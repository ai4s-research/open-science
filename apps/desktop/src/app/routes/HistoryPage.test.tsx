import { screen, waitFor, within, type BoundFunctions, type queries } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta, SessionQuery } from "@ai4s/sdk";
import { useRuntimeStore } from "@/lib/runtime";
import { renderAt } from "@/test/render";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-07-29T15:00:00Z").getTime();

const ALL: SessionMeta[] = [
  { id: "s1", title: "today's analysis", updated: NOW - 1000 },
  { id: "s2", title: "yesterday's debugging", updated: NOW - DAY },
  {
    id: "s3",
    title: "manuscript draft",
    updated: NOW - 40 * DAY,
    directory: "/work/projects/bci",
  },
  { id: "s4", title: "subagent work", updated: NOW - 900, parentId: "s1" },
  { id: "s5", title: "old shelved idea", updated: NOW - 90 * DAY, archived: NOW - 5 * DAY },
];

/** Stands in for the runtime: filters and pages the way the server does, so a
 *  test proves the page ASKS correctly rather than filtering after the fact. */
const queries_seen: SessionQuery[] = [];
const querySessions = vi.fn(async (q: SessionQuery = {}) => {
  queries_seen.push(q);
  let rows = ALL;
  if (!q.archived) rows = rows.filter((s) => s.archived == null);
  if (q.search) rows = rows.filter((s) => s.title.toLowerCase().includes(q.search!.toLowerCase()));
  if (q.cursor != null) rows = rows.filter((s) => (s.updated ?? 0) < q.cursor!);
  const limit = q.limit ?? 100;
  const page = rows.slice(0, limit);
  return { sessions: page, nextCursor: rows.length > limit ? page[page.length - 1]!.updated! : null };
});

const getMessages = vi.fn(async () => [
  { role: "user" as const, parts: [{ type: "text", text: "how do I sort spikes?" }] },
  { role: "assistant" as const, parts: [{ type: "text", text: "Use 4.5 sigma." }] },
]);

vi.mock("@/lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/runtime")>();
  return { ...actual, getClient: () => ({ querySessions, getMessages }) };
});

const setSessionArchived = vi.fn(async () => true);
const renameSession = vi.fn(async () => true);
const moveSessionToWorkspace = vi.fn(async () => true);

beforeEach(() => {
  vi.setSystemTime(NOW);
  queries_seen.length = 0;
  [querySessions, getMessages, setSessionArchived, renameSession, moveSessionToWorkspace].forEach(
    (m) => m.mockClear(),
  );
  useRuntimeStore.setState({
    status: "ready",
    setSessionArchived,
    renameSession,
    moveSessionToWorkspace,
    projects: [
      {
        id: "p1",
        name: "BCI trends",
        path: "/work/projects/bci",
        createdAt: NOW - 40 * DAY,
        pinned: false,
      },
    ] as never,
    sessions: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
  useRuntimeStore.setState({ sessions: [], projects: [], status: "offline" });
});

async function openHistory(): Promise<BoundFunctions<typeof queries>> {
  renderAt("/history");
  await screen.findByPlaceholderText("Search conversations");
  const page = within(screen.getByRole("main"));
  await page.findByText("today's analysis");
  return page;
}

describe("HistoryPage", () => {
  it("lists conversations of every age, grouped, including ones inside projects", async () => {
    const page = await openHistory();

    expect(page.getByText("today's analysis")).toBeInTheDocument();
    expect(page.getByText("yesterday's debugging")).toBeInTheDocument();
    expect(page.getByText("manuscript draft")).toBeInTheDocument();
    expect(page.getByText("BCI trends")).toBeInTheDocument();

    expect(page.getByText("Today")).toBeInTheDocument();
    expect(page.getByText("Yesterday")).toBeInTheDocument();
    expect(page.getByText("Older")).toBeInTheDocument();

    // Subagent sessions are internals of their parent, not history rows.
    expect(page.queryByText("subagent work")).not.toBeInTheDocument();
    // Archived ones stay out until asked for.
    expect(page.queryByText("old shelved idea")).not.toBeInTheDocument();
  });

  it("searches on the server, not by filtering a downloaded history", async () => {
    const page = await openHistory();
    await userEvent.type(screen.getByPlaceholderText("Search conversations"), "manuscript");

    await waitFor(() => expect(queries_seen.some((q) => q.search === "manuscript")).toBe(true));
    await waitFor(() => expect(page.queryByText("today's analysis")).not.toBeInTheDocument());
    expect(page.getByText("manuscript draft")).toBeInTheDocument();
  });

  it("shows archived conversations only when asked, and marks them", async () => {
    const page = await openHistory();
    await userEvent.click(screen.getByLabelText("Show archived"));

    expect(await page.findByText("old shelved idea")).toBeInTheDocument();
    expect(page.getByText("archived")).toBeInTheDocument();
    expect(queries_seen.some((q) => q.archived === true)).toBe(true);
  });

  it("archives a conversation and takes it out of the default view", async () => {
    const page = await openHistory();
    await userEvent.click(page.getByRole("button", { name: "Actions for today's analysis" }));
    await userEvent.click(await screen.findByText("Archive"));

    expect(setSessionArchived).toHaveBeenCalledWith("s1", true);
    await waitFor(() => expect(page.queryByText("today's analysis")).not.toBeInTheDocument());
  });

  it("restores an archived conversation", async () => {
    const page = await openHistory();
    await userEvent.click(screen.getByLabelText("Show archived"));
    await page.findByText("old shelved idea");

    await userEvent.click(page.getByRole("button", { name: "Actions for old shelved idea" }));
    await userEvent.click(await screen.findByText("Restore"));

    expect(setSessionArchived).toHaveBeenCalledWith("s5", false);
    // Still listed (the filter is on), but no longer badged.
    expect(page.getByText("old shelved idea")).toBeInTheDocument();
    await waitFor(() => expect(page.queryByText("archived")).not.toBeInTheDocument());
  });

  it("renames a session that the runtime never auto-titled", async () => {
    const page = await openHistory();
    await userEvent.click(page.getByRole("button", { name: "Actions for today's analysis" }));
    await userEvent.click(await screen.findByText("Rename"));

    const input = await page.findByDisplayValue("today's analysis");
    await userEvent.clear(input);
    await userEvent.type(input, "Spike sorting{Enter}");

    expect(renameSession).toHaveBeenCalledWith("s1", "Spike sorting");
  });

  it("files a loose conversation under an existing project", async () => {
    const page = await openHistory();
    await userEvent.click(page.getByRole("button", { name: "Actions for yesterday's debugging" }));
    await userEvent.click(await screen.findByText("Add to project"));
    const submenu = await screen.findByRole("menu", { name: "Add to project" });
    await userEvent.click(within(submenu).getByText("BCI trends"));

    expect(moveSessionToWorkspace).toHaveBeenCalledWith("s2", "/work/projects/bci");
  });
});
