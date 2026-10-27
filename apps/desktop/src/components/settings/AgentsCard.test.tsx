import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { loadAcpAgents, activeAcpAgentId } from "@/lib/acpAgents";
import { useRuntimeStore } from "@/lib/runtime";
import { useAccountsStore } from "@/lib/agentAccounts";
import { useLayoutStore } from "@/lib/layout";
import { AgentsCard } from "./AgentsCard";

// A running agent is the store's, so stopping one is a spy here.
const stopAcpAgent = vi.hoisted(() => vi.fn());
// What this machine has installed: Claude Code only.
const installed = vi.hoisted(() => ({ ids: ["cli-claude-code"] as string[] }));
const invoke = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  isTauri: true,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@/lib/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runtime")>()),
  stopAcpAgent,
}));
vi.mock("@/lib/cliAgents", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/cliAgents")>();
  return {
    ...real,
    useInstalledAgents: () => real.CLI_AGENTS.filter((a) => installed.ids.includes(a.id)),
  };
});

const renderCard = () =>
  render(
    <MemoryRouter>
      <AgentsCard />
    </MemoryRouter>,
  );

beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.localStorage.clear();
  stopAcpAgent.mockClear();
  invoke.mockReset();
  invoke.mockResolvedValue({ default: { email: "me@lab.org", plan: "max" }, accounts: [] });
  installed.ids = ["cli-claude-code"];
  useAccountsStore.setState({ byKind: {} });
  useRuntimeStore.setState({ defaultRuntime: null });
});

describe("Settings → Agents", () => {
  it("lists OpenCode and the installed agents, and sets the default for new conversations", async () => {
    const user = userEvent.setup();
    renderCard();

    expect(screen.getByRole("radio", { name: "OpenCode" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("radio", { name: "Claude Code" }));

    expect(activeAcpAgentId()).toBe("cli-claude-code");
    expect(loadAcpAgents().map((a) => a.id)).toEqual(["cli-claude-code"]);
    // Choosing a default starts nothing: conversations start agents as they need them.
    expect(stopAcpAgent).not.toHaveBeenCalled();
  });

  it("offers the ones not installed with the vendor's command, run in a terminal", async () => {
    const user = userEvent.setup();
    const addGroup = vi.spyOn(useLayoutStore.getState(), "addGroup");
    renderCard();

    expect(screen.queryByRole("radio", { name: "Codex" })).not.toBeInTheDocument();
    expect(screen.getByText("npm install -g @openai/codex")).toBeInTheDocument();

    // Catalog order: Codex is the first one not installed.
    await user.click(screen.getAllByRole("button", { name: "Install in terminal" })[0]);
    expect(addGroup).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal", command: "npm install -g @openai/codex" }),
    );
  });

  it("shows who the agent is signed in as, and the accounts added for it", async () => {
    invoke.mockResolvedValue({
      default: { email: "me@lab.org", plan: "max" },
      accounts: [{ id: "acct-1", kind: "claude", email: "second@lab.org", plan: "pro", addedAtMs: 1 }],
    });
    renderCard();

    expect(await screen.findByText("me@lab.org")).toBeInTheDocument();
    expect(screen.getByText("second@lab.org")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("agent_accounts", { kind: "claude" });
    expect(screen.getByRole("button", { name: "Add account" })).toBeInTheDocument();
  });

  it("removes a custom agent, falling back to OpenCode and stopping it", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "ai4s.acp.agents.v1",
      JSON.stringify([{ id: "acp-1", name: "My agent", command: "my-agent", args: ["--acp"] }]),
    );
    useRuntimeStore.getState().setDefaultRuntime("acp-1");
    renderCard();

    expect(screen.getByRole("radio", { name: "My agent" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(loadAcpAgents()).toEqual([]);
    expect(activeAcpAgentId()).toBeNull();
    expect(stopAcpAgent).toHaveBeenCalledWith("acp-1");
    expect(screen.getByRole("radio", { name: "OpenCode" })).toHaveAttribute("aria-checked", "true");
  });

  it("saves an edited command and stops the process started from the old one", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "ai4s.acp.agents.v1",
      JSON.stringify([{ id: "acp-1", name: "My agent", command: "my-agent", args: [] }]),
    );
    renderCard();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.type(screen.getByLabelText("Arguments"), `--config "/Users/me/My Agents/acp.json"`);
    await user.click(screen.getByRole("button", { name: "Save" }));

    // Split the way a shell would, but never THROUGH a shell: a quoted path
    // with spaces survives.
    expect(loadAcpAgents()).toEqual([
      { id: "acp-1", name: "My agent", command: "my-agent", args: ["--config", "/Users/me/My Agents/acp.json"] },
    ]);
    expect(stopAcpAgent).toHaveBeenCalledWith("acp-1");
  });

  it("reads an entry made from an old one-click preset as that agent", () => {
    window.localStorage.setItem(
      "ai4s.acp.agents.v1",
      JSON.stringify([
        { id: "acp-2", name: "Claude Code", command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"] },
      ]),
    );
    useRuntimeStore.getState().setDefaultRuntime("acp-2");
    renderCard();

    // One Claude Code row, and it is the default.
    expect(screen.getAllByRole("radio", { name: "Claude Code" })).toHaveLength(1);
    expect(screen.getByRole("radio", { name: "Claude Code" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("Settings → Agents → accounts", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "agent_accounts")
        return {
          default: { email: "me@lab.org", plan: "max" },
          accounts: [{ id: "acct-1", kind: "claude", email: "second@lab.org", plan: "pro", addedAtMs: 1 }],
        };
      return null;
    });
    useAccountsStore.setState({ defaults: {} });
  });

  it("chooses which account new conversations on the agent start on", async () => {
    const user = userEvent.setup();
    renderCard();

    expect(await screen.findByRole("radio", { name: /second@lab\.org/ })).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByRole("radio", { name: /second@lab\.org/ }));

    expect(useAccountsStore.getState().defaults).toEqual({ "cli-claude-code": "acct-1" });
    expect(screen.getByRole("radio", { name: /second@lab\.org/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /me@lab\.org/ })).toHaveAttribute("aria-checked", "false");
  });
});
