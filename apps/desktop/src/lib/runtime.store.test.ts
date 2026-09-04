// Workspace-per-session behavior: a fresh draft's first message creates a new
// dated folder by default; an explicit switcher choice pins the destination.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  /** The host's active workspace folder, as `active-workspace.txt` holds it.
   *  `setWorkspace`/`newDatedWorkspace` move it and `workspacePath` reads it
   *  back, because that is the contract the Rust side keeps: creating a dated
   *  folder MAKES it active, and the connect that follows scopes the runtime to
   *  whatever this then answers. A stub that always answered the same folder
   *  could not tell a reconnect that landed in the right one from a reconnect
   *  that did not — which is exactly the state that files a conversation apart
   *  from the files it creates. */
  activeWorkspace: "/ws/base",
  newDatedWorkspace: vi.fn(async (name: string) => (mocks.activeWorkspace = `/ws/${name}`)),
  setWorkspace: vi.fn(async (path: string) => (mocks.activeWorkspace = path)),
  /** Stamps a session's id into the ACTIVE folder — so it must not run when the
   *  app failed to move into the session's own folder. */
  markSession: vi.fn(async () => {}),
  commitWorkspaceSnapshot: vi.fn(async () => false),
  kernelReset: vi.fn(async () => {}),
  /** Number of connect() attempts that fail before one succeeds. */
  failConnects: 0,
  /** Number of createSession() attempts that fail before one succeeds. */
  failCreates: 0,
  /** Fire a normalized event into the store, as the SSE stream would. */
  fireEvent: (_e: unknown) => {},
  /** Fire a client status flip into the store, as the SDK's reconnect would. */
  fireStatus: (_s: string) => {},
  runShell: vi.fn(),
  renameSessionSpy: vi.fn(),
  /** What listSessions() answers — the runtime's whole history. */
  sessionList: [] as { id: string; title: string; directory?: string }[],
  moveSessionSpy: vi.fn(),
  /** Next renameSession call is rejected by the server. */
  failRename: false,
  createSessionSpy: vi.fn(),
  forkSessionSpy: vi.fn(),
  appendTextPartSpy: vi.fn(),
  setSessionArchivedSpy: vi.fn(),
  reviewSessionCounter: 0,
  sendPromptSpy: vi.fn(),
  /** Captures the FULL sendPrompt arg list (incl. model + variant) — the plain
   *  spy above deliberately ignores those, so existing 3-arg assertions hold. */
  sendPromptFullSpy: vi.fn(),
  runCommand: vi.fn(),
  replyPermission: vi.fn(),
  abortSession: vi.fn(),
  revertSpy: vi.fn(),
  unrevertSpy: vi.fn(),
  /** Number of revert() attempts that fail (busy session) before one succeeds. */
  failReverts: 0,
  /** SSE events the real server streams back DURING an abort POST's await — an
   *  "aborted" error and one or more session.idle events. Empty by default. */
  abortTrailing: [] as unknown[],
  getMessages: vi.fn(),
  /** Records setDefaultModel calls; `currentModel` is what getDefaultModel returns. */
  setDefaultModelSpy: vi.fn(),
  currentModel: null as string | null,
  /** Providers listProviders returns. [] (default) makes loadCatalog's dangling-
   *  model self-heal (#18) a no-op — the model is only "dangling" against a known
   *  provider list, so an empty list yields no fallback. Set to exercise the heal. */
  providers: [] as {
    id: string;
    name: string;
    models: { id: string; name: string; variants?: string[] }[];
  }[],
  /** Next setDefaultModel PATCH throws (server unreachable). */
  failSetModel: false,
  /** History the mock server returns for any session. */
  messages: [] as unknown[],
  /** Optional pause for exercising cancellation while review setup awaits history. */
  messagesGate: null as Promise<void> | null,
  /** Next getMessages call throws. */
  failMessages: false,
  /** Next runShell call throws (HTTP-level failure). */
  failShell: false,
  /** Next runCommand call throws before any event (HTTP-level failure). */
  failCommand: false,
  /** Next runCommand call streams an event, then throws — the WKWebView
   *  ~60 s fetch kill on a long sync turn ("Load failed"). */
  dropCommandPost: false,
  /** Approval mode the Rust config currently holds. */
  approvalMode: "approve" as string,
  setApprovalMode: vi.fn(async (mode: string) => {
    mocks.approvalMode = mode;
    return "http://127.0.0.1:1";
  }),
  notifyPermissionRequest: vi.fn(async () => true),
  startRuntime: vi.fn(async () => "http://127.0.0.1:1"),
  restartRuntime: vi.fn(async () => "http://127.0.0.1:2"),
  /** What Rust reports about sidecars that EXITED (#118): null = none have. */
  runtimeFailure: vi.fn(async (): Promise<{ exits: number; message: string } | null> => null),
  takeConfigQuarantineNotice: vi.fn(async (): Promise<string | null> => null),
  /** Skill install bridges (#61). */
  installSkillMarkdown: vi.fn(async (_text: string) => "pasted-skill"),
  workspaceSkillNames: vi.fn(async () => ["already-there"]),
  adoptWorkspaceSkills: vi.fn(async (_known: string[]) => ["agent-skill"]),
  /** Constructor options every OpenCodeClient was created with. */
  clientOpts: [] as Record<string, unknown>[],
  closedDirs: [] as string[],
}));

vi.mock("./tauri", () => ({
  isTauri: true,
  logDebug: async () => {},
  detectTools: async () => [],
  startRuntime: mocks.startRuntime,
  restartRuntime: mocks.restartRuntime,
  runtimeFailure: mocks.runtimeFailure,
  takeConfigQuarantineNotice: mocks.takeConfigQuarantineNotice,
  workspacePath: async () => mocks.activeWorkspace,
  setWorkspace: mocks.setWorkspace,
  newDatedWorkspace: mocks.newDatedWorkspace,
  markSession: mocks.markSession,
  commitWorkspaceSnapshot: mocks.commitWorkspaceSnapshot,
  getApprovalMode: async () => mocks.approvalMode,
  setApprovalMode: mocks.setApprovalMode,
  runtimePassword: async () => "pw-test",
  installSkillMarkdown: mocks.installSkillMarkdown,
  workspaceSkillNames: mocks.workspaceSkillNames,
  adoptWorkspaceSkills: mocks.adoptWorkspaceSkills,
}));
vi.mock("./kernel", () => ({ kernelReset: mocks.kernelReset }));
vi.mock("./systemNotification", () => ({
  notifyPermissionRequest: mocks.notifyPermissionRequest,
}));
vi.mock("@ai4s/sdk", () => {
  class OpenCodeClient {
    private statusCb: (s: string) => void = () => {};
    /** The real client keeps its status (BaseAgentRuntime); the store reads it
     *  after connecting rather than waiting for a transition. */
    private status = "offline";
    private opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      mocks.clientOpts.push(opts);
    }
    getStatus() {
      return this.status;
    }
    onStatus(cb: (s: string) => void) {
      const wrapped = (s: string) => {
        this.status = s;
        cb(s);
      };
      this.statusCb = wrapped;
      mocks.fireStatus = wrapped;
      return () => {
        this.statusCb = () => {};
      };
    }
    onEvent(cb: (e: unknown) => void) {
      mocks.fireEvent = cb;
    }
    async connect() {
      this.statusCb("connecting");
      if (mocks.failConnects > 0) {
        mocks.failConnects--;
        this.statusCb("error");
        throw new Error("Could not open OpenCode event stream");
      }
      this.statusCb("ready");
    }
    async listSessions() {
      return mocks.sessionList;
    }
    async renameSession(id: string, title: string) {
      mocks.renameSessionSpy(id, title);
      if (mocks.failRename) throw new Error("rename rejected");
    }
    async moveSession(id: string, directory: string) {
      mocks.moveSessionSpy(id, directory);
    }
    async listSkills() {
      return [{ name: "stub" }];
    }
    async listAgents() {
      return [
        { name: "build", description: "", mode: "primary" },
        { name: "plan", description: "", mode: "primary" },
      ];
    }
    async getDefaultModel() {
      return mocks.currentModel;
    }
    async listProviders() {
      return mocks.providers;
    }
    async setDefaultModel(model: string) {
      mocks.setDefaultModelSpy(model);
      if (mocks.failSetModel) throw new Error("Load failed");
      mocks.currentModel = model;
    }
    async createSession(title?: string) {
      mocks.createSessionSpy(title);
      if (mocks.failCreates > 0) {
        mocks.failCreates--;
        throw new Error("Load failed");
      }
      return "ses_new";
    }
    async forkSession(sid: string, messageId?: string) {
      mocks.forkSessionSpy(sid, messageId);
      mocks.reviewSessionCounter++;
      return `ses_review_${mocks.reviewSessionCounter}`;
    }
    async appendTextPart(sid: string, messageId: string, text: string, partId?: string) {
      mocks.appendTextPartSpy(sid, messageId, text, partId);
      return partId ?? "prt_mock";
    }
    async setSessionArchived(sid: string, archived: boolean) {
      mocks.setSessionArchivedSpy(sid, archived);
    }
    async sendPrompt(
      sid: string,
      text: string,
      agent?: string,
      model?: string | null,
      variant?: string | null,
    ) {
      mocks.sendPromptSpy(sid, text, agent);
      mocks.sendPromptFullSpy(sid, text, agent, model, variant);
    }
    async listCommands() {
      return [{ name: "init", description: "guided AGENTS.md setup", source: "command" }];
    }
    // Like the real endpoints, shell/command resolve only when the turn is
    // over — and session.idle fires BEFORE the POST resolves.
    async runShell(sid: string, command: string, agent: string) {
      mocks.runShell(sid, command, agent);
      if (mocks.failShell) throw new Error("shell exploded");
      mocks.fireEvent({
        type: "tool.updated",
        sessionId: sid,
        callId: "csh",
        tool: "bash",
        status: "success",
        title: "",
        input: { command },
        output: "/ws/mock\n",
      });
      mocks.fireEvent({ type: "session.idle", sessionId: sid });
    }
    async runCommand(sid: string, name: string, args?: string) {
      mocks.runCommand(sid, name, args);
      if (mocks.failCommand) throw new Error("command exploded");
      if (mocks.dropCommandPost) {
        mocks.fireEvent({ type: "text.updated", sessionId: sid, partId: "t1", text: "working…" });
        throw new Error("Load failed");
      }
      mocks.fireEvent({ type: "session.idle", sessionId: sid });
    }
    async replyPermission(requestId: string, reply: string) {
      mocks.replyPermission(requestId, reply);
    }
    async abortSession(sid: string) {
      mocks.abortSession(sid);
      // The real server answers an abort with its own SSE burst that streams
      // back while this POST is still being awaited — reproduce that timing so
      // the guard must already be set before the await, not after it.
      for (const e of mocks.abortTrailing) mocks.fireEvent(e);
    }
    async getMessages(sid: string) {
      mocks.getMessages(sid);
      if (mocks.failMessages) throw new Error("history hung");
      if (mocks.messagesGate) await mocks.messagesGate;
      return mocks.messages;
    }
    async revert(sid: string, messageID: string, partID?: string) {
      mocks.revertSpy(sid, messageID, partID);
      if (mocks.failReverts > 0) {
        mocks.failReverts--;
        throw new Error("session is busy");
      }
    }
    async unrevert(sid: string) {
      mocks.unrevertSpy(sid);
    }
    async listQuestions() {
      return [];
    }
    async listPermissions() {
      return [];
    }
    // The real client emits "offline" on teardown — the store must keep that
    // away from the UI while reconnecting (first-boot flicker regression).
    close() {
      const dir = this.opts.directory;
      if (typeof dir === "string") mocks.closedDirs.push(dir);
      this.statusCb("offline");
    }
  }
  // Mirrors the real helper: the store uses it to tell an already-resolved
  // permission (404) from a reply that genuinely failed.
  const isApiStatus = (err: unknown, status: number) =>
    err instanceof Error && (err as { status?: unknown }).status === status;
  return { OpenCodeClient, isApiStatus, DEFAULT_OPENCODE_URL: "http://127.0.0.1:4096" };
});

import type { ArtifactBlock } from "@ai4s/shared";
import { DRAFT_KEY, adoptSourceFolder, rootSessionOf, useRuntimeStore } from "./runtime";
import { useSshStore } from "./ssh";
import { useToastStore } from "./toast";
import { leaves, makeLeaf, useLayoutStore } from "./layout";

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.activeWorkspace = "/ws/base";
  mocks.failConnects = 0;
  mocks.failCreates = 0;
  mocks.failShell = false;
  mocks.failCommand = false;
  mocks.dropCommandPost = false;
  mocks.abortTrailing = [];
  mocks.messages = [];
  mocks.messagesGate = null;
  mocks.failMessages = false;
  mocks.failReverts = 0;
  mocks.approvalMode = "approve";
  mocks.currentModel = null;
  mocks.providers = [];
  mocks.failSetModel = false;
  mocks.failRename = false;
  mocks.sessionList = [];
  mocks.reviewSessionCounter = 0;
  mocks.notifyPermissionRequest.mockResolvedValue(true);
  mocks.createSessionSpy.mockClear();
  mocks.startRuntime.mockClear();
  mocks.startRuntime.mockImplementation(async () => "http://127.0.0.1:1");
  mocks.runtimeFailure.mockClear();
  mocks.runtimeFailure.mockResolvedValue(null);
  mocks.takeConfigQuarantineNotice.mockClear();
  mocks.takeConfigQuarantineNotice.mockResolvedValue(null);
  useToastStore.setState({ toasts: [] });
  mocks.closedDirs.length = 0;
  useRuntimeStore.setState({
    currentId: null,
    draftWorkspaces: {},
    threads: {},
    error: null,
    sending: false,
    sendingSessions: {},
    runningSessions: {},
    permissions: [],
    sessionParents: {},
    panes: {},
    sessionAgents: {},
    autoReview: false,
    backgroundReviews: {},
  });
  await useRuntimeStore.getState().connect();
  expect(useRuntimeStore.getState().status).toBe("ready");
  // connect() fires loadCatalog without awaiting it — settle it so tests that
  // override `agents` (or read them) aren't racing the catalog write.
  await new Promise((r) => setTimeout(r, 0));
});

