// @vitest-environment node
//
// Every pane that sits BESIDE a conversation wears the same 32px header, so
// its bottom rule lines up with the session header's. The coupling is invisible
// to tsc and to every rendering test — each pane looks right on its own, and
// the misalignment only exists between two of them — which is how the Runs pane
// carried a 48px header of its own for as long as it did: a 16px step in the
// rule between the chat and the panel, on every window that had both open.
//
// Checked by reading the files, the way `tauriCommands.test.ts` checks the
// Rust command names: the invariant is a relationship between files, not a
// behaviour any one component can be rendered to prove.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every component that renders a pane alongside a conversation. */
const PANES = [
  "app/routes/RunsPage.tsx",
  "app/routes/FilesPage.tsx",
  "components/thread/SubagentPane.tsx",
  "components/inspector/ArtifactInspector.tsx",
  "components/inspector/NotebookInspector.tsx",
  "components/inspector/PdfInspector.tsx",
  "components/inspector/FilePreviewInspector.tsx",
  "components/notebook/NotebookEditor.tsx",
  "components/session/ContentPane.tsx",
];

const read = (file: string) => readFileSync(join(src, file), "utf8");

describe("the pane header", () => {
  it("is 32px, the same as the session header it sits beside", () => {
    expect(read("components/inspector/RightPane.tsx")).toMatch(/PANE_HEADER\s*=\s*\n?\s*"flex h-8 /);
    // The other half of the pair: SessionView's own header row.
    expect(read("components/session/SessionView.tsx")).toContain('!(sidebarCollapsed && asTitlebar) && "h-8"');
  });

  it.each(PANES)("%s takes its header height from PANE_HEADER", (file) => {
    // Either it uses the constant, or it spells the same row out and says so —
    // the two that do (a notebook, a file preview) need a different border, not
    // a different height.
    expect(read(file)).toContain("PANE_HEADER");
  });

  it.each(PANES)("%s gives no bordered header row a height of its own", (file) => {
    const offenders = read(file)
      .split("\n")
      .filter((line) => /\bborder-b\b/.test(line) && /\bh-(?:9|1[0-9])\b/.test(line));
    expect(offenders).toEqual([]);
  });
});
