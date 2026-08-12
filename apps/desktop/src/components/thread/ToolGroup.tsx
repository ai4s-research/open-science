import { memo, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ThreadBlock, ToolCallBlock } from "@ai4s/shared";
import i18n from "@/i18n";
import { cn } from "@/lib/cn";
import { DiffView } from "@/components/code-viewer/DiffView";
import { STATUS } from "./ToolCallRow";
import { ReasoningRow } from "./ReasoningRow";
import { SubagentActivity } from "./SubagentActivity";
import { RunningDot } from "./RunningDot";

// Codex-style tool activity: consecutive quiet tool steps fold into one
// summary line ("Ran 3 commands, created a file"); expanding shows the list;
// expanding a step shows its detail (shell output, diff, file content)
// inline. While a step runs the group stays open and the running command
// shows a live output tail — a long training run never looks hung.

export type BlockListItem =
  | { kind: "group"; start: number; blocks: ThreadBlock[] }
  | { kind: "block"; index: number; block: ThreadBlock };

/** Fold a run of tool calls AND the reasoning between them into ONE activity
 *  group — thinking and doing are the same working stream, so interleaving them
 *  keeps consecutive tools merged instead of letting a "thinking" block split
 *  the run into fragments. Failures stay IN the group (routine trial-and-error;
 *  the summary counts them). A step that needs the USER (waiting-approval) or a
 *  non-groupable block (text, artifact, …) breaks the run. A run with no actual
 *  tool call — e.g. the reasoning that precedes the final answer — is not an
 *  activity group and renders on its own. Pure — exported for tests. */
export function groupToolBlocks(blocks: ThreadBlock[]): BlockListItem[] {
  const items: BlockListItem[] = [];
  let group: { start: number; blocks: ThreadBlock[] } | null = null;
  const flush = () => {
    const g = group;
    group = null;
    if (!g) return;
    if (g.blocks.some((b) => b.kind === "tool-call")) {
      items.push({ kind: "group", start: g.start, blocks: g.blocks });
    } else {
      // Reasoning-only run: no tools to summarize — render each on its own.
      g.blocks.forEach((b, k) => items.push({ kind: "block", index: g.start + k, block: b }));
    }
  };
  blocks.forEach((b, i) => {
    const groupable =
      (b.kind === "tool-call" && b.status !== "waiting-approval") || b.kind === "reasoning";
    if (groupable) {
      group ??= { start: i, blocks: [] };
      group.blocks.push(b);
    } else {
      flush();
      items.push({ kind: "block", index: i, block: b });
    }
  });
  flush();
  return items;
}

/** "Ran 3 commands, created a file" — one phrase per verb, in first-seen order.
 *  Counts tool calls only; interleaved reasoning doesn't add to the summary. */
export function summarizeGroup(blocks: ThreadBlock[]): string {
  const counts = new Map<string, number>();
  for (const b of blocks) {
    if (b.kind !== "tool-call") continue;
    const verb = b.verb ?? "";
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  const phrase = (verb: string, n: number): string => {
    switch (verb) {
      case "Ran":
        return i18n.t("session:tool.group.phrase.ran", { count: n });
      case "Created":
        return i18n.t("session:tool.group.phrase.created", { count: n });
      case "Edited":
        return i18n.t("session:tool.group.phrase.edited", { count: n });
      case "Read":
        return i18n.t("session:tool.group.phrase.read", { count: n });
      case "Searched":
        return i18n.t("session:tool.group.phrase.searched", { count: n });
      case "Listed":
        return i18n.t("session:tool.group.phrase.listed");
      case "Fetched":
        return i18n.t("session:tool.group.phrase.fetched", { count: n });
      default:
        return i18n.t("session:tool.group.phrase.default", { count: n });
    }
  };
  const text = [...counts.entries()].map(([verb, n]) => phrase(verb, n)).join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

/** Ticking elapsed time for a running step ("2m 41s"). */
export function Elapsed({ start }: { start: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted">
      {fmtDuration(Date.now() - start)}
    </span>
  );
}

/** Smooth expand/collapse without measuring content (grid-rows 0fr→1fr).
 *  Closed content is NOT mounted — a history session can hold a hundred tool
 *  steps whose details total megabytes of text; mounting them all up front
 *  makes opening the session jank. Opening mounts collapsed and expands on
 *  the next frame (so the animation still runs); closing unmounts after the
 *  transition finishes. */
function Collapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = window.requestAnimationFrame(() => setShown(true));
      return () => window.cancelAnimationFrame(raf);
    }
    setShown(false);
    const t = window.setTimeout(() => setMounted(false), 300);
    return () => window.clearTimeout(t);
  }, [open]);
  if (!mounted) return null;
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-300 ease-out",
        shown ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