describe("agent artifact presentation targets", () => {
  it("creates a real dedicated Session and opens it with the artifact in a new Screen", async () => {
    const source = makeLeaf("ses_source");
    useLayoutStore.setState({
      groups: [{ id: "g-source", name: "", tree: source, focusedLeafId: source.id, zoomedLeafId: null }],
      activeGroupId: "g-source",
      tree: source,
      focusedLeafId: source.id,
      zoomedLeafId: null,
      ephemeralGroupId: null,
    });
    useRuntimeStore.setState({
      currentId: "ses_source",
      sessions: [{ id: "ses_source", title: "Source", directory: "/ws/base" }],
    });

    mocks.fireEvent({
      type: "tool.updated",
      sessionId: "ses_source",
      callId: "present-dedicated",
      tool: "present_artifact",
      status: "success",
      input: {
        path: "figures/result.png",
        display: "panel",
        placement: "right",
        target: "new-session",
        title: "Result review",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.createSessionSpy).toHaveBeenCalledWith("Result review");
    expect(useRuntimeStore.getState().sessions.some((session) => session.id === "ses_new")).toBe(true);
    expect(useLayoutStore.getState().groups).toHaveLength(2);
    expect(
      leaves(useLayoutStore.getState().tree!).map((leaf) => leaf.artifact?.path ?? leaf.sessionId),
    ).toEqual(["ses_new", "figures/result.png"]);
  });
});

describe("retry notices", () => {
  it("keeps the account-state action, and drops the notice on the next sign of life", () => {
    // The action is what lets the pane say "waiting will not help" instead of
    // "retrying (attempt 1)" for a spent allowance (#117).
    mocks.fireEvent({
      type: "session.retry",
      sessionId: "ses_quota",
      attempt: 1,
      message: "Free usage exceeded, subscribe to Go",
      nextAt: 0,
      action: { reason: "free_tier_limit", provider: "opencode", link: "https://opencode.ai/go" },
    });
    expect(useRuntimeStore.getState().retryNotices["ses_quota"]).toMatchObject({
      attempt: 1,
      action: { reason: "free_tier_limit", provider: "opencode" },
    });

    mocks.fireEvent({ type: "session.idle", sessionId: "ses_quota" });
    expect(useRuntimeStore.getState().retryNotices["ses_quota"]).toBeUndefined();
  });

  it("carries no action for an ordinary provider failure", () => {
    mocks.fireEvent({
      type: "session.retry",
      sessionId: "ses_flaky",
      attempt: 2,
      message: "overloaded",
      nextAt: 0,
    });
    expect(useRuntimeStore.getState().retryNotices["ses_flaky"]?.action).toBeUndefined();
  });

  it("the red line the turn ends on inherits the cause the notice named", async () => {
    // The attempts run out and the failure arrives as a plain session error
    // whose text names no provider. The action from the last retry is the only
    // record of WHY, and it is about to be thrown away with the notice (#117).
    await useRuntimeStore.getState().sendPrompt("hi");
    mocks.fireEvent({
      type: "session.retry",
      sessionId: "ses_new",
      attempt: 5,
      message: "Free usage exceeded",
      nextAt: 0,
      action: { reason: "free_tier_limit", provider: "opencode" },
    });
    mocks.fireEvent({ type: "error", sessionId: "ses_new", message: "Free usage exceeded" });

    const last = useRuntimeStore.getState().threads["ses_new"].blocks.slice(-1)[0];
    expect(last).toMatchObject({ kind: "status-line", tone: "error" });
    expect(last.kind === "status-line" && last.text).toMatch(/OpenCode Zen/);
    expect(useRuntimeStore.getState().retryNotices["ses_new"]).toBeUndefined();
  });
});

describe("runtime authentication", () => {
  it("deduplicates concurrent bootstrap calls", async () => {
    const first = useRuntimeStore.getState().bootstrap();
    const second = useRuntimeStore.getState().bootstrap();

    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(mocks.startRuntime).toHaveBeenCalledTimes(1);
  });

  it("respawns the sidecar when reconnecting to a dead one", async () => {
    // The sidecar crashes on its own (Effect ServeError, exit 1). Retrying the
    // socket alone never recovers — nothing is listening and nothing puts it
    // back — so the app hammered a dead port until the user restarted it.
    // Every failed attempt must go through startRuntime, which respawns a dead
    // runtime and is a no-op for a live one.
    mocks.startRuntime.mockClear();
    const connect = vi
      .spyOn(useRuntimeStore.getState(), "connect")
      .mockImplementation(async () => {
        useRuntimeStore.setState({ status: "error", error: "stream closed" });
      });

    const ok = await useRuntimeStore.getState().connectRetry(3);

    expect(ok).toBe(false);
    expect(mocks.startRuntime).toHaveBeenCalledTimes(3); // one per failed attempt
    connect.mockRestore();
  });

  it("forces a fresh sidecar once retrying has stopped helping", async () => {
    // The case startRuntime cannot see: the process is alive, so nothing
    // terminates and nothing clears the lifecycle, but it has stopped serving.
    // start_runtime keeps handing back the same dead URL, so retrying alone
    // never recovers — observed as "opencode disconnects and will not
    // reconnect". After the threshold, force a new process exactly once.
    mocks.startRuntime.mockClear();
    mocks.restartRuntime.mockClear();
    const connect = vi
      .spyOn(useRuntimeStore.getState(), "connect")
      .mockImplementation(async () => {
        useRuntimeStore.setState({ status: "error", error: "stream closed" });
      });

    const url = useRuntimeStore.getState().serverUrl;
    // 9 attempts: eight quick retries (250 ms) then the forced one — enough to
    // cross the threshold, short enough to stay inside the test timeout.
    await useRuntimeStore.getState().connectRetry(9);

    expect(mocks.restartRuntime).toHaveBeenCalledTimes(1); // once, not every attempt
    expect(mocks.startRuntime).toHaveBeenCalledTimes(8); // the attempts before it
    expect(useRuntimeStore.getState().serverUrl).toBe("http://127.0.0.1:2");
    connect.mockRestore();
    useRuntimeStore.setState({ serverUrl: url, status: "ready", error: null });
  });

  it("stops spawning a runtime that keeps exiting, and reports what it said", async () => {
    // A config the runtime refuses to start on kills every spawn in
    // milliseconds. Retrying cannot fix that, so the loop used to open one
    // doomed process per attempt (up to 120) and then blame the socket
    // ("could not open the event stream") — while the reason sat in the child's
    // own stderr (#118). Six attempts are asked for; three deaths must end it.
    let exits = 0;
    mocks.startRuntime.mockImplementation(async () => {
      exits++; // this spawn died too
      return "http://127.0.0.1:1";
    });
    mocks.runtimeFailure.mockImplementation(async () =>
      exits === 0
        ? null
        : { exits, message: "Error: Config file at C:\\x\\opencode.json is not valid JSON(C)" },
    );
    const connect = vi
      .spyOn(useRuntimeStore.getState(), "connect")
      .mockImplementation(async () => {
        useRuntimeStore.setState({ status: "error", error: "Could not open OpenCode event stream" });
      });

    try {
      const ok = await useRuntimeStore.getState().connectRetry(6);

      expect(ok).toBe(false);
      expect(mocks.startRuntime.mock.calls.length).toBe(3); // not one per attempt
      expect(useRuntimeStore.getState().status).toBe("error");
      // The runtime's own words, not ours.
      expect(useRuntimeStore.getState().error).toMatch(/not valid JSON/);
    } finally {
      connect.mockRestore();
    }
  });

  it("keeps retrying a runtime that is merely slow to listen", async () => {
    // The discriminator has to be EXITS, not failed connects: a first boot
    // behind macOS TCC can take minutes with the process alive the whole time,
    // and giving up on it would be a regression.
    mocks.startRuntime.mockClear();
    mocks.runtimeFailure.mockResolvedValue(null);
    const connect = vi
      .spyOn(useRuntimeStore.getState(), "connect")
      .mockImplementation(async () => {
        useRuntimeStore.setState({ status: "error", error: "stream closed" });
      });

    try {
      const ok = await useRuntimeStore.getState().connectRetry(4);

      expect(ok).toBe(false);
      expect(mocks.startRuntime).toHaveBeenCalledTimes(4); // every attempt, none skipped
    } finally {
      connect.mockRestore();
    }
  });

  it("ignores exits that happened before this attempt began", async () => {
    // A sidecar that crashed an hour ago must not make the next reconnect give
    // up immediately — only deaths inside this attempt count.
    mocks.startRuntime.mockClear();
    mocks.runtimeFailure.mockResolvedValue({ exits: 7, message: "an old crash" });
    const connect = vi
      .spyOn(useRuntimeStore.getState(), "connect")
      .mockImplementation(async () => {
        useRuntimeStore.setState({ status: "error", error: "stream closed" });
      });

    try {
      await useRuntimeStore.getState().connectRetry(3);

      expect(mocks.startRuntime).toHaveBeenCalledTimes(3);
      expect(useRuntimeStore.getState().error).toBe("stream closed");
    } finally {
      connect.mockRestore();
    }
  });

  it("tells the user once when an unreadable config was rebuilt", async () => {
    mocks.takeConfigQuarantineNotice.mockResolvedValueOnce(
      "C:\\x\\opencode.json.broken-1755000000000",
    );

    await useRuntimeStore.getState().reportQuarantinedConfig();
    await useRuntimeStore.getState().reportQuarantinedConfig();

    const messages = useToastStore.getState().toasts.map((t) => t.message);
    // Once — the second call has nothing left to take.
    expect(messages).toHaveLength(1);
    // The path is the whole point: it is where the user's providers still are.
    expect(messages[0]).toContain("broken-1755000000000");
    expect(messages[0]).not.toContain("settings:toast"); // a real string, not a key
  });

  it("a reconnect that lands fast never repaints the status", async () => {
    // Switching Screens goes openSession → setWorkspace → connectRetry. Flipping
    // the indicator to "connecting" synchronously made it stutter on a path
    // where nothing was wrong, and — because `connected` is derived from status
    // — dropped `connected` for a frame when `switching` cleared, re-running the
    // pane-stream effect and re-handshaking streams that were already fine.
    useRuntimeStore.setState({ status: "ready" });
    const connect = vi
      .spyOn(useRuntimeStore.getState(), "connect")
      .mockImplementation(async () => {
        useRuntimeStore.setState({ status: "ready" });
      });

    const seen: string[] = [];
    const unsub = useRuntimeStore.subscribe((s) => {
      if (seen[seen.length - 1] !== s.status) seen.push(s.status);
    });
    await useRuntimeStore.getState().connectRetry(3);
    unsub();

    expect(seen).not.toContain("connecting");
    expect(useRuntimeStore.getState().status).toBe("ready");
    connect.mockRestore();
  });

  it("connect() passes the per-run runtime password to the SDK client", async () => {
    // The sidecar requires Basic auth (OPENCODE_SERVER_PASSWORD); an
    // unauthenticated client would 401 on every call.
    mocks.clientOpts.length = 0;
    await useRuntimeStore.getState().connect();
    expect(mocks.clientOpts[mocks.clientOpts.length - 1]).toMatchObject({
      password: "pw-test",
    });
  });
});

describe("per-session workspace folders", () => {
  it("creates a fresh dated folder before the first message of an unpinned draft", async () => {
    const id = await useRuntimeStore.getState().sendPrompt("hello");
    expect(id).toBe("ses_new");
    expect(mocks.newDatedWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.newDatedWorkspace.mock.calls[0][0]).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}$/);
    // The kernel is reset so it respawns inside the new folder.
    expect(mocks.kernelReset).toHaveBeenCalled();
  });

  it("keeps a pinned folder: no dated folder is created", async () => {
    useRuntimeStore.setState({ draftWorkspaces: { [DRAFT_KEY]: "/ws/base" }, workspace: "/ws/base" });
    const id = await useRuntimeStore.getState().sendPrompt("hello");
    expect(id).toBe("ses_new");
    expect(mocks.newDatedWorkspace).not.toHaveBeenCalled();
  });

  // #69: "new session in project X" is expressed on click, but the folder is
  // decided at send time from a global pin. Anything that re-blanks the draft
  // view in between — LiveSessionPage's focus effect does exactly that when a
  // pane loses its session — silently unpinned the folder, so the session was
  // created in a fresh dated folder instead of the project. It then rendered
  // under "Sessions" rather than the project, permanently.
  it("keeps a project folder when the draft view is re-blanked before the first message", async () => {
    await useRuntimeStore.getState().startDraftInWorkspace("/ws/毕设");
    expect(useRuntimeStore.getState().draftWorkspaces[DRAFT_KEY]).toBe("/ws/毕设");

    // The user glances at another session and comes back to the empty pane.
    useRuntimeStore.setState({ currentId: "ses_old" });
    useRuntimeStore.getState().resetDraftView();

    await useRuntimeStore.getState().sendPrompt("hello");
    expect(mocks.newDatedWorkspace).not.toHaveBeenCalled();
  });

  // The other half of #69: a draft that was never aimed anywhere must NOT
  // inherit the folder of whatever the user was just reading. Opening a new
  // screen is a layout action that touches no runtime state, so the pane's own
  // draft slot is simply empty — and an empty slot means a fresh dated folder.
  it("gives an unaimed pane its own dated folder, not the project just viewed", async () => {
    // Reading a session in a project: the active folder followed it there.
    useRuntimeStore.setState({
      workspace: "/ws/毕设",
      draftWorkspaces: { [DRAFT_KEY]: "/ws/毕设" },
    });

    // A new screen's pane has its own draft slot, which nobody aimed.
    await useRuntimeStore.getState().sendPrompt("hello", undefined, "draft:leaf-new");
    expect(mocks.newDatedWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.setWorkspace).not.toHaveBeenCalledWith("/ws/毕设");
  });

  // "+ new session in project X" opens its own pane, and that pane's composer
  // sends under `draft:<leafId>` — so the project folder must be aimed at THAT
  // slot, not the global one, or the send finds nothing and dates a folder.
  it("aims the pane's own draft slot, so its first send lands in the project", async () => {
    await useRuntimeStore.getState().startDraftInWorkspace("/ws/毕设", "draft:leaf-7");
    expect(useRuntimeStore.getState().draftWorkspaces["draft:leaf-7"]).toBe("/ws/毕设");

    await useRuntimeStore.getState().sendPrompt("hello", undefined, "draft:leaf-7");
    expect(mocks.newDatedWorkspace).not.toHaveBeenCalled();
  });

  // Once the draft becomes a session the destination has served its purpose.
  // Leaving it behind would aim the pane's NEXT draft at the same project long
  // after the user moved on — the same class of stale-global bug as #69 itself.
  it("forgets a draft's destination once its session exists", async () => {
    await useRuntimeStore.getState().startDraftInWorkspace("/ws/毕设", "draft:leaf-7");
    await useRuntimeStore.getState().sendPrompt("hello", undefined, "draft:leaf-7");

    expect(useRuntimeStore.getState().draftWorkspaces["draft:leaf-7"]).toBeUndefined();

    // A later draft in that same pane goes back to the default.
    mocks.newDatedWorkspace.mockClear();
    await useRuntimeStore.getState().sendPrompt("second", undefined, "draft:leaf-7");
    expect(mocks.newDatedWorkspace).toHaveBeenCalledTimes(1);
  });

  // Cmd+D splits without asking, so the new pane inherits the folder in front
  // of the user. (The header's split buttons ask first — SplitMenu — and aim
  // the pane at the answer.)
  it("adoptSourceFolder aims a split pane at its source's folder", () => {
    useRuntimeStore.setState({
      sessions: [{ id: "ses_1", title: "t", directory: "/ws/毕设" } as never],
    });

    adoptSourceFolder("leaf-9", { leafId: "leaf-1", sessionId: "ses_1" });

    expect(useRuntimeStore.getState().draftWorkspaces["draft:leaf-9"]).toBe("/ws/毕设");
  });

  it("adoptSourceFolder leaves a pane with nothing to continue alone", () => {
    // No source (an empty Screen), and a source draft that was never aimed:
    // both mean the new pane makes its own dated folder.
    adoptSourceFolder("leaf-10", null);
    adoptSourceFolder("leaf-11", { leafId: "leaf-2", sessionId: null });

    expect(useRuntimeStore.getState().draftWorkspaces["draft:leaf-10"]).toBeUndefined();
    expect(useRuntimeStore.getState().draftWorkspaces["draft:leaf-11"]).toBeUndefined();
  });

  it("restores the draft's folder when the active one wandered off", async () => {
    await useRuntimeStore.getState().startDraftInWorkspace("/ws/毕设");
    // Opening another session follows it into ITS folder (openSession does this).
    useRuntimeStore.setState({ workspace: "/ws/other-project" });
    mocks.setWorkspace.mockClear();

    await useRuntimeStore.getState().sendPrompt("hello");
    expect(mocks.setWorkspace).toHaveBeenCalledWith("/ws/毕设");
    expect(mocks.newDatedWorkspace).not.toHaveBeenCalled();
  });

  it("still unpins for an explicit New session (that is what New means)", async () => {
    await useRuntimeStore.getState().startDraftInWorkspace("/ws/毕设");
    useRuntimeStore.getState().startDraft();
    await useRuntimeStore.getState().sendPrompt("hello");
    expect(mocks.newDatedWorkspace).toHaveBeenCalledTimes(1);
  });

  it("does not create another folder for later messages in the same session", async () => {
    await useRuntimeStore.getState().sendPrompt("first");
    await useRuntimeStore.getState().sendPrompt("second");
    expect(mocks.newDatedWorkspace).toHaveBeenCalledTimes(1);
  });

  it("masks transient connect errors while deliberately reconnecting", async () => {
    mocks.failConnects = 1;
    const done = useRuntimeStore.getState().connectRetry(3);
    await new Promise((r) => setTimeout(r, 50)); // after the first failed attempt
    expect(useRuntimeStore.getState().status).toBe("connecting");
    expect(useRuntimeStore.getState().error).toBe(null);
    await done;
    expect(useRuntimeStore.getState().status).toBe("ready");
    expect(useRuntimeStore.getState().error).toBe(null);
  });

  it("never passes through 'offline' while retrying (first-boot page flicker)", async () => {
    // On a fresh install the retry loop runs for minutes (macOS TCC dialog);
    // each attempt tears down the previous client, whose close() emits
    // "offline" — if that reaches the store, the page flips between the
    // offline help card and the connecting screen once per attempt.
    mocks.failConnects = 1;
    const seen: string[] = [];
    const unsub = useRuntimeStore.subscribe((s, prev) => {
      if (s.status !== prev.status) seen.push(s.status);
    });
    await useRuntimeStore.getState().connectRetry(3);
    unsub();
    expect(useRuntimeStore.getState().status).toBe("ready");
    expect(seen).not.toContain("offline");
  });

  it("never passes through 'error' while retrying (the launch flicker)", async () => {
    // Every launch dials the sidecar before it listens, so the first two or
    // three attempts fail — and each published failure flipped the status
    // badge, the offline help card and the error banner on and off 250ms
    // apart. A retry window has to read as one uninterrupted "connecting".
    mocks.failConnects = 3;
    const seen: string[] = [];
    const errors: string[] = [];
    const unsub = useRuntimeStore.subscribe((s, prev) => {
      if (s.status !== prev.status) seen.push(s.status);
      if (s.error !== prev.error && s.error) errors.push(s.error);
    });
    await useRuntimeStore.getState().connectRetry(5);
    unsub();
    expect(useRuntimeStore.getState().status).toBe("ready");
    expect(seen).not.toContain("error");
    expect(errors).toEqual([]);
  });

  it("surfaces the last error only when the retry window is exhausted", async () => {
    mocks.failConnects = 99;
    await useRuntimeStore.getState().connectRetry(1);
    expect(useRuntimeStore.getState().status).toBe("error");
    expect(useRuntimeStore.getState().error).toContain("event stream");
  });

  it("a superseded openSession does not start a second, dueling reconnect", async () => {
    // Opening a folder-scoped session reconnects the SSE stream. If a newer
    // open (rapid switching, or an effect that fires twice) overlaps an older
    // one, TWO connectRetry loops must NOT run: they tear down each other's
    // in-flight EventSource and leak half-open sockets until the webview's
    // per-host connection pool is exhausted and every later session hangs.
    useRuntimeStore.setState({
      sessions: [
        { id: "A", title: "A", directory: "/ws/A" },
        { id: "B", title: "B", directory: "/ws/B" },
      ] as never,
    });
    const before = mocks.clientOpts.length;

    // Fire both without awaiting the first — the exact overlap seen in the wild.
    await Promise.all([
      useRuntimeStore.getState().openSession("A"),
      useRuntimeStore.getState().openSession("B"),
    ]);

    // Only the winner reconnects (one new client), and only its history loads.
    expect(mocks.clientOpts.length - before).toBe(1);
    expect(useRuntimeStore.getState().currentId).toBe("B");
    expect(mocks.getMessages).toHaveBeenLastCalledWith("B");
  });

  it("echoes the first message instantly into the draft, then grafts it onto the session", async () => {
    const p = useRuntimeStore.getState().sendPrompt("hi");
    // Synchronously (before any await resolves): the message is visible and
    // the composer is locked — the user is never staring at an unchanged page.
    expect(useRuntimeStore.getState().sending).toBe(true);
    expect(useRuntimeStore.getState().threads[DRAFT_KEY]?.blocks).toEqual([
      { kind: "user", text: "hi" },
    ]);
    await p;
    const s = useRuntimeStore.getState();
    expect(s.currentId).toBe("ses_new");
    expect(s.threads[DRAFT_KEY]).toBeUndefined();
    expect(s.threads["ses_new"].blocks).toEqual([{ kind: "user", text: "hi" }]);
    expect(s.sending).toBe(false);
    expect(s.runningSessions["ses_new"]).toBe(true); // turn active until idle
  });

  it("ignores a second send while one is in flight", async () => {
    const p = useRuntimeStore.getState().sendPrompt("hi");
    const second = await useRuntimeStore.getState().sendPrompt("hi again");
    expect(second).toBe(null);
    await p;
    expect(useRuntimeStore.getState().threads[DRAFT_KEY] ?? undefined).toBeUndefined();
    expect(useRuntimeStore.getState().threads["ses_new"].blocks).toHaveLength(1);
  });

  it("session.idle ends the turn: running cleared, done line folded in", async () => {
    await useRuntimeStore.getState().sendPrompt("hi");
    expect(useRuntimeStore.getState().runningSessions["ses_new"]).toBe(true);
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_new" });
    const s = useRuntimeStore.getState();
    expect(s.runningSessions["ses_new"]).toBeUndefined();
    expect(s.threads["ses_new"].blocks.slice(-1)[0]).toMatchObject({ kind: "status-line", tone: "done" });
  });

  // A streamed event must leave every session-keyed map byte-identical, so a
  // pane/sidebar that reads one of those maps does not repaint for a FOREIGN
  // session's tokens. Cloning them per event made concurrent subagents starve
  // the main thread — the UI froze for minutes at a time (#50).
  it("a streamed event does not churn the identity of session-keyed maps", async () => {
    await useRuntimeStore.getState().sendPrompt("hi");
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_new" });
    // First sign of life from a background session legitimately takes its
    // running lock; the steady state that follows is what must stay stable.
    mocks.fireEvent({ type: "text.updated", sessionId: "ses_other", text: "tok" });
    const before = useRuntimeStore.getState();
    expect(before.runningSessions["ses_other"]).toBe(true);
    // That session now streams on: more tokens, a tool step. Hundreds of these
    // arrive per turn, per concurrent subagent.
    mocks.fireEvent({ type: "text.updated", sessionId: "ses_other", text: "tok tok" });
    mocks.fireEvent({
      type: "tool.updated",
      sessionId: "ses_other",
      callId: "call_1",
      tool: "bash",
      status: "running",
    });
    const after = useRuntimeStore.getState();
    expect(after.threads["ses_other"]).toBeDefined(); // the fold DID happen
    expect(after.runningSessions).toBe(before.runningSessions);
    expect(after.stepCounts).toBe(before.stepCounts);
    expect(after.shellTurns).toBe(before.shellTurns);
  });

  it("a session error lands as a red line in the thread and unlocks the turn", async () => {
    await useRuntimeStore.getState().sendPrompt("hi");
    mocks.fireEvent({ type: "error", sessionId: "ses_new", message: "model unavailable" });
    const s = useRuntimeStore.getState();
    expect(s.runningSessions["ses_new"]).toBeUndefined();
    expect(s.threads["ses_new"].blocks.slice(-1)[0]).toEqual({
      kind: "status-line",
      text: "model unavailable",
      tone: "error",
    });
  });

  it("retries a failed createSession once (transient 'Load failed')", async () => {
    mocks.failCreates = 1;
    const id = await useRuntimeStore.getState().sendPrompt("hi");
    expect(id).toBe("ses_new");
    expect(useRuntimeStore.getState().error).toBe(null);
  });

  it("a hard create failure shows a red line in the draft and unlocks the composer", async () => {
    mocks.failCreates = 99;
    const id = await useRuntimeStore.getState().sendPrompt("hi");
    expect(id).toBe(null);
    const s = useRuntimeStore.getState();
    expect(s.sending).toBe(false);
    expect(s.threads[DRAFT_KEY].blocks.slice(-1)[0]).toMatchObject({
      kind: "status-line",
      tone: "error",
    });
  });

  it("refuses to create a session in a folder the runtime did not actually move to", async () => {
    // The dated folder is created but does NOT become active — so the reconnect
    // scopes the runtime to the old folder and `createSession` would file the
    // conversation there while its notebooks and figures are written in the new
    // one. A session on the reporter's machine is in exactly that state: its
    // notebook is on disk, and the conversation that made it answers "file not
    // found", because the two folders disagree and nothing said so.
    mocks.newDatedWorkspace.mockImplementationOnce(async (name: string) => `/ws/${name}`);

    const id = await useRuntimeStore.getState().sendPrompt("hi");

    expect(id).toBe(null);
    expect(mocks.createSessionSpy).not.toHaveBeenCalled();
    const s = useRuntimeStore.getState();
    expect(s.sending).toBe(false);
    expect(s.threads[DRAFT_KEY].blocks.slice(-1)[0]).toMatchObject({
      kind: "status-line",
      tone: "error",
    });
  });

  it("says so when it cannot follow a session into its own folder, and stamps nothing", async () => {
    // The failure used to be swallowed: the app stayed on the previous folder,
    // reconnected the stream to it, stamped THIS session's id into it, and then
    // resolved every file the conversation names there — so the session's own
    // notebook came back "file not found" while the UI showed it as open.
    useRuntimeStore.setState({
      workspace: "/ws/base",
      sessions: [{ id: "ses_elsewhere", title: "t", updated: 1, directory: "/ws/gone" }],
    });
    mocks.setWorkspace.mockRejectedValueOnce(new Error("No such file or directory"));

    await useRuntimeStore.getState().openSession("ses_elsewhere");

    const error = useRuntimeStore.getState().error ?? "";
    expect(error).toContain("/ws/gone");
    expect(error).toContain("No such file or directory");
    expect(mocks.markSession).not.toHaveBeenCalled();
    // The folder never moved, so the app must still be on the one it was on.
    expect(useRuntimeStore.getState().workspace).toBe("/ws/base");
  });

  it("marks a deliberate switch as `switching` for its whole duration", async () => {
    mocks.failConnects = 1; // keep the reconnect in flight for one retry beat
    const done = useRuntimeStore.getState().switchWorkspace({ path: "/ws/mine" });
    await new Promise((r) => setTimeout(r, 50));
    expect(useRuntimeStore.getState().switching).toBe(true);
    await done;
    expect(useRuntimeStore.getState().switching).toBe(false);
    expect(useRuntimeStore.getState().status).toBe("ready");
  });

  it("runShell: echoes `! cmd`, runs it, and ends the turn even though idle beat the POST", async () => {
    const id = await useRuntimeStore.getState().runShell("pwd");
    expect(id).toBe("ses_new");
    expect(mocks.runShell).toHaveBeenCalledWith("ses_new", "pwd", "build");
    const s = useRuntimeStore.getState();
    expect(s.threads["ses_new"].blocks[0]).toEqual({ kind: "user", text: "! pwd" });
    // The sync endpoint resolves after session.idle already fired — the
    // running lock must not stick (it was set before the POST, cleared after).
    expect(s.runningSessions["ses_new"]).toBeUndefined();
    expect(s.shellTurns["ses_new"]).toBeUndefined();
    expect(s.sending).toBe(false);
  });

  it("runShell: the bash row carries the command as title and the output inline", async () => {
    await useRuntimeStore.getState().runShell("pwd");
    const bash = useRuntimeStore
      .getState()
      .threads["ses_new"].blocks.find((b) => b.kind === "tool-call");
    // The shell endpoint reports an empty title — the command line stands in,
    // and the output shows inline (it IS the result the user asked for).
    expect(bash).toMatchObject({ title: "pwd", status: "success", outputSummary: "/ws/mock" });
  });

  it("an agent bash step (no shell turn) stays a quiet line without inline output", async () => {
    await useRuntimeStore.getState().sendPrompt("hi");
    mocks.fireEvent({
      type: "tool.updated",
      sessionId: "ses_new",
      callId: "c9",
      tool: "bash",
      status: "success",
      title: "install deps",
      input: { command: "pip install numpy" },
      output: "lots of pip noise",
    });
    const bash = useRuntimeStore
      .getState()
      .threads["ses_new"].blocks.find((b) => b.kind === "tool-call");
    // A bash step is titled by its (de-noised) command — the honest record —
    // not the model's free-text description.
    expect(bash).toMatchObject({ title: "pip install numpy", verb: "Ran", status: "success" });
    expect((bash as { outputSummary?: string }).outputSummary).toBeUndefined();
  });

  it("runShell failure lands as a red line and unlocks the composer", async () => {
    mocks.failShell = true;
    await useRuntimeStore.getState().runShell("pwd");
    const s = useRuntimeStore.getState();
    expect(s.threads["ses_new"].blocks.slice(-1)[0]).toMatchObject({
      kind: "status-line",
      tone: "error",
    });
    expect(s.runningSessions["ses_new"]).toBeUndefined();
    expect(s.shellTurns["ses_new"]).toBeUndefined(); // no events will clear it
    expect(s.sending).toBe(false);
  });

  it("runCommand: echoes `/name args` and posts the command with its arguments", async () => {
    const id = await useRuntimeStore.getState().runCommand("init", "focus on tests");
    expect(id).toBe("ses_new");
    expect(mocks.runCommand).toHaveBeenCalledWith("ses_new", "init", "focus on tests");
    const s = useRuntimeStore.getState();
    expect(s.threads["ses_new"].blocks[0]).toEqual({ kind: "user", text: "/init focus on tests" });
    expect(s.runningSessions["ses_new"]).toBeUndefined();
  });

  it("/clear starts a new draft in the same folder without calling OpenCode command", async () => {
    useRuntimeStore.setState({
      currentId: "ses_old",
      draftWorkspaces: {},
      threads: {
        ses_old: { blocks: [{ kind: "user", text: "old context" }], index: {}, loaded: true },
      },
    });
    const id = await useRuntimeStore.getState().runCommand("clear");
    expect(id).toBe(null);
    expect(mocks.runCommand).not.toHaveBeenCalled();

    const cleared = useRuntimeStore.getState();
    expect(cleared.currentId).toBe(null);
    expect(cleared.draftWorkspaces[DRAFT_KEY]).toBe(cleared.workspace);
    expect(cleared.threads.ses_old.blocks).toEqual([{ kind: "user", text: "old context" }]);
    expect(cleared.threads[DRAFT_KEY].blocks).toEqual([
      {
        kind: "status-line",
        text: "Chat context cleared. Files stay in the same folder.",
        tone: "review",
        divider: true,
      },
    ]);

    const connectsBeforeNextTurn = mocks.clientOpts.length;
    await useRuntimeStore.getState().sendPrompt("next");
    expect(mocks.newDatedWorkspace).not.toHaveBeenCalled();
    expect(mocks.clientOpts.length).toBeGreaterThan(connectsBeforeNextTurn);
  });

  it("openSession stops the loading skeleton when history fails to load", async () => {
    mocks.failMessages = true;
    useRuntimeStore.setState({
      sessions: [{ id: "ses_bad", title: "Bad session", directory: "/ws/base" }],
      currentId: null,
      threads: {},
    });

    await useRuntimeStore.getState().openSession("ses_bad");

    const thread = useRuntimeStore.getState().threads.ses_bad;
    expect(thread.loaded).toBe(true);
    expect(thread.blocks).toEqual([
      { kind: "status-line", text: "Failed to load messages: history hung", tone: "error" },
    ]);
  });

  it("switchWorkspace pins the chosen folder; startDraft un-pins it", async () => {
    await useRuntimeStore.getState().switchWorkspace({ path: "/ws/mine" });
    expect(mocks.setWorkspace).toHaveBeenCalledWith("/ws/mine");
    expect(useRuntimeStore.getState().draftWorkspaces[DRAFT_KEY]).toBe("/ws/mine");
    useRuntimeStore.getState().startDraft();
    expect(useRuntimeStore.getState().draftWorkspaces[DRAFT_KEY]).toBeUndefined();
  });

  it("ensureDraftWorkspace materializes a fresh draft's dated folder before files are written", async () => {
    // A brand-new, unpinned draft → creates+pins its dated folder, so a pasted
    // or attached file lands in the same workspace the session will run in.
    useRuntimeStore.setState({ currentId: null, draftWorkspaces: {} });
    mocks.newDatedWorkspace.mockClear();
    await useRuntimeStore.getState().ensureDraftWorkspace();
    expect(mocks.newDatedWorkspace).toHaveBeenCalledTimes(1);
    // The draft is now aimed at the folder it just materialized, so the send
    // reuses it instead of creating a second one and orphaning the file.
    expect(useRuntimeStore.getState().draftWorkspaces[DRAFT_KEY]).toMatch(
      /^\/ws\/\d{4}-\d{2}-\d{2}-\d{4}$/,
    );

    // Idempotent: a draft that already has its folder (or a live session) is left alone, so
    // send does not create a second dated folder that would orphan the file.
    mocks.newDatedWorkspace.mockClear();
    await useRuntimeStore.getState().ensureDraftWorkspace();
    expect(mocks.newDatedWorkspace).not.toHaveBeenCalled();
    useRuntimeStore.setState({ currentId: "ses_1", draftWorkspaces: {} });
    await useRuntimeStore.getState().ensureDraftWorkspace();
    expect(mocks.newDatedWorkspace).not.toHaveBeenCalled();
  });
});

