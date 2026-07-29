// A hung cell must be stoppable from the UI (P0-7 acceptance: a
// `while True: pass` cell can be reset without restarting the app).
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotebookEditor } from "./NotebookEditor";

const mocks = vi.hoisted(() => ({
  kernelExecute: vi.fn(),
  kernelReset: vi.fn(),
  writeWorkspaceFile: vi.fn(),
}));

const NOTEBOOK = JSON.stringify({
  cells: [{ cell_type: "code", source: ["while True: pass"], outputs: [] }],
  metadata: { kernelspec: { name: "python3", language: "python" } },
  nbformat: 4,
  nbformat_minor: 5,
});

vi.mock("@/lib/artifactFile", () => ({
  readArtifact: async () => ({ encoding: "utf8", data: NOTEBOOK }),
  writeWorkspaceFile: (...args: unknown[]) => mocks.writeWorkspaceFile(...args),
}));
vi.mock("@/lib/kernel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/kernel")>();
  return {
    ...actual,
    kernelExecute: (...args: unknown[]) => mocks.kernelExecute(...args),
    kernelReset: (...args: unknown[]) => mocks.kernelReset(...args),
  };
});
vi.mock("@/components/inspector/ProvenancePanel", () => ({
  ProvenancePanel: () => null,
}));

describe("NotebookEditor · stopping a hung cell", () => {
  beforeEach(() => {
    mocks.kernelExecute.mockReset();
    mocks.kernelReset.mockReset();
    mocks.writeWorkspaceFile.mockReset().mockResolvedValue(undefined);
  });

  it("a running cell shows Stop; clicking it resets the kernel and marks the cell interrupted", async () => {
    // The cell hangs until the kernel is killed — exactly the real backend
    // contract: kernel_reset makes the blocked execute fail with an error.
    let rejectExec: (e: Error) => void = () => {};
    mocks.kernelExecute.mockImplementation(
      () => new Promise((_, reject) => (rejectExec = reject)),
    );
    mocks.kernelReset.mockImplementation(async () => {
      rejectExec(new Error("kernel exited unexpectedly"));
    });

    render(<NotebookEditor path="analysis.ipynb" />);
    await userEvent.click(await screen.findByLabelText("Run cell 1"));

    // While running, the cell offers Stop (and it is clickable).
    const stop = await screen.findByLabelText("Stop cell 1");
    await userEvent.click(stop);

    // Stop resets exactly THIS notebook's kernel…
    expect(mocks.kernelReset).toHaveBeenCalledWith("python", "analysis.ipynb", undefined);
    // …and the cell reports the interruption, not a raw kernel error.
    expect(await screen.findByText(/Interrupted — the kernel was restarted/)).toBeInTheDocument();
    // The cell is runnable again.
    expect(await screen.findByLabelText("Run cell 1")).toBeInTheDocument();
  });

  it("a genuine kernel crash still reports the error, not an interruption", async () => {
    mocks.kernelExecute.mockRejectedValue(new Error("kernel exited unexpectedly"));
    render(<NotebookEditor path="analysis.ipynb" />);
    await userEvent.click(await screen.findByLabelText("Run cell 1"));
    expect(await screen.findByText(/kernel error: kernel exited unexpectedly/)).toBeInTheDocument();
  });
});

describe("NotebookEditor · autosave", () => {
  beforeEach(() => {
    mocks.kernelExecute.mockReset();
    mocks.kernelReset.mockReset();
    mocks.writeWorkspaceFile.mockReset();
  });

  it("persists a newer edit made while the previous save is still in flight", async () => {
    let finishFirstSave: () => void = () => {};
    let finishSecondSave: () => void = () => {};
    mocks.writeWorkspaceFile
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => {
          finishFirstSave = resolve;
        }),
      )
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => {
          finishSecondSave = resolve;
        }),
      );

    render(<NotebookEditor path="analysis.ipynb" />);
    const cell = await screen.findByLabelText("Cell 1");

    fireEvent.change(cell, { target: { value: "first edit" } });
    await waitFor(() => expect(mocks.writeWorkspaceFile).toHaveBeenCalledTimes(1));

    // The first disk write is still pending when the user types again.
    fireEvent.change(cell, { target: { value: "second edit" } });
    expect(screen.getByText("Unsaved")).toBeInTheDocument();

    await act(async () => finishFirstSave());

    // The old write must not mark the newer state as saved or cancel it.
    await waitFor(() => expect(mocks.writeWorkspaceFile).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
    const secondNotebook = JSON.parse(String(mocks.writeWorkspaceFile.mock.calls[1][1]));
    expect(secondNotebook.cells[0].source).toBe("second edit");

    await act(async () => finishSecondSave());
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
  });

  it("never runs two notebook writes concurrently", async () => {
    let finishFirstSave: () => void = () => {};
    let finishSecondSave: () => void = () => {};
    mocks.writeWorkspaceFile
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => {
          finishFirstSave = resolve;
        }),
      )
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => {
          finishSecondSave = resolve;
        }),
      );

    render(<NotebookEditor path="analysis.ipynb" />);
    const cell = await screen.findByLabelText("Cell 1");

    fireEvent.change(cell, { target: { value: "first edit" } });
    await waitFor(() => expect(mocks.writeWorkspaceFile).toHaveBeenCalledTimes(1));
    fireEvent.change(cell, { target: { value: "second edit" } });

    // Let the second debounce expire while the first write is blocked.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(mocks.writeWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Unsaved")).toBeInTheDocument();

    await act(async () => finishFirstSave());
    await waitFor(() => expect(mocks.writeWorkspaceFile).toHaveBeenCalledTimes(2));
    const secondNotebook = JSON.parse(String(mocks.writeWorkspaceFile.mock.calls[1][1]));
    expect(secondNotebook.cells[0].source).toBe("second edit");

    await act(async () => finishSecondSave());
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
  });
});
