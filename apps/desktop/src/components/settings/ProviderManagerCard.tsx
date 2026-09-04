import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { ProviderInfo } from "@ai4s/sdk";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { Section } from "./Section";

interface ProviderManagerCardProps {
  providers: ProviderInfo[];
  /** Overrides the default subtitle when the caller offers less than the full
   *  surface (the web client can only read it). */
  hint?: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  children: ReactNode;
}

export function ProviderManagerCard({
  providers,
  hint,
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
    <Section
      title={t("providers.title")}
      hint={hint ?? t("providers.hint")}
      action={
        /* The toggle only shows/hides content — it must stay clickable in
           every runtime state, or a disconnect strands an expanded panel. */
        <button
          aria-expanded={expanded}
          onClick={() => onExpandedChange(!expanded)}
          className="flex h-8 shrink-0 items-center gap-1 rounded-input border border-transparent bg-surface-2 px-3 text-[13px] text-text transition-colors hover:bg-border/50 disabled:text-muted"
        >
          <ChevronRight size={13} className={cn("transition-transform", expanded && "rotate-90")} />
          {t(expanded ? "providers.collapse" : "providers.manage")}
        </button>
      }
      flush
    >
      {expanded ? (
        children
      ) : (
        <p className="truncate px-4 py-3 text-[13px] text-muted">{summary}</p>
      )}
    </Section>
  );
}