const PANE =
  "whitespace-pre-wrap break-all px-3 py-2 font-mono text-xs leading-5";

/** Last few lines of a running command's stdout — the "it's alive" signal. */
function LiveTail({ text }: { text: string }) {
  const tail = text.replace(/\s+$/, "").split("\n").slice(-8).join("\n");
  if (!tail) return null;
  return (
    <pre className={cn(PANE, "ml-7 mb-1 mt-0.5 rounded-input bg-surface-2 text-muted")}>{tail}</pre>
  );
}

/** Shell detail: one panel, `$ command` header + scrollable output. */
function BashDetail({ block }: { block: ToolCallBlock }) {
  const out = block.output ?? block.outputSummary;
  return (
    <div className="ml-7 mb-1 mt-0.5 overflow-hidden rounded-input bg-surface-2">
      {block.command && (
        <pre className={cn(PANE, "text-muted", out && "border-b border-faint")}>
          {"$ "}
          {block.command}
        </pre>
      )}
      {out && <pre className={cn(PANE, "max-h-64 overflow-y-auto text-text")}>{out}</pre>}
    </div>
  );
}

function DiffDetail({ diff }: { diff: string }) {
  return <DiffView diff={diff} className="ml-7 mb-1 mt-0.5 max-h-64 overflow-y-auto" />;
}

function TextDetail({ text, muted }: { text: string; muted?: boolean }) {
  return (
    <pre
      className={cn(
        PANE,
        "ml-7 mb-1 mt-0.5 max-h-64 overflow-y-auto rounded-input bg-surface-2",
        muted ? "text-muted" : "text-text",
      )}
    >
      {text}
    </pre>
  );
}

function detailFor(block: ToolCallBlock): React.ReactNode | null {
  if (block.tool === "bash") {
    return block.command || block.output || block.outputSummary ? (
      <BashDetail block={block} />
    ) : null;
  }
  if (block.diff) return <DiffDetail diff={block.diff} />;
  if (block.content) return <TextDetail text={block.content} />;
  if (block.output) return <TextDetail text={block.output} />;
  return null;
}

