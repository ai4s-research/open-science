import { describe, expect, it } from "vitest";
import type { SessionMeta } from "@ai4s/sdk";
import {
  applyRef,
  condenseTranscript,
  matchPaths,
  matchSessions,
  refTriggerAt,
} from "./references";

describe("refTriggerAt", () => {
  it("opens on @ and # at the start of the input and mid-sentence", () => {
    expect(refTriggerAt("@tri", 4)).toEqual({ kind: "file", query: "tri", start: 0 });
    expect(refTriggerAt("compare with #spike", 19)).toEqual({
      kind: "session",
      query: "spike",
      start: 13,
    });
  });

  it("opens on a bare sigil, before anything is typed", () => {
    expect(refTriggerAt("look at @", 9)).toEqual({ kind: "file", query: "", start: 8 });
  });

  it("stays shut inside a word — an email or a URL fragment is not a reference", () => {
    expect(refTriggerAt("mail me@example.com", 19)).toBeNull();
    expect(refTriggerAt("see docs#install", 16)).toBeNull();
  });

  it("closes once the caret leaves the token", () => {
    // Caret parked before the sigil, and after a space that ended the token.
    expect(refTriggerAt("@trials.csv now", 15)).toBeNull();
    expect(refTriggerAt("@trials", 0)).toBeNull();
  });

  it("lowercases the query so matching is case-insensitive", () => {
    expect(refTriggerAt("@Trials", 7)?.query).toBe("trials");
  });
});

describe("applyRef", () => {
  it("replaces the typed token and leaves the rest of the line intact", () => {
    // The caret sits right after "tri" — index 9, before the space.
    const trigger = refTriggerAt("plot @tri please", 9)!;
    const out = applyRef("plot @tri please", trigger, 9, "@data/trials.csv");
    expect(out.value).toBe("plot @data/trials.csv  please");
    // Caret lands after the inserted reference and its trailing space.
    expect(out.value.slice(0, out.caret)).toBe("plot @data/trials.csv ");
  });

  it("removes the token when the reference is carried by a chip instead", () => {
    const trigger = refTriggerAt("compare with #spike", 19)!;
    const out = applyRef("compare with #spike", trigger, 19, "");
    expect(out.value).toBe("compare with  ");
  });
});

describe("matchPaths", () => {
  const paths = [
    "notes/trials.md",
    "data/raw/trials.csv",
    "trials/readme.md",
    "src/analysis.py",
  ];

  it("ranks a filename hit above a hit anywhere in the path", () => {
    expect(matchPaths(paths, "trials")).toEqual([
      "notes/trials.md",
      "data/raw/trials.csv",
      "trials/readme.md",
    ]);
  });

  it("offers the head of the list when nothing has been typed yet", () => {
    expect(matchPaths(paths, "", 2)).toEqual(["notes/trials.md", "data/raw/trials.csv"]);
  });
});

describe("matchSessions", () => {
  const sessions: SessionMeta[] = [
    { id: "a", title: "spike sorting", updated: 3 },
    { id: "b", title: "manuscript draft", updated: 5 },
    { id: "c", title: "subagent run", updated: 9, parentId: "b" },
    { id: "d", title: "spike review", updated: 1 },
  ];

  it("offers top-level conversations, newest first", () => {
    expect(matchSessions(sessions, null, "").map((s) => s.id)).toEqual(["b", "a", "d"]);
  });

  it("never offers the conversation you are typing in", () => {
    expect(matchSessions(sessions, "b", "").map((s) => s.id)).toEqual(["a", "d"]);
  });

  it("filters by title", () => {
    expect(matchSessions(sessions, null, "spike").map((s) => s.id)).toEqual(["a", "d"]);
  });
});

describe("condenseTranscript", () => {
  it("keeps what was asked and where it landed, dropping the middle", () => {
    const out = condenseTranscript([
      { role: "user", parts: [{ type: "text", text: "How do I sort spikes?" }] },
      { role: "assistant", parts: [{ type: "text", text: "middle reasoning" }] },
      { role: "user", parts: [{ type: "text", text: "and the threshold?" }] },
      { role: "assistant", parts: [{ type: "text", text: "Use 4.5 sigma." }] },
    ]);
    expect(out).toBe("Asked: How do I sort spikes?\n\nConcluded: Use 4.5 sigma.");
  });

  it("is empty for a conversation with nothing to quote", () => {
    expect(condenseTranscript([])).toBe("");
    expect(condenseTranscript([{ role: "assistant", parts: [{ type: "tool" }] }])).toBe("");
  });
});
