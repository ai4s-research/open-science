import { beforeEach, describe, expect, it, vi } from "vitest";
import { destroyTerminal, getTerminal, liveTerminalIds, pruneTerminals, putTerminal } from "./terminalSessions";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

function fakeTerminal(id: string) {
  const dispose = vi.fn();
  const termDispose = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  putTerminal(id, {
    // Only the members this module touches; the real xterm has far more.
    term: { dispose: termDispose } as never,
    fit: {} as never,
    container,
    dispose,
  });
  return { dispose, termDispose, container };
}

describe("terminals outliving their component", () => {
  beforeEach(() => {
    for (const id of liveTerminalIds()) destroyTerminal(id);
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it("keeps a terminal whose pane is still in the layout", async () => {
    // The reported bug: splitting a pane moves its leaf deeper in the tree,
    // React unmounts the component, and the shell died with it.
    fakeTerminal("p1");

    pruneTerminals(["p1", "p2"]);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(getTerminal("p1")).toBeDefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("kills the shell of a pane that has actually gone", async () => {
    const { dispose, termDispose, container } = fakeTerminal("p1");

    pruneTerminals(["p2"]);
    await Promise.resolve();

    expect(getTerminal("p1")).toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(termDispose).toHaveBeenCalledTimes(1);
    expect(container.isConnected).toBe(false);
    // The PTY is closed behind a dynamic import, so it lands a turn later.
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("terminal_close", { id: "p1" }));
  });

  it("reaps every closed pane, and only those", async () => {
    fakeTerminal("p1");
    fakeTerminal("p2");
    fakeTerminal("p3");

    pruneTerminals(["p2"]);
    await Promise.resolve();

    expect(liveTerminalIds()).toEqual(["p2"]);
  });

  it("is safe to destroy one twice", async () => {
    const { dispose } = fakeTerminal("p1");
    destroyTerminal("p1");
    destroyTerminal("p1");
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