// A task tool spawns a subagent in a CHILD session; its permission asks carry
// the child's id, and a sync POST held open for a long turn is killed by
// WKWebView at ~60 s. Both must not strand the conversation.
describe("subagent permission asks and long sync turns", () => {
  it("maps a task tool's child session to the parent conversation", async () => {
    const id = await useRuntimeStore.getState().sendPrompt("explore the repo");
    mocks.fireEvent({
      type: "tool.updated",
      sessionId: id,
      callId: "c1",
      tool: "task",
      status: "running",
      title: "Explore repo",
      childSessionId: "ses_child",
    });
    mocks.fireEvent({
      type: "permission.asked",
      sessionId: "ses_child",
      requestId: "per_1",
      action: "external_directory",
      resources: ["/repo/*"],
    });
    const s = useRuntimeStore.getState();
    expect(s.sessionParents["ses_child"]).toBe(id);
    expect(rootSessionOf(s.sessionParents, "ses_child")).toBe(id);
    expect(s.permissions).toHaveLength(1);
  });

  it("keeps the turn alive when a sync POST dies mid-turn but SSE kept streaming", async () => {
    mocks.dropCommandPost = true;
    const id = await useRuntimeStore.getState().runCommand("growth-marketing");
    expect(id).toBe("ses_new");
    const s = useRuntimeStore.getState();
    expect(
      s.threads["ses_new"].blocks.some((b) => b.kind === "status-line" && b.tone === "error"),
    ).toBe(false);
    expect(s.runningSessions["ses_new"]).toBe(true); // still working server-side
    expect(s.sending).toBe(false); // composer input unlocked for the queue
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_new" });
    expect(useRuntimeStore.getState().runningSessions["ses_new"]).toBeUndefined();
  });

  it("a command POST that fails before any event still shows the red line", async () => {
    mocks.failCommand = true;
    await useRuntimeStore.getState().runCommand("init");
    const s = useRuntimeStore.getState();
    const blocks = s.threads["ses_new"].blocks;
    expect(blocks[blocks.length - 1]).toMatchObject({ kind: "status-line", tone: "error" });
    expect(s.runningSessions["ses_new"]).toBeUndefined();
    expect(s.sending).toBe(false);
  });

  it("one reply answers all identical pending asks (same session, action, resources)", async () => {
    await useRuntimeStore.getState().sendPrompt("go");
    const ask = (requestId: string) =>
      mocks.fireEvent({
        type: "permission.asked",
        sessionId: "ses_child",
        requestId,
        action: "external_directory",
        resources: ["/repo/*"],
      });
    ask("per_a");
    ask("per_b");
    ask("per_c");
    expect(useRuntimeStore.getState().permissions).toHaveLength(3);
    await useRuntimeStore.getState().replyPermission("per_a", "always");
    expect(mocks.replyPermission).toHaveBeenCalledTimes(3);
    expect(mocks.replyPermission).toHaveBeenCalledWith("per_b", "always");
    expect(useRuntimeStore.getState().permissions).toHaveLength(0);
  });

  // Splitting a pane (or any re-render that re-answers) can carry a request the
  // runtime has already resolved. A 404 there means "already answered", not a
  // failure the user can act on — surfacing it put a scary banner over a click
  // that actually worked.
  it("treats an already-resolved permission (404) as answered, not as an error", async () => {
    await useRuntimeStore.getState().sendPrompt("go");
    const ask = (requestId: string) =>
      mocks.fireEvent({
        type: "permission.asked",
        sessionId: "ses_child",
        requestId,
        action: "external_directory",
        resources: ["/repo/*"],
      });
    ask("per_stale");
    ask("per_live");
    const gone = Object.assign(new Error("Failed to reply to the permission (404: not found)"), {
      status: 404,
    });
    mocks.replyPermission.mockImplementation((id: string) => {
      if (id === "per_stale") throw gone;
    });

    await useRuntimeStore.getState().replyPermission("per_stale", "always");

    expect(useRuntimeStore.getState().permissions).toHaveLength(0);
    expect(useRuntimeStore.getState().error).toBeNull();
  });

  it("still reports a permission reply that failed for a real reason", async () => {
    await useRuntimeStore.getState().sendPrompt("go");
    mocks.fireEvent({
      type: "permission.asked",
      sessionId: "ses_child",
      requestId: "per_x",
      action: "external_directory",
      resources: ["/repo/*"],
    });
    mocks.replyPermission.mockImplementation(() => {
      throw Object.assign(new Error("Failed to reply to the permission (500: boom)"), {
        status: 500,
      });
    });

    await useRuntimeStore.getState().replyPermission("per_x", "always");
    expect(useRuntimeStore.getState().error).toContain("500");
  });

  // A step still in flight when Stop lands never finished. Reloading the session
  // renders it "pending"; the live path has to agree, or its spinner turns
  // forever on a turn that is already over.
  it("settles the steps that were still running when the turn was interrupted", async () => {
    await useRuntimeStore.getState().sendPrompt("go");
    const sid = useRuntimeStore.getState().currentId!;
    useRuntimeStore.setState((s) => ({
      threads: {
        ...s.threads,
        [sid]: {
          blocks: [
            { kind: "tool-call", title: "python3 long.py", status: "running" },
            { kind: "tool-call", title: "rm -rf tmp", status: "waiting-approval" },
            { kind: "tool-call", title: "ls", status: "success" },
          ],
          index: {},
          loaded: true,
        },
      },
    }));

    await useRuntimeStore.getState().interrupt(sid);

    const blocks = useRuntimeStore.getState().threads[sid]!.blocks;
    const tools = blocks.filter((b) => b.kind === "tool-call");
    expect(tools.map((b) => (b as { status: string }).status)).toEqual([
      "pending",
      "pending",
      "success", // a finished step keeps its own outcome
    ]);
    expect(blocks[blocks.length - 1]).toMatchObject({ kind: "status-line", text: "Interrupted" });
  });

  it("sends one system notification for each new permission request", async () => {
    await useRuntimeStore.getState().sendPrompt("go");
    const permission = {
      type: "permission.asked" as const,
      sessionId: "ses_new",
      requestId: "per_notify",
      action: "bash",
      resources: ["npm install"],
    };

    mocks.fireEvent(permission);
    mocks.fireEvent(permission);

    expect(mocks.notifyPermissionRequest).toHaveBeenCalledTimes(1);
    expect(mocks.notifyPermissionRequest).toHaveBeenCalledWith({
      action: "bash",
      resources: ["npm install"],
    });
  });
});

