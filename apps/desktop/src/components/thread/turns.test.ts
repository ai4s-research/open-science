import { describe, expect, it } from "vitest";
import type { ThreadBlock } from "@ai4s/shared";
import { isTurnDone, spanMs, splitTurns } from "./turns";

const user = (text: string) => ({ kind: "user", text }) as ThreadBlock;
const agent = (markdown: string, t?: { created?: number; completed?: number }) =>
  ({ kind: "agent", markdown, ...t }) as ThreadBlock;
const ran = (title: string, t?: { startedAt?: number; endedAt?: number }) =>
  ({ kind: "tool-call", title, status: "success", verb: "Ran", ...t }) as ThreadBlock;
const think = (text: string) => ({ kind: "reasoning", text }) as ThreadBlock;
const reviewer = () => ({ kind: "reviewer", findings: [] }) as ThreadBlock;
/** Every block of a turn's work, whichever segment it landed in. */
const workOf = (t: { segments: { blocks: ThreadBlock[] }[] }) => t.segments.flatMap((s) => s.blocks);

describe("splitTurns", () => {
  it("takes the LAST agent message as the answer, not the first", () => {
    // A model that narrates as it goes writes several; the earlier ones are it
    // thinking out loud, which belongs with the work.
    const [turn] = splitTurns([
      user("go"),
      agent("I will start by reading the data"),
      ran("python a.py"),
      agent("Done. IC50 = 31.8 nM."),
    ]);
    expect(turn.lead).toHaveLength(1);
    expect(workOf(turn).map((b) => b.kind)).toEqual(["agent", "tool-call"]);
    expect(turn.answer).toHaveLength(1);
    expect((turn.answer[0] as { markdown: string }).markdown).toBe("Done. IC50 = 31.8 nM.");
  });

  it("gives a turn with no answer yet no fold — that turn is the running one", () => {
    const [turn] = splitTurns([user("go"), think("let me look"), ran("ls")]);
    expect(turn.answer).toHaveLength(0);
    expect(isTurnDone(turn)).toBe(false);
  });

  it("never folds a question that has no work behind it", () => {
    const [turn] = splitTurns([user("hi"), agent("hello")]);
    expect(workOf(turn)).toHaveLength(0);
    expect(isTurnDone(turn)).toBe(false);
  });

  it("starts a turn at every user message, and copes with a transcript that opens mid-conversation", () => {
    const turns = splitTurns([ran("leftover"), agent("a"), user("two"), ran("x"), agent("b")]);
    expect(turns).toHaveLength(2);
    expect(turns[0].lead).toHaveLength(0);
    expect(turns[1].lead).toHaveLength(1);
  });

  it("loses no block: every input block lands in exactly one part", () => {
    const blocks = [user("go"), think("t"), ran("x"), agent("mid"), ran("y"), agent("final")];
    const parts = splitTurns(blocks).flatMap((t) => [...t.lead, ...workOf(t), ...t.answer]);
    expect(parts).toEqual(blocks);
  });
});

describe("spanMs", () => {
  it("spans from the first stamp to the last, across block kinds", () => {
    const [turn] = splitTurns([
      user("go"),
      ran("a", { startedAt: 1_000, endedAt: 4_000 }),
      agent("done", { created: 4_500, completed: 9_000 }),
    ]);
    expect(spanMs([...workOf(turn), ...turn.answer])).toBe(8_000);
  });

  it("is null when the blocks carry no stamps, so the fold says 'Worked' and no figure", () => {
    const [turn] = splitTurns([user("go"), ran("a"), agent("done")]);
    expect(spanMs([...workOf(turn), ...turn.answer])).toBeNull();
  });

  it("still bounds a span whose last block never stamped an end", () => {
    // An answer with no `completed` would otherwise make a long turn read as
    // instantaneous.
    const [turn] = splitTurns([
      user("go"),
      ran("a", { startedAt: 1_000 }),
      agent("done", { created: 61_000 }),
    ]);
    expect(spanMs([...workOf(turn), ...turn.answer])).toBe(60_000);
  });
});

describe("what must stay visible", () => {
  it("keeps a reviewer's findings out of the fold, and splits the run around them", () => {
    // The next message answers the finding ("the sub-agent caught the swap"),
    // so folding it would leave the answer referring to something unseen.
    const [turn] = splitTurns([
      user("go"),
      ran("a"),
      reviewer(),
      ran("b"),
      agent("Acknowledged — the plan listed the same PMID twice."),
    ]);
    expect(turn.segments.map((s) => s.foldable)).toEqual([true, false, true]);
    expect(turn.segments[1].blocks[0].kind).toBe("reviewer");
  });

  it("does not fold a turn whose only work is a notice", () => {
    const [turn] = splitTurns([user("go"), reviewer(), agent("done")]);
    expect(isTurnDone(turn)).toBe(false);
  });
});
