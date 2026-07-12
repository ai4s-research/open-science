import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { ProviderInfo } from "@ai4s/sdk";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";

interface ProviderManagerCardProps {
  providers: ProviderInfo[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  children: ReactNode;
}

export function ProviderManagerCard({
  providers,
  expanded,
  onExpandedChange,
  children,
}: ProviderManagerCardProps) {
  const { t } = useTranslation("settings");
  const names = providers.map((provider) => provider.name).join(", ");
  const summary = providers.length
    ? t("providers.connectedSummary", { count: providers.length, names })
    : t("providers.noneConnected");

  return (
    <section className="mt-5 rounded-card border border-border bg-surface shadow-card">
      <header className="flex items-center gap-3 px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-[15px] text-text">{t("providers.title")}</h2>
          <p className="mt-0.5 truncate text-xs text-muted">{summary}</p>
          <p className="mt-0.5 text-xs text-muted">{t("providers.hint")}</p>
        </div>
        {/* The toggle only shows/hides content — it must stay clickable in
            every runtime state, or a disconnect strands an expanded panel. */}
        <button
          aria-expanded={expanded}
          onClick={() => onExpandedChange(!expanded)}
          className="flex h-9 shrink-0 items-center gap-1 rounded-input border border-border bg-surface px-3 text-[13px] text-text transition-colors hover:bg-surface-2 disabled:text-muted"
        >
          <ChevronRight size={13} className={cn("transition-transform", expanded && "rotate-90")} />
          {t(expanded ? "providers.collapse" : "providers.manage")}
        </button>
      </header>
      {expanded && <div className="border-t border-border px-5 py-4">{children}</div>}
    </section>
  );
}
