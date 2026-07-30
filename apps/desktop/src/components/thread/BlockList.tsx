import { memo } from "react";
import type { ArtifactBlock, FigureAnnotation, ThreadBlock } from "@ai4s/shared";
import { AgentMessage, DataTable, RunningJobsOverlay, StatusLine, UserMessage } from "./atoms";
import { ToolCallRow } from "./ToolCallRow";
import { ToolGroup, groupToolBlocks } from "./ToolGroup";
import { ReviewerCard } from "./ReviewerCard";
import { ReasoningRow } from "./ReasoningRow";
import { StepSummaryRow } from "./StepSummaryRow";
import { FigureBlock } from "./FigureBlock";
import { ArtifactCard } from "./ArtifactCard";
import { InlineArtifact } from "./InlineArtifact";
import { CompactionRow } from "./CompactionRow";

export interface BlockHandlers {
  /** Open an artifact in the inspector (live session). */
  onArtifactOpen?: (a: ArtifactBlock) => void;
  /** Forward a figure annotation to the agent (live session). */
  onFigureComment?: (annotation: FigureAnnotation, figureTitle: string) => void;
  /** Edit a past user message (revert + resend). Present only in the live
   *  session — its absence hides the per-message Edit button. */
  onEditMessage?: (messageID: string, newText: string) => void | Promise<void>;
  /** Revert to a past user message (drop it + everything after) and prefill the
   *  composer with its text. Present only in the live session. */
  onRevertMessage?: (messageID: string, text: string) => void | Promise<void>;
}

export function renderBlock(
  block: ThreadBlock,
  i: number,
  handlers?: BlockHandlers,
  liveReasoningIndex?: number,
  workspaceDirectory?: string,
) {
  switch (block.kind) {
    case "user":
      return (
        <UserMessage
          key={i}
          block={block}
          onEdit={handlers?.onEditMessage}
          onRevert={handlers?.onRevertMessage}
        />
      );
    case "agent":
      return <AgentMessage key={i} markdown={block.markdown} onOpenArtifact={handlers?.onArtifactOpen} />;
    case "reasoning":
      return <ReasoningRow key={i} block={block} streaming={i === liveReasoningIndex} />;
    case "step-summary":
      return <StepSummaryRow key={i} block={block} />;
    case "tool-call":
      return <ToolCallRow key={i} block={block} />;
    case "reviewer":
      return <ReviewerCard key={i} block={block} />;
    case "table":
      return <DataTable key={i} block={block} />;
    case "figure":
      return <FigureBlock key={i} block={block} onComment={handlers?.onFigureComment} />;
    case "artifact":
      return block.presentation?.mode === "inline" && !block.filename.endsWith(".ipynb") ? (
        <InlineArtifact key={i} block={block} workspaceDirectory={workspaceDirectory} />
      ) : (
        <ArtifactCard key={i} block={block} onOpen={handlers?.onArtifactOpen} />
      );
    case "running-jobs":
      return <RunningJobsOverlay key={i} block={block} />;
    case "compaction":
      return <CompactionRow key={i} block={block} />;
    case "status-line":
      return <StatusLine key={i} block={block} />;
  }
}

// Memoized: with `blocks` unchanged (a re-render from unrelated state) the whole
// list — including groupToolBlocks — is skipped. When `blocks` does change, the
// per-block memo above ensures only the touched rows actually re-render (#34).
// Requires callers to pass a stable `handlers` reference (see LiveSessionPage).
export const BlockList = memo(function BlockList({
  blocks,
  handlers,
  liveReasoningIndex,
  workspaceDirectory,
}: {
  blocks: ThreadBlock[];
  handlers?: BlockHandlers;
  /** Global index of the reasoning block streaming right now (live session);
   *  that block renders expanded and unfolds/collapses itself as it streams. */
  liveReasoningIndex?: number;
  /** Workspace directory that owns inline artifact files. */
  workspaceDirectory?: string;
}) {
  // Runs of quiet tool steps render as one collapsible group (Codex-style);
  // everything else — text, artifacts, prominent tool cards — on its own.
  return (
    <>
      {groupToolBlocks(blocks).map((item) =>
        item.kind === "group" ? (
          <ToolGroup
            key={`group:${item.start}`}
            blocks={item.blocks}
            start={item.start}
            liveReasoningIndex={liveReasoningIndex}
          />
        ) : (
          renderBlock(item.block, item.index, handlers, liveReasoningIndex, workspaceDirectory)
        ),
      )}
    </>
  );
});
