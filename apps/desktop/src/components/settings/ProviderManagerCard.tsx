import type { ReactNode } from "react";
import type { ProviderInfo } from "@ai4s/sdk";
import { useTranslation } from "react-i18next";
import { Section } from "./Section";

interface ProviderManagerCardProps {
  providers: ProviderInfo[];
  /** Overrides the default subtitle when the caller offers less than the full
   *  surface (the web client can only read it). */
  hint?: string;
  children: ReactNode;
}

/**
 * Where the models come from: what is connected, and how to connect more.
 *
 * Deliberately NOT collapsible. It used to open behind a "Manage" button, which
 * put the most common task on this page — adding a provider — two clicks deep
 * and invisible until you went looking. A settings page earns its space by
 * showing the state it governs; a card whose whole content is a click away is
 * just a heading.
 */
export function ProviderManagerCard({ providers, hint, children }: ProviderManagerCardProps) {
  const { t } = useTranslation("settings");
  const names = providers.map((provider) => provider.name).join(", ");

  return (
    <Section
      title={t("providers.title")}
      hint={hint ?? t("providers.hint")}
      // Screen-reader summary of what the rows below add up to; sighted readers
      // get the same thing from the list itself.
      action={
        <span className="sr-only">
          {providers.length
            ? t("providers.connectedSummary", { count: providers.length, names })
            : t("providers.noneConnected")}
        </span>
      }
      flush
    >
      {children}
    </Section>
  );
}
