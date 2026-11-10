import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { installRendererRecovery } from '../../electron/rendererRecovery.js'

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(entryUrl = 'file:///app/dist-electron/index.html', visible = true) {
  const contents = Object.assign(new EventEmitter(), {
    id: 2, isDestroyed: vi.fn(() => false), loadURL: vi.fn(async (_url: string) => {}),
  })
  const window = Object.assign(new EventEmitter(), {
    id: 1, webContents: contents, isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => visible), isMinimized: vi.fn(() => false),
    show: vi.fn(() => { window.isVisible.mockReturnValue(true); window.emit('show') }),
    restore: vi.fn(() => { window.isMinimized.mockReturnValue(false); window.emit('restore') }), focus: vi.fn(),
  })
  const options = {
    entryUrl, isQuitting: vi.fn(() => false), log: vi.fn(), logPath: vi.fn(() => '/profile/logs/client-errors.ndjson'),
    versions: { app: 'test', electron: '38', chrome: '140', platform: 'darwin', arch: 'arm64' },
    showDialog: vi.fn(async (_options: unknown) => ({ response: 1 })), changed: vi.fn(),
  }
  const recovery = installRendererRecovery(window as unknown as BrowserWindow, options)
  const crash = (reason = 'crashed') => contents.emit('render-process-gone', {}, { reason, exitCode: 5 })
  return { window, contents, options, recovery, crash }
}

