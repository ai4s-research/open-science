import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "@ai4s/sdk";
import { useRuntimeStore } from "@/lib/runtime";
import { AgentModelsCard } from "./AgentModelsCard";

const models = vi.hoisted(() => ({ current: {} as Record<string, string> }));
const variants = vi.hoisted(() => ({ current: {} as Record<string, string> }));
const setAgentModel = vi.hoisted(() => vi.fn(async () => {}));
const setAgentVariant = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/tauri", () => ({
  getAgentModels: async () => models.current,
  getAgentVariants: async () => variants.current,
  setAgentModel,
  setAgentVariant,
}));

// One reasoning model with its own effort vocabulary, one without any levels.
const providers: ProviderInfo[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    models: [
      { id: "opus", name: "Opus", variants: ["low", "high"] },
      { id: "haiku", name: "Haiku" },
    ],
  },
];

beforeEach(() => {
  models.current = {};
  variants.current = {};
  setAgentModel.mockClear();
  setAgentVariant.mockClear();
  useRuntimeStore.setState({
    agents: [{ name: "reviewer", mode: "subagent" }],
    defaultModel: "anthropic/opus",
    connectRetry: async () => {},
  } as never);
});

describe("AgentModelsCard", () => {
  it("offers the effective model's effort levels and none for a model without any", async () => {
    const first = render(<AgentModelsCard providers={providers} />);
    const effort = await screen.findByLabelText("Reasoning effort for reviewer");
    expect([...effort.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "Default effort",
      "Low",
      "High",
    ]);
    first.unmount();

    // Pinned to a model with no reasoning levels: there is nothing to choose,
    // so the control is not rendered at all.
    models.current = { reviewer: "anthropic/haiku" };
    render(<AgentModelsCard providers={providers} />);
    await screen.findByLabelText("Model for reviewer");
    await waitFor(() =>
      expect(screen.queryByLabelText("Reasoning effort for reviewer")).toBeNull(),
    );
  });

  it("clears a pinned effort the newly chosen model cannot honour", async () => {
    variants.current = { reviewer: "high" };
    render(<AgentModelsCard providers={providers} />);
    const model = await screen.findByLabelText("Model for reviewer");
    await waitFor(() =>
      expect((screen.getByLabelText("Reasoning effort for reviewer") as HTMLSelectElement).value).toBe(
        "high",
      ),
    );

    // "haiku" has no levels at all, so "high" cannot be sent — it is dropped
    // rather than left as a setting the runtime would reject.
    await userEvent.selectOptions(model, "anthropic/haiku");
    await waitFor(() => expect(setAgentVariant).toHaveBeenCalledWith("reviewer", ""));
    expect(setAgentModel).toHaveBeenCalledWith("reviewer", "anthropic/haiku");
  });

  it("reconciles away an effort the runtime upgrade removed (#74)", async () => {
    // A level pinned under the old runtime can simply cease to exist: from 1.18
    // OpenCode derives a model's efforts from the catalog, and models really did
    // lose levels the previous runtime synthesized. The runtime accepts the stale
    // value and then applies nothing, so the row must not keep showing it.
    variants.current = { reviewer: "medium" }; // opus now offers only low/high
    render(<AgentModelsCard providers={providers} />);
    await screen.findByLabelText("Model for reviewer");
    await waitFor(() => expect(setAgentVariant).toHaveBeenCalledWith("reviewer", ""));
    expect(
      (screen.getByLabelText("Reasoning effort for reviewer") as HTMLSelectElement).value,
    ).toBe("");
  });

  it("leaves a pinned effort alone when its model is not in the catalog", async () => {
    // A dangling model (provider signed out, endpoint removed) tells us nothing
    // about which efforts are legal — clearing here would silently discard a
    // setting that becomes valid again the moment the provider returns.
    models.current = { reviewer: "openai/gpt-5.6-sol" };
    variants.current = { reviewer: "max" };
    render(<AgentModelsCard providers={providers} />);
    await screen.findByLabelText("Model for reviewer");
    await waitFor(() => expect(setAgentModel).not.toHaveBeenCalled());
    expect(setAgentVariant).not.toHaveBeenCalled();
  });

  it("keeps a pinned effort the new model still offers", async () => {
    variants.current = { reviewer: "low" };
    const withBoth: ProviderInfo[] = [
      {
        id: "anthropic",
        name: "Anthropic",
        models: [
          { id: "opus", name: "Opus", variants: ["low", "high"] },
          { id: "sonnet", name: "Sonnet", variants: ["low", "medium"] },
        ],
      },
    ];
    render(<AgentModelsCard providers={withBoth} />);
    const model = await screen.findByLabelText("Model for reviewer");
    await userEvent.selectOptions(model, "anthropic/sonnet");
    await waitFor(() => expect(setAgentModel).toHaveBeenCalledWith("reviewer", "anthropic/sonnet"));
    expect(setAgentVariant).not.toHaveBeenCalled();
  });

  // A retired model is not a choice — but dropping it from the row that is
  // pinned to it would leave the select with no matching value, so the browser
  // would show "Default model" while the config still pins the dead one.
  it("hides retired models, except in the row already pinned to one", async () => {
    models.current = { reviewer: "opencode/glm-5-free" };
    const withRetired: ProviderInfo[] = [
      {
        id: "opencode",
        name: "OpenCode Zen",
        models: [
          { id: "hy3-free", name: "HY3", available: true },
          { id: "glm-5-free", name: "GLM-5", available: false },
        ],
      },
    ];
    useRuntimeStore.setState({
      agents: [{ name: "reviewer", mode: "subagent" }, { name: "plan", mode: "primary" }],
    } as never);
    render(<AgentModelsCard providers={withRetired} />);

    const pinned = await screen.findByLabelText("Model for reviewer");
    await waitFor(() => expect((pinned as HTMLSelectElement).value).toBe("opencode/glm-5-free"));
    expect([...pinned.querySelectorAll("option")].map((o) => o.textContent)).toContain(
      "opencode/glm-5-free — no longer served",
    );

    const other = screen.getByLabelText("Model for plan");
    expect([...other.querySelectorAll("option")].map((o) => o.getAttribute("value"))).toEqual([
      "",
      "opencode/hy3-free",
    ]);
  });
});
