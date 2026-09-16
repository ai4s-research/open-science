import { describe, expect, it } from "vitest";
import {
  agentMetric,
  clampPercent,
  formatCostUsd,
  formatResetIn,
  formatTokens,
  formatWindowLength,
  quotaWindowLabel,
  totalTokens,
  usageBarTone,
  usageWindowBounds,
  windowFigure,
  type AgentUsage,
  type RateLimitWindow,
  type TokenTotals,
} from "./usage";

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

describe("usage windows", () => {
  it("starts today at local midnight, not at UTC midnight", () => {
    // 14:30 local on any machine: the boundary must be that morning, so a user
    // east of UTC does not see their afternoon counted as tomorrow.
    const now = new Date(2026, 8, 14, 14, 30, 0);
    const { todayStartMs } = usageWindowBounds(now);
    const midnight = new Date(todayStartMs);
    expect(midnight.getHours()).toBe(0);
    expect(midnight.getDate()).toBe(14);
    expect(midnight.getMonth()).toBe(8);
  });

  it("makes the week a rolling seven days that includes today", () => {
    const now = new Date(2026, 8, 14, 14, 30, 0);
    const { weekStartMs } = usageWindowBounds(now);
    const start = new Date(weekStartMs);
    // Six days before the 14th.
    expect(start.getDate()).toBe(8);
    expect(start.getHours()).toBe(0);
  });

  it("keeps the week boundary on a midnight across a month edge", () => {
    const now = new Date(2026, 8, 2, 9, 0, 0);
    const start = new Date(usageWindowBounds(now).weekStartMs);
    // August: the window crosses the month edge.
    expect(start.getMonth()).toBe(7);
    expect(start.getDate()).toBe(27);
    expect(start.getHours()).toBe(0);
  });
});

describe("formatting", () => {
  it("never shows real spend as $0.00", () => {
    expect(formatCostUsd(0)).toBe("$0");
    expect(formatCostUsd(0.004)).toBe("<$0.01");
    expect(formatCostUsd(12.4)).toBe("$12.40");
    expect(formatCostUsd(150.6)).toBe("$151");
    expect(formatCostUsd(2310.39)).toBe("$2.3k");
  });

  it("abbreviates token counts", () => {
    expect(formatTokens(842)).toBe("842");
    expect(formatTokens(4200)).toBe("4.2k");
    expect(formatTokens(59_000)).toBe("59k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
    expect(formatTokens(2_542_722_784)).toBe("2543M");
  });

  it("counts every billed bucket, cached reads included", () => {
    const week = totals({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 300,
      cacheWriteTokens: 4000,
    });
    expect(totalTokens(week)).toBe(4330);
  });

  it("reports the time left on a rate-limit window, and nothing once it passed", () => {
    const now = Date.UTC(2026, 8, 14, 12, 0, 0);
    const inSeconds = (minutes: number) => (now + minutes * 60_000) / 1000;
    expect(formatResetIn(inSeconds(20), now)).toBe("20m");
    expect(formatResetIn(inSeconds(5 * 60), now)).toBe("5h");
    expect(formatResetIn(inSeconds(2 * 24 * 60), now)).toBe("2d");
    expect(formatResetIn(inSeconds(-5), now)).toBeNull();
    expect(formatResetIn(null, now)).toBeNull();
  });
});

describe("what a spend window prints", () => {
  it("shows cost when the turns could be priced", () => {
    expect(windowFigure(totals({ costUsd: 12.4, pricedTurns: 9 }))).toBe("$12.40");
  });

  it("shows tokens rather than a false $0 when the model has no price", () => {
    // A model newer than this build's price table: the token count is a true
    // number where "$0.00" would be a wrong one.
    const figure = windowFigure(
      totals({ inputTokens: 4_810_759, outputTokens: 896_763, unpricedTurns: 1845 }),
    );
    expect(figure).toBe("5.7M tok");
  });

  it("prefers cost when a window mixes priced and unpriced turns", () => {
    expect(windowFigure(totals({ costUsd: 3.5, pricedTurns: 4, unpricedTurns: 2 }))).toBe("$3.50");
  });

  it("prints nothing at all for an empty window", () => {
    // A "$0" row is noise; the caller drops the row instead of showing it.
    expect(windowFigure(totals({}))).toBeNull();
  });
});

function usage(fields: Partial<AgentUsage>): AgentUsage {
  return { agent: "claude", today: totals({}), week: totals({}), ...fields };
}

const quota: RateLimitWindow = {
  usedPercent: 49.4,
  windowMinutes: 300,
  resetsAt: null,
  asOfMs: 0,
  planType: "prolite",
};

describe("which metric an agent row carries", () => {
  it("prefers the subscription window — that is the question being asked", () => {
    const metric = agentMetric(
      usage({ today: totals({ costUsd: 12, pricedTurns: 3 }) }),
      quota,
    );
    expect(metric).toEqual({ kind: "quota", window: quota, usedPercent: 49 });
  });

  it("falls back to today's spend when the agent reports no window", () => {
    const metric = agentMetric(usage({ today: totals({ costUsd: 12.4, pricedTurns: 3 }) }), null);
    expect(metric).toEqual({ kind: "spend", window: "today", figure: "$12.40" });
  });

  it("shows the week rather than a meaningless $0 on a quiet morning", () => {
    // The screenshot bug: a row displayed "today $0" because the WEEK had usage.
    const metric = agentMetric(
      usage({ today: totals({}), week: totals({ costUsd: 237, pricedTurns: 900 }) }),
      null,
    );
    expect(metric).toEqual({ kind: "spend", window: "week", figure: "$237" });
  });

  it("carries no metric at all when there is nothing to report", () => {
    expect(agentMetric(usage({}), null)).toBeNull();
  });
});

describe("quota meter presentation", () => {
  it("rounds once, so the bar width and the label cannot disagree", () => {
    expect(clampPercent(49.4)).toBe(49);
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent(Number.NaN)).toBe(0);
  });

  it("fills in the app's accent until the figure is worth a warning", () => {
    // Not a muted grey: against this app's surfaces that reads as an empty
    // track, so every bar looked blank whatever it said.
    expect(usageBarTone(10)).toBe("bg-accent");
    expect(usageBarTone(59)).toBe("bg-accent");
    expect(usageBarTone(60)).toBe("bg-warn");
    expect(usageBarTone(80)).toBe("bg-error");
  });

  it("names a window in the space a sidebar has", () => {
    expect(formatWindowLength(300)).toBe("5h");
    expect(formatWindowLength(10080)).toBe("wk");
    expect(formatWindowLength(4320)).toBe("3d");
    expect(formatWindowLength(45)).toBe("45m");
  });

  it("prefers the live countdown to the window's nominal length", () => {
    const now = Date.UTC(2026, 8, 14, 12, 0, 0);
    const resetting = { ...quota, resetsAt: (now + 2 * 60 * 60_000) / 1000 };
    expect(quotaWindowLabel(resetting, now)).toBe("2h");
    // Once the reset time is unknown or past, the window's length is all there is.
    expect(quotaWindowLabel(quota, now)).toBe("5h");
  });
});
