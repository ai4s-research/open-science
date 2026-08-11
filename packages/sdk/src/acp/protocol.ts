// ACP (Agent Client Protocol) wire layer — newline-delimited JSON-RPC 2.0.
//
// ACP is the "LSP for agents": the CLIENT (us) speaks JSON-RPC to an AGENT over
// its stdin/stdout. See `docs/rfc/multi-agent-acp.md` for why this, rather than
// one adapter per agent.
//
// Two deliberate shapes here:
//
//   * The transport moves LINES, not parsed messages. Framing is this file's
//     job, so the same peer works over a spawned child's pipes (Node: tests and
//     headless runs) and over the desktop's Rust-supervised child relayed
//     through Tauri events. The webview has no `child_process` and the gateway
//     web client has no local process at all, so the runtime can never own the
//     child itself — see `AcpRuntime`.
//
//   * Requests go BOTH ways. An agent asks the client for permission, for file
//     contents, for a terminal. A client that only sends requests would hang
//     the agent's turn the first time it needs approval.
//
// The wire types below cover only what we use, and every one of them was read
// off a real agent (`@agentclientprotocol/codex-acp` 1.1.9, `gemini --acp`
// 0.33.1 and `@zed-industries/claude-code-acp` 0.16.2 all answer
// `protocolVersion: 1` with this shape) rather than transcribed from the spec
// alone.

/** The protocol version this client implements and negotiates. */
export const ACP_PROTOCOL_VERSION = 1;

/** How long a request waits before it is treated as lost. A prompt is excluded:
 *  a turn legitimately runs for many minutes. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * A bidirectional line channel to one agent process.
 *
 * `send` must deliver whole lines in order. `onLine` receives whole lines —
 * partial reads are the transport's problem to buffer, because only the
 * transport knows its own chunk boundaries.
 */
export interface JsonRpcTransport {
  send(line: string): void;
  /** Subscribe to inbound lines. Returns an unsubscribe. */
  onLine(listener: (line: string) => void): () => void;
  /** The channel ended (process exited, relay dropped). Returns an unsubscribe. */
  onClose(listener: (reason?: string) => void): () => void;
  close(): void;
}

/** A JSON-RPC error as the peer surfaces it — code and message kept verbatim,
 *  because an agent's own words ("Permission denied", a quota message) are the
 *  whole diagnostic value. */
export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

type Incoming = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export interface PeerHandlers {
  /** A notification from the agent (`session/update`, …). */
  onNotification?: (method: string, params: unknown) => void;
  /** A REQUEST from the agent. Resolve with the result, or throw to answer with
   *  an error. Returning undefined answers with `null`, which is a valid result. */
  onRequest?: (method: string, params: unknown) => Promise<unknown> | unknown;
  /** The channel closed. */
  onClose?: (reason?: string) => void;
}

/**
 * JSON-RPC 2.0 over a line transport: correlates requests with responses,
 * dispatches inbound notifications and requests, and fails every pending
 * request when the channel dies (so a crashed agent surfaces as an error
 * instead of a promise nobody ever settles).
 */
export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }
  >();
  private readonly unsubscribes: Array<() => void> = [];
  private closed = false;

  constructor(
    private readonly transport: JsonRpcTransport,
    private readonly handlers: PeerHandlers = {},
  ) {
    this.unsubscribes.push(transport.onLine((line) => this.receive(line)));
    this.unsubscribes.push(
      transport.onClose((reason) => {
        this.failAll(reason ?? "the agent connection closed");
        this.handlers.onClose?.(reason);
      }),
    );
  }

  /** Send a request and wait for its response. `timeoutMs: 0` waits forever —
   *  used for `session/prompt`, which is a whole agent turn. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.closed) return Promise.reject(new Error("the agent connection is closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribes.forEach((u) => u());
    this.failAll("the agent connection was closed locally");
    this.transport.close();
  }

  private write(message: unknown): void {
    this.transport.send(`${JSON.stringify(message)}\n`);
  }

  private failAll(reason: string): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
  }

  private receive(line: string): void {
    const text = line.trim();
    if (!text) return;
    let msg: Incoming;
    try {
      msg = JSON.parse(text) as Incoming;
    } catch {
      // Agents print human-readable noise on stdout occasionally (a banner, a
      // deprecation warning). Dropping it is right: JSON-RPC is the only thing
      // this channel means, and killing the peer over a stray line would take
      // the session with it.
      return;
    }
    // A response: id present, and one of result/error.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.pending.get(Number(msg.id));
      if (!entry) return; // late response to a timed-out request
      this.pending.delete(Number(msg.id));
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.error) entry.reject(new JsonRpcError(msg.error.code, msg.error.message, msg.error.data));
      else entry.resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    // A request FROM the agent — it is blocked until we answer.
    if (msg.id !== undefined) {
      void this.answer(msg.id, msg.method, msg.params);
      return;
    }
    this.handlers.onNotification?.(msg.method, msg.params);
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    if (!this.handlers.onRequest) {
      // -32601 is "method not found", which is exactly what an unhandled
      // agent-initiated request is: we never advertised the capability.
      this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `unhandled: ${method}` } });
      return;
    }
    try {
      const result = await this.handlers.onRequest(method, params);
      this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (err) {
      // A handler that names its own code keeps it — the difference between
      // "bad parameters" and "we broke" is the peer's to act on, and -32603 for
      // everything would flatten it. Anything else is an internal error.
      const code =
        typeof (err as { code?: unknown })?.code === "number"
          ? (err as { code: number }).code
          : -32603;
      this.write({
        jsonrpc: "2.0",
        id,
        error: { code, message: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}

// ---- Wire shapes we consume ----

export interface AcpAgentInfo {
  name?: string;
  title?: string;
  version?: string;
}

export interface AcpAuthMethod {
  id: string;
  name?: string;
  description?: string;
}

/** Capability-gated session methods. Presence of the KEY is the signal — the
 *  spec uses an empty object (`"list": {}`) as "supported", so a truthiness test
 *  on the value would read `{}` correctly but must never require a `true`. */
