// Providers as seen from the gateway-served web client (#119). Every write on
// that surface — API key, custom endpoint, remove — is refused by the gateway by
// design (secrets never cross the wire), so the controls must not be there at
// all: a user who submits the custom-endpoint form gets a bare 403 and reads it
// as their own API key being rejected.
//
// `window.__OS_WEB__` is set before the imports rather than mocked: the flag is
// read once at module load (that is the real thing being exercised), and every
// module branching on it holds its own copy.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "@ai4s/sdk";

(window as unknown as { __OS_WEB__?: boolean }).__OS_WEB__ = true;

const i18n = (await import("@/i18n")).default;
const runtime = await import("@/lib/runtime");
const { useRuntimeStore } = runtime;
const { SettingsPage } = await import("./SettingsPage");

const providers: ProviderInfo[] = [
  { id: "opencode", name: "OpenCode Zen", models: [{ id: "grok-code", name: "Grok Code" }] },
  { id: "openai", name: "OpenAI", models: [{ id: "gpt-5.2", name: "GPT-5.2" }] },
];

function webClient() {
  return {
    listProviders: vi.fn().mockResolvedValue(providers),
    listAuthMethods: vi.fn().mockResolvedValue({}),
    listProviderCatalog: vi.fn().mockResolvedValue({ all: [] }),
    listCustomProviderIds: vi.fn().mockResolvedValue([]),
    listMcpServers: vi.fn().mockResolvedValue([]),
    getProviderRegion: vi.fn().mockResolvedValue(null),
  } as unknown as NonNullable<ReturnType<typeof runtime.getClient>>;
}

let view: ReturnType<typeof render> | undefined;

describe("Providers in the gateway web client", () => {
  const initialRuntime = useRuntimeStore.getState();

  beforeEach(async () => {
    vi.spyOn(runtime, "getClient").mockReturnValue(webClient());
    useRuntimeStore.setState({ status: "ready", defaultModel: "openai/gpt-5.2", switching: false });
    await i18n.changeLanguage("en");
    await act(async () => {
      view = render(
        <MemoryRouter initialEntries={["/settings/models"]}>
          <Routes>
            <Route path="/settings/:section" element={<SettingsPage />} />
          </Routes>
        </MemoryRouter>,
      );
    });
    await userEvent.click(screen.getByRole("button", { name: "Manage" }));
  });

  afterEach(() => {
    view?.unmount();
    view = undefined;
    vi.restoreAllMocks();
    useRuntimeStore.setState(initialRuntime, true);
  });

  it("shows what is connected and where to change it", async () => {
    // Scoped to the card: the provider names also appear in the model browser.
    const card = screen.getByRole("heading", { level: 2, name: "Providers" }).closest("section")!;
    expect(within(card).getByText("OpenCode Zen")).toBeInTheDocument();
    expect(within(card).getByText("OpenAI")).toBeInTheDocument();
    expect(within(card).getByText(/osd auth set/)).toBeInTheDocument();
    expect(
      within(card).getByText("Connected providers — read-only from the browser"),
    ).toBeInTheDocument();
  });

  it("offers none of the writes the gateway refuses", () => {
    // Custom endpoint (PATCH /global/config with a provider block → 403).
    expect(screen.queryByRole("button", { name: /Custom endpoint/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add endpoint" })).not.toBeInTheDocument();
    // Connecting a provider (POST /auth → 403).
    expect(screen.queryByPlaceholderText(/Connect a provider/)).not.toBeInTheDocument();
    // Removing one (DELETE /auth, config write → 403).
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });
});
