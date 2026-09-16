// V8 SlicedString::kMinLength. Shorter slices are already flat, so copying them
// is pure waste.
const MIN_SLICED_STRING_LENGTH = 13

/**
 * Return a standalone copy of a string that outlives the chunk it came from.
 *
 * Why: `bigChunk.slice(a, b)` is a V8 SlicedString that pins the whole parent, so
 * retaining a few KiB of tail can pin megabytes of already-consumed provider
 * output. Ported from Orca, minus its renderer/mobile fallback — this module only
 * ever runs where `Buffer` exists.
 */
export function ownRetainedString(value: string): string {
  if (value.length < MIN_SLICED_STRING_LENGTH) {
    return value
  }
  return Buffer.from(value, 'utf16le').toString('utf16le')
}
