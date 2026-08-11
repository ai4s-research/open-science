// A `JsonRpcTransport` over a spawned child's stdio. NODE ONLY.
//
// Deliberately not exported from the SDK's browser barrel: it imports
// `child_process`, which the webview does not have. In the desktop app the child
// is supervised on the Rust side and relayed to a Tauri transport instead — this
// one exists so the ACP layer can be driven against REAL agents from Node
// (`@agentclientprotocol/codex-acp`, `gemini --acp`, `@zed-industries/claude-code-acp`),
// which is the only way to know the mapping is right.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { JsonRpcTransport } from "./protocol";

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  cwd?: string;
  /** Extra environment for the child. Inherits the parent's otherwise. */
  env?: Record<string, string>;
}

/**
 * Spawn `command args…` and speak newline-delimited JSON-RPC on its stdio.
 *
 * stderr is NOT part of the protocol — agents log to it freely — so it is
 * surfaced only as the close reason when the child dies, which is where it is
 * actually diagnostic ("Claude Code cannot be launched inside another Claude
 * Code session", an auth failure, a missing binary).
 */
export function stdioTransport(opts: StdioTransportOptions): JsonRpcTransport {
  const child: ChildProcessWithoutNullStreams = spawn(opts.command, opts.args ?? [], {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const lineListeners = new Set<(line: string) => void>();
  const closeListeners = new Set<(reason?: string) => void>();
  let buffer = "";
  /** Last stderr, capped — the useful part of a failure is its first lines. */
  let lastError = "";
  let closed = false;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    // Whole lines only: a chunk boundary can land mid-message, and handing half
    // a JSON object to the peer would drop the message it belongs to.
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      lineListeners.forEach((l) => l(line));
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    lastError = `${lastError}${chunk}`.slice(-2000);
  });

  const fail = (reason: string) => {
    if (closed) return;
    closed = true;
    closeListeners.forEach((l) => l(reason));
  };
  child.on("error", (err) => fail(`could not start ${opts.command}: ${err.message}`));
  child.on("exit", (code, signal) => {
    const how = signal ? `signal ${signal}` : `code ${code}`;
    const detail = lastError.trim();
    fail(detail ? `${opts.command} exited (${how}): ${detail.slice(0, 500)}` : `${opts.command} exited (${how})`);
  });

  return {
    send(line) {
      if (closed) return;
      child.stdin.write(line);
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
      if (!closed) {
        closed = true;
        child.kill();
      }
    },
  };
}
