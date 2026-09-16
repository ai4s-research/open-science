// A cell that is running, and a cell that has run.
//
// The reported failure: running a cell left it showing "running…" for ever.
// The cause was that "running…" was an OUTPUT — autosave wrote it into the
// .ipynb, so any interruption (a kernel that never answered, the pane closing)
// left a notebook whose file said the cell was running, with nothing able to
// clear it.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { NotebookEditor } from "./NotebookEditor";

const NOTEBOOK = JSON.stringify({
  cells: [{ cell_type: "code", source: ["import pandas"], outputs: [] }],
  metadata: { kernelspec: { name: "python3", language: "python" } },
  nbformat: 4,
  nbformat_minor: 5,
});

const written: string[] = [];
vi.mock("@/lib/artifactFile", () => ({
  readArtifact: async () => ({ encoding: "utf8", data: NOTEBOOK }),
  writeWorkspaceFile: async (_path: string, out: string) => {
    written.push(out);
  },
}));
vi.mock("@/components/inspector/ProvenancePanel", () => ({ ProvenancePanel: () => null }));

/** A kernel whose answer the test hands back, so a run can be held open. */
let settle: ((value: unknown) => void) | undefined;
const kernelExecute = vi.fn();
const kernelReset = vi.fn(async () => {});
vi.mock("@/lib/kernel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/kernel")>()),
  kernelExecute: (...args: unknown[]) => kernelExecute(...args),
  kernelReset: () => kernelReset(),
}));

const marker = () => screen.getByTitle(/Execution count/).textContent;

async function open() {
  render(<NotebookEditor path="analysis.ipynb" />);
  await screen.findByLabelText("Cell 1");
}

describe("a notebook cell that is running", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    written.length = 0;
    kernelReset.mockClear();
    kernelExecute.mockReset();
    kernelExecute.mockImplementation(() => new Promise((resolve) => (settle = resolve)));
  });

  it("shows [*] while it runs, and never writes that state into the file", async () => {
    await open();
    await userEvent.click(screen.getByLabelText("Run cell 1"));

    await waitFor(() => expect(marker()).toBe("[*]"));
    // Whatever autosave has written so far, none of it may claim the cell is
    // running — that is what survived a restart and looked stuck.
    await waitFor(() => expect(kernelExecute).toHaveBeenCalled());
    expect(written.join("")).not.toContain("running");
  });

  it("marks the cell with its execution count once it has run", async () => {
    await open();
    await userEvent.click(screen.getByLabelText("Run cell 1"));
    await waitFor(() => expect(marker()).toBe("[*]"));

    settle!({ ok: true, stdout: "", result: null, error: null });

    // An import prints nothing. The `[1]` is the only thing that says it ran —
    // the output pane used to say "(no output)", which read as a failure.
    await waitFor(() => expect(marker()).toBe("[1]"));
    expect(screen.queryByText("(no output)")).not.toBeInTheDocument();
  });

  it("recovers when Stop is pressed and the kernel never answers", async () => {
    await open();
    await userEvent.click(screen.getByLabelText("Run cell 1"));
    await waitFor(() => expect(marker()).toBe("[*]"));

    // The execute promise is deliberately left unsettled: a killed kernel that
    // never replies. Stop must still return the notebook to a usable state,
    // or the guard in `run` refuses every later cell until the app restarts.
    await userEvent.click(screen.getByLabelText("Stop cell 1"));

    await waitFor(() => expect(kernelReset).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByLabelText("Run cell 1")).toBeEnabled());
  });

  it("clears the previous output when a cell is re-run, as Jupyter does", async () => {
    await open();
    await userEvent.click(screen.getByLabelText("Run cell 1"));
    settle!({ ok: true, stdout: "first\n", result: null, error: null });
    await waitFor(() => expect(screen.getByText("first")).toBeInTheDocument());

    await userEvent.click(screen.getByLabelText("Run cell 1"));

    await waitFor(() => expect(screen.queryByText("first")).not.toBeInTheDocument());
  });
});
