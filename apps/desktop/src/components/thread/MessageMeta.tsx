import { useTranslation } from "react-i18next";
import { contextUsed, type MessageUsage } from "@ai4s/shared";
import { cn } from "@/lib/cn";

/** Share of the context window at which the readout starts warning. Below the
 *  runtime's own auto-compaction trigger, so "the context is filling up" is
 *  visible BEFORE the conversation gets summarized out from under the user. */
const WARN_AT = 0.75;

/** Compact token counts: 980, 12.4k, 1.28M. Two significant-ish digits — the
 *  exact figure lives in the tooltip, this one only has to convey scale. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Wall-clock a turn took: "820ms", "7.3s", "2m 41s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Cost is only meaningful when the provider charges: local models report 0,
 *  and a "$0.00" on every message is noise. Sub-cent spends still round up to
 *  a visible figure rather than showing "$0.00" for something that cost money. */
function formatCost(usd: number): string | null {
  if (usd <= 0) return null;
  return usd < 0.01 ? `<$0.01` : `$${usd.toFixed(2)}`;
}

/**
 * The quiet line under an agent answer: when it replied, how long it took, and
 * how much of the model's context window the conversation now occupies (#62).
 *
 * It sits beside Copy in the hover row because that is where a reader already
 * looks when interrogating a specific answer — and because the newest message
 * carries the newest numbers, "how full is the context right now" is answered
 * by the bottom of the thread without a separate always-on gauge.
 *
 * Every field is optional and rendered only when real: ACP sessions report no
 * usage at all, a streaming turn has no duration yet, and a model whose window
 * OpenCode does not know (`contextLimit` 0) shows tokens with no percentage
 * rather than a made-up denominator.
 */
export function MessageMeta({
  created,
  completed,
  usage,
  contextLimit,
}: {
  created?: number;
  completed?: number;
  usage?: MessageUsage;
  /** Model context window in tokens; 0/undefined means unknown. */
  contextLimit?: number;
}) {
  const { t, i18n } = useTranslation("session");
  const duration = created && completed && completed > created ? completed - created : null;
  const used = usage ? contextUsed(usage) : null;
  const limit = contextLimit && contextLimit > 0 ? contextLimit : null;
  const share = used !== null && limit ? used / limit : null;
  const cost = usage ? formatCost(usage.cost) : null;

  if (created == null && duration === null && used === null) return null;

  const clock =
    created != null
      ? new Date(created).toLocaleTimeString(i18n.language, {
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;

  // The full breakdown belongs in the tooltip: the line itself stays scannable,
  // but the numbers behind it are one hover away instead of unavailable.
  const breakdown = usage
    ? [
        t("meta.tooltip.input", { n: usage.input.toLocaleString(i18n.language) }),
        t("meta.tooltip.cacheRead", { n: usage.cacheRead.toLocaleString(i18n.language) }),
        t("meta.tooltip.cacheWrite", { n: usage.cacheWrite.toLocaleString(i18n.language) }),
        t("meta.tooltip.output", { n: usage.output.toLocaleString(i18n.language) }),
        ...(usage.reasoning > 0
          ? [t("meta.tooltip.reasoning", { n: usage.reasoning.toLocaleString(i18n.language) })]
          : []),
        limit
          ? t("meta.tooltip.context", {
              used: (used ?? 0).toLocaleString(i18n.language),
              limit: limit.toLocaleString(i18n.language),
            })
          : t("meta.tooltip.contextUnknown", {
              used: (used ?? 0).toLocaleString(i18n.language),
            }),
      ].join("\n")
    : undefined;

  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11px] tabular-nums text-muted">
      {clock && <span title={new Date(created!).toLocaleString(i18n.language)}>{clock}</span>}
      {duration !== null && (
        <>
          <span aria-hidden>·</span>
          <span title={t("meta.durationTitle")}>{formatDuration(duration)}</span>
        </>
      )}
      {used !== null && (
        <>
          <span aria-hidden>·</span>
          <span
            title={breakdown}
            className={cn("flex items-center gap-1", share !== null && share >= WARN_AT && "text-warn")}
          >
            {share !== null ? (
              <>
                <ContextRing share={share} />
                <span>
                  {t("meta.context", {
                    used: formatTokens(used),
                    limit: formatTokens(limit!),
                    percent: Math.round(share * 100),
                  })}
                </span>
              </>
            ) : (
              <span>{t("meta.contextUnknown", { used: formatTokens(used) })}</span>
            )}
          </span>
        </>
      )}
      {cost && (
        <>
          <span aria-hidden>·</span>
          <span title={t("meta.costTitle")}>{cost}</span>
        </>
      )}
    </div>
  );
}

/** A 10px dial of the context window. Purely redundant with the "62%" beside it
 *  — that redundancy is the point: the shape is readable at a glance and the
 *  number is there for anyone who needs the value, and neither carries meaning
 *  by color alone. */
function ContextRing({ share }: { share: number }) {
  const r = 4;
  const c = 2 * Math.PI * r;
  const filled = Math.min(1, Math.max(0, share)) * c;
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="shrink-0 -rotate-90">
      <circle cx="5" cy="5" r={r} fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.25" />
      <circle
        cx="5"
        cy="5"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray={`${filled} ${c - filled}`}
        strokeLinecap="round"
      />
    </svg>
  );
}
