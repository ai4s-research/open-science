import { describe, expect, it } from "vitest";
import i18n, { NAMESPACES } from "./index";
import { DEFAULT_LOCALE, shippedLocales } from "./config";

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/** All leaf key dot-paths in a nested object, with any trailing i18next plural
 *  suffix stripped so plural variants collapse to one base key. */
function baseKeyPaths(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") {
    return [prefix.replace(PLURAL_SUFFIX, "")];
  }
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    baseKeyPaths(v, prefix ? `${prefix}.${k}` : k),
  );
}

function baseKeysFor(locale: string): Set<string> {
  const all: string[] = [];
  for (const ns of NAMESPACES) {
    const bundle = i18n.getResourceBundle(locale, ns) ?? {};
    all.push(...baseKeyPaths(bundle).map((p) => `${ns}.${p}`));
  }
  return new Set(all);
}

describe("locale key parity (base keys)", () => {
  const english = baseKeysFor(DEFAULT_LOCALE);
  const others = shippedLocales().map((l) => l.code).filter((c) => c !== DEFAULT_LOCALE);

  it.each(others)("%s has exactly the English base-key set", (code) => {
    const theirs = baseKeysFor(code);
    const missing = [...english].filter((k) => !theirs.has(k));
    const extra = [...theirs].filter((k) => !english.has(k));
    expect({ code, missing, extra }).toEqual({ code, missing: [], extra: [] });
  });

  it.each(shippedLocales().map((locale) => locale.code))(
    "%s includes the model catalog unavailable message",
    (code) => {
      expect(i18n.exists("model.catalogUnavailable", { lng: code, ns: "settings" })).toBe(true);
    },
  );
});
