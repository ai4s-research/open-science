import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "@ai4s/sdk";
import i18n from "@/i18n";
import * as runtime from "@/lib/runtime";
import { useRuntimeStore } from "@/lib/runtime";
import { useSetupStore } from "@/lib/setup";
import { useToastStore } from "@/lib/toast";
import { loadModelPreferences } from "@/components/settings/modelPreferences";
import { Toaster } from "@/components/ui/Toaster";
import { SettingsPage } from "./SettingsPage";

const providers: ProviderInfo[] = [
  {
    id: "openai",
    name: "OpenAI",
    models: [
      { id: "gpt-5.2", name: "GPT-5.2" },
      { id: "o3", name: "o3" },
    ],
  },
];

let activeView: ReturnType<typeof render> | undefined;

function catalogClient(listProviders = vi.fn().mockResolvedValue(providers)) {
  return {
    listProviders,
    listAuthMethods: vi.fn().mockResolvedValue({}),
    listProviderCatalog: vi.fn().mockResolvedValue({ all: [] }),
    listCustomProviderIds: vi.fn().mockResolvedValue([]),
    listMcpServers: vi.fn().mockResolvedValue([]),
  } as unknown as NonNullable<ReturnType<typeof runtime.getClient>>;
}

async function renderSettings() {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <>
        <SettingsPage />
        <Toaster />
      </>,
    );
  });
  activeView = view;
  return view;
}

describe("Settings model browser integration", () => {
  const initialRuntime = useRuntimeStore.getState();
  const initialSetup = useSetupStore.getState();

  beforeEach(async () => {
    window.localStorage.clear();
    useToastStore.setState({ toasts: [] });
    useSetupStore.setState({ generation: 0 });
    useRuntimeStore.setState({ status: "ready", defaultModel: "openai/gpt-5.2", switching: false });
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    activeView?.unmount();
    activeView = undefined;
    vi.restoreAllMocks();
    useToastStore.setState({ toasts: [] });
    useSetupStore.setState(initialSetup, true);
    useRuntimeStore.setState(initialRuntime, true);
  });

  it("shows a localized unavailable state when the initial provider refresh fails", async () => {
    vi.spyOn(runtime, "getClient").mockReturnValue(
      catalogClient(vi.fn().mockRejectedValue(new Error("catalog offline"))),
    );

    await renderSettings();

    expect(await screen.findByText("The model catalog is currently unavailable.")).toBeInTheDocument();
    expect(screen.queryByText("No models available.")).not.toBeInTheDocument();
  });

  it("retains the last successful model list when a later provider refresh fails", async () => {
    const listProviders = vi.fn()
      .mockResolvedValueOnce(providers)
      .mockRejectedValueOnce(new Error("catalog offline"));
    vi.spyOn(runtime, "getClient").mockReturnValue(catalogClient(listProviders));
    await renderSettings();
    expect(await screen.findByRole("button", { name: /^o3/ })).toBeInTheDocument();

    await act(async () => useSetupStore.setState({ generation: 1 }));

    await waitFor(() => expect(listProviders).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: /^o3/ })).toBeInTheDocument();
    expect(screen.queryByText("The model catalog is currently unavailable.")).not.toBeInTheDocument();
  });

  it("keeps the runtime default and error semantics after a post-write reconnect failure", async () => {
    vi.spyOn(runtime, "getClient").mockReturnValue(catalogClient());
    const reconnectFailure = vi.fn(async (model: string) => {
      useRuntimeStore.setState({ defaultModel: model, switching: true });
      await Promise.resolve();
      useRuntimeStore.setState({ switching: false });
      throw new Error("reconnect failed");
    });
    useRuntimeStore.setState({ setDefaultModel: reconnectFailure });
    await renderSettings();
    const targetRow = await screen.findByRole("button", { name: /^o3/ });

    await userEvent.click(targetRow);

    await waitFor(() => expect(reconnectFailure).toHaveBeenCalledWith("openai/o3"));
    expect(useRuntimeStore.getState().defaultModel).toBe("openai/o3");
    const currentRow = screen.getByRole("button", { name: /^o3/ });
    expect(within(currentRow).getByText("Current default")).toBeInTheDocument();
    expect(currentRow).toBeEnabled();
    expect(screen.getByRole("button", { name: /^GPT-5.2/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add o3 to favorites" })).toBeEnabled();
    expect(loadModelPreferences().recent).toEqual([]);
    expect(screen.getByText("Could not set the model: reconnect failed")).toBeInTheDocument();
  });
});
