import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeStore } from "@/lib/runtime";
import { loadAcpAgents, activeAcpAgentId } from "@/lib/acpAgents";
import { AcpAgentsCard } from "./AcpAgentsCard";

// The card only decides WHICH runtime to connect to; the connection itself is
// the store's job, so a reconnect is a spy here.
const connectRetry = vi.hoisted(() => vi.fn(async () => true));

vi.mock("@/lib/tauri", () => ({ isTauri: true }));

beforeEach(() => {
  window.localStorage.clear();
  connectRetry.mockClear();
  useRuntimeStore.setState({ connectRetry, status: "ready", runtimeKind: "opencode" });
});

describe("Settings → the agent this app drives", () => {
  it("adds a preset agent, selects it, and reconnects onto it", async () => {
    const user = userEvent.setup();
    render(<AcpAgentsCard />);

    // Nothing configured yet: the bundled runtime is the only choice, and it is
    // the selected one.
    expect(screen.getByRole("radio", { name: "OpenCode (bundled)" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Codex" }));
    expect(loadAcpAgents()).toEqual([
      { id: "acp-1", name: "Codex", command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"] },
    ]);
    // Adding an agent does not START it — the user still has to pick it.
    expect(activeAcpAgentId()).toBeNull();
    expect(connectRetry).not.toHaveBeenCalled();

    await user.click(screen.getByRole("radio", { name: "Codex" }));
    await waitFor(() => expect(activeAcpAgentId()).toBe("acp-1"));
    // The runtime is chosen at connect time, so the choice is only real once the
    // app has reconnected onto it.
    expect(connectRetry).toHaveBeenCalled();
  });

  it("falls back to the bundled runtime when the running agent is removed", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "ai4s.acp.agents.v1",
      JSON.stringify([{ id: "acp-1", name: "Gemini CLI", command: "gemini", args: ["--acp"] }]),
    );
    window.localStorage.setItem("ai4s.acp.active.v1", "acp-1");
    render(<AcpAgentsCard />);

    expect(screen.getByRole("radio", { name: "Gemini CLI" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(loadAcpAgents()).toEqual([]);
    // Never left selecting an agent that is no longer configured.
    expect(activeAcpAgentId()).toBeNull();
    expect(connectRetry).toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "OpenCode (bundled)" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("saves an edited command and restarts the agent it is running", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "ai4s.acp.agents.v1",
      JSON.stringify([{ id: "acp-1", name: "Codex", command: "codex", args: [] }]),
    );
    window.localStorage.setItem("ai4s.acp.active.v1", "acp-1");
    render(<AcpAgentsCard />);

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const args = screen.getByLabelText("Arguments");
    await user.type(args, `--config "/Users/me/My Agents/acp.json"`);
    await user.click(screen.getByRole("button", { name: "Save" }));

    // The argument line is split the way a shell would, but never THROUGH a
    // shell — a path with spaces survives because it was quoted.
    expect(loadAcpAgents()).toEqual([
      {
        id: "acp-1",
        name: "Codex",
        command: "codex",
        args: ["--config", "/Users/me/My Agents/acp.json"],
      },
    ]);
    // The running child was started from the OLD command line — restart it, or
    // Settings describes one agent while another one answers.
    expect(connectRetry).toHaveBeenCalled();
  });
});
