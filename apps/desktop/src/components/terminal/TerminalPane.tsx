import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isMacUA, isTauri, logDebug } from "@/lib/tauri";
import { isGatewayWeb } from "@/lib/webMode";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { useRuntimeStore } from "@/lib/runtime";
import {
  terminalShellId,
  terminalTransport,
  terminalsAvailable,
  type TerminalControl,
} from "@/lib/terminalTransport";
import { copyReference, terminalReference } from "@/lib/agentReference";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
} from "@/components/ui/ContextMenu";
import {
  getTerminal,
  markTerminalUsed,
  putTerminal,
  rebuildTerminal,
  setTerminalFollowing,
  takeOverAll,
  useTerminalBuild,
  useTerminalFollowing,
} from "@/lib/terminalSessions";
import {
  findLeaf,
  resumeCommand,
  terminalAgentName,
  terminalStartup,
  useLayoutStore,
  type TerminalAgent,
} from "@/lib/layout";
import { registerTerminalLinks } from "./terminalLinks";
import { TerminalSearch } from "./TerminalSearch";
import { isJumpChord } from "@/components/jump-palette/JumpPalette";
import { createImeGate, createKeyTranslator, createPunctuationPassThrough } from "./terminalKeys";
import { REPAINT_START, readRepaint, spliceRepaint, type Repaint } from "./terminalResize";
import { openEscape } from "./terminalScreen";
import { readCopiedFiles } from "./terminalPaste";

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
  name,
  command,
  agent,
  onSplit,
  onRename,
  onClose,
}: {
  leafId: string;
  cwd?: string;
  /** The name the user gave this terminal, if any — for its reference. */
  name?: string;
  /** Typed into the shell once, when this terminal is first opened. */
  command?: string;
  /** The coding agent last seen in this terminal. Still running when the app
   *  last looked → its session is resumed on first open, INSTEAD of `command`
   *  (a relaunch picks the conversation back up rather than starting over).
   *  Exited → offered from the menu. */
  agent?: TerminalAgent;
  /** Right-click → Split. `kind` is what the NEW pane holds: another terminal,
   *  or a conversation about what this one just printed. */
  onSplit?: (dir: "row" | "col", kind: "terminal" | "session") => void;
  /** Right-click → Rename. The header owns the editor; this only opens it. */
  onRename?: () => void;
  onClose?: () => void;
}) {
  const { t } = useTranslation("session");
  const host = useRef<HTMLDivElement | null>(null);
  const available = terminalsAvailable(useRuntimeStore((s) => s.webTerminal));
  const [searching, setSearching] = useState(false);
  const followingKind = useTerminalFollowing((s) => s[leafId]);
  // Bumped when the terminal is thrown away to be built again.
  const build = useTerminalBuild((s) => s[leafId] ?? 0);
  const searchingRef = useRef(searching);
  searchingRef.current = searching;
  // The xterm key handler is bound once, when the terminal is created, but the
  // terminal outlives this component (it is re-parented on every split or
  // maximize). It reaches the search bar through this entry, which whichever
  // component currently shows the terminal keeps pointed at itself.
  useEffect(() => {
    const controls: FindControls = {
      open: () => setSearching(true),
      close: () => {
        setSearching(false);
        getTerminal(leafId)?.term.focus();
      },
      isOpen: () => searchingRef.current,
    };
    findControls.set(leafId, controls);
    return () => {
      if (findControls.get(leafId) === controls) findControls.delete(leafId);
    };
  }, [leafId]);

  useEffect(() => {
    if (!available || !host.current) return;
    const parent = host.current;
    let disposed = false;

    // Already running: adopt it. Everything — scrollback, the running program,
    // what the user had half-typed — is still there.
    const existing = getTerminal(leafId);
    if (existing) {
      // Its new box reaches the shell through the resize observer.
      parent.appendChild(existing.container);
      existing.term.focus();
      return () => {
        // Park it, do not destroy it. Destruction belongs to the layout, which
        // alone knows the difference between "moved" and "closed".
        existing.container.remove();
      };
    }

    void (async () => {
      const [
        { Terminal },
        { FitAddon },
        { SearchAddon },
        { SerializeAddon },
        { Unicode11Addon },
        { WebglAddon },
      ] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-search"),
        import("@xterm/addon-serialize"),
        import("@xterm/addon-unicode11"),
        import("@xterm/addon-webgl"),
        import("@xterm/xterm/css/xterm.css"),
        loadTerminalFont(),
      ]);
      if (disposed) return;

      const container = document.createElement("div");
      // Clips the old grid while a resize waits to be applied. Clip, not
      // hidden: a hidden box still scrolls, and the browser scrolls it to keep
      // an input method's composition in view, shifting the whole grid left
      // under the text being typed at the right edge.
      container.className = "h-full w-full overflow-clip";
      parent.appendChild(container);

      const term = new Terminal({
        ...TERMINAL_OPTIONS,
        // Follows the app's palette rather than xterm's own black, so a
        // terminal in a light workspace is not a hole in the page.
        theme: readTheme(),
      });
      const fit = new FitAddon();
      const search = new SearchAddon();
      const serialize = new SerializeAddon();
      term.loadAddon(fit);
      term.loadAddon(search);
      term.loadAddon(serialize);
      // xterm's default width table is Unicode 6, where emoji and many symbols
      // are one cell; Claude Code and Codex lay out with current Unicode, where
      // they are two. Every such glyph would shift the rest of its line by one.
      // Set before the first write: widths are fixed as text enters the buffer.
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = "11";
      const translateKey = createKeyTranslator(isMacUA());
      const imeGate = createImeGate(term);
      const punctuation = createPunctuationPassThrough(term);
      // Set by ⌘V, cleared by the paste event it should raise (see onPaste).
      let pasteWait: ReturnType<typeof setTimeout> | undefined;
      term.attachCustomKeyEventHandler((event) => {
        // Keys a native terminal sends differently (Shift+Enter, Option as
        // Meta, ⌘←/→/⌫) — see terminalKeys.
        const translated = translateKey(event);
        imeGate(event);
        if (translated === false) return false;
        // Left to the browser, so an input method can type "。" (see terminalKeys).
        if (translated === null && punctuation.key(event)) return false;
        if (translated !== null) {
          event.preventDefault();
          term.input(translated);
          return false;
        }
        // Find belongs to the app, not to the shell: xterm would otherwise pass
        // it through and some full-screen program would act on it. ⌘F on a
        // Mac, where Ctrl+F is the line editor's "forward one character";
        // Ctrl+F elsewhere.
        if (
          event.type === "keydown" &&
          (isMacUA() ? event.metaKey : event.ctrlKey) &&
          event.key.toLowerCase() === "f"
        ) {
          event.preventDefault();
          findControls.get(leafId)?.open();
          return false;
        }
        // Escape with the bar open closes the bar, even with the caret back in
        // the terminal. Marked handled, or macOS takes an unclaimed Escape as
        // "leave full screen".
        if (
          event.type === "keydown" &&
          event.key === "Escape" &&
          findControls.get(leafId)?.isOpen()
        ) {
          event.preventDefault();
          findControls.get(leafId)?.close();
          return false;
        }
        // The jump palette's chord is the app's too: left to xterm, Ctrl+Shift+J
        // would reach the shell as a line feed.
        if (isJumpChord(event)) return false;
        // With only files on the clipboard the window may raise no paste
        // event for ⌘V at all; if none follows, paste the files' paths here.
        if (isTauri && isMacUA() && event.type === "keydown" && event.metaKey && event.key.toLowerCase() === "v") {
          clearTimeout(pasteWait);
          pasteWait = setTimeout(() => {
            void readCopiedFiles().then((paths) => {
              if (paths) term.paste(paths);
            });
          }, 150);
        }
        return true;
      });
      term.open(container);
      // Files copied in Finder or Explorer reach the paste event with no
      // usable text, so xterm pasted nothing: paste their paths instead.
      // Caught before xterm's own listener; text pastes are left to it.
      // One by one, so a file that fails (too large) does not lose the others.
      const pasteFiles = async (id: string, files: File[]) => {
        let paths = "";
        for (const file of files) {
          try {
            paths += (await terminalTransport.pasteFile?.(id, file)) ?? "";
          } catch (err) {
            toast.error(t("composer.error.paste", { message: err instanceof Error ? err.message : String(err) }));
          }
        }
        return paths;
      };
      const onPaste = (event: ClipboardEvent) => {
        clearTimeout(pasteWait);
        const data = event.clipboardData;
        const text = data?.getData("text/plain") ?? "";
        // In a browser the shell runs on the host, so an empty paste would make
        // Claude Code read the HOST's clipboard (for a file copied in Finder,
        // its icon). Files pasted here go to the host; their paths are typed.
        const files = Array.from(data?.files ?? []);
        if (isGatewayWeb && files.length > 0 && terminalTransport.pasteFile) {
          event.preventDefault();
          event.stopPropagation();
          void pasteFiles(leafId, files).then((paths) => paths && term.paste(paths));
          return;
        }
        if (!isTauri || !data || (text && !data.files.length && !data.types.includes("Files"))) return;
        event.preventDefault();
        event.stopPropagation();
        // Always paste, even "": an empty bracketed paste is how Claude Code
        // and Codex learn to read a copied image from the clipboard.
        void readCopiedFiles().then((paths) => term.paste(paths || text));
      };
      container.addEventListener("paste", onPaste, true);
      // Capture on the container runs before xterm's own listener on its textarea.
      const onInput = (event: Event) => punctuation.input(event as InputEvent);
      container.addEventListener("input", onInput, true);
      // GPU renderer, as in VS Code and Orca: box-drawing and block characters
      // are drawn as exact cell-sized shapes instead of font glyphs, so rules
      // and borders join up as in a native terminal. Without WebGL, or once
      // the GPU drops the context, xterm falls back to its DOM renderer.
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // No WebGL here; the DOM renderer is already in place.
      }
      fit.fit();
      // Where the shell is NOW (the layout follows it, see `recordTerminal`),
      // so a relative path printed after a `cd` resolves where it should.
      const links = registerTerminalLinks(term, () => {
        for (const g of useLayoutStore.getState().groups) {
          const content = g.tree && findLeaf(g.tree, leafId)?.content;
          if (content?.kind === "terminal") return content.cwd ?? null;
        }
        return cwd ?? null;
      });

      const opened = await terminalTransport.open(leafId, cwd, term.cols, term.rows);
      const created = opened.created;
      // A running shell's recent output was drawn at the shell's size: the
      // pane starts there, and the resize below takes it to its own.
      if (!created && opened.cols && opened.rows) term.resize(opened.cols, opened.rows);
      // Drawn in place of the output it covers (see terminal.rs), if the
      // output after it is still there to follow on with.
      let screen = created ? null : (opened.screen ?? null);
      let first = true;

      // How far into the shell's output the pane has got (desktop): `received`
      // up to the last chunk in, `written` up to the last one xterm has drawn.
      // The pane's screen is saved at a moment the two agree.
      let received: number | undefined;
      let written: number | undefined;
      // The escape sequence the output so far ends inside, if any.
      let cutOff = "";
      let saveTimer: ReturnType<typeof setTimeout> | undefined;
      // Every write of output goes through `draw`, so a write xterm never
      // finishes is seen. One exception inside xterm's parser leaves its write
      // queue stopped for good: the pane shows nothing more while typing still
      // reaches the shell. Such a pane is built again from the shell's output,
      // as a relaunch does (see `rebuildTerminal`).
      let drawing = 0;
      let lastDrawn = 0;
      // xterm 6's resize flushes the write queue, and that flush stops at an
      // empty write and drops every write queued after it, callbacks too: an
      // empty one never goes in. The same flush can replay writes already
      // drawn, calling their callbacks twice: each counts once.
      const draw = (text: string, done?: () => void) => {
        if (!text) return void done?.();
        if (!drawing++) lastDrawn = Date.now();
        let counted = false;
        term.write(text, () => {
          if (counted) return;
          counted = true;
          drawing--;
          lastDrawn = Date.now();
          done?.();
        });
      };
      const stuckCheck = setInterval(() => {
        if (!drawing || Date.now() - lastDrawn < DRAW_STUCK_MS) return;
        clearInterval(stuckCheck);
        void logDebug(`[terminal ${leafId}] ${drawing} writes not drawn for ${DRAW_STUCK_MS}ms; building the pane again`);
        rebuildTerminal(leafId);
      }, DRAW_STUCK_MS / 5);
      const writeOut = (text: string) => {
        const upTo = received;
        draw(text, () => {
          written = upTo;
          scheduleSave(SAVE_SCREEN_MS);
        });
      };
      const scheduleSave = (delay: number) => {
        if (!terminalTransport.saveScreen || saveTimer || written === undefined) return;
        saveTimer = setTimeout(saveScreen, delay);
      };
      const saveScreen = () => {
        saveTimer = undefined;
        // Mid-resize, output not drawn yet, inside an escape sequence, or a
        // wrap pending at the end of a full row: a saved screen would not
        // carry on from that offset as the live one does.
        const buffer = term.buffer.active;
        if (reply || written === undefined || written !== received || cutOff || buffer.cursorX >= term.cols) {
          return scheduleSave(SAVE_RETRY_MS);
        }
        void terminalTransport
          .saveScreen?.(leafId, {
            end: written,
            cols: term.cols,
            rows: term.rows,
            data: serialize.serialize({ scrollback: TERMINAL_OPTIONS.scrollback }),
          })
          .catch(() => {});
      };

      // Who sizes the shell (see `TerminalControl`). While another view does,
      // this one follows its size, masked, and types nothing.
      let control: TerminalControl | null = null;
      const following = () => !!control?.by && control.by.id !== terminalTransport.viewer.id;
      // Set once the resize machinery below exists; a change can arrive first.
      let applyControl = () => {};
      let resizing = false;

      // Output that answers a resize the pane is still applying; see below.
      let reply: {
        cols: number;
        rows: number;
        data: string;
        timer: ReturnType<typeof setTimeout>;
        /** The repaint is being written; later output only queues. */
        writing: boolean;
        /** Claude Code repaints on its own, not for a resize. */
        own: boolean;
      } | null = null;
      const unsubscribe = await terminalTransport.subscribe(
        leafId,
        {
          onData: (chunk, at) => {
            if (first) {
              first = false;
              if (screen && at?.from === screen.end) draw(screen.data);
              screen = null;
            }
            if (at?.end !== undefined) received = at.end;
          cutOff = openEscape(cutOff + chunk);
            // Claude Code also repaints on its own, at the same size: when it
            // folds tool calls it already printed, say. Written as it is, that
            // lands below the copy already here like a resize's; spliced the same.
            if (!reply && resizing && chunk.includes(REPAINT_START)) expectRepaint(term.cols, term.rows, true);
            if (!reply) return writeOut(chunk);
            reply.data += chunk;
            if (reply.writing) return;
            const repaint = readRepaint(reply.data, reply.rows);
            if (repaint) applyResize(repaint);
          },
          onControl: (next) => {
            control = next;
            term.options.disableStdin = following();
            setTerminalFollowing(leafId, following() ? (next.by?.kind ?? null) : null);
            applyControl();
          },
          onExit: () => draw(`\r\n${t("terminal.exited")}\r\n`),
          onReset: () => term.reset(),
        },
        screen?.end,
      );
      const input = term.onData((data) => {
        if (following()) return;
        // Typing in a terminal nobody controls takes it.
        if (!control?.by) takeOver();
        // The first keystroke is what makes this terminal worth asking about
        // before it is closed.
        markTerminalUsed(leafId);
        void terminalTransport.write(leafId, data);
      });

      // The pane is resizable and tiled; the shell has to be told, or every
      // full-screen program keeps drawing into the old box.
      //
      // Applied once, to the grid the pane SETTLES on: collapsing the sidebar
      // animates a width for 200ms, and each step would re-measure the DOM and
      // make Claude Code repaint its conversation.
      //
      // xterm waits too, until the program answers. Claude Code answers with a
      // repaint of its latest turn, which would land on top of the copy
      // already here; it is spliced in instead (see `spliceRepaint`), the old
      // rows it replaces erased BEFORE xterm re-wraps them. Any other program
      // (a shell prompt, vim) prints no such repaint: after RESIZE_REPLY_MS its
      // output is written after the resize, as before.
      let queued = 0;
      let settle: ReturnType<typeof setTimeout> | undefined;
      let sent = { cols: term.cols, rows: term.rows };
      const applyResize = (repaint: Repaint | null) => {
        if (!reply || reply.writing) return;
        const { cols, rows, data, timer, own } = reply;
        clearTimeout(timer);
        const resizeAndWrite = (text: string) => {
          reply = null;
          term.resize(cols, rows);
          writeOut(text);
        };
        if (repaint === null) return resizeAndWrite(data);
        // Output arriving meanwhile queues behind the repaint.
        reply.data = "";
        reply.writing = true;
        draw(repaint.before, () => {
          const buffer = term.buffer.active;
          const screen = Array.from(
            { length: term.rows },
            (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? "",
          );
          const splice = spliceRepaint(repaint, screen);
          // A repaint of its own that lines up with nothing on screen is a new
          // screen, not a redraw: /clear draws its banner this way. As sent.
          if (own && !splice.matched) return resizeAndWrite(data.slice(repaint.before.length) + (reply?.data ?? ""));
          draw(splice.clear, () => resizeAndWrite(splice.repaint + (reply?.data ?? "")));
        });
      };
      // A view following another takes that view's size, and splices the
      // repaint it brings in the same way: it is the answer to a resize too.
      const tellShell = () => {
        settle = undefined;
        if (reply?.writing) {
          settle = setTimeout(tellShell, RESIZE_SETTLE_MS);
          return;
        }
        const follow = following();
        const size = follow && control ? { cols: control.cols, rows: control.rows } : fit.proposeDimensions();
        if (!size || (size.cols === sent.cols && size.rows === sent.rows)) return;
        expectRepaint(size.cols, size.rows);
        if (!follow) void terminalTransport.resize(leafId, size.cols, size.rows);
      };
      const expectRepaint = (cols: number, rows: number, own = false) => {
        applyResize(null);
        sent = { cols, rows };
        reply = {
          ...sent,
          data: "",
          writing: false,
          own,
          // A program that prints nothing, or only part of a repaint.
          timer: setTimeout(() => applyResize(null), RESIZE_REPLY_MS),
        };
      };
      // Take control at this pane's own size.
      const takeOver = () => {
        const size = fit.proposeDimensions();
        if (!size) return;
        if (reply?.writing) {
          setTimeout(takeOver, RESIZE_SETTLE_MS);
          return;
        }
        clearTimeout(settle);
        control = { by: terminalTransport.viewer, cols: size.cols, rows: size.rows };
        term.options.disableStdin = false;
        setTerminalFollowing(leafId, null);
        if (size.cols !== sent.cols || size.rows !== sent.rows) expectRepaint(size.cols, size.rows);
        void terminalTransport.claim(leafId, size.cols, size.rows);
        term.focus();
      };
      resizing = true;
      // At once: the repaint for the new size is already on its way. A size
      // this view did not ask for, while no one else controls the shell, is
      // spliced like any other; then this view asks for its own back.
      applyControl = () => {
        clearTimeout(settle);
        const c = control;
        if (c && !following() && !reply?.writing && (c.cols !== sent.cols || c.rows !== sent.rows)) {
          expectRepaint(c.cols, c.rows);
          settle = setTimeout(tellShell, RESIZE_SETTLE_MS);
          return;
        }
        tellShell();
      };
      if (control) applyControl();
      const observer = new ResizeObserver(() => {
        if (queued) return;
        queued = requestAnimationFrame(() => {
          queued = 0;
          // Parked, or on a Screen that is not on display: a zero box would
          // have xterm propose a nonsense grid.
          if (
            !container.isConnected ||
            !container.clientWidth ||
            !container.clientHeight
          )
            return;
          // A box out of display loses its scroll position, and xterm does
          // not notice: it still draws the bottom while the scrollbar sits at
          // the top, so wheeling up does nothing and wheeling down jumps to
          // the first line. Moving the view puts the scrollbar back under it.
          const line = term.buffer.active.viewportY;
          term.scrollToTop();
          term.scrollToLine(line);
          clearTimeout(settle);
          settle = setTimeout(tellShell, RESIZE_SETTLE_MS);
        });
      });
      observer.observe(container);

      // Follows the theme as it changes (Settings, or the system's light/dark
      // when the theme is "system"), not just the one it opened in.
      const themeWatch = new MutationObserver(() => {
        term.options.theme = readTheme();
      });
      themeWatch.observe(document.documentElement, { attributeFilter: ["data-theme", "data-variant"] });

      // Sent once, on the pane's FIRST open — never on a remount, which would
      // re-run it over whatever the user is doing in that shell.
      // And only into a shell this open STARTED: one already running (the
      // desktop window and a web page share it) is in the middle of something.
      const startup = created ? terminalStartup({ command, agent }) : undefined;
      if (startup) {
        markTerminalUsed(leafId);
        void terminalTransport.write(leafId, `${startup}\n`);
      }

      putTerminal(leafId, {
        term,
        fit,
        search,
        container,
        takeOver,
        dispose: () => {
          unsubscribe();
          void terminalTransport.release?.(leafId);
          container.removeEventListener("paste", onPaste, true);
          container.removeEventListener("input", onInput, true);
          clearTimeout(pasteWait);
          input.dispose();
          links.dispose();
          observer.disconnect();
          themeWatch.disconnect();
          if (queued) cancelAnimationFrame(queued);
          clearTimeout(settle);
          clearTimeout(saveTimer);
          clearInterval(stuckCheck);
          if (reply) clearTimeout(reply.timer);
        },
      });
      if (disposed) container.remove();
      else term.focus();
    })();

    return () => {
      disposed = true;
      getTerminal(leafId)?.container.remove();
    };
    // `cwd`, `command` and `agent` belong to the pane's first open. `cwd` and
    // `agent` are also rewritten every few seconds as the shell moves (see
    // `recordTerminal`), and none of that may rebuild a live terminal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leafId, t, available, build]);

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
          if (selection) void copyText(selection);
        }}
      >
        {t("terminal.menu.copy")}
      </ContextMenuItem>
      {/* A browser reads the clipboard only on a secure origin; over a LAN
          http address it cannot, and ⌘V into the terminal still works. */}
      {canReadClipboard() && (
        <ContextMenuItem
          onSelect={() => {
            void readClipboard().then((text) => {
              if (!text || followingKind) return;
              markTerminalUsed(leafId);
              void terminalTransport.write(leafId, text);
            });
          }}
        >
          {t("terminal.menu.paste")}
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => getTerminal(leafId)?.term.selectAll()}>
        {t("terminal.menu.selectAll")}
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() =>
          void copyReference(
            terminalReference({ shellId: terminalShellId(leafId), name, cwd, agent }),
            t("reference.copied"),
          )
        }
      >
        {t("reference.copy")}
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
      {cwd && isTauri && (
        <ContextMenuItem onSelect={() => void revealPath(cwd)}>
          {t("terminal.menu.revealCwd")}
        </ContextMenuItem>
      )}
      {/* Only once the agent has exited: typed while it runs, the command
          would land in the agent's own prompt. */}
      {agent && !agent.running && resumeCommand(agent) && (
        <ContextMenuItem
          onSelect={() => {
            markTerminalUsed(leafId);
            void terminalTransport.write(leafId, `${resumeCommand(agent)}\n`);
            getTerminal(leafId)?.term.focus();
          }}
        >
          {t("terminal.menu.resumeAgent", {
            agent: terminalAgentName(agent.kind),
          })}
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => setSearching(true)}>
        {t("terminal.search.find")}
      </ContextMenuItem>
      {onRename && (
        <ContextMenuItem onSelect={onRename}>
          {t("terminal.rename")}
        </ContextMenuItem>
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
      {onClose && (
        <ContextMenuItem onSelect={onClose}>
          {t("group.closePane")}
        </ContextMenuItem>
      )}
    </>
  );

  if (!available) {
    return (
      <div className="p-4 text-[13px] text-muted">
        {t(isGatewayWeb ? "terminal.webOff" : "terminal.desktopOnly")}
      </div>
    );
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
            onClose={() => findControls.get(leafId)?.close()}
          />
        )}
        {followingKind && (
          <ControlMask
            by={t(`terminal.control.by.${followingKind}`)}
            onTakeOver={() => getTerminal(leafId)?.takeOver()}
          />
        )}
      </div>
    </ContextMenu>
  );
}

