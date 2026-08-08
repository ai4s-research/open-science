// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { OpenCodeClient } from "@ai4s/sdk";

const BASE = "http://127.0.0.1:9999";

interface ServerSession {
  id: string;
  title: string;
  metadata?: Record<string, unknown>;
  time: { created: number; updated: number };
}

/** `count` sessions, newest first. `perMs` sessions share each millisecond —
 *  the real server does this constantly (1699 of 5038 in the load test). */
function history(count: number, perMs = 1): ServerSession[] {
  return Array.from({ length: count }, (_, i) => {
    const t = 1_000_000 - Math.floor(i / perMs);
    return { id: `ses_${i}`, title: `session ${i}`, time: { created: t, updated: t } };
  });
}

/** Stand-in for `/experimental/session`: at most `limit` rows, and with
 *  `cursor` only rows STRICTLY older than it (verified against 1.17.13).
 *
 *  It deliberately does NOT filter on our archive marker: the real server
 *  knows nothing about `metadata.ai4s`, so that filter is the client's job and
 *  these tests must exercise it. */
function server(all: ServerSession[], calls: string[] = []) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (url.pathname !== "/experimental/session") {
      return new Response("not found", { status: 404 });
    }
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const cursor = url.searchParams.get("cursor");
    const search = (url.searchParams.get("search") ?? "").toLowerCase();
    let rows = all;
    if (cursor != null) rows = rows.filter((s) => s.time.updated < Number(cursor));
    if (search) rows = rows.filter((s) => s.title.toLowerCase().includes(search));
    return new Response(JSON.stringify(rows.slice(0, limit)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe("OpenCodeClient.querySessions", () => {
  it("pages the whole history without dropping sessions that share a millisecond", async () => {
    // The failure this guards: cursoring on the last row's OWN timestamp asks
    // for rows strictly older than it, so the rest of that millisecond is
    // skipped. Measured against the real server: 8 of 5038 vanished.
    const { fetchImpl } = server(history(1000, 7));
    const client = new OpenCodeClient({ baseUrl: BASE, fetchImpl });

    const seen = new Set<string>();
    let cursor: number | null | undefined = undefined;
    for (let page = 0; page < 30; page++) {
      const batch = await client.querySessions({ limit: 100, cursor });
      batch.sessions.forEach((s) => seen.add(s.id));
      if (batch.nextCursor === null) break;
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
    // A page is never smaller than MIN_FETCH: the cursor overlaps the
    // millisecond it stopped in, so a tiny page could not advance past a run
    // of sessions sharing one.
    expect(calls).toEqual(["/experimental/session?limit=50&search=session+4242"]);
  });

  it("reads our archive marker out of the session's metadata", async () => {
    const rows = history(3);
    rows[1]!.metadata = { ai4s: { archived: 1785000000000 }, other: "kept" };
    const { fetchImpl } = server(rows);
    const client = new OpenCodeClient({ baseUrl: BASE, fetchImpl });

    const page = await client.querySessions({ archived: true });
    expect(page.sessions.map((s) => s.archived)).toEqual([undefined, 1785000000000, undefined]);
  });

  it("hides archived conversations itself — the server cannot do it for us", async () => {
    // The server's own `archived` flag is one-way, so ours lives in metadata,
    // which the server does not filter on. Verified live: asking the server to
    // exclude archived sessions leaves ours in the list.
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

    // 3.1 MB at 5k sessions on the wire — the sidebar must never pull that.
    expect(await client.listSessions()).toHaveLength(200);
  });

  it("keeps looking when archived conversations crowd out the newest page", async () => {
    const rows = history(600);
    // The newest 250 are archived: a single page would come back nearly empty.
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
  /** Records the PATCH bodies a client sends while serving one session. */
  function metaServer(initial: Record<string, unknown> | undefined) {
    const patches: unknown[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)));
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify({ id: "ses_1", metadata: initial }), { status: 200 });
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, patches };
  }

  it("archives without clobbering metadata another client owns", async () => {
    const { fetchImpl, patches } = metaServer({ other: "kept" });
    const client = new OpenCodeClient({ baseUrl: BASE, fetchImpl });

    await client.setSessionArchived("ses_1", true);

    const body = patches[0] as { metadata: Record<string, Record<string, number>> };
    expect(body.metadata.other).toBe("kept");
    expect(typeof body.metadata.ai4s!.archived).toBe("number");
  });

  it("restores by removing the marker, leaving no empty husk behind", async () => {
    const { fetchImpl, patches } = metaServer({ ai4s: { archived: 123 }, other: "kept" });
    const client = new OpenCodeClient({ baseUrl: BASE, fetchImpl });

    await client.setSessionArchived("ses_1", false);

    expect(patches[0]).toEqual({ metadata: { other: "kept" } });
  });
});

describe("OpenCodeClient session edits", () => {
  it("renames a session through PATCH /session/:id", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response("{}", { status: 200 });
    });
    const client = new OpenCodeClient({
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.renameSession("ses_1", "Protein folding review");

    expect(seen).toEqual([
      {
        url: `${BASE}/session/ses_1`,
        method: "PATCH",
        body: { title: "Protein folding review" },
      },
    ]);
  });

  it("moves a session's conversation without moving its workspace files", async () => {
    const seen: Array<{ url: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(null, { status: 204 });
    });
    const client = new OpenCodeClient({
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.moveSession("ses_1", "/work/projects/bci");

    expect(seen).toEqual([
      {
        url: `${BASE}/experimental/control-plane/move-session`,
        body: {
          sessionID: "ses_1",
          destination: { directory: "/work/projects/bci" },
          moveChanges: false,
        },
      },
    ]);
  });

  it("reports a failed rename instead of pretending it worked", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ message: "nope" }), { status: 500 }),
    );
    const client = new OpenCodeClient({
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.renameSession("ses_1", "x")).rejects.toThrow();
  });

  it("creates a session with ?directory= when a directory is set", async () => {
    // Regression: in web mode, the user selects a project but the session
    // was created without ?directory=, so it landed in the host's active
    // workspace instead of the selected project.
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(url.pathname + url.search);
      if (url.pathname === "/session" && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "ses_new" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    const client = new OpenCodeClient({
      baseUrl: BASE,
      directory: "/work/projects/my-project",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const id = await client.createSession("test");
    expect(id).toBe("ses_new");
    // The session creation URL must carry the directory.
    expect(calls).toEqual(["/session?directory=%2Fwork%2Fprojects%2Fmy-project"]);
  });

  it("creates a session without ?directory= when no directory is set", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(url.pathname + url.search);
      if (url.pathname === "/session" && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "ses_new" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    const client = new OpenCodeClient({
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const id = await client.createSession();
    expect(id).toBe("ses_new");
    expect(calls).toEqual(["/session"]);
  });
});
