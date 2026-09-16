// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { computerProviderUnavailableMessage } from '../../../../../runtime/computer/computer-provider-unavailable-message'

describe('computerProviderUnavailableMessage', () => {
  it('gives macOS developers the helper build and restart step', () => {
    expect(computerProviderUnavailableMessage('darwin')).toContain(
      'run scripts/dev/build-computer-use.sh and restart the app'
    )
    expect(computerProviderUnavailableMessage('darwin')).toContain(
      'Open Science Computer Use.app was not found or this macOS version is unsupported'
    )
  })

  it('keeps unsupported platforms explicit', () => {
    expect(computerProviderUnavailableMessage('freebsd')).toBe(
      'computer-use has no native provider for freebsd'
    )
  })
})
