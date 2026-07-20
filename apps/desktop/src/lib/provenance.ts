// Artifact provenance (P0-3): turn the agent's successful file-writing tool
// calls into version records in `.openscience/provenance.jsonl`, and read them
// back for the artifact History view. Pure derivation is separated from the
// Tauri bridge so it can be unit-tested without a desktop shell.
import type { ToolUpdatedEvent } from "@ai4s/sdk";
import type { ProvenanceRecord } from "@ai4s/shared";
import { isTauri, logDebug } from "./tauri";
import { deriveArtifact, parsePatchFiles } from "./artifacts";

export interface ProvenanceInput {
  path: string;
  tool: string;
  /** Text the tool wrote, when it carried it (write). */
  content?: string;
  /** Unified diff of an edit, when the full content wasn't in the event — the
   *  lineage of an incremental change (edits carry old/newString, not `content`). */
  diff?: string;
  log: string;
}

/** Jupyter tools that change a notebook; reads/lists are not new versions. */
const JUPYTER_MUTATING = /insert|overwrite|delete|execute|write|edit|append|run/;

/**
 * Derive a provenance record from a completed tool call, or `null` when the
 * event is not a version-worthy write (failures, reads, non-file tools).
 */
export function provenanceInputFromEvent(event: ToolUpdatedEvent): ProvenanceInput | null {
  if (event.status !== "success") return null;
  const artifact = deriveArtifact(event);
  if (!artifact) return null;
  const tool = (event.tool ?? "").toLowerCase();
  if (tool.includes("jupyter") && !JUPYTER_MUTATING.test(tool)) return null;
  // Write-tool titles are usually just the file path — redundant next to the
  // record's own path field, so keep only titles that say something more.
  const title = event.title?.trim();
  const log =
    title && !title.endsWith(artifact.filename) ? title : `${event.tool} → ${artifact.path}`;
  // When the tool didn't carry full content (an edit), keep its diff so the
  // History still shows what changed, rather than "content not captured".
  const diff = artifact.content ? undefined : event.diff;
  return { path: artifact.path, tool: event.tool, content: artifact.content, diff, log };
}

/**
 * All version records a completed tool call produces. Most write tools name one
 * file, but apply_patch can touch many in a single call — each becomes its own
 * record. Returns `[]` for non-version-worthy events (failures, reads, non-file
 * tools), so the caller can iterate unconditionally.
 */
export function provenanceInputsFromEvent(event: ToolUpdatedEvent): ProvenanceInput[] {
  if (event.status !== "success") return [];
  if ((event.tool ?? "").toLowerCase() === "apply_patch") {
    const input = (event.input ?? {}) as Record<string, unknown>;
    const patchText = typeof input.patchText === "string" ? input.patchText : undefined;
    if (!patchText) return [];
    // A delete removes the artifact — there is no version to open — so skip it;
    // adds carry the full new text, updates carry a diff.
    return parsePatchFiles(patchText)
      .filter((f) => f.op !== "delete")
      .map((f) => {
        const filename = f.path.split(/[\\/]/).pop() || f.path;
        const isAdd = f.op === "add";
        const content = isAdd
          ? f.body
              .split("\n")
              .map((l) => (l.startsWith("+") ? l.slice(1) : l))
              .join("\n")
          : undefined;
        return {
          path: f.path,
          tool: event.tool,
          content,
          diff: isAdd ? undefined : f.body,
          log: `${event.tool} → ${filename}`,
        };
      });
  }
  const single = provenanceInputFromEvent(event);
  return single ? [single] : [];
}

/** Append a version record (desktop only). Recording must never break the chat flow. */
export async function recordProvenance(
  input: ProvenanceInput,
  sessionId: string | undefined,
  model: string | null,
  variant: string | null = null,
): Promise<void> {
  if (!isTauri) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("record_provenance", {
      path: input.path,
      tool: input.tool,
      content: input.content ?? null,
      diff: input.diff ?? null,
      log: input.log,
      sessionId: sessionId ?? null,
      model: model ?? null,
      variant: variant ?? null,
    });
    void logDebug(`provenance ✓ ${input.path}`);
  } catch (e) {
    // Best-effort — the conversation goes on — but a failure must be visible
    // in the diagnostic log, or a silently broken audit trail looks healthy.
    void logDebug(`provenance FAILED for ${input.path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** All recorded versions of one artifact, oldest first ([] in browser dev). */
export async function listProvenance(path: string): Promise<ProvenanceRecord[]> {
  if (!isTauri) return [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<ProvenanceRecord[]>("list_provenance", { path });
  } catch {
    return [];
  }
}

/** The captured `pip freeze` list for a package snapshot hash (null if unreadable). */
export async function readEnvLockfile(hash: string): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("read_env_lockfile", { hash });
  } catch {
    return null;
  }
}
