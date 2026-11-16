// ACP agents run BESIDE OpenCode, per conversation (#14). OpenCode stays the
// connection (workspace, kernels, every OpenCode conversation); a conversation
// started on an ACP agent is recorded as that agent's and every call for it
// goes to that agent. The agent here is a fake that answers the real wire
// shapes (see src/test/acp-runtime.test.ts, where they were read off live
// agents); what is under test is the routing in the store.
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
  /** Calls the OpenCode fake received, by method. */
  oc: [] as Array<{ method: string; args: unknown[] }>,
  /** Connectors OpenCode's config holds (`listMcpServers`). */
  mcp: [] as Array<{ name: string; config?: Record<string, unknown> }>,
}));

vi.mock("@ai4s/sdk", () => {
  class OpenCodeClient {
    private status = "offline";
    private statusCb: (s: string) => void = () => {};
    getStatus() {
      return this.status;
    }
    onStatus(cb: (s: string) => void) {
      this.statusCb = (s) => {
        this.status = s;
        cb(s);
      };
      return () => {
        this.statusCb = () => {};
      };
    }
    onEvent() {}
    async connect() {
      this.statusCb("ready");
    }
    close() {}
    private call(method: string, ...args: unknown[]) {
      mocks.oc.push({ method, args });
    }
    async listSessions() {
      return [{ id: "ses_oc", title: "An OpenCode conversation", directory: "/ws/project" }];
    }
    async createSession() {
      this.call("createSession");
      return "ses_oc_new";
    }
    async sendPrompt(sid: string, text: string) {
      this.call("sendPrompt", sid, text);
    }
    async deleteSession(sid: string) {
      this.call("deleteSession", sid);
    }
    async sessionExists() {
      return true;
    }
    async getMessages() {
      return [];
    }
    async listQuestions() {
      return [];
    }
    async listPermissions() {
      return [];
    }
    async listSkills() {
      return [];
    }
    async listAgents() {
      return [];
    }
    async listCommands() {
      return [];
    }
    async getDefaultModel() {
      return null;
    }
    async listProviders() {
      return [];
    }
    async listMcpServers() {
      return mocks.mcp;
    }
  }
  const isApiStatus = () => false;
  class RequestTimeoutError extends Error {}
  return { OpenCodeClient, RequestTimeoutError, isApiStatus, DEFAULT_OPENCODE_URL: "http://127.0.0.1:4096" };
});

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
              sessionCapabilities: { list: {}, delete: {}, close: {} },
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
      if (msg.method === "session/close" || msg.method === "session/delete")
        push({ jsonrpc: "2.0", id: msg.id, result: {} });
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

async function freshStore(defaultAgent: string | null, sessions?: Record<string, unknown>) {
  window.localStorage.clear();
  window.localStorage.setItem("ai4s.acp.agents.v1", JSON.stringify([CODEX]));
  if (defaultAgent) window.localStorage.setItem("ai4s.acp.active.v1", defaultAgent);
  if (sessions) window.localStorage.setItem("ai4s.acp.sessions.v1", JSON.stringify(sessions));
  vi.resetModules();
  const runtime = await import("./runtime");
  await runtime.useRuntimeStore.getState().connect();
  return runtime;
}

const PAST = { "acp-past-1": { agentId: "acp-1", title: "Yesterday's run", directory: "/ws/older-project" } };

