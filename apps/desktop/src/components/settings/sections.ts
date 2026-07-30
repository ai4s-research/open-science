import {
  BookMarked,
  Cloud,
  Cpu,
  Globe,
  Palette,
  Plug,
  Radio,
  Settings,
  Shapes,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

/** Settings sections — the sidebar nav and `/settings/:section` routes.
 *  Labels come from the settings i18n namespace under `nav.<key>`.
 *  `desktopOnly` sections depend on Tauri IPC the gateway can't expose, so they
 *  are hidden in the browser (gateway) web client. */
export const SETTINGS_SECTIONS = [
  { key: "general", icon: Settings },
  { key: "appearance", icon: Palette },
  { key: "models", icon: Shapes },
  // Memory is edited as files in the app profile / project folder — Tauri IPC.
  { key: "memory", icon: BookMarked, desktopOnly: true },
  { key: "runtime", icon: Cpu, desktopOnly: true },
  { key: "connectors", icon: Plug, desktopOnly: true },
  { key: "browser", icon: Globe, desktopOnly: true },
  { key: "compute", icon: Cloud, desktopOnly: true },
  { key: "remote", icon: Radio, desktopOnly: true },
  { key: "privacy", icon: ShieldCheck },
] as const satisfies ReadonlyArray<{ key: string; icon: LucideIcon; desktopOnly?: boolean }>;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["key"];

/** Sections to show: all on desktop; drop `desktopOnly` ones in the web client. */
export function visibleSections(isWeb: boolean) {
  return isWeb ? SETTINGS_SECTIONS.filter((s) => !("desktopOnly" in s && s.desktopOnly)) : SETTINGS_SECTIONS;
}

export function resolveSection(raw: string | undefined): SettingsSection {
  return (SETTINGS_SECTIONS.find((s) => s.key === raw)?.key ?? "general") as SettingsSection;
}
