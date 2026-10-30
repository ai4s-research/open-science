import { describe, expect, it } from "vitest";
import { BLANK, bufferAnchors, cellStyle, lineCandidates, logicalLine, pickLongest, rowText } from "./terminalLinks";

/** A fake xterm row: each entry is one cell's characters, "" for the second
 *  half of a wide character. */
function row(cells: string[]) {
  return {
    length: cells.length,
    getCell: (x: number) => {
      const c = cells[x];
      if (c === undefined) return undefined;
      const wide = cells[x + 1] === "";
      return { getChars: () => c, getWidth: () => (c === "" ? 0 : wide ? 2 : 1), ...cell() } as never;
    },
  };
}

/** A fake cell's style: default unless a foreground color is given. */
function cell(fg?: number) {
  const no = () => 0;
  return {
    isFgDefault: () => fg === undefined,
    isBgDefault: () => true,
    getFgColorMode: () => (fg === undefined ? 0 : 0x3000000),
    getFgColor: () => fg ?? -1,
    getBgColorMode: no,
    getBgColor: () => -1,
    isBold: no,
    isItalic: no,
    isDim: no,
    isUnderline: no,
    isInverse: no,
    isStrikethrough: no,
  };
}

describe("cellStyle", () => {
  it("is empty for the default style and a key otherwise", () => {
    expect(cellStyle(cell() as never)).toBe("");
    expect(cellStyle(cell(0x5769f7) as never)).not.toBe("");
    expect(cellStyle(cell(0x5769f7) as never)).not.toBe(cellStyle(cell(0x000000) as never));
  });
});

describe("rowText", () => {
  it("maps each character to its cell, wide characters taking two", () => {
    const { text, cells } = rowText(row(["中", "", "a", "/", "b"]));
    expect(text).toBe("中a/b");
    expect(cells).toEqual([
      { x: 0, width: 2, style: "" },
      { x: 2, width: 1, style: "" },
      { x: 3, width: 1, style: "" },
      { x: 4, width: 1, style: "" },
    ]);
  });

  it("reads a cell nothing was printed into as a blank space", () => {
    const blank = { getChars: () => "", getWidth: () => 1, ...cell() } as never;
    const { text, cells } = rowText({ length: 3, getCell: (x: number) => (x === 1 ? blank : row(["a", "", "b"]).getCell(x)) });
    expect(text).toBe("a b");
    expect(cells[1].style).toBe(BLANK);
  });
});

/** Rows as text, one cell per character, padded to `cols` like a real buffer.
 *  A leading "↪" marks a row the terminal itself wrapped onto. `styles` gives
 *  each row's cells a style, one letter per cell ("." default, "_" nothing
 *  printed there); the rest of the row takes `pad`. */
function screen(lines: string[], cols: number, styles: string[] = [], pad = ".") {
  const rows = lines.map((l, i) => {
    const wrapped = l.startsWith("↪");
    const text = (wrapped ? l.slice(1) : l).padEnd(cols, " ");
    const mask = (styles[i] ?? "").padEnd(cols, pad);
    return {
      text,
      cells: [...text].map((_, x) => ({ x, width: 1, style: mask[x] === "." ? "" : mask[x] === "_" ? BLANK : mask[x] })),
      wrapped,
    };
  });
  return (y: number) => rows[y - 1] ?? null;
}

