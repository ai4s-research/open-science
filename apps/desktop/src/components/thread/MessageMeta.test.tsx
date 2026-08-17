import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MessageUsage } from "@ai4s/shared";
import { renderBlock } from "./BlockList";

const usage = (over: Partial<MessageUsage> = {}): MessageUsage => ({
  input: 3_000,
  output: 900,
  reasoning: 0,
  cacheRead: 118_000,
  cacheWrite: 2_100,
  cost: 0.42,
  ...over,
});

const created = new Date("2026-07-29T12:00:00Z").getTime();

describe("agent message meta", () => {
  it("says how full the context is, so a conversation's headroom is visible", () => {
    render(
      <>
        {renderBlock(
          { kind: "agent", markdown: "hi", created, completed: created + 7_300, usage: usage() },
          0,
          undefined,
          undefined,
          undefined,
          200_000,
        )}
      </>,
    );

    // 3000 + 118000 + 2100 + 900 = 124,000 of 200,000 → 62%.
    expect(screen.getByText("124k / 200k (62%)")).toBeInTheDocument();
    expect(screen.getByText("7.3s")).toBeInTheDocument();
    expect(screen.getByText("$0.42")).toBeInTheDocument();
  });

  it("counts cache reads as context in use — they are what the model was sent", () => {
    render(
      <>
        {renderBlock(
          {
            kind: "agent",
            markdown: "hi",
            created,
            usage: usage({ input: 10, output: 0, cacheRead: 99_990, cacheWrite: 0 }),
          },
          0,
          undefined,
          undefined,
          undefined,
          200_000,
        )}
      </>,
    );

    expect(screen.getByText("100k / 200k (50%)")).toBeInTheDocument();
  });

  it("shows tokens without a percentage when the window is unknown", () => {
    // contextLimit 0 is OpenCode saying it does not know the window — inventing
    // a denominator would report a share that is simply made up.
    render(
      <>
        {renderBlock({ kind: "agent", markdown: "hi", created, usage: usage() }, 0, undefined, undefined, undefined, 0)}
      </>,
    );

    expect(screen.getByText("124k tokens")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it("hides cost for a model that charges nothing rather than printing $0.00", () => {
    render(
      <>
        {renderBlock(
          { kind: "agent", markdown: "hi", created, usage: usage({ cost: 0 }) },
          0,
          undefined,
          undefined,
          undefined,
          200_000,
        )}
      </>,
    );

    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it("renders nothing for a runtime that reports no usage at all (ACP)", () => {
    const { container } = render(<>{renderBlock({ kind: "agent", markdown: "hi" }, 0)}</>);

    // The copy button still stands alone; no empty separators beside it.
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/·/);
  });

  it("omits the duration while the turn is still streaming", () => {
    render(
      <>
        {renderBlock({ kind: "agent", markdown: "hi", created, usage: usage() }, 0, undefined, undefined, undefined, 200_000)}
      </>,
    );

    expect(screen.getByText("124k / 200k (62%)")).toBeInTheDocument();
    expect(screen.queryByText(/\ds$/)).not.toBeInTheDocument();
  });
});