/** Over a terminal another view controls: frosted, so the output still shows
 *  through, with who has it and how to take it. */
function ControlMask({ by, onTakeOver }: { by: string; onTakeOver: () => void }) {
  const { t } = useTranslation("session");
  const action = "text-[13px] text-text transition-colors hover:text-accent";
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-5 bg-surface/60 backdrop-blur-md">
      <p className="text-[13px] text-muted">{t("terminal.control.held", { by })}</p>
      <div className="flex items-center gap-4 border-t border-border/70 pt-4">
        <button type="button" className={action} onClick={onTakeOver}>
          {t("terminal.control.takeOver")}
        </button>
        <span aria-hidden className="h-3 w-px bg-border" />
        <button type="button" className={action} onClick={takeOverAll}>
          {t("terminal.control.takeOverAll")}
        </button>
      </div>
    </div>
  );
}

interface FindControls {
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
}

/** The find bar of whichever component currently shows each terminal. */
const findControls = new Map<string, FindControls>();

/** How long the pane must hold still before the shell is told its new size:
 *  longer than a frame, shorter than a person notices after letting go. */
const RESIZE_SETTLE_MS = 150;

/** How often, at most, a pane saves its screen while output comes in: the
 *  output since is replayed on a reopen, so it only has to be well within the
 *  host's 256 KB of recent output. */