describe("logicalLine", () => {
  const cols = 40;

  it("puts back a path a TUI broke over two indented rows, from either row", () => {
    const rows = screen(
      [
        "● Open: /Users/me/Documents/projects/d",
        "  sh-notes/dsh-principles.html",
        "",
        "  Next paragraph",
      ],
      cols,
    );
    for (const y of [1, 2]) {
      const line = logicalLine(rows, y, cols);
      expect(line.text.trimEnd()).toBe("● Open: /Users/me/Documents/projects/dsh-notes/dsh-principles.html");
      expect(line.breaks).toEqual([{ at: 38, nearEdge: true }]);
      const spans = lineCandidates(line).map((s) => s.text);
      expect(spans).toContain("/Users/me/Documents/projects/dsh-notes/dsh-principles.html");
      // The row-by-row pieces stay candidates, for when the whole does not resolve.
      expect(spans).toContain("/Users/me/Documents/projects/d");
      expect(spans).toContain("sh-notes/dsh-principles.html");
    }
    // The second row's characters keep their own cells.
    const line = logicalLine(rows, 2, cols);
    expect(line.cells[38]).toEqual({ x: 2, y: 2, width: 1, style: "" });
  });

  it("joins rows the terminal wrapped as they are", () => {
    const rows = screen(["/Users/me/a-very-long-folder-name/and-a-", "↪file.txt"], cols);
    const line = logicalLine(rows, 2, cols);
    expect(line.text.trimEnd()).toBe("/Users/me/a-very-long-folder-name/and-a-file.txt");
    expect(line.breaks).toEqual([]);
  });

  it("does not join across a blank row or sentence punctuation", () => {
    expect(logicalLine(screen(["see notes/", "", "x/y"], cols), 1, cols).text.trim()).toBe("see notes/");
    expect(logicalLine(screen(["done (a/b)", "next/c"], cols), 2, cols).text.trim()).toBe("next/c");
  });

  it("lets a URL cross a break only where the row ran up to the edge", () => {
    const short = logicalLine(screen(["see https://a.com", "for details"], cols), 1, cols);
    expect(lineCandidates(short).map((s) => s.text)).toEqual(["https://a.com"]);
    const full = logicalLine(screen(["see https://example.com/a/very/long/pa", "  th/to/page"], cols), 1, cols);
    expect(lineCandidates(full).map((s) => s.text)).toContain("https://example.com/a/very/long/path/to/page");
  });
});

