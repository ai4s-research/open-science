import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** #157 Part E: a streaming message renders as sealed segments + live tail.
 *  The memoization contract is counted at the MarkdownViewer boundary: a
 *  sealed segment's viewer must run EXACTLY ONCE, no matter how many tokens
 *  arrive later. (DOM node identity cannot prove this — a re-render with
 *  identical output leaves the same nodes behind.) */
const { viewerRenders } = vi.hoisted(() => ({ viewerRenders: [] as string[] }));
vi.mock("@/components/markdown-viewer/MarkdownViewer", () => ({
  MarkdownViewer: ({ children }: { children: string }) => {
    viewerRenders.push(children);
    return <div data-md>{children}</div>;
  },
}));

import { AgentMessage } from "./atoms";

const SEG1 = "First paragraph is done.\n\n";

describe("AgentMessage streaming segments (#157)", () => {
  beforeEach(() => {
    viewerRenders.length = 0;
  });

  it("re-renders only the live tail while tokens keep arriving", async () => {
    const full = "First paragraph is done.\n\nSecond one types more.\n\nThird";
    const { container, rerender } = render(
      <AgentMessage markdown={"First paragraph is done.\n\nSecond one types"} />,
    );
    expect(container.querySelector("[data-sealed-segment]")!.textContent).toContain(
      "First paragraph is done.",
    );
    expect(viewerRenders.filter((t) => t === SEG1)).toHaveLength(1);

    rerender(<AgentMessage markdown={full} />);
    await waitFor(() => {
      expect(container.querySelector("[data-agent-message]")!.textContent).toContain("Third");
    });

    // The memo contract: the sealed segment never rendered again, and no
    // render ever re-parsed the whole message as one viewer.
    expect(viewerRenders.filter((t) => t === SEG1)).toHaveLength(1);
    expect(viewerRenders.filter((t) => t === full)).toHaveLength(0);
  });

  it("a finished message renders as one viewer with no segments", () => {
    const full = "First paragraph.\n\nSecond paragraph.";
    const { container } = render(<AgentMessage markdown={full} completed={1_700_000_000_000} />);
    expect(container.querySelector("[data-sealed-segment]")).toBeNull();
    expect(viewerRenders.length).toBeGreaterThan(0);
    expect(new Set(viewerRenders)).toEqual(new Set([full]));
  });
});
