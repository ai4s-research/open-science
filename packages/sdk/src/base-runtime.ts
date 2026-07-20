// BaseAgentRuntime: shared infrastructure for every AgentRuntime implementation.
//
// The listener/status machinery (getStatus / onEvent / onStatus / emit /
// setStatus) is identical across runtimes — OpenCodeClient and CodexRuntime
// had byte-for-byte copies. This base class factors it out so a new runtime
// author fills in ONLY their protocol-specific methods (connect, createSession,
// sendPrompt, ...) and inherits the plumbing.
//
// To add a new agent runtime, extend this class and implement the remaining
// AgentRuntime methods. See docs/AGENT_INTEGRATION.md for a step-by-step guide.
import type { OpenCodeEvent, RuntimeStatus } from "./types";

/**
 * Listener + status plumbing shared by every runtime. A subclass extends this
 * and implements its protocol-specific AgentRuntime methods (connect,
 * createSession, sendPrompt, …), calling `setStatus()` as it transitions and
 * `emit()` to fan out normalized events.
 *
 * `getStatus` / `onEvent` / `onStatus` are final here — they never differ by
 * runtime, so they are intentionally NOT overridable in practice.
 */
export abstract class BaseAgentRuntime {
  private status: RuntimeStatus = "offline";
  private readonly eventListeners = new Set<(e: OpenCodeEvent) => void>();
  private readonly statusListeners = new Set<(s: RuntimeStatus) => void>();

  /** Current runtime status. Implements `AgentRuntime.getStatus`. */
  getStatus(): RuntimeStatus {
    return this.status;
  }

  /** Subscribe to normalized runtime events. Returns an unsubscribe. */
  onEvent(listener: (event: OpenCodeEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Subscribe to status transitions. Returns an unsubscribe. */
  onStatus(listener: (status: RuntimeStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  // ---- tools for subclasses ----

  /** Fan a normalized event out to every onEvent listener. */
  protected emit(event: OpenCodeEvent): void {
    this.eventListeners.forEach((l) => l(event));
  }

  /** Transition status and notify onStatus listeners. A no-op if unchanged. */
  protected setStatus(status: RuntimeStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.statusListeners.forEach((l) => l(status));
  }
}
