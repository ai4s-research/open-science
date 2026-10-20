import * as ContextMenu from "@radix-ui/react-context-menu";
import { Copy, ExternalLink, FolderOpen, Unlink } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FileRoot } from "@ai4s/shared";
import {
  absoluteArtifactPath,
  openArtifactExternally,
  revealArtifact,
  type DirEntry,
} from "@/lib/artifactFile";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";

// The reveal action is the same everywhere; only its NAME matches the platform's
// file manager (label-only — the Rust side reveals correctly on all three).
const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
const isWin = typeof navigator !== "undefined" && navigator.userAgent.includes("Win");
const REVEAL_LABEL = isMac ? "Reveal in Finder" : isWin ? "Show in File Explorer" : "Show in File Manager";

async function copy(text: string, what: string) {
  try {
    await copyText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error("Could not copy to the clipboard.");
  }
}

/**
 * Right-click menu for a file/dir row in the explorer: reveal it in the OS file
 * manager, copy its absolute or workspace-relative path, or open it. Wraps the
 * row element (passed as `children`) as the menu's trigger — left-click still
 * does whatever the row's own onClick does.
 */
export function FileContextMenu({
  entry,
  root,
  onUnlink,
  children,
}: {
  entry: DirEntry;
  root: FileRoot;
  /** For a project's linked folder: unlink it (the caller asks first). */
  onUnlink?: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation(["pages", "common"]);

  const copyAbsolute = async () => {
    const abs = await absoluteArtifactPath(entry.path, root).catch(() => null);
    if (abs) await copy(abs, "Path");
    else toast.error("Could not resolve the file path.");
  };

  const reveal = async () => {
    try {
      await revealArtifact(entry.path, root);
    } catch (e) {
      toast.error(`Could not reveal the file: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-50 min-w-[190px] rounded-card border border-border bg-surface p-1 text-[13px] text-text shadow-pop">
          <Item icon={<FolderOpen size={14} />} onSelect={() => void reveal()}>
            {REVEAL_LABEL}
          </Item>
          <Item icon={<Copy size={14} />} onSelect={() => void copyAbsolute()}>
            {t("files.contextMenu.copyPath")}
          </Item>
          <Item
            icon={<Copy size={14} />}
            onSelect={() => void copy(entry.path, t("files.contextMenu.relativePathLabel"))}
          >
            {t("files.contextMenu.copyRelativePath")}
          </Item>
          {!entry.isDir && (
            <Item icon={<ExternalLink size={14} />} onSelect={() => void openArtifactExternally(entry.path, root)}>
              {t("files.contextMenu.openInDefaultApp")}
            </Item>
          )}
          {onUnlink && (
            <Item icon={<Unlink size={14} />} onSelect={onUnlink}>
              {t("files.linked.unlink")}
            </Item>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function Item({
  icon,
  children,
  onSelect,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      className={cn(
        "flex cursor-default items-center gap-2 rounded-input px-2 py-1.5 outline-none",
        "data-[highlighted]:bg-surface-2",
      )}
    >
      <span className="shrink-0 text-muted">{icon}</span>
      {children}
    </ContextMenu.Item>
  );
}