const SAVE_SCREEN_MS = 10_000;
/** Retry delay when the screen could not be saved just then. */
const SAVE_RETRY_MS = 500;

/** How long output may wait on xterm before the pane is built again. xterm
 *  parses in slices between frames, so a busy one still finishes a write now
 *  and then; one that finishes none for this long has stopped. */
const DRAW_STUCK_MS = 5_000;

/** How long a resize waits for Claude Code's repaint before xterm resizes
 *  anyway. Claude Code answers within 10ms; a shell waits this long. */
const RESIZE_REPLY_MS = 100;

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

/** Waits for the terminal's own font before a terminal opens. xterm measures
 *  its cell when it opens and again on every resize, and JetBrains Mono is a
 *  web font that loads on first use. A pane opened before it arrived (the
 *  restored layout at launch) measured a fallback font; its next resize
 *  measured the taller real one but kept the row count, so the bottom rows,
 *  Claude Code's input box among them, sat below the pane where no scrolling
 *  reaches them. */
function loadTerminalFont(): Promise<unknown> {
  if (!document.fonts) return Promise.resolve();
  const { fontSize, fontFamily, fontWeight, fontWeightBold } = TERMINAL_OPTIONS;
  return Promise.all(
    [fontWeight, fontWeightBold].map((w) => document.fonts.load(`${w} ${fontSize}px ${fontFamily}`)),
  ).catch(() => undefined);
}

