import type { HistoryMessage, SessionMeta } from "@ai4s/sdk";
import { isGoalInjectedPrompt } from "./goalPrompts";

/** Tool output kept per step in an export. A transcript is for reading and
 *  archiving, not for replaying a build log; a runaway 5 MB stdout would bury
 *  the conversation it belongs to. */
const TOOL_OUTPUT_MAX = 2000;

function cap(text: string, max: number): string {
  const trimmed = text.replace(/\s+$/, "");
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}\n… (truncated)`;
}

/** A conversation as a standalone Markdown document: front matter a script can
 *  parse, then the turns in order. Deliberately plain — the point of an export
 *  is that it outlives this app. */
export function sessionToMarkdown(session: SessionMeta, messages: HistoryMessage[]): string {
  const iso = (ms?: number) => (ms == null ? "" : new Date(ms).toISOString());
  const lines: string[] = [
    "---",
    `title: ${JSON.stringify(session.title)}`,
    `id: ${session.id}`,
    ...(session.directory ? [`workspace: ${JSON.stringify(session.directory)}`] : []),
    ...(session.created ? [`created: ${iso(session.created)}`] : []),
    ...(session.updated ? [`updated: ${iso(session.updated)}`] : []),
    ...(session.archived ? [`archived: ${iso(session.archived)}`] : []),
    "---",
    "",
    `# ${session.title}`,
    "",
  ];

  for (const m of messages) {
    const texts = m.parts
      .filter((p) => p.type === "text" && p.text?.trim() && !p.synthetic)
      .map((p) => p.text!.trim());
    const tools = m.parts.filter((p) => p.type === "tool");

    if (m.role === "user") {
      if (!texts.length) continue;
      // Goal mode writes its own turns into the session; exporting them under
      // "You" would credit the user with prompts they never wrote.
      if (texts.every((text) => isGoalInjectedPrompt(text))) continue;
      lines.push("## You", "", texts.join("\n\n"), "");
      continue;
    }

    if (!texts.length && !tools.length) continue;
    lines.push("## Assistant", "");
    for (const t of texts) lines.push(t, "");
    for (const p of tools) {
      const name = p.tool ?? "tool";
      const title = p.state?.title ? ` — ${p.state.title}` : "";
      lines.push(`<details><summary>${name}${title}</summary>`, "");
      const command = p.state?.input?.command;
      if (typeof command === "string" && command.trim()) {
        lines.push("```sh", command.trim(), "```", "");
      }
      if (p.state?.output?.trim()) {
        lines.push("```", cap(p.state.output, TOOL_OUTPUT_MAX), "```", "");
      }
      lines.push("</details>", "");
    }
    if (m.error) lines.push(`> **Turn failed:** ${m.error}`, "");
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** The index written alongside an export, so a folder of transcripts is
 *  navigable months later without opening each one. */
export function exportIndex(
  rows: Array<{ session: SessionMeta; file: string }>,
  exportedAt: number,
): string {
  const lines = [
    "# Exported conversations",
    "",
    `${rows.length} conversation${rows.length === 1 ? "" : "s"}, exported ${new Date(exportedAt).toISOString()}.`,
    "",
    "| Updated | Conversation | File |",
    "| --- | --- | --- |",
  ];
  for (const { session, file } of rows) {
    const when = session.updated ? new Date(session.updated).toISOString().slice(0, 10) : "";
    const title = session.title.replace(/\|/g, "\\|");
    lines.push(`| ${when} | ${title} | [${file}](${encodeURI(file)}) |`);
  }
  return `${lines.join("\n")}\n`;
}
