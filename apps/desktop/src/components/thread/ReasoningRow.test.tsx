import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReasoningRow } from "./ReasoningRow";

const block = { kind: "reasoning" as const, text: "checking the dataset shape" };
const long = {
  kind: "reasoning" as const,
  text: "checking the dataset shape\nit is 3 columns wide\nso the join key is missing",
};

describe("ReasoningRow", () => {
  it("types the line being written into the row while thinking", () => {
    render(<ReasoningRow block={long} streaming />);
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    // The tail, not the head: the row shows what the model is writing now.
    expect(screen.getByText("so the join key is missing")).toBeInTheDocument();
    expect(screen.queryByText(/it is 3 columns wide/)).not.toBeInTheDocument();
  });

  it("expands a streaming thought to the whole text", () => {
    render(<ReasoningRow block={long} streaming />);
    fireEvent.click(screen.getByText("Thinking…"));
    expect(screen.getByText(/it is 3 columns wide/)).toBeInTheDocument();
  });

  it("keeps the opening line as the summary once the thought settles", () => {
    render(<ReasoningRow block={long} />);
    expect(screen.getByText("Thought")).toBeInTheDocument();
    expect(screen.getByText("checking the dataset shape")).toBeInTheDocument();
    expect(screen.queryByText(/so the join key is missing/)).not.toBeInTheDocument();
  });

  it("a done thought expands on click", () => {
    render(<ReasoningRow block={block} />);
    fireEvent.click(screen.getByText("Thought"));
    expect(screen.getByText("checking the dataset shape")).toBeInTheDocument();
  });
});
