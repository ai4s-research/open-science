import { describe, expect, it } from "vitest";

import { pathKey, samePath } from "./workspacePath";

describe("pathKey", () => {
  it("matches a Windows project path against the sidecar's session directory", () => {
    // The exact pair from #76: Rust `canonicalize()` vs what OpenCode stored.
    expect(pathKey(String.raw`D:\Openscience-documents\projects\视频总结`)).toBe(
      pathKey("D:/Openscience-documents/projects/视频总结"),
    );
  });

  it("unwraps the verbatim prefix older installs persisted", () => {
    expect(pathKey(String.raw`\\?\D:\Docs\projects\p`)).toBe(pathKey("D:/Docs/projects/p"));
    // A UNC share keeps its root: `\\?\UNC\srv\share` names `\\srv\share`.
    expect(pathKey(String.raw`\\?\UNC\srv\share\work`)).toBe(pathKey(String.raw`\\srv\share\work`));
  });

  it("treats Windows paths as case-insensitive and POSIX paths as case-sensitive", () => {
    expect(pathKey(String.raw`D:\Work`)).toBe(pathKey("d:/work"));
    expect(pathKey(String.raw`\\SRV\Share`)).toBe(pathKey("//srv/share"));
    // Two distinct folders on Linux — collapsing them would group the wrong sessions.
    expect(pathKey("/home/u/Work")).not.toBe(pathKey("/home/u/work"));
  });

  it("ignores a trailing separator but keeps a root's", () => {
    expect(pathKey("/w/proj/")).toBe(pathKey("/w/proj"));
    expect(pathKey("D:\\w\\proj\\")).toBe(pathKey("D:/w/proj"));
    expect(pathKey("/")).toBe("/");
    expect(pathKey("C:\\")).toBe("c:/");
  });

  it("absorbs a stray line break but not a meaningful trailing space", () => {
    expect(pathKey("/w/proj\n")).toBe(pathKey("/w/proj"));
    // A POSIX folder name may end in a space; these are two real directories.
    expect(pathKey("/w/proj ")).not.toBe(pathKey("/w/proj"));
  });

  it("keeps different folders apart", () => {
    expect(pathKey("/w/a")).not.toBe(pathKey("/w/b"));
    // A prefix is not a match: `…/proj2` must not group under `…/proj`.
    expect(pathKey("/w/proj")).not.toBe(pathKey("/w/proj2"));
  });
});

describe("samePath", () => {
  it("compares across path forms", () => {
    expect(samePath(String.raw`D:\Docs\p`, "D:/Docs/p")).toBe(true);
    expect(samePath("/w/a", "/w/b")).toBe(false);
  });

  it("never matches a missing path, not even against itself", () => {
    // A session with no directory belongs to no project — two such sessions must
    // not be grouped together either.
    expect(samePath(null, null)).toBe(false);
    expect(samePath(undefined, "/w/a")).toBe(false);
    expect(samePath("/w/a", "")).toBe(false);
  });
});
