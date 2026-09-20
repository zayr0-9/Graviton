import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { glob } from 'glob'
import { isWindows, resolveToWindowsPath } from '../../utils/wslBridge.js'
import { globSearch } from '../glob.js'

vi.mock('glob', () => ({ glob: { iterate: vi.fn() } }))
vi.mock('../../utils/wslBridge.js', () => ({
  isWindows: vi.fn(() => false),
  detectPathType: (value: string) => value.startsWith('/') ? 'linux' : 'relative',
  resolveToWindowsPath: vi.fn(),
}))
const iterate = vi.mocked(glob.iterate)
const never = () => ({ [Symbol.asyncIterator]() { return this }, next: () => new Promise<IteratorResult<string>>(() => {}) })
beforeEach(() => { vi.useFakeTimers(); vi.mocked(isWindows).mockReturnValue(false) })
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })

describe('bounded glob search', () => {
  it('returns matches and clears the timeout and caller listener', async () => {
    iterate.mockImplementation(async function* () { yield 'a.ts'; yield 'b.ts' } as any)
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    expect(await globSearch('*.ts', { signal: controller.signal })).toMatchObject({ success: true, matches: ['a.ts', 'b.ts'] })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts traversal and settles even when the iterator ignores abort', async () => {
    iterate.mockImplementation(never as any)
    const result = globSearch('**/*')
    await vi.advanceTimersByTimeAsync(0)
    const signal = iterate.mock.calls[0][1]!.signal!
    await vi.advanceTimersByTimeAsync(5000)
    expect(await result).toMatchObject({ success: false, matches: [], timedOut: true, error: expect.stringContaining('timed out') })
    expect(signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels active traversal without waiting for its timeout', async () => {
    iterate.mockImplementation(never as any)
    const controller = new AbortController()
    const result = globSearch('*', { signal: controller.signal })
    await vi.advanceTimersByTimeAsync(0)
    const signal = iterate.mock.calls[0][1]!.signal!
    controller.abort()
    expect(await result).toMatchObject({ success: false, cancelled: true })
    expect(signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not traverse after pre-cancellation or an expired deadline', async () => {
    const controller = new AbortController(); controller.abort()
    expect(await globSearch('*', { signal: controller.signal })).toMatchObject({ cancelled: true })
    expect(await globSearch('*', { deadlineMs: Date.now() - 1 })).toMatchObject({ timedOut: true })
    expect(iterate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses an earlier caller deadline and bounds late WSL preparation', async () => {
    vi.mocked(isWindows).mockReturnValue(true)
    let release!: (path: string) => void
    vi.mocked(resolveToWindowsPath).mockImplementation(() => new Promise(resolve => { release = resolve }))
    const result = globSearch('*', { cwd: '/home/repo', deadlineMs: Date.now() + 20 })
    await vi.advanceTimersByTimeAsync(20)
    expect(await result).toMatchObject({ timedOut: true })
    const options = vi.mocked(resolveToWindowsPath).mock.calls[0][1]!
    expect(options.signal?.aborted).toBe(true)
    release('\\\\wsl$\\Ubuntu\\home\\repo')
    await vi.advanceTimersByTimeAsync(0)
    expect(iterate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains a native UNC cwd for Windows filesystem access', async () => {
    vi.mocked(isWindows).mockReturnValue(true)
    const cwd = '\\\\wsl$\\Ubuntu\\home\\repo'
    vi.mocked(resolveToWindowsPath).mockResolvedValue(cwd)
    iterate.mockImplementation(async function* () { yield 'a.ts' } as any)
    expect(await globSearch('*', { cwd: '/home/repo' })).toMatchObject({ success: true, cwd })
    expect(iterate.mock.calls[0][1]!.cwd).toBe(cwd)
  })

  it('stops at the match limit instead of collecting the whole traversal', async () => {
    let yielded = 0
    iterate.mockImplementation(async function* () { for (let i = 0; i < 100; i++) { yielded++; yield String(i) } } as any)
    expect(await globSearch('*', { maxMatches: 2 })).toMatchObject({ success: false, matches: [], error: expect.stringContaining('Too many matches') })
    expect(yielded).toBe(3)
    expect(iterate.mock.calls[0][1]!.signal!.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('maps file type objects and forwards ignores/options', async () => {
    iterate.mockImplementation(async function* () { yield { fullpath: () => '/repo/a.ts' } } as any)
    expect(await globSearch('*', { withFileTypes: true, nodir: true, ignore: '*.log' })).toMatchObject({ matches: ['/repo/a.ts'] })
    expect(iterate.mock.calls[0][1]).toMatchObject({ withFileTypes: true, nodir: true, ignore: expect.arrayContaining(['*.log', '**/node_modules/**']) })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans up on traversal failures and rejects empty patterns', async () => {
    iterate.mockImplementation(async function* () { throw new Error('filesystem unavailable') } as any)
    expect(await globSearch('*')).toMatchObject({ success: false, error: 'filesystem unavailable' })
    expect(await globSearch(' ')).toMatchObject({ success: false, error: 'Pattern cannot be empty' })
    expect(vi.getTimerCount()).toBe(0)
  })
})
