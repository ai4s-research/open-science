/**
 * Web client: keep the app inside the part of the page a phone actually shows.
 *
 * `100vh` on a phone is the height with the address bar HIDDEN, so a shell
 * that tall overran the screen: its top scrolled under the address bar and its
 * bottom (the composer) fell below the screen. The on-screen keyboard is worse:
 * it covers the page without resizing it, hiding whatever input is at the bottom.
 *
 * The visual viewport is exactly what is visible, keyboard excluded. Its height
 * and offset go to `--vv-height` / `--vv-top`, which `.app-viewport` (the shell)
 * is pinned to, so the whole app moves up with the keyboard instead of being
 * covered by it.
 */
export function installVisibleViewport(): void {
  const vv = typeof window === "undefined" ? undefined : window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  const update = () => {
    root.style.setProperty("--vv-height", `${vv.height}px`);
    root.style.setProperty("--vv-top", `${vv.offsetTop}px`);
  };
  update();
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
}
