import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
  };
});

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
