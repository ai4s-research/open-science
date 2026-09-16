import { computerUseProviderPath } from './provider-root'

export type DesktopScriptPlatform = 'linux' | 'windows'

export function desktopScriptPlatform(): DesktopScriptPlatform | null {
  if (process.platform === 'linux') {
    return 'linux'
  }
  if (process.platform === 'win32') {
    return 'windows'
  }
  return null
}

export function resolveDesktopScriptProviderPath(
  platform = desktopScriptPlatform()
): string | null {
  if (!platform) {
    return null
  }
  return computerUseProviderPath(platform === 'windows' ? 'runtime.ps1' : 'runtime.py')
}
