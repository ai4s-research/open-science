import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal as TerminalIcon, X } from "lucide-react";
import { useLayoutStore, type PaneContent } from "@/lib/layout";
import { draftKeyFor, useRuntimeStore } from "@/lib/runtime";
import { startPaneDrag } from "@/lib/dragPane";
import { extOf } from "@/lib/artifacts";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import { InlineName } from "@/components/ui/InlineName";
import { NotebookEditor } from "@/components/notebook/NotebookEditor";
import { FilesPage } from "@/app/routes/FilesPage";
import { FilePreviewInspector } from "@/components/inspector/FilePreviewInspector";

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
}: {
  content: PaneContent;
  leafId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(["session", "nav"]);
  const openContentPane = useLayoutStore((s) => s.openContentPane);
  const showDocumentPane = useLayoutStore((s) => s.showDocumentPane);
  const renamePane = useLayoutStore((s) => s.renamePane);
  const dockSession = useLayoutStore((s) => s.dockSession);
  const aimDraft = useRuntimeStore((s) => s.aimDraft);
  const [renaming, setRenaming] = useState(false);

  /** Split into a CONVERSATION, aimed at the folder the pane works in — the
   *  same path the session header's split button takes, so a session opened
   *  beside a terminal starts where that terminal is. */
  const splitSession = (dir: "row" | "col", folder: string | null) => {
    // eslint-disable-next-line i18next/no-literal-string -- DockEdge enum, not UI copy
    const created = dockSession(leafId, dir === "row" ? "right" : "bottom", null);
    if (created && folder) aimDraft(draftKeyFor(created), folder);
  };

  switch (content.kind) {
    case "terminal":
      return (
        <div className="flex h-full flex-col bg-surface">
          <header className="flex h-8 shrink-0 select-none items-center gap-1.5 border-b border-faint px-2.5">
            <TerminalIcon size={13} strokeWidth={1.5} className="shrink-0 text-muted" />
            {renaming ? (
              <InlineName
                initial={content.name ?? ""}
                placeholder={t("terminal.title")}
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
                    content.name || t("terminal.title"),
                  )
                }
                onDoubleClick={() => setRenaming(true)}
                title={t("group.renameHint")}
                className="min-w-0 max-w-[15rem] cursor-grab truncate text-[13px] font-medium text-text active:cursor-grabbing"
              >
                {content.name || t("terminal.title")}
              </span>
            )}
            <div className="flex-1" />
            <button
              onClick={onClose}
              className="rounded-md p-1 text-muted transition-colors hover:bg-border hover:text-error"
              aria-label={t("group.closePane")}
            >
              <X size={13} strokeWidth={1.5} />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-hidden">
            <TerminalPane
              leafId={leafId}
              cwd={content.cwd}
              command={content.command}
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
