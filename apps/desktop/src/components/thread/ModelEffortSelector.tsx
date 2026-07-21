import { useEffect, useMemo, useRef, useState } from "react";
import { Brain, ChevronDown, ChevronRight, Cpu, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { useRuntimeStore } from "@/lib/runtime";
import { flattenModelOptions, type ModelOption } from "@/components/settings/modelCatalog";
import { resolveSelection, selectionAvailability } from "@/lib/modelSelection";
import type { ModelSelection } from "@/lib/modelSelection";
import type { ProviderInfo } from "@ai4s/sdk";

const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "extra_high", "max", "ultra"];

export function ModelEffortSelector() {
  const { t } = useTranslation("session");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsedProviders, setCollapsedProviders] = useState<Set<string>>(new Set());
  const [hoveredModel, setHoveredModel] = useState<string | null>(null);
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
  const availability = selectionAvailability(selection, providers);

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
        setHoveredModel(null);
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
        setHoveredModel(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // ponytail: only show when connected and has at least one model option
  if (options.length === 0) return null;

  const modelLabel = currentOption
    ? currentOption.modelName
    : t("composer.modelSelector.notSet");

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

  const handlePickModel = async (modelKey: string) => {
    const newSelection: ModelSelection = { model: modelKey, variant: null };
    try {
      await setDefaultSelection(newSelection);
      setOpen(false);
      setHoveredModel(null);
    } catch {
      // error already in store.error
    }
  };

  const handlePickVariant = (variant: string | null) => {
    if (!selection) return;
    setCurrentSelection({ ...selection, variant });
    setHoveredModel(null);
  };

  const isHoveredCurrent = hoveredModel === currentModelKey;

  return (
    <div className="relative shrink-0" ref={containerRef}>
      {open && (
        <div
          role="menu"
          aria-label={t("composer.modelSelector.menuAria")}
          className="absolute bottom-full left-0 z-30 mb-2 w-72 rounded-card border border-border bg-surface shadow-card"
        >
          {/* Search */}
          <div className="border-b border-border p-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("composer.modelSelector.modelSection")}
                className="w-full rounded-input bg-surface-2 py-1 pl-7 pr-2 text-xs text-text outline-none placeholder:text-muted"
              />
            </div>
          </div>

          {/* Model list grouped by provider */}
          <div className="relative max-h-64 overflow-y-auto">
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
                      const isHovered = opt.key === hoveredModel;
                      return (
                        <div
                          key={opt.key}
                          className="relative"
                          onMouseEnter={() => setHoveredModel(opt.key)}
                          onMouseLeave={() => setHoveredModel(null)}
                        >
                          <button
                            role="menuitemradio"
                            aria-checked={isCurrent}
                            className={cn(
                              "flex w-full items-center gap-2 py-1.5 pl-7 pr-2 text-left text-xs hover:bg-surface-2",
                              isCurrent && "text-accent",
                            )}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              if (!isCurrent) void handlePickModel(opt.key);
                            }}
                          >
                            <Cpu size={12} className="shrink-0 text-muted" />
                            <span className="min-w-0 flex-1 truncate">{opt.modelName}</span>
                            {opt.variants.length > 0 && (
                              <Brain size={10} className="shrink-0 text-muted/60" />
                            )}
                            {isCurrent && (
                              <span className="shrink-0 text-accent">✓</span>
                            )}
                          </button>

                          {/* Thinking/effort popover on hover */}
                          {isHovered && (
                            <div className="absolute left-full top-0 z-40 ml-1 w-56 rounded-card border border-border bg-surface shadow-card">
                              <div className="px-2 py-1.5 text-xs text-muted">
                                {t("composer.modelSelector.variantSection")}
                              </div>
                              {/* Thinking toggle */}
                              <button
                                className="flex w-full items-center gap-2 px-2 py-1.5 text-xs hover:bg-surface-2"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setThinkingOn((v) => !v);
                                }}
                              >
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
                              {/* Effort levels */}
                              {EFFORT_LEVELS.map((v) => (
                                <button
                                  key={v}
                                  className="flex w-full items-center gap-2 px-2 py-1 text-xs hover:bg-surface-2"
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    if (isHoveredCurrent) {
                                      handlePickVariant(
                                        selection?.variant === v ? null : v,
                                      );
                                    } else {
                                      // Select model + variant
                                      void setDefaultSelection({
                                        model: hoveredModel!,
                                        variant: v,
                                      }).then(() => {
                                        setOpen(false);
                                        setHoveredModel(null);
                                      });
                                    }
                                  }}
                                >
                                  <span className="flex-1 capitalize text-text">{v}</span>
                                  {isHoveredCurrent && selection?.variant === v && (
                                    <span className="text-accent">✓</span>
                                  )}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              );
            })}
          </div>
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
        <span className="max-w-[100px] truncate">{modelLabel}</span>
        <span className="text-muted/60">·</span>
        <span className="text-muted">{variantLabel}</span>
        <ChevronDown size={11} />
      </button>
    </div>
  );
}
