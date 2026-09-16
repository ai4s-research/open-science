// What the agent actually reads back from a computer-use call.
//
// The accessibility tree is the answer; the rest is one header telling the model
// which window it is looking at, whether the action it just ran can be proven to
// have landed, and where the screenshot went when it asked for one. The
// verification vocabulary is Orca's, kept word-for-word because the skill guide's
// rules are written against it.
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActionVerb, ComputerResult } from './index'
import type {
  ComputerActionMetadata,
  ComputerScreenshotData,
  ComputerScreenshotStatus,
  ComputerSnapshotData,
  ComputerSnapshotResult
} from './types'

/** Screenshots are throwaway: the model reads one and moves on. */
const SCREENSHOT_DIR = join(tmpdir(), 'osd-computer-use-screenshots')
const SCREENSHOT_MAX_AGE_MS = 60 * 60 * 1000

export type FormattedComputerResult = {
  output: string
  /** Set when a screenshot was asked for and captured, so the caller can hand
   *  the image itself to the model rather than only its path. */
  screenshotPath: string | null
}

export function formatComputerResult(result: ComputerResult): FormattedComputerResult {
  switch (result.verb) {
    case 'capabilities':
      return { output: JSON.stringify(result.capabilities, null, 2), screenshotPath: null }
    case 'list_apps':
      return { output: JSON.stringify(result.apps, null, 2), screenshotPath: null }
    case 'list_windows':
      return { output: JSON.stringify(result.windows, null, 2), screenshotPath: null }
    case 'get_state':
      return formatSnapshot(result.state, null)
    default:
      return formatSnapshot(result.action, formatAction(result.verb, result.action.action))
  }
}

function formatSnapshot(
  result: ComputerSnapshotResult,
  actionLine: string | null
): FormattedComputerResult {
  const screenshotPath = saveScreenshot(result.screenshot, result.screenshotStatus)
  const lines = [formatTarget(result.snapshot)]
  if (actionLine) {
    lines.push(actionLine)
  }
  lines.push(formatElements(result.snapshot))
  lines.push(formatScreenshot(result.screenshot, result.screenshotStatus, screenshotPath))
  return {
    output: `${lines.join('\n')}\n\n${result.snapshot.treeText}`,
    screenshotPath
  }
}

function formatTarget(snapshot: ComputerSnapshotData): string {
  const { app, window } = snapshot
  const identity = app.bundleId ? `${app.name} (${app.bundleId}, pid ${app.pid})` : `${app.name} (pid ${app.pid})`
  const target =
    window.id !== null && window.id !== undefined
      ? `windowId ${window.id}`
      : window.index !== null && window.index !== undefined
        ? `windowIndex ${window.index}`
        : 'no window handle'
  return `app: ${identity} — window "${window.title}" ${window.width}x${window.height}, ${target}`
}

/** The tree a Chromium app shows before it has built a real one. */
const MANUAL_ACCESSIBILITY_STUB_ELEMENTS = 5

function formatElements(snapshot: ComputerSnapshotData): string {
  if (
    snapshot.manualAccessibilityJustEnabled &&
    snapshot.elementCount <= MANUAL_ACCESSIBILITY_STUB_ELEMENTS
  ) {
    // Without this the model reads five elements — a window, a container and the
    // traffic lights — and concludes the app cannot be driven, which is what
    // happened. The tree is coming; it just is not here yet.
    return (
      `elements: ${snapshot.elementCount} — this app keeps its accessibility tree switched off ` +
      'until something asks for it, and it is being built right now. This is NOT an app that ' +
      'exposes nothing: read the state again in a few seconds and the real tree will be here. ' +
      'Do not fall back to coordinates yet.'
    )
  }
  return formatVisibleElements(snapshot)
}

function formatVisibleElements(snapshot: ComputerSnapshotData): string {
  const truncation = snapshot.truncation?.truncated
    ? ` (truncated: the tree is larger than ${snapshot.truncation.maxNodes ?? 'the node cap'} nodes)`
    : ''
  const focused =
    snapshot.focusedElementId === null ? 'nothing focused' : `focus on element ${snapshot.focusedElementId}`
  return `elements: ${snapshot.elementCount} visible, ${focused}${truncation}. Indexes are the numbers in the tree below, are sparse, and go stale after any UI change.`
}

const UNVERIFIED_ACTION_REASONS: Record<ComputerActionMetadata['path'], string> = {
  accessibility: 'accessibility action unasserted',
  clipboard: 'clipboard paste',
  synthetic: 'synthetic input'
}

function formatAction(verb: ActionVerb, action: ComputerActionMetadata | undefined): string {
  const verification = formatVerification(action)
  const via = action?.path ? ` via ${action.path}` : ''
  const verified = action?.verification?.state === 'verified'
  const outcome = verified ? 'completed' : 'attempted'
  const warning = verified
    ? ''
    : ' Do not report this as done: read the tree below, or take a screenshot, before saying it worked.'
  return `action: ${verb} ${outcome}${via}, ${verification}.${warning}`
}

function formatVerification(action: ComputerActionMetadata | undefined): string {
  if (!action) {
    return 'unverified (verification metadata unavailable)'
  }
  const verification = action.verification
  if (!verification) {
    return `unverified (${UNVERIFIED_ACTION_REASONS[action.path]})`
  }
  if (verification.state === 'verified') {
    return `verified ${verification.property}`
  }
  return `unverified (${verification.reason.split('_').join(' ')})`
}

function formatScreenshot(
  screenshot: ComputerScreenshotData | null,
  status: ComputerScreenshotStatus,
  path: string | null
): string {
  if (status.state === 'skipped') {
    return 'screenshot: not requested.'
  }
  if (status.state === 'failed') {
    return `screenshot: failed (${status.code}): ${status.message}`
  }
  if (!screenshot) {
    return 'screenshot: reported captured but no image came back.'
  }
  if (!path) {
    return 'screenshot: captured but could not be saved to disk.'
  }
  const scale =
    Number.isFinite(screenshot.scale) && screenshot.scale > 0 && screenshot.scale !== 1
      ? ` Scale is ${screenshot.scale}: an action x/y is a screenshot pixel divided by ${screenshot.scale}.`
      : ''
  return `screenshot: ${path} (${screenshot.width}x${screenshot.height}).${scale}`
}

/** Write the image out and hand back a path. Returning base64 through a tool
 *  result would put a megabyte of it in the transcript. */
function saveScreenshot(
  screenshot: ComputerScreenshotData | null,
  status: ComputerScreenshotStatus
): string | null {
  if (status.state !== 'captured' || !screenshot) {
    return null
  }
  if (screenshot.path) {
    return screenshot.path
  }
  if (!screenshot.data) {
    return null
  }
  try {
    mkdirSync(SCREENSHOT_DIR, { recursive: true, mode: 0o700 })
    pruneScreenshots()
    const path = join(SCREENSHOT_DIR, `${Date.now()}-${process.pid}.png`)
    writeFileSync(path, Buffer.from(screenshot.data, 'base64'), { mode: 0o600 })
    return path
  } catch {
    return null
  }
}

function pruneScreenshots(): void {
  const cutoff = Date.now() - SCREENSHOT_MAX_AGE_MS
  try {
    for (const entry of readdirSync(SCREENSHOT_DIR)) {
      if (!entry.endsWith('.png')) {
        continue
      }
      const path = join(SCREENSHOT_DIR, entry)
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path, { force: true })
      }
    }
  } catch {
    // A screenshot that cannot be tidied up is not a reason to lose the one
    // being taken now.
  }
}
