import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_AGENTS, detectCliAgents, selectCliAgent } from "./cliAgents";
import { activeAcpAgentId, loadAcpAgents, saveAcpAgents } from "./acpAgents";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("./tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tauri")>()),
  isTauri: true,
}));

describe("detecting installed agents", () => {
  beforeEach(() => {
    window.localStorage.clear();
    invoke.mockReset();
  });

  it("asks about every command in the catalog and keeps only what answered", async () => {
    invoke.mockResolvedValue(["claude", "codex"]);

    const found = await detectCliAgents();

    expect(invoke).toHaveBeenCalledWith("detect_commands", {
      commands: CLI_AGENTS.map((a) => a.detect),
    });
    // Catalog order, not the order the probe replied in.
    expect(found.map((a) => a.name)).toEqual(["Claude Code", "Codex"]);
  });

  it("offers nothing when the machine has none of them", async () => {
    invoke.mockResolvedValue([]);
    expect(await detectCliAgents()).toEqual([]);
  });
});

describe("choosing an agent to run", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("creates the entry on first use and makes it the active one", () => {
    const codex = CLI_AGENTS.find((a) => a.id === "cli-codex")!;

    const next = selectCliAgent(codex);

    expect(next).toEqual([
      { id: "cli-codex", name: "Codex", command: codex.command, args: codex.args },
    ]);
    expect(loadAcpAgents()).toEqual(next);
    expect(activeAcpAgentId()).toBe("cli-codex");
  });

  it("leaves a user's own entries alone", () => {
    saveAcpAgents([{ id: "mine", name: "My agent", command: "my-agent", args: [] }]);

    selectCliAgent(CLI_AGENTS[0]);

    expect(loadAcpAgents().map((a) => a.id)).toEqual(["mine", CLI_AGENTS[0].id]);
  });

  it("overwrites its own entry so a catalog fix reaches an old machine", () => {
    const claude = CLI_AGENTS.find((a) => a.id === "cli-claude-code")!;
    saveAcpAgents([{ id: claude.id, name: claude.name, command: "stale-command", args: [] }]);

    selectCliAgent(claude);

    expect(loadAcpAgents()).toEqual([
      { id: claude.id, name: claude.name, command: claude.command, args: claude.args },
    ]);
  });
});
