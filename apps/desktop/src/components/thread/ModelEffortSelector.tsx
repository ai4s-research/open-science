import { useMemo, useRef, useState } from "react";
import { ChevronDown, Cpu } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { useRuntimeStore } from "@/lib/runtime";
import { flattenModelOptions } from "@/components/settings/modelCatalog";
import { resolveSelection, selectionAvailability } from "@/lib/modelSelection";
import type { ModelSelection } from "@/lib/modelSelection";

export function ModelEffortSelector() {
  const { t } = useTranslation("session");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const providers = useRuntimeStore((s) => s.providers);
  const defaultSelection = useRuntimeStore((s) => s.defaultSelection);
  const sessionSelections = useRuntimeStore((s) => s.sessionSelections);
  const draftSelection = useRuntimeStore((s) => s.draftSelection);
  const currentId = useRuntimeStore((s) => s.currentId);
  const switching = useRuntimeStore((s) => s.switching);
  const setCurrentSelection = useRuntimeStore((s) => s.setCurrentSelection);
  const setDefaultSelection = useRuntimeStore((s) => s.setDefaultSelection);

  const selection = resolveSelection({ currentId, defaultSelection, sessionSelections, draftSelection });
  const options = useMemo(() => flattenModelOptions(providers), [providers]);
  const currentModelKey = selection?.model ?? null;
  const currentOption = options.find((o) => o.key === currentModelKey) ?? null;
  const variants = currentOption?.variants ?? [];
  const availability = selectionAvailability(selection, providers);

  // ponytail: only show when connected and has at least one model option
  if (options.length === 0) return null;

  const modelLabel = currentOption
    ? `${currentOption.modelName}${currentOption.providerName ? ` · ${currentOption.providerName}` : ""}`
    : t("composer.modelSelector.notSet");

  const variantLabel = selection?.variant
    ? selection.variant
    : t("composer.modelSelector.defaultVariant");

  const handlePickModel = async (modelKey: string) => {
    const newSelection: ModelSelection = { model: modelKey, variant: null };
    try {
      await setDefaultSelection(newSelection);
      setOpen(false);
    } catch {
      // error already in store.error
    }
  };

  const handlePickVariant = (variant: string | null) => {
    if (!selection) return;
    setCurrentSelection({ ...selection, variant });
    setOpen(false);
  };

  return (
    <div className="relative shrink-0" ref={ref}>
      {open && (
        <div
          role="menu"
          aria-label={t("composer.modelSelector.menuAria")}
          className="absolute bottom-full left-0 z-20 mb-2 w-80 rounded-card border border-border bg-surface p-1 shadow-card"
        >
          <div className="px-2 pb-1 pt-1.5 text-xs text-muted">
            {t("composer.modelSelector.modelSection")}
          </div>
          <div className="max-h-48 overflow-y-auto">
            {options.map((opt) => (
              <button
                key={opt.key}
                role="menuitemradio"
                aria-checked={opt.key === currentModelKey}
                className="flex w-full items-center gap-2 rounded-input px-2 py-1.5 text-left hover:bg-surface-2"
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (opt.key !== currentModelKey) void handlePickModel(opt.key);
                }}
              >
                <Cpu size={13} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate text-xs text-text">
                  {opt.modelName}
                  <span className="text-muted"> · {opt.providerName}</span>
                </span>
                {opt.key === currentModelKey && (
                  <span className="shrink-0 text-xs text-accent">✓</span>
                )}
              </button>
            ))}
          </div>
          {variants.length > 0 && (
            <>
              <div className="mt-1 border-t border-border px-2 pb-1 pt-1.5 text-xs text-muted">
                {t("composer.modelSelector.variantSection")}
              </div>
              <button
                role="menuitemradio"
                aria-checked={!selection?.variant}
                className="flex w-full items-center gap-2 rounded-input px-2 py-1.5 text-left hover:bg-surface-2"
                onMouseDown={(e) => {
                  e.preventDefault();
                  handlePickVariant(null);
                }}
              >
                <span className="min-w-0 flex-1 truncate text-xs text-text">
                  {t("composer.modelSelector.defaultVariant")}
                </span>
                {!selection?.variant && <span className="shrink-0 text-xs text-accent">✓</span>}
              </button>
              {variants.map((v) => (
                <button
                  key={v}
                  role="menuitemradio"
                  aria-checked={selection?.variant === v}
                  className="flex w-full items-center gap-2 rounded-input px-2 py-1.5 text-left hover:bg-surface-2"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handlePickVariant(v);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-text">{v}</span>
                  {selection?.variant === v && <span className="shrink-0 text-xs text-accent">✓</span>}
                </button>
              ))}
            </>
          )}
        </div>
      )}
      <button
        aria-label={t("composer.modelSelector.aria")}
        title={t("composer.modelSelector.title")}
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs",
          availability !== "available"
            ? "bg-warn/15 text-warn hover:bg-warn/25"
            : "text-muted hover:bg-surface-2 hover:text-text",
        )}
        onClick={() => setOpen((o) => !o)}
        disabled={switching}
      >
        <Cpu size={12} />
        <span className="max-w-[120px] truncate">{modelLabel}</span>
        <span className="text-muted/60">·</span>
        <span className="text-muted">{variantLabel}</span>
        <ChevronDown size={11} />
      </button>
    </div>
  );
}
