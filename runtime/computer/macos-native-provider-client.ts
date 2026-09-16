import { rmSync } from 'node:fs'
import type net from 'node:net'
import type {
  ComputerActionResult,
  ComputerListAppsResult,
  ComputerListWindowsResult,
  ComputerProviderCapabilities,
  ComputerSnapshotResult
} from './types'
import {
  assertMacOSProviderCapability,
  macOSActionCapabilityKey,
  REQUIRED_MACOS_PROVIDER_PROTOCOL_VERSION,
  type NativeActionMethod,
  type NativeMethod,
  type NativeResponse,
  type PendingNativeRequest,
  writeNativeProviderLine
} from './macos-native-provider-contract'
import { resolveMacOSComputerUseAppPath } from './macos-native-provider-paths'
import {
  attachMacOSNativeProviderSocketListeners,
  NativeProviderLineBuffer,
  startMacOSNativeProviderSocket
} from './macos-native-provider-transport'
import { validateComputerProviderActionParams } from './computer-provider-action-validation'
import { normalizeComputerActionResult } from './computer-action-verification-normalization'
import { RuntimeClientError } from './runtime-client-error'

const REQUEST_TIMEOUT_MS = 60_000

/** A Chromium window before its tree exists: one container plus the three
 *  traffic-light buttons, under the window itself. */
