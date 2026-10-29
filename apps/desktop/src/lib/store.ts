import { create } from "zustand";
import { detectInitialLocale, LOCALE_KEY } from "@/i18n/config";
import { isMacUA, isTauri, trafficLightsPresent } from "./tauri";

export type Theme = "light" | "warm" | "dark" | "system";
/** The palette actually on screen: "system" resolves to light or dark. */
export type ResolvedTheme = Exclude<Theme, "system">;

export const THEMES: readonly Theme[] = ["light", "warm", "dark", "system"];

/** Other looks for the warm and dark themes (index.css, `data-variant`). The
 *  first of each is the default. */
export const THEME_VARIANTS = {
  warm: ["soft", "paper", "sepia"],
  dark: ["dimmed", "graphite", "slate"],
} as const;
export type VariantTheme = keyof typeof THEME_VARIANTS;
export type ThemeVariant = (typeof THEME_VARIANTS)[VariantTheme][number];
const VARIANT_KEY = (theme: VariantTheme) => `ai4s.theme.${theme}.variant`;

function initialVariants(): Record<VariantTheme, ThemeVariant> {
  const pick = (theme: VariantTheme): ThemeVariant => {
    const saved = typeof window === "undefined" ? null : window.localStorage.getItem(VARIANT_KEY(theme));
    const known: readonly string[] = THEME_VARIANTS[theme];
    return saved && known.includes(saved) ? (saved as ThemeVariant) : THEME_VARIANTS[theme][0];
  };
  return { warm: pick("warm"), dark: pick("dark") };
}

const THEME_KEY = "ai4s.theme.v2";
/** Two-theme era key: its "light" was the warm paper palette, now called "warm". */
const LEGACY_THEME_KEY = "ai4s.theme";
const SIDEBAR_WIDTH_KEY = "ai4s.sidebar.width";
const SIDEBAR_COLLAPSED_KEY = "ai4s.sidebar.collapsed";
const INSPECTOR_WIDTH_KEY = "ai4s.inspector.width";
const ZOOM_KEY = "ai4s.zoom";

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 0.1;

export const SIDEBAR_MIN = 184;
export const SIDEBAR_MAX = 340;
export const SIDEBAR_DEFAULT = 232;

export const INSPECTOR_MIN = 360;
export const INSPECTOR_MAX = 960;
export const INSPECTOR_DEFAULT = 560;

function initialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const saved = window.localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "warm" || saved === "dark" || saved === "system") return saved;
  const legacy = window.localStorage.getItem(LEGACY_THEME_KEY);
  if (legacy === "dark") return "dark";
  if (legacy === "light") return "warm";
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
}

function initialSidebarWidth(): number {
  if (typeof window === "undefined") return SIDEBAR_DEFAULT;
  const saved = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
  if (!Number.isFinite(saved) || saved === 0) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, saved));
}

function initialInspectorWidth(): number {
  if (typeof window === "undefined") return INSPECTOR_DEFAULT;
  const saved = Number(window.localStorage.getItem(INSPECTOR_WIDTH_KEY));
  if (!Number.isFinite(saved) || saved === 0) return INSPECTOR_DEFAULT;
  return Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, saved));
}

function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
}

function initialZoom(): number {
  if (typeof window === "undefined") return 1;
  const saved = Number(window.localStorage.getItem(ZOOM_KEY));
  if (!Number.isFinite(saved) || saved <= 0) return 1;
  return clampZoom(saved);
}

/** Conversation text size in px (DeepSeek Harness's "Font size": only the
 *  conversation content scales). 15 is the conversation's own body size. */
export const CONTENT_FONT_DEFAULT = 15;
export const CONTENT_FONT_MIN = 12;
export const CONTENT_FONT_MAX = 20;
const CONTENT_FONT_KEY = "ai4s.contentFontSize";

function initialContentFontSize(): number {
  if (typeof window === "undefined") return CONTENT_FONT_DEFAULT;
  const saved = Number(window.localStorage.getItem(CONTENT_FONT_KEY));
  if (!Number.isInteger(saved) || saved < CONTENT_FONT_MIN || saved > CONTENT_FONT_MAX) return CONTENT_FONT_DEFAULT;
  return saved;
}

