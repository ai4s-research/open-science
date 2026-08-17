import { useState } from "react";
import { Check, HelpCircle, Pencil, ShieldQuestion } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PermissionAskedEvent, PermissionReply, QuestionAskedEvent } from "@ai4s/sdk";
import { cn } from "@/lib/cn";

/**
 * The answerable surface for an agent request that blocks the run — a
 * `question` (pick options) or a `permission` (approve an action). Without
 * this, the agent's `question`/`permission` tool sits forever and the session
 * looks stuck. Rendered just above the composer for the current session.
 */
export function InteractionPrompt({
  question,
  permission,
  origin,
  onAnswer,
  onReject,
  onPermission,
}: {
  question?: QuestionAskedEvent;
  permission?: PermissionAskedEvent;
  /** Who is asking, when it isn't the main agent — a subagent session's title. */
  origin?: string;
  onAnswer: (requestId: string, answers: string[][]) => void;
  onReject: (requestId: string) => void;
  onPermission: (requestId: string, reply: PermissionReply) => void;
}) {
  if (question) {
    return (
      <QuestionCard
        key={question.requestId}
        question={question}
        origin={origin}
        onAnswer={onAnswer}
        onReject={onReject}
      />
    );
  }
  if (permission) {
    return (
      <PermissionCard
        key={permission.requestId}
        permission={permission}
        origin={origin}
        onReply={onPermission}
      />
    );
  }
  return null;
}

/** "external_directory" → "external directory" — readable, still explicit. */
const actionLabel = (action: string) => action.replace(/[_-]+/g, " ");