const MANUAL_ACCESSIBILITY_STUB_ELEMENTS = 5
const MANUAL_ACCESSIBILITY_SETTLE_MS = 5_000
const MANUAL_ACCESSIBILITY_POLL_MS = 500

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class MacOSNativeProviderClient {
  private socket: net.Socket | null = null
  private socketStartPromise: Promise<net.Socket> | null = null
  private socketPath: string | null = null
  private socketDirectory: string | null = null
  private socketToken: string | null = null
  private nextId = 1
  private pending = new Map<number, PendingNativeRequest>()
  private readonly socketBuffer = new NativeProviderLineBuffer()
  private providerCapabilities: ComputerProviderCapabilities | null = null
  private socketListenerCleanup: (() => void) | null = null
  private socketStartGeneration = 0
  async listApps(): Promise<ComputerListAppsResult> {
    return (await this.call('listApps', {})) as ComputerListAppsResult
  }
  async capabilities(): Promise<ComputerProviderCapabilities> {
    await this.ensureCompatible()
    return this.providerCapabilities!
  }
  async listWindows(params: unknown): Promise<ComputerListWindowsResult> {
    await this.ensureCapability('windows', 'list')
    return (await this.call('listWindows', params)) as ComputerListWindowsResult
  }
  async snapshot(params: unknown): Promise<ComputerSnapshotResult> {
    const first = (await this.call('getAppState', params)) as ComputerSnapshotResult
    return await this.awaitManualAccessibilityTree(first, params)
  }

  /**
   * Re-read an app whose accessibility tree was just switched on.
   *
   * Apps that ship Chromium with accessibility disabled build the tree
   * asynchronously once the flag flips, so the very read that flips it comes back
   * with a window, a container and three traffic-light buttons — and an agent
   * reading that concludes the app exposes nothing to act on. Measured on Doubao:
   * 5 elements on the enabling read, 41-55 about two seconds later.
   *
   * The wait is HERE and not in the helper: the helper builds that tree against
   * its own run loop, and sleeping inside it stopped the tree from appearing at
   * all (measured — it stayed at 5 for the full six seconds).
   *
   * How long it takes varies with how long the app's own web content takes to
   * load: four seconds in the fastest run measured, tens of seconds in the
   * slowest. So this waits a short, bounded time and otherwise hands back the
   * stub WITH the flag still set, which is what lets the caller say "read again"
   * instead of "this app exposes nothing".
   */
  private async awaitManualAccessibilityTree(
    snapshot: ComputerSnapshotResult,
    params: unknown
  ): Promise<ComputerSnapshotResult> {
    if (
      !snapshot.snapshot?.manualAccessibilityJustEnabled ||
      snapshot.snapshot.elementCount > MANUAL_ACCESSIBILITY_STUB_ELEMENTS
    ) {
      return snapshot
    }
    const deadline = Date.now() + MANUAL_ACCESSIBILITY_SETTLE_MS
    let latest = snapshot
    while (Date.now() < deadline) {
      await delay(MANUAL_ACCESSIBILITY_POLL_MS)
      latest = (await this.call('getAppState', params)) as ComputerSnapshotResult
      if (latest.snapshot.elementCount > MANUAL_ACCESSIBILITY_STUB_ELEMENTS) {
        return latest
      }
    }
    return latest
  }
  async action(method: NativeActionMethod, params: unknown): Promise<ComputerActionResult> {
    validateComputerProviderActionParams(
      method,
      params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
    )
    await this.ensureActionSupported(method)
    return normalizeComputerActionResult((await this.call(method, params)) as ComputerActionResult)
  }
  shutdown(): void {
    const socket = this.socket
    const token = this.socketToken
    this.socket = null
    this.socketStartPromise = null
    this.socketStartGeneration++
    this.providerCapabilities = null
    this.socketBuffer.clear()
    this.cleanupActiveSocketListeners()
    if (socket && !socket.destroyed) {
      const id = this.nextId++
      socket.write(`${JSON.stringify({ id, method: 'terminate', params: {}, token })}\n`)
      socket.end()
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(
        new RuntimeClientError('accessibility_error', 'native macOS provider shut down')
      )
      this.pending.delete(id)
    }
    this.cleanupSocketDirectory()
  }
  private async call(method: NativeMethod, params: unknown): Promise<unknown> {
    if (method !== 'handshake') {
      await this.ensureCompatible()
    }
    return await this.send(method, params)
  }
  private async send(method: NativeMethod, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const helperAppPath = resolveMacOSComputerUseAppPath()
    if (!helperAppPath) {
      throw new RuntimeClientError('accessibility_error', 'Open Science Computer Use.app was not found')
    }
    const transport = await this.ensureSocketStarted(helperAppPath)
    const token = this.socketToken
    const line = `${JSON.stringify({ id, method, params, token })}\n`
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.shutdown()
        reject(
          new RuntimeClientError('action_timeout', `native macOS provider ${method} timed out`)
        )
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(id, { resolve, reject, timer })
    })
    try {
      await writeNativeProviderLine(transport, line)
    } catch (error) {
      const wrapped = new RuntimeClientError(
        'accessibility_error',
        error instanceof Error ? error.message : String(error)
      )
      const pending = this.pending.get(id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(id)
      }
      this.invalidateActiveSocketAfterWriteFailure(transport, wrapped)
      throw wrapped
    }
    return await result
  }
  private async ensureCompatible(): Promise<void> {
    if (this.providerCapabilities) {
      return
    }
    const capabilities = await this.readCapabilities()
    if (capabilities.protocolVersion === REQUIRED_MACOS_PROVIDER_PROTOCOL_VERSION) {
      this.providerCapabilities = capabilities
      return
    }
    this.shutdown()
    const restarted = await this.readCapabilities()
    if (restarted.protocolVersion !== REQUIRED_MACOS_PROVIDER_PROTOCOL_VERSION) {
      throw new RuntimeClientError(
        'provider_incompatible',
        `native macOS provider protocol ${restarted.protocolVersion} is incompatible with required protocol ${REQUIRED_MACOS_PROVIDER_PROTOCOL_VERSION}`
      )
    }
    this.providerCapabilities = restarted
  }
  private async readCapabilities(): Promise<ComputerProviderCapabilities> {
    return (await this.send('handshake', {})) as ComputerProviderCapabilities
  }
  private async ensureCapability(
    group: keyof ComputerProviderCapabilities['supports'],
    capability: string
  ): Promise<void> {
    await this.ensureCompatible()
    if (assertMacOSProviderCapability(this.providerCapabilities, group, capability)) {
      return
    }
    throw new RuntimeClientError(
      'unsupported_capability',
      `native macOS provider does not support ${String(group)}.${capability}`
    )
  }
  private async ensureActionSupported(method: NativeActionMethod): Promise<void> {
    await this.ensureCapability('actions', macOSActionCapabilityKey(method))
  }
  private async ensureSocketStarted(helperAppPath: string): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) {
      return this.socket
    }
    this.cleanupActiveSocketListeners()
    this.socket = null
    if (this.socketStartPromise) {
      return await this.socketStartPromise
    }
    const socketStartPromise = this.startSocket(helperAppPath)
    this.socketStartPromise = socketStartPromise
    try {
      return await socketStartPromise
    } finally {
      if (this.socketStartPromise === socketStartPromise) {
        this.socketStartPromise = null
      }
    }
  }
  private async startSocket(helperAppPath: string): Promise<net.Socket> {
    const startGeneration = ++this.socketStartGeneration
    const started = await startMacOSNativeProviderSocket({
      helperAppPath,
      isCurrent: (socketPath) =>
        this.socketStartGeneration === startGeneration &&
        (this.socketPath === null || this.socketPath === socketPath)
    })
    this.socketDirectory = started.socketDirectory
    this.socketPath = started.socketPath
    this.socketToken = started.socketToken
    const socket = started.socket
    socket.setEncoding('utf8')
    this.socketBuffer.clear()
    this.socketListenerCleanup = attachMacOSNativeProviderSocketListeners(socket, {
      data: (chunk) => this.handleSocketData(socket, chunk),
      close: () => this.handleSocketClose(socket),
      error: (error) => this.handleTransportError(socket, error)
    })
    this.socket = socket
    return socket
  }
  private handleSocketData(socket: net.Socket, chunk: string): void {
    // Why: a timed-out helper socket can emit after a replacement starts.
    // Stale data must not corrupt the replacement socket's line buffer.
    if (this.socket !== socket) {
      return
    }
    this.socketBuffer.push(chunk, (line) => this.handleLine(line))
  }
  private handleLine(line: string): void {
    let response: NativeResponse
    try {
      response = JSON.parse(line) as NativeResponse
    } catch {
      return
    }
    const pending = this.pending.get(response.id)
    if (!pending) {
      return
    }
    clearTimeout(pending.timer)
    this.pending.delete(response.id)
    if (response.ok) {
      pending.resolve(response.result)
      return
    }
    pending.reject(new RuntimeClientError(response.error.code, response.error.message))
  }
  private handleSocketClose(socket: net.Socket): void {
    // Why: late close from a prior helper socket must not tear down the active replacement.
    if (this.socket !== socket) {
      return
    }
    this.cleanupActiveSocketListeners()
    this.socket = null
    this.socketBuffer.clear()
    this.cleanupSocketDirectory()
    this.rejectPending(
      new RuntimeClientError('accessibility_error', 'native macOS helper app connection closed')
    )
  }
  private handleTransportError(socket: net.Socket, error: Error): void {
    // Why: stale socket errors can arrive after shutdown/restart.
    if (this.socket !== socket) {
      return
    }
    this.cleanupActiveSocketListeners()
    // Why: an active transport error makes the helper socket unreliable for the next request.
    this.socket = null
    this.socketBuffer.clear()
    if (!socket.destroyed) {
      socket.destroy()
    }
    this.cleanupSocketDirectory()
    this.rejectPending(new RuntimeClientError('accessibility_error', error.message))
  }
  private invalidateActiveSocketAfterWriteFailure(
    socket: net.Socket,
    error: RuntimeClientError
  ): void {
    if (this.socket !== socket) {
      return
    }
    this.cleanupActiveSocketListeners()
    this.socket = null
    this.socketBuffer.clear()
    if (!socket.destroyed) {
      socket.destroy()
    }
    this.cleanupSocketDirectory()
    this.rejectPending(error)
  }
  private cleanupSocketDirectory(): void {
    if (!this.socketDirectory) {
      return
    }
    rmSync(this.socketDirectory, { recursive: true, force: true })
    this.socketDirectory = null
    this.socketPath = null
  }
  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
  private cleanupActiveSocketListeners(): void {
    const cleanup = this.socketListenerCleanup
    this.socketListenerCleanup = null
    cleanup?.()
  }
}
