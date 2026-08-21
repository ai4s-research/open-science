// The runtime SELECTOR (#14): with an ACP agent configured and selected, the
// store drives it INSTEAD of the bundled OpenCode client — same `AgentRuntime`
// seam, so a turn still lands in the thread. The agent here is a fake that
// answers the real wire shapes (see src/test/acp-runtime.test.ts, where they
// were read off live agents); what is under test is the wiring in `connect()`.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonRpcTransport } from "@ai4s/sdk/acp";

const mocks = vi.hoisted(() => ({
  /** (agentId, command, args) of every transport the store asked for. */
  started: [] as Array<{ agentId: string; command: string; args: string[] }>,
  /** Set by the fake agent below, so a test can push lines at the store. */
  agent: null as null | {
    sent: Record<string, unknown>[];
    push: (message: Record<string, unknown>) => void;
  },
  /** The next transport request throws, as a missing command does. */
  failStart: false,
  /** The active workspace folder, as the Rust side would report it. */
  workspace: "/ws/project",
}));

/** One fake agent, reused across reconnects: `connect()` runs again whenever the
 *  store creates a session in a fresh folder, and a test still has to be able to
 *  script the agent that is actually connected. */
function fakeAgent() {
  const lineListeners = new Set<(line: string) => void>();
  const closeListeners = new Set<(reason?: string) => void>();
  const sent: Record<string, unknown>[] = [];
  const push = (message: Record<string, unknown>) =>
    lineListeners.forEach((l) => l(JSON.stringify(message)));

  const transport: JsonRpcTransport = {
    send(line) {
      const msg = JSON.parse(line) as Record<string, unknown>;
      sent.push(msg);
      if (msg.method === "initialize")
        push({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: "@agentclientprotocol/codex-acp", title: "Codex" },
            agentCapabilities: {
              loadSession: true,
              sessionCapabilities: { list: {}, delete: {} },
            },
          },
        });
      if (msg.method === "session/new")
        push({
          jsonrpc: "2.0",
          id: msg.id,
          result: { sessionId: "acp-session-1", configOptions: [MODEL_OPTION] },
        });
      if (msg.method === "session/set_config_option") {
        const { value } = msg.params as { value: string };
        push({
          jsonrpc: "2.0",
          id: msg.id,
          result: { configOptions: [{ ...MODEL_OPTION, currentValue: value }] },
        });
      }
      if (msg.method === "session/list")
        push({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            sessions: [
              {
                sessionId: "acp-past-1",
                cwd: "/ws/older-project",
                title: "Yesterday's run",
                updatedAt: "2026-08-04T09:00:00Z",
              },
            ],
          },
        });
      if (msg.method === "session/load") {
        // History arrives as notifications, then the request is answered.
        const sessionId = (msg.params as { sessionId: string }).sessionId;
        const update = (update: Record<string, unknown>) =>
          push({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
        update({
          sessionUpdate: "user_message_chunk",
          messageId: "u1",
          content: { type: "text", text: "What changed?" },
        });
        update({
          sessionUpdate: "agent_message_chunk",
          messageId: "a1",
          content: { type: "text", text: "Two files." },
        });
        push({ jsonrpc: "2.0", id: msg.id, result: {} });
      }
      if (msg.method === "session/prompt") {
        // A turn: two deltas, then the prompt's own response ends it.
        push({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "acp-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "m1",
              content: { type: "text", text: "Half " },
            },
          },
        });
        push({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "acp-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "m1",
              content: { type: "text", text: "an answer." },
            },
          },
        });
        push({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      }
    },
    onLine(l) {
      lineListeners.add(l);
      return () => lineListeners.delete(l);
    },
    onClose(l) {
      closeListeners.add(l);
      return () => closeListeners.delete(l);
    },
    close() {
      closeListeners.clear();
      lineListeners.clear();
    },
  };
  return { transport, agent: { sent, push } };
}

