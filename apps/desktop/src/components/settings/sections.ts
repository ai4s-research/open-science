import type { ComponentType } from "react";
import {
  IconApiOutlineRegular,
  IconBrowseOutlineRegular,
  IconContextInjectionOutlineRegular,
  IconCordisPluginOutlineRegular,
  IconDatabaseOutlineRegular,
  IconGaugeOutlineRegular,
  IconGlobeOutlineRegular,
  IconLinkOutlineRegular,
  IconPersonalizationOutlineRegular,
  IconSettingsOutlineRegular,
  IconShieldOutlineRegular,
  type IconProps,
} from "@/components/icons/dsh";

/** Settings sections — the sidebar nav and `/settings/:section` routes.
 *  Labels come from the settings i18n namespace under `nav.<key>`.
 *  `desktopOnly` sections depend on Tauri IPC the gateway can't expose, so they
 *  are hidden in the browser (gateway) web client. */
export const SETTINGS_SECTIONS = [
  { key: "general", icon: IconSettingsOutlineRegular },
  { key: "appearance", icon: IconPersonalizationOutlineRegular },
  { key: "agents", icon: IconDatabaseOutlineRegular },
  // Memory is edited as files in the app profile / project folder — Tauri IPC.
  { key: "memory", icon: IconContextInjectionOutlineRegular, desktopOnly: true },
  // Proxy, download mirrors and Python: how this machine reaches the network
  // and runs tools. Which agent answers is under Agents.
  { key: "network", icon: IconApiOutlineRegular, desktopOnly: true },
  { key: "connectors", icon: IconCordisPluginOutlineRegular, desktopOnly: true },
  { key: "browser", icon: IconGlobeOutlineRegular, desktopOnly: true },
  // Driving the apps on THIS machine: native permission state and a
  // helper window, neither of which the gateway can reach.
  { key: "computer", icon: IconBrowseOutlineRegular, desktopOnly: true },
  { key: "compute", icon: IconGaugeOutlineRegular, desktopOnly: true },
  { key: "remote", icon: IconLinkOutlineRegular, desktopOnly: true },
  { key: "privacy", icon: IconShieldOutlineRegular },
] as const satisfies ReadonlyArray<{ key: string; icon: ComponentType<IconProps>; desktopOnly?: boolean }>;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["key"];

/** Sections to show: all on desktop; drop `desktopOnly` ones in the web client. */
export function visibleSections(isWeb: boolean) {
  return isWeb ? SETTINGS_SECTIONS.filter((s) => !("desktopOnly" in s && s.desktopOnly)) : SETTINGS_SECTIONS;
}

/** True for a section the web client hides. Hiding it from the NAVIGATION is not
 *  enough: `/settings/<key>` still resolves, so a typed or shared link would
 *  render a surface whose writes the gateway refuses outright (#119). The page
 *  has to check this too. */
export function isDesktopOnlySection(key: SettingsSection): boolean {
  return SETTINGS_SECTIONS.some((s) => s.key === key && "desktopOnly" in s && s.desktopOnly);
}

/** Sections that were renamed, so old links and bookmarks still land. */
const RENAMED: Record<string, SettingsSection> = { models: "agents", runtime: "network" };

export function resolveSection(raw: string | undefined): SettingsSection {
  if (raw && RENAMED[raw]) return RENAMED[raw];
  return (SETTINGS_SECTIONS.find((s) => s.key === raw)?.key ?? "general") as SettingsSection;
}
