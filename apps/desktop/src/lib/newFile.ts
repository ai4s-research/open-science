// Creating the file a new pane will hold.
//
// A "New Markdown" or "New Notebook" that opened an unsaved buffer would be a
// lie in a workbench whose whole point is that the work is real files on disk
// the agent can also see. So each one writes the file first and the pane opens
// what exists.
import { addTextToWorkspace } from "./tauri";
import { emptyIpynb } from "./notebook-file";
import type { KernelLanguage } from "./kernel";

/** A brand-new notebook in the workspace. Returns its workspace-relative path. */
export async function createNotebook(language: KernelLanguage = "python"): Promise<string> {
  const base = language === "r" ? "notebook-r.ipynb" : "notebook.ipynb";
  // The workspace picks a free name; two "New Notebook" clicks must not have
  // the second silently overwrite the first.
  return addTextToWorkspace(base, emptyIpynb(language));
}

/** A brand-new markdown file in the workspace. */
export async function createMarkdown(): Promise<string> {
  return addTextToWorkspace("note.md", "");
}
