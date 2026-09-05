import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "@ai4s/sdk";
import {
  listProvidersWithAvailability,
  markZenAvailability,
  resetZenModelCache,
  zenServedModels,
} from "./zenModels";

const env = vi.hoisted(() => ({
  isTauri: true,
  isGatewayWeb: false,
  servedIds: vi.fn<() => Promise<string[]>>(),
  gatewayGet: vi.fn<() => Promise<{ models?: string[] } | null>>(),
}));

vi.mock("./tauri", () => ({
  get isTauri() {
    return env.isTauri;
  },
  zenServedModelIds: env.servedIds,
}));

vi.mock("./webMode", () => ({
  get isGatewayWeb() {
    return env.isGatewayWeb;
  },
  gatewayGet: env.gatewayGet,
}));

const providers: ProviderInfo[] = [
  {
    id: "opencode",
    name: "OpenCode Zen",
    models: [
      { id: "mimo-v2.5-free", name: "MiMo v2.5 (free)" },
      { id: "ling-3.0-flash-free", name: "Ling 3.0 Flash (free)" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    models: [{ id: "claude-opus-5", name: "Claude Opus 5" }],
  },
];

beforeEach(() => {
  resetZenModelCache();
  env.isTauri = true;
  env.isGatewayWeb = false;
  env.servedIds.mockReset();
  env.gatewayGet.mockReset();
});

describe("markZenAvailability", () => {
  it("marks only the Zen models the gateway still serves", () => {
    const marked = markZenAvailability(providers, new Set(["mimo-v2.5-free"]));
    expect(marked[0].models.map((m) => [m.id, m.available])).toEqual([
      ["mimo-v2.5-free", true],
      ["ling-3.0-flash-free", false],
    ]);
  });

  it("leaves other providers alone — the list only speaks for Zen", () => {
    const marked = markZenAvailability(providers, new Set(["mimo-v2.5-free"]));
    expect(marked[1]).toBe(providers[1]);
  });

  it("marks nothing when availability is unknown, so a failed lookup hides no models", () => {
    expect(markZenAvailability(providers, null)).toBe(providers);
  });

  it("distrusts a list that recognises none of the models — that is wrong, not retired", () => {
    expect(markZenAvailability(providers, new Set(["something-else-entirely"]))).toBe(providers);
  });

  it("does nothing when Zen is not connected at all", () => {
    const others: ProviderInfo[] = [providers[1]];
    expect(markZenAvailability(others, new Set(["mimo-v2.5-free"]))).toBe(others);
  });
});

describe("zenServedModels", () => {
  it("asks the desktop side and caches the answer", async () => {
    env.servedIds.mockResolvedValue(["mimo-v2.5-free", "hy3-free"]);
    expect([...((await zenServedModels()) ?? [])]).toEqual(["mimo-v2.5-free", "hy3-free"]);
    expect(await zenServedModels()).not.toBeNull();
    expect(env.servedIds).toHaveBeenCalledTimes(1);
  });

  it("shares one request between concurrent callers", async () => {
    env.servedIds.mockResolvedValue(["hy3-free"]);
    await Promise.all([zenServedModels(), zenServedModels(), zenServedModels()]);
    expect(env.servedIds).toHaveBeenCalledTimes(1);
  });

  it("reads a failure as unknown rather than as an empty catalog", async () => {
    env.servedIds.mockRejectedValue(new Error("offline"));
    expect(await zenServedModels()).toBeNull();
  });

  it("reads an empty list as unknown too — it would otherwise hide every model", async () => {
    env.servedIds.mockResolvedValue([]);
    expect(await zenServedModels()).toBeNull();
  });

  it("goes through the gateway in web mode", async () => {
    env.isTauri = false;
    env.isGatewayWeb = true;
    env.gatewayGet.mockResolvedValue({ models: ["hy3-free"] });
    expect([...((await zenServedModels()) ?? [])]).toEqual(["hy3-free"]);
    expect(env.gatewayGet).toHaveBeenCalledWith("/v1/zen-models");
  });

  it("stays unknown where nothing can ask (plain browser dev)", async () => {
    env.isTauri = false;
    env.isGatewayWeb = false;
    expect(await zenServedModels()).toBeNull();
    expect(env.servedIds).not.toHaveBeenCalled();
    expect(env.gatewayGet).not.toHaveBeenCalled();
  });
});

describe("listProvidersWithAvailability", () => {
  it("returns the catalog with retired Zen models marked", async () => {
    env.servedIds.mockResolvedValue(["mimo-v2.5-free"]);
    const client = { listProviders: vi.fn(async () => providers) };
    const result = await listProvidersWithAvailability(client);
    expect(result[0].models.find((m) => m.id === "ling-3.0-flash-free")?.available).toBe(false);
  });

  it("still returns the catalog when the availability lookup fails", async () => {
    env.servedIds.mockRejectedValue(new Error("offline"));
    const client = { listProviders: vi.fn(async () => providers) };
    expect(await listProvidersWithAvailability(client)).toBe(providers);
  });
});
