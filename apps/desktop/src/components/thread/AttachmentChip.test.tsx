import { describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AttachmentChip } from "./AttachmentChip";

const previewUrl = vi.fn(async () => "http://127.0.0.1:1/t/w/pasted.png");
const readArtifact = vi.fn(async () => ({
  path: "notes.md",
  mime: "text/markdown",
  encoding: "utf8" as const,
  data: "# Title\nfirst line\nsecond line",
  size: 34,
}));

vi.mock("@/lib/artifactFile", () => ({
  previewUrl: (...args: unknown[]) => previewUrl(...(args as [])),
  readArtifact: (...args: unknown[]) => readArtifact(...(args as [])),
}));

// Radix renders the card twice — the visible one and a screen-reader copy —
// so every query here takes all matches and asserts on the first.
/** Radix opens a tooltip on focus with no delay; hover would need timers. */
const peek = async () => {
  await userEvent.tab();
  return waitFor(() => screen.getAllByRole("tooltip"));
};

beforeEach(() => {
  cleanup();
  previewUrl.mockClear();
  readArtifact.mockClear();
});

describe("AttachmentChip", () => {
  it("reads nothing until someone actually looks at the chip", () => {
    render(<AttachmentChip name="pasted.png" onRemove={() => {}} />);
    expect(previewUrl).not.toHaveBeenCalled();
    expect(readArtifact).not.toHaveBeenCalled();
  });

  it("shows a pasted image as the image itself, with its pixel size", async () => {
    render(<AttachmentChip name="pasted.png" onRemove={() => {}} />);
    await peek();

    const [img] = await screen.findAllByAltText("pasted.png");
    expect(img).toHaveAttribute("src", "http://127.0.0.1:1/t/w/pasted.png");
    // Until the picture decodes the line says the kind, so it is never blank.
    expect(screen.getAllByText("PNG")[0]).toBeInTheDocument();
    expect(readArtifact).not.toHaveBeenCalled(); // no base64 round-trip for an image
  });

  it("shows a text file's opening lines and how long it is", async () => {
    render(<AttachmentChip name="notes.md" onRemove={() => {}} />);
    await peek();

    expect((await screen.findAllByText(/first line/))[0]).toBeInTheDocument();
    expect(screen.getAllByText(/3 lines/)[0]).toBeInTheDocument();
    expect(previewUrl).not.toHaveBeenCalled();
  });

  it("says a file it cannot read is unreadable, and why", async () => {
    readArtifact.mockRejectedValueOnce(new Error("file too large to preview (>50 MB)"));
    render(<AttachmentChip name="huge.csv" onRemove={() => {}} />);
    await peek();

    expect((await screen.findAllByText("Can't read this file from the workspace"))[0]).toBeInTheDocument();
    // The runtime's own words, so a broken attachment is diagnosable from the UI.
    expect(screen.getAllByText(/file too large to preview/)[0]).toBeInTheDocument();
  });
});
