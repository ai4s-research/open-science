import { memo, useEffect, useState } from "react";
import {
  BookOpen,
  ChevronRight,
  FilePlus2,
  FolderOpen,
  Globe,
  PanelRight,
  Pencil,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ThreadBlock, ToolCallBlock } from "@ai4s/shared";
import i18n from "@/i18n";
import { cn } from "@/lib/cn";
import { DiffView } from "@/components/code-viewer/DiffView";
import { STATUS } from "./ToolCallRow";
import { SubagentActivity } from "./SubagentActivity";
import { RunningDot } from "./RunningDot";
import { ICON_SLOT } from "./rowLayout";

// Codex-style tool activity: consecutive quiet tool steps fold into one
// summary line ("Ran 3 commands, created a file"); expanding shows the list;
// expanding a step shows its detail (shell output, diff, file content)
// inline. While a step runs the group stays open and the running command
// shows a live output tail — a long training run never looks hung.

export type BlockListItem =
  | { kind: "group"; start: number; blocks: ThreadBlock[] }
  | { kind: "block"; index: number; block: ThreadBlock };

/** Fold a run of consecutive tool calls into ONE activity group.
 *
 *  Reasoning is NOT folded in, and that is the whole shape of the thing. What
 *  the model says while it works is the narration a reader follows; the commands
 *  are the receipts. Folding both produced a summary line that opened into
 *  twenty cramped monospace rows, with the narration buried among them as
 *  one-line stubs. Leaving thought outside gives the alternation Codex has —
 *  paragraph, one muted line of "what I did", paragraph — where the prose is the
 *  backbone and the activity is an aside.
 *
 *  It costs what the old rule bought: a thought between two commands now splits
 *  them into two groups. That is the point, not a regression — each group is the
 *  work done since the last thing the model said, which is also why the summary
 *  lines get short enough to read.
 *
 *  Failures stay IN the group (routine trial-and-error; the summary counts
 *  them). A step that needs the USER (waiting-approval) or any non-groupable
 *  block breaks the run. Pure — exported for tests. */
