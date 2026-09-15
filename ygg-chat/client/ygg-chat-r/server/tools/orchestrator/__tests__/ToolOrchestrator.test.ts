import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolOrchestrator } from '../ToolOrchestrator.js'

const deferred = () => {
  let resolve!: (value: unknown) => void
  let reject!: (reason: Error) => void
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('ToolOrchestrator cancellation and deadlines', () => {
  let orchestrator: ToolOrchestrator
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    orchestrator = new ToolOrchestrator({ persistJobs: false, concurrencyLimit: 1, defaultTimeoutMs: 5000 })
  })
  afterEach(async () => {
    orchestrator.shutdown()
    await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('aborts running work and immediately dispatches the next queued job', async () => {
    const handler = vi.fn((_args: unknown, _options: { signal?: AbortSignal }) => new Promise(() => {}))
    orchestrator.registerTool('work', handler)
    const first = orchestrator.submit('work', {})
    const second = orchestrator.submit('work', {})
    expect(second.status).toBe('pending')
    const signal = handler.mock.calls[0][1]?.signal
    expect(orchestrator.cancel(first.id)).toBe(true)
    expect(signal!.aborted).toBe(true)
    expect(second.status).toBe('running')
    expect(handler).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(orchestrator.getStats().activeWorkers).toBe(1)
  })

  it('includes queued time in the caller deadline forwarded to a shell', async () => {
    const startedAt = Date.now()
    const blocker = deferred()
    orchestrator.registerTool('work', () => blocker.promise)
    const shell = vi.fn(async (_args: unknown, _options: { deadlineMs?: number }) => ({ success: false, timedOut: true }))
    orchestrator.registerTool('bash', shell)
    orchestrator.submit('work', {})
    orchestrator.submit('bash', {}, { timeoutMs: 5000, deadlineMs: startedAt + 5000 })
    await vi.advanceTimersByTimeAsync(2000)
    blocker.resolve('done')
    await vi.advanceTimersByTimeAsync(0)
    expect(shell.mock.calls[0][1].deadlineMs).toBe(startedAt + 4000)
  })

  it('never invokes a handler when its caller deadline already expired', async () => {
    const handler = vi.fn(async () => 'must not execute')
    orchestrator.registerTool('work', handler)
    const job = orchestrator.submit('work', {}, { deadlineMs: Date.now() - 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(handler).not.toHaveBeenCalled()
    expect(job.status).toBe('failed')
    expect(job.error).toContain('deadline elapsed')
  })

  it('removes pending work without invoking it', async () => {
    const handler = vi.fn((_args: unknown, _options: { signal?: AbortSignal }) => new Promise(() => {}))
    orchestrator.registerTool('work', handler)
    const first = orchestrator.submit('work', {})
    const pending = orchestrator.submit('work', {})
    expect(orchestrator.cancel(pending.id)).toBe(true)
    orchestrator.cancel(first.id)
    await vi.advanceTimersByTimeAsync(10000)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(pending.status).toBe('cancelled')
    expect(orchestrator.cancel(pending.id)).toBe(false)
  })

  it('settles the execution lifecycle and clears its timer even if the signal is ignored', async () => {
    const execute = vi.spyOn(orchestrator as any, 'executeJob')
    orchestrator.registerTool('work', () => new Promise(() => {}))
    const job = orchestrator.submit('work', {})
    orchestrator.cancel(job.id)
    await expect(execute.mock.results[0].value).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    expect((orchestrator as any).jobControllers.size).toBe(0)
    expect(orchestrator.getStats().activeWorkers).toBe(0)
  })

  it.each(['resolve', 'reject'] as const)('does not overwrite cancellation on late %s', async outcome => {
    const work = deferred()
    const handler = vi.fn(() => work.promise)
    orchestrator.registerTool('work', handler)
    const job = orchestrator.submit('work', {}, { retries: 2 })
    orchestrator.cancel(job.id)
    const completedAt = job.completedAt
    if (outcome === 'resolve') work.resolve('late output')
    else work.reject(new Error('late error'))
    await vi.advanceTimersByTimeAsync(10000)
    expect(job.status).toBe('cancelled')
    expect(job.completedAt).toBe(completedAt)
    expect(job.result).toBeNull()
    expect(job.error).toBeNull()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('aborts the actual handler on timeout and ignores a late result', async () => {
    const work = deferred()
    let signal!: AbortSignal
    orchestrator.registerTool('work', (_, options) => { signal = options.signal!; return work.promise })
    const job = orchestrator.submit('work', {})
    await vi.advanceTimersByTimeAsync(5000)
    expect(signal!.aborted).toBe(true)
    expect(job.status).toBe('failed')
    expect(job.error).toContain('timed out after 5000ms')
    work.resolve('late')
    await vi.advanceTimersByTimeAsync(0)
    expect(job.status).toBe('failed')
    expect(job.result).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['bash', 'powershell'])('does not retry %s after rejection or timeout', async toolName => {
    const handler = vi.fn().mockRejectedValueOnce(new Error('uncertain execution'))
      .mockImplementation(() => new Promise(() => {}))
    orchestrator.registerTool(toolName, handler)
    const rejected = orchestrator.submit(toolName, {}, { retries: 2 })
    await vi.advanceTimersByTimeAsync(10000)
    expect(rejected.status).toBe('failed')
    expect(handler).toHaveBeenCalledTimes(1)
    const timedOut = orchestrator.submit(toolName, {}, { retries: 2 })
    await vi.advanceTimersByTimeAsync(10000)
    expect(timedOut.status).toBe('failed')
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('preserves delayed non-shell retries', async () => {
    const handler = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue('ok')
    orchestrator.registerTool('read_file', handler)
    const job = orchestrator.submit('read_file', {}, { retries: 1, retryDelayMs: 100 })
    await vi.advanceTimersByTimeAsync(0)
    expect(job.status).toBe('pending')
    await vi.advanceTimersByTimeAsync(99)
    expect(handler).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(job.status).toBe('completed')
    expect(job.result).toBe('ok')
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('cancels a delayed retry and guards a stale retry callback', async () => {
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    const handler = vi.fn().mockRejectedValue(new Error('temporary'))
    orchestrator.registerTool('read_file', handler)
    const job = orchestrator.submit('read_file', {}, { retries: 2, retryDelayMs: 100 })
    await vi.advanceTimersByTimeAsync(0)
    const callback = timerSpy.mock.calls.find(call => call[1] === 100)![0] as () => void
    expect(orchestrator.cancel(job.id)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    callback()
    await vi.advanceTimersByTimeAsync(10000)
    expect(job.status).toBe('cancelled')
    expect(handler).toHaveBeenCalledTimes(1)
    expect((orchestrator as any).pendingQueue).toEqual([])
  })

  it.each([['bash', 4000], ['powershell', 4000], ['read_file', 5000]])(
    'forwards the signal and absolute deadline for %s', async (name, offset) => {
      const handler = vi.fn().mockResolvedValue('ok')
      orchestrator.registerTool(name as string, handler)
      const now = Date.now()
      orchestrator.submit(name as string, {})
      expect(handler.mock.calls[0][1]).toMatchObject({ deadlineMs: now + Number(offset), signal: expect.any(AbortSignal) })
      await vi.advanceTimersByTimeAsync(0)
    }
  )

  it('shuts down active, pending and delayed-retry jobs without dispatching new work', async () => {
    const retry = vi.fn().mockRejectedValue(new Error('temporary'))
    const work = vi.fn().mockImplementation(() => new Promise(() => {}))
    orchestrator.registerTool('retry', retry)
    orchestrator.registerTool('work', work)
    const delayed = orchestrator.submit('retry', {}, { retries: 1 })
    await vi.advanceTimersByTimeAsync(0)
    const active = orchestrator.submit('work', {})
    const pending = orchestrator.submit('work', {})
    orchestrator.shutdown()
    expect(work.mock.calls[0][1].signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(10000)
    expect([delayed.status, active.status, pending.status]).toEqual(['cancelled', 'cancelled', 'cancelled'])
    expect(work).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(orchestrator.getStats().activeWorkers).toBe(0)
    expect(() => orchestrator.submit('work', {})).toThrow('shut down')
  })
})
