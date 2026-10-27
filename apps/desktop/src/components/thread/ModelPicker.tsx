import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import type { AcpConfigOption } from "@ai4s/sdk/acp";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  Loader2,
  Search,
  Star,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import { agentForTurn, useRuntimeStore, type AcpOptionsProbe } from "@/lib/runtime";
import { useIsMobile } from "@/lib/useIsMobile";
import { useAgentChoices } from "@/lib/agentChoices";
import { accountKindOf, accountLabel, splitAgentId, useAccountsStore, withAccount } from "@/lib/agentAccounts";
import { cn } from "@/lib/cn";
import {
  flattenModelOptions,
  filterModelOptions,
  type ModelFilter,
} from "@/components/settings/modelCatalog";
import {
  loadModelPreferences,
  recordRecent,
  saveModelPreferences,
  toggleFavorite,
  type ModelPreferences,
} from "@/components/settings/modelPreferences";

/** Display label for a reasoning-effort variant. Variant names are provider
 *  tokens (like model ids), the same in every language, so we title-case them
 *  in place rather than translating: "high" → "High", "xhigh" → "X-High". */
function labelVariant(name: string): string {
  if (name === "xhigh") return "X-High";
  return name.charAt(0).toLocaleUpperCase() + name.slice(1);
}

/**
 * Codex-style effort slider over a model's reasoning variants. Stops are laid
 * edge-to-edge (variant[0] hard left → variant[n-1] hard right) with the knob
 * inset by its radius so the end stops line up; the knob tracks the pointer
 * continuously and snaps to the nearest stop on release; dots grow on hover and
 * a click jumps to that stop; it's fully keyboard-operable (←/→, Home/End; ←
 * past the first stop clears to the model default). `value` null = no override
 * (empty track, nothing sent). `flash` bumps to pulse the track for attention.
 */
