import { describe, it, expect, vi } from "vitest";
import type { LayoutGroup, PaneNode, TerminalAgent } from "./layout";

/** A fresh store holding `groups` (active: the first), with nothing remembered
 *  from an earlier test — the last-Screen-per-project memory is module state. */
async function fresh(groups: LayoutGroup[], activeGroupId = groups[0].id) {
  window.localStorage.clear();
  vi.resetModules();
  const mod = await import("./layout");
  const active = groups.find((g) => g.id === activeGroupId)!;
  mod.useLayoutStore.setState({
    groups,
    activeGroupId,
    tree: active.tree,
    focusedLeafId: active.focusedLeafId,
    zoomedLeafId: null,
    ephemeralGroupId: null,
  });
  return { ...mod, S: () => mod.useLayoutStore.getState() };
}

const leaf = (id: string, sessionId: string | null, content?: object): PaneNode =>
  ({ kind: "leaf", id, sessionId, ...(content ? { content } : {}) }) as PaneNode;

const group = (id: string, projectId: string | undefined, tree: PaneNode | null): LayoutGroup => ({
  id,
  name: "",
  projectId,
  tree,
  focusedLeafId: tree && tree.kind === "leaf" ? tree.id : null,
  zoomedLeafId: null,
});

describe("Screens belong to projects", () => {
  it("the active project is the project of the Screen on display", async () => {
    const { S, selectActiveProjectId } = await fresh([group("g1", "P", leaf("a", "A")), group("g2", "", leaf("b", "B"))]);
    expect(selectActiveProjectId(S())).toBe("P");
    S().setActiveGroup("g2");
    expect(selectActiveProjectId(S())).toBe("");
  });

  it("a new Screen joins the active project", async () => {
    const { S } = await fresh([group("g1", "P", leaf("a", "A"))]);
    const id = S().addGroup();
    expect(S().groups.find((g) => g.id === id)?.projectId).toBe("P");
  });

  it("switching projects returns to the Screen that project was last on", async () => {
    const { S, selectActiveProjectId } = await fresh([
      group("p1", "P", leaf("a", "A")),
      group("p2", "P", leaf("b", "B")),
      group("q1", "Q", leaf("c", "C")),
    ]);
    S().setActiveGroup("p2");
    S().setActiveProject("Q");
    expect(S().activeGroupId).toBe("q1");
    S().setActiveProject("P");
    expect(S().activeGroupId).toBe("p2"); // not the first, the last one used
    expect(selectActiveProjectId(S())).toBe("P");
  });

  it("a project with no Screen yet gets an empty one, never nothing", async () => {
    const { S, selectActiveProjectId } = await fresh([group("g1", "", leaf("a", "A"))]);
    S().setActiveProject("NEW");
    expect(selectActiveProjectId(S())).toBe("NEW");
    expect(S().tree).toBeNull();
    expect(S().groups).toHaveLength(2);
  });

  it("closing a project's last Screen empties it rather than leaving the project", async () => {
    const { S, selectActiveProjectId } = await fresh([group("g1", "P", leaf("a", "A")), group("g2", "Q", leaf("b", "B"))]);
    S().closeGroup("g1");
    expect(S().groups.map((g) => g.id)).toEqual(["g1", "g2"]);
    expect(S().tree).toBeNull();
    expect(selectActiveProjectId(S())).toBe("P");
  });

  it("closing a Screen moves to a neighbour IN THE SAME project", async () => {
    const { S } = await fresh([
      group("p1", "P", leaf("a", "A")),
      group("q1", "Q", leaf("b", "B")),
      group("p2", "P", leaf("c", "C")),
    ]);
    S().closeGroup("p1");
    expect(S().activeGroupId).toBe("p2"); // not q1, which sits between them
  });

  it("opening a session lands in its project and shows that project", async () => {
    const { S, selectActiveProjectId } = await fresh([group("g1", "", leaf("a", "A"))]);
    S().openSessionEphemeral("X", "P");
    expect(selectActiveProjectId(S())).toBe("P");
    expect(S().groups.find((g) => g.id === S().activeGroupId)?.projectId).toBe("P");
  });

  it("a session already on screen elsewhere is shown there, switching project", async () => {
    const { S, selectActiveProjectId } = await fresh([group("g1", "", leaf("a", "A")), group("g2", "P", leaf("b", "B"))]);
    S().openSessionEphemeral("B", "P");
    expect(S().activeGroupId).toBe("g2");
    expect(selectActiveProjectId(S())).toBe("P");
    expect(S().groups).toHaveLength(2);
  });

  it("the preview Screen moves with the session into its project, not a second preview (#78)", async () => {
    const { S } = await fresh([group("g1", "", leaf("a", "A"))]);
    S().openSessionEphemeral("X", "P");
    const preview = S().ephemeralGroupId;
    S().openSessionEphemeral("Y", "Q");
    expect(S().ephemeralGroupId).toBe(preview);
    expect(S().groups.find((g) => g.id === preview)?.projectId).toBe("Q");
    expect(S().groups).toHaveLength(2);
  });

  it("new work in another project gets a Screen there, filling an empty one first", async () => {
    const { S } = await fresh([group("g1", "", leaf("a", "A")), group("g2", "P", null)]);
    S().openInNewGroup("N", "P");
    expect(S().activeGroupId).toBe("g2"); // the empty P Screen, not a new one
    expect(S().groups).toHaveLength(2);
  });

  it("reconcile files legacy Screens by what they hold, and orphans go to Default", async () => {
    const { S } = await fresh([
      group("legacy", undefined, leaf("a", "A")),
      group("gone", "DELETED", leaf("b", "B")),
      group("kept", "P", leaf("c", "C")),
    ]);
    S().reconcileProjects(new Set(["P", "Q"]), (g) => (g.id === "legacy" ? "Q" : "WHATEVER"), true);
    const byId = Object.fromEntries(S().groups.map((g) => [g.id, g.projectId]));
    expect(byId).toEqual({ legacy: "Q", gone: "", kept: "P" });
  });

  it("a Screen of a project the list has not caught up with yet is left alone", async () => {
    const { S } = await fresh([group("legacy", undefined, leaf("a", "A")), group("new", "JUST-CREATED", leaf("b", "B"))]);
    S().reconcileProjects(new Set(["P"]), () => "P", false);
    const byId = Object.fromEntries(S().groups.map((g) => [g.id, g.projectId]));
    expect(byId).toEqual({ legacy: "P", new: "JUST-CREATED" });
  });

  it("removing a project moves its Screens to Default", async () => {
    const { S, selectActiveProjectId } = await fresh([group("p1", "P", leaf("a", "A")), group("q1", "Q", leaf("b", "B"))]);
    S().releaseProject("P");
    expect(S().groups.map((g) => g.projectId)).toEqual(["", "Q"]);
    expect(selectActiveProjectId(S())).toBe("");
  });

  it("the Screen bar's project survives a relaunch", async () => {
    const { S } = await fresh([group("g1", "", leaf("a", "A"))]);
    S().addGroup();
    S().setActiveProject("P");
    const saved = window.localStorage.getItem("ai4s.layout.v2")!;
    vi.resetModules();
    window.localStorage.setItem("ai4s.layout.v2", saved);
    const { useLayoutStore, selectActiveProjectId } = await import("./layout");
    expect(selectActiveProjectId(useLayoutStore.getState())).toBe("P");
  });
});

