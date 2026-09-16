// @vitest-environment node
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  chmodSyncMock,
  connectMacOSProviderSocketMock,
  execFileMock,
  mkdtempSyncMock,
  resolveMacOSComputerUseAppPathMock,
  rmSyncMock,
  writeFileSyncMock
} = vi.hoisted(() => ({
  chmodSyncMock: vi.fn(),
  connectMacOSProviderSocketMock: vi.fn(),
  execFileMock: vi.fn(),
  mkdtempSyncMock: vi.fn(),
  resolveMacOSComputerUseAppPathMock: vi.fn(),
  rmSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn()
}))

// The helper is started through LaunchServices, not spawned as a child, so TCC
// judges the grants against the helper's own bundle identity.
vi.mock('child_process', () => ({
  execFile: execFileMock
}))

vi.mock('fs', () => ({
  chmodSync: chmodSyncMock,
  mkdtempSync: mkdtempSyncMock,
  rmSync: rmSyncMock,
  writeFileSync: writeFileSyncMock
}))

vi.mock('../../../../../runtime/computer/macos-native-provider-paths', () => ({
  resolveMacOSComputerUseAppPath: resolveMacOSComputerUseAppPathMock
}))

vi.mock('../../../../../runtime/computer/macos-native-provider-socket', () => ({
  connectMacOSProviderSocket: connectMacOSProviderSocketMock
}))

class FakeSocket extends EventEmitter {
  destroyed = false
  writes: string[] = []
  writeError: Error | null = null

  setEncoding(): void {}

  write(line: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(line)
    callback?.(this.writeError)
    return true
  }

  end(): void {
    this.destroyed = true
  }

  destroy(): this {
    this.destroyed = true
    return this
  }
}

function pendingConnectThatRejectsOnAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener(
      'abort',
      () => reject(new Error('native macOS helper app startup was cancelled')),
      { once: true }
    )
  })
}

async function loadClientModule() {
  vi.resetModules()
  return await import('../../../../../runtime/computer/macos-native-provider-client')
}

/** One recorded `open` invocation, and the callback that settles it. */
type Launch = {
  args: string[]
  done: (error: Error | null, stdout?: string, stderr?: string) => void
}

