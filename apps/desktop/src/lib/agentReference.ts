// "Copy reference": a few lines that hand a session or a terminal to another
// agent. They carry their own instructions — the commands that read it and talk
// to it — so any agent that can run a shell command can act on them, including
// a Claude Code in a terminal that has never heard of this app. English on
// purpose: the commands are, and so is every agent's best reading.
import { leaves, terminalAgentName, terminalName, type LayoutGroup, type PaneLeaf, type TerminalAgent } from "./layout";
import { terminalShellId } from "./terminalTransport";
import { copyText } from "./clipboard";
import { toast } from "./toast";

export interface ReferencedSession {
  id: string;
  title?: string;
  directory?: string;
}

export interface ReferencedTerminal {
  /** The shell's id at the gateway (`terminalShellId`), not the pane's. */
  shellId: string;
  name?: string;
  cwd?: string;
  agent?: TerminalAgent;
}


/** `osd` arguments are pasted into a shell: quote anything that is not a plain id. */
const arg = (s: string) => (/^[A-Za-z0-9_.-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export function sessionReference(s: ReferencedSession): string {
  const head = `[OSD session] ${[s.title?.trim() || "(untitled)", s.id, s.directory].filter(Boolean).join(" · ")}`;
  return [
    head,
    `  read: osd session show ${arg(s.id)}`,
    `  send and wait for the reply: osd session send ${arg(s.id)} "<message>" --wait`,
  ].join("\n");
}

export function terminalReference(t: ReferencedTerminal): string {
  // Named as everywhere else (see `terminalName`), then the agent running in
  // it. An agent that has exited left a shell behind, and is not mentioned.
  const running = t.agent?.running ? t.agent : undefined;
  const what = [terminalName(t, ""), running && terminalAgentName(running.kind)].filter(Boolean).join(" · ") || "shell";
  const head = `[OSD terminal] ${[what, t.shellId, t.cwd].filter(Boolean).join(" · ")}`;
  // A plain shell runs what is sent; an agent in it reads it as a message.
  const send = running
    ? `  send and wait for the reply: osd term send ${arg(t.shellId)} "<message>" --wait`
    : `  type a line (it runs): osd term send ${arg(t.shellId)} "<command>"`;
  // A menu or a dialog (a first run, a trust prompt) takes keys, not text.
  const keys = `  press keys (menus): osd term key ${arg(t.shellId)} down enter`;
  return [head, `  read: osd term read ${arg(t.shellId)}`, send, keys].join("\n");
}

/** One pane's reference, or null for a pane with nothing to talk to (a file
 *  tree, an editor, an unsent draft). */
export function paneReference(
  leaf: PaneLeaf,
  session: (id: string) => ReferencedSession | undefined,
): string | null {
  if (leaf.content?.kind === "terminal") {
    return terminalReference({
      shellId: terminalShellId(leaf.id),
      name: leaf.content.name,
      cwd: leaf.content.cwd,
      agent: leaf.content.agent,
    });
  }
  if (leaf.content || leaf.artifact || !leaf.sessionId) return null;
  return sessionReference(session(leaf.sessionId) ?? { id: leaf.sessionId });
}

/** Every pane of a Screen that can be talked to, under the Screen's name. */
export function screenReference(
  group: LayoutGroup,
  name: string,
  session: (id: string) => ReferencedSession | undefined,
): string | null {
  const refs = group.tree
    ? leaves(group.tree)
        .map((l) => paneReference(l, session))
        .filter((r): r is string => r !== null)
    : [];
  if (refs.length === 0) return null;
  return [`[OSD screen] ${name}`, ...refs].join("\n\n");
}

/** Put a reference on the clipboard and say so. */
export async function copyReference(text: string, copiedMessage: string): Promise<void> {
  try {
    await copyText(text);
    toast.success(copiedMessage);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  }
}
