import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "@ai4s/sdk";
import { useRuntimeStore } from "./runtime";
import { pendingModels, useModelCatalog, type CatalogStatus } from "./modelCatalogUpdates";

const env = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string) => Promise<unknown>>(),
  startRuntime: vi.fn(async () => "http://127.0.0.1:5001"),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: env.invoke }));
vi.mock("./tauri", async (orig) => ({
  ...(await orig<typeof import("./tauri")>()),
  isTauri: true,
  startRuntime: env.startRuntime,
  runtimeStartedAt: async () => 5000,
}));

const providers = [
  { id: "openai", name: "OpenAI", models: [] },
  { id: "anthropic", name: "Anthropic", models: [] },
] as ProviderInfo[];

const status = (over: Partial<CatalogStatus> = {}): CatalogStatus => ({
  updatedAt: 2000,
  checking: false,
  lastError: null,
  newModels: [],
  runtimeStartedAt: 1000,
  ...over,
});

describe("pendingModels", () => {
  it("counts only models downloaded after the runtime started, for connected providers", () => {
    const st = status({
      runtimeStartedAt: 1000,
      newModels: [
        { key: "openai/gpt-6.1-terra", at: 2000 },
        { key: "openai/gpt-6.1-sol", at: 500 }, // already loaded
        { key: "xai/grok-5", at: 2000 }, // a provider the user does not use
      ],
    });
    expect(pendingModels(st, ["openai", "anthropic"])).toEqual(["openai/gpt-6.1-terra"]);
    expect(pendingModels(null, ["openai"])).toEqual([]);
  });
});

describe("useModelCatalog", () => {
  const initialRuntime = useRuntimeStore.getState();
  const initialCatalog = useModelCatalog.getState();
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    env.invoke.mockReset();
    reload = vi.fn(async (apply: () => Promise<void>) => apply());
    useRuntimeStore.setState({
      providers,
      runningSessions: {},
      reloadRuntimeConfig: reload as never,
      setServerUrl: vi.fn(),
    });
  });
  afterEach(() => {
    useRuntimeStore.setState(initialRuntime, true);
    useModelCatalog.setState(initialCatalog, true);
  });

  const pending = status({ newModels: [{ key: "openai/gpt-6.1-terra", at: 2000 }] });

  it("waits for a running reply instead of restarting under it", async () => {
    useRuntimeStore.setState({ runningSessions: { ses_1: true } });
    useModelCatalog.setState({ status: pending });
    await useModelCatalog.getState().apply();
    expect(useModelCatalog.getState().phase).toBe("waiting");
    expect(useModelCatalog.getState().arrived).toBe(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it("loads new models when idle, then opens the picker on them once", async () => {
    env.invoke.mockImplementation(async (cmd) =>
      cmd === "model_catalog_apply" ? "applied" : status({ runtimeStartedAt: 5000 }),
    );
    useModelCatalog.setState({ status: pending });
    await useModelCatalog.getState().apply();
    expect(reload).toHaveBeenCalledOnce();
    expect(env.startRuntime).toHaveBeenCalled();
    expect(useModelCatalog.getState().phase).toBe("applied");
    expect(useModelCatalog.getState().consumeOpenOnNew()).toBe(true);
    expect(useModelCatalog.getState().consumeOpenOnNew()).toBe(false);
  });

  it("keeps waiting when the runtime reports a reply elsewhere", async () => {
    env.invoke.mockImplementation(async (cmd) => (cmd === "model_catalog_apply" ? "busy" : pending));
    useModelCatalog.setState({ status: pending });
    await useModelCatalog.getState().apply();
    expect(useModelCatalog.getState().phase).toBe("waiting");
  });

  it("does nothing for new models of providers the user has not connected", async () => {
    useModelCatalog.setState({ status: status({ newModels: [{ key: "xai/grok-5", at: 2000 }] }) });
    await useModelCatalog.getState().apply();
    expect(reload).not.toHaveBeenCalled();
    expect(useModelCatalog.getState().phase).toBe("idle");
  });

  it("a check that finds nothing says so, one that fails keeps the reason", async () => {
    env.invoke.mockResolvedValueOnce(status({ updatedAt: 9000 }));
    await useModelCatalog.getState().refresh();
    expect(useModelCatalog.getState().phase).toBe("upToDate");

    const lastError = { kind: "timeout", message: "operation timed out", at: 9500 };
    env.invoke.mockResolvedValueOnce(status({ lastError }));
    await useModelCatalog.getState().refresh();
    expect(useModelCatalog.getState().phase).toBe("failed");
    expect(useModelCatalog.getState().status?.lastError).toEqual(lastError);

    useModelCatalog.getState().acknowledge();
    expect(useModelCatalog.getState().phase).toBe("idle");
  });
});