// #38 — surfacing what the agent is doing: live step count and marking the tool
// the agent is blocked on as waiting-approval, right in the transcript.
describe("agent activity visibility (#38)", () => {
  it("tracks the model step number per session and clears it on idle", async () => {
    const id = (await useRuntimeStore.getState().sendPrompt("go"))!;
    mocks.fireEvent({ type: "step.updated", sessionId: id, step: 1 });
    mocks.fireEvent({ type: "step.updated", sessionId: id, step: 2 });
    expect(useRuntimeStore.getState().stepCounts[id]).toBe(2);
    mocks.fireEvent({ type: "session.idle", sessionId: id });
    expect(useRuntimeStore.getState().stepCounts[id]).toBeUndefined();
  });

  it("marks the newest running tool waiting-approval while a permission is pending, then restores it", async () => {
    const id = (await useRuntimeStore.getState().sendPrompt("go"))!;
    mocks.fireEvent({
      type: "tool.updated",
      sessionId: id,
      callId: "c1",
      tool: "bash",
      status: "running",
      title: "npm install",
      input: { command: "npm install" },
    });
    mocks.fireEvent({
      type: "permission.asked",
      sessionId: id,
      requestId: "per_1",
      action: "bash",
      resources: ["npm install"],
    });
    const blocked = useRuntimeStore
      .getState()
      .threads[id].blocks.find((b) => b.kind === "tool-call");
    expect(blocked).toMatchObject({ status: "waiting-approval" });
    mocks.fireEvent({ type: "permission.resolved", sessionId: id, requestId: "per_1" });
    const restored = useRuntimeStore
      .getState()
      .threads[id].blocks.find((b) => b.kind === "tool-call");
    expect(restored).toMatchObject({ status: "running" });
  });
});

// A missed session.idle (SSE reconnect window, directory-scoped event stream)
// must not spin "Working…" forever: the store reconciles its running locks
// against the server's truth, and the user can always interrupt a turn.
describe("stale running locks and interrupt", () => {
  const doneHistory = [
    { role: "user", parts: [{ type: "text", text: "hi" }] },
    { role: "assistant", completed: 1783301200079, parts: [{ type: "text", text: "all done" }] },
  ];

  it("reconcileRunning clears a stale lock and reloads the missed history", async () => {
    await useRuntimeStore.getState().sendPrompt("hi");
    expect(useRuntimeStore.getState().runningSessions["ses_new"]).toBe(true);
    mocks.messages = doneHistory; // the turn ended server-side; idle was missed
    await useRuntimeStore.getState().reconcileRunning();
    const s = useRuntimeStore.getState();
    expect(s.runningSessions["ses_new"]).toBeUndefined();
    expect(
      s.threads["ses_new"].blocks.some((b) => b.kind === "agent" && b.markdown === "all done"),
    ).toBe(true);
  });

  it("reconcileRunning keeps the lock while the turn is genuinely running", async () => {
    await useRuntimeStore.getState().sendPrompt("hi");
    mocks.messages = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", parts: [{ type: "text", text: "thinking…" }] }, // no `completed`
    ];
    await useRuntimeStore.getState().reconcileRunning();
    expect(useRuntimeStore.getState().runningSessions["ses_new"]).toBe(true);
  });

  it("connect() reconciles running locks left over from before the reconnect", async () => {
    await useRuntimeStore.getState().sendPrompt("hi");
    mocks.messages = doneHistory;
    await useRuntimeStore.getState().connect(); // e.g. a workspace switch
    await new Promise((r) => setTimeout(r, 10)); // reconcile runs behind connect
    expect(useRuntimeStore.getState().runningSessions["ses_new"]).toBeUndefined();
  });

  it("interrupt aborts the turn, unlocks the composer and marks the thread", async () => {
    await useRuntimeStore.getState().sendPrompt("hi");
    await useRuntimeStore.getState().interrupt();
    expect(mocks.abortSession).toHaveBeenCalledWith("ses_new");
    const s = useRuntimeStore.getState();
    expect(s.runningSessions["ses_new"]).toBeUndefined();
    expect(s.sending).toBe(false);
    expect(s.threads["ses_new"].blocks.slice(-1)[0]).toEqual({
      kind: "status-line",
      text: "Interrupted",
      tone: "error",
    });
  });

  it("the abort's own error/idle events add no noise after an interrupt", async () => {
    await useRuntimeStore.getState().sendPrompt("hi");
    await useRuntimeStore.getState().interrupt();
    const before = useRuntimeStore.getState().threads["ses_new"].blocks;
    mocks.fireEvent({ type: "error", sessionId: "ses_new", message: "The message was aborted" });
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_new" });
    expect(useRuntimeStore.getState().threads["ses_new"].blocks).toEqual(before);
  });

  it("swallows the abort's trailing error and BOTH idle events (only 'Interrupted' shows)", async () => {
    // Regression: the abort's SSE burst (an "aborted" error + two session.idle
    // events) arrives DURING the abort POST's await. If the guard is set after
    // the await, or consumed by the first idle, the thread grows a stray
    // "Aborted" and one or two "done" lines before "Interrupted".
    await useRuntimeStore.getState().sendPrompt("hi");
    mocks.abortTrailing = [
      { type: "error", sessionId: "ses_new", message: "The message was aborted" },
      { type: "session.idle", sessionId: "ses_new" },
      { type: "session.idle", sessionId: "ses_new" },
    ];
    await useRuntimeStore.getState().interrupt();
    const statusLines = useRuntimeStore
      .getState()
      .threads["ses_new"].blocks.filter((b) => b.kind === "status-line");
    expect(statusLines).toEqual([{ kind: "status-line", text: "Interrupted", tone: "error" }]);
  });

  it("a new turn after an interrupt folds its events normally again", async () => {
    await useRuntimeStore.getState().sendPrompt("hi");
    await useRuntimeStore.getState().interrupt();
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_new" }); // suppressed; guard clears on the next turn
    await useRuntimeStore.getState().sendPrompt("again");
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_new" });
    const s = useRuntimeStore.getState();
    expect(s.runningSessions["ses_new"]).toBeUndefined();
    expect(s.threads["ses_new"].blocks.slice(-1)[0]).toMatchObject({ kind: "status-line", tone: "done" });
  });

  it("interrupt does nothing when there is no session at all", async () => {
    await useRuntimeStore.getState().interrupt();
    expect(mocks.abortSession).not.toHaveBeenCalled();
  });

  // #59: "the agent can't stop". Every path below used to leave a live turn with
  // no way to stop it, because Stop was gated on a lock this app sets only when
  // IT starts a turn — and clears unconditionally, even on a failed abort.
  it("still aborts when the local running lock is gone (a turn this app lost track of)", async () => {
    const id = await useRuntimeStore.getState().sendPrompt("hi");
    await useRuntimeStore.getState().interrupt();
    mocks.abortSession.mockClear();
    await useRuntimeStore.getState().interrupt(id!);
    expect(mocks.abortSession).toHaveBeenCalledWith(id); // a second Stop reaches the server
  });

  it("a failed abort keeps the lock, reports the error and does NOT claim 'Interrupted'", async () => {
    const id = await useRuntimeStore.getState().sendPrompt("hi");
    mocks.abortSession.mockImplementationOnce(() => {
      throw new Error("Failed to interrupt the session");
    });
    await useRuntimeStore.getState().interrupt();
    const s = useRuntimeStore.getState();
    expect(s.runningSessions[id!]).toBe(true); // Stop stays available
    expect(s.error).toBe("Failed to interrupt the session");
    expect(s.threads[id!].blocks.some((b) => b.kind === "status-line" && b.text === "Interrupted")).toBe(false);
    // …and the session's events fold normally again (the guard was un-armed).
    mocks.fireEvent({ type: "session.idle", sessionId: id! });
    expect(useRuntimeStore.getState().threads[id!].blocks.slice(-1)[0]).toMatchObject({
      kind: "status-line",
      tone: "done",
    });
  });

  it("a streamed event re-locks a session whose in-memory lock was lost (reload)", async () => {
    const id = await useRuntimeStore.getState().sendPrompt("hi");
    // Simulate the reload: locks are in-memory only, the server keeps working.
    useRuntimeStore.setState({ runningSessions: {} });
    mocks.fireEvent({
      type: "tool.updated",
      sessionId: id!,
      callId: "c1",
      tool: "bash",
      status: "running",
      title: "ls /project",
    });
    expect(useRuntimeStore.getState().runningSessions[id!]).toBe(true);
  });

  it("the user message re-emitted after a turn ends does not restart the spinner", async () => {
    // OpenCode re-emits the turn's USER message ~40 ms after session.idle. That
    // surfaces as `message.agent`, which said nothing about the assistant — but
    // counting it as activity re-locked the session the instant it finished, so
    // a completed answer sat under a spinner until the ~15 s server poll cleared
    // it (and rebuilt the whole thread doing so). Reported as "shows done, then
    // keeps spinning for a while".
    const id = await useRuntimeStore.getState().sendPrompt("hi");
    mocks.fireEvent({ type: "session.idle", sessionId: id! });
    expect(useRuntimeStore.getState().runningSessions[id!]).toBeUndefined();

    mocks.fireEvent({ type: "message.agent", sessionId: id!, messageID: "msg_1", agent: "build" });
    expect(useRuntimeStore.getState().runningSessions[id!]).toBeUndefined();

    // Real assistant progress still re-locks (the #59 reload case above).
    mocks.fireEvent({ type: "step.updated", sessionId: id! });
    expect(useRuntimeStore.getState().runningSessions[id!]).toBe(true);
  });

  it("an interrupted session's trailing events do not re-lock it", async () => {
    const id = await useRuntimeStore.getState().sendPrompt("hi");
    await useRuntimeStore.getState().interrupt();
    mocks.fireEvent({
      type: "tool.updated",
      sessionId: id!,
      callId: "c1",
      tool: "bash",
      status: "running",
      title: "ls /project",
    });
    expect(useRuntimeStore.getState().runningSessions[id!]).toBeUndefined();
  });

  it("history seeds the lock for a session still mid-answer, but not for a finished one", async () => {
    mocks.messages = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", parts: [{ type: "text", text: "thinking…" }] }, // no `completed`
    ];
    await useRuntimeStore.getState().openSession("ses_live");
    expect(useRuntimeStore.getState().runningSessions["ses_live"]).toBe(true);
    mocks.messages = doneHistory;
    await useRuntimeStore.getState().openSession("ses_done");
    expect(useRuntimeStore.getState().runningSessions["ses_done"]).toBeUndefined();
  });

  it("a trailing USER message does not seed a lock (a never-answered turn stays idle)", async () => {
    mocks.messages = [{ role: "user", parts: [{ type: "text", text: "hi" }] }];
    await useRuntimeStore.getState().openSession("ses_stale");
    expect(useRuntimeStore.getState().runningSessions["ses_stale"]).toBeUndefined();
  });

  // The server deletes a pending permission when the turn it blocks is aborted,
  // but publishes no resolved event for it — nothing else retires the card.
  it("drops the approval the stopped turn was blocked on", async () => {
    const id = await useRuntimeStore.getState().sendPrompt("read the folder");
    mocks.fireEvent({
      type: "permission.asked", sessionId: id!, requestId: "per_1",
      action: "bash", resources: ["ls /project"],
    });
    expect(useRuntimeStore.getState().permissions).toHaveLength(1);
    await useRuntimeStore.getState().interrupt();
    expect(useRuntimeStore.getState().permissions).toEqual([]);
  });

  it("drops a stopped subagent's asks too, and keeps its trailing events quiet", async () => {
    const id = await useRuntimeStore.getState().sendPrompt("set up the project");
    mocks.fireEvent({
      type: "tool.updated", sessionId: id!, callId: "c1", tool: "task",
      status: "running", title: "Set up", childSessionId: "ses_child",
    });
    mocks.fireEvent({
      type: "permission.asked", sessionId: "ses_child", requestId: "per_9",
      action: "bash", resources: ["ls /project"],
    });
    expect(useRuntimeStore.getState().permissions).toHaveLength(1);
    await useRuntimeStore.getState().interrupt(id!);
    let s = useRuntimeStore.getState();
    expect(s.permissions).toEqual([]); // the child's ask died with the subtree
    expect(s.runningSessions["ses_child"]).toBeUndefined();
    // A late event from the stopped child must not re-lock anything.
    mocks.fireEvent({
      type: "tool.updated", sessionId: "ses_child", callId: "c2", tool: "bash",
      status: "running", title: "ls /project",
    });
    s = useRuntimeStore.getState();
    expect(s.runningSessions["ses_child"]).toBeUndefined();
    expect(s.runningSessions[id!]).toBeUndefined();
  });
});

