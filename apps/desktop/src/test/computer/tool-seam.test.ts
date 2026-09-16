// @vitest-environment node
// The seam this app added on top of the ported provider layer: the translation
// from the `computer` tool's arguments to provider params, and the text the
// model reads back. The provider layer itself is covered by the ported tests
// beside this file.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { providerParams, runComputerVerb } from '../../../../../runtime/computer/index'
import { formatComputerResult } from '../../../../../runtime/computer/format'
import type {
  ComputerActionResult,
  ComputerSnapshotResult
} from '../../../../../runtime/computer/types'

const snapshot: ComputerSnapshotResult['snapshot'] = {
  id: 'snapshot-1',
  app: { name: 'Origin', bundleId: 'com.originlab.origin', pid: 4210 },
  window: { id: 7, index: 0, title: 'Book1', width: 1440, height: 900 },
  coordinateSpace: 'window',
  treeText: '3 button Analyze\n4 textField Column A',
  elementCount: 2,
  focusedElementId: 4
}

function actionResult(
  action: ComputerActionResult['action']
): ComputerActionResult {
  return {
    snapshot,
    screenshot: null,
    screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' },
    action
  }
}

describe('providerParams', () => {
  it('asks for no screenshot unless the model asked for one', () => {
    expect(providerParams({ app: 'Origin' }).noScreenshot).toBe(true)
    expect(providerParams({ app: 'Origin', screenshot: false }).noScreenshot).toBe(true)
    expect(providerParams({ app: 'Origin', screenshot: true }).noScreenshot).toBe(false)
  })

  it('renames actionName, because `action` is the verb at the tool boundary', () => {
    const params = providerParams({ app: 'Origin', elementIndex: 3, actionName: 'AXPress' })
    expect(params.action).toBe('AXPress')
    expect(params.actionName).toBeUndefined()
  })

  it('drops arguments the providers do not take', () => {
    const params = providerParams({ app: 'Origin', screenshot: true, nonsense: 'x' })
    expect(params).not.toHaveProperty('nonsense')
    expect(params).not.toHaveProperty('screenshot')
  })

  it('passes absent optional arguments as absent, not as undefined keys', () => {
    expect(Object.keys(providerParams({ app: 'Origin' })).sort()).toEqual(['app', 'noScreenshot'])
  })
})

describe('runComputerVerb', () => {
  const provider = {
    capabilities: vi.fn(async () => ({ provider: 'test' })),
    listApps: vi.fn(async () => ({ apps: [] })),
    listWindows: vi.fn(async () => ({ windows: [] })),
    snapshot: vi.fn(async () => ({ snapshot })),
    action: vi.fn(async (_method: string, _params: unknown) => actionResult(undefined))
  }

  beforeEach(() => {
    vi.resetModules()
    for (const fn of Object.values(provider)) {
      fn.mockClear()
    }
  })
  afterEach(() => {
    vi.doUnmock('../../../../../runtime/computer/computer-provider-lifecycle')
  })

  async function withProvider(current: unknown) {
    vi.doMock('../../../../../runtime/computer/computer-provider-lifecycle', () => ({
      currentComputerProvider: () => current,
      shutdownComputerProviders: () => {}
    }))
    return await import('../../../../../runtime/computer/index')
  }

  it('routes every action verb to the provider method the native side answers to', async () => {
    const { runComputerVerb: run } = await withProvider(provider)
    const expected: [string, string][] = [
      ['click', 'click'],
      ['perform_action', 'performSecondaryAction'],
      ['set_value', 'setValue'],
      ['type_text', 'typeText'],
      ['press_key', 'pressKey'],
      ['hotkey', 'hotkey'],
      ['paste_text', 'pasteText'],
      ['scroll', 'scroll'],
      ['drag', 'drag']
    ]
    for (const [verb, method] of expected) {
      provider.action.mockClear()
      await run(verb as never, { app: 'Origin' })
      expect(provider.action.mock.calls[0]?.[0]).toBe(method)
    }
  })

  it('says computer use is unavailable rather than throwing something opaque', async () => {
    const { runComputerVerb: run } = await withProvider(null)
    await expect(run('list_apps', {})).rejects.toMatchObject({
      code: 'unsupported_capability'
    })
  })

  it('is not mocked in the imported-once module, so the real one still resolves', async () => {
    // Guards against the mock above leaking: the top-level import must remain
    // the real module for the other suites in this file.
    expect(typeof runComputerVerb).toBe('function')
  })
})