/** Clipboard reads and Finder, kept out of the menu body so it reads as a list
 *  of actions rather than a list of dynamic imports. */
function canReadClipboard(): boolean {
  return isTauri || typeof navigator.clipboard?.readText === "function";
}

async function readClipboard(): Promise<string> {
  if (!isTauri) return navigator.clipboard.readText();
  const paths = await readCopiedFiles();
  if (paths) return paths;
  const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
  return (await readText()) ?? "";
}

async function revealPath(path: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("reveal_path", { path, root: null });
}

/** xterm paints its own canvas, so it cannot inherit CSS variables — the
 *  current values are read and handed over, again on every theme change. */
function readTheme() {
  const style = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  const accent = value("--accent", "#c15f3c");
  // The 16 ANSI colours each theme tunes for its own ground (index.css);
  // xterm's defaults are for a black one, and vanish on a light ground.
  const ansi = Object.fromEntries(
    ANSI_NAMES.flatMap((name, i) => {
      const c = style.getPropertyValue(`--term-ansi-${i}`).trim();
      return c ? [[name, c]] : [];
    }),
  );
  return {
    background: value("--surface", "#ffffff"),
    foreground: value("--term-fg", value("--text", "#2a2723")),
    cursor: accent,
    // Accent at 30% (hex alpha 4d): agents paint the input line in a pale
    // surface tone, so a surface-coloured selection would vanish on it.
    selectionBackground: `${accent}4d`,
    ...ansi,
  };
}

const ANSI_NAMES = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;
