// One stream per browser tab, for everything it follows.
//
// A browser opens at most six connections to one host and port over plain
// HTTP/1.1 — what a LAN address gets — and every tab shares them. A tab used
// to hold a stream per folder it showed and one per terminal pane, so two tabs
// of a real workbench took all six and every other request from the browser
// waited forever. Now each tab holds one (`GET /v1/mux`, see the gateway's
// `mux_open`), and says over short requests what should flow down it.
import type { EventStreamOpener } from "@ai4s/sdk";
import { gatewayOrigin, gatewayToken } from "./webMode";
import type { TerminalControl, TerminalViewer } from "./terminalTransport";

export type MuxSpec =
  | { kind: "events"; directory?: string }
  | { kind: "terminal"; id: string; viewer?: TerminalViewer };

export interface MuxHandler {
  /** It is flowing. */
  onOpen: () => void;
  /** An event's data, or a chunk of a shell's output. */
  onData: (data: string) => void;
  /** Who controls a terminal now (terminals only). */
  onControl?: (control: TerminalControl) => void;
  /** It stopped: `exit`, the shell ended; `gone`, it cannot (or can no longer)
   *  be followed; `drop`, the tab's stream dropped — follow again to resume. */
  onEnd: (why: "exit" | "gone" | "drop") => void;
}

interface Frame {
  mux?: string;
  k?: string;
  open?: boolean;
  d?: string;
  c?: TerminalControl;
  exit?: boolean;
  gone?: boolean;
}

const subs = new Map<string, MuxHandler>();
let seq = 0;
/** The open stream's id, while it is up (or coming up). */
let current: Promise<string> | null = null;

const auth = (): Record<string, string> => {
  const token = gatewayToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

function open(): Promise<string> {
  return new Promise((resolve, reject) => {
    let named = false;
    // Everything following this stream ends with it; each decides whether to
    // follow again (which opens a new one).
    const drop = () => {
      current = null;
      const ended = [...subs.values()];
      subs.clear();
      for (const h of ended) h.onEnd("drop");
      if (!named) reject(new Error("the tab's stream did not open"));
    };
    fetch(`${gatewayOrigin()}/v1/mux`, { headers: auth() })
      .then(async (res) => {
        if (!res.ok || !res.body) return drop();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          for (let end = buffered.indexOf("\n\n"); end >= 0; end = buffered.indexOf("\n\n")) {
            const block = buffered.slice(0, end);
            buffered = buffered.slice(end + 2);
            const data = block
              .split("\n")
              .filter((l) => l.startsWith("data: "))
              .map((l) => l.slice(6))
              .join("\n");
            if (!data) continue; // a keepalive
            let frame: Frame;
            try {
              frame = JSON.parse(data) as Frame;
            } catch {
              continue;
            }
            if (typeof frame.mux === "string") {
              named = true;
              resolve(frame.mux);
              continue;
            }
            const h = frame.k ? subs.get(frame.k) : undefined;
            if (!h || !frame.k) continue;
            if (frame.open) h.onOpen();
            else if (typeof frame.d === "string") h.onData(frame.d);
            else if (frame.c) h.onControl?.(frame.c);
            else if (frame.exit || frame.gone) {
              subs.delete(frame.k);
              h.onEnd(frame.exit ? "exit" : "gone");
            }
          }
        }
        drop();
      })
      .catch(drop);
  });
}

async function change(id: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${gatewayOrigin()}/v1/mux/${id}`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Follow `spec` over this tab's one stream. Returns how to stop. */
export function follow(spec: MuxSpec, h: MuxHandler): () => void {
  const key = `s${++seq}`;
  subs.set(key, h);
  void (async () => {
    let id: string;
    try {
      current ??= open();
      id = await current;
    } catch {
      return; // the drop already told every follower, this one included
    }
    if (!subs.has(key)) return; // stopped before it started
    // The stream died between being named and this: same as a drop.
    if (!(await change(id, { add: [{ key, ...spec }] })) && subs.delete(key)) h.onEnd("drop");
  })();
  return () => {
    if (!subs.delete(key)) return;
    void current?.then((id) => change(id, { remove: [key] })).catch(() => {});
  };
}

/** A sidecar event stream over the tab's one stream, for `OpenCodeClient`. */
export const followEvents: EventStreamOpener = (directory, h) =>
  follow(directory ? { kind: "events", directory } : { kind: "events" }, {
    onOpen: h.onOpen,
    onData: h.onMessage,
    onEnd: () => h.onError(),
  });
