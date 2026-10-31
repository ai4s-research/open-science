import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { OPENCODE_VERSION } from "@ai4s/sdk";

/**
 * The pinned runtime version lives in two places that must agree: the SDK
 * constant (which the app DISPLAYS in Settings, so a user can tell the bundled
 * runtime from their own OpenCode install) and the script that downloads the
 * sidecar. #74 was caused by a stale pin; a pin that disagrees with itself
 * would be worse — the app would confidently report a version it is not
 * running. (OpenCode 2 supplies its plugin SDK itself; nothing else to pin.)
 */
describe("pinned OpenCode version", () => {
  const root = resolve(process.cwd(), "../..");
  const read = (path: string) => readFileSync(resolve(root, path), "utf8");

  it("is a bare semver on OpenCode 2, the API the SDK speaks", () => {
    expect(OPENCODE_VERSION).toMatch(/^2\.\d+\.\d+$/);
  });

  it("matches the sidecar download script", () => {
    const script = read("scripts/dev/fetch-opencode.sh");
    expect(script).toContain(`OPENCODE_VERSION="\${OPENCODE_VERSION:-${OPENCODE_VERSION}}"`);
  });
});
