// The settings `osd settings` can read and ask to change — one list, each entry
// calling the same functions the Settings page does, so a change approved here
// is the change the page would have made.
//
// Not here on purpose: secrets (API keys, sign-ins, passwords, tokens), and
// lists edited item by item (providers, MCP servers, accounts). Those stay in
// Settings, where the user types them.
import {
  getGatewayStatus,
  getMemoryEnabled,
  getMirrorSetting,
  getProxySetting,
  setGatewayConfig,
  setMemoryEnabled,
  setMirrorSetting,
  type GatewayStatus,
} from "./tauri";
import { useRuntimeStore } from "./runtime";
import { THEME_VARIANTS, useUiStore, ZOOM_MAX, ZOOM_MIN, type Theme, type ThemeVariant } from "./store";
import { useUpdateStore } from "./update";
import { localeMeta, shippedLocales } from "@/i18n/config";
import type { ParseKeys } from "i18next";
import type { SettingsSection } from "@/components/settings/sections";

/** A key of the `settings` i18n namespace. */
export type SettingsKey = ParseKeys<"settings">;

export type SettingValue = boolean | number | string;

export interface SettingDef {
  key: string;
  section: SettingsSection;
  label: SettingsKey;
  kind: "bool" | "enum" | "number" | "text";
  /** For `enum`: the values, and the i18n key naming each (`settings` ns). */
  options?: readonly string[];
  optionLabel?: (v: string) => SettingsKey;
  /** For values named outside i18n (a language by its own name). */
  display?: (v: string) => string;
  min?: number;
  max?: number;
  /** Widens what reaches this machine or what runs without asking: the
   *  dialog says so, with `hint`. */
  sensitive?: boolean;
  /** Shown under the change. */
  hint?: SettingsKey;
  /** Changing it restarts the agent runtime, which stops running turns. */
  restarts?: boolean;
  /** Settings it takes effect only with — as they are, or as the same
   *  request sets them. */
  requires?: Readonly<Record<string, SettingValue>>;
  read: () => Promise<SettingValue>;
  write: (v: SettingValue) => Promise<void>;
}

async function gateway(): Promise<GatewayStatus> {
  const s = await getGatewayStatus();
  if (!s) throw new Error("remote access is not available here");
  return s;
}

/** Change one field of the gateway config, keeping the rest as it is. */
async function setGateway(patch: Partial<Pick<GatewayStatus, "enabled" | "lan" | "mode" | "terminal">>) {
  const s = { ...(await gateway()), ...patch };
  await setGatewayConfig(s.enabled, s.lan, s.mode, s.configuredPort, s.terminal);
}

const runtime = () => useRuntimeStore.getState();
const ui = () => useUiStore.getState();
const updates = () => useUpdateStore.getState();

async function proxy() {
  const p = await getProxySetting();
  if (!p) throw new Error("the proxy is not available here");
  return p;
}

async function mirror() {
  const m = await getMirrorSetting();
  if (!m) throw new Error("mirrors are not available here");
  return m;
}

const stall = (patch: Parameters<ReturnType<typeof runtime>["setStallGuard"]>[0]) => runtime().setStallGuard(patch);

