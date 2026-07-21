import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 17891;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export function contentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return String(part ?? "");
      if (typeof part.text === "string") return part.text;
      if (part.type === "image_url") return `[image: ${part.image_url?.url ?? "attached"}]`;
      if (part.type === "input_image") return `[image: ${part.image_url ?? "attached"}]`;
      return JSON.stringify(part);
    })
    .filter(Boolean)
    .join("\n");
}

export function buildDeveloperInstructions(messages) {
  const hostInstructions = messages
    .filter((message) => message?.role === "system" || message?.role === "developer")
    .map((message) => contentToText(message.content))
    .filter(Boolean)
    .join("\n\n");
  const bridgeInstructions = [
    "You are the primary reasoning model inside Open Science Desktop; OpenCode is the host runtime.",
    "Follow the host system and developer instructions above as authoritative instructions.",
    "Use the supplied dynamic tools for host actions, including Open Science skills, MCP tools, file mutations, commands, and network access.",
    "Your built-in Codex environment is intentionally read-only. Do not bypass the host tools or their approval policy.",
    "Return the user-facing answer directly when the task is complete; do not describe this bridge.",
  ].join("\n");
  return hostInstructions ? `${hostInstructions}\n\n${bridgeInstructions}` : bridgeInstructions;
}

export function buildTranscript(messages) {
  const parts = [];
  for (const message of messages) {
    if (!message || message.role === "system" || message.role === "developer") continue;
    const role = String(message.role || "unknown").toUpperCase();
    const name = message.name ? ` name=${message.name}` : "";
    const callId = message.tool_call_id ? ` call_id=${message.tool_call_id}` : "";
    let text = contentToText(message.content);
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const calls = message.tool_calls.map((call) => ({
        id: call.id,
        name: call.function?.name,
        arguments: call.function?.arguments,
      }));
      text = `${text}${text ? "\n" : ""}[tool_calls] ${JSON.stringify(calls)}`;
    }
    parts.push(`<${role}${name}${callId}>\n${text}\n</${role}>`);
  }
  return parts.join("\n\n") || "Continue the conversation.";
}

export function convertTools(tools) {
  const seen = new Set();
  const converted = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool?.type !== "function" || !tool.function?.name) continue;
    const name = String(tool.function.name);
    if (seen.has(name)) continue;
    seen.add(name);
    converted.push({
      type: "function",
      name,
      description: String(tool.function.description || `Open Science tool: ${name}`),
      inputSchema: tool.function.parameters || { type: "object", properties: {} },
      deferLoading: false,
    });
  }
  return converted;
}

function responseSchema(body) {
  const format = body?.response_format;
  if (format?.type === "json_schema") return format.json_schema?.schema || format.json_schema;
  return undefined;
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function isAuthorized(authorization, apiKey) {
  if (!apiKey) return true;
  return safeEqual(authorization || "", `Bearer ${apiKey}`);
}

export function openAIResponse(outcome, model) {
  if (outcome.type === "error") throw outcome.error;
  const response = {
    id: makeId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    // App Server does not currently expose per-turn usage on this bridge path.
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  if (outcome.type === "tool_calls") {
    response.choices.push({
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: outcome.calls.map((call) => ({
          id: call.callId,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments ?? {}),
          },
        })),
      },
      finish_reason: "tool_calls",
    });
  } else {
    response.choices.push({
      index: 0,
      message: { role: "assistant", content: outcome.content || "" },
      finish_reason: "stop",
    });
  }
  return response;
}

class TurnJob {
  constructor(client, threadId, pendingToolCalls, timeoutMs) {
    this.client = client;
    this.threadId = threadId;
    this.pendingToolCalls = pendingToolCalls;
    this.timeoutMs = timeoutMs;
    this.turnId = null;
    this.buffer = "";
    this.finalText = "";
    this.outcomes = [];
    this.waiters = [];
    this.unannouncedTools = [];
    this.toolDebounce = null;
  }

