// @vitest-environment node
// The real macOS helper, over the real socket.
//
// Everything else in this directory tests the host layer against fakes, so a
// wrong assumption about the helper's own protocol would pass. Here the peer is
// the signed app bundle that `scripts/dev/build-computer-use.mjs` produces:
// spawn it, hand it the token, and see what comes back.
//
// Skipped unless that bundle has been built, so a checkout that has not run the
// staging script does not fail. It does NOT skip when macOS has withheld
// Accessibility — the point of the last case is that a missing permission
// arrives as one of the named error codes the skill guide has a recovery for,
// and not as a hang or a crash.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { COMPUTER_ERROR_CODES } from '../../../../../runtime/computer/types'

const providerDir = join(
  import.meta.dirname,
  '../../../../../apps/desktop/src-tauri/computer-use'
)
const helper = join(
  providerDir,
  'Open Science Computer Use.app/Contents/MacOS/osd-computer-use-macos'
)
const staged = process.platform === 'darwin' && existsSync(helper)

describe.skipIf(!staged)('the bundled macOS helper', () => {
  let computer: typeof import('../../../../../runtime/computer/index')

  beforeAll(async () => {
    process.env.OPENSCIENCE_COMPUTER_USE_DIR = providerDir
    computer = await import('../../../../../runtime/computer/index')
  })

  afterAll(() => {
    computer?.shutdownComputerProviders()
  })

  it('handshakes over its own socket and reports what it can do', async () => {
    const result = await computer.runComputerVerb('capabilities', {})
    expect(result.verb).toBe('capabilities')
    const capabilities = (result as { capabilities: Record<string, unknown> }).capabilities
    expect(capabilities.platform).toBe('darwin')
    expect(capabilities.protocolVersion).toBe(1)
    // The contract the host layer negotiates against, not a free-form blob.
    expect(capabilities.supports).toMatchObject({
      actions: expect.objectContaining({ click: expect.any(Boolean) }),
      windows: expect.objectContaining({ list: expect.any(Boolean) })
    })
  }, 30_000)

  it('lists the apps actually running on this machine', async () => {
    const result = await computer.runComputerVerb('list_apps', {})
    const apps = (result as { apps: { apps: { name: string; bundleId: string | null }[] } }).apps
    expect(apps.apps.length).toBeGreaterThan(0)
    // Finder is always running on a Mac with a session, and it is the one entry
    // whose bundle id can be asserted without knowing anything about the host.
    expect(apps.apps.some((app) => app.bundleId === 'com.apple.finder')).toBe(true)
  }, 30_000)

  it('reads an app window, or says exactly why it cannot', async () => {
    try {
      const result = await computer.runComputerVerb('get_state', { app: 'com.apple.finder' })
      const state = (result as { state: { snapshot: { treeText: string } } }).state
      expect(typeof state.snapshot.treeText).toBe('string')
    } catch (error) {
      // No Accessibility grant is the normal state on a fresh machine and on CI.
      // What must hold either way is that the failure is a named code with a
      // documented recovery.
      const code = (error as { code?: string }).code
      expect(Object.keys(COMPUTER_ERROR_CODES)).toContain(code)
      expect(['permission_denied', 'accessibility_error', 'window_not_found']).toContain(code)
    }
  }, 60_000)
})
