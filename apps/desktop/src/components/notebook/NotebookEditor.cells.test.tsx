// Selecting a cell and inserting around it (#93): before this, the only way to
// add a cell was the button at the bottom, which always appended to the END,
// and no keyboard shortcut reached the notebook at all.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NotebookEditor } from "./NotebookEditor";

const NOTEBOOK = JSON.stringify({
  cells: ["one", "two", "three"].map((s) => ({
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

const codeCells = () =>
  screen.getAllByRole("textbox").map((el) => (el as HTMLTextAreaElement).value);

async function open() {
  render(<NotebookEditor path="analysis.ipynb" />);
  await screen.findByLabelText("Cell 1");
}

describe("NotebookEditor · selecting a cell and inserting around it", () => {
  it("inserts above the chosen cell, not at the end", async () => {
    await open();
    await userEvent.click(screen.getByLabelText("Insert cell above 2"));
    expect(codeCells()).toEqual(["one", "", "two", "three"]);
  });

  it("inserts below the chosen cell, not at the end", async () => {
    await open();
    await userEvent.click(screen.getByLabelText("Insert cell below 1"));
    expect(codeCells()).toEqual(["one", "", "two", "three"]);
  });

  it("renumbers so the [n] labels stay in reading order", async () => {
    await open();
    await userEvent.click(screen.getByLabelText("Insert cell above 1"));
    // The new cell is [1] and everything below it shifted down by one.
    expect(screen.getByLabelText("Cell 1")).toHaveValue("");
    expect(screen.getByLabelText("Cell 4")).toHaveValue("three");
  });

  it("Esc then a/b inserts around the selected cell (Jupyter's command mode)", async () => {
    await open();
    await userEvent.click(screen.getByLabelText("Cell 2"));
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("a");
    expect(codeCells()).toEqual(["one", "", "two", "three"]);

    // Still in command mode, so the next key drives the notebook too.
    await userEvent.keyboard("b");
    expect(codeCells()).toEqual(["one", "", "", "two", "three"]);
  });

  it("keeps typing into the cell while in edit mode ('a' is just an 'a')", async () => {
    await open();
    await userEvent.click(screen.getByLabelText("Cell 2"));
    await userEvent.keyboard("ab");
    // No cell was inserted — the keys were text. (Where they land depends on the
    // caret, which a click sets from the click position.)
    expect(codeCells()).toHaveLength(3);
    expect((screen.getByLabelText("Cell 2") as HTMLTextAreaElement).value).toContain("ab");
  });

  it("moves the selection with j/k and Enter returns to editing", async () => {
    await open();
    await userEvent.click(screen.getByLabelText("Cell 1"));
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("j"); // down to cell 2
    await userEvent.keyboard("{Enter}"); // back into the text
    await userEvent.keyboard("!");
    expect(codeCells()).toEqual(["one", "two!", "three"]);
  });

  it("deleting a cell keeps a neighbour selected and renumbers", async () => {
    await open();
    await userEvent.click(screen.getByLabelText("Delete cell 2"));
    expect(codeCells()).toEqual(["one", "three"]);
    // The cell that slid into slot 2 is selected, so a/b act on it.
    await userEvent.keyboard("a");
    expect(codeCells()).toEqual(["one", "", "three"]);
  });
});
