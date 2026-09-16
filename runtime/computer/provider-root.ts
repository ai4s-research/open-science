import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Directory holding the native computer-use providers, exactly as the app bundles
 * them: `Open Science Computer Use.app` (macOS), `runtime.py` (Linux, AT-SPI) and
 * `runtime.ps1` (Windows, UI Automation).
 *
 * The app exports this when it starts the agent runtime. Unset means this runtime
 * was not started by the app — computer use is then simply unavailable, which the
 * provider lifecycle already reports as such.
 */
export function computerUseProviderPath(name: string): string | null {
  const root = process.env.OPENSCIENCE_COMPUTER_USE_DIR
  if (!root) {
    return null
  }
  const path = join(root, name)
  return existsSync(path) ? path : null
}