  waitForOutcome() {
    if (this.outcomes.length) return Promise.resolve(this.outcomes.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((entry) => entry.resolve !== resolve);
        reject(new Error(`Codex turn timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  pushOutcome(outcome) {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(outcome);
    } else {
      this.outcomes.push(outcome);
    }
  }

  clearPendingTools() {
    for (const [callId, pending] of this.pendingToolCalls) {
      if (pending.job === this) this.pendingToolCalls.delete(callId);
    }
  }

  fail(error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (this.toolDebounce) clearTimeout(this.toolDebounce);
    this.clearPendingTools();
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(normalized);
    }
    this.pushOutcome({ type: "error", error: normalized });
  }

  onNotification(message) {
    const { method, params = {} } = message;
    if (params.threadId && params.threadId !== this.threadId) return;
    if (method === "turn/started") {
      this.turnId = params.turn?.id || this.turnId;
    } else if (method === "item/agentMessage/delta") {
      this.turnId = params.turnId || this.turnId;
      this.buffer += params.delta || "";
    } else if (method === "item/completed" && params.item?.type === "agentMessage") {
      this.finalText = params.item.text || params.item.content || this.finalText;
    } else if (method === "turn/completed") {
      const status = params.turn?.status;
      if (status === "failed") {
        this.pushOutcome({
          type: "error",
          error: new Error(params.turn?.error?.message || "Codex turn failed"),
        });
      } else {
        this.pushOutcome({ type: "content", content: this.finalText || this.buffer || "" });
      }
      this.clearPendingTools();
      this.client.jobs.delete(this.threadId);
    } else if (method === "error") {
      this.fail(new Error(params.message || "Codex App Server error"));
    }
  }

  onDynamicToolRequest(message) {
    const params = message.params || {};
    this.turnId = params.turnId || this.turnId;
    const call = {
      serverRequestId: message.id,
      callId: params.callId || makeId("call"),
      name: params.tool,
      arguments: params.arguments ?? {},
    };
    this.pendingToolCalls.set(call.callId, { job: this, call });
    this.unannouncedTools.push(call);
    if (this.toolDebounce) return;
    this.toolDebounce = setTimeout(() => {
      this.toolDebounce = null;
      const calls = this.unannouncedTools.splice(0);
      if (!calls.length) return;
      this.buffer = "";
      this.finalText = "";
      this.pushOutcome({ type: "tool_calls", calls });
    }, 25);
  }
}

class CodexAppServerClient {
  constructor(options, logger, pendingToolCalls) {
    this.options = options;
    this.log = logger;
    this.pendingToolCalls = pendingToolCalls;
    this.process = null;
    this.ready = false;
    this.startPromise = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.jobs = new Map();
  }

  async ensureReady() {
    if (this.ready && this.process && !this.process.killed) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async start() {
    const executable = resolveCodexCommand(this.options.codexCommand);
    const spec = codexSpawnSpec(executable);
    const child = spawn(spec.command, spec.args, {
      cwd: this.options.workspace,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.log("codex_stderr", { text: String(chunk).trim().slice(0, 2000) });
    });
    child.on("error", (error) => this.onExit(error));
    child.on("exit", (code, signal) => {
      this.onExit(new Error(`Codex App Server exited: code=${code} signal=${signal}`));
    });

    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      try {
        this.onMessage(JSON.parse(line));
      } catch (error) {
        this.log("invalid_app_server_message", { error: String(error), line: line.slice(0, 1000) });
      }
    });

    await this.request("initialize", {
      clientInfo: {
        name: "open_science_codex_provider_bridge",
        title: "Open Science Codex Provider Bridge",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    this.ready = true;
    this.log("codex_app_server_ready", {
      pid: child.pid,
      model: this.options.model || "config-default",
    });
  }

  onExit(error) {
    if (!this.process && !this.ready) return;
    this.ready = false;
    this.process = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    for (const job of this.jobs.values()) job.fail(error);
    this.jobs.clear();
    this.log("codex_app_server_stopped", { error: String(error) });
  }

  onMessage(message) {
    if (message.method && Object.hasOwn(message, "id")) {
      if (message.method === "item/tool/call") {
        const job = this.jobs.get(message.params?.threadId);
        if (job) job.onDynamicToolRequest(message);
        else {
          this.respond(message.id, {
            success: false,
            contentItems: [{ type: "inputText", text: "The host lost the active turn." }],
          });
        }
        return;
      }
      // The bridge deliberately runs Codex read-only and never approves a
      // sandbox escape. Mutating actions must return through OpenCode tools.
      this.respond(message.id, null, {
        code: -32601,
        message: `Unsupported Codex server request: ${message.method}`,
      });
      return;
    }

    if (Object.hasOwn(message, "id")) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else entry.resolve(message.result);
      return;
    }

    if (!message.method) return;
    const threadId = message.params?.threadId;
    if (threadId && this.jobs.has(threadId)) this.jobs.get(threadId).onNotification(message);
    else if (message.method === "error") {
      for (const job of this.jobs.values()) job.onNotification(message);
    }
  }

  send(message) {
    if (!this.process?.stdin?.writable) throw new Error("Codex App Server stdin is unavailable");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ method, id, params });
    });
  }

  notify(method, params) {
    this.send({ method, params });
  }

  respond(id, result, error = null) {
    this.send(error ? { id, error } : { id, result });
  }

  async startTurn(body) {
    await this.ensureReady();
    const params = {
      cwd: this.options.workspace,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      developerInstructions: buildDeveloperInstructions(body.messages || []),
      dynamicTools: convertTools(body.tools),
      serviceName: "open-science-codex-provider-bridge",
    };
    if (this.options.model) params.model = this.options.model;
    const threadResult = await this.request("thread/start", params);
    const threadId = threadResult?.thread?.id;
    if (!threadId) throw new Error("Codex App Server did not return a thread id");

    const job = new TurnJob(this, threadId, this.pendingToolCalls, this.options.timeoutMs);
    this.jobs.set(threadId, job);
    const turnParams = {
      threadId,
      input: [{ type: "text", text: buildTranscript(body.messages || []) }],
      cwd: this.options.workspace,
    };
    const schema = responseSchema(body);
    if (schema) turnParams.outputSchema = schema;
    await this.request("turn/start", turnParams);
    return job;
  }

  stop() {
    if (this.process && !this.process.killed) this.process.kill();
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendSse(response, completion) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  const base = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
  };
  const write = (choice) => response.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`);
  write({ index: 0, delta: { role: "assistant" }, finish_reason: null });
  const message = completion.choices[0].message;
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((call, index) => {
      write({
        index: 0,
        delta: { tool_calls: [{ index, id: call.id, type: "function", function: call.function }] },
        finish_reason: null,
      });
    });
  } else {
    const content = message.content || "";
    for (let index = 0; index < content.length; index += 1200) {
      write({ index: 0, delta: { content: content.slice(index, index + 1200) }, finish_reason: null });
    }
  }
  write({ index: 0, delta: {}, finish_reason: completion.choices[0].finish_reason });
  response.end("data: [DONE]\n\n");
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 25 * 1024 * 1024) throw new Error("Request body exceeds 25 MB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function createLogger(logPath) {
  return (message, details = {}) => {
    const line = `${JSON.stringify({ time: new Date().toISOString(), message, ...details })}\n`;
    if (logPath) {
      try {
        fs.appendFileSync(logPath, line, "utf8");
      } catch {
        // Logging must never break the provider.
      }
    }
    process.stderr.write(line);
  };
}

export function readOptions(env = process.env) {
  const port = Number(env.CODEX_BRIDGE_PORT || DEFAULT_PORT);
  const timeoutMs = Number(env.CODEX_BRIDGE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid CODEX_BRIDGE_PORT");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error("Invalid CODEX_BRIDGE_TIMEOUT_MS");
  return {
    host: "127.0.0.1",
    port,
    timeoutMs,
    codexCommand: env.CODEX_BRIDGE_CODEX || "codex",
    workspace: path.resolve(env.CODEX_BRIDGE_CWD || process.cwd()),
    model: env.CODEX_BRIDGE_MODEL || null,
    apiKey: env.CODEX_BRIDGE_API_KEY || "",
    logPath: env.CODEX_BRIDGE_LOG ? path.resolve(env.CODEX_BRIDGE_LOG) : null,
  };
}

function resolveCodexCommand(command) {
  if (process.platform !== "win32" || path.isAbsolute(command) || /[\\/]/.test(command)) return command;
  const lookup = spawnSync("where.exe", [command], { encoding: "utf8", windowsHide: true });
  if (lookup.status !== 0) return command;
  const candidates = lookup.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // Prefer npm's wrapper over a WindowsApps alias: the latter can resolve via
  // `where.exe` but still reject child-process launch with EPERM.
  return candidates.find((candidate) => /\.cmd$/i.test(candidate))
    || candidates.find((candidate) => /\.exe$/i.test(candidate))
    || candidates.find((candidate) => /\.bat$/i.test(candidate))
    || candidates[0]
    || command;
}

export function codexSpawnSpec(
  command,
  platform = process.platform,
  nodeExecutable = process.execPath,
  exists = fs.existsSync,
) {
  if (platform === "win32" && /\.cmd$/i.test(command)) {
    const npmEntry = path.join(path.dirname(command), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (!exists(npmEntry)) {
      throw new Error(
        `Cannot launch ${command} without a shell: expected the npm Codex entry at ${npmEntry}. `
        + "Set CODEX_BRIDGE_CODEX to a native codex.exe instead.",
      );
    }
    return { command: nodeExecutable, args: [npmEntry, "app-server", "--listen", "stdio://"] };
  }
  if (platform === "win32" && /\.bat$/i.test(command)) {
    throw new Error("Windows .bat wrappers are not supported; set CODEX_BRIDGE_CODEX to codex.exe or npm's codex.cmd");
  }
  return { command, args: ["app-server", "--listen", "stdio://"] };
}

export function createBridge(options = readOptions()) {
  const log = createLogger(options.logPath);
  const pendingToolCalls = new Map();
  const appServer = new CodexAppServerClient(options, log, pendingToolCalls);

  const resolveOutcome = async (body) => {
    const matches = [];
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      if (message?.role !== "tool" || !message.tool_call_id) continue;
      const pending = pendingToolCalls.get(message.tool_call_id);
      if (pending) matches.push({ message, pending });
    }
    if (!matches.length) {
      const job = await appServer.startTurn(body);
      return job.waitForOutcome();
    }

    const jobs = new Set(matches.map((match) => match.pending.job));
    if (jobs.size !== 1) throw new Error("Tool results belong to multiple Codex turns");
    const job = matches[0].pending.job;
    const nextOutcome = job.waitForOutcome();
    for (const { message, pending } of matches) {
      const text = contentToText(message.content) || "Tool completed without textual output.";
      appServer.respond(pending.call.serverRequestId, {
        success: true,
        contentItems: [{ type: "inputText", text }],
      });
      pendingToolCalls.delete(pending.call.callId);
    }
    return nextOutcome;
  };

  const server = http.createServer(async (request, response) => {
    const started = Date.now();
    const requestId = makeId("req");
    try {
      if (!isAuthorized(request.headers.authorization, options.apiKey)) {
        response.setHeader("WWW-Authenticate", "Bearer");
        sendJson(response, 401, { error: { message: "Unauthorized", type: "authentication_error" } });
        return;
      }
      if (request.method === "GET" && (request.url === "/health" || request.url === "/v1/health")) {
        await appServer.ensureReady();
        sendJson(response, 200, {
          status: "ok",
          provider: "codex-cli",
          appServerReady: appServer.ready,
          model: options.model || "codex-config-default",
          workspace: options.workspace,
        });
        return;
      }
      if (request.method === "GET" && (request.url === "/v1/models" || request.url === "/models")) {
        sendJson(response, 200, {
          object: "list",
          data: [{ id: "codex-cli", object: "model", created: 0, owned_by: "local-codex-cli" }],
        });
        return;
      }
      if (request.method === "POST" && request.url?.startsWith("/v1/chat/completions")) {
        const body = await readJson(request);
        log("completion_started", {
          requestId,
          messages: Array.isArray(body.messages) ? body.messages.length : 0,
          tools: Array.isArray(body.tools) ? body.tools.length : 0,
          stream: Boolean(body.stream),
        });
        const outcome = await resolveOutcome(body);
        const completion = openAIResponse(outcome, body.model || "codex-cli");
        if (body.stream) sendSse(response, completion);
        else sendJson(response, 200, completion);
        log("completion_finished", { requestId, outcome: outcome.type, elapsedMs: Date.now() - started });
        return;
      }
      sendJson(response, 404, { error: { message: "Not found", type: "invalid_request_error" } });
    } catch (error) {
      log("request_failed", { requestId, error: String(error), elapsedMs: Date.now() - started });
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: "codex_bridge_error",
          },
        });
      } else response.end();
    }
  });

  return {
    options,
    server,
    appServer,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host, resolve);
      });
      log("bridge_listening", { host: options.host, port: options.port, pid: process.pid });
      await appServer.ensureReady();
    },
    async close() {
      appServer.stop();
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const bridge = createBridge();
  bridge.listen().catch(async (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    await bridge.close();
    process.exitCode = 1;
  });
  const shutdown = (signal) => {
    process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), message: "bridge_shutdown", signal })}\n`);
    void bridge.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