describe('main-owned renderer recovery', () => {
  it.each(['crashed', 'oom', 'killed', 'abnormal-exit', 'launch-failed', 'integrity-failure', 'memory-eviction', 'future-reason'])('logs and prompts for %s without reloading automatically', async reason => {
    const f = fixture()
    f.crash(reason)
    await flush()
    expect(f.options.showDialog).toHaveBeenCalledTimes(1)
    expect(f.contents.loadURL).not.toHaveBeenCalled()
    expect(f.recovery.needsRecovery()).toBe(true)
    expect(f.options.log).toHaveBeenCalledWith(expect.objectContaining({
      type: 'renderer_recovery', event: 'failed', reason: reason === 'future-reason' ? 'unknown' : reason,
      exitCode: 5, versions: f.options.versions, windowId: 1, webContentsId: 2,
    }))
    const dialog = f.options.showDialog.mock.calls[0][0] as { detail: string }
    expect(dialog.detail.includes('ran out of memory')).toBe(reason === 'oom')
  })

  it('Later remains recoverable through the native entry, including hidden windows', async () => {
    const f = fixture()
    f.window.isVisible.mockReturnValue(false)
    f.crash()
    expect(f.options.showDialog).not.toHaveBeenCalled()
    expect(f.window.show).not.toHaveBeenCalled()
    f.window.isVisible.mockReturnValue(true)
    f.recovery.recover()
    await flush()
    expect(f.options.showDialog).toHaveBeenCalledTimes(1)
    expect(f.window.show).toHaveBeenCalledTimes(1)
    f.window.emit('show')
    await flush()
    expect(f.options.showDialog).toHaveBeenCalledTimes(1)
    f.recovery.recover()
    await flush()
    expect(f.options.showDialog).toHaveBeenCalledTimes(2)
    expect(f.contents.loadURL).not.toHaveBeenCalled()
  })

  it('reloads the same trusted route once and records only document-load success', async () => {
    const f = fixture()
    const dialog = deferred<{ response: number }>()
    f.options.showDialog.mockReturnValue(dialog.promise)
    f.contents.emit('did-navigate-in-page', {}, 'file:///app/dist-electron/index.html#/chat/p/c', true)
    f.crash()
    f.recovery.recover()
    f.recovery.recover()
    expect(f.options.showDialog).toHaveBeenCalledTimes(1)
    dialog.resolve({ response: 0 })
    await flush()
    expect(f.contents.loadURL).toHaveBeenCalledTimes(1)
    expect(f.contents.loadURL).toHaveBeenCalledWith('file:///app/dist-electron/index.html#/chat/p/c')
    expect(f.recovery.needsRecovery()).toBe(false)
    expect(f.options.log.mock.calls.map(([r]) => r.event)).toEqual(['failed', 'reload_requested', 'document_loaded'])
  })

  it.each(['https://evil.invalid/?secret=1', 'file:///other/index.html', 'file:///app/dist-electron/index.html?secret=1', 'file:///app/dist-electron/index.html#subframe'])('rejects a foreign/subframe recovery target: %s', async url => {
    const f = fixture()
    f.options.showDialog.mockResolvedValue({ response: 0 })
    f.contents.emit('did-navigate-in-page', {}, url, !url.endsWith('#subframe'))
    f.crash()
    await flush()
    expect(f.contents.loadURL).toHaveBeenCalledTimes(1)
    expect(f.contents.loadURL).toHaveBeenCalledWith('file:///app/dist-electron/index.html')
    expect(JSON.stringify(f.options.log.mock.calls)).not.toContain('secret')
  })

  it('supports only the exact development entry with an optional hash', async () => {
    const f = fixture('http://localhost:5173/')
    f.options.showDialog.mockResolvedValue({ response: 0 })
    f.contents.emit('did-navigate-in-page', {}, 'http://localhost:5173/#/chat/p/c', true)
    f.contents.emit('did-navigate', {}, 'http://localhost:5173/other')
    f.crash()
    await flush()
    expect(f.contents.loadURL).toHaveBeenCalledTimes(1)
    expect(f.contents.loadURL).toHaveBeenCalledWith('http://localhost:5173/#/chat/p/c')
  })

  it.each(['clean', 'quitting', 'destroyed'])('does not prompt during %s exit', async kind => {
    const f = fixture()
    if (kind === 'quitting') f.options.isQuitting.mockReturnValue(true)
    if (kind === 'destroyed') f.window.isDestroyed.mockReturnValue(true)
    f.crash(kind === 'clean' ? 'clean-exit' : 'crashed')
    await flush()
    expect(f.options.showDialog).not.toHaveBeenCalled()
    expect(f.recovery.needsRecovery()).toBe(false)
  })

  it.each(['quit', 'destroy', 'navigation'])('ignores a dialog response after %s', async kind => {
    const f = fixture()
    const dialog = deferred<{ response: number }>()
    f.options.showDialog.mockReturnValue(dialog.promise)
    f.crash()
    if (kind === 'quit') f.options.isQuitting.mockReturnValue(true)
    if (kind === 'destroy') f.window.emit('closed')
    if (kind === 'navigation') f.contents.emit('did-navigate', {}, 'file:///app/dist-electron/index.html#/homepage')
    dialog.resolve({ response: 0 })
    await flush()
    expect(f.contents.loadURL).not.toHaveBeenCalled()
  })

  it('coalesces event + rejected promise and permits explicit retry after failed reload', async () => {
    const f = fixture()
    const navigation = deferred<void>()
    f.options.showDialog.mockResolvedValueOnce({ response: 0 }).mockResolvedValue({ response: 1 })
    f.contents.loadURL.mockReturnValueOnce(navigation.promise)
    f.crash()
    await flush()
    f.contents.emit('did-fail-load', {}, -6, 'private raw description', 'file:///secret', true)
    navigation.reject(new Error('private load URL'))
    await flush()
    expect(f.options.showDialog).toHaveBeenCalledTimes(2)
    expect(f.recovery.needsRecovery()).toBe(true)
    expect(f.options.log.mock.calls.filter(([r]) => r.event === 'failed')).toHaveLength(2)
    expect(JSON.stringify(f.options.log.mock.calls)).not.toContain('private')
    f.options.showDialog.mockResolvedValue({ response: 0 })
    f.recovery.recover()
    await flush()
    expect(f.recovery.needsRecovery()).toBe(false)
  })

  it('handles promise-only load failure and ignores ERR_ABORTED/subframe failures', async () => {
    const f = fixture()
    f.contents.loadURL.mockRejectedValueOnce(new Error('raw private URL'))
    await f.recovery.load()
    await flush()
    expect(f.options.showDialog).toHaveBeenCalledTimes(1)
    f.contents.emit('did-fail-load', {}, -3, '', '', true)
    f.contents.emit('did-fail-load', {}, -6, '', '', false)
    expect(f.options.showDialog).toHaveBeenCalledTimes(1)
    const g = fixture()
    g.contents.loadURL.mockRejectedValueOnce(Object.assign(new Error(), { code: 'ERR_ABORTED' }))
    await g.recovery.load()
    expect(g.options.showDialog).not.toHaveBeenCalled()
  })

  it('records a second crash while a dialog is open without acting on the stale response', async () => {
    const f = fixture()
    const dialog = deferred<{ response: number }>()
    f.options.showDialog.mockReturnValueOnce(dialog.promise).mockResolvedValue({ response: 1 })
    f.crash()
    f.crash('oom')
    expect(f.options.showDialog).toHaveBeenCalledTimes(1)
    dialog.resolve({ response: 0 })
    await flush()
    expect(f.contents.loadURL).not.toHaveBeenCalled()
    expect(f.options.showDialog).toHaveBeenCalledTimes(2)
  })

  it('invalidates a pending load when the renderer crashes again', async () => {
    const f = fixture()
    const navigation = deferred<void>()
    f.options.showDialog.mockResolvedValueOnce({ response: 0 }).mockResolvedValue({ response: 1 })
    f.contents.loadURL.mockReturnValueOnce(navigation.promise)
    f.crash()
    await flush()
    f.crash('oom')
    navigation.resolve()
    await flush()
    expect(f.recovery.needsRecovery()).toBe(true)
    expect(f.options.log.mock.calls.some(([r]) => r.event === 'document_loaded')).toBe(false)
  })

  it('recovers from log and dialog failures and removes lifecycle listeners', async () => {
    const f = fixture()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    f.options.log.mockImplementation(() => { throw new Error('private') })
    f.options.logPath.mockImplementation(() => { throw new Error('private') })
    f.options.showDialog.mockRejectedValueOnce(new Error('private'))
    f.crash()
    await flush()
    f.recovery.recover()
    await flush()
    expect(f.options.showDialog).toHaveBeenCalledTimes(2)
    f.window.emit('closed')
    expect(f.contents.listenerCount('render-process-gone')).toBe(0)
    expect(f.contents.listenerCount('did-fail-load')).toBe(0)
    expect(f.window.listenerCount('show')).toBe(0)
    f.crash()
    expect(f.options.showDialog).toHaveBeenCalledTimes(2)
    consoleError.mockRestore()
  })
})


