import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isTauri } from "@/lib/tauri";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
} from "@/components/ui/ContextMenu";
import { getTerminal, markTerminalUsed, putTerminal } from "@/lib/terminalSessions";
import { TerminalSearch } from "./TerminalSearch";

/**
 * A real shell in a pane.
 *
 * xterm.js renders it; the PTY lives in Rust (`src-tauri/src/terminal.rs`).
 *
 * The terminal itself is NOT owned by this component — it lives in
 * `lib/terminalSessions`, keyed by the pane's leaf id, and this component only
 * re-parents it into place. Splitting a pane moves its leaf DEEPER in the tree
 * (the leaf becomes a child of a new split node), and React unmounts anything
 * that changes position, keys or not; a terminal whose lifetime followed its
 * component lost the user's shell every time they split the pane beside it.
 *
 * xterm and its CSS load on demand: a session that never opens a terminal
 * should not pay for one, the same rule the code editor follows.
 */
export function TerminalPane({
  leafId,
  cwd,
  command,
  onSplit,
  onRename,
  onClose,
}: {
  leafId: string;
  cwd?: string;
  /** Typed into the shell once, when this terminal is first opened. */
  command?: string;
  /** Right-click → Split. `kind` is what the NEW pane holds: another terminal,
   *  or a conversation about what this one just printed. */
  onSplit?: (dir: "row" | "col", kind: "terminal" | "session") => void;
  /** Right-click → Rename. The header owns the editor; this only opens it. */
  onRename?: () => void;
  onClose?: () => void;
}) {
  const { t } = useTranslation("session");
  const host = useRef<HTMLDivElement | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!isTauri || !host.current) return;
    const parent = host.current;
    let disposed = false;

    // Already running: adopt it. Everything — scrollback, the running program,
    // what the user had half-typed — is still there.
    const existing = getTerminal(leafId);
    if (existing) {
      parent.appendChild(existing.container);
      existing.fit.fit();
      existing.term.focus();
      return () => {
        // Park it, do not destroy it. Destruction belongs to the layout, which
        // alone knows the difference between "moved" and "closed".
        existing.container.remove();
      };
    }

    void (async () => {
      const [{ Terminal }, { FitAddon }, { SearchAddon }, { invoke }, { listen }] =
        await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
          import("@xterm/addon-search"),
          import("@tauri-apps/api/core"),
          import("@tauri-apps/api/event"),
          import("@xterm/xterm/css/xterm.css"),
        ]);
      if (disposed) return;

      const container = document.createElement("div");
      container.className = "h-full w-full";
      parent.appendChild(container);

      const term = new Terminal({
        ...TERMINAL_OPTIONS,
        // Follows the app's palette rather than xterm's own black, so a
        // terminal in a light workspace is not a hole in the page.
        theme: readTheme(),
      });
      const fit = new FitAddon();
      const search = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(search);
      // ⌘F / Ctrl+F belongs to the app, not to the shell: xterm would otherwise
      // pass it through and some full-screen program would act on it.
      term.attachCustomKeyEventHandler((event) => {
        if (event.type === "keydown" && (event.metaKey || event.ctrlKey) && event.key === "f") {
          setSearching(true);
          return false;
        }
        return true;
      });
      term.open(container);
      fit.fit();

      await invoke("terminal_open", { id: leafId, cwd, cols: term.cols, rows: term.rows });
      const [dataEvent, exitEvent] = await invoke<[string, string]>("terminal_event_names", {
        id: leafId,
      });
      const unlistenData = await listen<string>(dataEvent, (event) => term.write(event.payload));
      const unlistenExit = await listen(exitEvent, () =>
        term.write(`\r\n${t("terminal.exited")}\r\n`),
      );
      const input = term.onData((data) => {
        // The first keystroke is what makes this terminal worth asking about
        // before it is closed.
        markTerminalUsed(leafId);
        void invoke("terminal_write", { id: leafId, data });
      });

      // The pane is resizable and tiled; the shell has to be told, or every
      // full-screen program keeps drawing into the old box.
      //
      // Coalesced to one frame, and the shell is told only when the GRID
      // changed. Collapsing the sidebar animates a width for 200ms, which fires
      // this a dozen times per terminal; each call re-measures the DOM
      // synchronously and used to cross into Rust for a PTY ioctl, so a window
      // with a few terminals in it visibly stuttered for the whole animation.
      let queued = 0;
      let sent = { cols: term.cols, rows: term.rows };
      const observer = new ResizeObserver(() => {
        if (queued) return;
        queued = requestAnimationFrame(() => {
          queued = 0;
          // Parked, or on a Screen that is not on display: a zero box would
          // have xterm propose a nonsense grid.
          if (!container.isConnected || !container.clientWidth || !container.clientHeight) return;
          fit.fit();
          if (term.cols === sent.cols && term.rows === sent.rows) return;
          sent = { cols: term.cols, rows: term.rows };
          void invoke("terminal_resize", { id: leafId, cols: term.cols, rows: term.rows });
        });
      });
      observer.observe(container);

      // Sent once, on the pane's FIRST open — never on a remount, which would
      // re-run it over whatever the user is doing in that shell.
      if (command) {
        markTerminalUsed(leafId);
        void invoke("terminal_write", { id: leafId, data: `${command}\n` });
      }

      putTerminal(leafId, {
        term,
        fit,
        search,
        container,
        dispose: () => {
          unlistenData();
          unlistenExit();
          input.dispose();
          observer.disconnect();
          if (queued) cancelAnimationFrame(queued);
        },
      });
      if (disposed) container.remove();
      else term.focus();
    })();

    return () => {
      disposed = true;
      getTerminal(leafId)?.container.remove();
    };
    // `command` belongs to the pane's first open; a change to it must not
    // rebuild a live terminal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leafId, cwd, t]);

  /** Right-click, modelled on Orca's terminal menu (`TerminalContextMenu.tsx`):
   *  the clipboard actions first, because that is what a right-click in a
   *  terminal is usually for, then the pane's own layout actions. Without it
   *  the packaged app shows the WebView's page menu, whose "Open Link in New
   *  Window" means nothing over a shell. */
  const menuItems = (
    <>
      <ContextMenuItem
        onSelect={() => {
          const selection = getTerminal(leafId)?.term.getSelection() ?? "";
          if (selection) void writeClipboard(selection);
        }}
      >
        {t("terminal.menu.copy")}
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => {
          void readClipboard().then((text) => {
            if (!text) return;
            markTerminalUsed(leafId);
            void invokeWrite(leafId, text);
          });
        }}
      >
        {t("terminal.menu.paste")}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => getTerminal(leafId)?.term.selectAll()}>
        {t("terminal.menu.selectAll")}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        onSelect={() => {
          const terminal = getTerminal(leafId);
          terminal?.term.clear();
          terminal?.term.focus();
        }}
      >
        {t("terminal.menu.clear")}
      </ContextMenuItem>
      {cwd && (
        <ContextMenuItem onSelect={() => void revealPath(cwd)}>
          {t("terminal.menu.revealCwd")}
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => setSearching(true)}>
        {t("terminal.search.find")}
      </ContextMenuItem>
      {onRename && (
        <ContextMenuItem onSelect={onRename}>{t("terminal.rename")}</ContextMenuItem>
      )}
      {(onSplit || onClose) && <ContextMenuSeparator />}
      {/* Split asks WHAT the new pane holds. A terminal beside a terminal is one
          common answer; a conversation about what this one just printed is the
          other, and it was previously unreachable without leaving the pane. */}
      {onSplit && (
        <>
          <ContextMenuSub label={t("group.splitRightShort")}>
            {/* eslint-disable i18next/no-literal-string -- split axis and pane kind, not UI copy */}
            <ContextMenuItem onSelect={() => onSplit("row", "terminal")}>
              {t("terminal.title")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onSplit("row", "session")}>
              {t("splitInto.session")}
            </ContextMenuItem>
          </ContextMenuSub>
          <ContextMenuSub label={t("group.splitDownShort")}>
            <ContextMenuItem onSelect={() => onSplit("col", "terminal")}>
              {t("terminal.title")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onSplit("col", "session")}>
              {t("splitInto.session")}
            </ContextMenuItem>
            {/* eslint-enable i18next/no-literal-string */}
          </ContextMenuSub>
        </>
      )}
      {onClose && <ContextMenuItem onSelect={onClose}>{t("group.closePane")}</ContextMenuItem>}
    </>
  );

  if (!isTauri) {
    return <div className="p-4 text-[13px] text-muted">{t("terminal.desktopOnly")}</div>;
  }
  return (
    <ContextMenu items={menuItems} label={t("terminal.menu.label")}>
      {/* `relative`: the search bar floats over the terminal rather than
          pushing it, so the line being read does not move as you type. */}
      <div className="relative h-full w-full">
        <div ref={host} className="h-full w-full bg-surface p-2" />
        {searching && (
          <TerminalSearch
            addon={getTerminal(leafId)?.search ?? null}
            onClose={() => {
              setSearching(false);
              getTerminal(leafId)?.term.focus();
            }}
          />
        )}
      </div>
    </ContextMenu>
  );
}