// Editing a past user message: the block is tagged with its server id from the
// message.agent event, then editMessage reverts to it (dropping it + everything
// after) and resends the corrected text.
describe("edit a past user message", () => {
  /** Send "hi", tag the echo with a server id, then end the turn with a reply. */
  async function sendAndFinish(messageID: string) {
    await useRuntimeStore.getState().sendPrompt("hi");
    mocks.fireEvent({ type: "message.agent", sessionId: "ses_new", messageID, agent: "build" });
    mocks.fireEvent({ type: "text.updated", sessionId: "ses_new", partId: "t1", text: "wrong answer" });
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_new" });
  }

  it("tags the live user block with its message id from message.agent", async () => {
    await useRuntimeStore.getState().sendPrompt("hi");
    expect(useRuntimeStore.getState().threads["ses_new"].blocks[0]).toEqual({ kind: "user", text: "hi" });
    mocks.fireEvent({ type: "message.agent", sessionId: "ses_new", messageID: "msg_1", agent: "build" });
    expect(useRuntimeStore.getState().threads["ses_new"].blocks[0]).toEqual({
      kind: "user",
      text: "hi",
      messageID: "msg_1",
    });
  });

  it("reverts to the message, drops it and the reply, and resends the new text", async () => {
    await sendAndFinish("msg_1");
    await useRuntimeStore.getState().editMessage("msg_1", "hi fixed");

    expect(mocks.revertSpy).toHaveBeenCalledWith("ses_new", "msg_1", undefined);
    expect(mocks.sendPromptSpy).toHaveBeenLastCalledWith("ses_new", "hi fixed", undefined);
    const blocks = useRuntimeStore.getState().threads["ses_new"].blocks;
    const users = blocks.filter((b) => b.kind === "user");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ text: "hi fixed" });
    expect(blocks.some((b) => b.kind === "agent")).toBe(false);
  });

  it("stops a running turn before reverting", async () => {
    await useRuntimeStore.getState().sendPrompt("hi");
    mocks.fireEvent({ type: "message.agent", sessionId: "ses_new", messageID: "msg_1" });
    expect(useRuntimeStore.getState().runningSessions["ses_new"]).toBe(true);

    await useRuntimeStore.getState().editMessage("msg_1", "hi fixed");
    expect(mocks.abortSession).toHaveBeenCalledWith("ses_new");
    expect(mocks.revertSpy).toHaveBeenCalledWith("ses_new", "msg_1", undefined);
  });

  it("retries revert while the just-aborted session is still settling", async () => {
    mocks.failReverts = 2; // busy twice, then succeeds
    await sendAndFinish("msg_1");
    await useRuntimeStore.getState().editMessage("msg_1", "hi fixed");
    expect(mocks.revertSpy).toHaveBeenCalledTimes(3);
    expect(mocks.sendPromptSpy).toHaveBeenLastCalledWith("ses_new", "hi fixed", undefined);
  });

  it("surfaces an error and does not resend when revert keeps failing", async () => {
    mocks.failReverts = 99;
    await sendAndFinish("msg_1");
    mocks.sendPromptSpy.mockClear();
    await useRuntimeStore.getState().editMessage("msg_1", "hi fixed");
    expect(mocks.revertSpy).toHaveBeenCalledTimes(5);
    expect(useRuntimeStore.getState().error).toBeTruthy();
    expect(mocks.sendPromptSpy).not.toHaveBeenCalled();
  });

  it("revertMessage drops the message and everything after WITHOUT resending", async () => {
    await sendAndFinish("msg_1");
    mocks.sendPromptSpy.mockClear();
    const ok = await useRuntimeStore.getState().revertMessage("msg_1");
    expect(ok).toBe(true);
    expect(mocks.revertSpy).toHaveBeenCalledWith("ses_new", "msg_1", undefined);
    expect(mocks.sendPromptSpy).not.toHaveBeenCalled(); // caller prefills the composer instead
    expect(useRuntimeStore.getState().threads["ses_new"].blocks).toEqual([]);
  });

  it("revertMessage returns false (and does not truncate) when revert fails", async () => {
    mocks.failReverts = 99;
    await sendAndFinish("msg_1");
    const before = useRuntimeStore.getState().threads["ses_new"].blocks;
    const ok = await useRuntimeStore.getState().revertMessage("msg_1");
    expect(ok).toBe(false);
    expect(useRuntimeStore.getState().threads["ses_new"].blocks).toEqual(before);
  });
});

// The right pane belongs to a session: each one keeps its own open artifact /
// Files browser and gets it back when reopened — never another session's.
describe("per-session right pane", () => {
  const artifact = (path: string): ArtifactBlock => ({
    kind: "artifact",
    path,
    filename: path.split("/").pop()!,
    artifact: "report",
    tool: "write",
  });

  it("remembers each session's pane and restores it on switch-back", () => {
    useRuntimeStore.setState({ currentId: "ses_1" });
    useRuntimeStore.getState().openArtifact(artifact("report.pdf"));
    // Session 2 has nothing open; session 1's pdf must not leak into it.
    useRuntimeStore.setState({ currentId: "ses_2" });
    expect(useRuntimeStore.getState().panes["ses_2"]).toBeUndefined();
    useRuntimeStore.getState().openArtifact(artifact("analysis.ipynb"));
    // Back to session 1: the pdf is there again, untouched.
    useRuntimeStore.setState({ currentId: "ses_1" });
    expect(useRuntimeStore.getState().panes["ses_1"]?.artifact?.path).toBe("report.pdf");
    expect(useRuntimeStore.getState().panes["ses_2"]?.artifact?.path).toBe("analysis.ipynb");
  });

  it("a closed pane stays closed after switching away and back", () => {
    useRuntimeStore.setState({ currentId: "ses_1" });
    useRuntimeStore.getState().openArtifact(artifact("report.pdf"));
    useRuntimeStore.getState().closeArtifact();
    useRuntimeStore.setState({ currentId: "ses_2" });
    useRuntimeStore.setState({ currentId: "ses_1" });
    expect(useRuntimeStore.getState().panes["ses_1"]?.artifact).toBe(null);
  });

  it("the artifact inspector, Files browser, and Runs pane are mutually exclusive", () => {
    useRuntimeStore.setState({ currentId: "ses_1" });
    useRuntimeStore.getState().openArtifact(artifact("report.pdf"));
    useRuntimeStore.getState().setShowFiles(true);
    expect(useRuntimeStore.getState().panes["ses_1"]).toEqual({ artifact: null, showFiles: true, showRuns: false, showAgents: false });
    // Opening Runs closes Files; opening an artifact closes Runs.
    useRuntimeStore.getState().setShowRuns(true);
    expect(useRuntimeStore.getState().panes["ses_1"]).toEqual({ artifact: null, showFiles: false, showRuns: true, showAgents: false });
    useRuntimeStore.getState().openArtifact(artifact("report.pdf"));
    const p = useRuntimeStore.getState().panes["ses_1"];
    expect(p?.showFiles).toBe(false);
    expect(p?.showRuns).toBe(false);
  });

  it("grafts the draft's pane onto the session created by the first message", async () => {
    useRuntimeStore.getState().openArtifact(artifact("notes.md"));
    expect(useRuntimeStore.getState().panes[DRAFT_KEY]?.artifact?.path).toBe("notes.md");
    await useRuntimeStore.getState().sendPrompt("hi");
    const s = useRuntimeStore.getState();
    expect(s.panes[DRAFT_KEY]).toBeUndefined();
    expect(s.panes["ses_new"]?.artifact?.path).toBe("notes.md");
  });

  it("startDraft resets the draft pane; session panes keep their memory", () => {
    useRuntimeStore.setState({ currentId: "ses_1" });
    useRuntimeStore.getState().openArtifact(artifact("report.pdf"));
    useRuntimeStore.setState({ currentId: null });
    useRuntimeStore.getState().openArtifact(artifact("stale.md"));
    useRuntimeStore.getState().startDraft();
    const s = useRuntimeStore.getState();
    expect(s.panes[DRAFT_KEY]).toBeUndefined();
    expect(s.panes["ses_1"]?.artifact?.path).toBe("report.pdf");
  });

  it("switchWorkspace drops the draft pane (old folder's files) but not session panes", async () => {
    useRuntimeStore.setState({ currentId: "ses_1" });
    useRuntimeStore.getState().openArtifact(artifact("report.pdf"));
    useRuntimeStore.setState({ currentId: null });
    useRuntimeStore.getState().openArtifact(artifact("old-folder.md"));
    await useRuntimeStore.getState().switchWorkspace({ path: "/ws/other" });
    const s = useRuntimeStore.getState();
    expect(s.panes[DRAFT_KEY]).toBeUndefined();
    expect(s.panes["ses_1"]?.artifact?.path).toBe("report.pdf");
  });

  it("deleteSession forgets the session's pane", async () => {
    useRuntimeStore.setState({ currentId: "ses_1" });
    useRuntimeStore.getState().openArtifact(artifact("report.pdf"));
    await useRuntimeStore.getState().deleteSession("ses_1");
    expect(useRuntimeStore.getState().panes["ses_1"]).toBeUndefined();
  });
});


