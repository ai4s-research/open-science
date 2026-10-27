import { describe, expect, it } from "vitest";
import { insertLeaf, makeContentLeaf, makeLeaf, type LayoutGroup } from "./layout";
import { screenReference, sessionReference, terminalReference } from "./agentReference";

describe("agent references", () => {
  it("a session names itself and the commands that read it and talk to it", () => {
    expect(sessionReference({ id: "ses_abc", title: "Fold proteins", directory: "/w/s1" })).toBe(
      [
        "[OSD session] Fold proteins · ses_abc · /w/s1",
        "  read: osd session show ses_abc",
        '  send and wait for the reply: osd session send ses_abc "<message>" --wait',
      ].join("\n"),
    );
  });

  it("a terminal running an agent is talked to; a plain shell is typed into", () => {
    const agent = terminalReference({
      shellId: "p12",
      cwd: "/repo",
      agent: { kind: "claude", sessionId: "52cadc66", running: true },
    });
    expect(agent).toContain("[OSD terminal] Claude Code · p12 · /repo");
    expect(agent).toContain("osd term read p12");
    expect(agent).toContain('osd term send p12 "<message>" --wait');

    const shell = terminalReference({ shellId: "wabc-p3", name: "build" });
    expect(shell).toContain("[OSD terminal] build · wabc-p3");
    expect(shell).toContain('type a line (it runs): osd term send wabc-p3 "<command>"');
    expect(shell).toContain("press keys (menus): osd term key wabc-p3 down enter");
  });

  it("a terminal is named after its agent session, unless the user named it", () => {
    const agent = { kind: "claude" as const, sessionId: "52cadc66", running: true, title: "Fix the build" };
    expect(terminalReference({ shellId: "p12", agent })).toContain("[OSD terminal] Fix the build · Claude Code · p12");
    expect(terminalReference({ shellId: "p12", name: "server", agent })).toContain(
      "[OSD terminal] server · Claude Code · p12",
    );
    // The agent exited: a shell again, typed into.
    const exited = terminalReference({ shellId: "p12", agent: { ...agent, running: false } });
    expect(exited).toContain("[OSD terminal] shell · p12");
    expect(exited).toContain('type a line (it runs): osd term send p12 "<command>"');
  });

  it("an id that is not plain is quoted for the shell", () => {
    expect(sessionReference({ id: "a b'c" })).toContain(`osd session show 'a b'\\''c'`);
  });

  it("a Screen lists the panes that can be talked to, and nothing else", () => {
    const conversation = makeLeaf("ses_1");
    const files = makeContentLeaf({ kind: "files" });
    const shell = makeContentLeaf({ kind: "terminal", cwd: "/repo" });
    let tree = insertLeaf(conversation, conversation.id, "right", files);
    tree = insertLeaf(tree, files.id, "right", shell);
    const group: LayoutGroup = { id: "g1", name: "", tree, focusedLeafId: conversation.id, zoomedLeafId: null };
    const ref = screenReference(group, "Analysis", (id) => ({ id, title: "Fit", directory: "/w" }))!;
    expect(ref.startsWith("[OSD screen] Analysis\n\n[OSD session] Fit · ses_1 · /w")).toBe(true);
    expect(ref).toContain(`[OSD terminal] shell · ${shell.id} · /repo`);
    expect(ref).not.toContain("files");

    const empty: LayoutGroup = { ...group, tree: files };
    expect(screenReference(empty, "Files only", () => undefined)).toBeNull();
  });
});