function ReasoningSlider({
  variants,
  value,
  onChange,
  label,
  minLabel,
  maxLabel,
  flash,
}: {
  variants: string[];
  value: string | null;
  onChange: (v: string | null) => void;
  label: string;
  minLabel: string;
  maxLabel: string;
  flash: number;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  // Live drag fraction (0..1) so the knob follows the finger between stops; null
  // when not dragging (knob rests on the committed stop).
  const [dragFrac, setDragFrac] = useState<number | null>(null);
  const n = variants.length;
  const idx = value ? variants.indexOf(value) : -1;
  // The knob radius (h-7 → 14px) each stop is inset by, so index 0 sits flush at
  // the left and index n-1 flush at the right without the knob clipping.
  const fracOf = (i: number) => (n > 1 ? i / (n - 1) : 0.5);
  const posOf = (f: number) => `calc(0.875rem + (100% - 1.75rem) * ${f})`;

  const commitFromClientX = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const usable = Math.max(1, rect.width - 28); // minus the two knob radii
    const frac = Math.min(1, Math.max(0, (clientX - rect.left - 14) / usable));
    setDragFrac(frac);
    onChange(variants[Math.round(frac * (n - 1))]);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    commitFromClientX(e.clientX);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragFrac === null) return; // only while dragging (pointer captured)
    commitFromClientX(e.clientX);
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    setDragFrac(null);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      onChange(variants[Math.min((idx < 0 ? -1 : idx) + 1, n - 1)]);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      onChange(idx <= 0 ? null : variants[idx - 1]);
    } else if (e.key === "Home") {
      e.preventDefault();
      onChange(variants[0]);
    } else if (e.key === "End") {
      e.preventDefault();
      onChange(variants[n - 1]);
    }
  };

  // Continuous knob/fill fraction: the live drag while dragging, else the
  // committed stop. The lit-dot count follows whichever is active.
  const liveFrac = dragFrac !== null ? dragFrac : idx >= 0 ? fracOf(idx) : null;
  const litIdx = dragFrac !== null ? Math.round(dragFrac * (n - 1)) : idx;

  return (
    <div>
      <div className="mb-1.5 flex justify-between px-1 text-[11px] text-muted">
        <span>{minLabel}</span>
        <span>{maxLabel}</span>
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={n - 1}
        aria-valuenow={idx < 0 ? undefined : idx}
        aria-valuetext={value ? labelVariant(value) : undefined}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="relative flex h-8 cursor-pointer touch-none items-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        {/* key={flash} replays the attention pulse each time a reasoning model is picked */}
        <div
          ref={trackRef}
          key={flash}
          className={cn(
            "relative h-6 w-full rounded-full bg-surface-2",
            flash > 0 && "animate-effort-flash",
          )}
        >
          {liveFrac !== null && (
            <div
              className={cn(
                // Codex-style bright blue fill (not the app accent, which reads
                // too dark/heavy here).
                "absolute inset-y-0 left-0 rounded-full bg-[#4c9dff]",
                dragFrac === null && "transition-[width] duration-100",
              )}
              style={{ width: posOf(liveFrac) }}
            />
          )}
          {variants.map((v, i) => (
            <span
              key={v}
              className={cn(
                "absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-transform duration-100 hover:scale-[1.9]",
                // Solid muted gray so the stops are clearly visible on the light
                // (near-white) track by default; white only where the blue fill
                // is behind them.
                litIdx >= 0 && i <= litIdx ? "bg-white/90" : "bg-muted",
              )}
              style={{ left: posOf(fracOf(i)) }}
            />
          ))}
          {liveFrac !== null && (
            <div
              className={cn(
                // A defined gray ring + soft shadow so the white knob stays
                // clearly visible on the near-white track (Codex-style).
                "pointer-events-none absolute top-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/15 bg-white shadow-[0_1px_4px_rgba(0,0,0,0.28)]",
                dragFrac === null && "transition-[left] duration-100",
              )}
              style={{ left: posOf(liveFrac) }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Inline model + reasoning-effort switcher for the composer (issues #48, #40).
 * A compact chip ("model · effort ⌄") that opens a picker: search, All /
 * Favorites / Recent / per-provider filters, a model list, and — only for models
 * that expose reasoning levels — an "Advanced" section with a segmented effort
 * control built from that model's own `variants`.
 *
 * Reads the runtime store directly (like the composer's own `getState()` calls):
 * the picker is a live-session concern and the store is the one source of truth
 * for providers / default model / reasoning variant. The composer renders it
 * only in the live session, so its `useNavigate` never runs in a mock surface.
 *
 * One picker body renders in two shells: an anchored popover on desktop/wide
 * web, a bottom sheet on phone-width viewports (`useIsMobile`).
 */
/** Which agent a conversation runs on, and that agent's own selectors. Given
 *  on the desktop, where an ACP agent can run; the picker then leads with the
 *  agent and shows the chosen agent's models below it. */
export interface AgentControl {
  /** ACP agent id, or null for OpenCode. */
  value: string | null;
  /** An existing conversation keeps its agent; only a new one chooses. */
  locked: boolean;
  onChange: (agentId: string | null) => void;
  /** The ACP agent's selectors (model, reasoning level, mode) as it reported
   *  them; for a new conversation, as it last reported them. */
  options: AcpConfigOption[];
  onOption: (configId: string, value: string) => void;
  /** A turn is running: the agent's selectors wait for it to end. */
  busy?: boolean;
  /** Reading the selectors of an agent that has never reported any. */
  probe?: AcpOptionsProbe;
  /** Asked when the picker shows an agent with no selectors known yet. */
  onNeedOptions?: () => void;
}

export function ModelPicker({
  sessionId,
  compact,
  agent,
}: {
  sessionId?: string;
  /** Narrow composer: show the chip as an icon only. The button keeps its
   *  aria-label and title, so the model stays discoverable without the words. */
  compact?: boolean;
  agent?: AgentControl;
} = {}) {
  const { t } = useTranslation(["session", "common"]);
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  const providers = useRuntimeStore((s) => s.providers);
  const defaultModel = useRuntimeStore((s) => s.defaultModel);
  const reasoningVariant = useRuntimeStore((s) => s.reasoningVariant);
  const setDefaultModel = useRuntimeStore((s) => s.setDefaultModel);
  const setReasoningVariant = useRuntimeStore((s) => s.setReasoningVariant);
  const sessionModels = useRuntimeStore((s) => s.sessionModels);
  const sessionVariants = useRuntimeStore((s) => s.sessionVariants);
  const setSessionModel = useRuntimeStore((s) => s.setSessionModel);
  const setSessionVariant = useRuntimeStore((s) => s.setSessionVariant);
  const clearSessionModel = useRuntimeStore((s) => s.clearSessionModel);
  const agentModels = useRuntimeStore((s) => s.agentModels);
  const agentVariants = useRuntimeStore((s) => s.agentVariants);
  // The agent this pane's next turn runs on ("build", or "plan" in plan mode).
  const turnAgent = useRuntimeStore((s) => (sessionId ? agentForTurn(s, sessionId) : null));
  // Only a MODEL switch spins this chip. `switching` also covers workspace
  // moves, so reading it made the chip spin on every Screen switch.
  const switching = useRuntimeStore((s) => s.modelSwitching);

  // When bound to a session (a split pane), the picker sets THAT pane's model /
  // effort — no global sidecar config PATCH, so other panes are untouched.
  // Without a sessionId it drives the global default (unchanged behavior).
  //
  // The displayed model mirrors the SEND's precedence exactly (pane pick >
  // configured agent model > global default). Showing the global default while
  // a configured `build` model was what actually ran is the whole confusion in
  // #85/#96 — the chip has to name the model the next turn will really use.
  const pinnedModel = sessionId ? sessionModels[sessionId] : undefined;
  const followedAgent = !pinnedModel && sessionId ? turnAgent : null;
  const agentModel = followedAgent ? agentModels[followedAgent] : undefined;
  const model = pinnedModel ?? agentModel ?? defaultModel;
  const variantChoice = agentModel
    ? (agentVariants[followedAgent!] ?? null)
    : sessionId
      ? sessionVariants[sessionId] !== undefined
        ? sessionVariants[sessionId]
        : reasoningVariant
      : reasoningVariant;
  const pickModel = (key: string): Promise<void> | void =>
    sessionId ? setSessionModel(sessionId, key) : setDefaultModel(key);
  const pickVariant = (v: string | null) =>
    sessionId ? setSessionVariant(sessionId, v) : setReasoningVariant(v);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ModelFilter>({ kind: "all" });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Bumped when a reasoning-capable model is picked → pulses the effort slider
  // so it's clear an effort can be set (and where).
  const [flash, setFlash] = useState(0);
  const [prefs, setPrefs] = useState<ModelPreferences>(() => loadModelPreferences());
  const closeButton = (
    <button
      aria-label={t("composer.model.close")}
      className="shrink-0 rounded-full p-1 text-muted hover:bg-surface-2 hover:text-text"
      onClick={() => setOpen(false)}
    >
      <X size={14} />
    </button>
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const options = useMemo(() => flattenModelOptions(providers), [providers]);
  const variantsByKey = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of providers)
      for (const m of p.models) map.set(`${p.id}/${m.id}`, m.variants ?? []);
    return map;
  }, [providers]);

  // 0 means OpenCode does not know the window — see ProviderModelInfo. It is
  // not cosmetic: a zero window disables auto-compaction entirely.
  const contextByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of providers)
      for (const m of p.models) map.set(`${p.id}/${m.id}`, m.contextLimit ?? 0);
    return map;
  }, [providers]);

  const current = options.find((o) => o.key === model);
  // Still configured, but the provider stopped serving it — the list below no
  // longer offers it, so say why rather than let the next turn fail.
  const currentRetired = current?.available === false;
  const contextUnknown = !!model && (contextByKey.get(model) ?? 0) === 0;
  const currentVariants = (model && variantsByKey.get(model)) || [];
  // The effort actually in force: the user's pick, but only when the current
  // model exposes it (else the model falls back to its own default — mirrors the
  // store's `activeVariant`, so the chip never claims an effort that won't send).
  const activeVariant =
    variantChoice && currentVariants.includes(variantChoice) ? variantChoice : null;

  const visible = filterModelOptions(options, filter, query, prefs.favorites, prefs.recent);

  // Manual outside-press dismissal — WKWebView never focuses a clicked button, so
  // relying on blur would leave the popover stuck open. (The composer's other
  // menus do the same.) The mobile sheet closes via its scrim instead.
  useEffect(() => {
    if (!open || isMobile) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, isMobile]);

  // Close on Escape from anywhere in the picker.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // On open: reset the query, focus search on desktop (skip on mobile so the
  // sheet doesn't yank up the keyboard), and default Advanced open when an
  // effort is already pinned so the user sees their setting.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setAdvancedOpen(!!activeVariant);
    if (!isMobile) searchRef.current?.focus();
    // Only when the popover transitions to open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const persistPrefs = (next: ModelPreferences) => {
    saveModelPreferences(next);
    setPrefs(next);
  };

  const selectModel = async (key: string) => {
    persistPrefs(recordRecent(prefs, key));
    // Reasoning-capable models keep the picker open so the user can dial in the
    // effort right after the switch (and the slider pulses to point it out);
    // models with nothing more to adjust close it.
    if ((variantsByKey.get(key) ?? []).length > 0) {
      setAdvancedOpen(true);
      setFlash((f) => f + 1);
    } else {
      setOpen(false);
    }
    if (key !== model) {
      try {
        await pickModel(key);
      } catch {
        // setDefaultModel records modelSwitchError / toasts on its own.
      }
    }
  };

  const acp = agent?.value != null;
  // The account rides in the agent id (`lib/agentAccounts.ts`): the tabs pick
  // the agent, the row under them its account.
  const split = agent?.value ? splitAgentId(agent.value) : null;
  const baseAgent = split?.base ?? null;
  const accountKind = baseAgent ? accountKindOf(baseAgent) : null;
  const accounts = useAccountsStore((s) => (accountKind ? s.byKind[accountKind] : undefined));
  const loadAccounts = useAccountsStore((s) => s.load);
  useEffect(() => {
    if (open && accountKind && !accounts) void loadAccounts(accountKind).catch(() => {});
  }, [open, accountKind, accounts, loadAccounts]);
  const chosenAccount = split?.account ? accounts?.accounts.find((a) => a.id === split.account) : undefined;
  const accountName = split?.account ? accountLabel(chosenAccount, split.account) : null;
  const { choices, pick } = useAgentChoices(baseAgent);
  const baseName = choices.find((c) => c.id === baseAgent)?.name ?? "";
  const agentName = accountName ? `${baseName} (${accountName.split("@")[0]})` : baseName;
  const acpOptions = (agent?.options ?? []).filter(
    (o) => o.type !== "boolean" && (o.options?.length ?? 0) > 0,
  );
  // The agent's model selector, for the chip: by category, which is what the
  // spec offers for it, else by the id agents use in practice.
  const acpModel = acpOptions.find((o) => o.category === "model") ?? acpOptions.find((o) => o.id === "model");
  const acpModelName = acpModel?.options?.find((v) => v.value === acpModel.currentValue)?.name;
  // An agent shown with nothing to choose from: ask for its list now rather
  // than make the user send a message first.
  const needsOptions = open && acp && acpOptions.length === 0 && !agent?.probe;
  const onNeedOptions = agent?.onNeedOptions;
  useEffect(() => {
    if (needsOptions) onNeedOptions?.();
  }, [needsOptions, onNeedOptions, agent?.value]);

  const chipLabel = acp
    ? acpModelName
      ? `${agentName} · ${acpModelName}`
      : agentName
    : (current?.modelName ?? t("composer.model.none"));

  const filterChips: { key: string; label: string; icon?: typeof Star; value: ModelFilter }[] = [
    { key: "all", label: t("composer.model.filter.all"), value: { kind: "all" } },
    {
      key: "favorites",
      label: t("composer.model.filter.favorites"),
      icon: Star,
      value: { kind: "favorites" },
    },
    { key: "recent", label: t("composer.model.filter.recent"), value: { kind: "recent" } },
    ...providers.map((p) => ({
      key: `provider:${p.id}`,
      label: p.name,
      value: { kind: "provider", providerID: p.id } as ModelFilter,
    })),
  ];
  const isActiveFilter = (value: ModelFilter) =>
    value.kind === filter.kind &&
    (value.kind !== "provider" ||
      (filter.kind === "provider" && value.providerID === filter.providerID));

  const opencodeBody = (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Search */}
      <div className="flex shrink-0 items-center gap-2 border-b border-faint px-2.5 py-2">
        <Search size={13} className="shrink-0 text-muted" />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("composer.model.search")}
          className="min-w-0 flex-1 bg-transparent text-xs text-text placeholder:text-muted focus:outline-none"
        />
        {isMobile && !agent && closeButton}
      </div>

      {/* Where this pane's model comes from. Rendered ONLY when it is not the
          plain global default, so the common case stays uncluttered and the
          surprising case (an agent setting is in force, or this conversation
          was pinned away from it) is stated instead of left to be guessed. */}
      {sessionId && (agentModel || (pinnedModel && turnAgent)) && (
        <div className="flex shrink-0 items-center gap-2 border-b border-faint px-2.5 py-1.5">
          {agentModel ? (
            <span className="truncate text-[11px] text-muted">
              {t("composer.model.followingAgent", { agent: followedAgent })}
            </span>
          ) : (
            <button
              className="truncate rounded px-1.5 py-0.5 text-[11px] text-accent hover:bg-accent/10"
              onClick={() => clearSessionModel(sessionId)}
            >
              {agentModels[turnAgent!]
                ? t("composer.model.followAgent", { agent: turnAgent })
                : t("composer.model.useDefault")}
            </button>
          )}
        </div>
      )}

      {/* Filter chips */}
      {options.length > 0 && (
        <div className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b border-faint px-2 py-1.5">
          {filterChips.map((chip) => (
            <button
              key={chip.key}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px]",
                isActiveFilter(chip.value)
                  ? "bg-accent/15 text-accent"
                  : "text-muted hover:bg-surface-2 hover:text-text",
              )}
              onClick={() => setFilter(chip.value)}
            >
              {chip.icon && <chip.icon size={10} />}
              {chip.label}
            </button>
          ))}
        </div>
      )}

      {/* Model list */}
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {options.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-muted">
            {t("composer.model.empty")}
          </div>
        ) : visible.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-muted">
            {t("composer.model.noResults")}
          </div>
        ) : (
          visible.map((o) => {
            const isCurrent = o.key === model;
            const isFavorite = prefs.favorites.includes(o.key);
            const hasReasoning = (variantsByKey.get(o.key) ?? []).length > 0;
            return (
              <div
                key={o.key}
                className={cn(
                  "group flex items-center gap-2 rounded-input px-2 py-1.5",
                  isCurrent ? "bg-surface-2" : "hover:bg-surface-2",
                )}
              >
                <button
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => void selectModel(o.key)}
                >
                  <Check
                    size={13}
                    className={cn("shrink-0 text-accent", isCurrent ? "" : "opacity-0")}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1">
                      <span className="truncate text-xs text-text">{o.modelName}</span>
                      {hasReasoning && (
                        <Zap size={9} className="shrink-0 text-muted" aria-hidden />
                      )}
                    </span>
                    <span className="block truncate text-[11px] text-muted">{o.providerName}</span>
                  </span>
                </button>
                <button
                  aria-label={t("composer.model.favorite")}
                  aria-pressed={isFavorite}
                  className={cn(
                    "shrink-0 rounded-full p-1 hover:bg-surface",
                    isFavorite
                      ? "text-accent"
                      : "text-muted opacity-0 group-hover:opacity-100 focus:opacity-100",
                  )}
                  onClick={() => persistPrefs(toggleFavorite(prefs, o.key))}
                >
                  <Star size={12} fill={isFavorite ? "currentColor" : "none"} />
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* Advanced: reasoning effort — only for models that expose levels (#40) */}
      {currentVariants.length > 0 && (
        <div className="shrink-0 border-t border-faint px-2 py-1.5">
          <button
            className="flex w-full items-center gap-1.5 rounded-input px-1.5 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            {advancedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <Zap size={12} />
            <span className="font-medium text-text">{t("composer.model.reasoning")}</span>
            <span className="ml-auto text-muted">
              {activeVariant ? labelVariant(activeVariant) : t("composer.model.reasoningDefault")}
            </span>
          </button>
          {advancedOpen && (
            <div className="px-1.5 pb-1 pt-1">
              <ReasoningSlider
                variants={currentVariants}
                value={activeVariant}
                onChange={pickVariant}
                label={t("composer.model.reasoning")}
                minLabel={t("composer.model.faster")}
                maxLabel={t("composer.model.smarter")}
                flash={flash}
              />
            </div>
          )}
        </div>
      )}

      {/* The chosen model has been retired by its provider: every turn fails
          with the provider's own error, and it is absent from the list above,
          which alone would just look like it vanished. */}
      {currentRetired && (
        <div className="shrink-0 border-t border-faint px-3 py-2">
          <span className="flex items-start gap-1.5">
            <TriangleAlert size={12} className="mt-0.5 shrink-0 text-warn" />
            <span className="text-xs">
              <span className="block font-medium text-text">
                {t("composer.model.retiredTitle")}
              </span>
              <span className="mt-0.5 block text-muted">
                {t("composer.model.retiredBody", { model: current?.modelName ?? model })}
              </span>
            </span>
          </span>
        </div>
      )}

      {/* A model whose context window OpenCode does not know never gets
          auto-compacted, which is silent until a long session stalls. Say it
          here, where the model was chosen, and make the fix one click away. */}
      {contextUnknown && (
        <button
          className="shrink-0 border-t border-faint px-3 py-2 text-left hover:bg-hover"
          onClick={() => {
            setOpen(false);
            navigate("/settings/agents");
          }}
        >
          <span className="flex items-start gap-1.5">
            <TriangleAlert size={12} className="mt-0.5 shrink-0 text-warn" />
            <span className="text-xs">
              <span className="block font-medium text-text">
                {t("composer.model.unknownContextTitle")}
              </span>
              <span className="mt-0.5 block text-muted">
                {t("composer.model.unknownContextBody")}
              </span>
            </span>
          </span>
        </button>
      )}

      {/* Manage providers */}
      <button
        className="shrink-0 border-t border-faint px-3 py-2 text-left text-xs text-accent hover:underline"
        onClick={() => {
          setOpen(false);
          navigate("/settings/agents");
        }}
      >
        {t("composer.model.manage")}
      </button>
    </div>
  );

  // The agent leads: which one answers decides which models exist at all. A
  // new conversation picks it here; an existing one names it and says how to
  // use another, since its history lives with the agent that wrote it.
  const agentRow = agent && (
    <div className="flex shrink-0 items-end gap-4 border-b border-faint px-3 pt-2.5">
      {agent.locked ? (
        <>
          <span className="pb-2 text-xs font-medium text-text">{agentName}</span>
          <span className="min-w-0 flex-1 truncate pb-2 text-right text-[11px] text-muted">
            {t("composer.agent.locked")}
          </span>
        </>
      ) : (
        <div role="tablist" aria-label={t("composer.agent.aria")} className="no-scrollbar flex min-w-0 flex-1 gap-4 overflow-x-auto">
          {choices.map((c) => {
            const selected = c.id === baseAgent;
            return (
              <button
                key={c.id ?? "opencode"}
                role="tab"
                aria-selected={selected}
                className={cn(
                  "shrink-0 border-b-[1.5px] pb-2 text-xs transition-colors",
                  selected
                    ? "border-accent font-medium text-text"
                    : "border-transparent text-muted hover:text-text",
                )}
                onClick={() => {
                  if (!selected) agent.onChange(pick(c.id));
                }}
              >
                {c.name}
              </button>
            );
          })}
          <button
            className="shrink-0 border-b-[1.5px] border-transparent pb-2 text-xs text-muted transition-colors hover:text-text"
            onClick={() => {
              setOpen(false);
              navigate("/settings/agents");
            }}
          >
            {t("composer.agent.more")}
          </button>
        </div>
      )}
      {isMobile && <div className="pb-1.5">{closeButton}</div>}
    </div>
  );

  // An ACP agent's own selectors, each a short list. Before its first session
  // the agent has reported none, so the list says when they arrive.
  const acpBody = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto pb-1">
        {acpOptions.length === 0 ? (
          <p
            className={cn(
              "flex items-start gap-2 px-3 py-5 text-xs leading-relaxed",
              agent?.probe?.status === "error" ? "text-error" : "text-muted",
            )}
          >
            {agent?.probe?.status === "error" ? (
              t("composer.agent.optionsFailed", { agent: agentName, error: agent.probe.error })
            ) : agent?.probe?.status !== "loading" && !agent?.onNeedOptions ? (
              // Nothing to read and nothing being read: the agent offered none.
              t("composer.agent.optionsNone", { agent: agentName })
            ) : agent?.probe?.status === "empty" ? (
              t("composer.agent.optionsNone", { agent: agentName })
            ) : (
              <>
                <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin" />
                {t("composer.agent.optionsLoading", { agent: agentName })}
              </>
            )}
          </p>
        ) : (
          acpOptions.map((option, i) => (
            <section key={option.id} className={cn("px-1 pt-1", i > 0 && "mt-1 border-t border-faint")}>
              <div className="px-2 pb-0.5 pt-1.5 text-[11px] text-muted">{option.name ?? option.id}</div>
              {option.options!.map((v) => {
                const isCurrent = v.value === option.currentValue;
                return (
                  <button
                    key={v.value}
                    disabled={agent?.busy}
                    title={v.description}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-input px-2 py-1.5 text-left disabled:opacity-50",
                      isCurrent ? "bg-surface-2" : "hover:bg-surface-2",
                    )}
                    onClick={() => {
                      if (!isCurrent) agent!.onOption(option.id, v.value);
                    }}
                  >
                    <Check size={13} className={cn("shrink-0 text-accent", isCurrent ? "" : "opacity-0")} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-text">{v.name ?? v.value}</span>
                      {v.description && (
                        <span className="block truncate text-[11px] text-muted">{v.description}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </section>
          ))
        )}
      </div>
      <button
        className="shrink-0 border-t border-faint px-3 py-2 text-left text-xs text-accent hover:underline"
        onClick={() => {
          setOpen(false);
          navigate("/settings/agents");
        }}
      >
        {t("composer.agent.manage")}
      </button>
    </div>
  );

  // Which account a new conversation runs as. Shown only when there is a
  // choice: one login is the common case and needs no row.
  const accountRow = agent && !agent.locked && accountKind && baseAgent && (accounts?.accounts.length ?? 0) > 0 && (
    <div
      role="tablist"
      aria-label={t("composer.agent.accountAria")}
      className="no-scrollbar flex shrink-0 gap-3 overflow-x-auto border-b border-faint px-3 py-1.5"
    >
      {[null, ...(accounts?.accounts ?? []).map((a) => a.id)].map((id) => {
        const selected = (split?.account ?? null) === id;
        const label =
          id === null
            ? accountLabel(accounts?.default, t("composer.agent.defaultAccount"))
            : accountLabel(accounts?.accounts.find((a) => a.id === id), id);
        return (
          <button
            key={id ?? "default"}
            role="tab"
            aria-selected={selected}
            className={cn(
              "shrink-0 rounded-input px-1.5 py-0.5 text-[11px] transition-colors",
              selected ? "bg-surface-2 text-text" : "text-muted hover:text-text",
            )}
            onClick={() => {
              if (!selected) agent.onChange(withAccount(baseAgent, id));
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );

  const body = (
    <div className="flex min-h-0 flex-1 flex-col">
      {agentRow}
      {accountRow}
      {acp ? acpBody : opencodeBody}
    </div>
  );

  return (
    // `min-w-0`, NOT `shrink-0`: this chip carries the longest text in the
    // toolbar ("Kimi For Coding High…"), so it is the one that must give way.
    // While it refused to shrink, the whole action row wrapped onto a second
    // line and left the send button stranded below the other controls.
    <div className="relative min-w-0" ref={rootRef}>
      {/* Chip trigger */}
      <button
        aria-label={t("composer.model.aria")}
        // A retired model fails every turn: say so on the chip, where it shows
        // without opening the picker, not only inside it.
        title={
          acp
            ? t("composer.agent.title")
            : currentRetired
              ? t("composer.model.retiredTitle")
              : t("composer.model.title")
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          "flex h-7 min-w-0 items-center rounded-full text-xs text-muted hover:bg-surface-2 hover:text-text",
          compact ? "gap-0.5 px-1.5" : "gap-1.5 px-2.5",
        )}
        onClick={() => setOpen((o) => !o)}
      >
        {switching && !acp ? (
          <Loader2 size={12} className="shrink-0 animate-spin" />
        ) : acp ? (
          <Bot size={12} className="shrink-0" />
        ) : currentRetired ? (
          <TriangleAlert size={12} className="shrink-0 text-warn" aria-hidden />
        ) : (
          <Cpu size={12} className="shrink-0" />
        )}
        {!compact && <span className="truncate text-text">{chipLabel}</span>}
        {!compact && !acp && activeVariant && (
          <span className="shrink-0 text-muted">· {labelVariant(activeVariant)}</span>
        )}
        {!compact && <ChevronDown size={11} className="shrink-0" />}
      </button>

      {/* Desktop / wide-web: anchored popover above the chip */}
      {open && !isMobile && (
        <div
          role="dialog"
          aria-label={t("composer.model.title")}
          className="absolute bottom-full right-0 z-30 mb-2 flex max-h-[min(70vh,26rem)] w-[340px] flex-col overflow-hidden rounded-card border border-border bg-surface shadow-pop"
        >
          {body}
        </div>
      )}

      {/* Mobile: bottom sheet + scrim */}
      {open && isMobile && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            role="dialog"
            aria-label={t("composer.model.title")}
            className="fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col overflow-hidden rounded-t-card border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] shadow-pop"
          >
            {body}
          </div>
        </>
      )}
    </div>
  );
}
