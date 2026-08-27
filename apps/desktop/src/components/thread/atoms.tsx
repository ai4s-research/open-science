import { memo, useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, Paperclip, Pencil, RotateCcw, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type {
  ArtifactBlock,
  DataTableBlock,
  HistoryRepairBlock,
  MessageUsage,
  RunningJobsBlock,
  StatusLineBlock,
  UserMessageBlock,
} from "@ai4s/shared";
import { MessageMeta } from "./MessageMeta";
import { cn } from "@/lib/cn";
import { MarkdownViewer } from "@/components/markdown-viewer/MarkdownViewer";
import { extractArtifactRefs, refToArtifactBlock } from "@/lib/artifacts";
import { resolveArtifactPath } from "@/lib/artifactFile";
import { useThrottledValue } from "@/lib/useThrottledValue";
import { HSCROLL_ATTR } from "@/lib/wheelChain";
import { HOVER_HOST } from "@/lib/hoverTracking";
import { RunningDot } from "./RunningDot";

// All block atoms are memoized on their props: a fold rebuilds only the one
// block object it changed (the blocks-array copy preserves the rest by
// reference), so an SSE event re-renders just the affected row — the rest of a
// long conversation is skipped, keeping render cost flat as history grows (#34).
// A user turn: a right-aligned bubble that hugs its content (short prompts stay
// small; long ones wrap at 85% of the column). Hovering reveals Copy and — when
// the message carries a server id and the thread supplies the handlers — Edit
// (open inline, correct, resend) and Revert (roll back to here, prefill the
// composer). Edit and Revert both discard this message and everything after it
// and roll back the files those turns changed, so each confirms first.
export const UserMessage = memo(function UserMessage({
  block,
  onEdit,
  onRevert,
}: {
  block: UserMessageBlock;
  onEdit?: (messageID: string, newText: string) => void | Promise<void>;
  onRevert?: (messageID: string, text: string) => void | Promise<void>;
}) {
  const { t } = useTranslation(["session", "common"]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(block.text);
  const [copied, setCopied] = useState(false);
  // Which destructive action is awaiting confirmation, if any.
  const [confirm, setConfirm] = useState<null | "edit" | "revert">(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const canEdit = !!onEdit && !!block.messageID;
  const canRevert = !!onRevert && !!block.messageID;

  const copy = async () => {
    try {
      await copyText(block.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("message.copyFailed"));
    }
  };

  const openEditor = () => {
    setDraft(block.text);
    setEditing(true);
  };
  const runConfirmed = () => {
    const action = confirm;
    setConfirm(null);
    if (!block.messageID) return;
    if (action === "edit") {
      const text = draft.trim();
      if (!text) return;
      setEditing(false);
      void onEdit?.(block.messageID, text);
    } else if (action === "revert") {
      void onRevert?.(block.messageID, block.text);
    }
  };

  // Focus at the end when the editor opens.
  useEffect(() => {
    if (!editing) return;
    const el = areaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  const confirmDialog = confirm && (
    <ConfirmDialog
      title={t("message.confirm.title")}
      body={t("message.confirm.body")}
      confirmLabel={confirm === "edit" ? t("message.confirm.edit") : t("message.confirm.revert")}
      onConfirm={runConfirmed}
      onCancel={() => setConfirm(null)}
    />
  );

  if (editing) {
    return (
      <div className="flex flex-col items-end">
        <div className="w-full rounded-card border border-border bg-surface-2 p-2">
          <textarea
            ref={areaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                if (draft.trim()) setConfirm("edit");
              }
            }}
            rows={Math.min(12, Math.max(2, draft.split("\n").length))}
            className="w-full resize-none bg-transparent px-2 py-1.5 text-[15px] leading-relaxed text-text outline-none"
          />
          <div className="flex justify-end gap-2 px-1 pt-1">
            <button
              onClick={() => setEditing(false)}
              className="rounded-input px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface hover:text-text"
            >
              {t("message.editing.cancel")}
            </button>
            <button
              onClick={() => draft.trim() && setConfirm("edit")}
              disabled={!draft.trim()}
              className="rounded-input bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:opacity-90 disabled:opacity-40"
            >
              {t("message.editing.send")}
            </button>
          </div>
        </div>
        {confirmDialog}
      </div>
    );
  }

  return (
    <div {...{ [HOVER_HOST]: "" }} className="flex flex-col items-end">
      <div className="w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-card bg-surface-2 px-4 py-2.5 text-[15px] leading-relaxed text-text">
        {block.text}
      </div>
      <div
        data-hover-row
        className="flex items-center gap-0.5 pr-0.5 pt-1"
      >
        <button
          onClick={copy}
          title={copied ? t("message.copied") : t("message.copy")}
          aria-label={t("message.copy")}
          className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        {canEdit && (
          <button
            onClick={openEditor}
            title={t("message.edit")}
            aria-label={t("message.edit")}
            className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
          >
            <Pencil size={14} />
          </button>
        )}
        {canRevert && (
          <button
            onClick={() => setConfirm("revert")}
            title={t("message.revert")}
            aria-label={t("message.revert")}
            className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
          >
            <RotateCcw size={14} />
          </button>
        )}
      </div>
      {confirmDialog}
    </div>
  );
});

export const AgentMessage = memo(function AgentMessage({
  markdown,
  created,
  completed,
  usage,
  contextLimit,
  onOpenArtifact,
}: {
  markdown: string;
  /** Turn timings and token accounting, when the runtime reported them —
   *  rendered beside Copy in the hover row (see MessageMeta). */
  created?: number;
  completed?: number;
  usage?: MessageUsage;
  contextLimit?: number;
  onOpenArtifact?: (a: ArtifactBlock) => void;
}) {
  const { t } = useTranslation(["session", "common"]);
  const [copied, setCopied] = useState(false);
  // While the agent streams, `markdown` grows on every token and re-parsing the
  // whole message (react-markdown + KaTeX) each time is the main live CPU cost
  // (#50). Throttle to the trailing value so the parse runs a bounded number of
  // times per second; a finished message settles immediately and stays put.
  const shown = useThrottledValue(markdown, 90);
  // Files the agent mentions (e.g. a PDF produced by running code) become clickable.
  // Each mention is resolved to a real workspace path first — prose often names a
  // bare filename ("index.html") whose file lives in a subdirectory; mentions of
  // files that don't exist get no chip.
  const mentioned = onOpenArtifact ? extractArtifactRefs(shown) : [];
  const [refs, setRefs] = useState<string[]>([]);
  const mentionedKey = mentioned.join("\n");
  useEffect(() => {
    let cancelled = false;
    if (!mentionedKey) {
      setRefs([]);
      return;
    }
    void Promise.all(mentionedKey.split("\n").map((p) => resolveArtifactPath(p).catch(() => null))).then(
      (resolved) => {
        if (cancelled) return;
        setRefs([...new Set(resolved.filter((p): p is string => p !== null))]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [mentionedKey]);

  const copy = async () => {
    try {
      await copyText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("message.copyFailed"));
    }
  };

  return (
    // Marked so a text selection inside an ANSWER (never a tool log or the
    // user's own message) can offer follow-up actions — see SelectionActions.
    <div {...{ [HOVER_HOST]: "" }} data-agent-message>
      <MarkdownViewer>{shown}</MarkdownViewer>
      {refs.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {refs.map((path) => (
            <button
              key={path}
              onClick={() => onOpenArtifact?.(refToArtifactBlock(path))}
              className="flex items-center gap-1.5 rounded-input border border-border bg-surface px-2 py-1 text-xs text-text hover:bg-surface-2"
              title={t("agentMessage.previewTitle", { path })}
            >
              <Paperclip size={12} className="text-accent" />
              <span className="font-mono">{path.split(/[\\/]/).pop()}</span>
            </button>
          ))}
        </div>
      )}
      <div
        data-hover-row
        className="flex min-w-0 items-center gap-1.5 pt-1"
      >
        <button
          onClick={copy}
          title={copied ? t("message.copied") : t("message.copy")}
          aria-label={t("message.copy")}
          className="shrink-0 rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <MessageMeta
          created={created}
          completed={completed}
          usage={usage}
          contextLimit={contextLimit}
        />
      </div>
    </div>
  );
});

export const DataTable = memo(function DataTable({ block }: { block: DataTableBlock }) {
  return (
    // `overflow-y-hidden`: a lone `overflow-x` makes the other axis `auto` too,
    // and the scrollbar's own height then made this card eat vertical wheel
    // events that belonged to the conversation. The marker hands WebKit's
    // latched trackpad gestures back as well (lib/wheelChain).
    <div
      {...{ [HSCROLL_ATTR]: "" }}
      className="overflow-x-auto overflow-y-hidden rounded-card border border-border bg-surface shadow-card"
    >
      {block.caption && (
        <div className="border-b border-border px-4 py-2 text-xs text-muted">{block.caption}</div>
      )}
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-muted">
            {block.columns.map((c) => (
              <th key={c} className="px-4 py-2 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, i) => (
            <tr key={i} className="border-b border-border/60 last:border-0">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={cn(
                    "px-4 py-2 text-text",
                    j === row.length - 1 && "font-mono text-[13px] text-link",
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

export const RunningJobsOverlay = memo(function RunningJobsOverlay({
  block,
}: {
  block: RunningJobsBlock;
}) {
  return (
    <div className="rounded-card border border-border bg-surface shadow-card">
      <div className="border-b border-border px-4 py-2 text-xs font-medium uppercase tracking-wider text-muted">
        {block.title}
      </div>
      <ul className="divide-y divide-border/60">
        {block.jobs.map((j, i) => (
          <li key={i} className="flex items-center gap-2 px-4 py-2 text-sm">
            <RunningDot className="text-accent" />
            <span className="flex-1 truncate text-text">{j.label}</span>
            <span className="text-xs text-muted">{j.elapsed}</span>
          </li>
        ))}
      </ul>
    </div>
  );
});

const TONE: Record<NonNullable<StatusLineBlock["tone"]>, string> = {
  running: "text-accent",
  done: "text-ok",
  review: "text-muted",
  error: "text-error",
};

export const StatusLine = memo(function StatusLine({ block }: { block: StatusLineBlock }) {
  return (
    <div className={cn(block.divider && "border-t border-border pt-4")}>
      <div className={cn("flex items-center gap-2 text-sm", TONE[block.tone ?? "review"])}>
        <Loader2
          size={14}
          className={cn(block.tone === "running" && "animate-spin", block.tone !== "running" && "hidden")}
        />
        <span>{block.text}</span>
      </div>
    </div>
  );
});

// A session whose stored history the model can no longer be sent (#114). The
// error line above already said retrying cannot work; this says what is broken
// and offers the only thing that clears it. It sits under the error rather than
// replacing it, because the two answer different questions ("why did this fail"
// / "what do I do now"), and it is a quiet bordered card, not another red line —
// the failure has been reported once already, and a second alarm reads as two
// problems. The rollback discards messages and rolls back files, so it confirms
// through the same dialog as Revert, naming the count first.
export const HistoryRepair = memo(function HistoryRepair({
  block,
  onRevert,
}: {
  block: HistoryRepairBlock;
  onRevert?: (messageID: string, text: string) => void | Promise<void>;
}) {
  const { t } = useTranslation(["session", "common"]);
  const [confirming, setConfirming] = useState(false);
  const target = block.target;
  const canRepair = !!onRevert && !!target;

  return (
    <div className="rounded-card border border-border bg-surface-2/50 p-3 text-sm">
      <div className="flex items-start gap-2">
        <Wrench size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-text">
            {block.reason
              ? t(`historyRepair.reason.${block.reason}`, {
                  tool: block.tool || t("historyRepair.someTool"),
                })
              : t("historyRepair.reason.unknown")}
          </p>
          <p className="mt-1 text-muted">
            {canRepair
              ? t("historyRepair.offer", { count: block.drops ?? 0 })
              : t("historyRepair.noTarget")}
          </p>
          {canRepair && (
            <button
              className="mt-2.5 rounded-input border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-2"
              onClick={() => setConfirming(true)}
            >
              {t("historyRepair.action")}
            </button>
          )}
        </div>
      </div>
      {confirming && target && (
        <ConfirmDialog
          title={t("historyRepair.confirm.title")}
          body={t("historyRepair.confirm.body", { count: block.drops ?? 0 })}
          confirmLabel={t("historyRepair.confirm.action")}
          onConfirm={() => {
            setConfirming(false);
            void onRevert?.(target.messageID, target.text);
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
});
