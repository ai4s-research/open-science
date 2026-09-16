// Computer use: one call into whichever native provider this platform has.
//
// Ported from Orca (github.com/stablyai/orca, MIT) — accessibility tree first,
// pixels only when asked for. Everything below the dispatch is that port; this
// file is the seam the agent's `computer` tool calls.
import { currentComputerProvider } from './computer-provider-lifecycle'
import { computerProviderUnavailableMessage } from './computer-provider-unavailable-message'
import type { NativeActionMethod } from './macos-native-provider-contract'
import { RuntimeClientError } from './runtime-client-error'
import type {
  ComputerActionResult,
  ComputerListAppsResult,
  ComputerListWindowsResult,
  ComputerProviderCapabilities,
  ComputerSnapshotResult
} from './types'

/** Every verb the tool accepts. The first four only look; the rest change the
 *  user's desktop. */
export const COMPUTER_VERBS = [
  'capabilities',
  'list_apps',
  'list_windows',
  'get_state',
  'click',
  'perform_action',
  'set_value',
  'type_text',
  'press_key',
  'hotkey',
  'paste_text',
  'scroll',
  'drag'
] as const

export type ComputerVerb = (typeof COMPUTER_VERBS)[number]
export type ObserveVerb = 'capabilities' | 'list_apps' | 'list_windows' | 'get_state'
export type ActionVerb = Exclude<ComputerVerb, ObserveVerb>

/** Verb → the method name the native providers answer to. Typed as a total map
 *  so adding a verb above without wiring it here fails to compile. */
const ACTION_METHODS: Record<ActionVerb, NativeActionMethod> = {
  click: 'click',
  perform_action: 'performSecondaryAction',
  set_value: 'setValue',
  type_text: 'typeText',
  press_key: 'pressKey',
  hotkey: 'hotkey',
  paste_text: 'pasteText',
  scroll: 'scroll',
  drag: 'drag'
}

export type ComputerResult =
  | { verb: 'capabilities'; capabilities: ComputerProviderCapabilities }
  | { verb: 'list_apps'; apps: ComputerListAppsResult }
  | { verb: 'list_windows'; windows: ComputerListWindowsResult }
  | { verb: 'get_state'; state: ComputerSnapshotResult }
  | { verb: ActionVerb; action: ComputerActionResult }

/** Arguments the provider understands, the ones the tool names, and the one
 *  place they are translated. Anything else the model sent is dropped here
 *  rather than being passed to a native provider that has no use for it. */
const PASSED_THROUGH = [
  'app',
  'windowId',
  'windowIndex',
  'restoreWindow',
  'elementIndex',
  'x',
  'y',
  'clickCount',
  'mouseButton',
  'modifiers',
  'value',
  'text',
  'key',
  'direction',
  'pages',
  'fromElementIndex',
  'toElementIndex',
  'fromX',
  'fromY',
  'toX',
  'toY'
] as const

export function providerParams(args: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const key of PASSED_THROUGH) {
    if (args[key] !== undefined) {
      params[key] = args[key]
    }
  }
  // The provider's flag is the negative one. The tool asks the positive question
  // and defaults to no screenshot: the tree is what actions are chosen from, and
  // an image nobody asked for is pure cost.
  params.noScreenshot = args.screenshot !== true
  // `action` is the verb at the tool's boundary, so the accessibility action
  // name arrives under a different one.
  if (args.actionName !== undefined) {
    params.action = args.actionName
  }
  return params
}

export async function runComputerVerb(
  verb: ComputerVerb,
  args: Record<string, unknown>
): Promise<ComputerResult> {
  const params = providerParams(args)
  const provider = currentComputerProvider()
  if (!provider) {
    throw new RuntimeClientError(
      'unsupported_capability',
      computerProviderUnavailableMessage(process.platform)
    )
  }
  switch (verb) {
    case 'capabilities':
      return { verb, capabilities: await provider.capabilities() }
    case 'list_apps':
      return { verb, apps: await provider.listApps() }
    case 'list_windows':
      return { verb, windows: await provider.listWindows(params) }
    case 'get_state':
      return { verb, state: await provider.snapshot(params) }
    default:
      return { verb, action: await provider.action(ACTION_METHODS[verb], params) }
  }
}

export { shutdownComputerProviders } from './computer-provider-lifecycle'
export { RuntimeClientError } from './runtime-client-error'
export type * from './types'
