import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FilePreviewInspector as FilePreviewInspectorT } from "@ai4s/shared";
import { readArtifact } from "@/lib/artifactFile";
import { useRuntimeStore } from "@/lib/runtime";
import { FilePreviewInspector, PreviewError } from "./FilePreviewInspector";

// The markdown tests below carry inline `content`, so they never hit
// readArtifact — this mock only feeds the binary-file test.
const probeLargeFile = vi.fn();
vi.mock("@/lib/artifactFile", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/artifactFile")>();
  return {
    ...mod,
    readArtifact: vi.fn(async () => ({
      path: "data/blob.bin",
      mime: "application/octet-stream",
      encoding: "base64",
      data: "AAEC",
      size: 3,
    })),
    probeLargeFile: (...args: unknown[]) => probeLargeFile(...args),
    writeWorkspaceFile: (...args: Parameters<typeof writeWorkspaceFile>) =>
      writeWorkspaceFile(...args),
  };
});

// Monaco needs a real layout engine; jsdom has none. These tests are about the
// INSPECTOR — dirty state, autosave, discard — so the editor is a textarea with
// the same contract. See `test/monacoStub`.
vi.mock("@/components/code-editor/monacoSetup", () => import("@/test/monacoStub"));

// Editing is desktop-only, so the editing tests need the app to believe it is
// running under Tauri.
const writeWorkspaceFile = vi.fn(async (_path: string, _content: string, _root?: unknown) => {});
const recordProvenance = vi.fn(
  async (_input: { path: string; tool: string; content?: string }, ..._rest: unknown[]) => {},
);
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  isTauri: true,
}));
vi.mock("@/lib/provenance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/provenance")>()),
  recordProvenance: (...args: Parameters<typeof recordProvenance>) => recordProvenance(...args),
}));

const md: FilePreviewInspectorT = {
  variant: "file",
  path: "notes/report.md",
  filename: "report.md",
  artifact: "report",
  content: "# Findings\n\nDose–response holds. `p < 0.01`.",
};

