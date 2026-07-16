// A minimal JSON-RPC 2.0 client over a child process's stdio. Shared transport
// for any runtime that speaks line-delimited JSON-RPC to a spawned binary —
// today CodexRuntime (codex app-server); tomorrow AcpRuntime (any ACP agent).
// See docs/rfc/multi-agent-acp.md: this is the layer both consume.
//
// Node-only: it spawns a real child process. Browser builds never import it.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** A JSON-RPC 2.0 request (expects a response). */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}
/** A JSON-RPC 2.0 notification (no response expected). */
interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}
/** A JSON-RPC 2.0 response to a prior request. */
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface StdioJsonRpcOptions {
  /** Command to spawn, e.g. ["codex", "app-server"]. */
  command: string[];
  /** Extra env for the child (merged over process.env). */
  env?: Record<string, string>;
  /** Working directory for the child. */
  cwd?: string;
  /** Ms to wait for the child to exit on close() before SIGKILL. Default 3000. */
  killGraceMs?: number;
}

/**
 * Speaks line-delimited JSON-RPC 2.0 to a spawned child process over its
 * stdin/stdout. Each JSON object is one line (newline-delimited).
 *
 * - `request(method, params)` → awaits the matching response by id.
 * - `onNotification(method, handler)` → fires for server-initiated messages.
 * - `notify(method, params)` → sends a notification (no response).
 */
export class StdioJsonRpcClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly notificationHandlers = new Map<
    string,
    Set<(params: unknown) => void>
  >();
  private buffer = "";
  private readonly options: StdioJsonRpcOptions;

  constructor(options: StdioJsonRpcOptions) {
    this.options = options;
  }

  /** Spawn the child. Resolves once stdout is open; the caller then does the
   *  protocol handshake (e.g. `initialize`). */
  start(): Promise<void> {
    if (this.proc) throw new Error("StdioJsonRpcClient already started");
    const [cmd, ...args] = this.options.command;
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...this.options.env },
        cwd: this.options.cwd,
      });
      this.proc = proc;
      let opened = false;
      const fail = (err: Error) => {
        if (!opened) {
          opened = true;
          reject(err);
        } else {
          this.onError(err);
        }
      };
      proc.on("error", fail);
      proc.on("exit", (code, signal) => {
        // Reject any in-flight requests: the answers will never come.
        const msg = `child exited (code ${code}, signal ${signal})`;
        for (const p of this.pending.values()) p.reject(new Error(msg));
        this.pending.clear();
        if (!opened) fail(new Error(msg));
        else this.onExit(code, signal);
      });
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        if (!opened) {
          opened = true;
          resolve();
        }
        this.onStdout(chunk);
      });
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk: string) => this.onStderr(chunk));
    });
  }

  /** Send a request and await the matching response. */
  request(method: string, params?: unknown): Promise<unknown> {
    if (!this.proc || !this.proc.stdin.writable) {
      return Promise.reject(new Error("JSON-RPC child is not running"));
    }
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write(msg);
    });
  }

  /** Send a notification (no response expected). */
  notify(method: string, params?: unknown): void {
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.write(msg);
  }

  /** Listen for a server-initiated notification/method. Returns an unsubscribe. */
  onNotification(method: string, handler: (params: unknown) => void): () => void {
    let set = this.notificationHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(method, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  /** Stop the child: close stdin, then SIGTERM → SIGKILL after the grace. */
  async close(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    try {
      proc.stdin.end();
    } catch {
      /* already closed */
    }
    await new Promise<void>((resolve) => {
      const grace = this.options.killGraceMs ?? 3000;
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        resolve();
      }, grace);
      proc.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // ---- hooks a subclass (or caller) can override ----

  /** Called on stderr output. Default: ignore. Override to log diagnostics. */
  protected onStderr(_chunk: string): void {}
  /** Called when the child exits unexpectedly after start. Default: no-op. */
  protected onExit(_code: number | null, _signal: NodeJS.Signals | null): void {}
  /** Called on a transport-level error. Default: no-op. */
  protected onError(_err: Error): void {}

  // ---- internals ----

  private write(msg: JsonRpcRequest | JsonRpcNotification): void {
    const proc = this.proc;
    if (!proc) return;
    proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // skip malformed lines
      }
      this.handleMessage(parsed as JsonRpcResponse | JsonRpcNotification);
    }
  }

  private handleMessage(msg: JsonRpcResponse | JsonRpcNotification): void {
    // A response carries an id matching a pending request.
    if (
      typeof msg === "object" &&
      msg !== null &&
      "id" in msg &&
      (msg.id === 0 || !!msg.id) &&
      ("result" in msg || "error" in msg) &&
      !("method" in msg)
    ) {
      const id = typeof msg.id === "string" ? Number(msg.id) : msg.id;
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        if (msg.error) {
          pending.reject(
            new Error(`${msg.error.message} (code ${msg.error.code})`),
          );
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }
    // Otherwise it's a notification (has `method`, no id).
    if (typeof msg === "object" && msg !== null && "method" in msg) {
      const handlers = this.notificationHandlers.get(msg.method);
      if (handlers) handlers.forEach((h) => h((msg as JsonRpcNotification).params));
    }
  }
}
