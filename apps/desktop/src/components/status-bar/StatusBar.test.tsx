import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useUsageStore, type AgentUsage, type TokenTotals, type UsageSummary } from "@/lib/usage";
import { StatusBar } from "./StatusBar";

// The bar scans on mount; these tests set the store directly instead.
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  isTauri: false,
}));

function totals(fields: Partial<TokenTotals>): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    pricedTurns: 0,
    unpricedTurns: 0,
    ...fields,
  };
}

function agent(name: string, fields: Partial<AgentUsage> = {}): AgentUsage {
  return { agent: name, today: totals({}), week: totals({}), ...fields };
}

function showUsage(summary: Partial<UsageSummary>) {
  useUsageStore.setState({
    loading: false,
    summary: {
      agents: [],
      codexRateLimits: [],
      scannedFiles: 0,
      skippedFiles: 0,
      scanMs: 0,
      ...summary,
    },
  });
}

const CODEX_QUOTA = {
  usedPercent: 49,
  windowMinutes: 300,
  resetsAt: null,
  asOfMs: 0,
  planType: "prolite",
};

describe("StatusBar", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    useUsageStore.setState({ summary: null, loading: false });
  });

  it("takes no space at all until a segment has something to say", () => {
    const { container } = render(<StatusBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it("stays a single 24px strip, whatever it is reporting", () => {
    showUsage({
      agents: [
        agent("claude", { today: totals({ costUsd: 237, pricedTurns: 900 }) }),
        agent("codex", { today: totals({ costUsd: 4, pricedTurns: 2 }) }),
      ],
      codexRateLimits: [CODEX_QUOTA],
    });
    const { container } = render(<StatusBar />);

    const bar = container.firstElementChild!;
    expect(bar).toHaveClass("h-6", "border-t");
    // Both agents live inside ONE button — the bar is a line, not a list.
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("keeps the detail behind a click rather than on the bar", async () => {
    showUsage({
      agents: [
        agent("claude", {
          today: totals({ costUsd: 12.4, pricedTurns: 9 }),
          week: totals({ costUsd: 237, pricedTurns: 900 }),
        }),
      ],
    });
    render(<StatusBar />);

    // Closed: one figure, and no sign of the week or the token counts.
    expect(screen.getByText("$12.40")).toBeInTheDocument();
    expect(screen.queryByText("$237")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Usage" }));

    // Open: the popover carries what the bar had no room for.
    expect(await screen.findByText("$237")).toBeInTheDocument();
    expect(screen.getByText("7d")).toBeInTheDocument();
    expect(screen.getByText("tokens")).toBeInTheDocument();
  });

  it("never prints a $0 for an agent that was idle today", () => {
    // The reported bug: a segment read "$0" because only the WEEK had usage.
    showUsage({ agents: [agent("claude", { week: totals({ costUsd: 237, pricedTurns: 900 }) })] });
    render(<StatusBar />);

    expect(screen.queryByText("$0")).not.toBeInTheDocument();
    expect(screen.getByText("$237")).toBeInTheDocument();
  });

  it("drops an agent with nothing to report", () => {
    showUsage({ agents: [agent("claude"), agent("codex")] });
    const { container } = render(<StatusBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it("colours the meter only once the window is worth noticing", () => {
    showUsage({
      agents: [agent("codex", { today: totals({ costUsd: 1, pricedTurns: 1 }) })],
      codexRateLimits: [{ ...CODEX_QUOTA, usedPercent: 91 }],
    });
    const { container } = render(<StatusBar />);

    expect(screen.getByText("91%")).toHaveClass("text-error");
    expect(container.querySelector(".bg-error")).toBeInTheDocument();
  });

  it("prefers the plan window to the money when the agent reports one", () => {
    showUsage({
      agents: [agent("codex", { today: totals({ costUsd: 4, pricedTurns: 2 }) })],
      codexRateLimits: [CODEX_QUOTA],
    });
    render(<StatusBar />);

    // "How much of my plan is left" is the question; the spend waits inside.
    expect(screen.getByText("49%")).toBeInTheDocument();
    expect(screen.queryByText("$4.00")).not.toBeInTheDocument();
  });

  it("shows tokens, not a wrong price, for a model it cannot price", async () => {
    showUsage({
      agents: [
        agent("codex", {
          today: totals({ inputTokens: 4_000_000, unpricedTurns: 1845 }),
          week: totals({ inputTokens: 4_000_000, unpricedTurns: 1845 }),
        }),
      ],
    });
    render(<StatusBar />);
    await userEvent.click(screen.getByRole("button", { name: "Usage" }));

    // The figure itself carries the honesty — a token count where a price is
    // unknown. The old sentence explaining the accounting was noise in a bar
    // read at a glance.
    const popover = within(await screen.findByRole("dialog"));
    expect(popover.getAllByText("4.0M tok").length).toBeGreaterThan(0);
    expect(popover.queryByText(/cannot price/)).not.toBeInTheDocument();
  });

  it("names which tool spent it — the app, or a CLI run elsewhere", async () => {
    // The reported confusion: rows labelled "Claude" and "Codex" read as if this
    // app had spent them, when they came from those CLIs in a terminal.
    showUsage({
      agents: [
        agent("workbench", { today: totals({ inputTokens: 3_000_000, unpricedTurns: 62 }),
                             week: totals({ inputTokens: 3_000_000, unpricedTurns: 62 }) }),
        agent("claude", { today: totals({ costUsd: 12, pricedTurns: 9 }),
                          week: totals({ costUsd: 12, pricedTurns: 9 }) }),
      ],
    });
    render(<StatusBar />);

    expect(screen.getByText("OSD")).toBeInTheDocument();
    expect(screen.getByText("Claude Code CLI")).toBeInTheDocument();
    expect(screen.queryByText("Claude")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Usage" }));
    // Said once, on the rows it applies to.
    expect(
      await screen.findByText("Run in your own terminal — only the usage is recorded here."),
    ).toBeInTheDocument();
  });

  it("leads with this app's own spend", () => {
    showUsage({
      agents: [
        agent("workbench", { today: totals({ costUsd: 3, pricedTurns: 2 }) }),
        agent("claude", { today: totals({ costUsd: 12, pricedTurns: 9 }) }),
      ],
    });
    render(<StatusBar />);

    const labels = screen.getAllByText(/OSD|Claude Code CLI/).map((el) => el.textContent);
    expect(labels[0]).toBe("OSD");
  });
});

describe("StatusBar · the usage popover, as Orca lays it out", () => {
  const FIVE_HOURS = {
    usedPercent: 8,
    windowMinutes: 300,
    // +30s of slack: the label floors to whole minutes, so a reset landing on
    // the exact boundary would read 4h 4m half the time.
    resetsAt: Math.round(Date.now() / 1000) + 4 * 3600 + 5 * 60 + 30,
    asOfMs: 0,
    planType: "pro",
  };
  const WEEKLY = { ...FIVE_HOURS, usedPercent: 45, windowMinutes: 10080 };

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    useUsageStore.setState({ summary: null, loading: false });
  });

  /** The popover only — the collapsed bar shows the tightest figure too, so an
   *  unscoped query would match both. */
  async function openPopover() {
    render(<StatusBar />);
    await userEvent.click(screen.getByRole("button", { name: "Usage" }));
    return within(await screen.findByRole("dialog"));
  }

  it("shows BOTH of Codex's windows, not just the hourly one", async () => {
    showUsage({ agents: [agent("codex")], codexRateLimits: [FIVE_HOURS, WEEKLY] });
    const popover = await openPopover();

    // The weekly window is the one a subscriber actually runs out of; it used
    // to be dropped on the floor by the scanner.
    expect(popover.getByText("5h")).toBeInTheDocument();
    expect(popover.getByText("wk")).toBeInTheDocument();
    expect(popover.getByText("8%")).toBeInTheDocument();
    expect(popover.getByText("45%")).toBeInTheDocument();
  });

  it("says when the quota comes back, to the minute", async () => {
    showUsage({ agents: [agent("codex")], codexRateLimits: [FIVE_HOURS, WEEKLY] });
    await openPopover();

    // "4h" for anything between four and five hours is the difference between
    // finishing the task and waiting.
    expect(screen.getByText("Resets in 4h 5m")).toBeInTheDocument();
  });

  it("names the plan beside the agent", async () => {
    showUsage({ agents: [agent("codex")], codexRateLimits: [FIVE_HOURS] });
    await openPopover();

    expect(screen.getByText(/· pro/)).toBeInTheDocument();
  });

  it("collapses to the window nearest its limit when asked", async () => {
    showUsage({ agents: [agent("codex")], codexRateLimits: [FIVE_HOURS, WEEKLY] });
    const popover = await openPopover();

    await userEvent.click(screen.getByRole("radio", { name: "Compact" }));

    // Compact keeps only the tightest — 45% weekly, not the 8% hourly.
    expect(popover.getByText("45%")).toBeInTheDocument();
    expect(popover.queryByText("8%")).not.toBeInTheDocument();
  });

  it("remembers the density the reader chose", async () => {
    showUsage({ agents: [agent("codex")], codexRateLimits: [FIVE_HOURS, WEEKLY] });
    await openPopover();
    await userEvent.click(screen.getByRole("radio", { name: "Compact" }));

    // A preference about the reader, not about the data: it outlives the popover.
    expect(window.localStorage.getItem("ai4s.usage.mode.v1")).toBe("compact");
  });

  it("leads with this app's own spend, then the CLI nearest a limit", async () => {
    showUsage({
      agents: [
        agent("workbench", { today: totals({ costUsd: 3, pricedTurns: 2 }) }),
        agent("codex"),
      ],
      codexRateLimits: [WEEKLY],
    });
    await openPopover();

    // This app's own spend leads whatever the CLIs are doing: it is the one the
    // reader is responsible for.
    const names = screen.getAllByText(/OSD|Codex CLI/).map((el) => el.textContent);
    expect(names[0]).toBe("OSD");
  });
});

describe("StatusBar · the plan figures come from the provider", () => {
  const FIVE_HOUR = { usedPercent: 43, windowMinutes: 300, resetsAt: null, asOfMs: 0, planType: null };
  const SEVEN_DAY = { usedPercent: 50, windowMinutes: 10080, resetsAt: null, asOfMs: 0, planType: null };

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    useUsageStore.setState({ summary: null, loading: false });
  });

  it("gives Claude Code its bars, which a transcript could never provide", async () => {
    showUsage({
      agents: [agent("claude", { week: totals({ costUsd: 5, pricedTurns: 3 }) })],
      plan: { claude: [FIVE_HOUR, SEVEN_DAY], codex: [] },
    });
    render(<StatusBar />);
    await userEvent.click(screen.getByRole("button", { name: "Usage" }));

    // Claude's transcripts carry token counts and nothing about the plan; the
    // percentages come from the provider itself.
    const popover = within(await screen.findByRole("dialog"));
    expect(popover.getByText("43%")).toBeInTheDocument();
    expect(popover.getByText("50%")).toBeInTheDocument();
    expect(popover.getByText("5h")).toBeInTheDocument();
  });

  it("prefers the provider's Codex figure over the one left in a session file", async () => {
    showUsage({
      agents: [agent("codex")],
      plan: { claude: [], codex: [{ ...FIVE_HOUR, usedPercent: 33 }] },
      // What a session happened to end on, days ago.
      codexRateLimits: [{ ...FIVE_HOUR, usedPercent: 91 }],
    });
    render(<StatusBar />);
    await userEvent.click(screen.getByRole("button", { name: "Usage" }));

    const popover = within(await screen.findByRole("dialog"));
    expect(popover.getByText("33%")).toBeInTheDocument();
    expect(popover.queryByText("91%")).not.toBeInTheDocument();
  });

  it("falls back to the recorded figure when the provider cannot be reached", async () => {
    showUsage({
      agents: [agent("codex")],
      plan: { claude: [], codex: [] },
      codexRateLimits: [{ ...FIVE_HOUR, usedPercent: 91 }],
    });
    render(<StatusBar />);
    await userEvent.click(screen.getByRole("button", { name: "Usage" }));

    // A stale percentage beats none at all — it is still the last thing the
    // provider actually said.
    expect(within(await screen.findByRole("dialog")).getByText("91%")).toBeInTheDocument();
  });
});

describe("StatusBar · when the provider cannot be asked", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    useUsageStore.setState({ summary: null, loading: false });
  });

  it("says why there are no bars instead of showing none silently", async () => {
    showUsage({
      agents: [agent("claude", { week: totals({ costUsd: 4, pricedTurns: 2 }) })],
      plan: { claude: [], codex: [], claudeError: "could not connect — check the proxy in Settings" },
    });
    render(<StatusBar />);
    await userEvent.click(screen.getByRole("button", { name: "Usage" }));

    // A silent absence reads as "this app cannot do that", which is exactly how
    // it looked while the requests were going out unproxied.
    expect(
      await screen.findByText("could not connect — check the proxy in Settings"),
    ).toBeInTheDocument();
  });

  it("marks a session-file percentage with its age, and still says why", async () => {
    // The number plan_usage.rs was written to replace: whatever the session
    // happened to end on. Shown, because a stale figure beats none — but never
    // as a live reading, and never instead of the reason the request failed.
    showUsage({
      agents: [agent("codex")],
      codexRateLimits: [
        {
          usedPercent: 91,
          windowMinutes: 300,
          resetsAt: null,
          asOfMs: Date.now() - 3 * 60 * 60 * 1000,
          planType: null,
        },
      ],
      plan: { claude: [], codex: [], codexError: "timed out — check the proxy in Settings" },
    });
    render(<StatusBar />);
    await userEvent.click(screen.getByRole("button", { name: "Usage" }));

    const popover = within(await screen.findByRole("dialog"));
    expect(popover.getByText("91%")).toBeInTheDocument();
    expect(popover.getByText("as of 3h ago")).toBeInTheDocument();
    expect(popover.getByText("timed out — check the proxy in Settings")).toBeInTheDocument();
  });

  it("says nothing when the bars are there", async () => {
    showUsage({
      agents: [agent("claude")],
      plan: {
        claude: [{ usedPercent: 43, windowMinutes: 300, resetsAt: null, asOfMs: 0, planType: null }],
        codex: [],
        claudeError: "stale message from an earlier attempt",
      },
    });
    render(<StatusBar />);
    await userEvent.click(screen.getByRole("button", { name: "Usage" }));

    const popover = within(await screen.findByRole("dialog"));
    expect(popover.getByText("43%")).toBeInTheDocument();
    expect(popover.queryByText(/stale message/)).not.toBeInTheDocument();
  });
});