// Memoized on `block`: within a group, only the tool step an SSE event actually
// changed re-renders — the group's other steps keep their block reference and
// are skipped, so a long tool run costs O(1) per event instead of O(steps) (#34).
const ToolRow = memo(function ToolRow({ block }: { block: ToolCallBlock }) {
  const { t } = useTranslation(["session", "common"]);
  const s = STATUS[block.status];
  const running = block.status === "running";
  // While running the live tail is already on screen — the row only becomes
  // expandable once there is a settled detail to reveal.
  const detail = running ? null : detailFor(block);
  // A user-typed "!" command ran for its output — its detail opens by default.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = (userOpen ?? !!block.outputSummary) && !!detail;
  const done = block.startedAt !== undefined && block.endedAt !== undefined;
  const duration = done ? block.endedAt! - block.startedAt! : 0;
  return (
    <div data-status={block.status}>
      <div
        role={detail ? "button" : undefined}
        tabIndex={detail ? 0 : undefined}
        onClick={detail ? () => setUserOpen(!open) : undefined}
        onKeyDown={
          detail
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setUserOpen(!open);
                }
              }
            : undefined
        }
        className={cn(
          "group flex items-center gap-2 rounded-input px-2 py-1 text-[12.5px]",
          detail && "cursor-pointer hover:bg-surface-2",
        )}
      >
        <span className={cn("shrink-0", s.className)} aria-label={t(`tool.status.${block.status}`)} role="img">
          {s.icon}
        </span>
        {block.verb && <span className="shrink-0 text-muted">{t(`tool.verb.${block.verb}`)}</span>}
        <span
          className={cn("min-w-0 truncate font-mono", running ? "text-text" : "text-muted")}
          title={block.command ?? block.title}
        >
          {block.title}
        </span>
        {detail && (
          <ChevronRight
            size={12}
            className={cn(
              "shrink-0 text-muted transition-transform duration-200",
              open && "rotate-90",
              !open && "opacity-0 group-hover:opacity-100",
            )}
          />
        )}
        <span className="min-w-0 flex-1" />
        {running && block.startedAt !== undefined && <Elapsed start={block.startedAt} />}
        {!running && done && duration >= 1000 && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted">
            {fmtDuration(duration)}
          </span>
        )}
        {block.meta && <span className="shrink-0 text-xs text-muted">{block.meta}</span>}
      </div>
      {/* Live pulse of the subagent this task spawned — self-subscribing so its
          child's folds never re-render this memoized row. */}
      {running && block.childSessionId && <SubagentActivity childId={block.childSessionId} />}
      {/* While running, the output tail is always visible — no click needed. */}
      {running && block.partialOutput && <LiveTail text={block.partialOutput} />}
      {detail && <Collapse open={open}>{detail}</Collapse>}
    </div>
  );
});

export function ToolGroup({
  blocks,
  start = 0,
  liveReasoningIndex,
}: {
  blocks: ThreadBlock[];
  /** Thread index of this group's first block — maps a row to its global index. */
  start?: number;
  /** Global index of the reasoning block currently streaming (if any). */
  liveReasoningIndex?: number;
}) {
  const { t } = useTranslation(["session", "common"]);
  // While a step runs the group stays open (the live tail must be visible);
  // once everything settles it folds to the summary. The fold waits a grace
  // period — within a turn the next command follows in seconds, and an
  // open→shut→open flap between steps would be pure jank. A click overrides.
  const tools = blocks.filter((b): b is ToolCallBlock => b.kind === "tool-call");
  // A thought streaming inside this group keeps it open too, so live thinking
  // is never hidden by an early fold when no tool happens to be running.
  const streamingHere =
    liveReasoningIndex != null &&
    liveReasoningIndex >= start &&
    liveReasoningIndex < start + blocks.length;
  const active =
    streamingHere || tools.some((b) => b.status === "running" || b.status === "pending");
  const failed = tools.filter((b) => b.status === "failed" || b.status === "warning").length;
  const [autoOpen, setAutoOpen] = useState(active);
  useEffect(() => {
    if (active) {
      setAutoOpen(true);
      return;
    }
    const timer = window.setTimeout(() => setAutoOpen(false), 2000);
    return () => window.clearTimeout(timer);
  }, [active]);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? autoOpen;
  const rows = blocks.map((b, i) =>
    b.kind === "reasoning" ? (
      <ReasoningRow key={i} block={b} streaming={start + i === liveReasoningIndex} inline />
    ) : b.kind === "tool-call" ? (
      <ToolRow key={i} block={b} />
    ) : null,
  );
  // A lone tool step (no interleaved thinking) keeps the bare-row look.
  if (blocks.length === 1 && blocks[0].kind === "tool-call") return <div>{rows}</div>;
  return (
    <div>
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        className="group flex w-full items-center gap-2 rounded-input px-2 py-1 text-left text-[12.5px] text-muted hover:bg-surface-2 hover:text-text"
      >
        {active ? (
          <RunningDot className="text-accent" />
        ) : (
          <ChevronRight
            size={13}
            className={cn("shrink-0 transition-transform duration-200", open && "rotate-90")}
          />
        )}
        <span className="min-w-0 truncate">{summarizeGroup(blocks)}</span>
        {failed > 0 && (
          <span className="shrink-0 text-error">· {t("tool.group.failedCount", { count: failed })}</span>
        )}
      </button>
      <Collapse open={open}>
        <div className="pl-4">{rows}</div>
      </Collapse>
    </div>
  );
}
