import { useEffect, useMemo, useRef, useState } from "react";
import { Brain, ChevronDown, ChevronRight, Cpu, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { useRuntimeStore } from "@/lib/runtime";
import { flattenModelOptions, type ModelOption } from "@/components/settings/modelCatalog";
import { resolveSelection } from "@/lib/modelSelection";
import type { ProviderInfo } from "@ai4s/sdk";

const EFFORT_LEVELS: [string, string][] = [
  ["minimal", "Minimal"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["extra_high", "Extra High"],
  ["max", "Max"],
  ["ultra", "Ultra"],
];

export function ModelEffortSelector() {
  const { t } = useTranslation("session");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsedProviders, setCollapsedProviders] = useState<Set<string>>(new Set());
  const [thinkingOn, setThinkingOn] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

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

  // The effort panel always shows for the current selection
  const activeOption = currentOption;

  // Group by provider
  const grouped = useMemo(() => {
    const map = new Map<string, { provider: ProviderInfo; models: ModelOption[] }>();
    for (const p of providers) {
      const models = options.filter((o) => o.providerID === p.id);
      const q = query.trim().toLowerCase();
      const filtered = q
        ? models.filter((m) =>
            [m.modelName, m.modelID, p.name, p.id].join(" ").toLowerCase().includes(q),
          )
        : models;
      if (filtered.length > 0) map.set(p.id, { provider: p, models: filtered });
    }
    return Array.from(map.values());
  }, [providers, options, query]);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (options.length === 0) return null;

  const modelLabel = activeOption ? activeOption.modelName : t("composer.modelSelector.notSet");
  const variantLabel = selection?.variant
    ? selection.variant
    : t("composer.modelSelector.defaultVariant");

  const toggleProvider = (id: string) => {
    setCollapsedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Click model: switch to it, keep popup open so user can pick effort
  const handlePickModel = async (modelKey: string) => {
    if (modelKey === currentModelKey) return;
    try {
      await setDefaultSelection({ model: modelKey, variant: null });
    } catch {
      // error in store
    }
  };

  // Pick effort: set on current session, then close
  const handlePickVariant = (variant: string | null) => {
    const target = currentModelKey;
    if (!target) return;
    setCurrentSelection({ model: target, variant });
    setOpen(false);
  };

  return (
    <div className="relative shrink-0" ref={containerRef}>
      {open && (
        <div
          role="menu"
          aria-label={t("composer.modelSelector.menuAria")}
          className="absolute bottom-full left-0 z-30 mb-2 flex max-h-80 w-72 rounded-card border border-border bg-surface shadow-card"
        >
          {/* Left: model list */}
          <div className="flex w-44 flex-col border-r border-border">
            <div className="border-b border-border p-2">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search"
                  className="w-full rounded-input bg-surface-2 py-1 pl-7 pr-2 text-xs text-text outline-none placeholder:text-muted"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {grouped.length === 0 && (
                <div className="p-3 text-xs text-muted italic">No matches</div>
              )}
              {grouped.map(({ provider, models }) => {
                const collapsed = collapsedProviders.has(provider.id);
                return (
                  <div key={provider.id}>
                    <button
                      onClick={() => toggleProvider(provider.id)}
                      className="flex w-full items-center gap-1 px-2 py-1.5 text-xs font-medium text-muted hover:bg-surface-2"
                    >
                      {collapsed ? (
                        <ChevronRight size={11} className="shrink-0" />
                      ) : (
                        <ChevronDown size={11} className="shrink-0" />
                      )}
                      <span className="truncate">{provider.name}</span>
                      <span className="ml-auto text-muted/60">{models.length}</span>
                    </button>
                    {!collapsed &&
                      models.map((opt) => {
                        const isCurrent = opt.key === currentModelKey;
                        return (
                          <button
                            key={opt.key}
                            className={cn(
                              "flex w-full items-center gap-1.5 py-1.5 pl-7 pr-2 text-left text-xs",
                              isCurrent ? "bg-surface-2 text-accent" : "text-text hover:bg-surface-2",
                            )}
                            onClick={() => void handlePickModel(opt.key)}
                          >
                            <Cpu size={12} className="shrink-0 text-muted" />
                            <span className="min-w-0 flex-1 truncate">{opt.modelName}</span>
                            {isCurrent && <span className="shrink-0 text-accent">✓</span>}
                          </button>
                        );
                      })}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right: effort panel — always visible for current selection */}
          <div className="flex w-40 flex-col">
            <div className="px-2 py-1.5 text-xs text-muted">
              {t("composer.modelSelector.variantSection")}
            </div>
            {/* Thinking toggle */}
            <button
              className="flex w-full items-center gap-2 px-2 py-1.5 text-xs hover:bg-surface-2"
              onClick={(e) => {
                e.stopPropagation();
                setThinkingOn((v) => !v);
              }}
            >
              <Brain size={12} className="text-muted" />
              <span className="flex-1 text-text">Thinking</span>
              <span
                className={cn(
                  "relative h-4 w-7 rounded-full transition-colors",
                  thinkingOn ? "bg-accent" : "bg-muted/30",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform",
                    thinkingOn ? "left-3.5" : "left-0.5",
                  )}
                />
              </span>
            </button>
            <div className="border-t border-border" />
            {/* Default (no variant) */}
            <button
              className="flex w-full items-center gap-2 px-2 py-1 text-xs hover:bg-surface-2"
              onClick={(e) => {
                e.stopPropagation();
                handlePickVariant(null);
              }}
            >
              <span className="flex-1 text-muted">{t("composer.modelSelector.defaultVariant")}</span>
              {!selection?.variant && <span className="text-accent">✓</span>}
            </button>
            {/* Effort levels */}
            {EFFORT_LEVELS.map(([value, label]) => (
              <button
                key={value}
                className="flex w-full items-center gap-2 px-2 py-1 text-xs hover:bg-surface-2"
                onClick={(e) => {
                  e.stopPropagation();
                  handlePickVariant(value);
                }}
              >
                <span className="flex-1 text-text">{label}</span>
                {selection?.variant === value && <span className="text-accent">✓</span>}
              </button>
            ))}
          </div>
        </div>
      )}
      <button
        aria-label={t("composer.modelSelector.aria")}
        title={t("composer.modelSelector.title")}
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted hover:bg-surface-2 hover:text-text",
        )}
        onClick={() => setOpen((o) => !o)}
        disabled={switching}
      >
        <Cpu size={12} />
        <span className="max-w-[100px] truncate">{modelLabel}</span>
        <span className="text-muted/60">·</span>
        <span className="text-muted">{variantLabel}</span>
        <ChevronDown size={11} />
      </button>
    </div>
  );
}
