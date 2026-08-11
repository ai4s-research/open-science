import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation } from "react-router-dom";
import { PanelLeft } from "lucide-react";
import { cn } from "@/lib/cn";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { CommandPalette } from "@/components/command-palette/CommandPalette";
import { PaneDragGhost } from "@/components/session/PaneDragGhost";
import { Toaster } from "@/components/ui/Toaster";
import { SshSignInDialog } from "@/components/ui/SshSignInDialog";
import { mockProject } from "@/lib/mock";
import { useRuntimeStore } from "@/lib/runtime";
import { ensureSetupProgressListener } from "@/lib/setup";
import { useOverlayTitlebar, useUiStore } from "@/lib/store";
import { overlayTitlebarStyle } from "@/lib/titlebar";
import { ensureJupyter, openExternal, watchFullscreen } from "@/lib/tauri";
import { useSshStore } from "@/lib/ssh";
import { useUpdateStore } from "@/lib/update";
import { isGatewayWeb, gatewayToken, setUnauthorizedHandler } from "@/lib/webMode";
import { WebTokenGate } from "@/components/web/WebTokenGate";
import { useIsMobile } from "@/lib/useIsMobile";
import { leaves, useLayoutStore, type SplitDir } from "@/lib/layout";
import { useNativeContextMenuGuard } from "@/lib/nativeMenu";

