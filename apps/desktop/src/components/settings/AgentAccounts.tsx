import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, ExternalLink, Loader2, Plus, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { openExternal } from "@/lib/tauri";
import type { CliAgent } from "@/lib/cliAgents";
import {
  accountKindOf,
  accountLabel,
  linkIn,
  startLogin,
  useAccountsStore,
  type AccountKind,
  type LoginResult,
} from "@/lib/agentAccounts";

/**
 * The accounts one agent runs as, under its row in Settings → Agents.
 *
 * A short list to choose from: the agent's own login first, then the accounts
 * added here. The one chosen is where a new conversation on this agent starts;
 * the composer can still pick another for each new conversation.
 */
export function AgentAccounts({ agent }: { agent: CliAgent }) {
  const kind = accountKindOf(agent.id);
  if (!kind) return null;
  return <AccountsList kind={kind} agentId={agent.id} agentName={agent.name} />;
}

function AccountsList({ kind, agentId, agentName }: { kind: AccountKind; agentId: string; agentName: string }) {
  const { t } = useTranslation(["settings", "common"]);
  const view = useAccountsStore((s) => s.byKind[kind]);
  const chosen = useAccountsStore((s) => s.defaults[agentId] ?? null);
  const load = useAccountsStore((s) => s.load);
  const remove = useAccountsStore((s) => s.remove);
  const setDefault = useAccountsStore((s) => s.setDefault);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void load(kind).catch(() => {});
  }, [kind, load]);

  const rows = [
    {
      id: null as string | null,
      label: view === undefined ? t("accounts.reading") : view.default ? accountLabel(view.default, agentName) : t("accounts.defaultSignedOut"),
      detail: [planName(view?.default?.plan), t("accounts.ownLogin")].filter(Boolean).join(" · "),
    },
    ...(view?.accounts ?? []).map((a) => ({ id: a.id as string | null, label: accountLabel(a, a.id), detail: planName(a.plan) })),
  ];

  return (
    <div className="ml-11 mr-4 mb-3 border-l border-faint pl-3">
      <div role="radiogroup" aria-label={t("accounts.title", { agent: agentName })}>
        {rows.map((row) => {
          const selected = chosen === row.id;
          return (
            <div key={row.id ?? "own"} className="group flex h-8 items-center gap-2.5">
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setDefault(agentId, row.id)}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              >
                <span
                  className={cn(
                    "h-3 w-3 shrink-0 rounded-full border transition-colors",
                    selected ? "border-[4px] border-accent" : "border-border",
                  )}
                />
                <span className={cn("min-w-0 truncate text-[13px]", selected ? "text-text" : "text-text/80")}>
                  {row.label}
                </span>
                {row.detail && <span className="shrink-0 text-xs text-muted">{row.detail}</span>}
              </button>
              {row.id && (
                <button
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-input text-muted opacity-0 transition-colors hover:text-error focus-visible:opacity-100 group-hover:opacity-100"
                  aria-label={t("accounts.remove")}
                  title={t("accounts.remove")}
                  onClick={() => {
                    if (!window.confirm(t("accounts.removeConfirm", { account: row.label }))) return;
                    void remove(kind, row.id!).catch((err) => toast.error(String(err)));
                  }}
                >
                  <X size={13} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {adding ? (
        <SignIn
          kind={kind}
          agentName={agentName}
          onClose={(added) => {
            setAdding(false);
            void load(kind).catch(() => {});
            if (added) toast.success(t("accounts.added", { account: added }));
          }}
        />
      ) : (
        <button
          className="mt-1 flex h-7 items-center gap-1.5 text-xs text-accent hover:underline"
          onClick={() => setAdding(true)}
        >
          <Plus size={12} />
          {t("accounts.add")}
        </button>
      )}
    </div>
  );
}

type Phase =
  | { name: "starting" }
  | { name: "ready" }
  | { name: "verifying" }
  | { name: "failed"; result: LoginResult };

/**
 * Adding an account, in two steps: open the sign-in link, then paste the code
 * the page shows (Claude Code) or finish in the browser (Codex).
 *
 * The panel stays until the agent answers: "verifying" while a pasted code is
 * checked, and on a failure it says why and offers to start again, rather than
 * vanishing into a toast.
 */
function SignIn({
  kind,
  agentName,
  onClose,
}: {
  kind: AccountKind;
  agentName: string;
  onClose: (added?: string) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [phase, setPhase] = useState<Phase>({ name: "starting" });
  const [link, setLink] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const session = useRef<Awaited<ReturnType<typeof startLogin>> | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const lastSaid = useRef("");

  useEffect(() => {
    let live = true;
    let ended = false;
    setPhase({ name: "starting" });
    setLink(null);
    setCode("");
    setCodeError(null);
    void startLogin(kind, {
      onLine: (line) => {
        if (!live) return;
        const found = linkIn(line);
        if (found) {
          setLink((prev) => prev ?? found);
          setPhase((p) => (p.name === "starting" ? { name: "ready" } : p));
          return;
        }
        // Asked for the code again after one was sent: that one was refused.
        if (line.endsWith(">") && phaseRef.current.name === "verifying") {
          setCodeError(lastSaid.current || t("accounts.codeRefused"));
          setPhase({ name: "ready" });
          return;
        }
        if (!line.endsWith(">")) lastSaid.current = line;
      },
      onDone: (result) => {
        ended = true;
        if (!live) return;
        if (result.account) onClose(accountLabel(result.account, result.account.id));
        else setPhase({ name: "failed", result });
      },
    })
      .then((s) => {
        if (!live) void s.cancel();
        else session.current = s;
      })
      .catch((err) => {
        if (live) setPhase({ name: "failed", result: { error: "failed", detail: String(err) } });
      });
    return () => {
      live = false;
      if (!ended) void session.current?.cancel();
      session.current = null;
    };
    // One sign-in per attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, attempt]);

  const copyLink = useCallback(async () => {
    if (!link) return;
    try {
      await copyText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error(t("agents.copyFailed"));
    }
  }, [link, t]);

  const submit = () => {
    const value = code.trim();
    if (!value || !session.current || phase.name !== "ready") return;
    setCodeError(null);
    setPhase({ name: "verifying" });
    void session.current.input(value).catch(() => setPhase({ name: "ready" }));
  };

  const failed = phase.name === "failed" ? phase.result : null;

  return (
    <div className="mt-2 space-y-4 pb-1 pt-2">
      <div className="flex items-baseline gap-3">
        <span className="flex-1 text-[13px] font-medium text-text">{t("accounts.addTitle", { agent: agentName })}</span>
        <button className="text-xs text-muted hover:text-text" onClick={() => onClose()}>
          {t("common:actions.cancel")}
        </button>
      </div>

      {failed ? (
        <div className="space-y-2.5">
          <p className="text-[13px] leading-relaxed text-error">
            {failed.error === "duplicate-default"
              ? t("accounts.error.duplicateDefault", { account: failed.detail ?? "" })
              : failed.error === "duplicate"
                ? t("accounts.error.duplicate", { account: failed.detail ?? "" })
                : failed.error === "not-signed-in"
                  ? failed.detail
                    ? t("accounts.error.notSignedInSaid", { said: failed.detail })
                    : t("accounts.error.notSignedIn")
                  : t("accounts.error.failed", { detail: failed.detail ?? "" })}
          </p>
          <button
            className="flex h-8 items-center gap-1.5 rounded-input border border-border px-3 text-[13px] text-text hover:bg-surface-2"
            onClick={() => setAttempt((n) => n + 1)}
          >
            {t("accounts.retry")}
          </button>
        </div>
      ) : (
        <>
          <Step n={1} title={t("accounts.step1")} hint={t("accounts.step1Hint")}>
            {link ? (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  className="flex h-8 items-center gap-1.5 rounded-input bg-accent px-3 text-[13px] font-medium text-accent-fg hover:bg-accent/90"
                  onClick={() => void openExternal(link)}
                >
                  <ExternalLink size={13} />
                  {t("accounts.openLink")}
                </button>
                <button
                  className="flex h-8 items-center gap-1.5 rounded-input border border-border px-3 text-[13px] text-text hover:bg-surface-2"
                  onClick={() => void copyLink()}
                >
                  {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
                  {copied ? t("accounts.copied") : t("accounts.copyLink")}
                </button>
              </div>
            ) : (
              <p className="flex items-center gap-2 text-xs text-muted">
                <Loader2 size={12} className="animate-spin" />
                {t("accounts.preparing")}
              </p>
            )}
          </Step>

          {kind === "claude" ? (
            <Step n={2} title={t("accounts.step2Code")} dim={!link}>
              <div className="flex gap-2">
                <input
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value);
                    setCodeError(null);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && submit()}
                  placeholder={t("accounts.codePlaceholder")}
                  aria-label={t("accounts.codePlaceholder")}
                  disabled={!link || phase.name === "verifying"}
                  spellCheck={false}
                  className="h-8 min-w-0 flex-1 rounded-input border border-border bg-surface px-2.5 font-mono text-xs text-text outline-none focus:border-accent disabled:text-muted"
                />
                <button
                  className="flex h-8 shrink-0 items-center gap-1.5 rounded-input bg-accent px-3 text-[13px] font-medium text-accent-fg hover:bg-accent/90 disabled:bg-accent/50"
                  onClick={submit}
                  disabled={!code.trim() || phase.name !== "ready"}
                >
                  {phase.name === "verifying" && <Loader2 size={13} className="animate-spin" />}
                  {phase.name === "verifying" ? t("accounts.verifying") : t("accounts.finish")}
                </button>
              </div>
              {codeError && <p className="mt-1.5 text-xs text-error">{codeError}</p>}
            </Step>
          ) : (
            <Step n={2} title={t("accounts.step2Browser")} dim={!link}>
              {link && (
                <p className="flex items-center gap-2 text-xs text-muted">
                  <Loader2 size={12} className="animate-spin" />
                  {t("accounts.waiting")}
                </p>
              )}
            </Step>
          )}
          <p className="text-[11px] leading-relaxed text-muted">{t("accounts.sharedHint")}</p>
        </>
      )}
    </div>
  );
}

function Step({
  n,
  title,
  hint,
  dim = false,
  children,
}: {
  n: number;
  title: string;
  hint?: string;
  dim?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("flex gap-3", dim && "text-muted")}>
      <span className="mt-px w-3 shrink-0 text-xs tabular-nums text-muted">{n}</span>
      <div className="min-w-0 flex-1 space-y-2">
        <div>
          <div className={cn("text-[13px]", dim ? "text-muted" : "text-text")}>{title}</div>
          {hint && <div className="mt-0.5 text-xs leading-relaxed text-muted">{hint}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

/** `max` → `Max`: the agents report plan names in lower case. */
function planName(plan: string | undefined): string {
  return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : "";
}
