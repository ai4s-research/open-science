import { RuntimeClientError } from './runtime-client-error'

/** Ceiling on text handed to the clipboard for a paste action. */
const CLIPBOARD_TEXT_WRITE_MAX_BYTES = 16 * 1024 * 1024

const CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR = 'Clipboard text is too large to copy safely.'

/**
 * Reject a paste payload that is too large to put on the clipboard.
 *
 * Upstream (Orca) measured this incrementally and yielded to the event loop
 * between batches, because the check ran on an Electron main process that was
 * also drawing a UI. Here it runs inside the agent's own tool process, where a
 * single `Buffer.byteLength` blocks nothing worth protecting.
 */
export function validateComputerClipboardPasteText(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > CLIPBOARD_TEXT_WRITE_MAX_BYTES) {
    throw new RuntimeClientError('invalid_argument', CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR)
  }
}
