import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { OPENCODE_VERSION } from "@ai4s/sdk";

/**
 * The pinned runtime version lives in three places that must agree: the SDK
 * constant (which the app now DISPLAYS in Settings, so a user can tell the
 * bundled runtime from their own OpenCode install), the script that downloads
 * the sidecar, and the script that installs the matching plugin SDK. #74 was
 * caused by a stale pin; a pin that disagrees with itself would be worse — the
 * app would confidently report a version it is not running.
 */
describe("pinned OpenCode version", () => {
  const root = resolve(process.cwd(), "../..");
  const read = (path: string) => readFileSync(resolve(root, path), "utf8");

  it("is a bare semver", () => {
    expect(OPENCODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("matches the sidecar download script", () => {
    const script = read("scripts/dev/fetch-opencode.sh");
    expect(script).toContain(`OPENCODE_VERSION="\${OPENCODE_VERSION:-${OPENCODE_VERSION}}"`);
  });

  it("matches the plugin SDK the goal-plugin bundle installs", () => {
    // OpenCode loads the plugin SDK from beside the configured plugin; a version
    // drifting from the runtime is exactly the class of mismatch #74 was about.
    const script = read("scripts/dev/fetch-goal-plugin.sh");
    expect(script).toContain(
      `OPENCODE_PLUGIN_VERSION="\${OPENCODE_PLUGIN_VERSION:-${OPENCODE_VERSION}}"`,
    );
  });
});
