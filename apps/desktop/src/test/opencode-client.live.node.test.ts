// @vitest-environment node
//
// The client against a REAL OpenCode server — the contract the mock server
// only imitates. Skipped unless OPENCODE_LIVE_BIN names an OpenCode binary:
//
//   OPENCODE_LIVE_BIN=apps/desktop/src-tauri/binaries/opencode-aarch64-apple-darwin \
//     pnpm --filter @ai4s/desktop exec vitest run src/test/opencode-client.live.node.test.ts
//
// It starts that binary in a throwaway profile (its own XDG dirs, a password,
// a free port) with the config shape the app writes, and drives every turn
// through a free OpenCode model, so it needs network access but no account.
// A model is not a script: each prompt names exactly what to do, and the
// assertions check what the runtime reported, not the model's wording.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenCodeClient, type ConfigStore, type OpenCodeEvent } from "@ai4s/sdk";

const BIN = process.env.OPENCODE_LIVE_BIN;
const MODEL = process.env.OPENCODE_LIVE_MODEL ?? "opencode/deepseek-v4.1-flash-free";
const PASSWORD = "live-test-password";
const TURN_MS = 150_000;

let root = "";
let workspace = "";
let otherWorkspace = "";
let configFile = "";
let server: ChildProcess | null = null;
let baseUrl = "";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

/** The file-backed store the desktop shell provides, in miniature. */
const fileConfig: ConfigStore = {
  async read() {
    return JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
  },
  async patch(patch) {
    const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
      const out = { ...a };
      for (const [k, v] of Object.entries(b)) {
        const p = out[k];
        out[k] =
          v && typeof v === "object" && !Array.isArray(v) && p && typeof p === "object" && !Array.isArray(p)
            ? merge(p as Record<string, unknown>, v as Record<string, unknown>)
            : v;
      }
      return out;
    };
    writeFileSync(configFile, JSON.stringify(merge(await this.read(), patch), null, 2));
  },
};

function client(directory = workspace): OpenCodeClient {
  return new OpenCodeClient({ baseUrl, password: PASSWORD, directory, config: fileConfig, requestTimeoutMs: 30_000 });
}

async function waitFor(pred: () => boolean, timeout = TURN_MS): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Run one turn and return every event it produced. */
async function turn(c: OpenCodeClient, sessionId: string, text: string, answer?: (e: OpenCodeEvent) => void) {
  const events: OpenCodeEvent[] = [];
  const off = c.onEvent((e) => {
    if ("sessionId" in e && e.sessionId !== sessionId) return;
    events.push(e);
    answer?.(e);
  });
  try {
    await c.sendPrompt(sessionId, text, undefined, MODEL);
    await waitFor(() => events.some((e) => e.type === "session.idle"));
  } finally {
    off();
  }
  return events;
}