describe("ACP conversations beside OpenCode", () => {
  beforeEach(() => {
    mocks.started = [];
    mocks.agent = null;
    mocks.failStart = false;
    mocks.workspace = "/ws/project";
    mocks.oc = [];
    mocks.mcp = [];
  });

  it("connects to OpenCode and starts no agent until a conversation needs one", async () => {
    const { useRuntimeStore, getClient } = await freshStore("acp-1");
    expect(useRuntimeStore.getState().status).toBe("ready");
    expect(getClient()).not.toBeNull();
    expect(mocks.started).toEqual([]);
  });

  it("runs a draft set to an agent on that agent, and records the conversation as its", async () => {
    const { useRuntimeStore, draftKeyFor } = await freshStore(null);
    const draft = draftKeyFor("leaf-1");
    useRuntimeStore.getState().setDraftRuntime(draft, "acp-1");
    const sid = await useRuntimeStore.getState().sendPrompt("Summarize the data", undefined, draft);

    expect(sid).toBe("acp-session-1");
    expect(mocks.started).toEqual([
      { agentId: "acp-1", command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"] },
    ]);
    // OpenCode created nothing and was sent nothing.
    expect(mocks.oc.filter((c) => c.method === "createSession" || c.method === "sendPrompt")).toEqual([]);
    const created = mocks.agent?.sent.find((m) => m.method === "session/new");
    // The session is created in the draft's own dated folder.
    expect(created?.params).toEqual({ cwd: mocks.workspace, mcpServers: [] });
    expect(mocks.workspace).toMatch(/^\/ws\/\d{4}-/);
    const blocks = useRuntimeStore.getState().threads[sid!]?.blocks ?? [];
    expect(blocks[0]).toMatchObject({ kind: "user", text: "Summarize the data" });
    // Deltas accumulate into one assistant block.
    expect(blocks.some((b) => b.kind === "agent" && b.markdown === "Half an answer.")).toBe(true);
    expect(useRuntimeStore.getState().runningSessions[sid!]).toBeUndefined();
    // Recorded, so it survives a restart and stays listed beside OpenCode's.
    expect(JSON.parse(window.localStorage.getItem("ai4s.acp.sessions.v1")!)[sid!]).toMatchObject({
      agentId: "acp-1",
      directory: mocks.workspace,
    });
    await useRuntimeStore.getState().refreshSessions();
    const ids = useRuntimeStore.getState().sessions.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(["ses_oc", sid!]));
  });

  it("starts a draft with no pick on the default agent from Settings", async () => {
    const { useRuntimeStore, draftKeyFor } = await freshStore("acp-1");
    const sid = await useRuntimeStore.getState().sendPrompt("Hello", undefined, draftKeyFor("leaf-1"));
    expect(sid).toBe("acp-session-1");
  });

  it("keeps a draft set to OpenCode on OpenCode, whatever the default", async () => {
    const { useRuntimeStore, draftKeyFor } = await freshStore("acp-1");
    const draft = draftKeyFor("leaf-1");
    useRuntimeStore.getState().setDraftRuntime(draft, null);
    const sid = await useRuntimeStore.getState().sendPrompt("Hello", undefined, draft);
    expect(sid).toBe("ses_oc_new");
    expect(mocks.started).toEqual([]);
    expect(mocks.oc.find((c) => c.method === "sendPrompt")?.args).toEqual(["ses_oc_new", "Hello"]);
  });

  it("lists a recorded conversation after a restart and replays it on its agent", async () => {
    const { useRuntimeStore } = await freshStore(null, PAST);
    expect(useRuntimeStore.getState().sessions).toContainEqual(
      expect.objectContaining({ id: "acp-past-1", title: "Yesterday's run", directory: "/ws/older-project" }),
    );

    await useRuntimeStore.getState().openSession("acp-past-1");
    const blocks = useRuntimeStore.getState().threads["acp-past-1"]?.blocks ?? [];
    expect(blocks).toMatchObject([
      { kind: "user", text: "What changed?" },
      { kind: "agent", markdown: "Two files." },
    ]);
    // Replayed history is finished history: no spinner.
    expect(useRuntimeStore.getState().runningSessions["acp-past-1"]).toBeUndefined();
    expect(mocks.started).toHaveLength(1);
  });

  it("opens a session started outside the app (a terminal) once it is adopted", async () => {
    const { useRuntimeStore } = await freshStore(null);
    // The terminal's folder is only a fallback: the agent says where the
    // session lives (the shell may have moved), and that is where it resumes.
    await useRuntimeStore.getState().adoptAcpSession("acp-1", "acp-past-1", "/ws/project");
    expect(useRuntimeStore.getState().sessions).toContainEqual(
      expect.objectContaining({ id: "acp-past-1", title: "Yesterday's run", directory: "/ws/older-project" }),
    );
    await useRuntimeStore.getState().openSession("acp-past-1");
    expect(useRuntimeStore.getState().threads["acp-past-1"]?.blocks).toHaveLength(2);
    const load = mocks.agent?.sent.find((m) => m.method === "session/load");
    expect((load?.params as { sessionId: string; cwd: string }).cwd).toBe("/ws/older-project");
  });

  it("keeps one agent process across workspace moves", async () => {
    const { useRuntimeStore, draftKeyFor } = await freshStore("acp-1");
    await useRuntimeStore.getState().sendPrompt("Summarize the data", undefined, draftKeyFor("leaf-1"));
    await useRuntimeStore.getState().switchWorkspace({ path: "/ws/other-project" });
    await useRuntimeStore.getState().sendPrompt("And again", "acp-session-1");

    expect(mocks.started).toHaveLength(1);
    expect(mocks.agent?.sent.filter((m) => m.method === "initialize")).toHaveLength(1);
    expect(mocks.agent?.sent.filter((m) => m.method === "session/prompt")).toHaveLength(2);
    expect(useRuntimeStore.getState().workspace).toBe("/ws/other-project");
  });

  it("offers the agent's own selectors, and sets them through the agent", async () => {
    const { useRuntimeStore, draftKeyFor } = await freshStore("acp-1");
    const sid = (await useRuntimeStore.getState().sendPrompt("Summarize", undefined, draftKeyFor("leaf-1")))!;
    expect(useRuntimeStore.getState().acpConfigOptions[sid]).toEqual([MODEL_OPTION]);

    await useRuntimeStore.getState().setAcpConfigOption(sid, "model", "gpt-5.6-sol[high]");
    const sent = mocks.agent?.sent.find((m) => m.method === "session/set_config_option");
    expect(sent?.params).toEqual({ sessionId: sid, configId: "model", value: "gpt-5.6-sol[high]" });
    expect(useRuntimeStore.getState().acpConfigOptions[sid]?.[0].currentValue).toBe("gpt-5.6-sol[high]");
  });

  it("remembers an agent's selectors, and applies a new conversation's pick before its first turn", async () => {
    const { useRuntimeStore, draftKeyFor } = await freshStore("acp-1");
    await useRuntimeStore.getState().sendPrompt("First", undefined, draftKeyFor("leaf-1"));
    // Learned from the first session, kept for the next new conversation.
    expect(useRuntimeStore.getState().acpAgentOptions["acp-1"]).toEqual([MODEL_OPTION]);
    expect(JSON.parse(window.localStorage.getItem("ai4s.acp.options.v1")!)["acp-1"]).toEqual([MODEL_OPTION]);

    const draft = draftKeyFor("leaf-2");
    useRuntimeStore.getState().setDraftAcpOption(draft, "model", "gpt-5.6-sol[high]");
    const before = mocks.agent!.sent.length;
    await useRuntimeStore.getState().sendPrompt("Second", undefined, draft);
    const methods = mocks.agent!.sent.slice(before).map((m) => m.method);
    // Set on the new session, and before the prompt, so the first turn runs on it.
    expect(methods.indexOf("session/set_config_option")).toBeGreaterThan(methods.indexOf("session/new"));
    expect(methods.indexOf("session/set_config_option")).toBeLessThan(methods.indexOf("session/prompt"));
    expect(useRuntimeStore.getState().draftAcpPicks[draft]).toBeUndefined();
  });

  it("reads an agent's selectors before its first conversation, and leaves no session behind", async () => {
    const { useRuntimeStore } = await freshStore(null);
    await useRuntimeStore.getState().fetchAcpAgentOptions("acp-1");
    expect(useRuntimeStore.getState().acpAgentOptions["acp-1"]).toEqual([MODEL_OPTION]);
    expect(useRuntimeStore.getState().acpOptionsProbe["acp-1"]).toBeUndefined();
    const sent = mocks.agent!.sent;
    const created = sent.find((m) => m.method === "session/new");
    // No connectors for a session nothing runs in.
    expect((created?.params as { mcpServers: unknown[] }).mcpServers).toEqual([]);
    expect(sent.find((m) => m.method === "session/delete")?.params).toEqual({ sessionId: "acp-session-1" });
    expect(useRuntimeStore.getState().sessions.map((m) => m.id)).not.toContain("acp-session-1");
  });

  it("reports an agent whose selectors could not be read", async () => {
    mocks.failStart = true;
    const { useRuntimeStore } = await freshStore(null);
    await useRuntimeStore.getState().fetchAcpAgentOptions("acp-1");
    expect(useRuntimeStore.getState().acpOptionsProbe["acp-1"]).toMatchObject({ status: "error" });
  });

  it("drops a draft's picks when it switches agent", async () => {
    const { useRuntimeStore, draftKeyFor } = await freshStore(null);
    const draft = draftKeyFor("leaf-1");
    useRuntimeStore.getState().setDraftRuntime(draft, "acp-1");
    useRuntimeStore.getState().setDraftAcpOption(draft, "model", "x");
    useRuntimeStore.getState().setDraftRuntime(draft, null);
    expect(useRuntimeStore.getState().draftAcpPicks[draft]).toBeUndefined();
  });

  it("hands this app's own connectors to the agent, per session", async () => {
    mocks.mcp = [
      { name: "pubmed", config: { type: "local", command: ["/opt/app/bin/uvx", "science-mcp"] } },
      { name: "off", config: { type: "local", command: ["/opt/app/bin/other"], enabled: false } },
    ];
    const { useRuntimeStore, draftKeyFor } = await freshStore("acp-1");
    await useRuntimeStore.getState().sendPrompt("Search PubMed", undefined, draftKeyFor("leaf-1"));
    const created = mocks.agent?.sent.find((m) => m.method === "session/new");
    expect((created?.params as { mcpServers: unknown }).mcpServers).toEqual([
      { name: "pubmed", command: "/opt/app/bin/uvx", args: ["science-mcp"], env: [] },
    ]);
  });

  it("reports an agent that would not start, and leaves OpenCode connected", async () => {
    mocks.failStart = true;
    const { useRuntimeStore, draftKeyFor } = await freshStore("acp-1");
    const sid = await useRuntimeStore.getState().sendPrompt("Hello", undefined, draftKeyFor("leaf-1"));
    expect(sid).toBeNull();
    const s = useRuntimeStore.getState();
    expect(JSON.stringify({ error: s.error, threads: s.threads })).toMatch(/could not start npx/);
    expect(s.status).toBe("ready");
  });

  it("lets go of a conversation moved to a terminal, and keeps it listed", async () => {
    const { useRuntimeStore } = await freshStore(null, PAST);
    await useRuntimeStore.getState().openSession("acp-past-1");
    await useRuntimeStore.getState().releaseAcpSession("acp-past-1");
    expect(mocks.agent?.sent.find((m) => m.method === "session/close")?.params).toEqual({
      sessionId: "acp-past-1",
    });
    expect(useRuntimeStore.getState().sessions.map((m) => m.id)).toContain("acp-past-1");
    // Reloaded on return, since the terminal adds to it meanwhile.
    expect(useRuntimeStore.getState().threads["acp-past-1"]).toBeUndefined();
  });

  it("forgets a deleted conversation here and leaves its history on the agent", async () => {
    const { useRuntimeStore } = await freshStore(null, PAST);
    await useRuntimeStore.getState().openSession("acp-past-1");
    await useRuntimeStore.getState().deleteSession("acp-past-1");
    expect(useRuntimeStore.getState().sessions.map((m) => m.id)).not.toContain("acp-past-1");
    expect(window.localStorage.getItem("ai4s.acp.sessions.v1")).toBe("{}");
    expect(mocks.agent?.sent.some((m) => m.method === "session/delete")).toBe(false);
    expect(mocks.oc.some((c) => c.method === "deleteSession")).toBe(false);
  });
});
