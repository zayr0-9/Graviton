import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import * as cp from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runBoundedShell } from '../shellRunner.js'

vi.mock('child_process', async importOriginal => ({ ...await importOriginal<typeof cp>(), spawn: vi.fn() }))
function fake(pid = 456) {
  return Object.assign(new EventEmitter(), { pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true), unref: vi.fn() })
}
const prepare = async () => ({ cmd: 'powershell.exe', args: [], cwd: 'C:\\work' })
let child: ReturnType<typeof fake>
let helpers: ReturnType<typeof fake>[]
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  child = fake(); helpers = []
  vi.mocked(cp.spawn).mockReset().mockImplementation(() => {
    if (vi.mocked(cp.spawn).mock.calls.length === 1) return child as any
    const helper = fake(900 + helpers.length); helpers.push(helper); return helper as any
  })
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('Windows bounded shell cleanup', () => {
  it('settles without close while taskkill hangs; bounds helper lifetime independently', async () => {
    const result = runBoundedShell(prepare, { timeoutMs: 10 })
    await vi.advanceTimersByTimeAsync(0)
    child.stdout.write('partial')
    await vi.advanceTimersByTimeAsync(310)
    expect(await result).toMatchObject({ success: false, timedOut: true, stdout: 'partial', cwd: 'C:\\work' })
    expect(cp.spawn).toHaveBeenCalledWith('taskkill.exe', ['/pid', '456', '/T', '/F'], expect.objectContaining({ stdio: 'ignore' }))
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(helpers[0].kill).toHaveBeenCalledWith('SIGKILL')
    expect(child.stdout.destroyed).toBe(true)
    expect(child.unref).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    expect(helpers.every(helper => helper.kill.mock.calls.length === 1)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(() => child.stderr.emit('error', new Error('late'))).not.toThrow()
  })

  it('bounds cancellation even when taskkill and direct kill both throw', async () => {
    vi.mocked(cp.spawn).mockImplementation((cmd: any) => {
      if (cmd === 'powershell.exe') return child as any
      throw new Error('taskkill missing')
    })
    child.kill.mockImplementation(() => { throw new Error('access denied') })
    const controller = new AbortController()
    const result = runBoundedShell(prepare, { signal: controller.signal })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await vi.advanceTimersByTimeAsync(300)
    expect(await result).toMatchObject({ cancelled: true, success: false })
    expect(child.kill).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['throw', 'error', 'nonzero'] as const)('falls back to child.kill when taskkill reports %s', async mode => {
    if (mode === 'throw') vi.mocked(cp.spawn).mockImplementation((cmd: any) => {
      if (cmd === 'powershell.exe') return child as any
      throw new Error('ENOENT')
    })
    const result = runBoundedShell(prepare, { timeoutMs: 10 })
    await vi.advanceTimersByTimeAsync(10)
    if (mode === 'error') helpers[0].emit('error', new Error('ENOENT'))
    if (mode === 'nonzero') helpers[0].emit('close', 1)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    await vi.advanceTimersByTimeAsync(300)
    expect(await result).toMatchObject({ timedOut: true })
    await vi.advanceTimersByTimeAsync(300)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not fall back or kill already-closed successful taskkill helpers', async () => {
    const result = runBoundedShell(prepare, { timeoutMs: 10 })
    await vi.advanceTimersByTimeAsync(10)
    helpers[0].emit('close', 0)
    await vi.advanceTimersByTimeAsync(300)
    helpers[1].emit('close', 0)
    expect(await result).toMatchObject({ timedOut: true })
    expect(child.kill).not.toHaveBeenCalled()
    expect(helpers.every(helper => helper.kill.mock.calls.length === 0)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('accepts a chunked WSL marker during grace and targets only its Linux group', async () => {
    const result = runBoundedShell(async () => ({ cmd: 'wsl.exe', args: [], displayCwd: '/work', wsl: { distro: 'Ubuntu', marker: '__owned.+__' } }), { timeoutMs: 10 })
    await vi.advanceTimersByTimeAsync(10)
    expect(cp.spawn).toHaveBeenCalledTimes(1) // retain bridge for the marker
    child.stderr.write('diagnostic\n__owned.')
    child.stderr.write('+__42')
    child.stderr.write('42\r\nother\n')
    expect(cp.spawn).toHaveBeenCalledWith('wsl.exe', ['-d', 'Ubuntu', '-e', '/bin/kill', '-TERM', '--', '-4242'], expect.any(Object))
    child.emit('close', 0)
    await vi.advanceTimersByTimeAsync(300)
    expect(await result).toMatchObject({ timedOut: true, cwd: '/work', stderr: 'diagnostic\nother\n' })
    expect(cp.spawn).toHaveBeenCalledWith('wsl.exe', ['-d', 'Ubuntu', '-e', '/bin/kill', '-KILL', '--', '-4242'], expect.any(Object))
    expect(cp.spawn).toHaveBeenCalledWith('taskkill.exe', ['/pid', '456', '/T', '/F'], expect.any(Object))
    expect(vi.mocked(cp.spawn).mock.calls).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(300)
    expect(helpers.every(helper => helper.kill.mock.calls.length === 1)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['0', '1', '999999999999999999999'])('does not use unsafe WSL group %s', async pid => {
    const result = runBoundedShell(async () => ({ cmd: 'wsl.exe', args: [], wsl: { distro: 'Ubuntu', marker: '__owned__' } }), { timeoutMs: 10 })
    await vi.advanceTimersByTimeAsync(0)
    child.stderr.write(`__owned__${pid}\n`)
    await vi.advanceTimersByTimeAsync(310)
    expect(await result).toMatchObject({ timedOut: true })
    expect(vi.mocked(cp.spawn).mock.calls.filter(call => call[0] === 'wsl.exe')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(300)
    expect(vi.getTimerCount()).toBe(0)
  })
})