interface UiState {
  /** The chosen theme — may be "system". */
  theme: Theme;
  /** What is on screen; ThemeProvider keeps it in step with the OS for "system". */
  resolvedTheme: ResolvedTheme;
  /** The variant on screen (null for light), set with `resolvedTheme` once the
   *  page carries it, so readers of the CSS colours see the new ones. */
  resolvedVariant: ThemeVariant | null;
  /** The chosen look of the warm and the dark theme. */
  themeVariants: Record<VariantTheme, ThemeVariant>;
  /** Conversation text size in px; see CONTENT_FONT_DEFAULT. */
  contentFontSize: number;
  /** Active UI locale (BCP-47). Persisted; mirrors the `theme` pattern. */
  locale: string;
  inspectorOpen: boolean;
  /** Right-pane width in px (persisted). */
  inspectorWidth: number;
  /** The pane whose panel is maximized to cover the whole window, by pane id
   *  (session-ephemeral, reset when that panel closes). One at a time: with
   *  several tiled panes each showing a panel, only the clicked one covers. */
  inspectorMaximized: string | null;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  /** macOS native fullscreen: the traffic lights slide away, so headers must
   *  drop their traffic-light inset. Synced from the Tauri window in AppShell. */
  isFullscreen: boolean;
  paletteOpen: boolean;
  /** Webview page-zoom factor (Cmd/Ctrl +/-). Persisted and owned in-app
   *  rather than by Tauri's zoomHotkeysEnabled, so the macOS titlebar strips
   *  can counter-scale for the fixed native traffic lights (see ZoomProvider). */
  zoom: number;
  /** One-shot text placed into the composer by another surface (e.g. the
   *  provenance Reproduce action) — consumed on the next composer render. */
  composerDraft: string | null;
  setTheme: (theme: Theme) => void;
  setResolvedTheme: (theme: ResolvedTheme, variant: ThemeVariant | null) => void;
  setThemeVariant: (theme: VariantTheme, variant: ThemeVariant) => void;
  setContentFontSize: (px: number) => void;
  toggleTheme: () => void;
  setLocale: (locale: string) => void;
  setInspectorOpen: (open: boolean) => void;
  setInspectorWidth: (width: number) => void;
  setInspectorMaximized: (paneId: string | null) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  setIsFullscreen: (fullscreen: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setZoom: (zoom: number) => void;
  zoomBy: (steps: number) => void;
  resetZoom: () => void;
  setComposerDraft: (draft: string | null) => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  theme: initialTheme(),
  resolvedTheme: "light",
  resolvedVariant: null,
  themeVariants: initialVariants(),
  contentFontSize: initialContentFontSize(),
  locale: detectInitialLocale(),
  inspectorOpen: true,
  sidebarCollapsed:
    typeof window !== "undefined" && window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1",
  sidebarWidth: initialSidebarWidth(),
  isFullscreen: false,
  paletteOpen: false,
  zoom: initialZoom(),
  setTheme: (theme) => {
    if (typeof window !== "undefined") window.localStorage.setItem(THEME_KEY, theme);
    set({ theme });
  },
  setResolvedTheme: (resolvedTheme, resolvedVariant) => set({ resolvedTheme, resolvedVariant }),
  setThemeVariant: (theme, variant) => {
    if (!(THEME_VARIANTS[theme] as readonly string[]).includes(variant)) return;
    if (typeof window !== "undefined") window.localStorage.setItem(VARIANT_KEY(theme), variant);
    set((s) => ({ themeVariants: { ...s.themeVariants, [theme]: variant } }));
  },
  setContentFontSize: (px) => {
    const next = Math.min(CONTENT_FONT_MAX, Math.max(CONTENT_FONT_MIN, Math.round(px)));
    if (typeof window !== "undefined") window.localStorage.setItem(CONTENT_FONT_KEY, String(next));
    set({ contentFontSize: next });
  },
  // The toggle steps through the palettes themselves; "system" is a setting,
  // not a step (from it, the toggle starts at the first palette).
  toggleTheme: () => {
    const cycle = THEMES.filter((th): th is ResolvedTheme => th !== "system");
    const at = cycle.indexOf(get().theme as ResolvedTheme);
    get().setTheme(cycle[(at + 1) % cycle.length]);
  },
  setLocale: (locale) => {
    if (typeof window !== "undefined") window.localStorage.setItem(LOCALE_KEY, locale);
    set({ locale });
  },
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  inspectorWidth: initialInspectorWidth(),
  inspectorMaximized: null,
  setInspectorWidth: (width) => {
    const inspectorWidth = Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, Math.round(width)));
    if (typeof window !== "undefined")
      window.localStorage.setItem(INSPECTOR_WIDTH_KEY, String(inspectorWidth));
    set({ inspectorWidth });
  },
  setInspectorMaximized: (inspectorMaximized) => set({ inspectorMaximized }),
  setSidebarCollapsed: (sidebarCollapsed) => {
    if (typeof window !== "undefined")
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? "1" : "0");
    set({ sidebarCollapsed });
  },
  toggleSidebar: () => get().setSidebarCollapsed(!get().sidebarCollapsed),
  setIsFullscreen: (isFullscreen) => set({ isFullscreen }),
  setSidebarWidth: (width) => {
    const sidebarWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width)));
    if (typeof window !== "undefined")
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    set({ sidebarWidth });
  },
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setZoom: (z) => {
    const zoom = clampZoom(z);
    if (typeof window !== "undefined") window.localStorage.setItem(ZOOM_KEY, String(zoom));
    set({ zoom });
  },
  zoomBy: (steps) => get().setZoom(get().zoom + steps * ZOOM_STEP),
  resetZoom: () => get().setZoom(1),
  composerDraft: null,
  setComposerDraft: (composerDraft) => set({ composerDraft }),
}));

/** Whether headers should inset for the macOS overlay-titlebar traffic lights.
 *  False in a browser, on non-mac, and in fullscreen (the lights hide). The one
 *  source of truth for every titlebar/header that clears the lights. */
export function useOverlayTitlebar(): boolean {
  const isFullscreen = useUiStore((s) => s.isFullscreen);
  return trafficLightsPresent(isTauri, isMacUA(), isFullscreen);
}
