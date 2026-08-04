import { memo } from "react";
import {
  Box,
  FileBarChart,
  FileCode2,
  FileText,
  Image as ImageIcon,
  NotebookPen,
  Paperclip,
  SquareArrowOutUpRight,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ArtifactBlock, ArtifactKind } from "@ai4s/shared";
import { cn } from "@/lib/cn";

const ICON: Record<ArtifactKind, React.ReactNode> = {
  figure: <ImageIcon size={15} />,
  script: <FileCode2 size={15} />,
  report: <FileText size={15} />,
  table: <FileBarChart size={15} />,
  notebook: <NotebookPen size={15} />,
  model: <Box size={15} />,
  data: <Paperclip size={15} />,
};

/** A file the agent produced, surfaced live in the thread and openable in the inspector. */
export const ArtifactCard = memo(function ArtifactCard({
  block,
  onOpen,
}: {
  block: ArtifactBlock;
  onOpen?: (a: ArtifactBlock) => void;
}) {
  const { t } = useTranslation(["session", "common"]);
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-input border border-border bg-surface px-3 py-2.5 text-sm",
        onOpen && "cursor-pointer hover:bg-surface-2",
      )}
      onClick={onOpen ? () => onOpen(block) : undefined}
      role={onOpen ? "button" : undefined}
    >
      <span className="shrink-0 text-accent">{ICON[block.artifact]}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-text">{block.filename}</span>
        {block.path && block.path !== block.filename && (
          <span
            className="block truncate text-[11px] text-muted"
            title={block.path}
          >
            {block.path}
          </span>
        )}
      </span>
      <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted ring-1 ring-border">
        {t(`artifact.kind.${block.artifact}`)}
      </span>
      <span className="shrink-0 truncate text-xs text-muted">
        {t("artifact.via", { tool: block.tool })}
      </span>
      <div className="flex-1" />
      {onOpen && (
        <span className="flex shrink-0 items-center gap-1 rounded-input px-2 py-1 text-xs text-link">
          <SquareArrowOutUpRight size={13} /> {t("artifact.open")}
        </span>
      )}
    </div>
  );
});
