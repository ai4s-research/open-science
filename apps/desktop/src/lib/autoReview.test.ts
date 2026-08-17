import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  autoReviewPrompt,
  isMutatingTool,
  shouldAutoReview,
  type AutoReviewGate,
} from "./autoReview";

const ON: AutoReviewGate = {
  enabled: true,
  changedFiles: true,
  wasReview: false,
  isSubagent: false,
  hasReviewer: true,
};

describe("isMutatingTool", () => {
  it("counts a successful write or edit as a workspace change", () => {
    expect(isMutatingTool("write", "success")).toBe(true);
    expect(isMutatingTool("edit", "success")).toBe(true);
    expect(isMutatingTool("apply_patch", "success")).toBe(true);
  });

  it("ignores a tool that only read, and one that has not finished", () => {
    expect(isMutatingTool("read", "success")).toBe(false);
    expect(isMutatingTool("grep", "success")).toBe(false);
    expect(isMutatingTool("write", "running")).toBe(false);
    expect(isMutatingTool("write", "failed")).toBe(false);
  });

  it("ignores bash — a shell step that writes is indistinguishable from `ls`", () => {
    expect(isMutatingTool("bash", "success")).toBe(false);
  });
});

describe("shouldAutoReview", () => {
  it("reviews a finished turn that changed files", () => {
    expect(shouldAutoReview(ON)).toBe(true);
  });

  it("stays out of the way when the user has not opted in", () => {
    expect(shouldAutoReview({ ...ON, enabled: false })).toBe(false);
  });

  it("skips a turn with nothing to audit", () => {
    expect(shouldAutoReview({ ...ON, changedFiles: false })).toBe(false);
  });

  it("never reviews a review — that is the loop", () => {
    expect(shouldAutoReview({ ...ON, wasReview: true })).toBe(false);
  });

  it("leaves a subagent session to its parent's review", () => {
    expect(shouldAutoReview({ ...ON, isSubagent: true })).toBe(false);
  });

  it("does nothing when the runtime has no reviewer agent", () => {
    expect(shouldAutoReview({ ...ON, hasReviewer: false })).toBe(false);
  });
});

describe("autoReviewPrompt", () => {
  it("pins the reviewer to the completed turn's changed files", () => {
    const prompt = autoReviewPrompt(["analysis.py", "report.md"]);
    expect(prompt).toContain("- analysis.py\n- report.md");
    expect(prompt).toContain("checkpoint only");
    expect(prompt).toContain("absent Git HEAD");
  });
});

// The reviewer is deployed into the OpenCode profile as a real agent. `mode`
// decides who may invoke it: `all` also puts it on the task tool's delegation
// menu, so a model could spawn it by itself and reviews turned up inside
// subagents even with auto-review switched off. The app pins it as the agent of
// its own background session — the primary role — so `primary` is what keeps
// the feature working without handing it to the model.
describe("the reviewer agent's profile", () => {
  it("is not offered to the task tool", () => {
    // vitest runs from apps/desktop; the profile lives at the repo root.
    const md = readFileSync(
      resolve(process.cwd(), "../../runtime/opencode-profile/agent/reviewer.md"),
      "utf8",
    );
    const frontmatter = md.split("---")[1] ?? "";
    const mode = /^mode:\s*(\S+)/m.exec(frontmatter)?.[1];
    expect(mode).toBe("primary");
    // It also may not spawn tasks of its own — a review that delegates is a loop.
    expect(frontmatter).toMatch(/task:\s*deny/);
  });
});
