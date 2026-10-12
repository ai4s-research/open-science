import { describe, expect, it } from "vitest";
import { splitStreamingMarkdown } from "./markdownSegments";

/** Stream `text` char-by-char (in chunks) and assert the two invariants hold
 *  at every step: lossless concatenation and prefix-stable sealing. */
function expectStreamingInvariants(chunks: string[]) {
  let text = "";
  let prevSealed: string[] = [];
  for (const chunk of chunks) {
    text += chunk;
    const { sealed, tail } = splitStreamingMarkdown(text);
    expect(sealed.join("") + tail).toBe(text);
    // Prefix stability: earlier seals are a prefix of the current seals.
    expect(sealed.length).toBeGreaterThanOrEqual(prevSealed.length);
    prevSealed.forEach((seg, i) => expect(sealed[i]).toBe(seg));
    prevSealed = sealed;
  }
  return splitStreamingMarkdown(text);
}

describe("splitStreamingMarkdown (#157)", () => {
  it("seals paragraphs at blank lines, keeping the live tail open", () => {
    const { sealed, tail } = splitStreamingMarkdown("First para.\n\nSecond para.\n\nThird grows");
    expect(sealed).toEqual(["First para.\n\n", "Second para.\n\n"]);
    expect(tail).toBe("Third grows");
  });

  it("keeps an unclosed code fence entirely in the tail", () => {
    const { sealed, tail } = splitStreamingMarkdown("Intro.\n\n```python\nfor x in xs:\n\n    run(x)\n");
    expect(sealed).toEqual(["Intro.\n\n"]);
    expect(tail).toContain("```python");
    expect(tail).toContain("run(x)");
  });

  it("seals a closed fence as one segment even with blank lines inside", () => {
    const text = "Before.\n\n```\nline one\n\nline two\n```\n\nAfter.";
    const { sealed, tail } = splitStreamingMarkdown(text);
    expect(sealed).toEqual(["Before.\n\n", "```\nline one\n\nline two\n```\n\n"]);
    expect(tail).toBe("After.");
  });

  it("keeps a table with its rows in one segment", () => {
    const text = "| a | b |\n|---|---|\n| 1 | 2 |\n\nNext.";
    const { sealed, tail } = splitStreamingMarkdown(text);
    expect(sealed).toEqual(["| a | b |\n|---|---|\n| 1 | 2 |\n\n"]);
    expect(tail).toBe("Next.");
  });

  it("does not seal inside block math, and ignores one-line math", () => {
    const math = "Answer $x$ inline.\n\n$$\n\\int_0^1\n\nx\\,dx\n$$\n\nDone.";
    const { sealed, tail } = splitStreamingMarkdown(math);
    expect(sealed).toEqual(["Answer $x$ inline.\n\n", "$$\n\\int_0^1\n\nx\\,dx\n$$\n\n"]);
    expect(tail).toBe("Done.");
    // One-line block math must not leave inMath stuck on.
    const oneLine = splitStreamingMarkdown("$$\nE = mc^2\n$$\n\nWait $$y$$ now.\n\nAfter.");
    expect(oneLine.tail).toBe("After.");
  });

  it("never seals a run of blank lines without content", () => {
    const { sealed, tail } = splitStreamingMarkdown("Only.\n\n\n\nMore");
    expect(sealed).toEqual(["Only.\n\n"]);
    expect(tail).toBe("\n\nMore");
  });

  it("stays prefix-stable and lossless across a realistic token stream", () => {
    const chunk = (s: string) => s.match(/.{1,7}/gs) ?? [];
    const prose = "Working through the queue now. The first pass reproduces the headline table. ";
    const code = "\n\n```python\nfor batch in batches:\n    qc = run_qc(batch)\n\n    report(qc.summary())\n```\n\n";
    const table = "\n| check | value |\n|---|---|\n| dispersion | 0.41 |\n\n";
    const chunks = [prose, code, prose, table, prose, "\n\nFinal paragraph still typing"];
    const final = expectStreamingInvariants(chunks.flatMap(chunk));
    expect(final.sealed.length).toBeGreaterThanOrEqual(4);
    expect(final.tail).toContain("still typing");
  });

  it("keeps a loose list, and code inside a list item, in one segment", () => {
    const loose = splitStreamingMarkdown("Steps:\n\n1. Install\n\n2. Run\n\nDone");
    expect(loose.sealed).toEqual(["Steps:\n\n1. Install\n\n2. Run\n\n"]);
    expect(loose.tail).toBe("Done");
    const nested = splitStreamingMarkdown("- Build:\n\n    ```bash\n    make\n    ```\n\n- Test\n\nAfter");
    expect(nested.sealed).toEqual(["- Build:\n\n    ```bash\n    make\n    ```\n\n- Test\n\n"]);
    expect(nested.tail).toBe("After");
  });

  it("waits while the next line could still become a list item", () => {
    expect(splitStreamingMarkdown("1. a\n\n2").sealed).toEqual([]);
    expect(splitStreamingMarkdown("1. a\n\n2. b").sealed).toEqual([]);
    expect(splitStreamingMarkdown("1. a\n\n2024 was").sealed).toEqual(["1. a\n\n"]);
    expect(splitStreamingMarkdown("Para.\n\n**bold** start").sealed).toEqual(["Para.\n\n"]);
    const chars = [..."Intro.\n\n1. one\n\n2. two\n\n- x\n\n-- not a list\n\n3 apples\n\nend"];
    expectStreamingInvariants(chars);
  });

  it("does not close a fence on a shorter or labelled fence inside it", () => {
    const text = "````md\n```js\nlet a = 1\n\nlet b = 2\n```\n````\n\nafter";
    const { sealed, tail } = splitStreamingMarkdown(text);
    expect(sealed).toEqual(["````md\n```js\nlet a = 1\n\nlet b = 2\n```\n````\n\n"]);
    expect(tail).toBe("after");
  });

  it("tolerates CRLF line endings", () => {
    const { sealed, tail } = splitStreamingMarkdown("One.\r\n\r\nTwo.");
    expect(sealed).toEqual(["One.\r\n\r\n"]);
    expect(tail).toBe("Two.");
  });
});
