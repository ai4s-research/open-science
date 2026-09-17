import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactBlock } from "@ai4s/shared";

// The real preview reads the file off disk through the inspector stack; this
// test is about the chrome around it, so it stands in for the content.
// The real preview reads the file off disk through the inspector stack. The
// stand-in keeps the two things this test is about: the header slot the fold and
// full-screen controls ride on, and a body that `collapsed` hides.
vi.mock("@/components/inspector/FilePreviewInspector", () => ({
  FilePreviewInspector: ({
    controls,
    collapsed,
    title,
  }: {
    controls?: React.ReactNode;
    collapsed?: boolean;
    title?: string;
  }) => (
    <div>
      <header>
        <span>{title}</span>
        {controls}
      </header>
      {!collapsed && <div data-testid="preview">chart</div>}
    </div>
  ),
}));

const { InlineArtifact } = await import("./InlineArtifact");

const block: ArtifactBlock = {
  kind: "artifact",
  path: "demo_analysis/figure1.png",
  filename: "figure1.png",
  artifact: "figure",
  tool: "write",
  presentation: { mode: "inline", title: "Dose–response fit (figure1.png)" },
};

describe("InlineArtifact", () => {
  it("folds from the card's own header, which stays put", async () => {
    render(<InlineArtifact block={block} />);
    expect(screen.getByTestId("preview")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Collapse" }));
    // Folded: the header stays, because it carries the control that unfolds it.
    expect(screen.queryByTestId("preview")).not.toBeInTheDocument();
    expect(screen.getByText("Dose–response fit (figure1.png)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Expand" }));
    expect(screen.getByTestId("preview")).toBeInTheDocument();
  });

  it("puts both controls on the preview's header, not on a second title bar", async () => {
    // A row of my own above the card said the filename twice.
    render(<InlineArtifact block={block} />);
    const header = screen.getAllByRole("banner")[0];
    expect(header).toContainElement(screen.getByRole("button", { name: "Maximize" }));
    expect(header).toContainElement(screen.getByRole("button", { name: "Collapse" }));
  });

  it("opens full-screen, and Escape closes it", async () => {
    render(<InlineArtifact block={block} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Maximize" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // The reader's hands are on the keyboard, not aiming at a close button.
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("caps its height instead of fixing it, so short content scrolls nothing", () => {
    // The fixed `h-[min(460px,58vh)]` made every preview a nested scroller, and
    // WebKit latches the wheel to the innermost one — the scroll conflict.
    const { container } = render(<InlineArtifact block={block} />);
    const box = container.querySelector('[class*="max-h-"]');
    expect(box).toBeTruthy();
    expect(box!.className).not.toMatch(/(^|\s)h-\[/);
  });
});
