// Scroll memory: a container comes back to where the user left it — per key,
// only once the content is ready, and a draft's offset follows its session id.
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRef, type UIEvent } from "react";
import {
  clearScrollMemory,
  isNearBottom,
  moveScrollMemory,
  useChatScroll,
  useScrollMemory,
} from "./scrollMemory";

function mount(key: string, ready: boolean, el: HTMLElement) {
  return renderHook(
    ({ k, r }: { k: string; r: boolean }) => {
      const ref = useRef<HTMLElement | null>(el);
      return useScrollMemory(ref, k, r);
    },
    { initialProps: { k: key, r: ready } },
  );
}

const scrollTo = (el: HTMLElement, top: number, onScroll: (e: UIEvent<HTMLElement>) => void) => {
  el.scrollTop = top;
  onScroll({ currentTarget: el } as unknown as UIEvent<HTMLElement>);
};

beforeEach(() => clearScrollMemory());

describe("useScrollMemory", () => {
  it("restores the recorded offset when the same key mounts again", () => {
    const a = document.createElement("div");
    const first = mount("file:/ws/a.md", true, a);
    scrollTo(a, 120, first.result.current);
    first.unmount();

    const b = document.createElement("div");
    mount("file:/ws/a.md", true, b);
    expect(b.scrollTop).toBe(120);
  });

  it("keeps keys independent and defaults an unknown key to the top", () => {
    const a = document.createElement("div");
    const first = mount("file:/ws/a.md", true, a);
    scrollTo(a, 120, first.result.current);

    const b = document.createElement("div");
    b.scrollTop = 55; // leftover position from whatever was shown before
    mount("file:/ws/other.md", true, b);
    expect(b.scrollTop).toBe(0);
  });

  it("waits for ready before restoring (content not loaded yet)", () => {
    const a = document.createElement("div");
    const first = mount("chat:ses_1", true, a);
    scrollTo(a, 300, first.result.current);
    first.unmount();

    const b = document.createElement("div");
    const again = mount("chat:ses_1", false, b);
    expect(b.scrollTop).toBe(0);
    again.rerender({ k: "chat:ses_1", r: true });
    expect(b.scrollTop).toBe(300);
  });

  it("ignores scroll events while not ready — a loading placeholder's clamp must not overwrite the real offset", () => {
    const a = document.createElement("div");
    const h = mount("chat:ses_1", true, a);
    scrollTo(a, 200, h.result.current);
    h.rerender({ k: "chat:ses_1", r: false });
    scrollTo(a, 0, h.result.current); // content swapped for a skeleton, browser clamps
    h.rerender({ k: "chat:ses_1", r: true });
    expect(a.scrollTop).toBe(200);
  });

  it("moveScrollMemory re-keys an offset (draft → real session id)", () => {
    const a = document.createElement("div");
    const first = mount("chat:draft", true, a);
    scrollTo(a, 80, first.result.current);
    moveScrollMemory("chat:draft", "chat:ses_new");

    const b = document.createElement("div");
    mount("chat:ses_new", true, b);
    expect(b.scrollTop).toBe(80);
  });

  it("can default an unseen key to the bottom without changing other consumers", () => {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollHeight", { value: 900, configurable: true });
    renderHook(() => {
      const ref = useRef<HTMLElement | null>(el);
      return useScrollMemory(ref, "chat:ses_new", true, "bottom");
    });
    expect(el.scrollTop).toBe(900);
  });
});

