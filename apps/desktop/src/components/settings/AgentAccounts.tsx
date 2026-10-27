import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Loader2, Plus, Trash2 } from "lucide-react";
import { inputCls } from "./inputCls";
import { cn } from "@/lib/cn";
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
} from "@/lib/agentAccounts";

/**
 * The accounts one agent can run as, under its row in Settings → Agents: its
 * own login (the default), the ones added here, and the way to add another.
 *
 * Adding one runs the agent's own sign-in in a new folder. The browser usually
 * opens by itself; the link is shown too, because a second account is signed in
 * from a private window or another browser, where the first one is not.
 */
export function AgentAccounts({ agent }: { agent: CliAgent }) {
  const kind = accountKindOf(agent.id);
  if (!kind) return null;
  return <AccountsList kind={kind} agentName={agent.name} />;
}

function AccountsList({ kind, agentName }: { kind: AccountKind; agentName: string }) {
  const { t } = useTranslation(["settings", "common"]);
  const view = useAccountsStore((s) => s.byKind[kind]);
  const load = useAccountsStore((s) => s.load);
  const remove = useAccountsStore((s) => s.remove);
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    void load(kind).catch(() => {});
  }, [kind, load]);

  return (
    <div className="space-y-1.5 pb-3 pl-11 pr-4">
      <div className="flex items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate text-text">
          {view === undefined
            ? t("accounts.reading")
            : view.default
              ? accountLabel(view.default, agentName)
              : t("accounts.defaultSignedOut")}
        </span>
        <span className="shrink-0 text-muted">
          {[view?.default?.plan, t("accounts.default")].filter(Boolean).join(" · ")}
        </span>
      </div>
      {view?.accounts.map((account) => (
        <div key={account.id} className="flex items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-text">{accountLabel(account, account.id)}</span>
          {account.plan && <span className="shrink-0 text-muted">{account.plan}</span>}
          <button
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-error"
            aria-label={t("accounts.remove")}
            title={t("accounts.remove")}
            onClick={() => {
              if (!window.confirm(t("accounts.removeConfirm", { account: accountLabel(account, account.id) }))) return;
              void remove(kind, account.id).catch((err) => toast.error(String(err)));
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      {signingIn ? (
        <SignIn
          kind={kind}
          onEnd={() => {
            setSigningIn(false);
            void load(kind).catch(() => {});
          }}
        />
      ) : (
        <button
          className="flex items-center gap-1.5 pt-0.5 text-xs text-accent hover:underline"
          onClick={() => setSigningIn(true)}
        >
          <Plus size={12} />
          {t("accounts.add")}
        </button>
      )}
      <p className="text-[11px] leading-relaxed text-muted">{t("accounts.sharedHint")}</p>
    </div>
  );
}

/** The sign-in in progress: the link, a field for a pasted code, Cancel. */
function SignIn({ kind, onEnd }: { kind: AccountKind; onEnd: () => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const [link, setLink] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const session = useRef<Awaited<ReturnType<typeof startLogin>> | null>(null);
  const ended = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void startLogin(kind, {
      onLine: (line) => {
        setLines((prev) => [...prev.slice(-3), line]);
        const found = linkIn(line);
        if (found) setLink((prev) => prev ?? found);
      },
      onDone: ({ account, error }) => {
        ended.current = true;
        if (account) toast.success(t("accounts.added", { account: accountLabel(account, account.id) }));
        else toast.error(error ?? t("accounts.failed"));
        onEnd();
      },
    })
      .then((s) => {
        if (cancelled) void s.cancel();
        else session.current = s;
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : String(err));
        onEnd();
      });
    return () => {
      cancelled = true;
      if (!ended.current) void session.current?.cancel();
    };
    // One sign-in per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitCode = () => {
    if (!code.trim()) return;
    void session.current?.input(code).catch((err) => toast.error(String(err)));
    setCode("");
  };

  return (
    <div className="space-y-2 rounded-input border border-faint px-3 py-2.5">
      <div className="flex items-center gap-2 text-xs text-muted">
        <Loader2 size={12} className="animate-spin" />
        <span className="flex-1">{t("accounts.waiting")}</span>
        <button
          className="text-xs text-muted hover:text-text"
          onClick={() => {
            ended.current = true;
            void session.current?.cancel();
            onEnd();
          }}
        >
          {t("common:actions.cancel")}
        </button>
      </div>
      {link && (
        <div className="space-y-1">
          <button
            className="flex items-center gap-1.5 text-xs text-accent hover:underline"
            onClick={() => void openExternal(link)}
          >
            <ExternalLink size={12} />
            {t("accounts.openLink")}
          </button>
          <p className="select-text break-all font-mono text-[11px] text-muted">{link}</p>
          <p className="text-[11px] text-muted">{t("accounts.privateHint")}</p>
        </div>
      )}
      {kind === "claude" && (
        <div className="flex gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitCode()}
            placeholder={t("accounts.codePlaceholder")}
            aria-label={t("accounts.codePlaceholder")}
            className={inputCls("flex-1 font-mono")}
            spellCheck={false}
          />
          <button
            className={cn(
              "h-8 shrink-0 rounded-input border border-border px-3 text-[13px] text-text transition-colors hover:bg-surface-2",
            )}
            onClick={submitCode}
            disabled={!code.trim()}
          >
            {t("accounts.submitCode")}
          </button>
        </div>
      )}
      {!link && lines.length > 0 && (
        <p className="select-text break-all font-mono text-[11px] text-muted">{lines[lines.length - 1]}</p>
      )}
    </div>
  );
}
