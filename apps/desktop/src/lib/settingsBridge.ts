// The window's side of `osd settings`. The gateway hands it each request
// (`gateway:settings`): a read is answered at once from the registry; a change
// is checked, then waits in `useSettingsRequests` for the user to decide in
// SettingsRequestDialog. Every answer goes back through `settings_answer`.
import { create } from "zustand";
import i18n from "@/i18n";
import { isTauri } from "./tauri";
import { parseValue, settingDef, SETTINGS, type SettingDef, type SettingValue } from "./settingsRegistry";

export interface SettingChange {
  def: SettingDef;
  from: SettingValue;
  to: SettingValue;
}

export interface SettingsRequest {
  id: string;
  /** The conversation that asked, when an agent did. */
  from: string | null;
  reason: string;
  changes: SettingChange[];
}

interface RequestsState {
  queue: SettingsRequest[];
  push: (r: SettingsRequest, replaces: string | null) => void;
  drop: (id: string) => void;
}

export const useSettingsRequests = create<RequestsState>((set) => ({
  queue: [],
  push: (r, replaces) => set((s) => ({ queue: [...s.queue.filter((q) => q.id !== replaces), r] })),
  drop: (id) => set((s) => ({ queue: s.queue.filter((q) => q.id !== id) })),
}));

export type Decision =
  | { status: "approved"; applied: string[]; declined: string[]; failed: Record<string, string> }
  | { status: "denied" };

export type Answer =
  | Decision
  | { status: "invalid"; error: string }
  | { settings: unknown[] };

export async function answer(id: string, a: Answer): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("settings_answer", { id, answer: a });
}

/** Every setting with its value, labelled in English (agents read this). */
export async function snapshot(): Promise<unknown[]> {
  const en = i18n.getFixedT("en", "settings");
  return Promise.all(
    SETTINGS.map(async (d) => ({
      key: d.key,
      section: d.section,
      label: en(d.label),
      kind: d.kind,
      value: await d.read().catch(() => null),
      ...(d.options ? { options: d.options } : {}),
      ...(d.min !== undefined ? { min: d.min, max: d.max } : {}),
    })),
  );
}

/** A change request as the user will see it, or why it cannot be one.
 *  Changes to what a setting already is are dropped: nothing to decide. */
export async function checkChanges(raw: Record<string, unknown>): Promise<SettingChange[] | string> {
  const changes: SettingChange[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const def = settingDef(key);
    if (!def) return `no setting ${key}; osd settings lists them`;
    let to: SettingValue;
    try {
      to = parseValue(def, value);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    const from = await def.read();
    if (from !== to) changes.push({ def, from, to });
  }
  for (const c of changes) {
    for (const [key, want] of Object.entries(c.def.requires ?? {})) {
      const asked = changes.find((x) => x.def.key === key);
      const now = asked ? asked.to : await settingDef(key)?.read();
      if (now !== want) return `${c.def.key} takes effect only with ${key}=${String(want)}; ask for both`;
    }
  }
  // Settings that restart the runtime go last: the restart stops the turn
  // that asked, and the rest should already be in place by then.
  return changes.sort((a, b) => Number(!!a.def.restarts) - Number(!!b.def.restarts));
}

interface Incoming {
  id: string;
  kind: "read" | "change";
  changes?: Record<string, unknown>;
  reason?: string;
  from?: string | null;
  replaces?: string | null;
}

export async function handle(req: Incoming): Promise<void> {
  if (req.kind === "read") return answer(req.id, { settings: await snapshot() });
  const checked = await checkChanges(req.changes ?? {});
  if (typeof checked === "string") return answer(req.id, { status: "invalid", error: checked });
  const keys = Object.keys(req.changes ?? {});
  if (checked.length === 0) return answer(req.id, { status: "approved", applied: keys, declined: [], failed: {} });
  if (req.replaces) useSettingsRequests.getState().drop(req.replaces);
  useSettingsRequests.getState().push(
    { id: req.id, from: req.from ?? null, reason: req.reason ?? "", changes: checked },
    req.replaces ?? null,
  );
}

/** Apply the changes the user kept, in order; report each one. */
export async function decide(r: SettingsRequest, keep: Set<string>): Promise<Decision> {
  if (keep.size === 0) return { status: "denied" };
  const applied: string[] = [];
  const declined: string[] = [];
  const failed: Record<string, string> = {};
  for (const c of r.changes) {
    if (!keep.has(c.def.key)) {
      declined.push(c.def.key);
      continue;
    }
    try {
      await c.def.write(c.to);
      applied.push(c.def.key);
    } catch (e) {
      failed[c.def.key] = e instanceof Error ? e.message : String(e);
    }
  }
  window.dispatchEvent(new Event(SETTINGS_CHANGED));
  return { status: "approved", applied, declined, failed };
}

/** Fired after an approved change, so an open Settings page reloads. */
export const SETTINGS_CHANGED = "osd:settings-changed";

if (isTauri) {
  void import("@tauri-apps/api/event").then(({ listen }) =>
    listen<string>("gateway:settings", (e) => {
      let req: Incoming;
      try {
        req = JSON.parse(e.payload) as Incoming;
      } catch {
        return;
      }
      void handle(req).catch((err: unknown) =>
        answer(req.id, { status: "invalid", error: err instanceof Error ? err.message : String(err) }),
      );
    }),
  );
}
