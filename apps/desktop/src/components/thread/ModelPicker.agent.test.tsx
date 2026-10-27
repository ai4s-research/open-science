// The model picker leads with the agent: a new conversation picks it in the
// same popover as its model; an existing one names it.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useRuntimeStore } from "@/lib/runtime";
import { useAccountsStore } from "@/lib/agentAccounts";
import { ModelPicker, type AgentControl } from "./ModelPicker";

// What this machine has installed: Claude Code, not Codex.
const installed = vi.hoisted(() => ({ ids: ["cli-claude-code"] }));
vi.mock("@/lib/cliAgents", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/cliAgents")>();
  return {
    ...real,
    useInstalledAgents: () => real.CLI_AGENTS.filter((a) => installed.ids.includes(a.id)),
  };
});

const MODEL = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "opus",
  options: [
    { value: "opus", name: "Opus" },
    { value: "sonnet", name: "Sonnet", description: "Faster" },
  ],
};

function control(over: Partial<AgentControl> = {}): AgentControl {
  return { value: null, locked: false, onChange: vi.fn(), options: [], onOption: vi.fn(), ...over };
}

const renderPicker = (agent: AgentControl) =>
  render(
    <MemoryRouter>
      <ModelPicker sessionId="draft:leaf" agent={agent} />
    </MemoryRouter>,
  );

describe("ModelPicker with an agent", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    window.localStorage.setItem(
      "ai4s.acp.agents.v1",
      JSON.stringify([{ id: "cli-claude-code", name: "Claude Code", command: "npx", args: [] }]),
    );
    useRuntimeStore.setState({ providers: [], defaultModel: null });
    useAccountsStore.setState({ byKind: {}, defaults: {} });
  });

  it("offers only the agents installed here, and a way to the rest", async () => {
    const user = userEvent.setup();
    // Codex was configured once, and is not on this machine any more.
    window.localStorage.setItem(
      "ai4s.acp.agents.v1",
      JSON.stringify([{ id: "cli-codex", name: "Codex", command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"] }]),
    );
    renderPicker(control());
    await user.click(screen.getByRole("button", { name: /switch model/i }));

    expect(screen.getByRole("tab", { name: "Claude Code" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Codex" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More agents…" })).toBeInTheDocument();
  });

  it("picks the account a new conversation runs as, when there is more than one", async () => {
    const user = userEvent.setup();
    useAccountsStore.setState({
      byKind: {
        claude: {
          default: { email: "me@lab.org" },
          accounts: [{ id: "acct-1", kind: "claude", email: "second@lab.org", addedAtMs: 1 }],
        },
      },
    });
    const agent = control({ value: "cli-claude-code" });
    renderPicker(agent);
    await user.click(screen.getByRole("button", { name: /switch model/i }));

    expect(screen.getByRole("radio", { name: "me@lab.org" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("radio", { name: "second@lab.org" }));
    expect(agent.onChange).toHaveBeenCalledWith("cli-claude-code~acct-1");
  });

  it("names the account of an existing conversation on the chip", () => {
    useAccountsStore.setState({
      byKind: {
        claude: { default: null, accounts: [{ id: "acct-1", kind: "claude", email: "second@lab.org", addedAtMs: 1 }] },
      },
    });
    renderPicker(control({ value: "cli-claude-code~acct-1", locked: true, options: [MODEL] }));
    expect(screen.getByRole("button", { name: /switch model/i })).toHaveTextContent("Claude Code (second) · Opus");
  });

  it("offers the agents in a new conversation and switches on a pick", async () => {
    const user = userEvent.setup();
    const agent = control();
    renderPicker(agent);
    await user.click(screen.getByRole("button", { name: /switch model/i }));

    expect(screen.getByRole("tab", { name: "OpenCode" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "Claude Code" }));
    expect(agent.onChange).toHaveBeenCalledWith("cli-claude-code");
  });

  it("names the agent and its model on the chip, and lists the agent's own models", async () => {
    const user = userEvent.setup();
    const agent = control({ value: "cli-claude-code", options: [MODEL] });
    renderPicker(agent);
    const chip = screen.getByRole("button", { name: /switch model/i });
    expect(chip).toHaveTextContent("Claude Code · Opus");

    await user.click(chip);
    await user.click(screen.getByRole("button", { name: /Sonnet/ }));
    expect(agent.onOption).toHaveBeenCalledWith("model", "sonnet");
  });

  it("asks for an agent's models the moment it is shown without any", async () => {
    const user = userEvent.setup();
    const onNeedOptions = vi.fn();
    renderPicker(control({ value: "cli-claude-code", onNeedOptions }));
    await user.click(screen.getByRole("button", { name: /switch model/i }));
    expect(onNeedOptions).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Reading Claude Code's models…")).toBeInTheDocument();
  });

  it("says why when the agent could not be read", async () => {
    const user = userEvent.setup();
    renderPicker(
      control({
        value: "cli-claude-code",
        onNeedOptions: vi.fn(),
        probe: { status: "error", error: "npx is not installed" },
      }),
    );
    await user.click(screen.getByRole("button", { name: /switch model/i }));
    expect(screen.getByText("Claude Code did not start: npx is not installed")).toBeInTheDocument();
  });

  it("keeps an existing conversation on its agent", async () => {
    const user = userEvent.setup();
    renderPicker(control({ value: "cli-claude-code", locked: true, options: [MODEL] }));
    await user.click(screen.getByRole("button", { name: /switch model/i }));
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByText("New conversation to use another agent")).toBeInTheDocument();
  });
});
