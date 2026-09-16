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

interface LiveTerminal {
  term: Terminal;
  fit: FitAddon;
  /** The terminal's own element, kept alive while it is parked. */
  container: HTMLDivElement;
  dispose: () => void;
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
  terminal.dispose();
  terminal.term.dispose();
  terminal.container.remove();
  void closePty(leafId);
}

async function closePty(leafId: string): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("terminal_close", { id: leafId });
  } catch {
    // The window is going away; the Rust side kills every shell on exit.
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