export interface AcpSessionCapabilities {
  list?: unknown;
  resume?: unknown;
  close?: unknown;
  delete?: unknown;
  additionalDirectories?: unknown;
}

export interface AcpAgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  sessionCapabilities?: AcpSessionCapabilities;
  mcpCapabilities?: Record<string, unknown>;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentInfo?: AcpAgentInfo;
  agentCapabilities?: AcpAgentCapabilities;
  /** Sign-in methods the agent offers. A non-empty list does NOT mean it is
   *  unauthenticated — codex-acp lists them while already signed in. */
  authMethods?: AcpAuthMethod[];
}

export interface AcpModelInfo {
  modelId: string;
  name?: string;
  description?: string;
}

/** One of the agent's own session selectors (model, reasoning level, permission
 *  mode, …). `session/set_config_option` is v1's stable way to change any of
 *  them, and the agent decides which exist — which is why nothing here is
 *  hard-coded to "model". */
export interface AcpConfigOptionValue {
  value: string;
  name?: string;
  description?: string;
}
export interface AcpConfigOption {
  id: string;
  name?: string;
  description?: string;
  /** "mode" | "model" | "model_config" | "thought_level" | `_custom`, or absent.
   *  UX metadata only: the spec forbids depending on it for correctness. */
  category?: string;
  /** "select" (default) or "boolean" — the latter only if the CLIENT advertised
   *  `session.configOptions.boolean`, which we do not. */
  type?: string;
  currentValue?: string | boolean;
  options?: AcpConfigOptionValue[];
}
export interface AcpConfigOptionsResult {
  configOptions?: AcpConfigOption[];
}

export interface AcpNewSessionResult {
  sessionId: string;
  /** The agent's OWN model list, as older agents report it beside the session.
   *  `configOptions` is the stable v1 way to expose (and change) a model; this
   *  is kept because agents in the wild still answer with it. */
  models?: { availableModels?: AcpModelInfo[]; currentModelId?: string };
  /** The agent's session selectors — model, reasoning level, permission mode. */
  configOptions?: AcpConfigOption[];
}

/** `session/list` — one page of the agent's OWN session history. */
export interface AcpSessionInfo {
  sessionId: string;
  /** Absolute workspace folder the session belongs to. */
  cwd: string;
  title?: string;
  /** RFC 3339 timestamp. */
  updatedAt?: string;
}
export interface AcpSessionListResult {
  sessions?: AcpSessionInfo[];
  nextCursor?: string | null;
}

export interface AcpPromptResult {
  /** "end_turn" | "cancelled" | "max_tokens" | "refusal" | … — the agent's word
   *  for why the turn stopped. */
  stopReason?: string;
}

export interface AcpContentBlock {
  type?: string;
  text?: string;
}

export interface AcpCommand {
  name: string;
  description?: string;
  input?: { hint?: string } | null;
}

export interface AcpToolCallUpdate {
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: Record<string, unknown>;
  content?: Array<{ type?: string; content?: AcpContentBlock; text?: string }>;
}

/** One `session/update` notification's payload. `sessionUpdate` is the tag. */
export interface AcpSessionUpdate {
  sessionUpdate: string;
  messageId?: string;
  content?: AcpContentBlock;
  availableCommands?: AcpCommand[];
  [key: string]: unknown;
}

export interface AcpSessionNotification {
  sessionId: string;
  update: AcpSessionUpdate;
}

/** `session/request_permission` — the agent is blocked until we answer. */
export interface AcpPermissionRequest {
  sessionId: string;
  toolCall?: AcpToolCallUpdate;
  options?: Array<{ optionId: string; name?: string; kind?: string }>;
}
