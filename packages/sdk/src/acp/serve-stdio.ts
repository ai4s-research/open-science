// The process an external editor spawns to drive Open Science over ACP (#14).
//
// Node-only, and deliberately NOT exported from the browser barrel: it owns
// `process.stdin`/`stdout`, which the webview does not have. stdio is the only
// transport ACP v1 stabilizes (Streamable HTTP is still a draft proposal), so an
// editor integration IS a subprocess — this is that subprocess.
//
// It holds no runtime of its own: it connects to the desktop app's authenticated
// gateway (docs/rfc/remote-access-gateway.md) exactly as the LAN web client
// does, so the editor drives the SAME sessions, workspace and approvals the user
// sees in the window. Nothing here duplicates the runtime, and nothing works
// unless the user has enabled remote access and handed over a token.
import { OpenCodeClient } from "../OpenCodeClient";
import { AcpAgentServer } from "./server";
import type { JsonRpcTransport } from "./protocol";

export interface ServeStdioOptions {
  /** Gateway origin, e.g. `http://127.0.0.1:4123`. */
  url: string;
  /** Gateway token. The credential — never logged, never echoed. */
  token: string;
  version?: string;
  /** Streams to speak on. Injectable so tests never touch the real process. */
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

/** A line transport over a pair of node streams. Whole lines only: a read
 *  boundary lands mid-message routinely, so partial lines are buffered here —
 *  the same contract the client half's transports keep. */
export function streamTransport(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): JsonRpcTransport {
  const lineListeners = new Set<(line: string) => void>();
  const closeListeners = new Set<(reason?: string) => void>();
  let buffer = "";
  let closed = false;

  input.setEncoding?.("utf8");
  input.on("data", (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, "");
      buffer = buffer.slice(at + 1);
      if (line) lineListeners.forEach((l) => l(line));
      at = buffer.indexOf("\n");
    }
  });
  const end = (reason?: string) => {
    if (closed) return;
    closed = true;
    closeListeners.forEach((l) => l(reason));
  };
  input.on("end", () => end("the editor closed the connection"));
  input.on("error", (err: Error) => end(err.message));

  return {
    send(line) {
      if (closed) return;
      output.write(line.endsWith("\n") ? line : `${line}\n`);
    },
    onLine(listener) {
      lineListeners.add(listener);
      return () => lineListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close() {
      end();
    },
  };
}

/**
 * Connect to the gateway and serve ACP on the given streams until they close.
 *
 * The workspace comes from the gateway's own `/v1/whoami`, not from a flag: it
 * is the folder the desktop is actually in, and the server refuses sessions for
 * any other `cwd` rather than editing files somewhere the editor is not looking.
 */
export async function serveStdio(opts: ServeStdioOptions): Promise<AcpAgentServer> {
  const baseUrl = opts.url.replace(/\/+$/, "");
  const runtime = new OpenCodeClient({ baseUrl, password: opts.token });
  let workspace = "";
  try {
    const res = await fetch(`${baseUrl}/v1/whoami`, {
      headers: { Authorization: `Bearer ${opts.token}` },
    });
    if (res.ok) workspace = ((await res.json()) as { directory?: string }).directory ?? "";
  } catch {
    // Fall through to connect(), whose failure carries the real diagnosis
    // (wrong port, gateway off) instead of this one.
  }
  await runtime.connect();
  return new AcpAgentServer({
    runtime,
    transport: streamTransport(opts.stdin ?? process.stdin, opts.stdout ?? process.stdout),
    workspace,
    version: opts.version,
    // stderr is where an editor shows an agent's log; stdout carries protocol
    // messages only, which the spec is explicit about.
    onNotice: (message) => process.stderr.write(`${message}\n`),
  });
}

/**
 * CLI entry: `acp-server --url <origin> --token <token>`, or the same two values
 * as `OPENSCIENCE_GATEWAY_URL` / `OPENSCIENCE_GATEWAY_TOKEN`.
 *
 * Diagnostics go to stderr on purpose — the spec forbids anything on stdout
 * that is not an ACP message, and an editor showing a JSON parse error instead
 * of "no token" would be a bad first five minutes.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const flag = (name: string) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const url = flag("url") ?? process.env.OPENSCIENCE_GATEWAY_URL ?? "";
  const token = flag("token") ?? process.env.OPENSCIENCE_GATEWAY_TOKEN ?? "";
  if (!url || !token) {
    process.stderr.write(
      "Open Science ACP server: --url and --token are required " +
        "(or OPENSCIENCE_GATEWAY_URL / OPENSCIENCE_GATEWAY_TOKEN).\n" +
        "Both are shown in Open Science → Settings → Remote Access.\n",
    );
    process.exitCode = 2;
    return;
  }
  try {
    await serveStdio({ url, token, version: flag("version") });
  } catch (err) {
    process.stderr.write(
      `Open Science ACP server: could not reach the desktop app at ${url} — ` +
        `${err instanceof Error ? err.message : String(err)}\n` +
        "Is Open Science running with remote access enabled?\n",
    );
    process.exitCode = 1;
  }
}
