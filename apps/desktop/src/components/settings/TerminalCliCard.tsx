import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Terminal } from "lucide-react";
import { Row, Section } from "@/components/settings/Section";
import { chipCls } from "@/components/settings/inputCls";
import { toast } from "@/lib/toast";
import { getCliShimStatus, installCliShim, isTauri, type CliShimStatus } from "@/lib/tauri";

/** Where the wrapper goes. Stands in only while the backend's answer — which
 *  resolves the same path from the user's home — is still on its way. */
const DEFAULT_SHIM = "~/.local/bin/osd";

/** Settings → Remote Access → the terminal command.
 *
 *  The app installs `osd` on launch, so this card mostly REPORTS: where the
 *  command is, and what (if anything) was touched to make a terminal find it.
 *  The button is for repair — an app that moved, or a launch whose attempt
 *  failed. The line to paste appears only when nothing automatic worked. */
export function TerminalCliCard() {
  const { t } = useTranslation(["settings"]);
  const [status, setStatus] = useState<CliShimStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void getCliShimStatus().then(setStatus);
  }, []);
  useEffect(refresh, [refresh]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("remote.copied"));
    } catch {
      /* Clipboard denied: the line is on screen to copy by hand. */
    }
  };

  const install = () => {
    if (busy) return;
    setBusy(true);
    void (async () => {
      try {
        const next = await installCliShim();
        if (next) setStatus(next);
      } catch (e) {
        toast.error(`${t("cli.error")}: ${String(e)}`);
      } finally {
        setBusy(false);
      }
    })();
  };

  if (!isTauri) return null;

  const available = Boolean(status?.binary);
  /** One line saying where things stand — the state, not the mechanics. */
  const state = () => {
    if (!available) return t("cli.unavailable");
    if (status?.occupied) return t("cli.occupied");
    if (!status?.installed) return t("cli.notInstalled");
    switch (status.route) {
      case "already-on-path":
        return t("cli.readyPath");
      case "shell-profile":
        return t("cli.readyProfile", { profile: status.profile ?? "" });
      case "user-environment":
        return t("cli.readyEnvironment");
      default:
        return t("cli.unreachable");
    }
  };

  return (
    <Section title={t("cli.title")} hint={t("cli.hint")} flush>
      <Row
        title={
          <span className="inline-flex items-center gap-2">
            <Terminal size={13} className="shrink-0 text-muted" />
            <code className="font-mono text-[12.5px]">{status?.shim ?? DEFAULT_SHIM}</code>
          </span>
        }
        hint={state()}
        control={
          <button
            type="button"
            className={chipCls("shrink-0")}
            disabled={busy || !available || status?.occupied}
            onClick={install}
          >
            {status?.installed ? (
              <span className="inline-flex items-center gap-1.5">
                <Check size={13} />
                {t("cli.repair")}
              </span>
            ) : (
              t("cli.install")
            )}
          </button>
        }
      >
        {/* Only when PATH could not be arranged for them. */}
        {status?.pathHint && (
          <div className="mt-2.5 flex items-center gap-2">
            <code className="flex-1 overflow-x-auto whitespace-pre rounded-input bg-surface-2 px-3 py-2 font-mono text-[12.5px] text-text">
              {status.pathHint}
            </code>
            <button
              type="button"
              className="rounded-input p-2 text-muted transition-colors hover:bg-surface-2 hover:text-text"
              aria-label={t("remote.copy")}
              title={t("remote.copy")}
              onClick={() => void copy(status.pathHint ?? "")}
            >
              <Copy size={15} />
            </button>
          </div>
        )}
      </Row>
    </Section>
  );
}
