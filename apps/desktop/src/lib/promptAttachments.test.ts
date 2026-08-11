import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactFile } from "./artifactFile";
import { imageAttachmentParts } from "./promptAttachments";
import * as artifactFile from "./artifactFile";

const file = (over: Partial<ArtifactFile>): ArtifactFile => ({
  path: "x",
  mime: "image/png",
  encoding: "base64",
  data: "AAAA",
  size: 4,
  ...over,
});

describe("imageAttachmentParts", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("sends an image as a data-URL part (a file:// url loses the whole turn)", async () => {
    vi.spyOn(artifactFile, "readArtifact").mockResolvedValue(
      file({ mime: "image/png", data: "UE5H" }),
    );
    expect(await imageAttachmentParts(["figure.png"])).toEqual([
      { filename: "figure.png", mime: "image/png", url: "data:image/png;base64,UE5H" },
    ]);
  });

  it("reads nothing when there are no attachments", async () => {
    const read = vi.spyOn(artifactFile, "readArtifact");
    expect(await imageAttachmentParts([])).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it("leaves non-images to the agent's own file tools", async () => {
    vi.spyOn(artifactFile, "readArtifact").mockResolvedValue(
      file({ mime: "text/csv", encoding: "utf8", data: "a,b" }),
    );
    expect(await imageAttachmentParts(["data.csv"])).toEqual([]);
  });

  it("skips an image too large to inline rather than stalling the turn", async () => {
    vi.spyOn(artifactFile, "readArtifact").mockResolvedValue(
      file({ mime: "image/png", size: 64 * 1024 * 1024 }),
    );
    expect(await imageAttachmentParts(["huge.png"])).toEqual([]);
  });

  it("drops an unreadable attachment without failing the others", async () => {
    vi.spyOn(artifactFile, "readArtifact").mockImplementation(async (path) => {
      if (path === "gone.png") throw new Error("ENOENT");
      return file({ mime: "image/jpeg", data: "SkZH" });
    });
    expect(await imageAttachmentParts(["gone.png", "kept.jpg"])).toEqual([
      { filename: "kept.jpg", mime: "image/jpeg", url: "data:image/jpeg;base64,SkZH" },
    ]);
  });

  it("attaches nothing outside the desktop app (readArtifact returns null)", async () => {
    vi.spyOn(artifactFile, "readArtifact").mockResolvedValue(null);
    expect(await imageAttachmentParts(["figure.png"])).toEqual([]);
  });
});
