import { describe, expect, it } from "vitest";
import type { HistoryMessage, SessionMeta } from "@ai4s/sdk";
import { exportIndex, sessionToMarkdown } from "./exportSession";

const session: SessionMeta = {
  id: "ses_1",
  title: "Spike sorting",
  directory: "/work/bci",
  created: new Date("2026-07-01T09:00:00Z").getTime(),
  updated: new Date("2026-07-02T09:00:00Z").getTime(),
};

describe("sessionToMarkdown", () => {
  it("writes front matter a script can read, then the turns in order", () => {
    const messages: HistoryMessage[] = [
      { role: "user", parts: [{ type: "text", text: "How do I sort spikes?" }] },
      { role: "assistant", parts: [{ type: "text", text: "Use a **4.5 sigma** threshold." }] },
    ];

    const md = sessionToMarkdown(session, messages);

    expect(md).toContain('title: "Spike sorting"');
    expect(md).toContain("id: ses_1");
    expect(md).toContain("created: 2026-07-01T09:00:00.000Z");
    expect(md.indexOf("## You")).toBeLessThan(md.indexOf("## Assistant"));
    expect(md).toContain("Use a **4.5 sigma** threshold.");
  });

  it("keeps tool steps but folds them away, so the conversation stays readable", () => {
    const messages: HistoryMessage[] = [
      {
        role: "assistant",
        parts: [
          { type: "text", text: "Running it now." },
          {
            type: "tool",
            tool: "bash",
            state: { title: "sort.py", input: { command: "python sort.py" }, output: "done\n" },
          },
        ],
      },
    ];

    const md = sessionToMarkdown(session, messages);

    expect(md).toContain("<details><summary>bash — sort.py</summary>");
    expect(md).toContain("python sort.py");
    expect(md).toContain("done");
  });

  it("truncates a runaway tool log instead of burying the conversation in it", () => {
    const messages: HistoryMessage[] = [
      {
        role: "assistant",
        parts: [{ type: "tool", tool: "bash", state: { output: "x".repeat(50_000) } }],
      },
    ];

    const md = sessionToMarkdown(session, messages);

    expect(md).toContain("… (truncated)");
    expect(md.length).toBeLessThan(5000);
  });

  it("records a failed turn rather than exporting it as if it had answered", () => {
    const messages: HistoryMessage[] = [
      { role: "assistant", error: "rate limited", parts: [{ type: "text", text: "partial" }] },
    ];

    expect(sessionToMarkdown(session, messages)).toContain("**Turn failed:** rate limited");
  });

  it("skips the synthetic markers the runtime writes for a shell turn", () => {
    const messages: HistoryMessage[] = [
      { role: "user", parts: [{ type: "text", text: "internal marker", synthetic: true }] },
      { role: "assistant", parts: [{ type: "text", text: "real answer" }] },
    ];

    const md = sessionToMarkdown(session, messages);
    expect(md).not.toContain("internal marker");
    expect(md).toContain("real answer");
  });
});

describe("exportIndex", () => {
  it("lists what was written so a folder of transcripts is navigable later", () => {
    const md = exportIndex(
      [
        { session, file: "Spike sorting.md" },
        { session: { ...session, id: "ses_2", title: "Pipe | table" }, file: "Pipe - table.md" },
      ],
      new Date("2026-07-29T12:00:00Z").getTime(),
    );

    expect(md).toContain("2 conversations, exported 2026-07-29T12:00:00.000Z");
    expect(md).toContain("| 2026-07-02 | Spike sorting | [Spike sorting.md](Spike%20sorting.md) |");
    // A pipe in a title must not break the table it sits in.
    expect(md).toContain("Pipe \\| table");
  });
});
