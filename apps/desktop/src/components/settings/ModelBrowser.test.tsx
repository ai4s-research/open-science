import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "@ai4s/sdk";
import { loadModelPreferences } from "./modelPreferences";
import { ModelBrowser } from "./ModelBrowser";

const providers: ProviderInfo[] = [
  { id: "openai", name: "OpenAI", models: [
    { id: "gpt-5.2", name: "GPT-5.2" },
    { id: "o3", name: "o3" },
  ] },
  { id: "ollama", name: "Ollama Cloud", models: [
    { id: "qwen3-coder", name: "Qwen3 Coder" },
  ] },
];

describe("ModelBrowser", () => {
  beforeEach(() => window.localStorage.clear());

  it("filters by provider and searches the active filter", async () => {
    render(<ModelBrowser providers={providers} defaultModel={null} busy={false}
      onSelect={vi.fn()} onManageProviders={vi.fn()} />);
    const filters = screen.getByRole("navigation", { name: "Model filters" });
    await userEvent.click(within(filters).getByRole("button", { name: /Ollama Cloud/ }));
    expect(screen.getByRole("button", { name: /^Qwen3 Coder/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /GPT-5.2/ })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search models" }), "missing");
    expect(screen.getByText(/No models match/)).toBeInTheDocument();
  });

  it("favorites without selecting and persists the result", async () => {
    const onSelect = vi.fn<(model: string) => Promise<boolean>>();
    render(<ModelBrowser providers={providers} defaultModel={null} busy={false}
      onSelect={onSelect} onManageProviders={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Add o3 to favorites" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(loadModelPreferences().favorites).toEqual(["openai/o3"]);
    await userEvent.click(screen.getByRole("button", { name: /Favorites/ }));
    expect(screen.getByRole("button", { name: /^o3/ })).toBeInTheDocument();
  });

  it("supports keyboard activation for filters, favorites, and model rows", async () => {
    const onSelect = vi.fn().mockResolvedValue(true);
    render(<ModelBrowser providers={providers} defaultModel={null} busy={false}
      onSelect={onSelect} onManageProviders={vi.fn()} />);

    const filters = screen.getByRole("navigation", { name: "Model filters" });
    const providerFilter = within(filters).getByRole("button", { name: /Ollama Cloud/ });
    providerFilter.focus();
    await userEvent.keyboard("{Enter}");

    const favoriteButton = screen.getByRole("button", { name: "Add Qwen3 Coder to favorites" });
    favoriteButton.focus();
    await userEvent.keyboard(" ");
    expect(loadModelPreferences().favorites).toEqual(["ollama/qwen3-coder"]);
    expect(onSelect).not.toHaveBeenCalled();

    const modelRow = screen.getByRole("button", { name: /^Qwen3 Coder/ });
    modelRow.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("ollama/qwen3-coder"));
  });

  it("blocks repeated selection while pending and records recent only on success", async () => {
    let resolveSelection!: (value: boolean) => void;
    const onSelect = vi.fn(() => new Promise<boolean>((resolve) => { resolveSelection = resolve; }));
    render(<ModelBrowser providers={providers} defaultModel="openai/gpt-5.2" busy={false}
      onSelect={onSelect} onManageProviders={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /^o3/ }));
    expect(screen.getByText("Switching…")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Qwen3 Coder/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    resolveSelection(true);
    await waitFor(() => expect(loadModelPreferences().recent).toEqual(["openai/o3"]));
  });

  it("does not update recent history when selection fails", async () => {
    const onSelect = vi.fn().mockResolvedValue(false);
    render(<ModelBrowser providers={providers} defaultModel="openai/gpt-5.2" busy={false}
      onSelect={onSelect} onManageProviders={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /^o3/ }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("openai/o3"));
    expect(loadModelPreferences().recent).toEqual([]);
  });

  it("contains rejected selections as failed attempts", async () => {
    const onSelect = vi.fn().mockRejectedValue(new Error("selection failed"));
    render(<ModelBrowser providers={providers} defaultModel="openai/gpt-5.2" busy={false}
      onSelect={onSelect} onManageProviders={vi.fn()} />);

    const modelRow = screen.getByRole("button", { name: /^o3/ });
    const favoriteButton = screen.getByRole("button", { name: "Add o3 to favorites" });
    await userEvent.click(modelRow);

    expect(onSelect).toHaveBeenCalledWith("openai/o3");
    await waitFor(() => expect(modelRow).toBeEnabled());
    expect(favoriteButton).toBeEnabled();
    expect(loadModelPreferences().recent).toEqual([]);
  });

  it("shows an unavailable configured default and exposes provider management when empty", () => {
    const onManageProviders = vi.fn();
    const { rerender } = render(<ModelBrowser providers={providers} defaultModel="gone/model" busy={false}
      onSelect={vi.fn()} onManageProviders={onManageProviders} />);
    expect(screen.getByText(/Configured model unavailable: gone\/model/)).toBeInTheDocument();
    rerender(<ModelBrowser providers={[]} defaultModel="gone/model" busy={false}
      onSelect={vi.fn()} onManageProviders={onManageProviders} />);
    expect(screen.getByText(/Configured model unavailable: gone\/model/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage providers" })).toBeInTheDocument();
  });

  it("keeps focus on the clicked row through the pending switch (no drop to body)", async () => {
    let resolveSelection!: (value: boolean) => void;
    const onSelect = vi.fn(() => new Promise<boolean>((resolve) => { resolveSelection = resolve; }));
    render(<ModelBrowser providers={providers} defaultModel="openai/gpt-5.2" busy={false}
      onSelect={onSelect} onManageProviders={vi.fn()} />);

    const row = screen.getByRole("button", { name: /^o3/ });
    row.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByText("Switching…")).toBeInTheDocument();
    // A DOM-disabled button leaves the tab order and browsers drop focus to
    // <body>, stranding keyboard users mid-switch — rows must stay enabled
    // and block interaction via aria-disabled + the click guard instead.
    expect(row).toBeEnabled();
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveFocus();
    resolveSelection(true);
    await waitFor(() => expect(loadModelPreferences().recent).toEqual(["openai/o3"]));
    expect(row).toHaveFocus();
  });

  it("signals when no default model is configured", () => {
    render(<ModelBrowser providers={providers} defaultModel={null} busy={false}
      onSelect={vi.fn()} onManageProviders={vi.fn()} />);
    expect(screen.getByText("Not set — pick a default model")).toBeInTheDocument();
  });

  it("keeps the current model row keyboard-focusable without selecting it again", async () => {
    const onSelect = vi.fn().mockResolvedValue(true);
    render(<ModelBrowser providers={providers} defaultModel="openai/o3" busy={false}
      onSelect={onSelect} onManageProviders={vi.fn()} />);

    const currentRow = screen.getByRole("button", { name: /^o3/ });
    expect(currentRow).toHaveAttribute("aria-current", "true");
    expect(currentRow).toHaveAttribute("aria-disabled", "true");
    expect(currentRow).toBeEnabled();
    currentRow.focus();
    expect(currentRow).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onSelect).not.toHaveBeenCalled();
  });
});
