// Derives the id a custom endpoint gets in OpenCode's global config from the
// display name the user typed. The id becomes a JSON key under `provider` and
// rides inside "provider/model" strings, so it stays ASCII — but a display name
// must not have to be (#89).
//
// An ASCII-only name keeps its plain slug, so endpoints added before this
// existed keep the ids they already have. Once a name carries non-ASCII
// characters the slug has dropped information, so a digest of the whole name is
// appended: without it "音云 API" and "星河 API" both collapse to `api`, and the
// second "Add endpoint" silently overwrites the first provider's config.

function isAscii(s: string): boolean {
  for (const ch of s) if (ch.codePointAt(0)! > 0x7f) return false;
  return true;
}

/** FNV-1a over code points — short, stable, and needs no crypto import. */
function digest(s: string): string {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * ASCII config id for a custom endpoint's display name. Returns "" only for a
 * blank name, so callers can treat "" as "the name field is empty".
 */
export function customProviderId(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) return `custom-${digest(trimmed)}`;
  if (isAscii(trimmed)) return slug;
  return `${slug}-${digest(trimmed)}`;
}
