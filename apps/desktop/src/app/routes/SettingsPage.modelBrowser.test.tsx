import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "@ai4s/sdk";
import i18n from "@/i18n";
import * as runtime from "@/lib/runtime";
import { useRuntimeStore } from "@/lib/runtime";
import { useSetupStore } from "@/lib/setup";
import { useToastStore } from "@/lib/toast";
import { loadModelPreferences, saveModelPreferences } from "@/components/settings/modelPreferences";
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

  it("shows the connect prompt when the runtime errors before any model switch happened", async () => {
    // First boot with a dead sidecar: status "error", defaultModel null,
    // modelSwitchError null. The browser must NOT appear (the old page-local
    // sentinel compared null === null here and showed an empty browser).
    useRuntimeStore.setState({ status: "error", defaultModel: null, modelSwitchError: null });

    await renderSettings();

    expect(screen.getByText("Connect the runtime to configure models.")).toBeInTheDocument();
    expect(screen.queryByText("No models available.")).not.toBeInTheDocument();
  });

  it("keeps the browser up through an immediately-rejected retry after a failed switch", async () => {
    vi.spyOn(runtime, "getClient").mockReturnValue(catalogClient());
    // A dead server per the store contract: every attempt rejects AND records
    // modelSwitchError (the store owns the failure fact now).
    const deadSwitch = vi.fn(async () => {
      useRuntimeStore.setState({ modelSwitchError: "Load failed" });
      throw new Error("Load failed");
    });
    useRuntimeStore.setState({ setDefaultModel: deadSwitch });
    await renderSettings();
    await screen.findByRole("button", { name: /^o3/ });

    await userEvent.click(screen.getByRole("button", { name: /^o3/ }));
    await waitFor(() => expect(deadSwitch).toHaveBeenCalledTimes(1));
    act(() => useRuntimeStore.setState({ status: "error", switching: false }));
    expect(screen.getByRole("searchbox", { name: "Search models" })).toBeInTheDocument();

    // Retrying while the server is still down must not collapse the surface.
    await userEvent.click(screen.getByRole("button", { name: /^o3/ }));
    await waitFor(() => expect(deadSwitch).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("searchbox", { name: "Search models" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^o3/ })).toBeInTheDocument();
  });

  it("shows a loading state, not a false unavailable-model warning, while the catalog loads", async () => {
    let resolveProviders!: (value: ProviderInfo[]) => void;
    const pending = new Promise<ProviderInfo[]>((resolve) => {
      resolveProviders = resolve;
    });
    vi.spyOn(runtime, "getClient").mockReturnValue(
      catalogClient(vi.fn().mockReturnValue(pending)),
    );

    await renderSettings();

    expect(screen.getByText("Loading the model catalog…")).toBeInTheDocument();
    expect(screen.queryByText(/Configured model unavailable/)).not.toBeInTheDocument();
    expect(screen.queryByText("No models available.")).not.toBeInTheDocument();
    await act(async () => resolveProviders(providers));
    expect(await screen.findByRole("button", { name: /^o3/ })).toBeInTheDocument();
  });

  it("shows models when the provider list succeeds even if auxiliary settings calls fail", async () => {
    const client = catalogClient();
    (client as { listAuthMethods: unknown }).listAuthMethods = vi
      .fn()
      .mockRejectedValue(new Error("aux down"));
    vi.spyOn(runtime, "getClient").mockReturnValue(client);

    await renderSettings();

    expect(await screen.findByRole("button", { name: /^o3/ })).toBeInTheDocument();
    expect(screen.queryByText("The model catalog is currently unavailable.")).not.toBeInTheDocument();
  });

  it("drops the cached catalog when the server URL changes (no stale models from the old runtime)", async () => {
    vi.spyOn(runtime, "getClient").mockReturnValue(catalogClient());
    await renderSettings();
    expect(await screen.findByRole("button", { name: /^o3/ })).toBeInTheDocument();

    act(() => useRuntimeStore.getState().setServerUrl("http://127.0.0.1:9999"));

    expect(screen.queryByRole("button", { name: /^o3/ })).not.toBeInTheDocument();
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

  it("hides a cached model snapshot after an ordinary runtime disconnect", async () => {
    vi.spyOn(runtime, "getClient").mockReturnValue(catalogClient());
    await renderSettings();
    expect(await screen.findByRole("searchbox", { name: "Search models" })).toBeInTheDocument();

    act(() => useRuntimeStore.setState({ status: "offline", switching: false }));

    expect(await screen.findByText("Connect the runtime to configure models.")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "Search models" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^o3/ })).not.toBeInTheDocument();
  });

  it("keeps the runtime default and error semantics after a post-write reconnect failure", async () => {
    vi.spyOn(runtime, "getClient").mockReturnValue(catalogClient());
    saveModelPreferences({ favorites: [], recent: ["openai/gpt-5.2"] });
    let exhaustReconnect!: () => void;
    const reconnectFailure = vi.fn((model: string) => new Promise<void>((_resolve, reject) => {
      useRuntimeStore.setState({
        defaultModel: model,
        switching: true,
        status: "connecting",
        error: null,
      });
      exhaustReconnect = () => {
        // Per the store contract, a failed switch records modelSwitchError.
        useRuntimeStore.setState({
          switching: false,
          status: "error",
          error: "reconnect failed",
          modelSwitchError: "reconnect failed",
        });
        reject(new Error("reconnect failed"));
      };
    }));
    useRuntimeStore.setState({ setDefaultModel: reconnectFailure });
    await renderSettings();
    const targetRow = await screen.findByRole("button", { name: /^o3/ });

    await userEvent.click(targetRow);

    await waitFor(() => expect(reconnectFailure).toHaveBeenCalledWith("openai/o3"));
    expect(useRuntimeStore.getState()).toMatchObject({
      defaultModel: "openai/o3",
      switching: true,
      status: "connecting",
    });
    expect(screen.getByRole("searchbox", { name: "Search models" })).toBeInTheDocument();
    expect(screen.getByText("Switching…")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /^o3/ })).getByText("Current default")).toBeInTheDocument();

    await act(async () => exhaustReconnect());

    await waitFor(() => expect(screen.getByText("Could not set the model: reconnect failed")).toBeInTheDocument());
    expect(useRuntimeStore.getState().defaultModel).toBe("openai/o3");
    const currentRow = screen.getByRole("button", { name: /^o3/ });
    expect(within(currentRow).getByText("Current default")).toBeInTheDocument();
    expect(currentRow).toBeEnabled();
    expect(screen.getByRole("button", { name: /^GPT-5.2/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add o3 to favorites" })).toBeEnabled();
    expect(loadModelPreferences().recent).toEqual(["openai/gpt-5.2"]);

    act(() => useRuntimeStore.setState({ status: "offline", switching: false }));
    expect(await screen.findByText("Connect the runtime to configure models.")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "Search models" })).not.toBeInTheDocument();
  });
});
