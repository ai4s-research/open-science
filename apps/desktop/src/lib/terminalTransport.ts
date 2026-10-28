// How a terminal pane reaches its shell.
//
// The desktop app talks to its own PTYs over Tauri commands and events. A web
// client (the remote-access gateway) reaches the SAME PTY layer on the desktop
// through `/v1/terminals/...`, which the user has to switch on in Settings. The
// pane does not care which: it opens, writes, resizes, closes and reads output.
import { isTauri } from "./tauri";
import { follow } from "./gatewayMux";
import { MAX_UPLOAD_BYTES } from "./artifactFile";
import { gatewayOrigin, gatewayPost, gatewayToken, isGatewayWeb, layoutSource, signedInAccount } from "./webMode";

/** Where a chunk sits in the shell's output, in bytes, when known (desktop). */
export interface OutputOffsets {
  /** Where the chunk starts: on the first chunk only. */
  from?: number;
  /** Where it ends. */
  end?: number;
}

export interface TerminalOutput {
  onData: (chunk: string, at?: OutputOffsets) => void;
  /** The shell exited. */
  onExit: () => void;
  /** The stream was re-established and will replay the shell's recent output:
   *  clear the screen first, or that output is drawn twice. Web only. */
  onReset: () => void;
}

/** A pane's screen as of offset `end` of its shell's output. */
export interface SavedScreen {
  end: number;
  data: string;
}

export interface Opened {
  /** True when a new shell was started; false when it was already running —
   *  then nothing may be typed into it on the pane's behalf. */
  created: boolean;
  /** The size the shell runs at, when known (desktop): its recent output was
   *  drawn for it, so a pane reopening on it starts there. */
  cols?: number;
  rows?: number;
  /** The pane's saved screen, when it fits that shell at that size. */
  screen?: SavedScreen | null;
}

export interface TerminalTransport {
  open(id: string, cwd: string | undefined, cols: number, rows: number): Promise<Opened>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  close(id: string): Promise<void>;
  /** Start reading output (recent output first, from offset `since` when
   *  that is still held); the returned function stops. */
  subscribe(id: string, output: TerminalOutput, since?: number): Promise<() => void>;
  /** Keep the pane's screen, drawn at `cols` x `rows`, for its next open.
   *  Desktop only. */
  saveScreen?(id: string, screen: SavedScreen & { cols: number; rows: number }): Promise<void>;
  /** Save a file pasted in the browser on the shell's host; returns its path,
   *  quoted for that shell, to type. Web only: the desktop pastes the copied
   *  file's own path. */
  pasteFile?(id: string, file: File): Promise<string>;
}

const desktop: TerminalTransport = {
  async open(id, cwd, cols, rows) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<Opened>("terminal_open", { id, cwd, cols, rows });
  },
  async write(id, data) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("terminal_write", { id, data });
  },
  async resize(id, cols, rows) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("terminal_resize", { id, cols, rows });
  },
  async close(id) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("terminal_close", { id });
  },
  // Recent output first: a shell that outlived the last app (it lives in the
  // terminal host) comes back with its screen, not blank.
  async subscribe(id, { onData, onExit }, since) {
    const { invoke, Channel } = await import("@tauri-apps/api/core");
    let stopped = false;
    const onEvent = new Channel<({ kind: "data"; data: string } & OutputOffsets) | { kind: "exit" }>();
    onEvent.onmessage = (event) => {
      if (stopped) return;
      if (event.kind === "data") onData(event.data, { from: event.from, end: event.end });
      else onExit();
    };
    await invoke("terminal_subscribe", { id, since: since ?? null, onEvent });
    return () => {
      stopped = true;
    };
  },
  async saveScreen(id, { end, cols, rows, data }) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("terminal_save_screen", { id, end, cols, rows, data });
  },
};

/** This browser's own name for shells that are its own. Pane ids are `p1`,
 *  `p2`… in every client, so a bare pane id would collide with a desktop
 *  terminal (which the gateway refuses an account) or with another browser's,
 *  which would then type into this one's shell. One random id per browser,
 *  kept so a reload finds its shells again. A token client following the
 *  window's Screens needs none: there the same pane id IS the same shell, on
 *  purpose. */
