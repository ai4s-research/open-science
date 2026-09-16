import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { computerUseProviderPath } from './provider-root'

/** The helper's own app bundle. It is a separate bundle, and not a plain binary
 *  inside the app, because macOS grants Accessibility and Screen Recording per
 *  bundle identifier: this is the identity the user sees in System Settings and
 *  the only thing that holds those two grants. */
export const MACOS_COMPUTER_USE_APP_NAME = 'Open Science Computer Use.app'

export const MACOS_COMPUTER_USE_BUNDLE_ID = 'com.ai4s.workbench.computer-use'

export function resolveMacOSComputerUseAppPath(): string | null {
  return computerUseProviderPath(MACOS_COMPUTER_USE_APP_NAME)
}

export function resolveMacOSComputerUseExecutablePath(): string | null {
  const appPath = resolveMacOSComputerUseAppPath()
  if (!appPath) {
    return null
  }
  const executablePath = join(appPath, 'Contents', 'MacOS', 'osd-computer-use-macos')
  return existsSync(executablePath) ? executablePath : null
}
