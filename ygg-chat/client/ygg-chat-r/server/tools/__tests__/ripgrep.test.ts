import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import * as cp from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getNativeShellPath } from '../nativeShell.js'
import { getWSLCommandArgs, shouldUseWSL } from '../../utils/wslBridge.js'
import { ripgrepSearch } from '../ripgrep.js'

vi.mock('child_process', async original => ({ ...await original<typeof cp>(), spawn: vi.fn() }))
vi.mock('../nativeShell.js', () => ({ getNativeShellPath: vi.fn(async () => '/custom/bin') }))
vi.mock('../../utils/wslBridge.js', () => ({
  detectPathType: (p: string) => p.startsWith('/') ? 'linux' : 'relative',
  shouldUseWSL: vi.fn(() => false), toWslPath: (p: string) => p,
  getWSLCommandArgs: vi.fn(async (cmd, args) => ['wsl.exe', ['-d', 'Ubuntu', '-e', cmd, ...args]]),
}))
function child() {
  const proc = Object.assign(new EventEmitter(), {
    pid: 12345678, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), unref: vi.fn(),
  })
  vi.mocked(cp.spawn).mockReturnValue(proc as any)
  return proc
}
const line = (type = 'match', text = 'needle\n') => JSON.stringify({ type, data: { path: { text: '/repo/a.ts' }, lines: { text }, line_number: 2 } }) + '\n'
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  vi.spyOn(process, 'kill').mockReturnValue(true)
  vi.mocked(getNativeShellPath).mockResolvedValue('/custom/bin')
  vi.mocked(shouldUseWSL).mockReturnValue(false)
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('bounded ripgrep search', () => {
  it('returns matches/context, keeps leading-dash patterns literal and imports native PATH', async () => {
    const proc = child(); const result = ripgrepSearch('-needle', '/repo', { contextLines: 1 })
    await vi.advanceTimersByTimeAsync(0)
    proc.stdout.write(line()); proc.stdout.write(line('context', 'neighbor\n')); proc.emit('close', 0)
    expect(await result).toMatchObject({ success: true, matches: [{ file: '/repo/a.ts', line: 'needle\n' }, { line: 'neighbor\n' }] })
    expect(cp.spawn).toHaveBeenCalledWith('rg', expect.arrayContaining(['-e', '-needle', '--', '/repo']), expect.objectContaining({ env: expect.objectContaining({ PATH: '/custom/bin' }) }))
    expect(vi.getTimerCount()).toBe(0)
    expect(proc.stdout.listenerCount('data')).toBe(0)
  })
  it('reports timeout, never success, even when the child closes on TERM', async () => {
    const proc = child(); const result = ripgrepSearch('x', '/repo')
    await vi.advanceTimersByTimeAsync(0); proc.stdout.write(line())
    await vi.advanceTimersByTimeAsync(30000); proc.emit('close', null, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(300)
    expect(await result).toMatchObject({ success: false, matches: [], timedOut: true })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('settles a never-closing child after bounded cleanup and kills the owned group', async () => {
    child(); const result = ripgrepSearch('x', '/repo', { timeoutMs: 10 })
    await vi.advanceTimersByTimeAsync(310)
    expect(await result).toMatchObject({ success: false, timedOut: true })
    expect(process.kill).toHaveBeenCalledWith(-12345678, 'SIGKILL')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cancels active execution', async () => {
    child(); const controller = new AbortController(); const result = ripgrepSearch('x', '/repo', { signal: controller.signal })
    await vi.advanceTimersByTimeAsync(0); controller.abort(); await vi.advanceTimersByTimeAsync(300)
    expect(await result).toMatchObject({ success: false, cancelled: true, matches: [] })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('never starts preparation for pre-abort or expired caller deadline', async () => {
    const controller = new AbortController(); controller.abort()
    expect(await ripgrepSearch('x', '.', { signal: controller.signal })).toMatchObject({ cancelled: true })
    expect(await ripgrepSearch('x', '.', { deadlineMs: Date.now() - 1 })).toMatchObject({ timedOut: true })
    expect(cp.spawn).not.toHaveBeenCalled(); expect(getNativeShellPath).not.toHaveBeenCalled()
  })
  it('bounds preparation and prevents late spawn', async () => {
    let release!: (value: string) => void
    vi.mocked(getNativeShellPath).mockImplementation(() => new Promise(resolve => { release = resolve }))
    const result = ripgrepSearch('x', '.', { deadlineMs: Date.now() + 10 })
    await vi.advanceTimersByTimeAsync(10)
    expect(await result).toMatchObject({ timedOut: true })
    release('/late/bin'); await vi.advanceTimersByTimeAsync(0)
    expect(cp.spawn).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  })
  it.each([2, 3, null])('does not call exit code %s a successful empty search', async code => {
    const proc = child(); const result = ripgrepSearch('x'); await vi.advanceTimersByTimeAsync(0); proc.emit('close', code)
    expect(await result).toMatchObject({ success: false, matches: [], error: expect.any(String) })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('preserves exit 1 as no matches', async () => {
    const proc = child(); const result = ripgrepSearch('x'); await vi.advanceTimersByTimeAsync(0); proc.emit('close', 1)
    expect(await result).toMatchObject({ success: true, matches: [] })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects capture overflow rather than parsing truncated output as success', async () => {
    const proc = child(); const result = ripgrepSearch('x'); await vi.advanceTimersByTimeAsync(0)
    proc.stdout.write('x'.repeat(250000)); proc.emit('close', 0)
    expect(await result).toMatchObject({ success: false, matches: [], error: expect.stringContaining('capture limit') })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('applies output limits to files-only results too', async () => {
    const proc = child(); const result = ripgrepSearch('x', '.', { filesWithMatches: true, maxOutputChars: 5 })
    await vi.advanceTimersByTimeAsync(0); proc.stdout.write('/very/long/path.ts\n'); proc.emit('close', 0)
    expect(await result).toMatchObject({ success: false, error: expect.stringContaining('too large') })
  })
  it('parses count output with Windows drive letters', async () => {
    const proc = child(); const result = ripgrepSearch('x', '.', { count: true })
    await vi.advanceTimersByTimeAsync(0); proc.stdout.write('C:\\repo\\a.ts:12\n'); proc.emit('close', 0)
    expect(await result).toMatchObject({ success: true, matches: [{ file: 'C:\\repo\\a.ts', matchCount: 12 }] })
  })
  it('uses positional args and an owned group for WSL searches', async () => {
    vi.mocked(shouldUseWSL).mockReturnValue(true)
    const proc = child(); const result = ripgrepSearch('$(touch nope)', '/repo')
    await vi.advanceTimersByTimeAsync(0); proc.emit('close', 1)
    expect(await result).toMatchObject({ success: true })
    const args = vi.mocked(getWSLCommandArgs).mock.calls[0][1]!
    expect(args[2]).toContain('exec rg "$@"')
    expect(args[2]).not.toContain('$(touch nope)')
    expect(args).toContain('$(touch nope)')
    expect(getNativeShellPath).not.toHaveBeenCalled()
  })
})

describe('Windows ripgrep preparation', () => {
  it('bounds hung executable discovery before rg can spawn', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    child()
    const result = ripgrepSearch('x', 'C:\\repo', { timeoutMs: 10 })
    await vi.advanceTimersByTimeAsync(610)
    expect(await result).toMatchObject({ success: false, timedOut: true })
    expect(vi.mocked(cp.spawn).mock.calls.some(([cmd]) => cmd === 'rg')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('prefers discovered native rg and clears discovery timers', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const discovery = child()
    const result = ripgrepSearch('x', 'C:\\repo')
    await vi.advanceTimersByTimeAsync(0)
    expect(cp.spawn).toHaveBeenCalledWith('where.exe', ['rg.exe'], expect.anything())
    discovery.stdout.write('C:\\bin\\rg.exe\r\n')
    const rg = child()
    discovery.emit('close', 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(cp.spawn).toHaveBeenCalledWith('C:\\bin\\rg.exe', expect.any(Array), expect.anything())
    rg.emit('close', 1)
    expect(await result).toMatchObject({ success: true, matches: [] })
    expect(vi.getTimerCount()).toBe(0)
  })
})
