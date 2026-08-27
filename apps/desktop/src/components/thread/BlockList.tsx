import { memo } from "react";
import type { ArtifactBlock, FigureAnnotation, ThreadBlock } from "@ai4s/shared";
import {
  AgentMessage,
  DataTable,
  HistoryRepair,
  RunningJobsOverlay,
  StatusLine,
  UserMessage,
} from "./atoms";
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
  /** Open the subagents panel on the subagent a task row spawned. Present only
   *  in the live session — a nested transcript has no panel of its own. */
  onOpenSubagent?: (childSessionId: string) => void;
}

export function renderBlock(
  block: ThreadBlock,
  i: number,
  handlers?: BlockHandlers,
  liveReasoningIndex?: number,
  workspaceDirectory?: string,
  contextLimit?: number,
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
      return (
        <AgentMessage
          key={i}
          markdown={block.markdown}
          created={block.created}
          completed={block.completed}
          usage={block.usage}
          contextLimit={contextLimit}
          onOpenArtifact={handlers?.onArtifactOpen}
        />
      );
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
    case "history-repair":
      // Reuses the Revert handler: the repair IS a revert, to a message the app
      // picked instead of one the user clicked. Absent outside the live session,
      // which correctly leaves the diagnosis readable but not actionable.
      return <HistoryRepair key={i} block={block} onRevert={handlers?.onRevertMessage} />;
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
  contextLimit,
}: {
  blocks: ThreadBlock[];
  handlers?: BlockHandlers;
  /** Global index of the reasoning block streaming right now (live session);
   *  that block renders expanded and unfolds/collapses itself as it streams. */
  liveReasoningIndex?: number;
  /** Workspace directory that owns inline artifact files. */
  workspaceDirectory?: string;
  /** Context window of the model this session uses, so each answer's meta line
   *  can say how full it is. 0/undefined ⇒ tokens shown without a percentage. */
  contextLimit?: number;
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
            onOpenSubagent={handlers?.onOpenSubagent}
          />
        ) : (
          renderBlock(
            item.block,
            item.index,
            handlers,
            liveReasoningIndex,
            workspaceDirectory,
            contextLimit,
          )
        ),
      )}
    </>
  );
});