export function AppShell() {
  const { t } = useTranslation("nav");
  const { sidebarCollapsed, setSidebarCollapsed } = useUiStore();
  const isMobile = useIsMobile();
  // Gateway web client: hold the app behind a token gate until authenticated.
  const [webReady, setWebReady] = useState(!isGatewayWeb || !!gatewayToken());

  // Cmd/Ctrl+B toggles the sidebar, matching the button's tooltip. Not in
  // settings: there the sidebar IS the settings navigation (with the only way
  // back to the app), so it must not collapse.
  const inSettings = useLocation().pathname.startsWith("/settings");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (!window.location.pathname.startsWith("/settings"))
          useUiStore.getState().toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A right-click on app chrome must not open the WebView's page menu.
  useNativeContextMenuGuard();

  // Ghostty-style split-pane shortcuts, live only on the /live surface. Disabled
  // where tiling can't work (phone width, web gateway) and in Settings. New
  // panes start as a DRAFT — no session/folder until the pane's first send (#2).
  const splitDisabled = isMobile || isGatewayWeb;
  useEffect(() => {
    if (splitDisabled) return;
    const doSplit = (dir: SplitDir) => {
      const layout = useLayoutStore.getState();
      // Empty group → the new draft fills it; otherwise split the focused pane.
      if (!layout.tree) layout.dockSession("", dir === "row" ? "right" : "bottom", null);
      else layout.split(dir, null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (!window.location.pathname.startsWith("/live")) return;
      const layout = useLayoutStore.getState();
      const key = e.key.toLowerCase();
      if (key === "d") {
        // Cmd+D splits side-by-side; Cmd+Shift+D stacks.
        e.preventDefault();
        void doSplit(e.shiftKey ? "col" : "row");
      } else if (key === "t") {
        // Cmd+T opens a new (empty) group.
        e.preventDefault();
        layout.addGroup();
      } else if (e.shiftKey && (key === "]" || key === "[")) {
        // Cmd+Shift+] / [ cycles groups.
        e.preventDefault();
        const i = layout.groups.findIndex((g) => g.id === layout.activeGroupId);
        const n = layout.groups.length;
        const j = key === "]" ? (i + 1) % n : (i - 1 + n) % n;
        layout.setActiveGroup(layout.groups[j].id);
      } else if (e.shiftKey && key === "enter") {
        e.preventDefault();
        layout.toggleZoom();
      } else if (key === "w") {
        // Close the focused pane — but only while tiled; a lone pane lets
        // Cmd+W fall through to its usual window-close.
        if (layout.tree && leaves(layout.tree).length > 1) {
          e.preventDefault();
          layout.closeFocused();
        }
      } else if (e.altKey && (key === "arrowleft" || key === "arrowup")) {
        e.preventDefault();
        layout.focusAdjacent("prev");
      } else if (e.altKey && (key === "arrowright" || key === "arrowdown")) {
        e.preventDefault();
        layout.focusAdjacent("next");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [splitDisabled]);
  // In the packaged desktop app, auto-start the bundled OpenCode and connect,
  // and bring the Jupyter server back up if the user enabled it before.
  useEffect(() => {
    if (isGatewayWeb && !webReady) return; // wait for the token gate
    void useRuntimeStore.getState().bootstrap();
    void ensureJupyter();
    // One app-lifetime listener for uv provisioning progress, so a running
    // download's live output survives navigating between pages.
    ensureSetupProgressListener();
    void useSshStore.getState().init();
    if (!import.meta.env.TEST) {
      void useUpdateStore.getState().maybeAutoCheck();
    }
  }, [webReady]);

  // Web client: if the gateway rejects the token (rotated/revoked), drop back
  // to the token gate instead of looping on a failed connection.
  useEffect(() => {
    if (!isGatewayWeb) return;
    setUnauthorizedHandler(() => setWebReady(false));
    return () => setUnauthorizedHandler(null);
  }, []);

  // Mobile: the sidebar is an overlay drawer — keep it closed by default and
  // close it after navigating (tapping a session or nav item). Keyed on
  // location.key, not pathname: tapping "New" while already on /live pushes
  // the same path, and the drawer must still close.
  const locationKey = useLocation().key;
  useEffect(() => {
    if (isMobile) setSidebarCollapsed(true);
  }, [isMobile, locationKey, setSidebarCollapsed]);

  // Track native fullscreen: macOS hides the traffic lights there, so headers
  // must drop their traffic-light inset (see useOverlayTitlebar).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void watchFullscreen((fs) => useUiStore.getState().setIsFullscreen(fs)).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // External links open in the system browser. Navigating the webview away
  // from the app would strand the user — there is no back button.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest?.("a[href]");
      const href = anchor?.getAttribute("href") ?? "";
      if (/^https?:\/\//i.test(href)) {
        e.preventDefault();
        void openExternal(href);
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  // The session pages' own header doubles as the titlebar when the sidebar is
  // collapsed; every other route gets this fallback strip so the macOS traffic
  // lights don't overlap content, the window stays draggable, and the sidebar
  // can be re-expanded. Live and example sessions share the same one-row header
  // — without this the example page would stack this strip on top of its own
  // header and read as a double-height bar.
  const isMac = navigator.userAgent.includes("Mac");
  const overlayTitlebar = useOverlayTitlebar();
  const pathname = useLocation().pathname;
  const pageOwnsTitlebar = pathname.startsWith("/live") || pathname.startsWith("/example");

  if (isGatewayWeb && !webReady) {
    return <WebTokenGate onConnect={() => setWebReady(true)} />;
  }

  return (
    // The window background lives on <main>, not the shell: under vibrancy
    // the area behind the (translucent) sidebar must stay transparent.
    <div className="flex h-screen w-screen overflow-hidden text-text">
      <Sidebar project={mockProject} />
      {/* Mobile: dim + close the overlay drawer by tapping outside it. */}
      {isMobile && !sidebarCollapsed && (
        <div
          className="fixed inset-0 z-30 bg-black/40"
          onClick={() => setSidebarCollapsed(true)}
          aria-hidden
        />
      )}
      <main className="flex min-w-0 flex-1 flex-col bg-bg">
        {/* Mobile top bar: a hamburger to open the drawer. Skipped on pages that
            own their header (live/example sessions already render a toggle) so
            the two don't stack. */}
        {isMobile && !pageOwnsTitlebar && (
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2">
            <button
              onClick={() => setSidebarCollapsed(false)}
              aria-label={t("sidebar.expand")}
              className="rounded p-2 text-text hover:bg-surface-2"
            >
              <PanelLeft size={18} strokeWidth={1.5} />
            </button>
          </div>
        )}
        {/* Titlebar strip for pages that don't own one: keeps the whole top
            of the content area draggable under the macOS overlay titlebar,
            and hosts the expand button while the sidebar is collapsed. */}
        {!isMobile && !pageOwnsTitlebar && (overlayTitlebar || (sidebarCollapsed && !inSettings)) && (
          <div
            data-tauri-drag-region={overlayTitlebar || undefined}
            style={
              overlayTitlebar
                ? overlayTitlebarStyle(sidebarCollapsed && !inSettings)
                : undefined
            }
            className={cn("flex shrink-0 items-center", !overlayTitlebar && "h-12 pl-2")}
          >
            {sidebarCollapsed && !inSettings && (
              <button
                onClick={() => setSidebarCollapsed(false)}
                aria-label={t("sidebar.expand")}
                title={t("sidebar.expandTitle", { shortcut: isMac ? "⌘B" : "Ctrl+B" })}
                className="fade-in rounded p-1 text-text hover:bg-surface-2"
              >
                <PanelLeft size={14} strokeWidth={1.5} />
              </button>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </main>
      <CommandPalette />
      <Toaster />
      {/* Sign-in for an interactively authenticated compute host (#73): app-wide,
          because the prompt has to reach the user wherever the need arose — the
          Settings card or the conversation the agent is working in. */}
      <SshSignInDialog />
      <PaneDragGhost />
    </div>
  );
}