function clientId(): string {
  const KEY = "os_terminal_client";
  try {
    const saved = window.localStorage.getItem(KEY);
    if (saved && /^[a-z0-9]{12}$/.test(saved)) return saved;
    const fresh = randomId();
    window.localStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    return (sessionClient ??= randomId());
  }
}
let sessionClient: string | undefined;

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
}

/** Following the desktop window's Screens: its shells are this page's. */
const sharesDesktopShells = () => !signedInAccount() && layoutSource() === "desktop";

/** Each pane's shell, as named when it was opened: switching between the
 *  window's Screens and one's own must not re-route a shell already open, or
 *  leave one behind under a name nobody uses any more. */
const opened = new Map<string, { wire: string; shared: boolean }>();

function shellOf(id: string): { wire: string; shared: boolean } {
  const known = opened.get(id);
  if (known) return known;
  const shared = sharesDesktopShells();
  return { wire: shared ? id : `w${clientId()}-${id}`, shared };
}

const path = (id: string, rest = "") => `/v1/terminals/${encodeURIComponent(shellOf(id).wire)}${rest}`;
const authHeader = (): Record<string, string> => {
  const token = gatewayToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

/** How long to wait before reading a dropped output stream again. */
const RECONNECT_MS = 1000;

const web: TerminalTransport = {
  async open(id, cwd, cols, rows) {
    const shell = shellOf(id);
    opened.set(id, shell);
    const res = await gatewayPost<{ created?: boolean }>(path(id), { cwd: cwd ?? null, cols, rows });
    return { created: res?.created === true };
  },
  async write(id, data) {
    await gatewayPost(path(id, "/input"), { data });
  },
  async resize(id, cols, rows) {
    await gatewayPost(path(id, "/resize"), { cols, rows });
  },
  async pasteFile(id, file) {
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error(`${file.name}: larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    }
    const res = await fetch(`${gatewayOrigin()}${path(id, `/paste?name=${encodeURIComponent(file.name)}`)}`, {
      method: "POST",
      headers: authHeader(),
      body: file,
    });
    const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
    if (!res.ok || !body.text) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body.text;
  },
  async close(id) {
    const shell = shellOf(id);
    opened.delete(id);
    // A shell shared with the desktop window is the window's: it ends it when
    // the pane leaves the shared layout. Ending it from here as well could kill
    // one the window had just opened, from a moment the two layouts disagreed.
    if (shell.shared) return;
    const url = `${gatewayOrigin()}/v1/terminals/${encodeURIComponent(shell.wire)}`;
    await fetch(url, { method: "DELETE", headers: authHeader() });
  },
  async subscribe(id, output) {
    // Over the tab's one stream (see gatewayMux): a connection per terminal
    // pane is how two tabs used up the browser's six.
    let stopped = false;
    let stop = () => {};
    let opens = 0;
    const start = () => {
      stop = follow(
        { kind: "terminal", id: shellOf(id).wire },
        {
          // Each later open replays the shell's recent output.
          onOpen: () => {
            if (opens++ > 0) output.onReset();
          },
          onData: (chunk) => output.onData(chunk),
          onEnd: (why) => {
            if (stopped) return;
            if (why === "drop") setTimeout(() => !stopped && start(), RECONNECT_MS);
            // Gone (closed elsewhere, or access withdrawn): nothing to come back to.
            else output.onExit();
          },
        },
      );
    };
    start();
    return () => {
      stopped = true;
      stop();
    };
  },
};


export const terminalTransport: TerminalTransport = isGatewayWeb ? web : desktop;

/** The id the gateway knows a pane's shell by — what `osd term` takes. The
 *  desktop names a shell after its pane; a browser after itself and the pane
 *  (see `shellOf`), unless it is following the window's Screens. */
export function terminalShellId(leafId: string): string {
  return isGatewayWeb ? shellOf(leafId).wire : leafId;
}

/** Whether this client has terminals at all: the desktop app always, a web
 *  client only once the desktop allows it (`webTerminal`, from /v1/whoami). */
export function terminalsAvailable(webTerminal: boolean): boolean {
  return isTauri || (isGatewayWeb && webTerminal);
}
