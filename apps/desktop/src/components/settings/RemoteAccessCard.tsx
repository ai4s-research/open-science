import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Eye, EyeOff, Globe, Laptop, Plug, RefreshCw, ShieldAlert } from "lucide-react";
import { Row, Section, Switch } from "@/components/settings/Section";
import { chipCls } from "@/components/settings/inputCls";
import { toast } from "@/lib/toast";
import {
  acpServerScript,
  getGatewayStatus,
  isTauri,
  regenerateGatewayToken,
  setGatewayConfig,
  type GatewayMode,
  type GatewayStatus,
} from "@/lib/tauri";

/** Settings → Remote Access. Turns the desktop into an authenticated API
 *  gateway (loopback by default; LAN opt-in) that CLI / phone / tunnel clients
 *  drive. See docs/rfc/remote-access-gateway.md. */
export function RemoteAccessCard() {
  const { t } = useTranslation(["settings", "common"]);
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);
  /** The port field, empty until the user types one. Up here with the other
   *  hooks, not beside the port Row: everything below the `isTauri` early
   *  return runs conditionally, and a hook there breaks the hook order. */
  const [portInput, setPortInput] = useState<string>("");
  /** Where the bundled ACP agent lives, so the editor snippet is a real path
   *  the user can paste (#14, server direction). */
  const [acpScript, setAcpScript] = useState<string | null>(null);
  useEffect(() => {
    void acpServerScript().then(setAcpScript);
  }, []);

  const refresh = useCallback(() => {
    void getGatewayStatus().then(setStatus);
  }, []);
  useEffect(refresh, [refresh]);

  const apply = (fn: () => Promise<GatewayStatus | null>) => {
    if (busy) return;
    setBusy(true);
    void (async () => {
      try {
        const next = await fn();
        if (next) setStatus(next);
        else refresh();
      } catch (e) {
        toast.error(`${t("remote.error")}: ${String(e)}`);
      } finally {
        setBusy(false);
      }
    })();
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    toast.success(t("remote.copied"));
  };

  if (!isTauri) return null;

  const enabled = status?.enabled ?? false;
  const lan = status?.lan ?? false;
  const mode: GatewayMode = status?.mode ?? "full";

  const configuredPort = status?.configuredPort ?? null;

  const setEnabled = (v: boolean) => apply(() => setGatewayConfig(v, lan, mode, configuredPort));
  const setMode = (m: GatewayMode) => apply(() => setGatewayConfig(true, lan, m, configuredPort));
  const setLan = (v: boolean) => {
    if (v && !window.confirm(t("remote.lanWarn"))) return;
    apply(() => setGatewayConfig(true, v, mode, configuredPort));
  };

  const applyPort = () => {
    const n = portInput.trim() === "" ? null : Number(portInput);
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 65535)) {
      toast.error(t("remote.portInvalid"));
      return;
    }
    apply(() => setGatewayConfig(true, lan, mode, n));
    setPortInput("");
  };

  // Copy the URL with the token in the hash, so opening the link on another
  // device connects with no manual token entry (the SPA reads #token= on load).
  const linkWithToken = (u: string | null) =>
    u && status?.token ? `${u}/#token=${encodeURIComponent(status.token)}` : u;

  return (
    <Section title={t("remote.title")} hint={t("remote.hint")} flush>
      <div className="divide-y divide-faint">
        <Row
          title={t("remote.enable")}
          hint={t("remote.enableHint")}
          control={<Switch checked={enabled} onChange={setEnabled} label={t("remote.enable")} />}
        />

        {enabled && (
          <>
            {/* Access URLs — the thing you actually open on another device. */}
            <Row title={t("remote.loopbackUrl")} hint={t("remote.loopbackUrlHint")}>
              <UrlLine
                url={status?.loopbackUrl ?? null}
                copyValue={linkWithToken(status?.loopbackUrl ?? null)}
                onCopy={copy}
                copyLabel={t("remote.copy")}
                icon={<Laptop size={13} />}
              />
            </Row>

            <Row
              title={t("remote.binding")}
              hint={t("remote.bindingHint")}
              control={
                <select
                  className={chipCls("shrink-0")}
                  value={lan ? "lan" : "loopback"}
                  disabled={busy}
                  onChange={(e) => setLan(e.target.value === "lan")}
                >
                  <option value="loopback">{t("remote.bindingLoopback")}</option>
                  <option value="lan">{t("remote.bindingLan")}</option>
                </select>
              }
            >
              {lan && (
                <div className="mt-2.5">
                  <UrlLine
                    url={status?.lanUrl ?? null}
                    copyValue={linkWithToken(status?.lanUrl ?? null)}
                    onCopy={copy}
                    copyLabel={t("remote.copy")}
                    icon={<Globe size={13} />}
                  />
                  <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-amber-500 dark:text-amber-400">
                    <ShieldAlert size={13} className="mt-0.5 shrink-0" />
                    {t("remote.lanActive")}
                  </p>
                </div>
              )}
            </Row>

            {/* Port configuration. */}
            <Row title={t("remote.port")} hint={t("remote.portHint")}>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={65535}
                  placeholder={String(status?.port ?? 4098)}
                  value={portInput}
                  onChange={(e) => setPortInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && applyPort()}
                  disabled={busy}
                  className={chipCls("w-24 shrink-0")}
                />
                <button
                  type="button"
                  className={chipCls("shrink-0")}
                  disabled={busy || portInput.trim() === ""}
                  onClick={applyPort}
                >
                  {t("remote.portApply")}
                </button>
                {configuredPort && (
                  <button
                    type="button"
                    className="rounded-input p-2 text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
                    disabled={busy}
                    onClick={() => apply(() => setGatewayConfig(true, lan, mode, null))}
                    title={t("remote.portReset")}
                  >
                    <RefreshCw size={14} />
                  </button>
                )}
              </div>
            </Row>

            {/* Access mode = the token's ceiling. */}
            <Row
              title={t("remote.mode")}
              hint={mode === "full" ? t("remote.modeFullHint") : t("remote.modeReadonlyHint")}
              control={
                <select
                  className={chipCls("shrink-0")}
                  value={mode}
                  disabled={busy}
                  onChange={(e) => setMode(e.target.value as GatewayMode)}
                >
                  <option value="full">{t("remote.modeFull")}</option>
                  <option value="read-only">{t("remote.modeReadonly")}</option>
                </select>
              }
            />

            {/* Bearer token. */}
            <Row title={t("remote.token")} hint={t("remote.tokenHint")}>
              <div className="mt-2.5 flex items-center gap-2">
                <code className="flex-1 truncate rounded-input bg-surface-2 px-3 py-2 font-mono text-[12.5px] text-text">
                  {reveal ? status?.token || "—" : "•".repeat(Math.min(status?.token?.length ?? 24, 40))}
                </code>
                <button
                  type="button"
                  className="rounded-input p-2 text-muted transition-colors hover:bg-surface-2 hover:text-text"
                  aria-label={reveal ? t("remote.hide") : t("remote.reveal")}
                  title={reveal ? t("remote.hide") : t("remote.reveal")}
                  onClick={() => setReveal((v) => !v)}
                >
                  {reveal ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
                <button
                  type="button"
                  className="rounded-input p-2 text-muted transition-colors hover:bg-surface-2 hover:text-text"
                  aria-label={t("remote.copy")}
                  title={t("remote.copy")}
                  onClick={() => status?.token && void copy(status.token)}
                >
                  <Copy size={15} />
                </button>
                <button
                  type="button"
                  className="rounded-input p-2 text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
                  aria-label={t("remote.regenerate")}
                  title={t("remote.regenerate")}
                  disabled={busy}
                  onClick={() =>
                    apply(async () => {
                      const s = await regenerateGatewayToken();
                      toast.success(t("remote.regenerated"));
                      return s;
                    })
                  }
                >
                  <RefreshCw size={15} />
                </button>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted">{t("remote.openHint")}</p>
            </Row>

            {/* External editors (ACP): the agent entry to paste into Zed,
                JetBrains, Neovim — anything that drives an ACP agent (#14). */}
            {acpScript && status?.loopbackUrl && (
              <Row title={t("remote.acpTitle")} hint={t("remote.acpHint")}>
                <div className="mt-2.5 flex items-start gap-2">
                  <span className="mt-2 text-muted">
                    <Plug size={13} />
                  </span>
                  <pre className="min-w-0 flex-1 overflow-x-auto rounded-input bg-surface-2 px-3 py-2 font-mono text-[12px] leading-relaxed text-text">
{/* eslint-disable-next-line i18next/no-literal-string -- the placeholder inside a JSON snippet the user pastes verbatim; translating it would break the config */}
                    {acpAgentEntry(acpScript, status.loopbackUrl, reveal ? status.token : "<token>")}
                  </pre>
                  <button
                    type="button"
                    className="mt-1 rounded-input p-2 text-muted transition-colors hover:bg-surface-2 hover:text-text"
                    aria-label={t("remote.copy")}
                    title={t("remote.copy")}
                    onClick={() =>
                      void copy(acpAgentEntry(acpScript, status.loopbackUrl!, status.token))
                    }
                  >
                    <Copy size={15} />
                  </button>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted">{t("remote.acpNodeHint")}</p>
              </Row>
            )}
          </>
        )}
      </div>
    </Section>
  );
}

