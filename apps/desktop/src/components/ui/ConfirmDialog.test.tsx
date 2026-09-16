import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PaneScope } from "@/components/session/PaneScope";
import { ConfirmDialog } from "./ConfirmDialog";

function ask(scope?: "window" | "pane") {
  return (
    <ConfirmDialog
      title="Compact the context?"
      body="The full conversation stays on disk."
      confirmLabel="Compact"
      scope={scope}
      onConfirm={() => {}}
      onCancel={() => {}}
    />
  );
}

/** A tiled pane: the element `scope="pane"` is supposed to land inside. */
function InPane({ children }: { children: React.ReactNode }) {
  return (
    <PaneScope>
      {(ref) => (
        <div ref={ref} data-testid="pane" className="relative">
          {/* Positioned boxes on the way down — the composer is one — which an
              `absolute` overlay would otherwise resolve against. */}
          <div className="relative">{children}</div>
        </div>
      )}
    </PaneScope>
  );
}

describe("a confirmation the reader has to place", () => {
  it("covers the whole window by default", () => {
    render(ask());
    expect(screen.getByRole("presentation")).toHaveClass("fixed");
  });

  it("covers only the pane that asked", () => {
    render(<InPane>{ask("pane")}</InPane>);

    const overlay = screen.getByRole("presentation");
    expect(overlay).toHaveClass("absolute");
    // Portalled to the PANE, not left where it was written: every box between
    // the two is a candidate for `position: relative`, and an overlay resolving
    // against the composer would cover a 60px strip instead of the pane.
    expect(screen.getByTestId("pane")).toContainElement(overlay);
    expect(overlay.parentElement).toBe(screen.getByTestId("pane"));
  });

  it("falls back to the window when there is no pane to sit in", () => {
    // A route, a settings page: `scope="pane"` must not leave the question
    // unplaced.
    render(ask("pane"));
    expect(screen.getByRole("presentation")).toHaveClass("fixed");
  });
});
