// The one place this layer starts a child process.
//
// Upstream (Orca) routed every spawn in the app through a much larger chokepoint
// that also resolved `.cmd`/`.bat` shims, built Windows command lines by hand and
// verified process-tree termination. Nothing here spawns a shim: the programs are
// `python3` and an absolute `powershell.exe`, so what survives is the one decision
// that still matters on Windows — never let a console-subsystem child flash its own
// window in front of the user.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { win32 as pathWin32 } from 'node:path'

export type ProcessSpec = {
  /** Program to run. Absolute on Windows: a bare name resolves against the
   *  child's PATH, which under Group Policy can resolve to nothing. */
  program: string
  args?: readonly string[]
  env?: NodeJS.ProcessEnv
}

export function spawnProcess(spec: ProcessSpec): ChildProcessWithoutNullStreams {
  return spawn(spec.program, [...(spec.args ?? [])], {
    env: spec.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // Why never `shell: true`: it concatenates arguments without escaping (Node
    // itself warns, DEP0190) and it silently makes windowsHide a no-op.
    shell: false
  }) as ChildProcessWithoutNullStreams
}

/** Absolute path to Windows PowerShell. `SystemRoot` is set on every Windows
 *  session; the literal is only a last resort for a stripped environment. */
export function windowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows'
  // win32 joins deliberately: these paths are only ever spawned on Windows, but
  // they are also built off-platform by tests, where the host separator would
  // produce `C:\Windows/System32/...`.
  return pathWin32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}