vi.mock("./tauri", () => ({
  isTauri: true,
  logDebug: async () => {},
  detectTools: async () => [],
  startRuntime: async () => "http://127.0.0.1:1",
  runtimeFailure: async () => null,
  takeConfigQuarantineNotice: async () => null,
  workspacePath: async () => mocks.workspace,
  setWorkspace: async (p: string) => {
    mocks.workspace = p;
    return p;
  },
  newDatedWorkspace: async (name: string) => {
    mocks.workspace = `/ws/${name}`;
    return mocks.workspace;
  },
  markSession: async () => {},
  commitWorkspaceSnapshot: async () => false,
  getApprovalMode: async () => "approve",
  setApprovalMode: async () => "http://127.0.0.1:1",
  setProxySetting: async () => "http://127.0.0.1:1",
  runtimePassword: async () => "pw-test",
  listProjects: async () => [],
  createProject: async () => null,
  importProject: async () => null,
  setProjectPinned: async () => {},
  deleteProject: async () => {},
  installSkillMarkdown: async () => "skill",
  workspaceSkillNames: async () => [],
  adoptWorkspaceSkills: async () => [],
}));
vi.mock("./kernel", () => ({ kernelReset: async () => {} }));
vi.mock("./acpTransport", () => ({
  acpTransport: async (agentId: string, command: string, args: string[]) => {
    mocks.started.push({ agentId, command, args });
    if (mocks.failStart) throw new Error(`could not start ${command}: No such file or directory`);
    const { transport, agent } = fakeAgent();
    mocks.agent = agent;
    return transport;
  },
  acpRunning: async () => [],
}));

/** One selector, the shape a real agent sends (`configOptions`): the agent owns
 *  the list, and `session/set_config_option` is how v1 changes a model. */
const MODEL_OPTION = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "gpt-5.6-sol[medium]",
  options: [
    { value: "gpt-5.6-sol[medium]", name: "GPT-5.6-Sol (medium)" },
    { value: "gpt-5.6-sol[high]", name: "GPT-5.6-Sol (high)" },
  ],
};

const CODEX = {
  id: "acp-1",
  name: "Codex",
  command: "npx",
  args: ["-y", "@agentclientprotocol/codex-acp"],
};

async function freshStore(selected: string | null) {
  window.localStorage.clear();
  window.localStorage.setItem("ai4s.acp.agents.v1", JSON.stringify([CODEX]));
  if (selected) window.localStorage.setItem("ai4s.acp.active.v1", selected);
  vi.resetModules();
  return await import("./runtime");
}

