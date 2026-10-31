// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { OpenCodeClient, type SessionCursor } from "@ai4s/sdk";

const BASE = "http://127.0.0.1:9999";

interface ServerSession {
  id: string;
  title: string;
  metadata?: Record<string, unknown>;
  time: { created: number; updated: number };
  location: { directory: string };
}

/** `count` sessions, newest first. */
function history(count: number): ServerSession[] {
  return Array.from({ length: count }, (_, i) => {
    const t = 1_000_000 - i;
    return { id: `ses_${i}`, title: `session ${i}`, time: { created: t, updated: t }, location: { directory: "/ws" } };
  });
}

/** Stand-in for `GET /api/session`: at most `limit` rows, newest first, and an
 *  OPAQUE cursor the client must hand back as given.
 *
 *  It deliberately does NOT filter on our archive marker: the server knows
 *  nothing about `metadata.ai4s`, so that filter is the client's job and these
 *  tests must exercise it. */
function server(all: ServerSession[], calls: string[] = []) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (url.pathname !== "/api/session") return new Response("not found", { status: 404 });
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const cursor = url.searchParams.get("cursor");
    const search = (url.searchParams.get("search") ?? "").toLowerCase();
    const pool = search ? all.filter((s) => s.title.toLowerCase().includes(search)) : all;
    const start = cursor ? Number(atob(cursor)) : 0;
    const rows = pool.slice(start, start + limit);
    const next = start + limit < pool.length ? btoa(String(start + limit)) : null;
    return new Response(JSON.stringify({ data: rows, cursor: { next } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe("OpenCodeClient.querySessions", () => {
  it("pages the whole history by passing the server's cursor back", async () => {
    const { fetchImpl } = server(history(1000));
    const client = new OpenCodeClient({ baseUrl: BASE, fetchImpl });

    const seen = new Set<string>();
    let cursor: SessionCursor | null | undefined = undefined;
    for (let page = 0; page < 30; page++) {
      const batch = await client.querySessions({ limit: 100, cursor });
      batch.sessions.forEach((s) => seen.add(s.id));
      if (batch.nextCursor === null) break;
      expect(typeof batch.nextCursor).toBe("string");
      cursor = batch.nextCursor;
    }
    expect(seen.size).toBe(1000);
  });

  it("reports no next page once the history runs out", async () => {
    const { fetchImpl } = server(history(30));
    const client = new OpenCodeClient({ baseUrl: BASE, fetchImpl });
    const page = await client.querySessions({ limit: 100 });
    expect(page.sessions).toHaveLength(30);
    expect(page.nextCursor).toBeNull();
  });

  it("searches on the server rather than pulling the history down to filter it", async () => {
    const { fetchImpl, calls } = server(history(5000));
    const client = new OpenCodeClient({ baseUrl: BASE, fetchImpl });
    const page = await client.querySessions({ limit: 20, search: "session 4242" });
    expect(page.sessions.map((s) => s.id)).toEqual(["ses_4242"]);
    expect(calls).toEqual(["/api/session?limit=20&order=desc&search=session+4242"]);
  });

  it("reads each session's folder and our archive marker", async () => {
    const rows = history(3);
    rows[1]!.metadata = { ai4s: { archived: 1785000000000 }, other: "kept" };
    const { fetchImpl } = server(rows);
    const client = new OpenCodeClient({ baseUrl: BASE, fetchImpl });
    const page = await client.querySessions({ archived: true });
    expect(page.sessions.map((s) => s.archived)).toEqual([undefined, 1785000000000, undefined]);
    expect(page.sessions[0].directory).toBe("/ws");
  });

  it("hides archived conversations itself — the server does not know our marker", async () => {
    const rows = history(3);
    rows[1]!.metadata = { ai4s: { archived: 1785000000000 } };
    const { fetchImpl } = server(rows);
    const client = new OpenCodeClient({ baseUrl: BASE, fetchImpl });
    const page = await client.querySessions({});
    expect(page.sessions.map((s) => s.id)).toEqual(["ses_0", "ses_2"]);
  });
});

describe("OpenCodeClient.listSessions (the sidebar's window)", () => {
  it("holds a bounded window instead of a multi-year history", async () => {
    const { fetchImpl } = server(history(5000));
    const client = new OpenCodeClient({ baseUrl: BASE, fetchImpl });
    expect(await client.listSessions()).toHaveLength(200);
  });

  it("keeps looking when archived conversations crowd out the newest page", async () => {
    const rows = history(600);
    for (let i = 0; i < 250; i++) rows[i]!.metadata = { ai4s: { archived: 1 } };
    const { fetchImpl } = server(rows);
    const client = new OpenCodeClient({ baseUrl: BASE, fetchImpl });
    const recent = await client.listSessions();
    expect(recent).toHaveLength(200);
    expect(recent.every((s) => s.archived == null)).toBe(true);
    expect(recent[0]!.id).toBe("ses_250");
  });
});

describe("OpenCodeClient.setSessionArchived", () => {
  function metaServer(initial: Record<string, unknown> | undefined) {
    const patches: unknown[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)));
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify({ data: { id: "ses_1", metadata: initial } }), { status: 200 });
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, patches };
  }

  it("archives without clobbering metadata another client owns", async () => {
    const { fetchImpl, patches } = metaServer({ other: "kept" });
    await new OpenCodeClient({ baseUrl: BASE, fetchImpl }).setSessionArchived("ses_1", true);
    const body = patches[0] as { metadata: Record<string, Record<string, number>> };
    expect(body.metadata.other).toBe("kept");
    expect(typeof body.metadata.ai4s!.archived).toBe("number");
  });

  it("restores by removing the marker, leaving no empty husk behind", async () => {
    const { fetchImpl, patches } = metaServer({ ai4s: { archived: 123 }, other: "kept" });
    await new OpenCodeClient({ baseUrl: BASE, fetchImpl }).setSessionArchived("ses_1", false);
    expect(patches[0]).toEqual({ metadata: { other: "kept" } });
  });
});

