import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { useRuntimeStore } from "@/lib/runtime";
import { toast } from "@/lib/toast";
import { answer, decide, useSettingsRequests, type SettingsRequest } from "@/lib/settingsBridge";
import type { SettingDef, SettingValue } from "@/lib/settingsRegistry";

/**
 * An agent (or `osd` at a shell) asked to change settings. One dialog per
 * request, however many settings it names: who asked, why, and each change
 * from its value now to the one asked for — each kept or left out by the user.
 * Nothing changes until they apply; Escape declines, so the asker is not left
 * waiting on a dialog nobody will answer.
 */
export function SettingsRequestDialog() {
  const request = useSettingsRequests((s) => s.queue[0]);
  const waiting = useSettingsRequests((s) => s.queue.length - 1);
  if (!request) return null;
  return <RequestView key={request.id} request={request} waiting={waiting} />;
}

function RequestView({ request, waiting }: { request: SettingsRequest; waiting: number }) {
  const { t } = useTranslation("settings");
  const drop = useSettingsRequests((s) => s.drop);
  const asker = useRuntimeStore((s) => s.sessions.find((x) => x.id === request.from)?.title);
  const [keep, setKeep] = useState(() => new Set(request.changes.map((c) => c.def.key)));
  const [busy, setBusy] = useState(false);

  const finish = async (kept: Set<string>) => {
    setBusy(true);
    try {
      const result = await decide(request, kept);
      await answer(request.id, result);
      if (result.status === "approved") {
        const failed = Object.entries(result.failed);
        if (failed.length === 0) toast.success(t("request.applied"));
        for (const [key, error] of failed) toast.error(t("request.failed", { key, error }));
      }
    } finally {
      drop(request.id);
    }
  };
  const decline = () => void finish(new Set());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) decline();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const toggle = (key: string) =>
    setKeep((k) => {
      const next = new Set(k);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const from = request.from
    ? t("request.fromSession", { title: asker ?? request.from })
    : t("request.fromCommand");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" role="presentation">
      <div
        role="alertdialog"
        aria-label={t("request.title")}
        className="w-[460px] max-w-[calc(100%-2rem)] rounded-card border border-border bg-surface p-5 shadow-card"
      >
        <div className="text-sm font-medium text-text">{t("request.title")}</div>
        <div className="mt-0.5 text-xs text-muted">{from}</div>

        <div className="mt-4 text-xs text-muted">{t("request.reason")}</div>
        <p className="mt-1 whitespace-pre-wrap text-sm text-text">{request.reason}</p>

        <ul className="mt-4 border-t border-border">
          {request.changes.map((c) => (
            <li key={c.def.key} className="border-b border-border py-2.5">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-accent"
                  checked={keep.has(c.def.key)}
                  disabled={busy}
                  onChange={() => toggle(c.def.key)}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-sm text-text">{t(c.def.label)}</span>
                    <span className="text-xs text-muted">
                      <Value def={c.def} v={c.from} /> <span aria-hidden>→</span>{" "}
                      <span className="font-medium text-text">
                        <Value def={c.def} v={c.to} />
                      </span>
                    </span>
                  </span>
                  {c.def.sensitive && c.def.hint && (
                    <span className="mt-1 block text-xs text-warn">{t(c.def.hint)}</span>
                  )}
                  {c.def.restarts && <span className="mt-1 block text-xs text-muted">{t("request.restarts")}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>

        <div className="mt-4 flex items-center justify-end gap-2">
          {waiting > 0 && (
            <span className="mr-auto text-xs text-muted">{t("request.more", { count: waiting })}</span>
          )}
          <button
            className={cn(
              "rounded-input bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90",
              (busy || keep.size === 0) && "pointer-events-none opacity-50",
            )}
            disabled={busy || keep.size === 0}
            onClick={() => void finish(keep)}
          >
            {t("request.apply")}
          </button>
          <button
            autoFocus
            disabled={busy}
            className="rounded-input border border-border px-3 py-1.5 text-sm text-text hover:bg-surface-2"
            onClick={decline}
          >
            {t("request.decline")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Value({ def, v }: { def: SettingDef; v: SettingValue }) {
  const { t } = useTranslation("settings");
  if (typeof v === "boolean") return <>{t(v ? "request.on" : "request.off")}</>;
  if (v === "") return <>{t("request.empty")}</>;
  if (def.display) return <>{def.display(String(v))}</>;
  if (def.kind === "enum" && def.optionLabel) return <>{t(def.optionLabel(String(v)))}</>;
  return <>{String(v)}</>;
}
