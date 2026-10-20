import { describe, it, expect } from "vitest";
import { jumpEntries, type JumpInput } from "./jumpEntries";
import { projectIdForGroup, projectIdForPath, projectIdForSession } from "./projectScope";
import type { LayoutGroup, PaneNode } from "./layout";

const projects = [
  { id: "P", name: "Protein", path: "/w/protein" },
  { id: "N", name: "Nested", path: "/w/protein/sub" },
];
const sessions = [
  { id: "s1", title: "Fold the thing", directory: "/w/protein", updated: 3 },
  { id: "s2", title: "Loose chat", directory: "/tmp/elsewhere", updated: 2 },
  { id: "s3", title: "Old work", directory: "/w/protein", updated: 1 },
  { id: "child", title: "subagent", directory: "/w/protein", parentId: "s1", updated: 9 },
];
const leaf = (id: string, sessionId: string | null, content?: object): PaneNode =>
  ({ kind: "leaf", id, sessionId, ...(content ? { content } : {}) }) as PaneNode;
const group = (id: string, projectId: string, tree: PaneNode | null, name = ""): LayoutGroup => ({
  id,
  name,
  projectId,
  tree,
  focusedLeafId: null,
  zoomedLeafId: null,
});

describe("which project something belongs to", () => {
  it("a folder belongs to the project that is it or contains it, deepest first", () => {
    expect(projectIdForPath("/w/protein", projects)).toBe("P");
    expect(projectIdForPath("/w/protein/data", projects)).toBe("P");
    expect(projectIdForPath("/w/protein/sub/x", projects)).toBe("N");
    // A sibling whose name merely starts the same is not inside.
    expect(projectIdForPath("/w/protein-old", projects)).toBe("");
    expect(projectIdForPath(null, projects)).toBe("");
  });

  it("a session belongs to exactly its folder's project, as the sidebar files it", () => {
    expect(projectIdForSession("s1", sessions, projects)).toBe("P");
    expect(projectIdForSession("s2", sessions, projects)).toBe("");
    expect(projectIdForSession("missing", sessions, projects)).toBe("");
  });

  it("a Screen goes where its conversation is, else where its terminal is working", () => {
    expect(projectIdForGroup(group("g", "", leaf("a", "s1")), sessions, projects)).toBe("P");
    const term = leaf("t", null, { kind: "terminal", cwd: "/w/protein/sub" });
    expect(projectIdForGroup(group("g", "", term), sessions, projects)).toBe("N");
    expect(projectIdForGroup(group("g", "", leaf("a", "s2")), sessions, projects)).toBe("");
    expect(projectIdForGroup(group("g", "", null), sessions, projects)).toBe("");
  });
});

describe("what ⌘J offers", () => {
  const labels: JumpInput["labels"] = {
    defaultProject: "Default",
    terminal: "Terminal",
    files: "Files",
    session: "Session",
    screen: (n) => `Screen ${n}`,
    newSession: (p) => `New session in ${p}`,
    newTerminal: (p) => `New terminal in ${p}`,
    projectDetail: (n) => `${n} sessions`,
  };
  const groups = [
    group("d1", "", leaf("a", "s2")),
    group("p1", "P", leaf("t", null, { kind: "terminal", cwd: "/w/protein", name: "build", agent: { kind: "claude", sessionId: "x", running: true } })),
    group("p2", "P", leaf("b", "s1"), "Folding"),
  ];
  const entries = jumpEntries({ groups, activeGroupId: "p2", sessions, projects, labels });
  const bySection = (section: string) => entries.filter((e) => e.section === section);

  it("its actions act on the active project", () => {
    expect(bySection("actions").map((e) => e.label)).toEqual(["New session in Protein", "New terminal in Protein"]);
  });

  it("lists Default and every project, the one used last first, saying how much is in it", () => {
    const rows = bySection("projects");
    expect(rows.map((e) => e.label).sort()).toEqual(["Default", "Nested", "Protein"]);
    expect(rows.every((e) => e.detail?.endsWith("sessions"))).toBe(true);
    const lastUsed = (label: string) => rows.findIndex((e) => e.label === label);
    // Protein holds the newest session of the fixture.
    expect(lastUsed("Protein")).toBe(0);
  });

  it("the empty palette's recent rows are the newest conversations, open ones going to their pane", () => {
    const recent = bySection("recent");
    expect(recent.length).toBeGreaterThan(0);
    const open = recent.find((e) => e.target.kind === "pane");
    expect(open?.target).toMatchObject({ groupId: "p2", leafId: "b", sessionId: "s1" });
  });

  it("offers a new session in every project, by name", () => {
    expect(bySection("newIn").map((e) => e.label).sort()).toEqual([
      "New session in Default",
      "New session in Nested",
      "New session in Protein",
    ]);
  });

  it("does not list a one-pane Screen twice", () => {
    const panes = bySection("panes").map((e) => e.label);
    expect(panes).not.toContain("build · protein · Claude Code");
    // A Screen named apart from its pane keeps both: they say different things.
    expect(bySection("screens").map((e) => e.label)).toContain("Folding");
  });

  it("lists the active project's Screens first, each saying where it lives", () => {
    expect(bySection("screens").map((e) => [e.label, e.detail])).toEqual([
      ["build · protein · Claude Code", "Protein"],
      ["Folding", "Protein"],
      ["Loose chat", "Default"],
    ]);
  });

  it("finds a terminal by what is running in it", () => {
    const term = bySection("screens").find((e) => e.target.kind === "screen" && e.target.groupId === "p1");
    expect(term?.label).toContain("Claude Code");
  });

  it("offers the sessions not open anywhere, newest first, without subagents", () => {
    expect(bySection("sessions").map((e) => [e.label, e.detail])).toEqual([["Old work", "Protein"]]);
  });
});
