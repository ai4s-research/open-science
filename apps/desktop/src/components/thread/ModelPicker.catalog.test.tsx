import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "@ai4s/sdk";
import { useRuntimeStore } from "@/lib/runtime";
import { useModelCatalog, type CatalogStatus } from "@/lib/modelCatalogUpdates";
import { ModelPicker } from "./ModelPicker";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const providers: ProviderInfo[] = [
  {
    id: "openai",
    name: "OpenAI",
    models: [
      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", contextLimit: 400000 },
      { id: "gpt-6.1-terra", name: "GPT-6.1 Terra", contextLimit: 400000 },
    ],
  },
];

const status = (over: Partial<CatalogStatus> = {}): CatalogStatus => ({
  updatedAt: Date.now() - 2 * HOUR,
  checking: false,
  lastError: null,
  newModels: [],
  runtimeStartedAt: Date.now(),
  ...over,
});

const open = async () => {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <ModelPicker />
    </MemoryRouter>,
  );
  await user.click(screen.getByRole("button", { name: /switch model/i }));
  return { user, dialog: screen.getByRole("dialog") };
};

describe("ModelPicker model list freshness", () => {
  const initialRuntime = useRuntimeStore.getState();
  const initialCatalog = useModelCatalog.getState();
  let refresh: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    useRuntimeStore.setState({ providers, defaultModel: "openai/gpt-6.1-sol", switching: false });
    refresh = vi.fn(async () => {});
    useModelCatalog.setState({ status: status(), phase: "idle", refresh: refresh as never });
  });
  afterEach(() => {
    useRuntimeStore.setState(initialRuntime, true);
    useModelCatalog.setState(initialCatalog, true);
  });

  it("states the list's age in the footer and checks on click", async () => {
    const { user, dialog } = await open();
    await user.click(within(dialog).getByRole("button", { name: /updated 2h ago/i }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(within(dialog).queryByText(/days old/i)).not.toBeInTheDocument();
  });

  it("marks models that just arrived and opens on them once", async () => {
    useModelCatalog.setState({
      status: status({ newModels: [{ key: "openai/gpt-6.1-terra", at: Date.now() }] }),
      phase: "applied",
      arrived: 1,
      openOnNew: true,
    });
    const { dialog } = await open();
    expect(within(dialog).getByRole("button", { name: "New 1" })).toHaveClass("text-accent");
    expect(within(dialog).queryByText("GPT-6.1 Sol")).not.toBeInTheDocument();
    expect(within(dialog).getByText("GPT-6.1 Terra")).toBeInTheDocument();
    expect(within(dialog).getByText("1 new model")).toBeInTheDocument();
  });

  it("a search that finds nothing offers a check when the list is old", async () => {
    useModelCatalog.setState({ status: status({ updatedAt: Date.now() - 12 * DAY }) });
    const { user, dialog } = await open();
    await user.type(within(dialog).getByPlaceholderText(/search models/i), "gpt 6.2");
    expect(within(dialog).getByText("0 results for gpt 6.2")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Check for new models" }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("a fresh list does not offer a check on a missed search", async () => {
    const { user, dialog } = await open();
    await user.type(within(dialog).getByPlaceholderText(/search models/i), "gpt 6.2");
    expect(within(dialog).getByText("0 results for gpt 6.2")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Check for new models" })).not.toBeInTheDocument();
  });

  it("an old list whose updates fail gets a notice", async () => {
    useModelCatalog.setState({
      status: status({
        updatedAt: Date.now() - 12 * DAY,
        lastError: { kind: "timeout", message: "operation timed out", at: Date.now() },
      }),
    });
    const { dialog } = await open();
    expect(within(dialog).getByText("Model list is 12 days old")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("a failed check says why and offers a retry", async () => {
    useModelCatalog.setState({
      status: status({ lastError: { kind: "proxy", message: "connection refused", at: Date.now() } }),
      phase: "failed",
    });
    const { user, dialog } = await open();
    const retry = within(dialog).getByRole("button", { name: /proxy refused the update/i });
    expect(retry).toHaveAttribute("title", "connection refused");
    await user.click(retry);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("new models waiting on a reply say so", async () => {
    useModelCatalog.setState({ phase: "waiting", arrived: 3 });
    const { dialog } = await open();
    expect(within(dialog).getByText("3 new models after this reply")).toBeInTheDocument();
  });
});
