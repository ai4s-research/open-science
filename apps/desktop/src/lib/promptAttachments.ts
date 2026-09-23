// Turn composer attachments into real multimodal prompt parts (#88).
//
// An attachment is already copied into the workspace, and the prompt text names
// it — enough for the agent to open it with its own tools, but not enough for a
// vision model to LOOK at a figure: it only ever saw the filename. Images are
// therefore also sent as `file` parts carrying the bytes.
//
// Images only, deliberately. Anything else (CSV, notebook, PDF, archive) is
// better read by the agent's own tools than inlined into every request, and the
// workspace note already points at it.

import type { PromptFile } from "@ai4s/sdk";
import { readArtifact, toDataUrl } from "./artifactFile";
import { previewKindForName } from "./artifacts";

/** Formats a vision model can be expected to accept. */
const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/i;

/**
 * Base64 inflates by ~4/3, and the whole part rides inside one JSON request, so
 * a huge image would stall or blow up the turn. Above this the attachment stays
 * a workspace note — the agent can still open the file.
 */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** What a send got, and what it silently did not. */
export interface AttachmentParts {
  parts: PromptFile[];
  /** Attachments that LOOK like images but produced no part — unreadable,
   *  oversized, or not actually an image. Named so the caller can say so: the
   *  prompt still carries the filename, so a dropped picture is otherwise
   *  invisible, and the model answers about a figure it never saw. */
  dropped: string[];
}

/**
 * Resolve workspace attachment names to image parts. Never throws and never
 * blocks a send: anything unreadable, oversized, or not an image is simply
 * omitted, leaving the prompt's file note as the only reference to it.
 *
 * Omitting a CSV is the design; omitting a PNG is a failure, and the two are
 * reported differently — see `dropped`.
 */
export async function imageAttachmentParts(names: string[]): Promise<AttachmentParts> {
  if (names.length === 0) return { parts: [], dropped: [] };
  const resolved = await Promise.all(
    names.map(async (filename): Promise<PromptFile | null> => {
      try {
        const file = await readArtifact(filename);
        if (!file || file.encoding !== "base64") return null;
        if (!IMAGE_MIME.test(file.mime)) return null;
        if (file.size > MAX_IMAGE_BYTES) return null;
        return { filename, mime: file.mime, url: toDataUrl(file) };
      } catch {
        return null;
      }
    }),
  );
  return {
    parts: resolved.filter((p): p is PromptFile => p !== null),
    dropped: names.filter(
      (name, i) => resolved[i] === null && previewKindForName(name) === "image",
    ),
  };
}
