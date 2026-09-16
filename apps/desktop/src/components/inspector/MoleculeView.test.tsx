import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoleculeView } from "./MoleculeView";

// 3Dmol needs WebGL, which jsdom lacks — mock it and assert the wiring
// (model handed over with the right format, styles applied on toggle).
const viewer = {
  setBackgroundColor: vi.fn(),
  addModel: vi.fn(),
  setStyle: vi.fn(),
  zoomTo: vi.fn(),
  zoom: vi.fn(),
  rotate: vi.fn(),
  render: vi.fn(),
  resize: vi.fn(),
  clear: vi.fn(),
  selectedAtoms: vi.fn(() => [{}, {}, {}]),
};
const createViewer = vi.fn(() => viewer);
vi.mock("3dmol", () => ({ createViewer: () => createViewer() }));

// jsdom has no WebGL, and the component now refuses to build a viewer without
// one — so stand in for the context a real WebView hands over. A test that
// wants the no-WebGL path overrides this again.
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("MoleculeView", () => {
  it("hands a PDB's raw text to 3Dmol as a pdb model and reports atom count", async () => {
    render(<MoleculeView filename="1abc.pdb" text={"ATOM  1  C   LIG\nATOM  2  O   LIG"} />);
    await waitFor(() => expect(viewer.addModel).toHaveBeenCalled());
    expect(viewer.addModel).toHaveBeenCalledWith(expect.stringContaining("ATOM"), "pdb");
    expect(await screen.findByText("3 atoms")).toBeInTheDocument();
    expect(screen.getByText("PDB")).toBeInTheDocument();
  });

  it("converts a SMILES file to a coordinate-bearing model before rendering", async () => {
    render(<MoleculeView filename="mols.smi" text="CCO ethanol" />);
    await waitFor(() => expect(viewer.addModel).toHaveBeenCalled());
    const [model, format] = viewer.addModel.mock.calls[0];
    expect(format).toBe("sdf");
    // openchemlib laid out real coordinates (not the raw SMILES string).
    expect(model).not.toContain("CCO ethanol");
    expect(model).toMatch(/-?\d+\.\d{3,}/);
  });

  it("re-applies the style when the user switches render mode", async () => {
    render(<MoleculeView filename="ligand.mol" text="mol" />);
    await waitFor(() => expect(viewer.setStyle).toHaveBeenCalled());
    viewer.setStyle.mockClear();

    await userEvent.click(screen.getByRole("button", { name: "Sphere" }));
    await waitFor(() =>
      expect(viewer.setStyle).toHaveBeenCalledWith({}, expect.objectContaining({ sphere: expect.anything() })),
    );
  });

  it("offers Cartoon only for macromolecules (small molecules lack residues)", async () => {
    const { rerender } = render(<MoleculeView filename="ligand.mol" text="small molecule" />);
    await waitFor(() => expect(viewer.addModel).toHaveBeenCalled());
    // A small molecule: cartoon would crash 3Dmol on missing resn, so it's hidden.
    expect(screen.queryByRole("button", { name: "Cartoon" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stick" })).toBeInTheDocument();

    // A protein (many alpha carbons) gets the cartoon option.
    const protein = Array.from({ length: 25 }, (_, i) => `ATOM  ${i} CA  ALA`).join("\n");
    rerender(<MoleculeView filename="1abc.pdb" text={protein} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Cartoon" })).toBeInTheDocument());
  });

  // A WebView that returns no WebGL context used to reach 3Dmol, which
  // dereferenced the null context and threw its raw `this._gl.clearDepth`
  // TypeError at the user (#143, WebKitGTK on Linux).
  it("explains a missing WebGL context instead of letting 3Dmol throw", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    render(<MoleculeView filename="feh2o.xyz" text={"1\ncomment\nFe 0.0 0.0 0.0"} />);
    expect(await screen.findByText(/WebGL/)).toBeInTheDocument();
    expect(createViewer).not.toHaveBeenCalled();
  });

  it("explains a SMILES file with no parseable structures", async () => {
    render(<MoleculeView filename="empty.smi" text={"   \n# comment\n"} />);
    expect(await screen.findByText(/No chemical structures found/)).toBeInTheDocument();
    expect(viewer.addModel).not.toHaveBeenCalled();
  });
});