describe("approval mode", () => {
  it("loads the configured mode when connecting", async () => {
    expect(useRuntimeStore.getState().approvalMode).toBe("approve");
    mocks.approvalMode = "full";
    await useRuntimeStore.getState().connect();
    expect(useRuntimeStore.getState().approvalMode).toBe("full");
  });

  it("setApprovalMode persists the choice and reconnects to the restarted sidecar", async () => {
    await useRuntimeStore.getState().setApprovalMode("full");
    expect(mocks.setApprovalMode).toHaveBeenCalledWith("full");
    const s = useRuntimeStore.getState();
    expect(s.approvalMode).toBe("full");
    expect(s.status).toBe("ready"); // reconnected after the restart
  });

  it("setApprovalMode is a deliberate restart: `switching` masks the reconnect (no UI flash)", async () => {
    const p = useRuntimeStore.getState().setApprovalMode("full");
    // Synchronously flagged, like switchWorkspace — the page must not render
    // the restart as a disconnection.
    expect(useRuntimeStore.getState().switching).toBe(true);
    await p;
    const s = useRuntimeStore.getState();
    expect(s.switching).toBe(false);
    expect(s.status).toBe("ready");
  });

  it("setDefaultModel applies the model and reconnects seamlessly (no manual Connect)", async () => {
    const before = mocks.clientOpts.length;
    await useRuntimeStore.getState().setDefaultModel("anthropic/claude-sonnet-5");
    expect(mocks.setDefaultModelSpy).toHaveBeenCalledWith("anthropic/claude-sonnet-5");
    // A fresh client/event stream replaces the one the config change closed —
    // exactly one reconnect, so switching models never strands the app offline.
    expect(mocks.clientOpts.length - before).toBe(1);
    const s = useRuntimeStore.getState();
    expect(s.status).toBe("ready");
    expect(s.switching).toBe(false);
    expect(s.defaultModel).toBe("anthropic/claude-sonnet-5");
  });

  it("setDefaultModel masks the reconnect with `switching` (no disconnect flash)", async () => {
    const p = useRuntimeStore.getState().setDefaultModel("anthropic/claude-sonnet-5");
    expect(useRuntimeStore.getState().switching).toBe(true);
    await p;
    expect(useRuntimeStore.getState().switching).toBe(false);
    expect(useRuntimeStore.getState().status).toBe("ready");
  });

  it("setDefaultModel rejects an exhausted reconnect without rolling back the persisted model", async () => {
    const originalConnectRetry = useRuntimeStore.getState().connectRetry;
    useRuntimeStore.setState({
      connectRetry: vi.fn(async () => {
        useRuntimeStore.setState({
          status: "error",
          error: "Could not open OpenCode event stream",
        });
        return false;
      }),
    });

    try {
      await expect(
        useRuntimeStore.getState().setDefaultModel("anthropic/claude-sonnet-5"),
      ).rejects.toThrow("Could not open OpenCode event stream");
      const state = useRuntimeStore.getState();
      expect(state.status).toBe("error");
      expect(state.defaultModel).toBe("anthropic/claude-sonnet-5");
      expect(state.switching).toBe(false);
    } finally {
      useRuntimeStore.setState({ connectRetry: originalConnectRetry });
    }
  });

  it("setDefaultModel uses a stable error when exhausted reconnect has no message", async () => {
    const originalConnectRetry = useRuntimeStore.getState().connectRetry;
    useRuntimeStore.setState({
      connectRetry: vi.fn(async () => {
        useRuntimeStore.setState({ status: "error", error: null });
        return false;
      }),
    });

    try {
      await expect(
        useRuntimeStore.getState().setDefaultModel("anthropic/claude-sonnet-5"),
      ).rejects.toThrow("Runtime did not reconnect after setting the default model.");
    } finally {
      useRuntimeStore.setState({ connectRetry: originalConnectRetry });
    }
  });

  it("holds a ready→connecting blip so a self-recovering stream never repaints the page", async () => {
    // OpenCode closes /event ~1s after a config PATCH while rebuilding its
    // instance; the SDK reconnects in ~250ms. That blip must not reach the UI.
    vi.useFakeTimers();
    try {
      mocks.fireStatus("connecting");
      expect(useRuntimeStore.getState().status).toBe("ready"); // held
      mocks.fireStatus("ready");
      await vi.advanceTimersByTimeAsync(5000);
      expect(useRuntimeStore.getState().status).toBe("ready"); // never flipped
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces connecting when the stream does not recover within the grace window", async () => {
    vi.useFakeTimers();
    try {
      mocks.fireStatus("connecting");
      expect(useRuntimeStore.getState().status).toBe("ready");
      await vi.advanceTimersByTimeAsync(2000);
      expect(useRuntimeStore.getState().status).toBe("connecting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an error during the hold surfaces immediately", () => {
    mocks.fireStatus("connecting");
    mocks.fireStatus("error");
    expect(useRuntimeStore.getState().status).toBe("error");
  });

  it("loadCatalog never clobbers defaultModel while a switch is in flight", async () => {
    // The switch's reconnect fires loadCatalog, whose config read can still
    // answer with the pre-switch model while OpenCode rebuilds its instance —
    // applying it would visibly bounce the UI back to the previous model.
    try {
      useRuntimeStore.setState({ defaultModel: "moonshot/kimi-k2-thinking", switching: true });
      mocks.currentModel = "moonshot/kimi-k2.7-code"; // stale read-back
      await useRuntimeStore.getState().loadCatalog();
      expect(useRuntimeStore.getState().defaultModel).toBe("moonshot/kimi-k2-thinking");
      // Outside a switch the server value is authoritative again.
      useRuntimeStore.setState({ switching: false });
      await useRuntimeStore.getState().loadCatalog();
      expect(useRuntimeStore.getState().defaultModel).toBe("moonshot/kimi-k2.7-code");
    } finally {
      useRuntimeStore.setState({ switching: false });
    }
  });

  it("loadCatalog self-heals a dangling default model (#18)", async () => {
    // The stored default points at a provider/model that no longer exists.
    mocks.providers = [
      { id: "anthropic", name: "Anthropic", models: [{ id: "claude-sonnet-5", name: "Sonnet" }] },
    ];
    mocks.currentModel = "moonshot/kimi-removed"; // dangling: not in providers
    useRuntimeStore.setState({ switching: false, defaultModel: "moonshot/kimi-removed" });
    await useRuntimeStore.getState().loadCatalog();
    // Re-pointed to the closest surviving model so sends stop failing "model not found".
    expect(mocks.setDefaultModelSpy).toHaveBeenCalledWith("anthropic/claude-sonnet-5");
    expect(useRuntimeStore.getState().defaultModel).toBe("anthropic/claude-sonnet-5");
  });

  it("loadCatalog leaves a valid default model untouched (#18)", async () => {
    mocks.providers = [
      { id: "anthropic", name: "Anthropic", models: [{ id: "claude-sonnet-5", name: "Sonnet" }] },
    ];
    mocks.currentModel = "anthropic/claude-sonnet-5"; // valid
    useRuntimeStore.setState({ switching: false, defaultModel: "anthropic/claude-sonnet-5" });
    await useRuntimeStore.getState().loadCatalog();
    expect(mocks.setDefaultModelSpy).not.toHaveBeenCalled();
    expect(useRuntimeStore.getState().defaultModel).toBe("anthropic/claude-sonnet-5");
  });

  it("loadCatalog does NOT revert a model the user just switched to (#37)", async () => {
    // A deliberate switch to a valid model — it sticks.
    mocks.providers = [{ id: "step", name: "StepFun", models: [{ id: "step-2", name: "Step 2" }] }];
    mocks.currentModel = "step/step-2";
    await useRuntimeStore.getState().setDefaultModel("step/step-2");
    await new Promise((r) => setTimeout(r, 0)); // settle the reconnect's fired loadCatalog
    expect(useRuntimeStore.getState().defaultModel).toBe("step/step-2");
    mocks.setDefaultModelSpy.mockClear();

    // The very next catalog read comes back WITHOUT step-2 — the transient an
    // instance returns while it warms right after the switch's reconnect. The
    // old self-heal judged that "dangling" and reverted the user's choice to an
    // old model (#37); the grace window must leave the just-switched model alone.
    mocks.providers = [
      { id: "anthropic", name: "Anthropic", models: [{ id: "claude-sonnet-5", name: "Sonnet" }] },
    ];
    mocks.currentModel = "step/step-2"; // config still says step-2 (the PATCH landed)
    await useRuntimeStore.getState().loadCatalog();

    expect(mocks.setDefaultModelSpy).not.toHaveBeenCalled();
    expect(useRuntimeStore.getState().defaultModel).toBe("step/step-2");
  });
});

describe("reasoning-effort variant", () => {
  const withReasoning = [
    {
      id: "openai",
      name: "OpenAI",
      models: [{ id: "gpt-5", name: "GPT-5", variants: ["low", "medium", "high"] }],
    },
  ];
  const primeModel = async (variant: string | null) => {
    mocks.providers = withReasoning;
    mocks.currentModel = "openai/gpt-5";
    await useRuntimeStore.getState().loadCatalog();
    useRuntimeStore.setState({ reasoningVariant: variant });
  };

  it("forwards the selected variant when the current model exposes it", async () => {
    await primeModel("high");
    await useRuntimeStore.getState().sendPrompt("hi");
    expect(mocks.sendPromptFullSpy).toHaveBeenLastCalledWith(
      "ses_new",
      "hi",
      undefined,
      "openai/gpt-5",
      "high",
    );
  });

  it("forwards `max` on a model whose catalog reaches it (#74)", async () => {
    // The bundled 1.17.13 never offered `max`, so nothing exercised the top of
    // the range. Now that the runtime reports it, selecting it must reach the
    // turn — the guard is "does this model expose it", not a hardcoded ceiling.
    mocks.providers = [
      {
        id: "openai",
        name: "OpenAI",
        models: [
          {
            id: "gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            variants: ["none", "low", "medium", "high", "xhigh", "max"],
          },
        ],
      },
    ];
    mocks.currentModel = "openai/gpt-5.6-sol";
    await useRuntimeStore.getState().loadCatalog();
    useRuntimeStore.setState({ reasoningVariant: "max" });
    await useRuntimeStore.getState().sendPrompt("hi");
    expect(mocks.sendPromptFullSpy).toHaveBeenLastCalledWith(
      "ses_new",
      "hi",
      undefined,
      "openai/gpt-5.6-sol",
      "max",
    );
  });

  it("drops a variant the current model does not expose (would error server-side)", async () => {
    await primeModel("max"); // gpt-5 has only low/medium/high
    await useRuntimeStore.getState().sendPrompt("hi");
    const calls = mocks.sendPromptFullSpy.mock.calls;
    expect(calls[calls.length - 1]?.[4]).toBeUndefined();
  });

  it("sends no variant when none is selected", async () => {
    await primeModel(null);
    await useRuntimeStore.getState().sendPrompt("hi");
    const calls = mocks.sendPromptFullSpy.mock.calls;
    expect(calls[calls.length - 1]?.[4]).toBeUndefined();
  });

  it("persists the chosen variant across restarts", () => {
    useRuntimeStore.getState().setReasoningVariant("high");
    expect(window.localStorage.getItem("ai4s.models.variant.v1")).toBe("high");
    useRuntimeStore.getState().setReasoningVariant(null);
    expect(window.localStorage.getItem("ai4s.models.variant.v1")).toBeNull();
  });
});

// The store — not the Settings page — owns the fact "a model switch failed":
// the page derives its whole model surface from `connected || switching ||
// modelSwitchError`, so the browser stays on screen for a retry no matter how
// the attempt failed, and clears wherever the failure stops being true.
describe("model switch failure state", () => {
  const failReconnect = () =>
    vi.fn(async () => {
      useRuntimeStore.setState({ status: "error", error: "Could not open OpenCode event stream" });
      return false;
    });

  it("connectRetry resolves true on success and false when exhausted", async () => {
    await expect(useRuntimeStore.getState().connectRetry(1)).resolves.toBe(true);
    mocks.failConnects = 99;
    await expect(useRuntimeStore.getState().connectRetry(1)).resolves.toBe(false);
  });

  it("an exhausted reconnect records modelSwitchError", async () => {
    const original = useRuntimeStore.getState().connectRetry;
    useRuntimeStore.setState({ connectRetry: failReconnect() });
    try {
      await expect(
        useRuntimeStore.getState().setDefaultModel("anthropic/claude-sonnet-5"),
      ).rejects.toThrow();
      expect(useRuntimeStore.getState().modelSwitchError).toBe(
        "Could not open OpenCode event stream",
      );
    } finally {
      useRuntimeStore.setState({ connectRetry: original });
    }
  });

  it("a rejected model PATCH records modelSwitchError (retry keeps the browser up)", async () => {
    // The likely retry path: the server is still down, so the PATCH itself
    // rejects before any reconnect. The failure state must re-arm — this is
    // exactly the case where the old page-local flag silently dropped it.
    mocks.failSetModel = true;
    await expect(
      useRuntimeStore.getState().setDefaultModel("anthropic/claude-sonnet-5"),
    ).rejects.toThrow("Load failed");
    expect(useRuntimeStore.getState().modelSwitchError).toBe("Load failed");
    expect(useRuntimeStore.getState().defaultModel).toBe(null); // PATCH never landed
  });

  it("a later successful model switch clears modelSwitchError", async () => {
    useRuntimeStore.setState({ modelSwitchError: "stale" });
    await useRuntimeStore.getState().setDefaultModel("anthropic/claude-sonnet-5");
    expect(useRuntimeStore.getState().modelSwitchError).toBe(null);
  });

  it("a later successful reconnect clears modelSwitchError", async () => {
    useRuntimeStore.setState({ modelSwitchError: "stale" });
    await useRuntimeStore.getState().connectRetry(1);
    expect(useRuntimeStore.getState().modelSwitchError).toBe(null);
  });

  it("changing the server URL clears modelSwitchError", () => {
    useRuntimeStore.setState({ modelSwitchError: "stale" });
    useRuntimeStore.getState().setServerUrl("http://127.0.0.1:9999");
    expect(useRuntimeStore.getState().modelSwitchError).toBe(null);
  });

  it("disconnect clears modelSwitchError (offline shows the connect prompt again)", () => {
    useRuntimeStore.setState({ modelSwitchError: "stale" });
    useRuntimeStore.getState().disconnect();
    expect(useRuntimeStore.getState().modelSwitchError).toBe(null);
  });
});

describe("plan agent mode", () => {
  it("pins agent 'plan' on send, and grafts the draft's mode onto the new session", async () => {
    useRuntimeStore.getState().setAgentMode("plan");
    const id = await useRuntimeStore.getState().sendPrompt("plan an analysis");

    expect(mocks.sendPromptSpy).toHaveBeenLastCalledWith("ses_new", "plan an analysis", "plan");
    const { sessionAgents } = useRuntimeStore.getState();
    expect(sessionAgents[id!]).toBe("plan");
    expect(sessionAgents["draft"]).toBeUndefined();
  });

  it("omits the agent field entirely in build mode", async () => {
    await useRuntimeStore.getState().sendPrompt("hello");
    expect(mocks.sendPromptSpy).toHaveBeenLastCalledWith("ses_new", "hello", undefined);
  });

  it("never pins a stale plan mode when the runtime has no plan agent", async () => {
    useRuntimeStore.setState({ agents: [{ name: "build", description: "", mode: "primary" }] });
    useRuntimeStore.getState().setAgentMode("plan");
    await useRuntimeStore.getState().sendPrompt("hi");
    expect(mocks.sendPromptSpy).toHaveBeenLastCalledWith("ses_new", "hi", undefined);
  });

  it("follows OpenCode's plan_exit Yes-path: a build user message flips the pill", async () => {
    useRuntimeStore.getState().setAgentMode("plan");
    const id = await useRuntimeStore.getState().sendPrompt("plan it");
    expect(useRuntimeStore.getState().sessionAgents[id!]).toBe("plan");

    // The injected "Execute the plan" user message arrives with agent build.
    mocks.fireEvent({ type: "message.agent", sessionId: id, agent: "build" });

    expect(useRuntimeStore.getState().sessionAgents[id!]).toBe("build");
  });

  it("a fresh draft always starts in build", async () => {
    useRuntimeStore.getState().setAgentMode("plan");
    useRuntimeStore.getState().startDraft();
    expect(useRuntimeStore.getState().sessionAgents["draft"]).toBeUndefined();
  });

  it("reopening a session seeds the mode from the last user message's agent", async () => {
    mocks.messages = [
      { role: "user", agent: "build", parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", completed: 2, parts: [] },
      { role: "user", agent: "plan", parts: [{ type: "text", text: "plan X" }] },
      { role: "assistant", completed: 4, parts: [] },
    ];
    await useRuntimeStore.getState().openSession("ses_hist");
    expect(useRuntimeStore.getState().sessionAgents["ses_hist"]).toBe("plan");
  });
});

// A skill must end up somewhere every workspace can see: the app profile's user
// skills dir. Writing it into the session's own .opencode/skills/ loses it with
// that dated folder (#61).
describe("skill install", () => {
  it("installs a pasted SKILL.md itself — no session, no model turn", async () => {
    const skill = "---\nname: pasted-skill\ndescription: Say hi.\n---\n\nhi\n";
    const result = await useRuntimeStore.getState().installSkill(skill);

    expect(result).toEqual({ kind: "installed", name: "pasted-skill" });
    expect(mocks.installSkillMarkdown).toHaveBeenCalledWith(skill);
    expect(mocks.createSessionSpy).not.toHaveBeenCalled();
    expect(mocks.sendPromptSpy).not.toHaveBeenCalled();
  });

  it("opens the agent install in its OWN screen, echoing what the user typed", async () => {
    // A pane the user is working in must not be taken over by an install.
    const busy = makeLeaf("ses_busy");
    useLayoutStore.setState({
      groups: [{ id: "g-busy", name: "", tree: busy, focusedLeafId: busy.id, zoomedLeafId: null }],
      activeGroupId: "g-busy",
      tree: busy,
      focusedLeafId: busy.id,
      zoomedLeafId: null,
      ephemeralGroupId: null,
    });

    // Aimed at a project folder, as if the user were working in one.
    useRuntimeStore.setState({ draftWorkspaces: { [DRAFT_KEY]: "/ws/proj" }, workspace: "/ws/proj" });

    await useRuntimeStore.getState().installSkill("找到 dbs 这个 skills，安装");
    await new Promise((r) => setTimeout(r, 0));

    // An install is not part of that project: it gets its own plain dated
    // folder, and does not leave the folder pinned behind it.
    expect(mocks.newDatedWorkspace).toHaveBeenCalledTimes(1);
    expect(useRuntimeStore.getState().draftWorkspaces[DRAFT_KEY]).toBeUndefined();

    const layout = useLayoutStore.getState();
    expect(layout.groups).toHaveLength(2);
    expect(layout.activeGroupId).not.toBe("g-busy");
    // The busy pane still shows its own session.
    expect(leaves(layout.groups[0].tree!)[0].sessionId).toBe("ses_busy");
    // The new screen has one pane, bound to the install session.
    expect(leaves(layout.tree!).map((l) => l.sessionId)).toEqual(["ses_new"]);

    // The thread shows one short localized ask around the user's own words; the
    // model gets them wrapped in the full instructions.
    const blocks = useRuntimeStore.getState().threads["ses_new"].blocks;
    const shown = (blocks[0] as { kind: string; text: string }).text;
    expect(blocks[0].kind).toBe("user");
    expect(shown).toContain("找到 dbs 这个 skills，安装");
    expect(shown).not.toBe("找到 dbs 这个 skills，安装"); // carries the ask too
    const calls = mocks.sendPromptFullSpy.mock.calls;
    const sent = calls[calls.length - 1][1] as string;
    expect(sent).toContain("找到 dbs 这个 skills，安装");
    expect(sent.length).toBeGreaterThan("找到 dbs 这个 skills，安装".length);
    // Locked while the turn runs, so the pane shows a spinner and a Stop.
    expect(useRuntimeStore.getState().runningSessions["ses_new"]).toBe(true);
  });

  it("hands a URL to an agent session and adopts what it wrote when idle", async () => {
    const result = await useRuntimeStore
      .getState()
      .installSkill("https://example.com/skills/thing");

    expect(result).toEqual({ kind: "session", id: "ses_new" });
    expect(mocks.installSkillMarkdown).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.sendPromptSpy).toHaveBeenCalled();
    // Adoption waits for the turn to finish...
    expect(mocks.adoptWorkspaceSkills).not.toHaveBeenCalled();

    mocks.fireEvent({ type: "session.idle", sessionId: "ses_new" });
    await new Promise((r) => setTimeout(r, 0));

    // ...and skips the skills that were already in the workspace.
    expect(mocks.adoptWorkspaceSkills).toHaveBeenCalledWith(["already-there"]);
  });

  it("adopts only for the install's own session", async () => {
    await useRuntimeStore.getState().installSkill("https://example.com/skills/thing");
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_other" });
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.adoptWorkspaceSkills).not.toHaveBeenCalled();
  });

  it("keeps waiting when a turn ends before the skill exists (question, approval)", async () => {
    // First turn writes nothing (the agent stopped to ask something).
    mocks.adoptWorkspaceSkills.mockResolvedValueOnce([]);
    await useRuntimeStore.getState().installSkill("https://example.com/skills/thing");

    mocks.fireEvent({ type: "session.idle", sessionId: "ses_new" });
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.adoptWorkspaceSkills).toHaveBeenCalledTimes(1);

    // The finishing turn is still adopted — the install was not abandoned.
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_new" });
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.adoptWorkspaceSkills).toHaveBeenCalledTimes(2);

    // ...and once adopted it stops adopting on every later idle.
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_new" });
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.adoptWorkspaceSkills).toHaveBeenCalledTimes(2);
  });
});