function QuestionCard({
  question,
  origin,
  onAnswer,
  onReject,
}: {
  question: QuestionAskedEvent;
  origin?: string;
  onAnswer: (requestId: string, answers: string[][]) => void;
  onReject: (requestId: string) => void;
}) {
  const { t } = useTranslation(["session", "common"]);
  // One selection set + one custom string per question.
  const [selected, setSelected] = useState<Record<number, Set<string>>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});
  // Which questions have their own-words field open. Every question can always
  // be answered in the user's own words: a model that offers an "Other" option
  // but forgets `custom` used to leave nowhere to say WHAT — and in quick-pick
  // that answered the whole question with the bare word "Other".
  const [ownWords, setOwnWords] = useState<Record<number, boolean>>({});

  const items = question.questions;
  const toggle = (qi: number, label: string, multiple: boolean) =>
    setSelected((s) => {
      const cur = new Set(multiple ? (s[qi] ?? []) : []);
      if (cur.has(label)) cur.delete(label);
      else cur.add(label);
      return { ...s, [qi]: cur };
    });

  /** Open the own-words field. Single-select questions drop their pick, the way
   *  choosing any other option would. */
  const openOwnWords = (qi: number, multiple: boolean) => {
    setOwnWords((o) => ({ ...o, [qi]: true }));
    if (!multiple) setSelected((s) => ({ ...s, [qi]: new Set() }));
  };

  const answerFor = (qi: number): string[] => {
    const picked = [...(selected[qi] ?? [])];
    const c = custom[qi]?.trim();
    // The typed text IS the answer — never the label of the row that revealed
    // the field, which would tell the agent nothing.
    return c ? [...picked, c] : picked;
  };
  const ready = items.every((_, qi) => answerFor(qi).length > 0);

  // Single question, single-select, no free text yet: click an option to answer
  // at once. Opening the own-words field ends quick-pick — there is now
  // something to type and a Send to press.
  const isQuickPick =
    items.length === 1 && !items[0].multiple && !items[0].custom && !ownWords[0];

  return (
    <div className="rounded-card border border-accent/40 bg-surface shadow-card">
      <header className="border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <HelpCircle size={15} className="text-accent" />
          <span className="text-sm font-medium text-text">{t("interaction.question.heading")}</span>
          <button
            className="ml-auto text-xs text-muted hover:text-text"
            onClick={() => onReject(question.requestId)}
          >
            {t("interaction.skip")}
          </button>
        </div>
        {origin && (
          <div className="mt-0.5 pl-6 text-xs text-muted">{t("interaction.askedBy", { origin })}</div>
        )}
      </header>

      <div className="max-h-[45vh] space-y-4 overflow-y-auto px-4 py-3.5">
        {items.map((it, qi) => {
          const multiple = !!it.multiple;
          return (
            <div key={qi} className="space-y-2">
              <div className="text-sm text-text">{it.question}</div>
              <div className="flex flex-col gap-1.5">
                {it.options.map((opt) => {
                  const on = selected[qi]?.has(opt.label) ?? false;
                  const act = () =>
                    isQuickPick
                      ? onAnswer(question.requestId, [[opt.label]])
                      : toggle(qi, opt.label, multiple);
                  return (
                    <button
                      key={opt.label}
                      onClick={act}
                      className={cn(
                        "flex items-start gap-2.5 rounded-input border px-3 py-2 text-left transition-colors",
                        on
                          ? "border-accent bg-accent/10"
                          : "border-border bg-surface hover:bg-surface-2",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border",
                          on ? "border-accent bg-accent text-accent-fg" : "border-muted/50",
                        )}
                      >
                        {on && <Check size={11} strokeWidth={3} />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium text-text">{opt.label}</span>
                        {opt.description && (
                          <span className="mt-0.5 block text-xs leading-snug text-muted">
                            {opt.description}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
                {/* The guaranteed escape hatch. Hidden behind a row so a
                    question with good options stays a clean list, but always
                    one click away — the agent asking cannot take it away by
                    forgetting a flag. Skipped when it already asked for free
                    text, which shows the field outright. */}
                {!it.custom && !ownWords[qi] && (
                  <button
                    onClick={() => openOwnWords(qi, multiple)}
                    className="flex items-center gap-2.5 rounded-input border border-dashed border-border px-3 py-2 text-left text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-text"
                  >
                    <Pencil size={13} className="shrink-0" />
                    {t("interaction.question.other")}
                  </button>
                )}
              </div>
              {(it.custom || ownWords[qi]) && (
                <input
                  autoFocus={!!ownWords[qi]}
                  value={custom[qi] ?? ""}
                  onChange={(e) => setCustom((c) => ({ ...c, [qi]: e.target.value }))}
                  placeholder={t("interaction.question.customPlaceholder")}
                  className="w-full rounded-input border border-border bg-surface px-3 py-2 text-[13px] text-text outline-none placeholder:text-muted focus:border-accent/60"
                />
              )}
            </div>
          );
        })}
      </div>

      {!isQuickPick && (
        <footer className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
          <button
            className="rounded-input px-3 py-1.5 text-xs text-muted hover:text-text"
            onClick={() => onReject(question.requestId)}
          >
            {t("interaction.skip")}
          </button>
          <button
            disabled={!ready}
            onClick={() => onAnswer(question.requestId, items.map((_, qi) => answerFor(qi)))}
            className="rounded-input bg-accent px-3.5 py-1.5 text-xs font-medium text-accent-fg hover:opacity-90 disabled:opacity-40"
          >
            {t("interaction.submit")}
          </button>
        </footer>
      )}
    </div>
  );
}

function PermissionCard({
  permission,
  origin,
  onReply,
}: {
  permission: PermissionAskedEvent;
  origin?: string;
  onReply: (requestId: string, reply: PermissionReply) => void;
}) {
  const { t } = useTranslation(["session", "common"]);
  return (
    <div className="rounded-card border border-warn/40 bg-surface shadow-card">
      <header className="border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <ShieldQuestion size={15} className="text-warn" />
          <span className="text-sm font-medium text-text">
            {t("interaction.permission.heading")}{" "}
            <span className="font-mono">{actionLabel(permission.action)}</span>
          </span>
        </div>
        {origin && (
          <div className="mt-0.5 pl-6 text-xs text-muted">{t("interaction.askedBy", { origin })}</div>
        )}
      </header>
      {permission.resources.length > 0 && (
        <div className="px-4 py-3">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-input border border-border bg-surface-2 px-3 py-2 font-mono text-[12px] text-text">
            {permission.resources.join("\n")}
          </pre>
        </div>
      )}
      <footer className="flex items-center gap-2 border-t border-border px-4 py-2.5">
        <button
          className="rounded-input px-3 py-1.5 text-xs text-error hover:bg-error/10"
          onClick={() => onReply(permission.requestId, "reject")}
        >
          {t("interaction.reject")}
        </button>
        <div className="flex-1" />
        <button
          className="rounded-input border border-border px-3 py-1.5 text-xs text-text hover:bg-surface-2"
          onClick={() => onReply(permission.requestId, "always")}
        >
          {t("interaction.alwaysAllow")}
        </button>
        <button
          className="rounded-input bg-accent px-3.5 py-1.5 text-xs font-medium text-accent-fg hover:opacity-90"
          onClick={() => onReply(permission.requestId, "once")}
        >
          {t("interaction.allowOnce")}
        </button>
      </footer>
    </div>
  );
}
