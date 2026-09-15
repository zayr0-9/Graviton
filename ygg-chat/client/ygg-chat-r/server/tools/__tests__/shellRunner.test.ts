import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as cp from 'child_process'
import { runBoundedShell, type PreparedShell } from '../shellRunner.js'
import { normalizeShellTimeoutMs } from '../shellExecutionPolicy.js'

vi.mock('child_process', async importOriginal => ({ ...await importOriginal<typeof cp>(), spawn: vi.fn() }))
const prepare = async () => ({ cmd: 'fake', args: [], displayCwd: '/test' })
function fake() {
  const child = Object.assign(new EventEmitter(), { pid: 12345678, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), unref: vi.fn() })
  vi.mocked(cp.spawn).mockReturnValue(child as any)
  return child
}
beforeEach(() => { vi.spyOn(process, 'platform', 'get').mockReturnValue('linux') })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
describe('bounded shell runner', () => {
  it.each([undefined, 0, -1, NaN, Infinity, null, '12'])('normalizes invalid timeout %s', value => {
    expect(normalizeShellTimeoutMs(value as number)).toBe(180000)
  })
  it('caps positive values', () => { expect(normalizeShellTimeoutMs(999999)).toBe(180000) })
  it('returns captured output without close and kills the group twice', async () => {
    vi.useFakeTimers()
    const child = fake()
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const result = runBoundedShell(prepare, { timeoutMs: 10 })
    await vi.advanceTimersByTimeAsync(0)
    child.stdout.write('partial')
    await vi.advanceTimersByTimeAsync(10)
    child.emit('close', 0) // leader close must not cancel group escalation
    await vi.advanceTimersByTimeAsync(300)
    expect(await result).toMatchObject({ success: false, timedOut: true, stdout: 'partial', error: expect.any(String) })
    expect(kill.mock.calls).toEqual([[-child.pid, 'SIGTERM'], [-child.pid, 'SIGKILL']])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cancels a never-closing child', async () => {
    vi.useFakeTimers(); fake(); vi.spyOn(process, 'kill').mockReturnValue(true)
    const controller = new AbortController()
    const result = runBoundedShell(prepare, { signal: controller.signal })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await vi.advanceTimersByTimeAsync(300)
    expect(await result).toMatchObject({ success: false, cancelled: true, error: 'Command cancelled' })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds hung preparation and never spawns when it resolves late', async () => {
    vi.useFakeTimers(); vi.mocked(cp.spawn).mockClear()
    let release!: (value: PreparedShell) => void
    const result = runBoundedShell(() => new Promise(resolve => { release = resolve }), { timeoutMs: 10 })
    await vi.advanceTimersByTimeAsync(10)
    expect(await result).toMatchObject({ timedOut: true })
    release(await prepare()); await vi.advanceTimersByTimeAsync(0)
    expect(cp.spawn).not.toHaveBeenCalled()
  })
  it('honors an earlier epoch deadline and pre-abort without preparation', async () => {
    vi.useFakeTimers(); const prep = vi.fn(prepare)
    const controller = new AbortController(); controller.abort()
    expect(await runBoundedShell(prep, { signal: controller.signal })).toMatchObject({ cancelled: true })
    expect(prep).not.toHaveBeenCalled()
    const result = runBoundedShell(() => new Promise(() => {}), { deadlineMs: Date.now() + 5 })
    await vi.advanceTimersByTimeAsync(5)
    expect(await result).toMatchObject({ timedOut: true })
  })
  it('preserves success codes, filtering, cwd and truncation', async () => {
    vi.useFakeTimers(); const child = fake()
    const result = runBoundedShell(prepare, { successCodes: [7], maxOutputChars: 5 }, true)
    await vi.advanceTimersByTimeAsync(0)
    child.stdout.write('abcdef'); child.emit('close', 7)
    expect(await result).toMatchObject({ success: true, cwd: '/test', stdout: 'abcde', stderr: '\n[Output truncated at 5 characters]' })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('settles spawn and preparation errors, tolerating late stream errors', async () => {
    vi.useFakeTimers(); const child = fake()
    const result = runBoundedShell(prepare)
    await vi.advanceTimersByTimeAsync(0)
    child.emit('error', new Error('spawn failed'))
    expect(await result).toMatchObject({ success: false, error: 'spawn failed' })
    child.stdout.emit('error', new Error('late'))
    expect(await runBoundedShell(async () => { throw new Error('prep failed') })).toMatchObject({ error: 'prep failed' })
  })
})

describe('shell output and fallback safety', () => {
  it('falls back for both POSIX signals when group kill fails', async () => {
    vi.useFakeTimers(); const child = fake()
    vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH') })
    const result = runBoundedShell(prepare, { timeoutMs: 10 })
    await vi.advanceTimersByTimeAsync(310)
    expect(await result).toMatchObject({ timedOut: true })
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('preserves split UTF-8, combined output cap, actual cwd and benign EPIPE', async () => {
    vi.useFakeTimers(); const child = fake()
    const result = runBoundedShell(async () => ({ cmd: 'fake', args: [], cwd: '/actual' }), { cwd: '/requested', maxOutputChars: 5 })
    await vi.advanceTimersByTimeAsync(0)
    const bytes = Buffer.from('é')
    child.stdout.write(bytes.subarray(0, 1)); child.stdout.write(bytes.subarray(1))
    child.stderr.write('abcdMORE')
    child.stdin.emit('error', Object.assign(new Error('closed pipe'), { code: 'EPIPE' }))
    child.emit('close', 0)
    expect(await result).toMatchObject({ success: true, stdout: 'é', stderr: 'abcd', cwd: '/actual' })
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      expect(stream.destroyed).toBe(true)
      expect(() => stream.emit('error', new Error('late'))).not.toThrow()
    }
    expect(vi.getTimerCount()).toBe(0)
  })
  it('filters known terminal warnings without losing normal stderr', async () => {
    vi.useFakeTimers(); const child = fake()
    const result = runBoundedShell(prepare)
    await vi.advanceTimersByTimeAsync(0)
    child.stderr.write('warning\nyour 131072x1 screen size is bogus. expect trouble\nuseful\n')
    child.emit('close', 0)
    expect(await result).toMatchObject({ success: true, stderr: 'warning\nuseful\n' })
  })
})