describe("session rename and project filing", () => {
  it("renameSession retitles the row without re-listing (and so reordering) history", async () => {
    await useRuntimeStore.getState().connect();
    useRuntimeStore.setState({
      sessions: [
        { id: "ses_1", title: "New session - 2026-07-28T09:37:15.952Z" },
        { id: "ses_2", title: "other" },
      ],
    });

    // Leading/trailing whitespace is the user's typing, not part of the title.
    expect(await useRuntimeStore.getState().renameSession("ses_1", "  Spike sorting  ")).toBe(true);

    expect(mocks.renameSessionSpy).toHaveBeenCalledWith("ses_1", "Spike sorting");
    expect(useRuntimeStore.getState().sessions.map((s) => s.title)).toEqual([
      "Spike sorting",
      "other",
    ]);
  });

  it("renameSession ignores an empty or unchanged title", async () => {
    await useRuntimeStore.getState().connect();
    useRuntimeStore.setState({ sessions: [{ id: "ses_1", title: "Spike sorting" }] });

    expect(await useRuntimeStore.getState().renameSession("ses_1", "   ")).toBe(false);
    expect(await useRuntimeStore.getState().renameSession("ses_1", "Spike sorting")).toBe(false);
    expect(mocks.renameSessionSpy).not.toHaveBeenCalled();
  });

  it("renameSession keeps the old title when the runtime rejects it", async () => {
    await useRuntimeStore.getState().connect();
    useRuntimeStore.setState({ sessions: [{ id: "ses_1", title: "before" }] });
    mocks.failRename = true;

    expect(await useRuntimeStore.getState().renameSession("ses_1", "after")).toBe(false);
    expect(useRuntimeStore.getState().sessions[0]!.title).toBe("before");
    expect(useRuntimeStore.getState().error).toBe("rename rejected");
  });

  it("moveSessionToWorkspace re-homes the conversation so it groups under the project", async () => {
    await useRuntimeStore.getState().connect();
    useRuntimeStore.setState({ sessions: [{ id: "ses_1", title: "loose work" }] });
    // The move also re-homes the session's subagent children, so the store
    // re-lists afterwards; the server reports both in the destination folder.
    mocks.sessionList = [
      { id: "ses_1", title: "loose work", directory: "/work/projects/bci" },
      { id: "ses_2", title: "subagent", directory: "/work/projects/bci" },
    ];

    expect(
      await useRuntimeStore.getState().moveSessionToWorkspace("ses_1", "/work/projects/bci"),
    ).toBe(true);
    await vi.waitFor(() => expect(useRuntimeStore.getState().sessions).toHaveLength(2));

    expect(mocks.moveSessionSpy).toHaveBeenCalledWith("ses_1", "/work/projects/bci");
    expect(useRuntimeStore.getState().sessions.map((s) => s.directory)).toEqual([
      "/work/projects/bci",
      "/work/projects/bci",
    ]);
  });
});

