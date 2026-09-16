// What the status bar's right-hand segments read, from `src-tauri/status_bar.rs`.
//
// Everything here is scoped to THIS app's own process tree — see that module's
// note on why a machine-wide figure would be someone else's number.
import { isTauri } from "./tauri";

/** One thing the user opened, and what it is costing. Orca lists a row per
 *  session for the same reason: a total tells you the workbench is heavy, a row
 *  tells you which pane to go and look at. */
export interface ResourceGroup {
  /** "terminal" | "kernel" | "app". */
  kind: string;
  /** The terminal's pane id, or the kernel's notebook path. Empty for `app`. */
  id: string;
  /** The heaviest process's own name, when nothing better is known. */
  label: string;
  memoryBytes: number;
  cpuPercent: number;
  processCount: number;
}

export interface ResourceUsage {
  /** Resident memory of this app and everything it started. */
  memoryBytes: number;
  processCount: number;
  cpuPercent: number;
  /** Heaviest first. */
  groups: ResourceGroup[];
}

/** A kernel's group id is its map key, `python:/abs/path/to.ipynb`. The path is
 *  what the reader recognises; the language prefix is bookkeeping. */
export function kernelNotebookName(id: string): string {
  const path = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  return path.split("/").pop() || path;
}

export interface ListeningPort {
  port: number;
  pid: number;
  command: string;
  /** Bound to a public interface rather than loopback. */
  public: boolean;
}

/** Keep the machine awake: always, only while an agent is working, or never.
 *  Orca's three modes (`computer-awake-mode`), for the same reason — a long
 *  agent run that the lid closes on is a wasted run. */
export type AwakeMode = "on" | "auto" | "off";
export const AWAKE_MODES: AwakeMode[] = ["on", "auto", "off"];

const AWAKE_KEY = "ai4s.awake.mode.v1";

export function storedAwakeMode(): AwakeMode {
  try {
    const value = window.localStorage.getItem(AWAKE_KEY);
    return AWAKE_MODES.includes(value as AwakeMode) ? (value as AwakeMode) : "off";
  } catch {
    return "off";
  }
}

export function storeAwakeMode(mode: AwakeMode): void {
  try {
    window.localStorage.setItem(AWAKE_KEY, mode);
  } catch {
    /* the mode still applies to this run; only the memory of it is lost */
  }
}

/** Whether the machine should be held awake right now. */
export function shouldHoldAwake(mode: AwakeMode, agentsWorking: boolean): boolean {
  return mode === "on" || (mode === "auto" && agentsWorking);
}

export async function fetchResources(): Promise<ResourceUsage | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ResourceUsage>("system_resources");
}

export async function fetchPorts(): Promise<ListeningPort[]> {
  if (!isTauri) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ListeningPort[]>("listening_ports");
}

export async function holdAwake(on: boolean): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("awake_hold", { on });
}

/** `12.29 GB`, `840 MB` — two decimals in GB, as Orca's badge shows, because a
 *  workbench climbs by tens of megabytes and a single decimal hides that. */
export function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/** The address a listening port answers on, for opening it in a browser. */
export function portUrl(port: ListeningPort): string {
  return `http://localhost:${port.port}`;
}
