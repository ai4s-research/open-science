import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderBlock } from "./BlockList";

describe("compaction marker", () => {
  it("reads as one quiet seam, not as a message from the agent", () => {
    render(<>{renderBlock({ kind: "compaction", auto: true }, 0)}</>);

    const toggle = screen.getByRole("button", { name: /Context compacted/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // Nothing about the mechanics until asked for.
    expect(screen.queryByText(/summarized the earlier turns/)).not.toBeInTheDocument();
  });

  it("explains itself on demand, so context management stays auditable", async () => {
    const at = new Date("2026-07-29T12:00:00Z").getTime();
    render(<>{renderBlock({ kind: "compaction", auto: true, overflow: true, at }, 0)}</>);

    await userEvent.click(screen.getByRole("button", { name: /Context compacted/ }));

    expect(screen.getByText(/summarized the earlier turns/)).toBeInTheDocument();
    expect(screen.getByText(/context had already filled up/)).toBeInTheDocument();
    expect(screen.getByText(/still stored locally/)).toBeInTheDocument();
  });

  it("distinguishes a compaction the user asked for", async () => {
    render(<>{renderBlock({ kind: "compaction", auto: false }, 0)}</>);
    await userEvent.click(screen.getByRole("button", { name: /Context compacted/ }));

    expect(screen.getByText(/You asked the runtime to summarize/)).toBeInTheDocument();
  });
});