describe("useChatScroll", () => {
  it("shows that older messages are being read and jumps back to the latest", () => {
    const el = document.createElement("div");
    Object.defineProperties(el, {
      scrollHeight: { value: 1_000, configurable: true },
      clientHeight: { value: 200, configurable: true },
    });
    const hook = renderHook(() => {
      const ref = useRef<HTMLElement | null>(el);
      return useChatScroll(ref, "chat:ses_1");
    });

    act(() => {
      el.scrollTop = 300;
      hook.result.current.onScroll({ currentTarget: el } as unknown as UIEvent<HTMLElement>);
    });
    expect(hook.result.current.atLatest).toBe(false);

    act(() => hook.result.current.jumpToLatest());
    expect(el.scrollTop).toBe(1_000);
    expect(hook.result.current.atLatest).toBe(true);
  });

  it("uses a tolerance when deciding whether the reader is at the latest messages", () => {
    const el = document.createElement("div");
    Object.defineProperties(el, {
      scrollHeight: { value: 1_000, configurable: true },
      clientHeight: { value: 200, configurable: true },
    });
    el.scrollTop = 730;
    expect(isNearBottom(el)).toBe(true);
    el.scrollTop = 700;
    expect(isNearBottom(el)).toBe(false);
  });

  it("follows growing content only while the reader is already at the bottom", () => {
    const OriginalResizeObserver = globalThis.ResizeObserver;
    let notifyResize: ResizeObserverCallback | undefined;
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;

    let height = 1_000;
    const el = document.createElement("div");
    Object.defineProperties(el, {
      scrollHeight: { get: () => height, configurable: true },
      clientHeight: { value: 200, configurable: true },
    });
    const hook = renderHook(
      ({ ready }) => {
        const ref = useRef<HTMLElement | null>(el);
        return useChatScroll(ref, "chat:ses_stream", ready);
      },
      { initialProps: { ready: true } },
    );

    try {
      (
        hook.result.current.contentRef as unknown as { current: HTMLDivElement | null }
      ).current = document.createElement("div");
      hook.rerender({ ready: false });
      hook.rerender({ ready: true });

      act(() => {
        el.scrollTop = 300;
        hook.result.current.onScroll({ currentTarget: el } as unknown as UIEvent<HTMLElement>);
      });
      height = 1_200;
      act(() => notifyResize?.([], {} as ResizeObserver));
      expect(el.scrollTop).toBe(300);

      act(() => hook.result.current.jumpToLatest());
      height = 1_400;
      act(() => notifyResize?.([], {} as ResizeObserver));
      expect(el.scrollTop).toBe(1_400);
    } finally {
      hook.unmount();
      globalThis.ResizeObserver = OriginalResizeObserver;
    }
  });

  // Screens stay mounted while hidden, so a pane can be away and back without
  // ever unmounting. Coming back must not strand a reader who was pinned to
  // the latest at a message that is no longer last.
  it("re-pins a follower to the latest when its Screen comes back", () => {
    let height = 1_000;
    const el = document.createElement("div");
    Object.defineProperties(el, {
      scrollHeight: { get: () => height, configurable: true },
      clientHeight: { value: 200, configurable: true },
    });
    el.scrollTop = 800; // at the bottom
    const hook = renderHook(
      ({ visible }) => {
        const ref = useRef<HTMLElement | null>(el);
        return useChatScroll(ref, "chat:ses_back", visible);
      },
      { initialProps: { visible: true } },
    );

    hook.rerender({ visible: false }); // Screen switched away
    height = 3_000; // the conversation kept streaming
    hook.rerender({ visible: true }); // and back

    expect(el.scrollTop).toBe(3_000);
  });

  it("leaves a reader of older turns where they were, on the way back", () => {
    let height = 1_000;
    const el = document.createElement("div");
    Object.defineProperties(el, {
      scrollHeight: { get: () => height, configurable: true },
      clientHeight: { value: 200, configurable: true },
    });
    const hook = renderHook(
      ({ visible }) => {
        const ref = useRef<HTMLElement | null>(el);
        return useChatScroll(ref, "chat:ses_reading", visible);
      },
      { initialProps: { visible: true } },
    );
    act(() => {
      el.scrollTop = 200; // reading history
      hook.result.current.onScroll({ currentTarget: el } as unknown as UIEvent<HTMLElement>);
    });

    hook.rerender({ visible: false });
    height = 3_000;
    hook.rerender({ visible: true });

    expect(el.scrollTop).toBe(200);
  });

  // The same pane pointed at another session is a FIRST entry, not a return:
  // it must land where that session was left, not inherit the follow state of
  // the conversation it used to show.
  it("does not carry one session's follow state into the next", () => {
    const el = document.createElement("div");
    Object.defineProperties(el, {
      scrollHeight: { value: 5_000, configurable: true },
      clientHeight: { value: 200, configurable: true },
    });
    el.scrollTop = 4_900; // following session one
    const hook = renderHook(
      ({ key }) => {
        const ref = useRef<HTMLElement | null>(el);
        return useChatScroll(ref, key);
      },
      { initialProps: { key: "chat:ses_one" } },
    );

    // Session two was last read near its start.
    act(() => {
      el.scrollTop = 4_900;
      hook.result.current.onScroll({ currentTarget: el } as unknown as UIEvent<HTMLElement>);
    });
    hook.rerender({ key: "chat:ses_two" });

    expect(el.scrollTop).toBe(5_000); // unseen key → its own default, not a re-pin
    act(() => {
      el.scrollTop = 300;
      hook.result.current.onScroll({ currentTarget: el } as unknown as UIEvent<HTMLElement>);
    });
    hook.rerender({ key: "chat:ses_one" });
    hook.rerender({ key: "chat:ses_two" });

    expect(el.scrollTop).toBe(300); // came back to where session two was left
  });
});