describe('formatComputerResult', () => {
  it('says the tree is still being built rather than that the app is empty', () => {
    // A Chromium app with accessibility switched off answers the enabling read
    // with a window, a container and three traffic-light buttons. Read as-is,
    // that says "nothing to act on" — and an agent then goes to coordinates or
    // gives up, which is what happened with Doubao.
    const { output } = formatComputerResult({
      verb: 'get_state',
      state: {
        snapshot: {
          ...snapshot,
          elementCount: 5,
          manualAccessibilityJustEnabled: true
        },
        screenshot: null,
        screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' }
      }
    })
    expect(output).toContain('read the state again')
    expect(output).toContain('NOT an app that exposes nothing')
    expect(output).not.toContain('visible')
  })

  it('goes back to the ordinary count once the tree is there', () => {
    const { output } = formatComputerResult({
      verb: 'get_state',
      state: {
        snapshot: { ...snapshot, elementCount: 55, manualAccessibilityJustEnabled: true },
        screenshot: null,
        screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' }
      }
    })
    expect(output).toContain('55 visible')
    expect(output).not.toContain('read the state again')
  })

  it('puts the tree last, under a header naming app, window and focus', () => {
    const { output } = formatComputerResult({
      verb: 'get_state',
      state: { snapshot, screenshot: null, screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' } }
    })
    expect(output).toContain('com.originlab.origin')
    expect(output).toContain('windowId 7')
    expect(output).toContain('focus on element 4')
    expect(output.endsWith(snapshot.treeText)).toBe(true)
  })

  it('reports a verified action as completed, with the property that was read back', () => {
    const { output } = formatComputerResult({
      verb: 'set_value',
      action: actionResult({
        path: 'accessibility',
        verification: { state: 'verified', property: 'value' }
      })
    })
    expect(output).toContain('set_value completed via accessibility, verified value')
    expect(output).not.toContain('Do not report this as done')
  })

  it('refuses to let an unverified action read as success', () => {
    const { output } = formatComputerResult({
      verb: 'type_text',
      action: actionResult({
        path: 'synthetic',
        verification: { state: 'unverified', reason: 'synthetic_input' }
      })
    })
    expect(output).toContain('type_text attempted via synthetic, unverified (synthetic input)')
    expect(output).toContain('Do not report this as done')
  })

  it('treats missing verification metadata as unverified, not as success', () => {
    const { output } = formatComputerResult({ verb: 'click', action: actionResult(undefined) })
    expect(output).toContain('unverified (verification metadata unavailable)')
    expect(output).toContain('Do not report this as done')
  })

  it('names an accessibility action that was never asserted', () => {
    const { output } = formatComputerResult({
      verb: 'click',
      action: actionResult({ path: 'accessibility' })
    })
    expect(output).toContain('unverified (accessibility action unasserted)')
  })

  it('writes a captured screenshot to a file and reports its path, not its bytes', () => {
    const data = Buffer.from(
      '89504e470d0a1a0a0000000d49484452',
      'hex'
    ).toString('base64')
    const { output, screenshotPath } = formatComputerResult({
      verb: 'get_state',
      state: {
        snapshot,
        screenshot: { data, format: 'png', width: 2880, height: 1800, scale: 2 },
        screenshotStatus: { state: 'captured' }
      }
    })
    expect(screenshotPath).toMatch(/\.png$/)
    expect(output).toContain(screenshotPath as string)
    expect(output).not.toContain(data)
    expect(output).toContain('divided by 2')
  })

  it('passes a screenshot failure through with its code, so the recovery is known', () => {
    const { output, screenshotPath } = formatComputerResult({
      verb: 'get_state',
      state: {
        snapshot,
        screenshot: null,
        screenshotStatus: {
          state: 'failed',
          code: 'screenshot_failed',
          message: 'Screen Recording permission is required'
        }
      }
    })
    expect(screenshotPath).toBeNull()
    expect(output).toContain('screenshot: failed (screenshot_failed)')
  })
})

describe('provider discovery', () => {
  const previous = process.env.OPENSCIENCE_COMPUTER_USE_DIR

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.OPENSCIENCE_COMPUTER_USE_DIR
    } else {
      process.env.OPENSCIENCE_COMPUTER_USE_DIR = previous
    }
  })

  it('finds nothing when the app did not say where the providers are', async () => {
    delete process.env.OPENSCIENCE_COMPUTER_USE_DIR
    const { resolveDesktopScriptProviderPath } = await import(
      '../../../../../runtime/computer/desktop-script-provider-paths'
    )
    expect(resolveDesktopScriptProviderPath('linux')).toBeNull()
    expect(resolveDesktopScriptProviderPath('windows')).toBeNull()
  })

  it('reads each platform its own script out of the one staged directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'osd-computer-use-test-'))
    await writeFile(join(dir, 'runtime.py'), '', 'utf8')
    process.env.OPENSCIENCE_COMPUTER_USE_DIR = dir
    const { resolveDesktopScriptProviderPath } = await import(
      '../../../../../runtime/computer/desktop-script-provider-paths'
    )
    expect(resolveDesktopScriptProviderPath('linux')).toBe(join(dir, 'runtime.py'))
    // Staged but absent on this machine: reported as missing, not as a path that
    // would fail later at spawn time.
    expect(resolveDesktopScriptProviderPath('windows')).toBeNull()
    await rm(dir, { recursive: true, force: true })
  })

  it('points at the helper executable inside the macOS app bundle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'osd-computer-use-test-'))
    const app = join(dir, 'Open Science Computer Use.app')
    await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true })
    await writeFile(join(app, 'Contents', 'MacOS', 'osd-computer-use-macos'), '', 'utf8')
    process.env.OPENSCIENCE_COMPUTER_USE_DIR = dir
    const { resolveMacOSComputerUseExecutablePath } = await import(
      '../../../../../runtime/computer/macos-native-provider-paths'
    )
    expect(resolveMacOSComputerUseExecutablePath()).toBe(
      join(app, 'Contents', 'MacOS', 'osd-computer-use-macos')
    )
    await rm(dir, { recursive: true, force: true })
  })
})
