import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type net from 'node:net'
import { release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { connectMacOSProviderSocket } from './macos-native-provider-socket'
import { RuntimeClientError } from './runtime-client-error'

const HELPER_CONNECT_TIMEOUT_MS = 10_000
const HELPER_LAUNCH_TIMEOUT_MS = 10_000

export type StartedMacOSProviderSocket = {
  socket: net.Socket
  socketDirectory: string
  socketPath: string
  socketToken: string
}

export function isMacOS14OrNewer(): boolean {
  const darwinMajor = Number.parseInt(release().split('.')[0] ?? '', 10)
  return Number.isFinite(darwinMajor) && darwinMajor >= 23
}

// Why: Node treats unhandled socket 'error' events as process exceptions, so
// stale helper sockets keep a no-op listener that does not retain the client.
export function ignoreStaleSocketError(): void {}

export function attachMacOSNativeProviderSocketListeners(
  socket: net.Socket,
  listeners: {
    data: (chunk: string) => void
    close: () => void
    error: (error: Error) => void
  }
): () => void {
  socket.on('data', listeners.data)
  socket.on('close', listeners.close)
  socket.on('error', listeners.error)
  return () => {
    socket.off('data', listeners.data)
    socket.off('close', listeners.close)
    socket.off('error', listeners.error)
    socket.off('error', ignoreStaleSocketError)
    socket.on('error', ignoreStaleSocketError)
  }
}

export class NativeProviderLineBuffer {
  private pending = ''
  private hasCompleteLine = false

  push(chunk: string, handleLine: (line: string) => void): void {
    this.pending += chunk
    this.hasCompleteLine ||= chunk.endsWith('\n') || chunk.includes('\n')
    if (!this.hasCompleteLine) {
      return
    }
    // Keep complete lines retryable if a callback throws.
    this.pending = consumeNativeProviderLines(this.pending, handleLine)
    this.hasCompleteLine = false
  }

  clear(): void {
    this.pending = ''
    this.hasCompleteLine = false
  }
}

export function consumeNativeProviderLines(
  buffer: string,
  handleLine: (line: string) => void
): string {
  let remaining = buffer
  while (true) {
    const newline = remaining.indexOf('\n')
    if (newline === -1) {
      return remaining
    }
    const line = remaining.slice(0, newline)
    remaining = remaining.slice(newline + 1)
    if (line.trim()) {
      handleLine(line)
    }
  }
}

export async function startMacOSNativeProviderSocket({
  helperAppPath,
  isCurrent
}: {
  helperAppPath: string
  isCurrent: (socketPath: string) => boolean
}): Promise<StartedMacOSProviderSocket> {
  const socketDirectory = mkdtempSync(join(tmpdir(), 'osd-computer-use-'))
  chmodSync(socketDirectory, 0o700)
  const socketPath = join(socketDirectory, 'provider.sock')
  const socketToken = randomUUID()
  const socketTokenPath = join(socketDirectory, 'provider.token')
  writeFileSync(socketTokenPath, socketToken, { encoding: 'utf8', mode: 0o600 })
  const connectAbort = new AbortController()
  try {
    await launchProviderApp(helperAppPath, socketPath, socketTokenPath)
    const socket = await connectMacOSProviderSocket(
      socketPath,
      HELPER_CONNECT_TIMEOUT_MS,
      connectAbort.signal
    )
    rmSync(socketTokenPath, { force: true })
    if (!isCurrent(socketPath)) {
      socket.destroy()
      cleanupSocketDirectory(socketDirectory)
      throw new RuntimeClientError(
        'accessibility_error',
        'native macOS provider startup was superseded'
      )
    }
    return { socket, socketDirectory, socketPath, socketToken }
  } catch (error) {
    connectAbort.abort()
    if (isCurrent(socketPath)) {
      cleanupSocketDirectory(socketDirectory)
    }
    throw error
  }
}

function cleanupSocketDirectory(socketDirectory: string): void {
  rmSync(socketDirectory, { recursive: true, force: true })
}

/**
 * Start the helper through LaunchServices, and NOT as a child process.
 *
 * This is the whole reason the helper can hold its own permissions. macOS
 * attributes a TCC request to the "responsible process", which for a directly
 * spawned child is an ancestor — measured on macOS 26: the same signed helper
 * bundle, with Accessibility granted, reports `not-granted` when exec'd as a
 * child and `granted` when launched with `open`. Spawning it directly would
 * silently put the workbench's own (absent) grants in charge and deny every
 * call.
 *
 * `open` returns as soon as the launch is accepted, so a zero exit means
 * "started", not "connected" — the socket connect below is what proves it came
 * up. The helper's parent is then launchd, which is why it is told our pid
 * rather than reading `getppid()`.
 */
function launchProviderApp(
  helperAppPath: string,
  socketPath: string,
  socketTokenPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/open',
      [
        '-n',
        helperAppPath,
        '--args',
        '--agent',
        socketPath,
        '--token-file',
        socketTokenPath,
        '--client-pid',
        String(process.pid)
      ],
      { timeout: HELPER_LAUNCH_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve()
          return
        }
        const detail = stderr.trim() || error.message
        reject(
          new RuntimeClientError(
            'accessibility_error',
            `native macOS helper app failed to start: ${detail}`
          )
        )
      }
    )
  })
}
