import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownViewer } from "./MarkdownViewer";

vi.mock("@/lib/tauri", () => ({ isTauri: false, openExternal: vi.fn() }));

// Every path the conversation names resolves; resolving itself is lib/links' job.
vi.mock("@/lib/links", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/links")>();
  return {
    ...actual,
    resolveLink: vi.fn(async (text: string) => ({
      kind: "path",
      path: text,
      root: "workspace",
      isDir: false,
      display: text,
    })),
  };
});

describe("MarkdownViewer · paths in plain answer text", () => {
  it("makes a path in a paragraph and in a list item clickable", async () => {
    render(<MarkdownViewer links>{"Saved to src/report.md today.\n\n- see out/fig1.png"}</MarkdownViewer>);
    expect(await screen.findByRole("link", { name: "src/report.md" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "out/fig1.png" })).toBeInTheDocument();
    // The prose around a path stays plain text.
    expect(screen.queryByRole("link", { name: /today/ })).not.toBeInTheDocument();
  });

  it("leaves a document preview's text alone", async () => {
    render(<MarkdownViewer>{"Saved to src/report.md today."}</MarkdownViewer>);
    await Promise.resolve();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
