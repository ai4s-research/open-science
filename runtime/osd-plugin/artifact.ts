// `present_artifact`: ask the Open Science Desktop UI to display a workspace
// file. The call itself is the signal the UI acts on; the tool only checks the
// file is real and inside the workspace.
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

type DisplayMode = "inline" | "panel";
type Placement = "right" | "bottom";
type Target = "current-screen" | "new-screen" | "new-session";

export interface PresentInput {
  path: string;
  display: DisplayMode;
  placement?: Placement;
  target?: Target;
  title?: string;
}

/** The host UI contract, attached to every model request: models sometimes
 *  mistake reading a file or linking its path for displaying it, and the tool
 *  description alone does not stop that. */
export const ARTIFACT_PRESENTATION_SYSTEM = `Open Science Desktop can display workspace files through the present_artifact tool.
- If the user asks to show, display, render, preview, or open an artifact in the chat/conversation, call present_artifact with display="inline".
- If the user asks for a panel or side-by-side view in the current Screen, call present_artifact with display="panel", target="current-screen", and the placement they asked for: placement="bottom" for below/underneath/a bottom panel, otherwise placement="right".
- If the artifact is already shown in a panel and the user asks to move it, call present_artifact again with the new placement; the host moves the open panel.
- If the user asks for a new Screen, call it with target="new-screen". If they ask for a new or dedicated Session, call it with target="new-session"; the host creates the Session.
- If you generate the artifact, create the file first, then call present_artifact in the same turn.
- Reading a file, mentioning its path, or attaching a link does not display it. Never claim an artifact is displayed unless present_artifact completed successfully.`;

/** A workspace-relative path, resolved — or an error naming what is wrong. */
export function workspacePath(directory: string, requestedPath: string): string {
  if (isAbsolute(requestedPath)) {
    throw new Error("path must be relative to the current workspace");
  }
  const root = resolve(directory);
  const target = resolve(root, requestedPath);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("path must name a file inside the current workspace");
  }
  return target;
}

export const presentArtifactTool = {
  name: "present_artifact",
  description:
    "Actually display an existing workspace artifact in the Open Science Desktop UI. You MUST call this tool when the user asks to show, display, render, preview, or open a file in the conversation or a Screen panel; reading the file or mentioning its path does not display it. Use inline for the conversation. For panel display, target can use the current Screen, create a new Screen with the source conversation, or create a real dedicated Agent Session in a new Screen. The file must already exist, and you must not claim it is displayed unless this call succeeds.",
  input: {
    type: "object",
    properties: {
      path: {
        type: "string",
        minLength: 1,
        description: "Workspace-relative path of the existing image, table, HTML, PDF, document, or other previewable file.",
      },
      display: {
        type: "string",
        enum: ["inline", "panel"],
        description: "inline renders at this point in the conversation; panel creates a dedicated artifact panel.",
      },
      placement: {
        type: "string",
        enum: ["right", "bottom"],
        description:
          "Where the panel goes relative to the conversation: right (side by side) or bottom (below it). Pass bottom whenever the user asks for the artifact below, underneath, or in a bottom panel; an already open panel moves to the side you pass. Ignored for inline display. Defaults to right.",
      },
      target: {
        type: "string",
        enum: ["current-screen", "new-screen", "new-session"],
        description:
          "Panel destination: use the current Screen, create a new Screen, or create a dedicated Agent Session in a new Screen. Ignored for inline display. Defaults to current-screen.",
      },
      title: {
        type: "string",
        minLength: 1,
        maxLength: 160,
        description: "Optional concise title shown above the artifact. Defaults to the filename.",
      },
    },
    required: ["path", "display"],
    additionalProperties: false,
  },
} as const;

/** Run the tool for a session working in `directory`. */
export async function presentArtifact(directory: string, args: PresentInput): Promise<string> {
  const target = workspacePath(directory, args.path);
  const metadata = await stat(target);
  if (!metadata.isFile()) {
    throw new Error("path must name an existing file");
  }
  const placement = args.placement ?? "right";
  const presentationTarget = args.target ?? "current-screen";
  return JSON.stringify({
    presented: true,
    path: args.path,
    display: args.display,
    ...(args.display === "panel" ? { placement, target: presentationTarget } : {}),
    ...(args.title ? { title: args.title } : {}),
  });
}
