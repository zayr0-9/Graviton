import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canFallbackToLocalExecution, ToolRuntimeSandboxHost, type SandboxProcessHandle } from '../toolRuntimeSandbox.js'

function harness() {
  let message!: (value: unknown) => void
  let exit!: (code: number | null) => void
  const process: SandboxProcessHandle = {
    postMessage: vi.fn(), kill: vi.fn(),
    onMessage: fn => { message = fn }, onExit: fn => { exit = fn }, onError: vi.fn(),
  }
  const fork = vi.fn(() => process)
  const host = new ToolRuntimeSandboxHost({ fork })
  return { host, process, fork, ready: () => message({ type: 'ready' }), message: (v: unknown) => message(v), exit: () => exit(1) }
}
const flush = async () => { await vi.advanceTimersByTimeAsync(0) }
const sent = (h: ReturnType<typeof harness>) => vi.mocked(h.process.postMessage).mock.calls.map(c => c[0] as any)

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('utility request cancellation lifecycle', () => {
  it('strips signal from IPC and cleans listeners after success', async () => {
    const h = harness(); const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const p = h.host.executeTool('bash', {}, { signal: controller.signal, deadlineMs: 120_000 })
    h.ready(); await flush()
    const request = sent(h)[0]
    expect(request.options).toEqual({ deadlineMs: 120_000 })
    h.message({ type: 'tool_result', requestId: request.requestId, success: true, result: 'ok' })
    await expect(p).resolves.toBe('ok')
    controller.abort()
    expect(sent(h)).toHaveLength(1)
    expect(remove).toHaveBeenCalled()
    expect((h.host as any).pending.size).toBe(0)
  })

  it('rejects pre-aborted requests without initialization or fallback', async () => {
    const h = harness(); const controller = new AbortController(); controller.abort()
    const error = await h.host.executeTool('bash', {}, { signal: controller.signal }).catch(e => e)
    expect(error).toMatchObject({ name: 'AbortError', dispatched: false })
    expect(canFallbackToLocalExecution(error)).toBe(false)
    expect(h.fork).not.toHaveBeenCalled()
  })

  it('aborts during initialization promptly without later dispatch or killing shared runtime', async () => {
    const h = harness(); const controller = new AbortController()
    const p = h.host.executeTool('bash', {}, { signal: controller.signal }).catch(e => e)
    controller.abort()
    expect(await p).toMatchObject({ name: 'AbortError', dispatched: false })
    h.ready(); await flush()
    expect(sent(h)).toEqual([])
    expect(h.process.kill).not.toHaveBeenCalled()
    const next = h.host.executeTool('read_file', {})
    await flush()
    h.message({ type: 'tool_result', requestId: sent(h)[0].requestId, success: true })
    await next
  })

  it('cancels only its dispatched request and ignores late results', async () => {
    const h = harness(); const controller = new AbortController()
    const p = h.host.executeTool('bash', {}, { signal: controller.signal }).catch(e => e)
    h.ready(); await flush()
    const requestId = sent(h)[0].requestId
    controller.abort()
    expect(await p).toMatchObject({ name: 'AbortError', dispatched: true })
    expect(sent(h)[1]).toEqual({ type: 'cancel_tool', requestId })
    h.message({ type: 'tool_result', requestId, success: true })
    expect((h.host as any).pending.size).toBe(0)
    expect(h.process.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['bash', {}], ['powershell', {}],
    ['bash', { timeoutMs: 180_000 }], ['powershell', { timeoutMs: 180_000 }],
  ] as const)('allows three minutes for %s with %j plus margin', async (tool, args) => {
    const h = harness()
    const p = h.host.executeTool(tool, args).catch(e => e)
    h.ready(); await flush()
    expect(sent(h)[0].options.deadlineMs).toBe(280_000)
    await vi.advanceTimersByTimeAsync(180_000)
    expect(sent(h)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await p).toMatchObject({ dispatched: true, errorCode: 'deadline_exceeded' })
    expect(sent(h)[1].type).toBe('cancel_tool')
  })

  it('constrains the response wait to deadline plus margin', async () => {
    const h = harness()
    const p = h.host.executeTool('bash', { timeoutMs: 120_000 }, { deadlineMs: 102_000 }).catch(e => e)
    h.ready(); await flush()
    await vi.advanceTimersByTimeAsync(2999)
    expect(sent(h)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(canFallbackToLocalExecution(await p)).toBe(false)
    expect(sent(h)[1].type).toBe('cancel_tool')
  })

  it('starts budget before initialization and never dispatches after deadline', async () => {
    const h = harness()
    const p = h.host.executeTool('bash', {}, { deadlineMs: 100_500 }).catch(e => e)
    await vi.advanceTimersByTimeAsync(1500)
    expect(await p).toMatchObject({ dispatched: false, name: 'TimeoutError' })
    h.ready(); await flush()
    expect(sent(h)).toEqual([])
    expect(h.process.kill).not.toHaveBeenCalled()
  })

  it('does not dispatch after the argument timeout expires during initialization', async () => {
    const h = harness()
    const p = h.host.executeTool('bash', { timeoutMs: 100 }).catch(e => e)
    await vi.advanceTimersByTimeAsync(200)
    h.ready(); await flush()
    expect(await p).toMatchObject({ dispatched: false, name: 'TimeoutError' })
    expect(sent(h)).toEqual([])
  })

  it('rejects an already expired deadline without forking', async () => {
    const h = harness()
    const error = await h.host.executeTool('bash', {}, { deadlineMs: Date.now() }).catch(e => e)
    expect(error.dispatched).toBe(false)
    expect(canFallbackToLocalExecution(error)).toBe(false)
    expect(h.fork).not.toHaveBeenCalled()
  })

  it.each(['exit', 'send'])('treats %s failure after send attempt as dispatched and cleans pending state', async mode => {
    const h = harness()
    if (mode === 'send') vi.mocked(h.process.postMessage).mockImplementation(() => { throw new Error('send failed') })
    const p = h.host.executeTool('bash', {}).catch(e => e)
    h.ready(); await flush()
    if (mode === 'exit') h.exit()
    const error = await p
    expect(error.dispatched).toBe(true)
    expect(canFallbackToLocalExecution(error)).toBe(false)
    expect((h.host as any).pending.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('allows fallback only on known pre-dispatch non-cancellation failures', async () => {
    const host = new ToolRuntimeSandboxHost({ fork: () => { throw new Error('unavailable') } })
    const error = await host.executeTool('bash', {}).catch(e => e)
    expect(error.dispatched).toBe(false)
    expect(canFallbackToLocalExecution(error)).toBe(true)
    for (const value of [null, new Error('unknown'), { dispatched: true }, { dispatched: false, name: 'AbortError' }, { dispatched: false, errorCode: 'deadline_exceeded' }]) {
      expect(canFallbackToLocalExecution(value)).toBe(false)
    }
  })
})
