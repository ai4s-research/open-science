import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Composer } from "./Composer";

// Desktop-only attach behaviors, with the Tauri bridge mocked out.
vi.mock("@/lib/tauri", () => ({
  isTauri: true,
  addFilesToWorkspace: vi.fn(async () => ["data.csv"]),
  addTextToWorkspace: vi.fn(async () => "pasted.txt"),
  addBinaryToWorkspace: vi.fn(async () => "pasted.png"),
  addPathsToWorkspace: vi.fn(async () => ["dropped.csv"]),
  logDebug: vi.fn(async () => {}),
}));

// The composer subscribes to the webview's native drag-drop event on mount.
// Without a Tauri runtime `getCurrentWebview()` throws — stub it so the effect
// subscribes cleanly instead of leaving an unhandled rejection.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => () => {}) }),
}));

describe("Composer attachments (desktop)", () => {
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
            type: "image/png",
            getAsFile: () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
          },
        ],
      },
    });
    await waitFor(() => expect(screen.getByText("pasted.png")).toBeTruthy());
    expect(input.value).toBe(""); // the image never lands as text
  });
});
