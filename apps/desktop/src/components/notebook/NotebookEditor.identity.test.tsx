// A cell's `index` is its stable identity (React key), NOT the number shown to
// the user — that comes from its position at render time. Renumbering on every
// structural edit changed the key of every cell below an insert, so React threw
// them away and rebuilt them; on a notebook with real outputs that is a freeze.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NotebookEditor } from "./NotebookEditor";

const NOTEBOOK = JSON.stringify({
  cells: ["one", "two", "three", "four"].map((s) => ({
    cell_type: "code",
    source: [s],
    outputs: [],
  })),
  metadata: { kernelspec: { name: "python3", language: "python" } },
  nbformat: 4,
  nbformat_minor: 5,
});

vi.mock("@/lib/artifactFile", () => ({
  readArtifact: async () => ({ encoding: "utf8", data: NOTEBOOK }),
  writeWorkspaceFile: async () => {},
}));
vi.mock("@/components/inspector/ProvenancePanel", () => ({ ProvenancePanel: () => null }));

const boxes = () => screen.getAllByRole("textbox") as HTMLTextAreaElement[];
const last = () => boxes()[boxes().length - 1]!;

describe("NotebookEditor · cell identity", () => {
  it("does not rebuild the cells below an insert", async () => {
    render(<NotebookEditor path="analysis.ipynb" />);
    await screen.findByLabelText("Cell 1");

    const before = last();
    expect(before.value).toBe("four");

    await userEvent.click(screen.getByLabelText("Insert cell above 1"));

    // Same DOM node, moved rather than destroyed and recreated.
    expect(last()).toBe(before);
    expect(last().value).toBe("four");
  });

  it("does not rebuild the survivors of a delete", async () => {
    render(<NotebookEditor path="analysis.ipynb" />);
    await screen.findByLabelText("Cell 1");

    const before = last();
    await userEvent.click(screen.getByLabelText("Delete cell 1"));

    expect(last()).toBe(before);
    expect(boxes().map((b) => b.value)).toEqual(["two", "three", "four"]);
  });

  it("keeps the [n] labels positional after inserting and deleting", async () => {
    render(<NotebookEditor path="analysis.ipynb" />);
    await screen.findByLabelText("Cell 1");

    await userEvent.click(screen.getByLabelText("Insert cell above 2"));
    await userEvent.click(screen.getByLabelText("Delete cell 4"));

    // Four cells, numbered 1..4 with no gaps, whatever the underlying ids are.
    expect(boxes()).toHaveLength(4);
    for (let i = 1; i <= 4; i++) {
      expect(screen.getByLabelText(`Cell ${i}`)).toBeInTheDocument();
    }
    expect(boxes().map((b) => b.value)).toEqual(["one", "", "two", "four"]);
  });

  it("survives a flurry of inserts, deletes, mode switches and typing", async () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => errors.push(a));

    render(<NotebookEditor path="analysis.ipynb" />);
    await screen.findByLabelText("Cell 1");

    for (let round = 0; round < 6; round++) {
      await userEvent.click(screen.getByLabelText("Cell 1"));
      await userEvent.keyboard("{Escape}");
      await userEvent.keyboard("bbaa"); // four inserts in command mode
      await userEvent.keyboard("jjkk"); // move around
      await userEvent.keyboard("{Enter}"); // into the text
      await userEvent.keyboard("x");
      await userEvent.keyboard("{Escape}");
      const del = screen.getAllByLabelText(/^Delete cell /);
      await userEvent.click(del[del.length - 1]!);
    }

    // Still coherent: contiguous positional labels, no runaway re-render.
    for (let i = 1; i <= boxes().length; i++) {
      expect(screen.getByLabelText(`Cell ${i}`)).toBeInTheDocument();
    }
    expect(errors.filter((e) => String(e).includes("Maximum update depth"))).toEqual([]);
    spy.mockRestore();
  }, 30000);
});