/**
 * Terminal defaults, borrowed from Orca's `lib/pane-manager/pane-terminal-options.ts`
 * (MIT) — a set of settings it arrived at the hard way, each for a reason worth
 * keeping. The ones that change behaviour rather than looks:
 *
 * - `macOptionClickForcesSelection`: while a program has grabbed the mouse
 *   (vim, htop, less), a plain drag goes to that program and selects nothing.
 *   Option+drag forces a selection anyway. Without it a terminal running
 *   anything full-screen simply cannot be selected from, which is what
 *   "can't select" looks like.
 * - `macOptionIsMeta: false`: non-US layouts compose `@` and `€` with Option;
 *   treating it as Meta makes those keys unreachable.
 * - `minimumContrastRatio`: this app's default surface is light, and plenty of
 *   CLIs print dark blue on the assumption of a dark one. xterm lifts such
 *   colours until they are legible instead of letting them vanish.
 * - `fontFamily`: a Nerd Font chain, so a powerline prompt renders as a prompt
 *   and not as a row of tofu.
 */
const TERMINAL_OPTIONS = {
  allowProposedApi: true,
  cursorBlink: true,
  cursorStyle: "block",
  // xterm's default inactive outline turns a bar cursor into extra strokes in
  // a blurred pane; only a block cursor gains from the outline.
  cursorInactiveStyle: "outline",
  fontSize: 12.5,
  fontFamily:
    "'JetBrains Mono', 'SF Mono', 'Menlo', 'Monaco', 'Cascadia Mono', 'Consolas', " +
    "'DejaVu Sans Mono', 'Symbols Nerd Font Mono', 'MesloLGS Nerd Font', monospace",
  fontWeight: "300",
  fontWeightBold: "500",
  // Enough to scroll back through a build log without holding a session's
  // worth of output in memory for every open pane.
  scrollback: 5000,
  scrollSensitivity: 1.15,
  fastScrollSensitivity: 5,
  minimumContrastRatio: 4.5,
  macOptionIsMeta: false,
  macOptionClickForcesSelection: true,
  drawBoldTextInBrightColors: true,
} as const;

/** Clipboard and shell writes, kept out of the menu body so it reads as a list
 *  of actions rather than a list of dynamic imports. */
async function writeClipboard(text: string): Promise<void> {
  const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
  await writeText(text);
}

async function readClipboard(): Promise<string> {
  const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
  return (await readText()) ?? "";
}

async function invokeWrite(id: string, data: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("terminal_write", { id, data });
}

async function revealPath(path: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("reveal_path", { path, root: null });
}

/** xterm paints its own canvas, so it cannot inherit CSS variables — the
 *  current values are read once and handed over. */
function readTheme() {
  const style = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    background: value("--surface", "#ffffff"),
    foreground: value("--text", "#2a2723"),
    cursor: value("--accent", "#c15f3c"),
    selectionBackground: value("--surface-2", "#f2efe7"),
  };
}