describe("a terminal remembers where it was and what ran in it", () => {
  const terminal = (agent?: object) => leaf("t", null, { kind: "terminal", cwd: "/w/start", ...(agent ? { agent } : {}) });

  it("follows the shell's folder and the agent in its foreground", async () => {
    const { S } = await fresh([group("g1", "P", terminal())]);
    S().recordTerminal("t", { cwd: "/w/start/sub", agent: { kind: "claude", sessionId: "abc-1" } });
    expect(S().tree).toMatchObject({
      content: { cwd: "/w/start/sub", agent: { kind: "claude", sessionId: "abc-1", running: true } },
    });
  });

  it("an agent that exits stays as the LAST session, marked not running", async () => {
    const { S } = await fresh([group("g1", "P", terminal({ kind: "codex", sessionId: "c-9", running: true }))]);
    S().recordTerminal("t", { cwd: "/w/start", agent: null });
    expect(S().tree).toMatchObject({ content: { agent: { kind: "codex", sessionId: "c-9", running: false } } });
  });

  it("is named after the agent session in it, unless the user named it", async () => {
    const { S, terminalName } = await fresh([group("g1", "P", terminal())]);
    S().recordTerminal("t", { cwd: "/w/start", agent: { kind: "claude", sessionId: "abc-1", title: "Fix the build" } });
    const content = (S().tree as { content: { agent?: TerminalAgent } }).content;
    expect(content).toMatchObject({ agent: { title: "Fix the build", running: true } });
    expect(terminalName(content, "Terminal")).toBe("Fix the build");
    expect(terminalName({ ...content, name: "server" }, "Terminal")).toBe("server");
    // Back at the shell prompt, the session's name no longer applies.
    S().recordTerminal("t", { cwd: "/w/start", agent: null });
    expect(terminalName((S().tree as { content: { agent?: TerminalAgent } }).content, "Terminal")).toBe("Terminal");
  });

  it("an unchanged probe commits nothing (it runs every few seconds)", async () => {
    const { S, useLayoutStore } = await fresh([group("g1", "P", terminal())]);
    const before = useLayoutStore.getState().groups;
    S().recordTerminal("t", { cwd: "/w/start", agent: null });
    expect(useLayoutStore.getState().groups).toBe(before);
  });

  it("reaches a terminal on a Screen that is not on display", async () => {
    const { S } = await fresh([group("g1", "P", leaf("a", "A")), group("g2", "P", terminal())]);
    S().recordTerminal("t", { cwd: "/elsewhere", agent: null });
    expect(S().groups[1].tree).toMatchObject({ content: { cwd: "/elsewhere" } });
  });

  it("a relaunch resumes a still-running agent instead of the pane's command", async () => {
    const { terminalStartup } = await fresh([group("g1", "", null)]);
    const agent = { kind: "claude" as const, sessionId: "abc-1", running: true };
    expect(terminalStartup({ command: "claude", agent })).toBe("claude --resume abc-1");
    expect(terminalStartup({ agent: { kind: "codex", sessionId: "c-9", running: true } })).toBe("codex resume c-9");
    // Exited before the quit: the shell comes back as it was left.
    expect(terminalStartup({ command: "ssh h", agent: { ...agent, running: false } })).toBe("ssh h");
    expect(terminalStartup({})).toBeUndefined();
  });

  it("never types a session id that is not a plain id into a shell", async () => {
    const { resumeCommand, terminalStartup } = await fresh([group("g1", "", null)]);
    const evil = { kind: "claude" as const, sessionId: "x; rm -rf ~", running: true };
    expect(resumeCommand(evil)).toBeNull();
    expect(terminalStartup({ command: "zsh", agent: evil })).toBe("zsh");
  });

  it("a saved agent of the wrong shape is dropped, not trusted", async () => {
    const { isPaneContent } = await fresh([group("g1", "", null)]);
    expect(isPaneContent({ kind: "terminal", agent: { kind: "claude", sessionId: "a", running: true } })).toBe(true);
    expect(isPaneContent({ kind: "terminal", agent: { kind: "bash", sessionId: "a", running: true } })).toBe(false);
    expect(isPaneContent({ kind: "terminal", agent: { kind: "claude", sessionId: 7, running: true } })).toBe(false);
    expect(isPaneContent({ kind: "terminal", agent: { kind: "pi", sessionId: "a", running: true } })).toBe(true);
  });

  it("resumes each terminal agent with its own command", async () => {
    const { resumeCommand } = await fresh([group("g1", "", null)]);
    const id = "01a01595-5d28-7ba3-98c7-323282fa41ad";
    expect(resumeCommand({ kind: "claude", sessionId: id, running: true })).toBe(`claude --resume ${id}`);
    expect(resumeCommand({ kind: "codex", sessionId: id, running: true })).toBe(`codex resume ${id}`);
    expect(resumeCommand({ kind: "pi", sessionId: id, running: true })).toBe(`pi --session ${id}`);
  });
});
