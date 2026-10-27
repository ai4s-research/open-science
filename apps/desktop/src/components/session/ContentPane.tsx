import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MessagesSquare, Terminal as TerminalIcon, X } from "lucide-react";
import { terminalName, useLayoutStore, type PaneContent, type TerminalAgent } from "@/lib/layout";
import { CLI_AGENTS, ensureCliAgent } from "@/lib/cliAgents";
import { isTauri } from "@/lib/tauri";
import { isGatewayWeb } from "@/lib/webMode";
import { toast } from "@/lib/toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { draftKeyFor, useRuntimeStore } from "@/lib/runtime";
import { startPaneDrag } from "@/lib/dragPane";
import { extOf } from "@/lib/artifacts";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import { TerminalSenders } from "@/components/terminal/TerminalSenders";
import { InlineName } from "@/components/ui/InlineName";
import { NotebookEditor } from "@/components/notebook/NotebookEditor";
import { FilesPage } from "@/app/routes/FilesPage";
import { FilePreviewInspector } from "@/components/inspector/FilePreviewInspector";
import { HOVER_REVEAL } from "@/components/inspector/RightPane";
import { useIsMobile } from "@/lib/useIsMobile";
import { cn } from "@/lib/cn";

/**
 * A pane holding something that is not a conversation: a terminal, the file
 * tree, a notebook, an edited file, a web page.
 *
 * Most of these surfaces already HAVE a header — the notebook's carries its
 * kernel, save state and history; the file tree carries its breadcrumbs — so
 * this adds none and hands them `onClose` instead. Wrapping them gave every
 * pane two stacked title bars, which is what the reported "好几层 Header" was.
 * Only the terminal, which has no chrome of its own, is given one here.
 */