describe("OpenCodeClient session edits", () => {
  it("renames a session through PATCH /api/session/:id", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response("{}", { status: 200 });
    });
    await new OpenCodeClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch }).renameSession(
      "ses_1",
      "Protein folding review",
    );
    expect(seen).toEqual([{ url: `${BASE}/api/session/ses_1`, method: "PATCH", body: { title: "Protein folding review" } }]);
  });

  it("reports a failed rename instead of pretending it worked", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "nope" }), { status: 500 }));
    const client = new OpenCodeClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.renameSession("ses_1", "x")).rejects.toThrow(/nope/);
  });

  it("reverts for good: stages, then commits, so a reload cannot bring the turn back", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method} ${new URL(String(input)).pathname} ${init?.body ?? ""}`);
      return new Response("{}", { status: 200 });
    });
    await new OpenCodeClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch }).revert("ses_1", "msg_9");
    expect(calls).toEqual([
      `POST /api/session/ses_1/revert/stage {"messageID":"msg_9","files":true}`,
      "POST /api/session/ses_1/revert/commit ",
    ]);
  });

  it("forks before a message", async () => {
    let body: unknown;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ data: { id: "ses_fork" } }), { status: 200 });
    });
    const client = new OpenCodeClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.forkSession("ses_1", "msg_3")).resolves.toBe("ses_fork");
    expect(body).toEqual({ before: "msg_3" });
  });
});

describe("sessionExists", () => {
  const client = (status: number) =>
    new OpenCodeClient({ baseUrl: BASE, fetchImpl: vi.fn(async () => new Response("{}", { status })) as never });

  it("answers from the session itself, not the recent list", async () => {
    await expect(client(200).sessionExists("ses_old")).resolves.toBe(true);
    await expect(client(404).sessionExists("ses_gone")).resolves.toBe(false);
  });

  it("throws when the runtime cannot answer, so the caller keeps the pane", async () => {
    await expect(client(500).sessionExists("ses_x")).rejects.toThrow();
  });
});
