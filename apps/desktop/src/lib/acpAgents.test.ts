import { beforeEach, describe, expect, it } from "vitest";
import {
  activeAcpAgent,
  activeAcpAgentId,
  formatCommandArgs,
  loadAcpAgents,
  newAcpAgentId,
  parseCommandArgs,
  saveAcpAgents,
  setActiveAcpAgentId,
  type AcpAgentConfig,
} from "./acpAgents";

const codex: AcpAgentConfig = {
  id: "acp-1",
  name: "Codex",
  command: "npx",
  args: ["-y", "@agentclientprotocol/codex-acp"],
};

describe("configured ACP agents", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips a configured agent and its selection", () => {
    saveAcpAgents([codex]);
    setActiveAcpAgentId(codex.id);
    expect(loadAcpAgents()).toEqual([codex]);
    expect(activeAcpAgentId()).toBe("acp-1");
    expect(activeAcpAgent()).toEqual(codex);
  });

  it("falls back to the bundled runtime when the selected agent is gone", () => {
    // Deleting the selected entry must leave the app on OpenCode rather than on
    // a selection that names nothing — the app would otherwise have no runtime.
    saveAcpAgents([codex]);
    setActiveAcpAgentId(codex.id);
    saveAcpAgents([]);
    expect(activeAcpAgentId()).toBe("acp-1");
    expect(activeAcpAgent()).toBeNull();
  });

  it("drops stored entries the app could not start", () => {
    window.localStorage.setItem(
      "ai4s.acp.agents.v1",
      JSON.stringify([
        { id: "acp-1", name: "Fine", command: "gemini", args: ["--acp"] },
        { id: "acp-2", name: "No command", command: "  ", args: [] },
        { name: "No id", command: "codex", args: [] },
        { id: "acp-1", name: "Duplicate id", command: "other", args: [] },
        "nonsense",
      ]),
    );
    expect(loadAcpAgents()).toEqual([
      { id: "acp-1", name: "Fine", command: "gemini", args: ["--acp"] },
    ]);
  });

  it("names a new agent with the first free id", () => {
    expect(newAcpAgentId([])).toBe("acp-1");
    expect(newAcpAgentId([codex])).toBe("acp-2");
    expect(newAcpAgentId([codex, { ...codex, id: "acp-2" }])).toBe("acp-3");
  });
});

describe("argument line", () => {
  it("splits on whitespace and keeps quoted runs together", () => {
    expect(parseCommandArgs("-y @agentclientprotocol/codex-acp")).toEqual([
      "-y",
      "@agentclientprotocol/codex-acp",
    ]);
    // The arguments never go through a shell, so a path with spaces can only be
    // held together by quoting here.
    expect(parseCommandArgs(`--config "/Users/me/My Agents/acp.json"`)).toEqual([
      "--config",
      "/Users/me/My Agents/acp.json",
    ]);
    expect(parseCommandArgs("  --acp   ")).toEqual(["--acp"]);
    expect(parseCommandArgs("")).toEqual([]);
    // An empty quoted argument is a real (empty) argument, not nothing.
    expect(parseCommandArgs(`--flag ""`)).toEqual(["--flag", ""]);
  });

  it("re-quotes what it split, so an edit round-trips", () => {
    const args = ["--config", "/Users/me/My Agents/acp.json", "--acp"];
    expect(parseCommandArgs(formatCommandArgs(args))).toEqual(args);
  });
});