describe("runtime selector", () => {
  beforeEach(() => {
    mocks.started = [];
    mocks.agent = null;
    mocks.failStart = false;
    mocks.workspace = "/ws/project";
  });

  it("drives the selected ACP agent instead of the OpenCode client", async () => {
    const { useRuntimeStore, getClient } = await freshStore("acp-1");
    await useRuntimeStore.getState().connect();

    expect(mocks.started).toEqual([
      { agentId: "acp-1", command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"] },
    ]);
    const s = useRuntimeStore.getState();
    expect(s.status).toBe("ready");
    expect(s.runtimeKind).toBe("acp");
    expect(s.acpAgentName).toBe("Codex");
    // No OpenCode instance backs this connection: Settings' provider/MCP surface
    // must hide rather than PATCH a sidecar that is not driving anything.
    expect(getClient()).toBeNull();
    expect(s.providers).toEqual([]);
  });

  it("runs a whole turn through the ACP agent", async () => {
    const { useRuntimeStore, DRAFT_KEY } = await freshStore("acp-1");
    await useRuntimeStore.getState().connect();
    const sid = await useRuntimeStore.getState().sendPrompt("Summarize the data");

    expect(sid).toBe("acp-session-1");
    const created = mocks.agent?.sent.find((m) => m.method === "session/new");
    // ACP takes the workspace folder per session, and a first send gives the
    // draft its own dated folder — so the session is created in THAT one.
    expect(created?.params).toEqual({ cwd: mocks.workspace, mcpServers: [] });
    expect(mocks.workspace).toMatch(/^\/ws\/\d{4}-/);
    const blocks = useRuntimeStore.getState().threads[sid!]?.blocks ?? [];
    expect(blocks[0]).toMatchObject({ kind: "user", text: "Summarize the data" });
    // Deltas accumulate into one assistant block — passing them through would
    // render "Half an answer." as "an answer.".
    expect(blocks.some((b) => b.kind === "agent" && b.markdown === "Half an answer.")).toBe(true);
    // The turn ended: the composer is unlocked again.
    expect(useRuntimeStore.getState().runningSessions[sid!]).toBeUndefined();
    expect(useRuntimeStore.getState().threads[DRAFT_KEY]).toBeUndefined();
  });

  it("lists the agent's own past sessions and reopens one with its history", async () => {
    const { useRuntimeStore } = await freshStore("acp-1");
    await useRuntimeStore.getState().connect();
    await useRuntimeStore.getState().refreshSessions();

    // The agent keeps the history, so a session from a previous RUN of this app
    // is in the sidebar — with the folder it belongs to, which is what groups it
    // under its project.
    expect(useRuntimeStore.getState().sessions).toContainEqual(
      expect.objectContaining({
        id: "acp-past-1",
        title: "Yesterday's run",
        directory: "/ws/older-project",
      }),
    );

    await useRuntimeStore.getState().openSession("acp-past-1");
    const blocks = useRuntimeStore.getState().threads["acp-past-1"]?.blocks ?? [];
    expect(blocks).toMatchObject([
      { kind: "user", text: "What changed?" },
      { kind: "agent", markdown: "Two files." },
    ]);
    // Replayed history is finished history: no spinner, no Stop button for a
    // turn that ended before the app started.
    expect(useRuntimeStore.getState().runningSessions["acp-past-1"]).toBeUndefined();
    // Following the session into its folder reuses the same agent process.
    expect(mocks.started).toHaveLength(1);
  });

  it("keeps one agent process across workspace moves", async () => {
    const { useRuntimeStore } = await freshStore("acp-1");
    await useRuntimeStore.getState().connect();
    // A first send moves the workspace (its own dated folder) and reconnects —
    // the path every new session takes.
    await useRuntimeStore.getState().sendPrompt("Summarize the data");
    await useRuntimeStore.getState().switchWorkspace({ path: "/ws/other-project" });

    // ACP binds the folder per SESSION (`session/new`'s cwd), so two workspace
    // moves must not cost two agent cold starts — nor kill the sessions the
    // child is holding.
    expect(mocks.started).toHaveLength(1);
    expect(mocks.agent?.sent.filter((m) => m.method === "initialize")).toHaveLength(1);
    expect(useRuntimeStore.getState().status).toBe("ready");
    expect(useRuntimeStore.getState().workspace).toBe("/ws/other-project");
  });

  it("offers the agent's own selectors, and sets them through the agent", async () => {
    const { useRuntimeStore } = await freshStore("acp-1");
    await useRuntimeStore.getState().connect();
    const sid = (await useRuntimeStore.getState().sendPrompt("Summarize the data"))!;

    // The model picker is OpenCode's; an ACP agent reports its own options and
    // this is what the composer renders instead.
    expect(useRuntimeStore.getState().acpConfigOptions[sid]).toEqual([MODEL_OPTION]);

    await useRuntimeStore.getState().setAcpConfigOption(sid, "model", "gpt-5.6-sol[high]");
    const sent = mocks.agent?.sent.find((m) => m.method === "session/set_config_option");
    expect(sent?.params).toEqual({ sessionId: sid, configId: "model", value: "gpt-5.6-sol[high]" });
    // The agent's answer replaces the list wholesale — picking a model can
    // change which reasoning levels exist.
    expect(useRuntimeStore.getState().acpConfigOptions[sid]?.[0].currentValue).toBe(
      "gpt-5.6-sol[high]",
    );
  });

  it("hands this app's own connectors to the agent, per session", async () => {
    // ACP takes MCP servers per session; OpenCode keeps them in its global
    // config. Without this an ACP agent runs with none of the connectors the
    // user configured — which reads as the feature being broken.
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const at = String(url);
        if (at.endsWith("/mcp")) return json({ pubmed: { status: "connected" } });
        if (at.endsWith("/global/config"))
          return json({
            mcp: {
              pubmed: { type: "local", command: ["/opt/app/bin/uvx", "science-mcp"] },
              off: { type: "local", command: ["/opt/app/bin/other"], enabled: false },
            },
          });
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );
    try {
      const { useRuntimeStore } = await freshStore("acp-1");
      await useRuntimeStore.getState().connect();
      await useRuntimeStore.getState().sendPrompt("Search PubMed");

      const created = mocks.agent?.sent.find((m) => m.method === "session/new");
      expect((created?.params as { mcpServers: unknown }).mcpServers).toEqual([
        // `env` travels even when empty: the published schema requires it, and
        // an agent validating with the official SDK refuses the session without it.
        { name: "pubmed", command: "/opt/app/bin/uvx", args: ["science-mcp"], env: [] },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the bundled runtime when no agent is selected", async () => {
    const { useRuntimeStore } = await freshStore(null);
    await useRuntimeStore.getState().connect();
    expect(mocks.started).toEqual([]);
    expect(useRuntimeStore.getState().runtimeKind).toBe("opencode");
  });

  it("reports a command that would not start, and starts nothing else", async () => {
    // A wrong command is the common first-run failure; it has to name itself in
    // the UI rather than leaving the app silently on no runtime at all.
    mocks.failStart = true;
    const { useRuntimeStore, getClient } = await freshStore("acp-1");
    await useRuntimeStore.getState().connect();
    const s = useRuntimeStore.getState();
    expect(s.status).toBe("error");
    expect(s.error).toMatch(/could not start npx/);
    expect(s.runtimeKind).toBe("acp");
    expect(getClient()).toBeNull();
  });
});