describe("a highlighted path with spaces", () => {
  const cols = 40;
  /** A style mask for `line` with `part` (its first occurrence) in style "b". */
  const mark = (line: string, part: string) => {
    const i = line.indexOf(part);
    return ".".repeat(i) + "b".repeat(part.length) + ".".repeat(line.length - i - part.length);
  };
  const at = (lines: string[], styles: string[], y: number, pad = ".") => {
    const line = logicalLine(screen(lines, cols, styles, pad), y, cols);
    return { line, spans: lineCandidates(line) };
  };

  it("is a candidate as a whole, on one row", () => {
    const text = "see /Users/me/My Files/a b.pdf ok";
    const { spans } = at([text], [mark(text, "/Users/me/My Files/a b.pdf")], 1);
    expect(spans.map((s) => s.text)).toContain("/Users/me/My Files/a b.pdf");
    // The pieces stay candidates too.
    expect(spans.map((s) => s.text)).toContain("/Users/me/My");
  });

  it("goes on over a space the TUI skipped instead of printing", () => {
    // A resumed Claude Code moves the cursor over spaces: nothing is printed there.
    const text = "  /Users/me/dmg/Open Science.dmg";
    const styles = ["__" + "b".repeat(18) + "_" + "b".repeat(11)];
    const { spans } = at([text], styles, 1, "_");
    expect(spans.map((s) => s.text)).toContain("/Users/me/dmg/Open Science.dmg");
  });

  it("tries a word wrap with the space it took, when no space was printed", () => {
    const lines = ["  /Users/me/release/dmg/Open", "  Science_0.7.0_aarch64.dmg"];
    const styles = [mark(lines[0], "/Users/me/release/dmg/Open").replace(/\./g, "_"), mark(lines[1], "Science_0.7.0_aarch64.dmg").replace(/\./g, "_")];
    const { spans } = at(lines, styles, 2, "_");
    expect(spans.map((s) => s.text)).toContain("/Users/me/release/dmg/Open Science_0.7.0_aarch64.dmg");
  });

  it("gets back the space a word wrap took, from either row", () => {
    // Claude Code wraps inline code at the space and indents the rest.
    // The space ending the first row is printed in the path's style.
    const lines = ["● at /Users/me/release/dmg/Open ", "  Science_0.7.0_aarch64.dmg ok"];
    const styles = [mark(lines[0], "/Users/me/release/dmg/Open "), mark(lines[1], "Science_0.7.0_aarch64.dmg")];
    for (const y of [1, 2]) {
      const { line, spans } = at(lines, styles, y);
      expect(line.breaks).toEqual([{ at: 31, nearEdge: false }]);
      const whole = spans.find((s) => s.text === "/Users/me/release/dmg/Open Science_0.7.0_aarch64.dmg");
      expect(whole).toBeDefined();
      // The span covers the cells of both rows.
      expect(line.cells[whole!.start]).toMatchObject({ x: 5, y: 1 });
      expect(line.cells[whole!.end - 1]).toMatchObject({ x: 26, y: 2 });
    }
  });

  it("keeps a path wrapped mid-name whole", () => {
    const lines = ["at /Users/me/projects/open-ai4s-workbe", "  nch/dmg/Open Science.dmg ok"];
    const styles = [mark(lines[0], "/Users/me/projects/open-ai4s-workbe"), mark(lines[1], "nch/dmg/Open Science.dmg")];
    const { line, spans } = at(lines, styles, 2);
    expect(line.breaks).toEqual([{ at: 38, nearEdge: true }]);
    expect(spans.map((s) => s.text)).toContain("/Users/me/projects/open-ai4s-workbench/dmg/Open Science.dmg");
  });

  it("keeps the plain reading of a path wrapped mid-name in a shaded box", () => {
    const lines = ["  /Users/me/a-very-long-folder/and-a", "  -file.txt"];
    const { spans } = at(lines, ["gggggggggggggggggggggggggggggggggggg", "gggggggggggg"], 1, "g");
    expect(spans.map((s) => s.text)).toContain("/Users/me/a-very-long-folder/and-a-file.txt");
  });

  it("starts where the path does, after a marker in the same style", () => {
    // Claude Code prints a tool call's result line, `⎿` and all, in one grey.
    const text = "  ⎿  ~/Downloads/Awesome Prompts Penguin Banner.png";
    const { spans } = at([text], [mark(text, "⎿  ~/Downloads/Awesome Prompts Penguin Banner.png")], 1);
    expect(spans.map((s) => s.text)).toContain("~/Downloads/Awesome Prompts Penguin Banner.png");
  });

  it("finds a path at the end of a styled paragraph wrapped over rows", () => {
    // A recap: prose and the path in one italic, broken mid-name and at a space.
    const lines = ["recap: 打好了，装上验收：/Users/me/projects/open-ai4s-workb", "ench/release/dmg/Open", "Science_0.7.1_aarch64.dmg"];
    const styles = lines.map((l) => "b".repeat(l.length));
    const { spans } = at(lines, styles, 3, ".");
    expect(spans.map((s) => s.text)).toContain(
      "/Users/me/projects/open-ai4s-workbench/release/dmg/Open Science_0.7.1_aarch64.dmg",
    );
  });

  it("is not tried in unstyled prose", () => {
    const { spans } = at(["see the a/b notes and c/d"], [], 1);
    expect(spans.map((s) => s.text)).toEqual(["a/b", "c/d"]);
  });
});

describe("pickLongest", () => {
  it("keeps the longest of overlapping spans", () => {
    const spans = [
      { start: 0, end: 10 },
      { start: 0, end: 30 },
      { start: 12, end: 30 },
      { start: 31, end: 35 },
    ];
    expect(pickLongest(spans)).toEqual([
      { start: 0, end: 30 },
      { start: 31, end: 35 },
    ]);
  });
});

describe("bufferAnchors", () => {
  it("reads absolute paths from the output, the latest first, wrapped rows as one line", () => {
    const rows = screen(["⏺ Read(/Users/me/rep", "↪o/README.md)", "$ cd /Users/me/other", "ok"], 20);
    expect(bufferAnchors(rows, 4)).toEqual(["/Users/me/other", "/Users/me/repo/README.md"]);
  });
});
