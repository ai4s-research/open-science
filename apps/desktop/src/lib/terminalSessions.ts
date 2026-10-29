// Terminals that outlive their React component.
//
// Splitting a pane moves its leaf DEEPER in the tree — leaf A becomes a child
// of a new split node — and React unmounts anything that changes position,
// keys or not. A terminal whose lifetime followed its component therefore lost
// its shell every time the user split the pane beside it.
//
// So the terminal lives here instead: one xterm instance and one detached DOM
// node per leaf id, re-parented into whatever element is currently rendering
// it. The shell is killed only when the LEAF is gone — which the layout knows
// and React does not.
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import { create } from "zustand";
import type { TerminalProbe } from "./layout";
import { isTauri } from "./tauri";
import { terminalTransport, type TerminalViewer } from "./terminalTransport";

interface LiveTerminal {
  term: Terminal;
  fit: FitAddon;
  /** Find-in-terminal. Lives with the terminal, not with the search bar, so
   *  closing and reopening the bar does not lose the buffer's decorations. */
  search: SearchAddon;
  /** The terminal's own element, kept alive while it is parked. */
  container: HTMLDivElement;
  /** Take control of the shell from the view that has it. */
  takeOver: () => void;
  dispose: () => void;
}

/** The terminals this view follows, with the kind of view that controls each
 *  (see `TerminalControl`). Shown as a mask over each. */
export const useTerminalFollowing = create<Record<string, TerminalViewer["kind"]>>(() => ({}));

export function setTerminalFollowing(leafId: string, by: TerminalViewer["kind"] | null): void {
  useTerminalFollowing.setState((s) => {
    if ((s[leafId] ?? null) === by) return s;
    const next = { ...s };
    if (by) next[leafId] = by;
    else delete next[leafId];
    return next;
  }, true);
}

/** Take control of every terminal this view follows. */
export function takeOverAll(): void {
  for (const leafId of Object.keys(useTerminalFollowing.getState())) live.get(leafId)?.takeOver();
}

const live = new Map<string, LiveTerminal>();

/** Terminals the user has actually typed into.
 *
 *  Closing one of these stops a shell and whatever it is running, so it is
 *  worth a question. A terminal opened a moment ago and never touched is an
 *  empty slot — asking about it would train the reader to dismiss the question
 *  without reading it, which is exactly what makes a confirmation useless when
 *  it matters. */
const used = new Set<string>();

/** Called on the first keystroke that reaches the shell. */
export function markTerminalUsed(leafId: string): void {
  used.add(leafId);
}

export function isTerminalUsed(leafId: string): boolean {
  return used.has(leafId);
}

export function getTerminal(leafId: string): LiveTerminal | undefined {
  return live.get(leafId);
}

export function putTerminal(leafId: string, terminal: LiveTerminal): void {
  live.set(leafId, terminal);
  ensureTerminalProbe();
}

/** How often the layout re-reads what each terminal is doing. Slow enough to
 *  cost nothing (a few file reads per terminal), fast enough that quitting
 *  right after `cd` or starting `claude` still records it. */
const PROBE_INTERVAL_MS = 3000;
let probing = false;

/** Start following every live terminal's folder and coding agent into the
 *  layout (`recordTerminal`). Once per app, from the first terminal on. */
function ensureTerminalProbe(): void {
  // The probe reads the desktop's own processes; a web client has no view of them.
  if (probing || !isTauri || typeof window === "undefined") return;
  probing = true;
  window.setInterval(() => void probeOnce(), PROBE_INTERVAL_MS);
}

async function probeOnce(): Promise<void> {
  if (live.size === 0) return;
  try {
    const [{ invoke }, { useLayoutStore }] = await Promise.all([
      import("@tauri-apps/api/core"),
      import("./layout"),
    ]);
    const report = await invoke<Record<string, TerminalProbe>>("terminal_probe");
    const { recordTerminal } = useLayoutStore.getState();
    for (const [leafId, probe] of Object.entries(report)) recordTerminal(leafId, probe);
  } catch {
    // A missed look is harmless: the next one is three seconds away.
  }
}

/** Every terminal currently alive, for the layout to compare against. */
export function liveTerminalIds(): string[] {
  return [...live.keys()];
}

/**
 * Tear one down for good: the xterm instance, its element, and the shell.
 *
 * Called when a pane is closed, never when it merely re-renders — that is the
 * whole distinction this module exists to keep.
 */
export function destroyTerminal(leafId: string): void {
  const terminal = live.get(leafId);
  used.delete(leafId);
  if (!terminal) return;
  live.delete(leafId);
  setTerminalFollowing(leafId, null);
  terminal.dispose();
  terminal.term.dispose();
  terminal.container.remove();
  void closePty(leafId);
}

async function closePty(leafId: string): Promise<void> {
  try {
    await terminalTransport.close(leafId);
  } catch {
    // The window is going away; the Rust side kills every shell on exit.
  }
}

/**
 * Drop the saved exports (see terminal_env.rs) of panes that no longer exist.
 *
 * Once, at startup, with the restored layout: leaf ids are reused once the
 * highest one is gone, so a leftover record would otherwise be sourced into an
 * unrelated new pane. Later is too late — that new pane is then "open".
 */
export async function pruneTerminalEnv(openLeafIds: string[]): Promise<void> {
  if (!isTauri) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("terminal_env_prune", { open: openLeafIds });
  } catch {
    // Not the desktop app, or nothing to prune: a leftover only costs a file.
  }
}

/**
 * Kill the terminals whose panes no longer exist.
 *
 * The layout is the authority on what is open: a leaf that has left every
 * Screen's tree is closed, whatever React did or did not unmount.
 */
export function pruneTerminals(openLeafIds: Iterable<string>): void {
  const open = new Set(openLeafIds);
  for (const id of liveTerminalIds()) {
    if (!open.has(id)) destroyTerminal(id);
  }
}
