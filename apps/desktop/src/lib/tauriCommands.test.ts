// @vitest-environment node
//
// Every `invoke("name")` in the frontend must be a command the Rust side
// actually registered. A mismatch is invisible to tsc and to every mocked test
// — the call simply rejects at runtime, and a caller that defends itself with
// `.catch(() => null)` (the right thing for an optional feature) swallows it
// entirely. That is how a wired-up feature can ship doing nothing at all.
//
// Checked by reading the two files rather than by running Tauri, which a unit
// test cannot do.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, "..", "..");

/** Command names the frontend calls, from every `invoke<…>("name")`. */
function invokedNames(): Set<string> {
  const names = new Set<string>();
  for (const file of ["src/lib/tauri.ts", "src/lib/kernel.ts", "src/lib/acpTransport.ts"]) {
    let text: string;
    try {
      text = readFileSync(join(desktop, file), "utf8");
    } catch {
      continue; // an optional module this build does not have
    }
    for (const m of text.matchAll(/invoke(?:<[^>]*>)?\(\s*"([a-z0-9_]+)"/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

/** Command names Rust registered, from the `generate_handler!` list. */
function registeredNames(): Set<string> {
  const text = readFileSync(join(desktop, "src-tauri/src/lib.rs"), "utf8");
  const start = text.indexOf("generate_handler!");
  expect(start).toBeGreaterThan(-1);
  // The macro's bracketed list; commands are written `module::name` or `name`,
  // separated by commas — and the LAST one carries no trailing comma, which a
  // comma-anchored pattern silently drops.
  const list = text.slice(text.indexOf("[", start) + 1, text.indexOf("])", start));
  const names = new Set<string>();
  for (const token of list.split(",")) {
    const name = token.trim().split("::").pop() ?? "";
    if (/^[a-z0-9_]+$/.test(name)) names.add(name);
  }
  return names;
}

describe("Tauri command wiring", () => {
  it("every command the frontend invokes is registered in Rust", () => {
    const invoked = invokedNames();
    const registered = registeredNames();
    // Sanity: the readers found something, so an empty set cannot pass.
    expect(invoked.size).toBeGreaterThan(20);
    expect(registered.size).toBeGreaterThan(20);

    const missing = [...invoked].filter((name) => !registered.has(name)).sort();
    expect(missing).toEqual([]);
  });

  it("covers the #118 bridges specifically", () => {
    // Named rather than left to the sweep above: both are optional-by-design
    // (their callers tolerate a null), so a broken name would show up as the
    // feature quietly never firing.
    const invoked = invokedNames();
    const registered = registeredNames();
    for (const name of ["runtime_failure", "take_config_quarantine_notice"]) {
      expect(invoked.has(name), `${name} is not invoked anywhere`).toBe(true);
      expect(registered.has(name), `${name} is not registered in Rust`).toBe(true);
    }
  });
});
