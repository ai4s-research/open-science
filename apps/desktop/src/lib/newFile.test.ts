import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMarkdown, createNotebook } from "./newFile";

const addTextToWorkspace = vi.fn();
vi.mock("./tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tauri")>()),
  addTextToWorkspace: (...args: unknown[]) => addTextToWorkspace(...args),
}));

describe("creating the file a new pane will hold", () => {
  beforeEach(() => {
    addTextToWorkspace.mockReset();
    // The workspace answers with the name it actually used, which may differ
    // from the one asked for when that name is taken.
    addTextToWorkspace.mockImplementation((name: string) => Promise.resolve(name));
  });

  it("writes a real notebook to the workspace, not an unsaved buffer", async () => {
    const path = await createNotebook();

    expect(path).toBe("notebook.ipynb");
    const [name, content] = addTextToWorkspace.mock.calls[0]!;
    expect(name).toBe("notebook.ipynb");
    // Valid ipynb: the pane opens what is on disk, and the agent can read it.
    const parsed = JSON.parse(content as string);
    expect(parsed.nbformat).toBe(4);
    expect(parsed.metadata.kernelspec.language).toBe("python");
    expect(Array.isArray(parsed.cells)).toBe(true);
  });

  it("makes an R notebook when asked for one", async () => {
    await createNotebook("r");

    const [name, content] = addTextToWorkspace.mock.calls[0]!;
    expect(name).toBe("notebook-r.ipynb");
    expect(JSON.parse(content as string).metadata.kernelspec.language).toBe("r");
  });

  it("writes an empty markdown file", async () => {
    const path = await createMarkdown();

    expect(path).toBe("note.md");
    expect(addTextToWorkspace).toHaveBeenCalledWith("note.md", "");
  });

  it("returns the name the workspace chose, so the pane opens the right file", async () => {
    // Two "New Notebook" clicks must not have the second open the first's file.
    addTextToWorkspace.mockResolvedValueOnce("notebook-2.ipynb");
    expect(await createNotebook()).toBe("notebook-2.ipynb");
  });
});