/**
 * The agent entry an ACP client takes: a command, its arguments, and the token
 * in the ENVIRONMENT rather than on the command line — an argument list is
 * visible to every process on the machine, and this token is full access to the
 * workspace.
 *
 * The shape (command / args / env) is what ACP clients configure custom agents
 * with; the JSON here is Zed's `agent_servers` entry, which the others read
 * closely enough to adapt.
 */
function acpAgentEntry(script: string, url: string, token: string): string {
  return JSON.stringify(
    {
      agent_servers: {
        "Open Science": {
          command: "node",
          args: [script, "--url", url],
          env: { OPENSCIENCE_GATEWAY_TOKEN: token },
        },
      },
    },
    null,
    2,
  );
}

function UrlLine({
  url,
  onCopy,
  copyLabel,
  copyValue,
  icon,
}: {
  url: string | null;
  onCopy: (text: string) => void;
  copyLabel: string;
  /** What the copy button copies (defaults to the shown URL) — e.g. the URL
   *  with the token in the hash, so the link connects with no token entry. */
  copyValue?: string | null;
  icon: React.ReactNode;
}) {
  if (!url) return <div className="text-xs text-muted">—</div>;
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted">{icon}</span>
      <code className="flex-1 truncate rounded-input bg-surface-2 px-3 py-2 font-mono text-[12.5px] text-text">
        {url}
      </code>
      <button
        type="button"
        className="rounded-input p-2 text-muted transition-colors hover:bg-surface-2 hover:text-text"
        onClick={() => onCopy(copyValue ?? url)}
        aria-label={copyLabel}
      >
        <Copy size={15} />
      </button>
    </div>
  );
}