export const SETTINGS: readonly SettingDef[] = [
  {
    key: "remote.enabled",
    section: "remote",
    label: "remote.enable",
    kind: "bool",
    sensitive: true,
    hint: "remote.enableHint",
    read: async () => (await gateway()).enabled,
    write: (v) => setGateway({ enabled: v as boolean }),
  },
  {
    key: "remote.lan",
    section: "remote",
    label: "remote.bindingLan",
    kind: "bool",
    sensitive: true,
    hint: "remote.lanActive",
    requires: { "remote.enabled": true },
    read: async () => (await gateway()).lan,
    write: (v) => setGateway({ lan: v as boolean }),
  },
  {
    key: "remote.mode",
    section: "remote",
    label: "remote.mode",
    kind: "enum",
    options: ["full", "read-only"],
    optionLabel: (v) => (v === "full" ? "remote.modeFull" : "remote.modeReadonly"),
    requires: { "remote.enabled": true },
    read: async () => (await gateway()).mode,
    write: (v) => setGateway({ mode: v as GatewayStatus["mode"] }),
  },
  {
    key: "remote.terminal",
    section: "remote",
    label: "remote.terminal",
    kind: "bool",
    sensitive: true,
    hint: "remote.terminalHint",
    read: async () => (await gateway()).terminal,
    write: (v) => setGateway({ terminal: v as boolean }),
  },
  {
    key: "approval.mode",
    section: "agents",
    label: "request.approvalMode",
    kind: "enum",
    options: ["approve", "full"],
    optionLabel: (v) => (v === "full" ? "request.approvalFull" : "request.approvalApprove"),
    sensitive: true,
    hint: "request.approvalFullHint",
    restarts: true,
    read: async () => runtime().approvalMode,
    write: (v) => runtime().setApprovalMode(v as "approve" | "full"),
  },
  {
    key: "memory.enabled",
    section: "memory",
    label: "memory.enableLabel",
    kind: "bool",
    read: () => getMemoryEnabled(),
    write: (v) => setMemoryEnabled(v as boolean),
  },
  {
    key: "network.proxy",
    section: "network",
    label: "runtime.proxyLabel",
    kind: "enum",
    options: ["system", "custom", "none"],
    optionLabel: (v) => (v === "system" ? "runtime.proxySystem" : v === "custom" ? "runtime.proxyCustom" : "runtime.proxyNone"),
    restarts: true,
    read: async () => (await proxy()).mode,
    write: async (v) => {
      const p = await proxy();
      if (v === "custom" && !p.url) throw new Error("set network.proxyUrl in the same request");
      await runtime().setProxySetting(v as "system" | "custom" | "none", v === "custom" ? p.url : "", p.bypass);
    },
  },
  {
    key: "network.proxyUrl",
    section: "network",
    label: "request.proxyUrl",
    kind: "text",
    restarts: true,
    read: async () => (await proxy()).url,
    write: async (v) => {
      const url = String(v).trim();
      if (!/^https?:\/\/\S+:\d+\/?$/i.test(url)) throw new Error("an http(s)://host:port address");
      const p = await proxy();
      await runtime().setProxySetting("custom", url, p.bypass);
    },
  },
  {
    key: "network.proxyBypass",
    section: "network",
    label: "runtime.proxyBypassLabel",
    kind: "text",
    restarts: true,
    read: async () => (await proxy()).bypass.join(", "),
    write: async (v) => {
      const p = await proxy();
      await runtime().setProxySetting(p.mode, p.url, String(v).split(/[\s,]+/).filter(Boolean));
    },
  },
  {
    key: "network.pypiMirror",
    section: "network",
    label: "runtime.mirrorPypi",
    kind: "text",
    read: async () => (await mirror()).pypi,
    write: async (v) => setMirrorSetting(String(v).trim(), (await mirror()).python),
  },
  {
    key: "network.pythonMirror",
    section: "network",
    label: "runtime.mirrorPython",
    kind: "text",
    read: async () => (await mirror()).python,
    write: async (v) => setMirrorSetting((await mirror()).pypi, String(v).trim()),
  },
  {
    key: "review.auto",
    section: "general",
    label: "review.autoTitle",
    kind: "bool",
    read: async () => runtime().autoReview,
    write: async (v) => runtime().setAutoReview(v as boolean),
  },
  {
    key: "notify.turnComplete",
    section: "general",
    label: "notify.turnCompleteTitle",
    kind: "bool",
    read: async () => runtime().turnNotify,
    write: async (v) => runtime().setTurnNotify(v as boolean),
  },
  {
    key: "stall.enabled",
    section: "general",
    label: "stall.enableTitle",
    kind: "bool",
    read: async () => runtime().stallGuard.enabled,
    write: async (v) => stall({ enabled: v as boolean }),
  },
  {
    key: "stall.silenceMinutes",
    section: "general",
    label: "request.stallSilenceMinutes",
    kind: "number",
    min: 1,
    max: 240,
    read: async () => runtime().stallGuard.silenceMinutes,
    write: async (v) => stall({ silenceMinutes: v as number, channelAEnabled: true }),
  },
  {
    key: "stall.repeatThreshold",
    section: "general",
    label: "request.stallRepeatThreshold",
    kind: "number",
    min: 2,
    max: 100,
    read: async () => runtime().stallGuard.repeatThreshold,
    write: async (v) => stall({ repeatThreshold: v as number, channelBEnabled: true }),
  },
  {
    key: "appearance.theme",
    section: "appearance",
    label: "appearance.themeLabel",
    kind: "enum",
    options: ["light", "warm", "dark", "system"],
    optionLabel: (v) => `appearance.theme.${v as Theme}`,
    read: async () => ui().theme,
    write: async (v) => ui().setTheme(v as Theme),
  },
  {
    key: "appearance.warmVariant",
    section: "appearance",
    label: "appearance.variantLabel.warm",
    kind: "enum",
    options: [...THEME_VARIANTS.warm],
    optionLabel: (v) => `appearance.variant.${v as ThemeVariant}`,
    read: async () => ui().themeVariants.warm,
    write: async (v) => ui().setThemeVariant("warm", v as ThemeVariant),
  },
  {
    key: "appearance.darkVariant",
    section: "appearance",
    label: "appearance.variantLabel.dark",
    kind: "enum",
    options: [...THEME_VARIANTS.dark],
    optionLabel: (v) => `appearance.variant.${v as ThemeVariant}`,
    read: async () => ui().themeVariants.dark,
    write: async (v) => ui().setThemeVariant("dark", v as ThemeVariant),
  },
  {
    key: "appearance.language",
    section: "appearance",
    label: "language.label",
    kind: "enum",
    options: shippedLocales().map((l) => l.code),
    display: (v) => localeMeta(v)?.nativeName ?? v,
    read: async () => ui().locale,
    write: async (v) => ui().setLocale(v as string),
  },
  {
    key: "appearance.zoom",
    section: "appearance",
    label: "appearance.zoom.label",
    kind: "number",
    min: ZOOM_MIN,
    max: ZOOM_MAX,
    read: async () => ui().zoom,
    write: async (v) => ui().setZoom(v as number),
  },
  {
    key: "updates.autoCheck",
    section: "general",
    label: "updates.autoCheck",
    kind: "bool",
    read: async () => updates().enabled,
    write: async (v) => updates().setEnabled(v as boolean),
  },
  {
    key: "updates.badge",
    section: "general",
    label: "updates.showBadge",
    kind: "bool",
    read: async () => updates().badgeEnabled,
    write: async (v) => updates().setBadgeEnabled(v as boolean),
  },
];

export function settingDef(key: string): SettingDef | undefined {
  return SETTINGS.find((s) => s.key === key);
}

const TRUE = ["on", "true", "yes", "1"];
const FALSE = ["off", "false", "no", "0"];

/** A value as typed (`osd settings set k=v` sends text), read as the
 *  setting's type. Throws with what the setting takes. */
export function parseValue(def: SettingDef, raw: unknown): SettingValue {
  const text = String(raw).trim();
  switch (def.kind) {
    case "bool": {
      if (typeof raw === "boolean") return raw;
      if (TRUE.includes(text.toLowerCase())) return true;
      if (FALSE.includes(text.toLowerCase())) return false;
      throw new Error(`${def.key} is on or off`);
    }
    case "enum": {
      if (def.options?.includes(text)) return text;
      throw new Error(`${def.key} is one of ${def.options?.join(", ")}`);
    }
    case "number": {
      const n = Number(text);
      if (text === "" || !Number.isFinite(n) || (def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max))
        throw new Error(`${def.key} is a number from ${def.min} to ${def.max}`);
      return n;
    }
    case "text":
      return text;
  }
}