describe('MacOSNativeProviderClient', () => {
  const sockets: FakeSocket[] = []
  const launches: Launch[] = []
  /** Armed before a connect so the socket fails its very first write. */
  const nextWriteError: { value: Error | null } = { value: null }

  beforeEach(() => {
    vi.useFakeTimers()
    sockets.length = 0
    launches.length = 0
    mkdtempSyncMock.mockImplementation((prefix: string) => `${prefix}${sockets.length}`)
    resolveMacOSComputerUseAppPathMock.mockReturnValue(
      '/Applications/Open Science.app/Contents/Resources/computer-use/Open Science Computer Use.app'
    )
    // `open` reports only whether the launch was accepted; by default it was.
    execFileMock.mockImplementation((_file: string, args: string[], _options: unknown, done: Launch['done']) => {
      launches.push({ args, done })
      done(null, '', '')
    })
    nextWriteError.value = null
    connectMacOSProviderSocketMock.mockImplementation(async () => {
      const socket = new FakeSocket()
      socket.writeError = nextWriteError.value
      sockets.push(socket)
      return socket
    })
  })

  afterEach(() => {
    chmodSyncMock.mockReset()
    connectMacOSProviderSocketMock.mockReset()
    execFileMock.mockReset()
    mkdtempSyncMock.mockReset()
    resolveMacOSComputerUseAppPathMock.mockReset()
    rmSyncMock.mockReset()
    writeFileSyncMock.mockReset()
    vi.useRealTimers()
  })

  it('does not rescan a growing fragmented screenshot reply', async () => {
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()
    const call = client.snapshot({ app: 'fixture' })
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const socket = sockets[0]!
    await vi.waitFor(() => expect(socket.writes).toHaveLength(1))
    const handshake = JSON.parse(socket.writes[0]!) as { id: number }
    socket.emit(
      'data',
      `${JSON.stringify({ id: handshake.id, ok: true, result: macOSProviderCapabilities() })}\n`
    )
    await vi.waitFor(() => expect(socket.writes).toHaveLength(2))
    const request = JSON.parse(socket.writes[1]!) as { id: number }
    const result = { screenshot: { data: 'A'.repeat(1_200_000) }, text: 'fixture' }
    const reply = `${JSON.stringify({ id: request.id, ok: true, result })}\n`
    const originalIndexOf = String.prototype.indexOf
    const originalIncludes = String.prototype.includes
    let searchedUnits = 0
    const search = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
      this: string,
      needle: string,
      fromIndex?: number
    ) {
      if (needle === '\n') {
        searchedUnits += Math.max(0, this.length - (fromIndex ?? 0))
      }
      return originalIndexOf.call(this, needle, fromIndex)
    })
    const includes = vi.spyOn(String.prototype, 'includes').mockImplementation(function (
      this: string,
      needle: string,
      fromIndex?: number
    ) {
      if (needle === '\n') {
        searchedUnits += Math.max(0, this.length - (fromIndex ?? 0))
      }
      return originalIncludes.call(this, needle, fromIndex)
    })
    try {
      for (let offset = 0; offset < reply.length; offset += 4096) {
        socket.emit('data', reply.slice(offset, offset + 4096))
      }
    } finally {
      search.mockRestore()
      includes.mockRestore()
    }
    await expect(call).resolves.toEqual(result)
    expect(searchedUnits).toBeLessThanOrEqual(reply.length * 3)
    client.shutdown()
  })

  it('retries buffered replies on an empty chunk after a malformed reply throws', async () => {
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()
    void client.capabilities().catch(() => {})
    const secondCall = client.capabilities()
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const socket = sockets[0]!
    await vi.waitFor(() => expect(socket.writes).toHaveLength(2))
    const first = JSON.parse(socket.writes[0]!) as { id: number }
    const second = JSON.parse(socket.writes[1]!) as { id: number }
    const malformed = JSON.stringify({ id: first.id, ok: false })
    const valid = JSON.stringify({ id: second.id, ok: true, result: macOSProviderCapabilities() })
    expect(() => socket.emit('data', `${malformed}\n${valid}\n`)).toThrow(TypeError)
    socket.emit('data', '')
    await expect(secondCall).resolves.toEqual(macOSProviderCapabilities())
    client.shutdown()
  })

  it('ignores stale socket data, close, and error after a replacement socket starts', async () => {
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()

    const firstCall = client.capabilities()
    const firstRejection = expect(firstCall).rejects.toThrow(
      'native macOS provider handshake timed out'
    )
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const firstSocket = sockets[0]!

    firstSocket.emit('data', '{"id":999,"result":"partial')
    await vi.advanceTimersByTimeAsync(60_000)
    await firstRejection
    expect(firstSocket.destroyed).toBe(true)
    expect(firstSocket.listenerCount('data')).toBe(0)
    expect(firstSocket.listenerCount('close')).toBe(0)
    expect(firstSocket.listenerCount('error')).toBe(1)

    const secondCall = client.capabilities()
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    const secondSocket = sockets[1]!
    await vi.waitFor(() => expect(secondSocket.writes).toHaveLength(1))
    const secondRequest = JSON.parse(secondSocket.writes[0]!) as { id: number }

    // Why: a timed-out helper socket can flush events after restart. Those
    // stale events must not clear/reject the active replacement request.
    firstSocket.emit('data', '{"id":999,"ok":false,"error":{"code":"old","message":"old"}}\n')
    expect(() => firstSocket.emit('error', new Error('old helper failed late'))).not.toThrow()
    firstSocket.emit('close')

    const capabilities = {
      protocolVersion: 1,
      supports: {}
    }
    secondSocket.emit(
      'data',
      `${JSON.stringify({ id: secondRequest.id, ok: true, result: capabilities })}\n`
    )

    await expect(secondCall).resolves.toEqual(capabilities)
  })

  it('starts a replacement socket after the active helper connection errors', async () => {
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()

    const firstCall = client.capabilities()
    const firstRejection = expect(firstCall).rejects.toThrow('active helper failed')
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const firstSocket = sockets[0]!
    const firstSocketDirectory = mkdtempSyncMock.mock.results[0]?.value as string
    await vi.waitFor(() => expect(firstSocket.writes).toHaveLength(1))

    firstSocket.emit('data', '{"id":999,"result":"partial')
    firstSocket.emit('error', new Error('active helper failed'))
    await firstRejection
    expect(firstSocket.destroyed).toBe(true)
    expect(firstSocket.listenerCount('data')).toBe(0)
    expect(firstSocket.listenerCount('close')).toBe(0)
    expect(firstSocket.listenerCount('error')).toBe(1)
    expect(rmSyncMock).toHaveBeenCalledWith(firstSocketDirectory, {
      recursive: true,
      force: true
    })

    const secondCall = client.capabilities()
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    const secondSocket = sockets[1]!
    await vi.waitFor(() => expect(secondSocket.writes).toHaveLength(1))
    const secondRequest = JSON.parse(secondSocket.writes[0]!) as { id: number }

    const capabilities = {
      protocolVersion: 1,
      supports: {}
    }
    secondSocket.emit(
      'data',
      `${JSON.stringify({ id: secondRequest.id, ok: true, result: capabilities })}\n`
    )

    await expect(secondCall).resolves.toEqual(capabilities)
  })

  it('invalidates the active socket when a helper write fails', async () => {
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()

    // Let the handshake land first, so what fails is an ordinary request write
    // on an established socket — the case this is about.
    const handshakeCall = client.capabilities()
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const firstSocket = sockets[0]!
    const firstSocketDirectory = mkdtempSyncMock.mock.results[0]?.value as string
    await vi.waitFor(() => expect(firstSocket.writes).toHaveLength(1))
    const handshake = JSON.parse(firstSocket.writes[0]!) as { id: number }
    firstSocket.emit(
      'data',
      `${JSON.stringify({ id: handshake.id, ok: true, result: macOSProviderCapabilities() })}\n`
    )
    await handshakeCall

    firstSocket.writeError = new Error('write EPIPE')
    const firstCall = client.listApps()

    await expect(firstCall).rejects.toThrow('write EPIPE')
    expect(firstSocket.destroyed).toBe(true)
    expect(firstSocket.listenerCount('data')).toBe(0)
    expect(firstSocket.listenerCount('close')).toBe(0)
    expect(firstSocket.listenerCount('error')).toBe(1)
    expect(rmSyncMock).toHaveBeenCalledWith(firstSocketDirectory, {
      recursive: true,
      force: true
    })

    // The next call gets a new helper and a new socket. It does NOT handshake
    // again: capabilities were negotiated before the write failed and survive
    // the socket, so the first thing on the wire is the request itself.
    const secondCall = client.listApps()
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    const secondSocket = sockets[1]!
    await vi.waitFor(() => expect(secondSocket.writes).toHaveLength(1))
    const secondRequest = JSON.parse(secondSocket.writes[0]!) as { id: number; method: string }
    expect(secondRequest.method).toBe('listApps')
    secondSocket.emit(
      'data',
      `${JSON.stringify({ id: secondRequest.id, ok: true, result: { apps: [] } })}\n`
    )

    await expect(secondCall).resolves.toEqual({ apps: [] })
  })

  it('rejects actions that the native provider does not advertise', async () => {
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()

    const call = client.action('setValue', {
      app: 'TextEdit',
      elementIndex: 0,
      value: 'draft'
    })
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const socket = sockets[0]!
    await vi.waitFor(() => expect(socket.writes).toHaveLength(1))
    const handshakeRequest = JSON.parse(socket.writes[0]!) as { id: number }

    socket.emit(
      'data',
      `${JSON.stringify({
        id: handshakeRequest.id,
        ok: true,
        result: macOSProviderCapabilities({ setValue: false })
      })}\n`
    )

    await expect(call).rejects.toMatchObject({
      code: 'unsupported_capability',
      message: expect.stringContaining('actions.setValue')
    })
    expect(socket.writes).toHaveLength(1)
  })

  it('rejects malformed action payloads before starting the native helper', async () => {
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()

    await expect(client.action('click', { elementIndex: 0 })).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Missing app')
    })
    await expect(client.action('click', { app: 'TextEdit' })).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Click requires')
    })
    await expect(
      client.action('click', {
        app: 'TextEdit',
        elementIndex: 0,
        modifiers: 'CmdOrCtrl+A'
      })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Click modifiers accept modifier keys only')
    })
    await expect(client.action('typeText', { app: 'TextEdit', text: '' })).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Missing text')
    })
    await expect(
      client.action('pressKey', { app: 'TextEdit', key: 'CmdOrCtrl+V' })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Press-key accepts one key only')
    })
    await expect(client.action('hotkey', { app: 'TextEdit', key: 'A' })).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Hotkey requires')
    })

    expect(launches).toHaveLength(0)
    expect(sockets).toHaveLength(0)
    expect(execFileMock).not.toHaveBeenCalled()
    expect(connectMacOSProviderSocketMock).not.toHaveBeenCalled()
  })

  it('normalizes unverified synthetic native action results', async () => {
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()

    const call = client.action('click', {
      app: 'TextEdit',
      elementIndex: 0
    })
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const socket = sockets[0]!
    await vi.waitFor(() => expect(socket.writes).toHaveLength(1))
    const handshakeRequest = JSON.parse(socket.writes[0]!) as { id: number }

    socket.emit(
      'data',
      `${JSON.stringify({
        id: handshakeRequest.id,
        ok: true,
        result: macOSProviderCapabilities()
      })}\n`
    )
    await vi.waitFor(() => expect(socket.writes).toHaveLength(2))
    const actionRequest = JSON.parse(socket.writes[1]!) as { id: number }
    socket.emit(
      'data',
      `${JSON.stringify({
        id: actionRequest.id,
        ok: true,
        result: {
          snapshot: {},
          action: { path: 'synthetic', actionName: null, fallbackReason: null }
        }
      })}\n`
    )

    await expect(call).resolves.toMatchObject({
      action: {
        path: 'synthetic',
        verification: { state: 'unverified', reason: 'synthetic_input' }
      }
    })
  })

  it('removes the parent-owned token file after the helper socket connects', async () => {
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()

    const call = client.capabilities()
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const socket = sockets[0]!
    await vi.waitFor(() => expect(socket.writes).toHaveLength(1))
    const request = JSON.parse(socket.writes[0]!) as { id: number }
    const socketDirectory = mkdtempSyncMock.mock.results[0]?.value as string

    expect(rmSyncMock).toHaveBeenCalledWith(join(socketDirectory, 'provider.token'), {
      force: true
    })

    socket.emit(
      'data',
      `${JSON.stringify({
        id: request.id,
        ok: true,
        result: { protocolVersion: 1, supports: {} }
      })}\n`
    )
    await expect(call).resolves.toMatchObject({ protocolVersion: 1 })
  })

  it('does not let a superseded startup clean up the replacement helper token', async () => {
    const pendingConnects: {
      resolve: (socket: FakeSocket) => void
    }[] = []
    connectMacOSProviderSocketMock.mockImplementation(
      async () =>
        await new Promise<FakeSocket>((resolve) => {
          pendingConnects.push({ resolve })
        })
    )
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()

    const firstCall = client.capabilities()
    await vi.waitFor(() => expect(pendingConnects).toHaveLength(1))
    const firstSocketDirectory = mkdtempSyncMock.mock.results[0]?.value as string

    client.shutdown()

    const secondCall = client.capabilities()
    await vi.waitFor(() => expect(pendingConnects).toHaveLength(2))
    const secondSocket = new FakeSocket()
    pendingConnects[1]!.resolve(secondSocket)
    await vi.waitFor(() => expect(secondSocket.writes).toHaveLength(1))
    const secondRequest = JSON.parse(secondSocket.writes[0]!) as { id: number }

    const firstSocket = new FakeSocket()
    pendingConnects[0]!.resolve(firstSocket)

    await expect(firstCall).rejects.toThrow('native macOS provider startup was superseded')
    expect(firstSocket.destroyed).toBe(true)
    expect(rmSyncMock).toHaveBeenCalledWith(join(firstSocketDirectory, 'provider.token'), {
      force: true
    })

    secondSocket.emit(
      'data',
      `${JSON.stringify({
        id: secondRequest.id,
        ok: true,
        result: { protocolVersion: 1, supports: {} }
      })}\n`
    )
    await expect(secondCall).resolves.toMatchObject({ protocolVersion: 1 })
  })

  it('launches the helper app through LaunchServices, naming the client it serves', async () => {
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()
    const call = client.capabilities()
    await vi.waitFor(() => expect(launches).toHaveLength(1))

    expect(execFileMock.mock.calls[0]?.[0]).toBe('/usr/bin/open')
    const args = launches[0]!.args
    // `-n` so an already-running helper is never reused, and the app BUNDLE
    // rather than the executable inside it — that is what gives the helper its
    // own TCC identity.
    expect(args[0]).toBe('-n')
    expect(args[1]).toMatch(/Open Science Computer Use\.app$/)
    expect(args).toContain('--args')
    expect(args).toContain('--agent')
    expect(args).toContain('--token-file')
    // LaunchServices means the helper's parent is launchd, so it cannot read the
    // client's pid off its own process tree; it is told.
    expect(args[args.indexOf('--client-pid') + 1]).toBe(String(process.pid))

    const socket = sockets[0]!
    await vi.waitFor(() => expect(socket.writes).toHaveLength(1))
    const handshake = JSON.parse(socket.writes[0]!) as { id: number }
    socket.emit(
      'data',
      `${JSON.stringify({ id: handshake.id, ok: true, result: macOSProviderCapabilities() })}\n`
    )
    await expect(call).resolves.toMatchObject({ platform: 'darwin' })
  })

  it('cleans up the socket directory when the helper never connects', async () => {
    connectMacOSProviderSocketMock.mockRejectedValueOnce(new Error('socket did not open'))
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()

    await expect(client.capabilities()).rejects.toThrow('socket did not open')

    // Nothing to kill: the helper is launchd's child now, and it stands itself
    // down when the connection it was started for never arrives.
    expect(rmSyncMock).toHaveBeenCalledWith(expect.stringContaining('osd-computer-use-'), {
      recursive: true,
      force: true
    })
  })

  it('rejects a refused launch and removes the temp state, aborting the pending connect', async () => {
    execFileMock.mockImplementationOnce(
      (_file: string, args: string[], _options: unknown, done: Launch['done']) => {
        launches.push({ args, done })
        done(new Error('exited with code 1'), '', 'Unable to find application')
      }
    )
    connectMacOSProviderSocketMock.mockImplementation((_path, _timeout, signal?: AbortSignal) =>
      pendingConnectThatRejectsOnAbort(signal)
    )
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()

    await expect(client.capabilities()).rejects.toThrow(
      'native macOS helper app failed to start: Unable to find application'
    )
    const socketDirectory = mkdtempSyncMock.mock.results[0]?.value as string
    expect(rmSyncMock).toHaveBeenCalledWith(socketDirectory, {
      recursive: true,
      force: true
    })
  })
})

function macOSProviderCapabilities(actions: Partial<Record<string, boolean>> = {}) {
  return {
    platform: 'darwin',
    provider: 'osd-computer-use-macos',
    providerVersion: '1.0.0',
    protocolVersion: 1,
    supports: {
      apps: { list: true, bundleIds: true, pids: true },
      windows: {
        list: true,
        targetById: true,
        targetByIndex: true,
        focus: false,
        moveResize: false
      },
      observation: {
        screenshot: true,
        annotatedScreenshot: false,
        elementFrames: true,
        ocr: false
      },
      actions: {
        click: true,
        typeText: true,
        pressKey: true,
        hotkey: true,
        pasteText: true,
        scroll: true,
        drag: true,
        setValue: true,
        performAction: true,
        ...actions
      },
      surfaces: { menus: false, dialogs: false, dock: false, menubar: false }
    }
  }
}
