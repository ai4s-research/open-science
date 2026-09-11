import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAt } from "@/test/render";
import { useRuntimeStore } from "@/lib/runtime";

// COPYCAT RULE: useRuntimeStore is module-global — restore the status this file
// found it at, so no other suite inherits a faked one.
const RUNTIME_STATUS = useRuntimeStore.getState().status;
afterEach(() => {
  useRuntimeStore.setState({
    status: RUNTIME_STATUS,
    error: null,
    sessions: [],
    threads: {},
    currentId: null,
  });
  vi.useRealTimers();
});

/** What a launch looks like: the runtime is coming up, and nothing about it is
 *  the user's problem yet. The offline card ("start one with opencode serve")
 *  is for a runtime that is NOT being dialled — showing it mid-connect is what
 *  made every app start flicker, once per retry. */
describe("a session pane while the runtime is starting", () => {
  it("says nothing about a runtime that is still connecting", async () => {
    useRuntimeStore.setState({ status: "connecting", error: null });
    renderAt("/live");
    // The composer says what is happening instead of "Connect to chat", which
    // asked the user to do something the app was already doing.
    expect(await screen.findByPlaceholderText("Starting the runtime…")).toBeInTheDocument();
    expect(screen.queryByText("OpenCode runtime")).not.toBeInTheDocument();
    expect(screen.queryByText("Starting the local runtime…")).not.toBeInTheDocument();
  });

  it("explains the wait once it is long enough to notice", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useRuntimeStore.setState({ status: "connecting", error: null });
    renderAt("/live");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6100);
    });
    expect(screen.getByText("Starting the local runtime…")).toBeInTheDocument();
    expect(screen.queryByText("OpenCode runtime")).not.toBeInTheDocument();
  });

  it("offers the manual server instructions once nothing is being dialled", async () => {
    useRuntimeStore.setState({ status: "offline", error: null });
    renderAt("/live");
    expect(await screen.findByText("OpenCode runtime")).toBeInTheDocument();
    expect(screen.queryByText("Starting the local runtime…")).not.toBeInTheDocument();
  });
});

/** The skeleton means "nothing to show yet", NOT "history unfetched" — the two
 *  came apart in #139. A failed load keeps `loaded: false` so the next open
 *  retries, and it is the error row that stops the spinner. Keying the skeleton
 *  off `loaded` again would hand that session an endless pulse instead, which
 *  is the bug 1620a1f fixed and no store test can see. */
describe("a session pane whose history failed to load", () => {
  it("shows the error row rather than pulsing forever", async () => {
    act(() =>
      useRuntimeStore.setState({
        status: "ready",
        error: null,
        sessions: [{ id: "ses_err", title: "Broken", directory: "/ws/base" }],
        currentId: "ses_err",
        threads: {
          ses_err: {
            blocks: [
              { kind: "status-line", text: "Failed to load messages: Load failed", tone: "error" },
            ],
            index: {},
            loaded: false,
          },
        },
      }),
    );
    const { container } = renderAt("/live/ses_err");
    expect(await screen.findByText("Failed to load messages: Load failed")).toBeInTheDocument();
    expect(container.querySelector(".animate-pulse")).toBeNull();
  });
});
