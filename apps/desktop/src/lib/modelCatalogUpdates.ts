// Keeping the picker's model list current.
//
// The app downloads the model catalog itself (Rust `model_catalog`); the runtime
// reads it only when it starts. This store shows how fresh the list is, lets the
// user check now, and loads a list that brought new models for the user's own
// providers by restarting the runtime, but only while no reply is running.
//
// Desktop calls Tauri commands, the web client the gateway's `/v1/model-catalog`
// routes; both reach the same Rust code, so the two always agree.

import { create } from "zustand";
import { isTauri, runtimeStartedAt, startRuntime } from "./tauri";
import { gatewayGet, gatewayPost, isGatewayWeb } from "./webMode";
import { useRuntimeStore } from "./runtime";

export interface CatalogError {
  kind: "timeout" | "proxy" | "offline" | "server" | "invalid" | string;
  message: string;
  at: number;
}

export interface CatalogStatus {
  updatedAt: number | null;
  checking: boolean;
  lastError: CatalogError | null;
  newModels: { key: string; at: number }[];
  runtimeStartedAt: number;
}

type ApplyOutcome = "current" | "busy" | "applied";

/**
 * - idle: nothing to say beyond the list's age
 * - checking: a check the user asked for is running
 * - upToDate: that check found nothing new (shown briefly)
 * - failed: that check failed
 * - waiting: new models are downloaded; a reply is running
 * - applying: the runtime is restarting on the new list
 * - applied: new models arrived; shown until the user has seen them
 */
export type CatalogPhase =
  | "idle"
  | "checking"
  | "upToDate"
  | "failed"
  | "waiting"
  | "applying"
  | "applied";

/** A list this old with a failed last update gets a notice. */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** A list this old is worth offering a check when a search finds nothing. */
export const CHECK_OFFER_AFTER_MS = 24 * 60 * 60 * 1000;
const POLL_MS = 60 * 1000;
const UP_TO_DATE_MS = 3000;

async function call<T>(command: string, method: "GET" | "POST", path: string): Promise<T | null> {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command);
  }
  if (isGatewayWeb) {
    return method === "GET" ? gatewayGet<T>(path) : gatewayPost<T>(path, {});
  }
  return null; // plain browser dev: no catalog to manage
}

const api = {
  status: () => call<CatalogStatus>("model_catalog_status", "GET", "/v1/model-catalog"),
  refresh: () => call<CatalogStatus>("model_catalog_refresh", "POST", "/v1/model-catalog/refresh"),
  apply: async (): Promise<ApplyOutcome | null> => {
    if (isTauri) return call<ApplyOutcome>("model_catalog_apply", "POST", "");
    const body = await call<{ outcome: ApplyOutcome }>("", "POST", "/v1/model-catalog/apply");
    return body?.outcome ?? null;
  },
};

/** New models the running runtime has not loaded yet, for providers the user
 *  has connected. Others (a provider they never use) are no reason to restart. */
export function pendingModels(status: CatalogStatus | null, providerIds: string[]): string[] {
  if (!status) return [];
  const connected = new Set(providerIds);
  return status.newModels
    .filter((m) => m.at > status.runtimeStartedAt && connected.has(m.key.split("/")[0]))
    .map((m) => m.key);
}

interface CatalogState {
  status: CatalogStatus | null;
  phase: CatalogPhase;
  /** How many models the last load brought (for "3 new models"). */
  arrived: number;
  /** Set when new models arrive; the picker opens on the New filter once. */
  openOnNew: boolean;
  load: () => Promise<void>;
  /** The user's "check for new models". */
  refresh: () => Promise<void>;
  /** Load downloaded new models now, if nothing is running. */
  apply: () => Promise<void>;
  /** The picker closed after showing `applied` / `upToDate` / `failed`. */
  acknowledge: () => void;
  consumeOpenOnNew: () => boolean;
}

let upToDateTimer: ReturnType<typeof setTimeout> | null = null;

export const useModelCatalog = create<CatalogState>((set, get) => ({
  status: null,
  phase: "idle",
  arrived: 0,
  openOnNew: false,

  load: async () => {
    try {
      const status = await api.status();
      if (!status) return;
      set({ status });
    } catch {
      return; // an unreachable status is no reason to show anything
    }
    await get().apply();
  },

  refresh: async () => {
    if (get().phase === "checking" || get().phase === "applying") return;
    if (upToDateTimer) clearTimeout(upToDateTimer);
    set({ phase: "checking" });
    let status: CatalogStatus | null;
    try {
      status = await api.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((s) => ({
        phase: "failed",
        status: s.status && {
          ...s.status,
          lastError: { kind: "offline", message, at: Date.now() },
        },
      }));
      return;
    }
    if (!status) {
      set({ phase: "idle" });
      return;
    }
    set({ status });
    if (status.lastError) {
      set({ phase: "failed" });
      return;
    }
    const providerIds = useRuntimeStore.getState().providers.map((p) => p.id);
    if (pendingModels(status, providerIds).length > 0) {
      set({ phase: "idle" });
      await get().apply();
      return;
    }
    set({ phase: "upToDate" });
    upToDateTimer = setTimeout(() => {
      if (get().phase === "upToDate") set({ phase: "idle" });
    }, UP_TO_DATE_MS);
  },

  apply: async () => {
    const { status, phase } = get();
    if (phase === "applying" || phase === "checking") return;
    const runtime = useRuntimeStore.getState();
    const pending = pendingModels(
      status,
      runtime.providers.map((p) => p.id),
    );
    if (pending.length === 0) return;
    // This window's own replies are known without asking; the Rust side checks
    // every project's runtime as well, which covers replies started elsewhere.
    if (Object.keys(runtime.runningSessions).length > 0) {
      set({ phase: "waiting", arrived: pending.length });
      return;
    }
    set({ phase: "applying", arrived: pending.length });
    let outcome: ApplyOutcome | null = null;
    try {
      await runtime.reloadRuntimeConfig(async () => {
        outcome = await api.apply();
        if (outcome === "applied" && isTauri) {
          // The restarted runtime listens on a new port.
          const url = await startRuntime();
          if (url) useRuntimeStore.getState().setServerUrl(url);
          useRuntimeStore.setState({ runtimeStartedAt: await runtimeStartedAt() });
        }
      });
    } catch {
      outcome = null;
    }
    const after = await api.status().catch(() => null);
    if (after) set({ status: after });
    if (outcome === "applied") set({ phase: "applied", openOnNew: true });
    else if (outcome === "busy") set({ phase: "waiting" });
    else set({ phase: "idle" });
  },

  acknowledge: () => {
    const phase = get().phase;
    if (phase === "applied" || phase === "failed" || phase === "upToDate") set({ phase: "idle" });
  },

  consumeOpenOnNew: () => {
    if (!get().openOnNew) return false;
    set({ openOnNew: false });
    return true;
  },
}));

let watching = false;

/** Start polling once per window: the app's own background check (on launch,
 *  then every 6 h) lands without anyone asking, and a reply finishing is the
 *  moment a waiting list can load. */
export function watchModelCatalog(): void {
  if (watching || (!isTauri && !isGatewayWeb)) return;
  watching = true;
  void useModelCatalog.getState().load();
  setInterval(() => void useModelCatalog.getState().load(), POLL_MS);
  useRuntimeStore.subscribe((s, prev) => {
    const wasRunning = Object.keys(prev.runningSessions).length > 0;
    const running = Object.keys(s.runningSessions).length > 0;
    if (wasRunning && !running && useModelCatalog.getState().phase === "waiting") {
      void useModelCatalog.getState().apply();
    }
  });
}
