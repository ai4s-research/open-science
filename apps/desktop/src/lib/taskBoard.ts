// What the Tasks page shows: every agent at work, read off state the app
// already holds, so each number is exact and live. Three groups, in the order
// the user acts on them: waiting for the user, working, done earlier today.
// Pure, so what the board says is testable without rendering.
import type { PermissionAskedEvent, QuestionAskedEvent, SessionMeta } from "@ai4s/sdk";
import type { ThreadBlock, ToolCallStatus, ToolVerb } from "@ai4s/shared";
import { leaves, projectOf, type LayoutGroup, type TerminalAgentKind } from "./layout";
import { projectIdForSession } from "./projectScope";

/** Tool calls shown in a row's trail: enough to read a rhythm, one glance wide. */
export const TRAIL_LENGTH = 24;

export type BoardAgent = { kind: "opencode" } | { kind: TerminalAgentKind; account?: string };

export type BoardAsk =
  | { type: "permission"; action: string; resource?: string }
  | { type: "question"; text: string };

export type BoardStep =
  | { type: "tool"; verb?: ToolVerb; title: string }
  | { type: "thinking" }
  | { type: "replying" };

export interface BoardRow {
  /** Unique across the board. */
  id: string;
  title: string;
  agent: BoardAgent;
  projectId: string;
  /** A conversation row opens its session; a terminal row focuses its pane. */
  target: { kind: "session"; sessionId: string } | { kind: "pane"; groupId: string; leafId: string };
  /** Set on rows waiting for the user. */
  ask?: BoardAsk;
  /** What it is doing now; working rows whose thread is loaded. */
  step?: BoardStep;
  /** The latest tool calls of the current turn, oldest first. */
  trail: ToolCallStatus[];
  /** Tool calls and distinct files written in the current turn. */
  tools: number;
  files: number;
  /** Epoch ms the current turn started, when the thread says. */
  startedAt?: number;
  /** Epoch ms of the last thing it did. */
  lastAt?: number;
  /** Set on terminal rows: the agent runs in a terminal pane. */
  terminal?: true;
}

export interface Board {
  needsYou: BoardRow[];
  working: BoardRow[];
  today: BoardRow[];
}

export interface BoardInput {
  sessions: Pick<SessionMeta, "id" | "title" | "directory" | "parentId" | "updated" | "created">[];
  projects: { id: string; path: string }[];
  runningSessions: Record<string, true>;
  permissions: PermissionAskedEvent[];
  questions: QuestionAskedEvent[];
  sessionParents: Record<string, string>;
  threads: Record<string, { blocks: ThreadBlock[] } | undefined>;
  /** Which agent a conversation runs on (absent: OpenCode). */
  agentOf: (sessionId: string) => BoardAgent;
  groups: LayoutGroup[];
  now: number;
}

const rootOf = (parents: Record<string, string>, id: string): string => {
  let cur = id;
  for (let i = 0; i < 64 && parents[cur]; i++) cur = parents[cur];
  return cur;
};

const startOfDay = (now: number): number => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** The current turn of a thread: everything after the last user message. */
function currentTurn(blocks: ThreadBlock[]): ThreadBlock[] {
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].kind === "user") return blocks.slice(i + 1);
  return blocks;
}

function turnFacts(blocks: ThreadBlock[] | undefined, working: boolean) {
  const turn = blocks ? currentTurn(blocks) : [];
  const trail: ToolCallStatus[] = [];
  const written = new Set<string>();
  let tools = 0;
  let startedAt: number | undefined;
  let lastAt: number | undefined;
  const seen = (t: number | undefined) => {
    if (!t) return;
    if (startedAt === undefined || t < startedAt) startedAt = t;
    if (lastAt === undefined || t > lastAt) lastAt = t;
  };
  for (const b of turn) {
    if (b.kind === "tool-call") {
      tools += 1;
      trail.push(b.status);
      if ((b.verb === "Edited" || b.verb === "Created") && b.filePath) written.add(b.filePath);
      seen(b.startedAt);
      seen(b.endedAt);
    } else if (b.kind === "agent") {
      seen(b.created);
      seen(b.completed);
    }
  }
  let step: BoardStep | undefined;
  if (working && turn.length > 0) {
    const last = turn[turn.length - 1];
    if (last.kind === "tool-call") step = { type: "tool", verb: last.verb, title: last.title };
    else if (last.kind === "reasoning") step = { type: "thinking" };
    else if (last.kind === "agent") step = { type: "replying" };
  }
  return { trail: trail.slice(-TRAIL_LENGTH), tools, files: written.size, startedAt, lastAt, step };
}

export function buildBoard(input: BoardInput): Board {
  const { sessions, projects, runningSessions, sessionParents, threads, now } = input;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const root = (id: string) => rootOf(sessionParents, id);

  // A subagent's ask or work is its conversation's: the user acts there.
  const asks = new Map<string, BoardAsk>();
  for (const p of input.permissions) {
    const id = root(p.sessionId);
    if (!asks.has(id)) asks.set(id, { type: "permission", action: p.action, resource: p.resources[0] });
  }
  for (const q of input.questions) {
    const id = root(q.sessionId);
    if (!asks.has(id)) asks.set(id, { type: "question", text: q.questions[0]?.question ?? "" });
  }
  const running = new Set(Object.keys(runningSessions).map(root));

  const sessionRow = (id: string, working: boolean): BoardRow | null => {
    const s = byId.get(id);
    if (!s) return null;
    const facts = turnFacts(threads[id]?.blocks, working);
    return {
      id: `session:${id}`,
      title: s.title,
      agent: input.agentOf(id),
      projectId: projectIdForSession(id, sessions, projects),
      target: { kind: "session", sessionId: id },
      ...facts,
      lastAt: facts.lastAt ?? s.updated,
    };
  };

  const needsYou: BoardRow[] = [];
  for (const [id, ask] of asks) {
    const row = sessionRow(id, false);
    if (row) needsYou.push({ ...row, ask });
  }

  const working: BoardRow[] = [];
  for (const id of running) {
    if (asks.has(id)) continue;
    const row = sessionRow(id, true);
    if (row) working.push(row);
  }
  // A coding agent left running in a terminal is at work too.
  for (const g of input.groups) {
    for (const leaf of g.tree ? leaves(g.tree) : []) {
      const c = leaf.content;
      if (c?.kind !== "terminal" || !c.agent?.running) continue;
      working.push({
        id: `pane:${leaf.id}`,
        title: c.name || c.agent.title || "",
        agent: { kind: c.agent.kind },
        projectId: projectOf(g),
        target: { kind: "pane", groupId: g.id, leafId: leaf.id },
        trail: [],
        tools: 0,
        files: 0,
        terminal: true,
      });
    }
  }
  working.sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity));

  const dayStart = startOfDay(now);
  const today: BoardRow[] = [];
  for (const s of sessions) {
    if (s.parentId || running.has(s.id) || asks.has(s.id)) continue;
    if ((s.updated ?? s.created ?? 0) < dayStart) continue;
    const row = sessionRow(s.id, false);
    if (row) today.push(row);
  }
  today.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));

  return { needsYou, working, today };
}
