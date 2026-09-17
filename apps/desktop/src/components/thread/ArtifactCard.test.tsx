import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { ArtifactBlock } from "@ai4s/shared";
import { ArtifactCard } from "./ArtifactCard";

const block: ArtifactBlock = {
  kind: "artifact",
  path: "sessions/demo/run_analysis.py",
  filename: "run_analysis.py",
  artifact: "script",
  tool: "edit",
};

describe("ArtifactCard", () => {
  it("gives the free width to the filename, not to a spacer", () => {
    // The row used to carry TWO flex-1 children — the name and a bare spacer
    // `<div>` — so the slack was split between them and the kind badge and
    // "via edit" ended up parked mid-card with dead space either side.
    const { container } = render(<ArtifactCard block={block} onOpen={() => {}} />);
    const row = container.firstElementChild!;
    const growers = [...row.querySelectorAll("*")].filter((el) =>
      el.className.toString().split(/\s+/).includes("flex-1"),
    );
    expect(growers).toHaveLength(1);
    expect(growers[0].textContent).toContain("run_analysis.py");
  });

  it("clicks through to the handler once per click", async () => {
    const onOpen = vi.fn();
    render(<ArtifactCard block={block} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(block);
  });
});
