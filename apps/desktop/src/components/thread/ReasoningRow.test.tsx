import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReasoningRow } from "./ReasoningRow";

const block = { kind: "reasoning" as const, text: "checking the dataset shape" };
const long = {
  kind: "reasoning" as const,
  text: "checking the dataset shape\nit is 3 columns wide\nso the join key is missing",
};

describe("ReasoningRow", () => {
  it("shows what the model said, whole, as ordinary prose", () => {
    // It is the narration a reader follows, so it reads like the rest of the
    // conversation: full text, no summary line, no card, nothing to expand.
    const { container } = render(<ReasoningRow block={long} />);
    expect(container.textContent).toContain("checking the dataset shape");
    expect(container.textContent).toContain("so the join key is missing");
  });

  it("is not a control — clicking a sentence must not fold it away", () => {
    // Click-to-collapse meant selecting a line pulled the paragraph out from
    // under the cursor. What hides finished work is the TURN fold, not this.
    render(<ReasoningRow block={long} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("reads in the conversation's own colour, not a muted aside", () => {
    const { container } = render(<ReasoningRow block={block} />);
    expect(container.querySelector("p")).toHaveClass("text-text");
  });

  it("marks the thought being written with a caret and nothing else", () => {
    const { container } = render(<ReasoningRow block={long} streaming />);
    // Same text, same layout — text that reflows differently as it arrives is
    // harder to follow than text that does not.
    expect(container.textContent).toContain("so the join key is missing");
  });

  it("renders nothing for an empty thought", () => {
    const { container } = render(<ReasoningRow block={{ kind: "reasoning", text: "  " }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