// #72: a file-changing turn forks a read-only background reviewer. Its result
// is persisted on the parent checkpoint without taking the parent's running
// lock; only one hidden reviewer streams at a time (#50).
describe("auto-review on turn completion", () => {
  const REVIEWER_AGENTS = [
    { name: "build", description: "", mode: "primary" as const },
    { name: "reviewer", description: "", mode: "all" as const },
  ];

  // The review queue and its single slot are module state (deliberately: store
  // writes on streamed events repaint every subscriber — #50). `disconnect` is
  // what clears them in production, so each test starts from a runtime that
  // owes no review, instead of inheriting the previous test's in-flight one.
  beforeEach(async () => {
    useRuntimeStore.getState().disconnect();
    await useRuntimeStore.getState().connect();
  });

  /** Enable auto-review with the reviewer agent present and `ids` listed. */
  function armed(ids: string[], extra: Record<string, unknown> = {}) {
    mocks.messages = [
      { role: "user", id: "msg_user", completed: 1, parts: [{ type: "text", text: "do it" }] },
      {
        role: "assistant",
        id: "msg_checkpoint",
        completed: 2,
        parts: [{ type: "text", text: "done" }],
      },
    ];
    useRuntimeStore.setState({
      autoReview: true,
      agents: REVIEWER_AGENTS,
      sessions: ids.map((id) => ({ id, title: id })),
      ...extra,
    } as never);
  }

  /** One turn that wrote a file, then went idle. */
  function wroteAFile(sid: string) {
    mocks.fireEvent({
      type: "tool.updated",
      sessionId: sid,
      callId: `c-${sid}`,
      tool: "write",
      status: "success",
      title: "",
      input: { filePath: "analysis.py" },
    });
  }

  const reviewCalls = () =>
    mocks.sendPromptFullSpy.mock.calls.filter((c) => c[2] === "reviewer");

  function finishReview(index = reviewCalls().length - 1) {
    const sid = reviewCalls()[index]![0] as string;
    mocks.fireEvent({
      type: "text.updated",
      sessionId: sid,
      partId: `part-${sid}`,
      text:
        "```review\n" +
        '{"findings":[{"level":"warn","title":"Check the reported value","evidence":"report.md:4"}],"note":"Background review."}' +
        "\n```",
    });
    mocks.fireEvent({ type: "session.idle", sessionId: sid });
    return sid;
  }

  it("sends one reviewer turn, with no model of its own, after a file changed", async () => {
    armed(["ses_1"]);
    wroteAFile("ses_1");
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_1" });
    await vi.waitFor(() => expect(reviewCalls()).toHaveLength(1));

    const [sid, text, agent, model, variant] = reviewCalls()[0]!;
    expect(sid).toBe("ses_review_1");
    expect(mocks.forkSessionSpy).toHaveBeenCalledWith("ses_1", undefined);
    expect(text).toContain("Review the work just completed");
    expect(text).toContain("- analysis.py");
    expect(agent).toBe("reviewer");
    // No per-turn model or effort: those come from the reviewer's own per-agent
    // config (#71), which an explicit model would override.
    expect(model).toBeUndefined();
    expect(variant).toBeUndefined();
    // The foreground is immediately usable; only a quiet background status is set.
    expect(useRuntimeStore.getState().runningSessions["ses_1"]).toBeUndefined();
    expect(useRuntimeStore.getState().backgroundReviews["ses_1"]).toBe("running");

    // The hidden fork's result is attached to the parent checkpoint and its own
    // reasoning/tool transcript is discarded.
    finishReview();
    await vi.waitFor(() => expect(mocks.appendTextPartSpy).toHaveBeenCalledTimes(1));
    expect(reviewCalls()).toHaveLength(1);
    expect(mocks.appendTextPartSpy).toHaveBeenCalledWith(
      "ses_1",
      "msg_checkpoint",
      expect.stringContaining("Check the reported value"),
      expect.stringMatching(/^prt_[A-Za-z0-9]+$/),
    );
    expect(useRuntimeStore.getState().backgroundReviews["ses_1"]).toBeUndefined();
    expect(
      useRuntimeStore.getState().threads["ses_1"].blocks.some((block) => block.kind === "reviewer"),
    ).toBe(true);
    expect(useRuntimeStore.getState().threads["ses_review_1"]).toBeUndefined();

    // The server echoes the synthetic part update. It refreshes the card but
    // must not relock the idle parent as though a new model turn had started.
    mocks.fireEvent({
      type: "text.updated",
      sessionId: "ses_1",
      partId: mocks.appendTextPartSpy.mock.calls[0]![3],
      text: mocks.appendTextPartSpy.mock.calls[0]![2],
    });
    expect(useRuntimeStore.getState().runningSessions["ses_1"]).toBeUndefined();
  });

  it("lets the user stop a background review without adding a fake result", async () => {
    armed(["ses_1"]);
    wroteAFile("ses_1");
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_1" });
    await vi.waitFor(() => expect(reviewCalls()).toHaveLength(1));

    useRuntimeStore.getState().cancelAutoReview("ses_1");
    await vi.waitFor(() =>
      expect(useRuntimeStore.getState().backgroundReviews["ses_1"]).toBeUndefined(),
    );
    expect(mocks.abortSession).toHaveBeenCalledWith("ses_review_1");
    expect(mocks.appendTextPartSpy).not.toHaveBeenCalled();
    expect(useRuntimeStore.getState().threads["ses_review_1"]).toBeUndefined();
  });

  it("turning auto-review off cancels the running review and every queued review", async () => {
    armed(["ses_a", "ses_b"]);
    wroteAFile("ses_a");
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_a" });
    await vi.waitFor(() => expect(reviewCalls()).toHaveLength(1));

    wroteAFile("ses_b");
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_b" });
    await vi.waitFor(() =>
      expect(useRuntimeStore.getState().backgroundReviews).toEqual({
        ses_a: "running",
        ses_b: "queued",
      }),
    );

    window.localStorage.setItem("ai4s.autoReview.v1", "1");
    useRuntimeStore.getState().setAutoReview(false);

    await vi.waitFor(() => expect(mocks.abortSession).toHaveBeenCalledWith("ses_review_1"));
    await vi.waitFor(() => expect(useRuntimeStore.getState().backgroundReviews).toEqual({}));
    expect(window.localStorage.getItem("ai4s.autoReview.v1")).toBeNull();
    expect(mocks.appendTextPartSpy).not.toHaveBeenCalled();
    expect(reviewCalls()).toHaveLength(1);
  });

  it("turning auto-review off while history loads prevents the hidden fork", async () => {
    let releaseHistory!: () => void;
    mocks.messagesGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    armed(["ses_1"]);
    wroteAFile("ses_1");
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_1" });
    await vi.waitFor(() => expect(mocks.getMessages).toHaveBeenCalledWith("ses_1"));
    expect(useRuntimeStore.getState().backgroundReviews["ses_1"]).toBe("running");

    useRuntimeStore.getState().setAutoReview(false);
    releaseHistory();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.forkSessionSpy).not.toHaveBeenCalled();
    expect(reviewCalls()).toHaveLength(0);
    expect(useRuntimeStore.getState().backgroundReviews).toEqual({});
  });

  it("rechecks the switch before draining a stale queued review", async () => {
    armed(["ses_a", "ses_b"]);
    wroteAFile("ses_a");
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_a" });
    await vi.waitFor(() => expect(reviewCalls()).toHaveLength(1));

    wroteAFile("ses_b");
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_b" });
    await vi.waitFor(() =>
      expect(useRuntimeStore.getState().backgroundReviews["ses_b"]).toBe("queued"),
    );

    // Simulate stale persisted/module state: the queue itself must defend the
    // invariant even when the public setter was not the path that flipped it.
    useRuntimeStore.setState({ autoReview: false });
    finishReview(0);

    await vi.waitFor(() =>
      expect(useRuntimeStore.getState().backgroundReviews["ses_b"]).toBeUndefined(),
    );
    expect(reviewCalls()).toHaveLength(1);
  });

  it("stops the hidden reviewer when its parent session is deleted", async () => {
    armed(["ses_1"]);
    wroteAFile("ses_1");
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_1" });
    await vi.waitFor(() => expect(reviewCalls()).toHaveLength(1));

    await useRuntimeStore.getState().deleteSession("ses_1");
    expect(mocks.abortSession).toHaveBeenCalledWith("ses_review_1");
    expect(useRuntimeStore.getState().backgroundReviews["ses_1"]).toBeUndefined();

    // Trailing server events from the aborted hidden child stay invisible and
    // cannot synthesize a finding for a parent that no longer exists.
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_review_1" });
    expect(mocks.appendTextPartSpy).not.toHaveBeenCalled();
    expect(useRuntimeStore.getState().threads["ses_review_1"]).toBeUndefined();
  });

  it("forks before a newer foreground turn so the reviewed checkpoint is included", async () => {
    armed(["ses_1"]);
    useRuntimeStore.setState({
      threads: {
        ses_1: {
          loaded: true,
          index: {},
          blocks: [
            { kind: "user", text: "do it", messageID: "msg_user" },
            { kind: "agent", markdown: "done" },
            { kind: "user", text: "continue", messageID: "msg_next_turn" },
          ],
        },
      },
    } as never);
    mocks.messages.push({
      role: "user",
      id: "msg_next_turn",
      parts: [{ type: "text", text: "continue" }],
    });
    wroteAFile("ses_1");
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_1" });

    await vi.waitFor(() => expect(reviewCalls()).toHaveLength(1));
    expect(mocks.forkSessionSpy).toHaveBeenCalledWith("ses_1", "msg_next_turn");
    finishReview();
    await vi.waitFor(() =>
      expect(mocks.appendTextPartSpy).toHaveBeenCalledWith(
        "ses_1",
        "msg_checkpoint",
        expect.any(String),
        expect.any(String),
      ),
    );
    const blocks = useRuntimeStore.getState().threads["ses_1"].blocks;
    const reviewAt = blocks.findIndex((block) => block.kind === "reviewer");
    const nextTurnAt = blocks.findIndex(
      (block) => block.kind === "user" && block.messageID === "msg_next_turn",
    );
    expect(reviewAt).toBeGreaterThan(0);
    expect(reviewAt).toBeLessThan(nextTurnAt);
  });

  it("stays off until the user opts in", async () => {
    useRuntimeStore.setState({ agents: REVIEWER_AGENTS } as never);
    wroteAFile("ses_1");
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(reviewCalls()).toHaveLength(0);
  });

  it("skips a read-only turn", async () => {
    armed(["ses_1"]);
    mocks.fireEvent({
      type: "tool.updated",
      sessionId: "ses_1",
      callId: "c-read",
      tool: "read",
      status: "success",
      title: "",
      input: { filePath: "analysis.py" },
    });
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(reviewCalls()).toHaveLength(0);
  });

  it("leaves a subagent's own turn to its parent", async () => {
    armed(["ses_parent", "ses_child"], { sessionParents: { ses_child: "ses_parent" } });
    wroteAFile("ses_child");
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_child" });
    await new Promise((r) => setTimeout(r, 0));
    expect(reviewCalls()).toHaveLength(0);
  });

  it("reviews the parent's turn when a subagent did the writing", async () => {
    // The child session is never reviewed on its own, so crediting its writes to
    // it meant a turn that delegated EVERY file change — the `task`-only turn —
    // was reviewed by nobody, which is the opposite of what the gate promises.
    armed(["ses_parent", "ses_child"], { sessionParents: { ses_child: "ses_parent" } });
    wroteAFile("ses_child");
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_child" });
    await new Promise((r) => setTimeout(r, 0));
    expect(reviewCalls()).toHaveLength(0);

    mocks.fireEvent({ type: "session.idle", sessionId: "ses_parent" });
    await vi.waitFor(() => expect(reviewCalls()).toHaveLength(1));
    expect(mocks.forkSessionSpy).toHaveBeenCalledWith("ses_parent", undefined);
    expect(reviewCalls()[0]![0]).toBe("ses_review_1");
  });

  // Session ids of its own: interrupting one marks it interrupted for the rest of
  // the file (module state, by design — the next turn clears it), and reusing an
  // id afterwards would silence that session's idle events in later tests.
  it("does not turn one owed review into two when the session is also dirty", async () => {
    armed(["ses_c", "ses_d"]);
    wroteAFile("ses_c");
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_c" });
    await vi.waitFor(() => expect(reviewCalls()).toHaveLength(1)); // ses_c holds the slot

    wroteAFile("ses_d");
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_d" });
    await new Promise((r) => setTimeout(r, 0)); // ses_d is queued

    // Another completed change is coalesced into the same queued review.
    wroteAFile("ses_d");
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_d" });
    expect(reviewCalls()).toHaveLength(1);

    finishReview(0);
    await vi.waitFor(() => expect(reviewCalls()).toHaveLength(2));
    expect(reviewCalls()[1]![0]).toBe("ses_review_2");

    finishReview(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(reviewCalls()).toHaveLength(2);
  });

  it("does nothing when the runtime exposes no reviewer agent", async () => {
    useRuntimeStore.setState({
      autoReview: true,
      agents: [{ name: "build", description: "", mode: "primary" }],
    } as never);
    wroteAFile("ses_1");
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(reviewCalls()).toHaveLength(0);
  });

  it("does not review a turn the user interrupted", async () => {
    armed(["ses_1"]);
    wroteAFile("ses_1");
    // The abort's own trailing idle is what would otherwise look like a
    // finished turn.
    mocks.abortTrailing = [{ type: "session.idle", sessionId: "ses_1" }];
    await useRuntimeStore.getState().interrupt("ses_1");
    await new Promise((r) => setTimeout(r, 0));
    expect(reviewCalls()).toHaveLength(0);
  });

  it("does not review a turn that died, and frees the slot when a review dies", async () => {
    armed(["ses_a", "ses_b"]);
    // A turn that wrote a file and then failed (rate limit, dangling model):
    // the work is half-finished, so it is not reviewed.
    wroteAFile("ses_a");
    mocks.fireEvent({ type: "error", sessionId: "ses_a", message: "model not found" });
    await new Promise((r) => setTimeout(r, 0));
    expect(reviewCalls()).toHaveLength(0);
    // Its trailing idle must not review it either — the error consumed the change.
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_a" });
    await new Promise((r) => setTimeout(r, 0));
    expect(reviewCalls()).toHaveLength(0);

    // A review that dies the same way hands its slot back, so the next session
    // is still reviewed instead of waiting forever.
    wroteAFile("ses_a");
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_a" });
    await vi.waitFor(() => expect(reviewCalls()).toHaveLength(1));
    mocks.fireEvent({ type: "error", sessionId: "ses_review_1", message: "provider exploded" });
    await new Promise((r) => setTimeout(r, 0));
    expect(useRuntimeStore.getState().runningSessions["ses_a"]).toBeUndefined();
    expect(useRuntimeStore.getState().threads["ses_review_1"]).toBeUndefined();

    wroteAFile("ses_b");
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_b" });
    await vi.waitFor(() => expect(reviewCalls()).toHaveLength(2));
    expect(reviewCalls()[1]![0]).toBe("ses_review_2");
  });

  it("runs one review at a time and gets to the second session afterwards", async () => {
    armed(["ses_a", "ses_b"]);
    wroteAFile("ses_a");
    wroteAFile("ses_b");
    // Both panes finish at once: only one review starts.
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_a" });
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_b" });
    await vi.waitFor(() => expect(reviewCalls()).toHaveLength(1));
    expect(reviewCalls()[0]![0]).toBe("ses_review_1");

    // The first review ends → the queued session is reviewed, not dropped.
    finishReview(0);
    await vi.waitFor(() => expect(reviewCalls()).toHaveLength(2));
    expect(reviewCalls()[1]![0]).toBe("ses_review_2");

    finishReview(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(reviewCalls()).toHaveLength(2);
  });

  it("queues a waiting session once, however many turns it finishes", async () => {
    // The queue is the SET of sessions owed a review. A pane that keeps working
    // while another session's review holds the slot used to be pushed once per
    // finished turn, and each duplicate survived the drain that started its
    // review — turning into a second paid review of the same state.
    armed(["ses_a", "ses_b"]);
    wroteAFile("ses_a");
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_a" });
    await vi.waitFor(() => expect(reviewCalls()).toHaveLength(1));

    // Three more file-changing turns in the other pane while ses_a is reviewed.
    for (let i = 0; i < 3; i++) {
      wroteAFile("ses_b");
      mocks.fireEvent({ type: "session.idle", sessionId: "ses_b" });
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(reviewCalls()).toHaveLength(1); // still just ses_a's

    // The slot frees: ses_b is reviewed exactly once, not once per queued copy.
    finishReview(0);
    await vi.waitFor(() => expect(reviewCalls()).toHaveLength(2));
    expect(reviewCalls()[1]![0]).toBe("ses_review_2");
    finishReview(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(reviewCalls()).toHaveLength(2);
  });

  it("relays one interactive sign-in per ssh_connect call, not one per event", async () => {
    // #73: the agent reaches the sign-in dialog through its `ssh_connect` tool,
    // and one tool call streams several `tool.updated` events (the SDK re-emits
    // per part update). Opening a sign-in is the opposite of idempotent: each
    // repeat started another ssh master racing the first for one ControlPath, and
    // the answer the user typed need not have reached the one that won.
    useRuntimeStore.setState({ sessions: [{ id: "ses_1", title: "s" }] } as never);
    const connect = vi.spyOn(useSshStore.getState(), "connect").mockResolvedValue(undefined);
    const asking = (status: string, callId = "call-ssh-1") => ({
      type: "tool.updated" as const,
      sessionId: "ses_1",
      callId,
      tool: "ssh_connect",
      status,
      title: "",
      input: { host: "login.cluster.edu" },
    });

    mocks.fireEvent(asking("pending"));
    mocks.fireEvent(asking("running"));
    mocks.fireEvent(asking("running"));
    await new Promise((r) => setTimeout(r, 0));
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith("login.cluster.edu");

    // A genuinely different call still reaches the dialog.
    mocks.fireEvent(asking("running", "call-ssh-2"));
    await new Promise((r) => setTimeout(r, 0));
    expect(connect).toHaveBeenCalledTimes(2);
    connect.mockRestore();
  });

  it("keeps a review owed by an earlier turn when a later turn is interrupted", async () => {
    // The files that earned the review are on disk. Interrupting a LATER turn
    // says nothing about them, but the owed entry used to be consumed by the
    // interrupt's bookkeeping and the review was silently dropped.
    armed(["ses_a", "ses_b"]);
    wroteAFile("ses_a");
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_a" });
    await vi.waitFor(() => expect(reviewCalls()).toHaveLength(1)); // ses_a holds the slot

    wroteAFile("ses_b"); // ses_b now owes a review and is queued
    mocks.fireEvent({ type: "session.idle", sessionId: "ses_b" });
    await new Promise((r) => setTimeout(r, 0));

    // The user starts and interrupts another turn in ses_b.
    mocks.abortTrailing = [{ type: "session.idle", sessionId: "ses_b" }];
    await useRuntimeStore.getState().interrupt("ses_b");
    await new Promise((r) => setTimeout(r, 0));
    expect(reviewCalls()).toHaveLength(1); // the interrupt itself is not reviewed

    // Once the slot frees, the review ses_b was already owed still happens.
    finishReview(0);
    await vi.waitFor(() => expect(reviewCalls()).toHaveLength(2));
    expect(reviewCalls()[1]![0]).toBe("ses_review_2");
  });
});

// #96: an agent carrying its own configured model must actually get to use it.
// The send used to pass an explicit per-turn model unconditionally, which
// overrode exactly that setting — so the `build` row did nothing to the
// messages you send, and Plan mode ignored its own model (#85).
describe("per-agent model precedence", () => {
  const withAgents = async (agentModels: Record<string, string>) => {
    mocks.currentModel = "openai/gpt-5";
    await useRuntimeStore.getState().loadCatalog();
    useRuntimeStore.setState({
      agents: [
        { name: "build", description: "" },
        { name: "plan", description: "" },
      ],
      agentModels,
      agentVariants: {},
      defaultModel: "openai/gpt-5",
      // Start from a clean pane: a per-session model set by an earlier test
      // grafts onto the session its first send creates, and `currentId` would
      // then carry that pick into this one.
      sessionModels: {},
      sessionVariants: {},
      sessionAgents: {},
      currentId: null,
    });
  };
  const lastSend = () => {
    const calls = mocks.sendPromptFullSpy.mock.calls;
    return calls[calls.length - 1]!;
  };

  it("sends no model when the build agent has one, so its setting is what runs", async () => {
    await withAgents({ build: "anthropic/claude-opus-4-8" });
    await useRuntimeStore.getState().sendPrompt("hi");
    const [, , agent, model] = lastSend();
    expect(agent).toBeUndefined();
    expect(model).toBeNull();
  });

  it("still pins the default when no agent model is configured (#8 unchanged)", async () => {
    await withAgents({});
    await useRuntimeStore.getState().sendPrompt("hi");
    expect(lastSend()[3]).toBe("openai/gpt-5");
  });

  it("a model picked in THIS conversation outranks the agent setting", async () => {
    await withAgents({ build: "anthropic/claude-opus-4-8" });
    useRuntimeStore.getState().setSessionModel(DRAFT_KEY, "openai/o3");
    await useRuntimeStore.getState().sendPrompt("hi");
    expect(lastSend()[3]).toBe("openai/o3");
  });

  it("clearing the pick hands the turn back to the agent setting", async () => {
    await withAgents({ build: "anthropic/claude-opus-4-8" });
    useRuntimeStore.getState().setSessionModel(DRAFT_KEY, "openai/o3");
    useRuntimeStore.getState().clearSessionModel(DRAFT_KEY);
    await useRuntimeStore.getState().sendPrompt("hi");
    expect(lastSend()[3]).toBeNull();
  });

  it("plan mode follows the plan agent's model, not the build one", async () => {
    await withAgents({ build: "anthropic/claude-opus-4-8" });
    useRuntimeStore.setState({ sessionAgents: { [DRAFT_KEY]: "plan" } });
    await useRuntimeStore.getState().sendPrompt("hi");
    const [, , agent, model] = lastSend();
    expect(agent).toBe("plan");
    // `plan` has no configured model, so the default is still pinned…
    expect(model).toBe("openai/gpt-5");

    // …and once it does, the turn stops overriding it.
    useRuntimeStore.setState({ agentModels: { build: "x/y", plan: "openai/o3" } });
    await useRuntimeStore.getState().sendPrompt("hi again");
    expect(lastSend()[3]).toBeNull();
  });

  it("infers nothing from a catalog without the agent (older sidecar)", async () => {
    await withAgents({ build: "anthropic/claude-opus-4-8" });
    useRuntimeStore.setState({ agents: [] });
    await useRuntimeStore.getState().sendPrompt("hi");
    expect(lastSend()[3]).toBe("openai/gpt-5");
  });
});

// Switching Screens changes the whole set of tiled folders at once. Closing
// each departing stream on the spot meant a flip between two Screens paid a
// fresh SSE handshake every time — against a per-directory OpenCode instance
// that starts lazily, i.e. a cold start on the switch's critical path (#92).
describe("background pane streams", () => {
  const dirsBuilt = () =>
    mocks.clientOpts.map((o) => o.directory).filter((d): d is string => typeof d === "string");

  beforeEach(() => {
    useRuntimeStore.setState({ workspace: "/ws/foreground" });
    mocks.clientOpts.length = 0;
  });

  it("survives a Screen switch away and back without reconnecting", () => {
    const sync = useRuntimeStore.getState().syncPaneStreams;
    sync(["/ws/a"]);
    expect(dirsBuilt()).toEqual(["/ws/a"]);

    // Switch to a Screen that shows neither folder…
    sync([]);
    expect(mocks.closedDirs).not.toContain("/ws/a");

    // …and back: the same stream is still there, so nothing is rebuilt.
    sync(["/ws/a"]);
    expect(dirsBuilt()).toEqual(["/ws/a"]);
    expect(mocks.closedDirs).not.toContain("/ws/a");
  });

  it("retires a stream that stays gone", () => {
    vi.useFakeTimers();
    try {
      const sync = useRuntimeStore.getState().syncPaneStreams;
      sync(["/ws/a"]);
      sync([]);
      vi.advanceTimersByTime(60_000);
      expect(mocks.closedDirs).toContain("/ws/a");
    } finally {
      vi.useRealTimers();
    }
  });

  // Two live streams on one folder fold every event twice, so the foreground's
  // own folder is still dropped the moment it is adopted — no grace period.
  it("drops the foreground folder's background stream at once", () => {
    const sync = useRuntimeStore.getState().syncPaneStreams;
    sync(["/ws/a"]);
    useRuntimeStore.setState({ workspace: "/ws/a" });
    sync(["/ws/a"]);
    expect(mocks.closedDirs).toContain("/ws/a");
  });
});