describe('review regressions', () => {
  it('shows failed first load even before ready-to-show', async () => {
    const f = fixture(undefined, false)
    f.contents.loadURL.mockRejectedValueOnce(new Error('first load'))
    await f.recovery.load()
    await flush()
    expect(f.window.show).toHaveBeenCalledTimes(1)
    expect(f.options.showDialog).toHaveBeenCalledTimes(1)
    expect(f.options.showDialog.mock.calls[0][0]).toMatchObject({ message: 'Graviton’s interface could not load.' })
  })

  it('restores minimized windows and prompts only once despite restore/show events', async () => {
    const f = fixture()
    f.window.isMinimized.mockReturnValue(true)
    f.window.isVisible.mockReturnValue(false)
    f.crash()
    expect(f.options.showDialog).not.toHaveBeenCalled()
    f.recovery.recover()
    await flush()
    expect(f.window.restore).toHaveBeenCalledTimes(1)
    expect(f.options.showDialog).toHaveBeenCalledTimes(1)
  })

  it('prompts on natural restore after a minimized crash', async () => {
    const f = fixture()
    f.window.isMinimized.mockReturnValue(true)
    f.crash()
    f.window.restore()
    await flush()
    expect(f.options.showDialog).toHaveBeenCalledTimes(1)
  })

  it('does not allow a tray refresh failure to prevent crash cleanup listeners', async () => {
    const f = fixture()
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {})
    f.options.changed.mockImplementation(() => { throw new Error('tray unavailable') })
    const cleanup = vi.fn()
    f.contents.on('render-process-gone', cleanup)
    f.crash()
    await flush()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(f.options.showDialog).toHaveBeenCalledTimes(1)
    silence.mockRestore()
  })

  it('records aborted recovery and leaves the native retry enabled', async () => {
    const f = fixture()
    f.options.showDialog.mockResolvedValue({ response: 0 })
    f.contents.loadURL.mockRejectedValueOnce(Object.assign(new Error(), { code: 'ERR_ABORTED' }))
    f.crash()
    await flush()
    expect(f.options.log.mock.calls.some(([r]) => r.event === 'reload_aborted')).toBe(true)
    expect(f.recovery.needsRecovery()).toBe(true)
  })

  it('suppresses recovery on Windows session-end, including an open dialog response', async () => {
    const f = fixture()
    const dialog = deferred<{ response: number }>()
    f.options.showDialog.mockReturnValue(dialog.promise)
    f.crash()
    f.window.emit('session-end')
    dialog.resolve({ response: 0 })
    await flush()
    expect(f.contents.loadURL).not.toHaveBeenCalled()
    f.crash()
    expect(f.options.showDialog).toHaveBeenCalledTimes(1)
  })

  it('normalizes Windows drive letter and percent-encoding without trusting other files', async () => {
    const f = fixture('file:///C:/App/index.html')
    f.options.versions.platform = 'win32'
    f.options.showDialog.mockResolvedValue({ response: 0 })
    f.contents.emit('did-navigate', {}, 'file:///c:/App/%69ndex.html#/chat/p/c')
    f.contents.emit('did-navigate', {}, 'file:///C:/other/index.html#/bad')
    f.crash()
    await flush()
    expect(f.contents.loadURL).toHaveBeenCalledWith('file:///c:/App/%69ndex.html#/chat/p/c')
  })
})


it.each(['minimize', 'hide'])('explicit recovery after Later waits for asynchronous %s reversal', async kind => {
  const f = fixture()
  f.crash()
  await flush()
  expect(f.options.showDialog).toHaveBeenCalledTimes(1)
  f.window.isVisible.mockReturnValue(false)
  f.window.show.mockImplementation(() => {})
  if (kind === 'minimize') {
    f.window.isMinimized.mockReturnValue(true)
    f.window.restore.mockImplementation(() => {})
  }
  f.recovery.recover()
  await flush()
  expect(f.options.showDialog).toHaveBeenCalledTimes(1)
  f.window.isVisible.mockReturnValue(true)
  f.window.isMinimized.mockReturnValue(false)
  f.window.emit(kind === 'minimize' ? 'restore' : 'show')
  f.window.emit('focus')
  await flush()
  expect(f.options.showDialog).toHaveBeenCalledTimes(2)
  f.window.emit('focus')
  await flush()
  expect(f.options.showDialog).toHaveBeenCalledTimes(2)
})
