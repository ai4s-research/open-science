import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Composer } from "./Composer";
import { addFilesToWorkspace, discardWorkspaceFile } from "@/lib/tauri";

// Desktop-only attach behaviors, with the Tauri bridge mocked out.
vi.mock("@/lib/tauri", () => ({
  isTauri: true,
  // The picker COPIED this one in, so the composer owns it; a drop of a file
  // that was already in the workspace is referenced in place and is not ours.
  addFilesToWorkspace: vi.fn(async () => [{ name: "data.csv", copied: true }]),
  addTextToWorkspace: vi.fn(async () => "pasted.txt"),
  addBinaryToWorkspace: vi.fn(async (filename: string) => filename),
  addPathsToWorkspace: vi.fn(async () => [{ name: "dropped.csv", copied: false }]),
  discardWorkspaceFile: vi.fn(async () => {}),
  logDebug: vi.fn(async () => {}),
}));

// The preview card reads the file; nothing here is about what it shows.
vi.mock("@/lib/artifactFile", () => ({
  previewUrl: vi.fn(async () => null),
  readArtifact: vi.fn(async () => null),
  absoluteArtifactPath: vi.fn(async () => null),
}));

// The composer subscribes to the webview's native drag-drop event on mount.
// Without a Tauri runtime `getCurrentWebview()` throws — stub it so the effect
// subscribes cleanly instead of leaving an unhandled rejection.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => () => {}) }),
}));

describe("Composer attachments (desktop)", () => {
  // The bridge mocks are module-level; only the call records reset per test.
  beforeEach(() => vi.clearAllMocks());

  it("adds picked files as removable chips and sends them as a file note", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);

    fireEvent.click(screen.getByLabelText("Add files"));
    await waitFor(() => expect(screen.getByText("data.csv")).toBeTruthy());

    // Chip is outside the textarea — typing text is independent of the file.
    const input = screen.getByLabelText("Ask anything");
    fireEvent.change(input, { target: { value: "analyze this" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // The note names the workspace copy; the chip list rides along so the send
    // can also attach the images as real multimodal parts (#88).
    expect(onSend).toHaveBeenCalledWith(
      "analyze this\n\nFiles added to the workspace: data.csv",
      ["data.csv"],
    );
    // Chips are cleared after sending.
    expect(screen.queryByText("data.csv")).toBeNull();
  });

  it("removes a chip via its X button without touching the text", async () => {
    render(<Composer onSend={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Add files"));
    await waitFor(() => expect(screen.getByText("data.csv")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Remove data.csv"));
    expect(screen.queryByText("data.csv")).toBeNull();
  });

  it("turns an oversized paste into a workspace file chip, keeping the box clean", async () => {
    render(<Composer onSend={vi.fn()} />);
    const input = screen.getByLabelText("Ask anything") as HTMLTextAreaElement;

    fireEvent.paste(input, {
      clipboardData: { getData: () => "x".repeat(3000) },
    });
    await waitFor(() => expect(screen.getByText("pasted.txt")).toBeTruthy());
    expect(input.value).toBe("");

    // A short paste stays a normal paste (no new chip).
    fireEvent.paste(input, { clipboardData: { getData: () => "short text" } });
    expect(screen.getAllByText("pasted.txt")).toHaveLength(1);
  });

  it("turns a pasted image (screenshot) into an image file chip", async () => {
    render(<Composer onSend={vi.fn()} />);
    const input = screen.getByLabelText("Ask anything") as HTMLTextAreaElement;

    // A clipboard image item, as macOS/Windows/Linux webviews expose it.
    fireEvent.paste(input, {
      clipboardData: {
        getData: () => "",
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
          },
        ],
      },
    });
    await waitFor(() => expect(screen.getByText("pasted.png")).toBeTruthy());
    expect(input.value).toBe(""); // the image never lands as text
  });

  it("attaches a file copied in a file manager instead of typing its text", async () => {
    render(<Composer onSend={vi.fn()} />);
    const input = screen.getByLabelText("Ask anything") as HTMLTextAreaElement;

    // Copying a .md in Finder puts a FILE on the clipboard (plus a text/plain
    // fallback). Only the bitmap branch existed, so the fallback used to land
    // in the box as a string.
    fireEvent.paste(input, {
      clipboardData: {
        getData: () => "/Users/me/notes.md",
        items: [
          {
            kind: "file",
            type: "text/markdown",
            getAsFile: () => new File(["# Notes"], "notes.md", { type: "text/markdown" }),
          },
        ],
      },
    });

    await waitFor(() => expect(screen.getByText("notes.md")).toBeTruthy());
    expect(input.value).toBe("");
  });

  it("deletes a file it copied in when the chip goes, and never one it only referenced", async () => {
    render(<Composer onSend={vi.fn()} />);

    fireEvent.click(screen.getByLabelText("Add files"));
    await waitFor(() => expect(screen.getByText("data.csv")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Remove data.csv"));
    expect(discardWorkspaceFile).toHaveBeenCalledWith("data.csv");
  });

  it("stops owning a file once it has been sent", async () => {
    // Send `data.csv`, then attach a file of the same name that was ALREADY in
    // the workspace. Ownership that outlived the send would delete it.
    render(<Composer onSend={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Add files"));
    await waitFor(() => expect(screen.getByText("data.csv")).toBeTruthy());
    const input = screen.getByLabelText("Ask anything");
    fireEvent.change(input, { target: { value: "go" } });
    fireEvent.keyDown(input, { key: "Enter" });

    vi.mocked(addFilesToWorkspace).mockResolvedValueOnce([{ name: "data.csv", copied: false }]);
    fireEvent.click(screen.getByLabelText("Add files"));
    await waitFor(() => expect(screen.getByText("data.csv")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Remove data.csv"));

    expect(discardWorkspaceFile).not.toHaveBeenCalled();
  });

  it("leaves a file that was already in the workspace exactly where it is", async () => {
    // Attaching a workspace file references it in place (`copied: false`).
    // Deleting one of those on an X click would destroy the user's own data —
    // the reason the backend reports what it copied instead of the frontend
    // guessing from a bare name.
    vi.mocked(addFilesToWorkspace).mockResolvedValueOnce([{ name: "existing.csv", copied: false }]);
    render(<Composer onSend={vi.fn()} />);

    fireEvent.click(screen.getByLabelText("Add files"));
    await waitFor(() => expect(screen.getByText("existing.csv")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Remove existing.csv"));

    expect(screen.queryByText("existing.csv")).toBeNull(); // chip still goes
    expect(discardWorkspaceFile).not.toHaveBeenCalledWith("existing.csv");
  });
});