describe.skipIf(!BIN)("OpenCodeClient ↔ a real OpenCode server", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "osd-live-"));
    workspace = join(root, "ws");
    otherWorkspace = join(root, "ws-other");
    const cfg = join(root, "xdg-config", "opencode");
    for (const d of [workspace, otherWorkspace, cfg, join(root, "xdg-data"), join(root, "xdg-cache"), join(root, "xdg-state")])
      mkdirSync(d, { recursive: true });
    configFile = join(cfg, "opencode.jsonc");
    // The app's own config shape (OpenCode 1 format, which 2 still reads):
    // approve mode gates `rm` behind a prompt.
    writeFileSync(
      configFile,
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          model: MODEL,
          compaction: { auto: true },
          permission: { bash: { "rm *": "ask", "* rm *": "ask" }, external_directory: { "*": "ask" } },
        },
        null,
        2,
      ),
    );
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(BIN!, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: workspace,
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: PASSWORD,
        XDG_CONFIG_HOME: join(root, "xdg-config"),
        XDG_DATA_HOME: join(root, "xdg-data"),
        XDG_CACHE_HOME: join(root, "xdg-cache"),
        XDG_STATE_HOME: join(root, "xdg-state"),
      },
      stdio: "ignore",
    });
    const auth = `Basic ${btoa(`opencode:${PASSWORD}`)}`;
    const start = Date.now();
    for (;;) {
      try {
        const res = await fetch(`${baseUrl}/api/info`, { headers: { Authorization: auth } });
        if (res.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() - start > 60_000) throw new Error("OpenCode did not start");
      await new Promise((r) => setTimeout(r, 250));
    }
  }, 90_000);

  afterAll(() => {
    server?.kill("SIGTERM");
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("connects and reads the runtime's catalog", async () => {
    const c = client();
    await c.connect();
    expect(c.getStatus()).toBe("ready");
    const providers = await c.listProviders();
    const [pid, mid] = MODEL.split("/");
    const model = providers.find((p) => p.id === pid)?.models.find((m) => m.id === mid);
    expect(model).toBeDefined();
    expect(model!.free).toBe(true);
    expect((await c.listAgents()).map((a) => a.name)).toEqual(expect.arrayContaining(["build", "plan"]));
    expect((await c.listCommands()).map((cmd) => cmd.name)).toContain("goal");
    expect(Array.isArray(await c.listSkills())).toBe(true);
    expect(await c.getDefaultModel()).toBe(MODEL);
    c.close();
  });

  it("keeps, renames, archives and lists a conversation", async () => {
    const c = client();
    const id = await c.createSession("live probe");
    expect(await c.sessionExists(id)).toBe(true);
    await c.renameSession(id, "renamed probe");
    let page = await c.querySessions({ search: "renamed probe" });
    expect(page.sessions.map((s) => s.id)).toContain(id);
    expect(page.sessions.find((s) => s.id === id)?.directory).toBe(workspace);
    await c.setSessionArchived(id, true);
    page = await c.querySessions({ search: "renamed probe" });
    expect(page.sessions.map((s) => s.id)).not.toContain(id);
    page = await c.querySessions({ search: "renamed probe", archived: true });
    expect(page.sessions.find((s) => s.id === id)?.archived).toBeTypeOf("number");
    await c.setSessionArchived(id, false);
    page = await c.querySessions({ search: "renamed probe" });
    expect(page.sessions.map((s) => s.id)).toContain(id);
    await c.deleteSession(id);
    expect(await c.sessionExists(id)).toBe(false);
  });

  it("streams a turn with a shell call, and reads it back as history", async () => {
    const c = client();
    await c.connect();
    const id = await c.createSession();
    const events = await turn(
      c,
      id,
      "Run the shell command `echo osd-live-ok` exactly once, then reply with one short sentence that quotes its output.",
    );
    const types = new Set(events.map((e) => e.type));
    for (const t of ["user.message", "step.updated", "tool.updated", "text.updated", "message.usage", "session.idle"])
      expect(types, `missing ${t}`).toContain(t);
    const bash = events.filter((e): e is Extract<OpenCodeEvent, { type: "tool.updated" }> => e.type === "tool.updated" && e.tool === "bash");
    expect(bash.slice(-1)[0]?.status).toBe("success");
    expect(bash.slice(-1)[0]?.output).toContain("osd-live-ok");
    expect(bash.slice(-1)[0]?.input?.command).toContain("echo osd-live-ok");

    const history = await c.getMessages(id);
    expect(history[0].role).toBe("user");
    expect(history[0].parts[0].text).toContain("echo osd-live-ok");
    expect(history[0].agent).toBe("build");
    const tool = history.flatMap((m) => m.parts).find((p) => p.type === "tool");
    expect(tool?.tool).toBe("bash");
    expect(tool?.state?.status).toBe("completed");
    expect(tool?.state?.output).toContain("osd-live-ok");
    const last = history.slice(-1)[0]!;
    expect(last.role).toBe("assistant");
    expect(last.completed).toBeTypeOf("number");
    expect(last.usage?.input).toBeGreaterThan(0);
    c.close();
  }, TURN_MS);

  it("asks permission for a gated command and continues once it is granted", async () => {
    const c = client();
    await c.connect();
    const id = await c.createSession();
    const asked: string[] = [];
    const events = await turn(c, id, "Run the shell command `rm -f osd-live-missing-file` exactly once, then say done.", (e) => {
      if (e.type === "permission.asked") {
        asked.push(e.action);
        void c.replyPermission(e.requestId, "once");
      }
    });
    expect(asked).toContain("bash");
    expect(events.some((e) => e.type === "permission.resolved")).toBe(true);
    const bash = events.filter((e): e is Extract<OpenCodeEvent, { type: "tool.updated" }> => e.type === "tool.updated" && e.tool === "bash");
    expect(bash.slice(-1)[0]?.status).toBe("success");
    c.close();
  }, TURN_MS);

  it("relays a question and its answer", async () => {
    const c = client();
    await c.connect();
    const id = await c.createSession();
    const questions: string[] = [];
    await turn(
      c,
      id,
      'Use the question tool to ask me exactly one question, "Pick a colour", with the options "Red" and "Blue". After I answer, reply with only the colour I picked.',
      (e) => {
        if (e.type === "question.asked") {
          questions.push(e.questions[0]?.question ?? "");
          expect(e.questions[0]?.options.map((o) => o.label)).toEqual(expect.arrayContaining(["Red", "Blue"]));
          void c.answerQuestion(e.requestId, [["Blue"]]);
        }
      },
    );
    expect(questions.length).toBeGreaterThan(0);
    const text = (await c.getMessages(id)).slice(-1)[0]?.parts.map((p) => p.text ?? "").join("") ?? "";
    expect(text.toLowerCase()).toContain("blue");
    c.close();
  }, TURN_MS);

  it("interrupts a running turn", async () => {
    const c = client();
    await c.connect();
    const id = await c.createSession();
    const events: OpenCodeEvent[] = [];
    c.onEvent((e) => events.push(e));
    await c.sendPrompt(id, "Run the shell command `sleep 60` and wait for it to finish.", undefined, MODEL);
    await waitFor(() => events.some((e) => e.type === "tool.updated" && e.tool === "bash" && e.status === "running"));
    await c.abortSession(id);
    await waitFor(() => events.some((e) => e.type === "session.idle" && e.sessionId === id), 30_000);
    c.close();
  }, TURN_MS);

  it("forks, appends, and reverts for good", async () => {
    const c = client();
    await c.connect();
    const id = await c.createSession();
    await turn(c, id, "Reply with exactly the word ONE.");
    await turn(c, id, "Reply with exactly the word TWO.");
    const before = await c.getMessages(id);
    const users = before.filter((m) => m.role === "user");
    expect(users).toHaveLength(2);

    const fork = await c.forkSession(id, users[1].id);
    const forked = await c.getMessages(fork);
    expect(forked.filter((m) => m.role === "user")).toHaveLength(1);

    const checkpoint = before.filter((m) => m.role === "assistant").slice(-1)[0]!.id!;
    await c.appendTextPart(id, checkpoint, "osd-live-appended");
    const appended = (await c.getMessages(id)).slice(-1)[0]!;
    expect(appended.role).toBe("assistant");
    expect(appended.parts[0]).toMatchObject({ type: "text", text: "osd-live-appended", synthetic: true });

    // Revert drops the second turn at once — a reload must not bring it back —
    // and the next prompt carries on from the first.
    await c.revert(id, users[1].id!);
    const reverted = await c.getMessages(id);
    expect(reverted.filter((m) => m.role === "user").map((m) => m.parts[0].text)).toEqual([
      "Reply with exactly the word ONE.",
    ]);
    await turn(c, id, "Reply with exactly the word THREE.");
    const after = (await c.getMessages(id)).filter((m) => m.role === "user").map((m) => m.parts[0].text);
    expect(after).toEqual(["Reply with exactly the word ONE.", "Reply with exactly the word THREE."]);
    c.close();
  }, TURN_MS * 2);

  it("runs a user shell command without a model turn", async () => {
    const c = client();
    await c.connect();
    const id = await c.createSession();
    const events: OpenCodeEvent[] = [];
    c.onEvent((e) => events.push(e));
    await c.runShell(id, "echo osd-shell-ok");
    await waitFor(() => events.some((e) => e.type === "tool.updated" && e.tool === "bash" && e.status === "success"), 30_000);
    const done = events.find((e): e is Extract<OpenCodeEvent, { type: "tool.updated" }> => e.type === "tool.updated" && e.status === "success");
    expect(done?.output).toContain("osd-shell-ok");
    const history = await c.getMessages(id);
    expect(history.flatMap((m) => m.parts).some((p) => p.tool === "bash" && p.state?.output?.includes("osd-shell-ok"))).toBe(true);
    c.close();
  }, TURN_MS);

  it("resolves a slash command when its turn is over", async () => {
    // Defined in the config, which the runtime applies live, so the command
    // is short and certain.
    await fileConfig.patch({ command: { ping: { description: "answer pong", template: "Reply with exactly the word PONG." } } });
    const c = client();
    await c.connect();
    const start = Date.now();
    for (;;) {
      if ((await c.listCommands()).some((cmd) => cmd.name === "ping")) break;
      if (Date.now() - start > 20_000) throw new Error("the command was never loaded");
      await new Promise((r) => setTimeout(r, 500));
    }
    const id = await c.createSession();
    const events: OpenCodeEvent[] = [];
    c.onEvent((e) => events.push(e));
    await c.runCommand(id, "ping");
    expect(events.some((e) => e.type === "session.idle" && e.sessionId === id)).toBe(true);
    const last = (await c.getMessages(id)).slice(-1)[0];
    expect(last.parts.map((p) => p.text ?? "").join("")).toContain("PONG");
    c.close();
  }, TURN_MS);

  it("keeps each folder's client to its own sessions", async () => {
    const here = client(workspace);
    const there = client(otherWorkspace);
    await here.connect();
    await there.connect();
    const seenThere: OpenCodeEvent[] = [];
    there.onEvent((e) => seenThere.push(e));
    const id = await here.createSession();
    await turn(here, id, "Reply with exactly the word HELLO.");
    expect(seenThere.filter((e) => "sessionId" in e && e.sessionId === id)).toHaveLength(0);
    here.close();
    there.close();
  }, TURN_MS);

  it("switches the default model through the config file without dropping the stream", async () => {
    const c = client();
    await c.connect();
    await c.setDefaultModel("opencode/big-pickle");
    expect(await c.getDefaultModel()).toBe("opencode/big-pickle");
    await new Promise((r) => setTimeout(r, 1500));
    expect(c.getStatus()).toBe("ready");
    await c.setDefaultModel(MODEL);
    c.close();
  });
});
