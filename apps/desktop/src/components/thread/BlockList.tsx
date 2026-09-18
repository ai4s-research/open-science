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
import { ToolGroup, dropProcessArtifacts, groupToolBlocks } from "./ToolGroup";
import { TurnWork } from "./TurnWork";
import { dropReasoning, isTurnDone, spanMs, splitTurns } from "./turns";
import { ReviewerCard } from "./ReviewerCard";
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
  /** Answer a stall-guard warning's action: "keep-waiting" dismisses it and
   *  re-arms the guard; "stop" interrupts the turn. Present only in the live
   *  session. */
  onStallAction?: (stallKey: string, action: "keep-waiting" | "stop") => void;
  /** Reload a session whose history failed to load — the error line's Retry
   *  action (#139). Present only in the live session. */
  onRetryHistory?: () => void;
}

export function renderBlock(
  block: ThreadBlock,
  i: number,
  handlers?: BlockHandlers,
  /** Unused. Kept so the positional signature two test files call stays put;
   *  thinking is shown live on the status row and never rendered here. */
  _unusedLiveReasoning?: undefined,
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
      // Thinking is shown live beside "Working…" and never kept — `dropReasoning`
      // removes these before they reach here. This arm stays only because the
      // switch is exhaustive over the block union.
      return null;
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
      return (
        <StatusLine
          key={i}
          block={block}
          onStallAction={handlers?.onStallAction}
          onRetry={handlers?.onRetryHistory}
        />
      );
  }
}

// Memoized: with `blocks` unchanged (a re-render from unrelated state) the whole
// list — including groupToolBlocks — is skipped. When `blocks` does change, the
// per-block memo above ensures only the touched rows actually re-render (#34).
// Requires callers to pass a stable `handlers` reference (see LiveSessionPage).
export const BlockList = memo(function BlockList({
  blocks,
  handlers,
  workspaceDirectory,
  contextLimit,
}: {
  blocks: ThreadBlock[];
  handlers?: BlockHandlers;
  /** Workspace directory that owns inline artifact files. */
  workspaceDirectory?: string;
  /** Context window of the model this session uses, so each answer's meta line
   *  can say how full it is. 0/undefined ⇒ tokens shown without a percentage. */
  contextLimit?: number;
}) {
  // Three shaping passes, in this order.
  //
  // 1. The scratch files a turn wrote are dropped — the answer already ends with
  //    a chip per file it produced — which also stops a file card from splitting
  //    the run it sits in.
  // 2. The thread is cut into turns, and each turn into the work and the answer.
  // 3. Inside a turn's work, consecutive tool calls fold into one activity line.
  //
  // The order matters both times: dropping before grouping is what lets a run
  // fold as ONE line, and splitting before grouping keeps a group from ever
  // straddling two turns.
  //
  // `liveReasoningIndex` addresses the array the CALLER holds and the first pass
  // removes blocks, so the streaming thought is resolved to a BLOCK here and
  // compared by identity below. An index would point at whatever shifted into
  // that slot — silently, since a wrong index is still a valid one.
  const shaped = dropReasoning(dropProcessArtifacts(blocks));
  const renderOne = (block: ThreadBlock, key: number) =>
    renderBlock(block, key, handlers, undefined, workspaceDirectory, contextLimit);
  const renderRun = (run: ThreadBlock[], offset: number) =>
    groupToolBlocks(run).map((item) =>
      item.kind === "group" ? (
        <ToolGroup
          key={`group:${offset + item.start}`}
          blocks={item.blocks}
          onOpenSubagent={handlers?.onOpenSubagent}
        />
      ) : (
        renderOne(item.block, offset + item.index)
      ),
    );

  const cursorAfter = (turn: { lead: ThreadBlock[]; segments: { blocks: ThreadBlock[] }[] }, at: number) =>
    at + turn.lead.length + turn.segments.reduce((n, seg) => n + seg.blocks.length, 0);
  let offset = 0;
  return (
    <>
      {splitTurns(shaped).map((turn) => {
        const at = offset;
        offset = cursorAfter(turn, at) + turn.answer.length;
        return (
          <div key={at} className="flex flex-col gap-4">
            {turn.lead.map((b, i) => renderOne(b, at + i))}
            {(() => {
              const done = isTurnDone(turn);
              let cursor = at + turn.lead.length;
              return turn.segments.map((segment) => {
                const from = cursor;
                cursor += segment.blocks.length;
                const rendered = renderRun(segment.blocks, from);
                // Each foldable run gets its OWN line and its own elapsed time:
                // a notice between two runs (a reviewer's findings, a status
                // line) stays on screen and splits them, and one turn-wide
                // figure repeated on both would be wrong on at least one.
                return segment.foldable && done ? (
                  <TurnWork key={from} done durationMs={spanMs(segment.blocks)}>
                    {rendered}
                  </TurnWork>
                ) : (
                  <div key={from} className="flex flex-col gap-4">
                    {rendered}
                  </div>
                );
              });
            })()}
            {renderRun(turn.answer, cursorAfter(turn, at))}
          </div>
        );
      })}
    </>
  );
});