export function groupToolBlocks(blocks: ThreadBlock[]): BlockListItem[] {
  const items: BlockListItem[] = [];
  let group: { start: number; blocks: ThreadBlock[] } | null = null;
  const flush = () => {
    const g = group;
    group = null;
    if (!g) return;
    items.push({ kind: "group", start: g.start, blocks: g.blocks });
  };
  blocks.forEach((b, i) => {
    const groupable = b.kind === "tool-call" && b.status !== "waiting-approval";
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

/**
 * Drop the file cards a turn produced along the way.
 *
 * They were first moved to the end of their turn, which is where seeing them
 * stacked showed what they actually are: noise. The answer already ends with a
 * chip per file it produced (`analyze.py  report.md  data.csv …`), so the cards
 * repeated that list at five times the height — and repeated themselves too,
 * since a file written and then edited is two cards for one file.
 *
 * Dropping them also un-splits the activity: a card between two tool steps used
 * to break the run in two, so one stretch of work folded as two groups.
 *
 * What is NOT dropped: artifacts the agent PRESENTED (`presentation`).
 * `present_artifact` is the agent deciding this file is the point of the
 * sentence it sits beside, which is the opposite of scratch work.
 *
 * Where the files went: the answer's own chips, and the Files panel, which
 * lists everything the session wrote whether the answer mentions it or not.
 *
 * Pure — exported for tests.
 */
export function dropProcessArtifacts(blocks: ThreadBlock[]): ThreadBlock[] {
  const process = (b: ThreadBlock): boolean => b.kind === "artifact" && !b.presentation;
  return blocks.some(process) ? blocks.filter((b) => !process(b)) : blocks;
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

/**
 * The icon for a run of activity, chosen by what it mostly did.
 *
 * Codex's rule, read off its own rows: the icon follows the FIRST phrase of the
 * summary, so "Read files, ran commands, searched the web" gets the book and
 * "Edited files, read files, ran commands" the pencil. The verb order is
 * first-seen (see `summarizeGroup`), so the icon and the sentence can never
 * disagree — both come from the same ordering.
 *
 * Why an icon at all: a wall of identical grey rows gives the reader nothing to
 * aim at when scrolling back for "where did it edit something". Shape is
 * faster to scan than text.
 */
const VERB_ICON: Record<string, React.ReactNode> = {
  Ran: <Terminal size={14} strokeWidth={1.5} />,
  Read: <BookOpen size={14} strokeWidth={1.5} />,
  Edited: <Pencil size={14} strokeWidth={1.5} />,
  Created: <FilePlus2 size={14} strokeWidth={1.5} />,
  Searched: <Search size={14} strokeWidth={1.5} />,
  Listed: <FolderOpen size={14} strokeWidth={1.5} />,
  Fetched: <Globe size={14} strokeWidth={1.5} />,
};

export function groupIcon(blocks: ThreadBlock[]): React.ReactNode {
  for (const b of blocks) {
    if (b.kind !== "tool-call") continue;
    const icon = VERB_ICON[b.verb ?? ""];
    if (icon) return icon;
  }
  // A run whose verbs this build does not know still gets a shape rather than
  // an empty slot, so the icon column stays a column.
  return <Wrench size={14} strokeWidth={1.5} />;
}

export function fmtDuration(ms: number): string {
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


/** The statuses whose row leads with WHY, not what. */
const FAILED = new Set(["failed", "warning"]);

/** The headline of an error: its first non-empty line, which is where a tool
 *  puts the sentence a reader needs ("cannot overwrite … without reading it
 *  first"); the lines under it are context for the expanded view. */
function firstLine(text?: string): string | undefined {
  const line = text?.split("\n").find((l) => l.trim() !== "");
  return line?.trim();
}

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
const ToolRow = memo(function ToolRow({
  block,
  onOpenSubagent,
}: {
  block: ToolCallBlock;
  onOpenSubagent?: (childSessionId: string) => void;
}) {
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
  // A subagent that is still working has no settled detail to unfold, and its
  // own transcript lives in the panel — so the row leads there instead of
  // being the one row in the group that does nothing when clicked.
  const opensPanel = running && !!block.childSessionId && !!onOpenSubagent;
  const errorLine = FAILED.has(block.status) ? firstLine(block.output) : undefined;
  const activate = opensPanel
    ? () => onOpenSubagent!(block.childSessionId!)
    : detail
      ? () => setUserOpen(!open)
      : undefined;
  return (
    <div data-status={block.status}>
      <div
        role={activate ? "button" : undefined}
        tabIndex={activate ? 0 : undefined}
        title={opensPanel ? t("subagents.openRow") : undefined}
        onClick={activate}
        onKeyDown={
          activate
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  activate();
                }
              }
            : undefined
        }
        className={cn(
          // Unpadded for the same reason as the group summary above: a lone
          // tool step renders as a bare row directly among the message blocks,
          // so its leading edge has to be theirs. Inside an expanded group the
          // wrapper's `pl-4` still provides the nesting indent.
          "group flex items-center gap-2 py-1 text-[12.5px]",
          activate && "cursor-pointer hover:text-text",
        )}
      >
        <span
          className={cn(ICON_SLOT, s.className)}
          aria-label={t(`tool.status.${block.status}`)}
          role="img"
        >
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
        {opensPanel && (
          <PanelRight size={12} className="shrink-0 text-muted opacity-0 group-hover:opacity-100" />
        )}
        {/* Why a step failed is the point of it. Behind two folds — the group,
            then the row — it was effectively unreadable, so the first line of
            the error rides the row itself. */}
        {!running && errorLine ? (
          <span className="min-w-0 flex-1 truncate text-error" title={block.output}>
            {errorLine}
          </span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {running && block.startedAt !== undefined && <Elapsed start={block.startedAt} />}
        {!running && done && duration >= 1000 && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted">
            {fmtDuration(duration)}
          </span>
        )}
        {block.meta && <span className="shrink-0 text-xs text-muted">{block.meta}</span>}
      </div>
      {/* Live pulse of the subagent this task spawned — self-subscribing so its
          child's folds never re-render this memoized row. It leads into the
          panel too: it is the line a reader is looking at when they decide
          they want to watch this subagent properly. */}
      {running && block.childSessionId && (
        <SubagentActivity
          childId={block.childSessionId}
          onOpen={opensPanel ? () => onOpenSubagent!(block.childSessionId!) : undefined}
          openLabel={t("subagents.openRow")}
        />
      )}
      {/* While running, the output tail is always visible — no click needed. */}
      {running && block.partialOutput && <LiveTail text={block.partialOutput} />}
      {detail && <Collapse open={open}>{detail}</Collapse>}
    </div>
  );
});

export function ToolGroup({
  blocks,
  onOpenSubagent,
}: {
  blocks: ThreadBlock[];
  /** Open the subagents panel on a running task's subagent. */
  onOpenSubagent?: (childSessionId: string) => void;
}) {
  const { t } = useTranslation(["session", "common"]);
  // While a step runs the group stays open (the live tail must be visible);
  // once everything settles it folds to the summary. The fold waits a grace
  // period — within a turn the next command follows in seconds, and an
  // open→shut→open flap between steps would be pure jank. A click overrides.
  const tools = blocks.filter((b): b is ToolCallBlock => b.kind === "tool-call");
  const active = tools.some((b) => b.status === "running" || b.status === "pending");
  const failed = tools.filter((b) => b.status === "failed" || b.status === "warning").length;
  // What the ONE folded line says while the run is live: the command actually
  // running, not a count of the ones that finished. Folding the list is what was
  // asked for; going silent with it was not, and "ran 4 commands" beside a
  // spinner tells a reader nothing about the twenty minutes they are waiting.
  const running = tools.find((b) => b.status === "running") ?? tools.find((b) => b.status === "pending");
  // Folded by default, running or not. A run of commands is one line while it
  // happens and one line afterwards, which is what "multiple consecutive
  // commands fold together" asks for; the running dot on that line carries the
  // live signal that an open list used to.
  //
  // It costs the live output tail of a running command. The dot, the summary and
  // the turn's own elapsed time all still move, so the window is not silent —
  // but a long build no longer shows its last lines here, and opening the group
  // is how to see them.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? false;
  const rows = blocks.map((b, i) =>
    b.kind === "tool-call" ? <ToolRow key={i} block={b} onOpenSubagent={onOpenSubagent} /> : null,
  );
  // A lone tool step (no interleaved thinking) keeps the bare-row look.
  if (blocks.length === 1 && blocks[0].kind === "tool-call") return <div>{rows}</div>;
  return (
    <div>
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        // No horizontal padding: this row sits between an agent message and a
        // file card, both of which start at the content edge, and the 8px inset
        // put its chevron out of line with everything around it. The hover
        // highlight still spans the full column — it is `w-full`, and only the
        // content was ever inset.
        // Codex's proportions: reading size, not the 12.5px of a log line, and
        // real vertical room so an activity line sits BETWEEN paragraphs rather
        // than crowding against them. It is one line among prose now, not the
        // header of a list, so it can afford the space.
        className="group flex w-full items-center gap-2.5 py-1.5 text-left text-[13.5px] text-muted hover:text-text"
      >
        {/* ONE icon column for every row in an activity run. The leading glyphs
            differ in size (Check 13, AlertTriangle 14, the running dot, a brain)
            so letting them size themselves left the column ragged — which is
            what the misalignment in the group was. A fixed slot centres whatever
            goes in it, whatever its glyph. */}
        <span className={cn(ICON_SLOT, "text-muted/70")}>
          {active ? <RunningDot className="text-accent" /> : groupIcon(blocks)}
        </span>
        {active && running ? (
          <>
            <span className="min-w-0 truncate font-mono text-text" title={running.command ?? running.title}>
              {running.title}
            </span>
            {running.startedAt !== undefined && <Elapsed start={running.startedAt} />}
          </>
        ) : (
          <span className="min-w-0 truncate">{summarizeGroup(blocks)}</span>
        )}
        {failed > 0 && (
          <span className="shrink-0 text-error">· {t("tool.group.failedCount", { count: failed })}</span>
        )}
        {/* The shape at the head says WHAT this run did; expandability is a
            hover hint, so a settled conversation reads as a list of activity
            rather than a column of disclosure triangles. */}
        <ChevronRight
          size={13}
          className={cn(
            "ml-auto shrink-0 text-muted/60 transition-transform duration-200",
            open ? "rotate-90" : "opacity-0 group-hover:opacity-100",
          )}
        />
      </button>
      <Collapse open={open}>
        <div className="pl-4">{rows}</div>
      </Collapse>
    </div>
  );
}
