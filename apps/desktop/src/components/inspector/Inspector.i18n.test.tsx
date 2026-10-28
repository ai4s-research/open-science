import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ArtifactInspector as ArtifactInspectorT,
  NotebookInspector as NotebookInspectorT,
  FilePreviewInspector as FilePreviewInspectorT,
  PdfInspector as PdfInspectorT,
} from "@ai4s/shared";
import { useUiStore } from "@/lib/store";
import { ArtifactInspector } from "./ArtifactInspector";
import { NotebookInspector } from "./NotebookInspector";
import { FilePreviewInspector } from "./FilePreviewInspector";
import { PdfInspector } from "./PdfInspector";
import { ProvenancePanel } from "./ProvenancePanel";
import { TablePreview } from "./TablePreview";
import { MaximizePaneButton, RightPane } from "./RightPane";

// ProvenancePanel talks to the real provenance store by default (via
// listProvenance); mocked here only so one test can hold it pending to assert
// the loading state — every other test lets it resolve immediately to [].
const listProvenance = vi.fn();
vi.mock("@/lib/provenance", () => ({
  listProvenance: (path: string) => listProvenance(path),
  readEnvLockfile: vi.fn(),
}));

// COPYCAT RULE: useUiStore is module-global; reset the locale after each test
// so this suite never bleeds a non-English locale into other test files.
afterEach(() => useUiStore.getState().setLocale("en"));

describe("ArtifactInspector strings (i18n)", () => {
  const data: ArtifactInspectorT = {
    variant: "artifact",
    title: "trend.py",
    versions: [{ label: "v1" }],
    activeVersion: "v1",
    inputs: ["raw.csv"],
    code: "print(1)",
    language: "python",
  };

  it("renders the header controls and tab labels in English", () => {
    render(<ArtifactInspector data={data} onClose={() => {}} />);
    expect(screen.getByLabelText("Previous version")).toBeInTheDocument();
    expect(screen.getByLabelText("Next version")).toBeInTheDocument();
    expect(screen.getByLabelText("Download")).toBeInTheDocument();
    expect(screen.getByLabelText("Close inspector")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Code" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Execution Log" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Messages" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Environment" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
    expect(screen.getByText("Download script")).toBeInTheDocument();
    expect(screen.getByText("Inputs")).toBeInTheDocument();
  });

  it("renders the empty and not-yet-reviewed states for each tab in English", async () => {
    render(<ArtifactInspector data={data} onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Execution Log" }));
    expect(screen.getByText("No execution log.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Messages" }));
    expect(screen.getByText("No messages for this version.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Environment" }));
    expect(screen.getByText("No environment info.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("v1 has not passed review yet.")).toBeInTheDocument();
  });

  it("renders the review-passed state in English", async () => {
    render(<ArtifactInspector data={{ ...data, reviewPassed: true }} onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("Review passed — v1 traces to code and inputs.")).toBeInTheDocument();
  });
});

describe("NotebookInspector strings (i18n)", () => {
  const data: NotebookInspectorT = {
    variant: "notebook",
    name: "analysis.ipynb",
    live: true,
    kernelLabel: "Python 3.12",
    kernelNote: "Runs locally.",
    cells: [],
  };

  it("renders the header, live badge, and input affordances in English", () => {
    render(<NotebookInspector data={data} onClose={() => {}} />);
    expect(screen.getByText("Notebook")).toBeInTheDocument();
    expect(screen.getByText("Shared with the agent")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Type an expression and press Enter")).toBeInTheDocument();
    expect(screen.getByLabelText("Notebook expression")).toBeInTheDocument();
    expect(screen.getByLabelText("Run expression")).toBeInTheDocument();
    expect(screen.getByLabelText("Close inspector")).toBeInTheDocument();
  });
});

describe("FilePreviewInspector strings (i18n)", () => {
  it("renders the artifact-kind badge and header controls, falling back to the desktop-app note", async () => {
    const data: FilePreviewInspectorT = {
      variant: "file",
      path: "data/train.csv",
      filename: "train.csv",
      artifact: "script",
    };
    render(<FilePreviewInspector data={data} onClose={() => {}} />);
    expect(screen.getByText("script")).toBeInTheDocument();
    expect(screen.getByLabelText("History")).toBeInTheDocument();
    expect(screen.getByLabelText("Open externally")).toBeInTheDocument();
    expect(screen.getByLabelText("Close inspector")).toBeInTheDocument();
    // No Tauri sidecar in tests — the csv read comes back empty, so the file
    // preview falls back to the "available in the desktop app" note.
    expect(await screen.findByText("Preview is available in the desktop app.")).toBeInTheDocument();
  });
});

describe("PdfInspector strings (i18n)", () => {
  it("renders the Close-inspector control in English", () => {
    const data: PdfInspectorT = {
      variant: "pdf",
      title: "review.pdf",
      doc: { title: "Review", sections: [] },
    };
    render(<PdfInspector data={data} onClose={() => {}} />);
    expect(screen.getByLabelText("Close inspector")).toBeInTheDocument();
  });
});

describe("ProvenancePanel strings (i18n)", () => {
  it("shows the loading state before history resolves", () => {
    listProvenance.mockReturnValueOnce(new Promise(() => {})); // never resolves in this test
    render(
      <MemoryRouter>
        <ProvenancePanel path="fig/plot.py" />
      </MemoryRouter>,
    );
    expect(screen.getByText("Loading history…")).toBeInTheDocument();
  });

  it("splits the empty-state sentence around the file path in English", async () => {
    listProvenance.mockResolvedValueOnce([]);
    render(
      <MemoryRouter>
        <ProvenancePanel path="does/not/exist.py" />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/No versions recorded yet\. Each time the agent writes/)).toBeInTheDocument();
    expect(
      screen.getByText(/, a version is added here with the code, model, and conversation that produced it\./),
    ).toBeInTheDocument();
  });
});

describe("TablePreview strings (i18n)", () => {
  it("pluralizes the truncated-rows note in English", () => {
    render(<TablePreview table={{ columns: ["a"], rows: [["1"]], truncated: true }} />);
    expect(screen.getByText("Showing the first 1 row")).toBeInTheDocument();
  });

  it("uses the plural form for more than one row", () => {
    render(<TablePreview table={{ columns: ["a"], rows: [["1"], ["2"], ["3"]], truncated: true }} />);
    expect(screen.getByText("Showing the first 3 rows")).toBeInTheDocument();
  });
});

describe("MaximizePaneButton strings (i18n)", () => {
  it("toggles the aria-label between Maximize panel and Restore panel in English", async () => {
    render(
      <RightPane paneId="pane-1" fill onClose={() => {}}>
        <MaximizePaneButton />
      </RightPane>,
    );
    expect(screen.getByLabelText("Maximize panel")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Maximize panel"));
    expect(screen.getByLabelText("Restore panel")).toBeInTheDocument();
    // Toggle back off so this test doesn't leak maximized state (module-global
    // store) into whichever test runs next.
    await userEvent.click(screen.getByLabelText("Restore panel"));
    expect(screen.getByLabelText("Maximize panel")).toBeInTheDocument();
  });
});
