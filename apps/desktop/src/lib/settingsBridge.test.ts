import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./tauri", () => ({ isTauri: true }));

// A small registry: what the bridge does does not depend on which settings exist.
const values = vi.hoisted(() => ({ enabled: false, lan: false, terminal: false, approval: "approve", zoom: 1 }));
const writes = vi.hoisted(() => [] as string[]);
vi.mock("./settingsRegistry", async (importOriginal) => {
  const real = await importOriginal<typeof import("./settingsRegistry")>();
  const def = (key: string, field: keyof typeof values, extra: object = {}) => ({
    key,
    section: "remote",
    label: "remote.enable",
    kind: typeof values[field] === "boolean" ? "bool" : typeof values[field] === "number" ? "number" : "enum",
    read: async () => values[field],
    write: async (v: never) => {
      if (key === "appearance.zoom" && v === 2) throw new Error("no");
      writes.push(key);
      (values as Record<string, unknown>)[field] = v;
    },
    ...extra,
  });
  const SETTINGS = [
    def("approval.mode", "approval", { options: ["approve", "full"], restarts: true }),
    def("remote.enabled", "enabled"),
    def("remote.lan", "lan", { requires: { "remote.enabled": true } }),
    def("remote.terminal", "terminal"),
    def("appearance.zoom", "zoom", { min: 0.5, max: 3 }),
  ];
  return { ...real, SETTINGS, settingDef: (k: string) => SETTINGS.find((s) => s.key === k) };
});

import { checkChanges, decide, handle, useSettingsRequests } from "./settingsBridge";

beforeEach(() => {
  Object.assign(values, { enabled: false, lan: false, terminal: false, approval: "approve", zoom: 1 });
  writes.length = 0;
  invoke.mockClear();
  useSettingsRequests.setState({ queue: [] });
});

describe("a change request", () => {
  it("names each change from its value now, and refuses what it cannot be", async () => {
    const ok = await checkChanges({ "remote.terminal": "on", "appearance.zoom": "1.5" });
    expect(Array.isArray(ok) && ok.map((c) => [c.def.key, c.from, c.to])).toEqual([
      ["remote.terminal", false, true],
      ["appearance.zoom", 1, 1.5],
    ]);
    expect(await checkChanges({ "remote.nope": "on" })).toMatch(/no setting remote.nope/);
    expect(await checkChanges({ "remote.terminal": "maybe" })).toMatch(/on or off/);
    expect(await checkChanges({ "appearance.zoom": "9" })).toMatch(/from 0.5 to 3/);
  });

  it("leaves out what is already so, and asks for what a change needs", async () => {
    expect(await checkChanges({ "remote.terminal": "off" })).toEqual([]);
    expect(await checkChanges({ "remote.lan": "on" })).toMatch(/remote.enabled=true; ask for both/);
    const both = await checkChanges({ "remote.lan": "on", "remote.enabled": "on" });
    expect(Array.isArray(both) && both.length).toBe(2);
  });

  it("puts a change that restarts the runtime last", async () => {
    const c = await checkChanges({ "approval.mode": "full", "remote.terminal": "on" });
    expect(Array.isArray(c) && c.map((x) => x.def.key)).toEqual(["remote.terminal", "approval.mode"]);
  });

  it("waits for the user; one already so is answered at once", async () => {
    await handle({ id: "set_1", kind: "change", changes: { "remote.terminal": "on" }, reason: "r", from: "ses_a" });
    expect(useSettingsRequests.getState().queue.map((q) => q.id)).toEqual(["set_1"]);
    expect(invoke).not.toHaveBeenCalled();
    await handle({ id: "set_2", kind: "change", changes: { "remote.enabled": "off" }, reason: "r" });
    expect(invoke).toHaveBeenCalledWith("settings_answer", {
      id: "set_2",
      answer: { status: "approved", applied: ["remote.enabled"], declined: [], failed: {} },
    });
  });

  it("an invalid one is refused without asking the user", async () => {
    await handle({ id: "set_3", kind: "change", changes: { "remote.nope": "1" }, reason: "r" });
    expect(useSettingsRequests.getState().queue).toEqual([]);
    expect(invoke).toHaveBeenCalledWith("settings_answer", {
      id: "set_3",
      answer: { status: "invalid", error: expect.stringContaining("no setting") },
    });
  });

  it("a newer request from the same conversation replaces the one waiting", async () => {
    await handle({ id: "set_1", kind: "change", changes: { "remote.terminal": "on" }, reason: "r", from: "ses_a" });
    await handle({ id: "set_2", kind: "change", changes: { "remote.enabled": "on" }, reason: "r", from: "ses_a", replaces: "set_1" });
    expect(useSettingsRequests.getState().queue.map((q) => q.id)).toEqual(["set_2"]);
  });
});

describe("the user's decision", () => {
  it("applies what was kept, reports the rest", async () => {
    const changes = await checkChanges({ "remote.terminal": "on", "remote.enabled": "on", "appearance.zoom": "2" });
    if (!Array.isArray(changes)) throw new Error(changes);
    const r = { id: "set_1", from: null, reason: "r", changes };
    const d = await decide(r, new Set(["remote.terminal", "appearance.zoom"]));
    expect(d).toEqual({ status: "approved", applied: ["remote.terminal"], declined: ["remote.enabled"], failed: { "appearance.zoom": "no" } });
    expect(writes).toEqual(["remote.terminal"]);
    expect(await decide(r, new Set())).toEqual({ status: "denied" });
  });

  it("a read answers every setting with its value", async () => {
    await handle({ id: "set_r", kind: "read" });
    const call = invoke.mock.calls[0] as unknown as [string, { answer: { settings: { key: string; value: unknown }[] } }];
    expect(call[1].answer.settings.find((s) => s.key === "remote.terminal")?.value).toBe(false);
    expect(call[1].answer.settings).toHaveLength(5);
  });
});
