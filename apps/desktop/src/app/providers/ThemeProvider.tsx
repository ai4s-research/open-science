import { useEffect, type ReactNode } from "react";
import { useUiStore, type ResolvedTheme } from "@/lib/store";
import { isMacUA, isTauri, setWindowTheme } from "@/lib/tauri";

/** Applies the current theme to the document root. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useUiStore((s) => s.theme);
  const variants = useUiStore((s) => s.themeVariants);
  const setResolvedTheme = useUiStore((s) => s.setResolvedTheme);
  useEffect(() => {
    // "system" follows the OS light/dark setting, live.
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved: ResolvedTheme = theme === "system" ? (media?.matches ? "dark" : "light") : theme;
      const root = document.documentElement;
      // The variant first: watchers of data-theme then read finished colours.
      const variant = resolved === "light" ? null : variants[resolved];
      if (variant) root.dataset.variant = variant;
      else delete root.dataset.variant;
      root.dataset.theme = resolved;
      setResolvedTheme(resolved, variant);
      void setWindowTheme(resolved === "dark");
    };
    apply();
    if (theme !== "system" || !media) return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme, variants, setResolvedTheme]);
  // The macOS desktop window has a vibrancy material behind the webview
  // (tauri.macos.conf.json); flag the root so CSS can let the sidebar show it.
  useEffect(() => {
    if (isTauri && isMacUA()) document.documentElement.dataset.vibrancy = "1";
  }, []);
  return <>{children}</>;
}