export function ContentPane({
  content,
  leafId,
  onClose,
  solo = false,
}: {
  content: PaneContent;
  leafId: string;
  onClose: () => void;
  /** The Screen's only pane: the terminal's header shows on hover only. */
  solo?: boolean;
}) {
  const { t } = useTranslation(["session", "nav"]);
  const openContentPane = useLayoutStore((s) => s.openContentPane);
  const showDocumentPane = useLayoutStore((s) => s.showDocumentPane);
  const renamePane = useLayoutStore((s) => s.renamePane);
  const dockSession = useLayoutStore((s) => s.dockSession);
  const replacePane = useLayoutStore((s) => s.replacePane);
  const [confirmContinue, setConfirmContinue] = useState(false);
  const adoptAcpSession = useRuntimeStore((s) => s.adoptAcpSession);
  const aimDraft = useRuntimeStore((s) => s.aimDraft);
  const [renaming, setRenaming] = useState(false);
  const isMobile = useIsMobile();

  /** Split into a CONVERSATION, aimed at the folder the pane works in — the
   *  same path the session header's split button takes, so a session opened
   *  beside a terminal starts where that terminal is. */
  const splitSession = (dir: "row" | "col", folder: string | null) => {
    // eslint-disable-next-line i18next/no-literal-string -- DockEdge enum, not UI copy
    const created = dockSession(leafId, dir === "row" ? "right" : "bottom", null);
    if (created && folder) aimDraft(draftKeyFor(created), folder);
  };

  /** The CLI agent the terminal is running, when the app can drive it over ACP
   *  (desktop only: the agent is a process on this machine). */
  const cliAgentOf = (agent?: TerminalAgent) =>
    agent && isTauri && !isGatewayWeb ? CLI_AGENTS.find((a) => a.detect === agent.kind) : undefined;

  /**
   * Continue the terminal's agent session as a conversation in the app, in the
   * terminal's place, after the user confirms. The terminal closes: two
   * processes writing one session would fork its history. The conversation
   * offers the way back (SessionView's terminal button).
   */
  const continueInApp = async (agent: TerminalAgent) => {
    const cli = cliAgentOf(agent);
    if (!cli) return;
    try {
      const entry = ensureCliAgent(cli);
      const folder = content.kind === "terminal" ? content.cwd : undefined;
      const fallback = folder ?? useRuntimeStore.getState().workspace;
      if (!fallback) throw new Error("No folder to resume this conversation in.");
      await adoptAcpSession(entry.id, agent.sessionId, fallback);
      replacePane(leafId, { sessionId: agent.sessionId });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  switch (content.kind) {
    case "terminal": {
      const cli = cliAgentOf(content.agent);
      const name = terminalName(content, t("terminal.title"));
      return (
        <div className="flex h-full flex-col bg-surface">
          {/* 32px, like every pane beside a conversation (see `PANE_HEADER`),
              and no rule under it: the terminal's surface starts right below. */}
          <header
            className={cn(
              "flex h-8 shrink-0 select-none items-center gap-1.5 px-2.5",
              // A phone has no pointer to wait for.
              solo && !isMobile && HOVER_REVEAL,
            )}
          >
            <TerminalIcon size={13} strokeWidth={1.5} className="shrink-0 text-muted" />
            {renaming ? (
              <InlineName
                initial={content.name ?? ""}
                placeholder={name}
                ariaLabel={t("terminal.rename")}
                onCommit={(name) => {
                  renamePane(leafId, name);
                  setRenaming(false);
                }}
                onCancel={() => setRenaming(false)}
              />
            ) : (
              <span
                // The header is a drag handle, exactly as a session's title is:
                // a terminal belongs to a Screen no more permanently than a
                // conversation does, and it was the one pane that could not be
                // moved. `startPaneDrag` only begins past a few pixels, so the
                // double-click below still renames.
                onPointerDown={(e) =>
                  startPaneDrag(
                    e,
                    // eslint-disable-next-line i18next/no-literal-string -- DragSource kind, not UI copy
                    { kind: "pane", leafId, sessionId: null },
                    name,
                  )
                }
                onDoubleClick={() => setRenaming(true)}
                title={t("group.renameHint")}
                className="min-w-0 max-w-[15rem] cursor-grab truncate text-[13px] font-medium text-text active:cursor-grabbing"
              >
                {name}
              </span>
            )}
            <div className="flex-1" />
            {cli && content.agent && (
              <button
                onClick={() => setConfirmContinue(true)}
                className="rounded-md p-1 text-muted transition-colors hover:bg-border hover:text-text"
                aria-label={t("terminal.continueInApp.label")}
                title={t("terminal.continueInApp.label")}
              >
                <MessagesSquare size={13} strokeWidth={1.5} />
              </button>
            )}
            <TerminalSenders leafId={leafId} />
            <button
              onClick={onClose}
              className="rounded-md p-1 text-muted transition-colors hover:bg-border hover:text-error"
              aria-label={t("group.closePane")}
            >
              <X size={13} strokeWidth={1.5} />
            </button>
          </header>
          {confirmContinue && cli && content.agent && (
            <ConfirmDialog
              title={t("terminal.continueInApp.confirmTitle")}
              body={t("terminal.continueInApp.confirmBody", { agent: cli.name })}
              confirmLabel={t("terminal.continueInApp.label")}
              // eslint-disable-next-line i18next/no-literal-string -- tone enum, not UI copy
              tone="default"
              // eslint-disable-next-line i18next/no-literal-string -- scope enum, not UI copy
              scope="pane"
              onConfirm={() => {
                setConfirmContinue(false);
                void continueInApp(content.agent!);
              }}
              onCancel={() => setConfirmContinue(false)}
            />
          )}
          <div className="min-h-0 flex-1 overflow-hidden">
            <TerminalPane
              leafId={leafId}
              cwd={content.cwd}
              name={content.name}
              command={content.command}
              agent={content.agent}
              // Splitting from the terminal's own menu puts the new pane BESIDE
              // it — the pane-level gesture, as opposed to the Screen bar's "+",
              // which makes a whole new Screen. What the new pane HOLDS is the
              // user's choice: a second terminal, or a conversation about what
              // the first one just printed.
              onSplit={(dir, kind) =>
                kind === "terminal"
                  ? // eslint-disable-next-line i18next/no-literal-string -- PaneContent kind, not UI copy
                    openContentPane({ kind: "terminal", cwd: content.cwd }, dir)
                  : splitSession(dir, content.cwd ?? null)
              }
              onRename={() => setRenaming(true)}
              onClose={onClose}
            />
          </div>
        </div>
      );
    }

    case "files":
      return (
        <FilesPage
          onClose={onClose}
          // A file opens BESIDE the tree, not on top of it: the whole reason
          // the browser is a pane is that you keep browsing while you read.
          // `base`, because that is the tree these paths came from. Opening
          // them as workspace-relative made every click report "file not
          // found": the two roots only coincide for the active session.
          //
          // ONE pane for files, reused on every click: a pane per click left
          // the tree fighting a row of slivers for the width.
          onOpenFile={(entry) =>
            showDocumentPane(
              /* eslint-disable i18next/no-literal-string -- PaneContent kinds and FileRoot, not UI copy */
              extOf(entry.name) === "ipynb"
                ? { kind: "notebook", path: entry.path, root: "base" }
                : { kind: "editor", path: entry.path, root: "base" },
              /* eslint-enable i18next/no-literal-string */
            )
          }
        />
      );

    case "notebook":
      return (
        <NotebookEditor path={content.path} root={content.root} onClose={onClose} compactHeader />
      );

    case "editor":
      return (
        <FilePreviewInspector
          data={{
            variant: "file",
            path: content.path,
            filename: baseName(content.path),
            // eslint-disable-next-line i18next/no-literal-string -- artifact kind, not UI copy
            artifact: "report",
            root: content.root,
          }}
          onClose={onClose}
          compactHeader
          // An editor pane opens IN edit mode. Arriving read-only with a pencil
          // to hunt for made it read as a preview that happens to be editable,
          // which is not what "open the file" means.
          startEditing
        />
      );
  }
}

function baseName(path: string): string {
  return path.split("/").pop() || path;
}
