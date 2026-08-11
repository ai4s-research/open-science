// A `JsonRpcTransport` over the Rust-supervised ACP child (#14).
//
// `AcpRuntime` takes a line channel and never spawns anything — the webview has
// no `child_process`. Rust owns the process (`src-tauri/src/acp.rs`) and relays
// its stdout as `acp:line` events; this adapter is the other end of that pipe.
//
// Deliberately NOT available in the gateway web client: the agent would have to
// run on the phone, which has no such process. `isTauri` gates it, and Settings
// hides the picker in web mode rather than offering a control that cannot work
// (AGENTS.md).
import { isTauri } from "./tauri";

import type { JsonRpcTransport } from "@ai4s/sdk/acp";

/** `tauri.ts` exposes no generic invoke — every bridge imports the API where it
 *  is used, so the browser bundle never pulls it in. */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

interface AcpLine {
  agentId: string;
  line: string;
}
interface AcpExit {
  agentId: string;
  reason: string;
}

/**
 * Start `command args…` as agent `agentId` and return its line transport.
 *
 * The listeners are attached BEFORE the process starts: a fast agent can write
 * its first line before `acp_start` has even returned, and a line nobody is
 * listening for is gone — the handshake would then hang on a response that was
 * already delivered.
 */
export async function acpTransport(
  agentId: string,
  command: string,
  args: string[] = [],
): Promise<JsonRpcTransport> {
  if (!isTauri) throw new Error("ACP agents run on the desktop host, not in the browser client");
  const { listen } = await import("@tauri-apps/api/event");

  const lineListeners = new Set<(line: string) => void>();
  const closeListeners = new Set<(reason?: string) => void>();
  let closed = false;

  const unlistenLine = await listen<AcpLine>("acp:line", ({ payload }) => {
    if (payload.agentId !== agentId) return;
    lineListeners.forEach((l) => l(payload.line));
  });
  const unlistenExit = await listen<AcpExit>("acp:exit", ({ payload }) => {
    if (payload.agentId !== agentId || closed) return;
    closed = true;
    closeListeners.forEach((l) => l(payload.reason));
  });

  const detach = () => {
    unlistenLine();
    unlistenExit();
  };

  try {
    // Stop first, and AWAIT it. `acp_start` is idempotent per agent id, so a
    // still-running child from the previous connection would be adopted instead
    // of replaced — and its cwd is the workspace folder it was spawned in, which
    // is exactly what a workspace switch (teardown → connect) has just changed.
    // The previous transport's own `close` fires `acp_stop` without awaiting, so
    // ordering the two commands is this call's job.
    await call("acp_stop", { agentId }).catch(() => {
      /* nothing was running */
    });
    await call("acp_start", { agentId, command, args });
  } catch (err) {
    detach();
    throw err;
  }

  return {
    send(line) {
      if (closed) return;
      // Fire and forget: the peer's own request timeouts are what surface a
      // write that never landed, and awaiting here would serialize the stream.
      void call("acp_send", { agentId, line }).catch((err) => {
        if (closed) return;
        closed = true;
        const reason = err instanceof Error ? err.message : String(err);
        closeListeners.forEach((l) => l(reason));
      });
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
      if (closed) return;
      closed = true;
      detach();
      void call("acp_stop", { agentId }).catch(() => {
        /* already gone */
      });
    },
  };
}

/** Agents Rust still has running — the truth after a webview reload, which loses
 *  every JS handle while the children keep going. */
export async function acpRunning(): Promise<string[]> {
  if (!isTauri) return [];
  return call<string[]>("acp_running");
}