describe("FilePreviewInspector — markdown", () => {
  it("uses the same compact 32px header as a tiled Session pane", () => {
    const { container } = render(
      <FilePreviewInspector data={md} onClose={() => {}} compactHeader />,
    );
    expect(container.querySelector("header")).toHaveClass("h-8", "border-faint");
  });

  it("renders markdown as a formatted document by default", async () => {
    render(<FilePreviewInspector data={md} onClose={() => {}} />);
    // The heading is real document markup, not raw "# Findings" text.
    expect(await screen.findByRole("heading", { name: "Findings" })).toBeInTheDocument();
    expect(screen.queryByText("# Findings")).not.toBeInTheDocument();
  });

  it("toggles to the raw source under the Code tab", async () => {
    render(<FilePreviewInspector data={md} onClose={() => {}} />);
    await screen.findByRole("heading", { name: "Findings" });
    await userEvent.click(screen.getByRole("button", { name: /Code/ }));
    expect(screen.getByText(/# Findings/)).toBeInTheDocument();
  });

  it("shows the newly opened file, not the previous one (no stale bleed)", async () => {
    // The same inspector instance is reused across files; opening a second
    // file with its own inline content must replace the first, not keep it.
    const a: FilePreviewInspectorT = { ...md, path: "a.md", filename: "a.md", content: "# Alpha" };
    const b: FilePreviewInspectorT = { ...md, path: "b.md", filename: "b.md", content: "# Beta" };
    const { rerender } = render(<FilePreviewInspector data={a} onClose={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeInTheDocument();

    rerender(<FilePreviewInspector data={b} onClose={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Beta" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Alpha" })).not.toBeInTheDocument();
  });
});

describe("FilePreviewInspector — binary file behind a text preview", () => {
  it("says the file is binary instead of the misleading 'desktop app' note", async () => {
    // A text-kind preview whose read comes back base64 (genuinely binary
    // bytes) must say so — not claim the preview needs the desktop app.
    const bin: FilePreviewInspectorT = {
      variant: "file",
      path: "data/blob.bin",
      filename: "blob.bin",
      artifact: "data",
    };
    render(<FilePreviewInspector data={bin} onClose={() => {}} />);
    expect(await screen.findByText(/binary and has no preview/)).toBeInTheDocument();
    expect(screen.queryByText(/available in the desktop app/)).not.toBeInTheDocument();
  });
});

describe("FilePreviewInspector — markdown via readArtifact (Files browser path)", () => {
  it("renders a .md file that has no inline content by reading it from disk", async () => {
    const read = vi.mocked(readArtifact);
    read.mockResolvedValueOnce({
      path: "notes/report.md",
      mime: "text/markdown",
      encoding: "utf8",
      data: "# Disk-loaded\n\nRendered from readArtifact.",
      size: 40,
    });
    render(
      <FilePreviewInspector
        data={{ variant: "file", path: "notes/report.md", filename: "report.md", artifact: "report" }}
        onClose={() => {}}
      />,
    );
    // The heading is real document markup fetched through readArtifact — the
    // path the Files browser (no inline content) actually exercises.
    expect(await screen.findByRole("heading", { name: "Disk-loaded" })).toBeInTheDocument();
    expect(read).toHaveBeenCalledWith("notes/report.md", undefined);
  });

  it("falls back to the desktop-app note when the file cannot be read (browser dev)", async () => {
    const read = vi.mocked(readArtifact);
    read.mockResolvedValueOnce(null);
    render(
      <FilePreviewInspector
        data={{ variant: "file", path: "notes/report.md", filename: "report.md", artifact: "report" }}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText(/desktop app/)).toBeInTheDocument();
  });
});

describe("FilePreviewInspector — session workspace scope", () => {
  const deck: FilePreviewInspectorT = {
    variant: "file",
    path: "GPT-5.6-Luna-self-introduction-premium.pptx",
    filename: "GPT-5.6-Luna-self-introduction-premium.pptx",
    artifact: "report",
  };

  it("waits for the owning session workspace and never reloads from another pane's root", async () => {
    const read = vi.mocked(readArtifact);
    read.mockClear();
    act(() => {
      useRuntimeStore.setState({ workspace: "/workspaces/other-session" });
    });

    render(
      <FilePreviewInspector
        data={deck}
        workspaceDirectory="/workspaces/luna-session"
      />,
    );
    expect(read).not.toHaveBeenCalled();

    act(() => {
      useRuntimeStore.setState({ workspace: "/workspaces/luna-session" });
    });
    await waitFor(() => {
      expect(read).toHaveBeenCalledWith(deck.path, undefined);
    });
    expect(read).toHaveBeenCalledTimes(1);

    // Focusing a different split pane changes the global active workspace.
    // The already-bound Luna preview must neither 404 nor read a same-named
    // file from that other directory.
    act(() => {
      useRuntimeStore.setState({ workspace: "/workspaces/third-session" });
    });
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("treats a \\?\\-prefixed workspace path as the same folder (Windows canonicalize)", async () => {
    // Tauri's canonicalize() returns \\?\C:\… on Windows; the persisted
    // workspace file and a session's directory come from different sources, so
    // without normalization the wait guard compares raw strings that never
    // match and the preview spins on "loading" forever (the REPORT.md bug).
    const read = vi.mocked(readArtifact);
    read.mockClear();
    act(() => {
      useRuntimeStore.setState({ workspace: "\\\\?\\C:\\Users\\root\\Documents\\OpenScience\\2026-08-01-1420" });
    });
    render(
      <FilePreviewInspector
        data={deck}
        workspaceDirectory="C:/Users/root/Documents/OpenScience/2026-08-01-1420"
      />,
    );
    // Same folder (modulo prefix / slashes): the preview must load immediately,
    // not park in the "waiting for workspace" state.
    await waitFor(() => {
      expect(read).toHaveBeenCalledWith(deck.path, undefined);
    });
    expect(screen.queryByText(/waiting for the workspace/i)).not.toBeInTheDocument();
  });

  it("shows a waiting note instead of spinning forever while parked on another workspace", async () => {
    const read = vi.mocked(readArtifact);
    read.mockClear();
    act(() => {
      useRuntimeStore.setState({ workspace: "/workspaces/other-session" });
    });
    render(
      <FilePreviewInspector
        data={deck}
        workspaceDirectory="/workspaces/luna-session"
      />,
    );
    // Parked: no read, and the pane settles into an explicit wait note — the
    // "loading…" spinner must not stay up indefinitely.
    await waitFor(() => {
      expect(screen.getByText(/waiting for the workspace/i)).toBeInTheDocument();
    });
    expect(read).not.toHaveBeenCalled();
  });
});

describe("PreviewError", () => {
  it("shows a helpful card with Open-externally for a too-large file", async () => {
    const onOpen = vi.fn();
    render(
      <PreviewError
        error="file too large to preview (>25 MB)"
        filename="huge.nc"
        path="data/huge.nc"
        onOpenExternally={onOpen}
      />,
    );
    expect(screen.getByText(/huge\.nc is too large to preview/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Open externally/ }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("inspects a too-large file without loading it and renders the pointer", async () => {
    probeLargeFile.mockResolvedValueOnce({
      format: "fastq",
      size: "90.0 GB",
      approx_reads: 450_000_000,
      read_length: { min: 150, max: 150, mean: 150 },
      gzipped: true,
      note: "Memory pointer — file introspected/sampled, not loaded.",
    });
    render(
      <PreviewError
        error="file too large to preview (>25 MB)"
        filename="reads.fastq.gz"
        path="data/reads.fastq.gz"
        onOpenExternally={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Inspect without loading/i }));
    // The pointer's key facts render — the format value, the read count, and
    // that it was sampled, not loaded.
    expect(await screen.findByText("fastq")).toBeInTheDocument(); // the Format cell, exact
    expect(screen.getByText(/450,000,000/)).toBeInTheDocument();
    expect(screen.getByText(/not loaded/i)).toBeInTheDocument();
    expect(probeLargeFile).toHaveBeenCalledWith("data/reads.fastq.gz", undefined);
  });

  it("shows the probe's error if introspection fails", async () => {
    probeLargeFile.mockRejectedValueOnce(new Error("no Python found"));
    render(
      <PreviewError error="file too large to preview" filename="x.bam" path="x.bam" onOpenExternally={() => {}} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Inspect without loading/i }));
    expect(await screen.findByText(/no Python found/)).toBeInTheDocument();
  });

  it("renders other errors as a plain line, no card", () => {
    render(<PreviewError error="Preview is available in the desktop app." filename="x.bin" onOpenExternally={() => {}} />);
    expect(screen.getByText(/available in the desktop app/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open externally/ })).not.toBeInTheDocument();
  });
});

describe("FilePreviewInspector — editing a file (#33)", () => {
  // These tests assert on what was NOT written, so each starts from no calls.
  beforeEach(() => vi.clearAllMocks());

  const py: FilePreviewInspectorT = {
    variant: "file",
    path: "analysis/fit.py",
    filename: "fit.py",
    artifact: "report",
    content: "import numpy as np\n",
  };

  /** Open the file and switch it into edit mode. The read-only view is
   *  highlighted markup, so its text is spread across spans — the Edit button
   *  appearing is the reliable signal that the file has loaded. */
  async function edit(data = py) {
    const view = render(<FilePreviewInspector data={data} onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit this file" }));
    // `findBy`, not `getBy`: the editor arrives with its own chunk, which is
    // loaded on demand rather than in the app's first bundle.
    return { view, editor: await screen.findByRole("textbox", { name: "Editing fit.py" }) };
  }

  it("shows the source read-only until the user asks to edit", async () => {
    const { container } = render(<FilePreviewInspector data={py} onClose={() => {}} />);
    await screen.findByRole("button", { name: "Edit this file" });
    expect(container.textContent).toContain("import numpy");
    // Nothing to type into: a file is read until it is opened for editing.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("does not offer Save until something actually changed", async () => {
    await edit();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("writes the edited text to disk and records it in the file's history", async () => {
    const { editor } = await edit();
    await userEvent.click(editor);
    await userEvent.keyboard("x = 1");

    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);

    await waitFor(() => expect(writeWorkspaceFile).toHaveBeenCalled());
    const [path, content] = writeWorkspaceFile.mock.calls[0]!;
    expect(path).toBe("analysis/fit.py");
    expect(content).toContain("x = 1");

    // The whole reason to edit in here rather than in an external editor: the
    // hand edit joins the same history an agent's write lands in.
    await waitFor(() => expect(recordProvenance).toHaveBeenCalled());
    const [input] = recordProvenance.mock.calls[0]!;
    expect(input.path).toBe("analysis/fit.py");
    expect(input.tool).toBe("manual-edit");
    expect(input.content).toContain("x = 1");
  });

  it("discards an edit without writing anything", async () => {
    const { view, editor } = await edit();
    await userEvent.click(editor);
    await userEvent.keyboard("oops");
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(writeWorkspaceFile).not.toHaveBeenCalled();
    // Back to the file as it is on disk, not to the abandoned draft.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(view.container.textContent).toContain("import numpy");
    expect(view.container.textContent).not.toContain("oops");
  });
});

describe("FilePreviewInspector — an editor pane", () => {
  beforeEach(() => vi.clearAllMocks());

  const py: FilePreviewInspectorT = {
    variant: "file",
    path: "analysis/fit.py",
    filename: "fit.py",
    artifact: "report",
    content: "import numpy as np\n",
  };

  it("opens editing, with no pencil to find first", async () => {
    render(<FilePreviewInspector data={py} onClose={() => {}} startEditing />);

    // Orca's editor tabs ARE editors; a preview with a hidden pencil is not
    // what "open the file" means.
    expect(await screen.findByRole("textbox", { name: "Editing fit.py" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit this file" })).not.toBeInTheDocument();
  });

  it("opens a markdown note on its text, with Orca's formatting toolbar", async () => {
    render(<FilePreviewInspector data={md} onClose={() => {}} startEditing />);

    // An editor pane lands on the source, not on a rendered page with the
    // editor hidden behind a toggle.
    expect(await screen.findByRole("textbox", { name: "Editing report.md" })).toBeInTheDocument();
    const toolbar = screen.getByRole("toolbar", { name: "Formatting" });
    for (const button of ["Heading 1", "Bold", "Bulleted list", "Quote", "Link"]) {
      expect(within(toolbar).getByRole("button", { name: button })).toBeInTheDocument();
    }
  });

  it("does not label a note the user opened as a 'report'", async () => {
    render(<FilePreviewInspector data={md} onClose={() => {}} startEditing />);
    await screen.findByRole("textbox", { name: "Editing report.md" });

    // The artifact badge belongs next to something a conversation produced.
    expect(screen.queryByText("Report")).not.toBeInTheDocument();
  });

  it("formats the text through the toolbar", async () => {
    render(<FilePreviewInspector data={md} onClose={() => {}} startEditing />);
    const editor = await screen.findByRole("textbox", { name: "Editing report.md" });

    await userEvent.click(editor);
    // On the heading line: the marker applies to the line the caret is on, and
    // a click lands the caret at the end of the text.
    (editor as HTMLTextAreaElement).setSelectionRange(0, 0);
    await userEvent.click(screen.getByRole("button", { name: "Quote" }));

    // The heading BECOMES a quote rather than being quoted as a heading —
    // one marker per line, the way Orca's toolbar behaves.
    await waitFor(() =>
      expect((editor as HTMLTextAreaElement).value).toContain("> Findings"),
    );
  });

  it("saves on its own, and says which state it is in", async () => {
    const editor = await (async () => {
      render(<FilePreviewInspector data={py} onClose={() => {}} startEditing />);
      return screen.findByRole("textbox", { name: "Editing fit.py" });
    })();

    await userEvent.click(editor);
    await userEvent.keyboard("x");

    // Autosave, as Orca does — no Save button to hunt for.
    await waitFor(() => expect(writeWorkspaceFile).toHaveBeenCalled(), { timeout: 3000 });
    // A light, not a word: "Saving…/Saved" sat against the buttons and read as
    // part of them. The state is the dot's label now.
    expect(await screen.findByRole("status", { name: "Saved" })).toBeInTheDocument();
  });
});

describe("FilePreviewInspector — the editor fills its pane", () => {
  const py: FilePreviewInspectorT = {
    variant: "file",
    path: "analysis/fit.py",
    filename: "fit.py",
    artifact: "report",
    content: "import numpy as np\n",
  };

  it("gives the editor a full-height box, not a padded one", async () => {
    render(<FilePreviewInspector data={py} onClose={() => {}} startEditing />);
    const editor = await screen.findByRole("textbox", { name: "Editing fit.py" });

    // Monaco lays itself out against a DEFINITE height. In the padded,
    // auto-height box the read-only view uses it collapsed to a ~30px strip
    // showing nothing but its own scrollbar.
    const box = editor.closest(".flex-1");
    expect(box?.className).toContain("min-h-0");
    expect(editor.closest(".p-3")).toBeNull();
  });

  it("keeps the read-only view in its padded block", async () => {
    render(<FilePreviewInspector data={py} onClose={() => {}} />);

    // A file being READ grows with its content inside the scrolling body —
    // that box was right all along, and only the editor needed a real height.
    // (Highlighting splits the source across spans, so the assertion is on the
    // block, not on a text node.)
    await waitFor(() => {
      const padded = document.querySelector(".p-3");
      expect(padded?.textContent).toContain("import numpy");
    });
  });
});
