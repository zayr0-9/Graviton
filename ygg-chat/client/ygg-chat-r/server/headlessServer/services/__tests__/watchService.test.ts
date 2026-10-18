import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatchService, createWatchExecutor } from '../watchService.js'
import { ToolOrchestrator } from '../../../tools/orchestrator/ToolOrchestrator.js'

const context = { conversationId: 'conversation', lineageId: 'branch', messageId: 'message' }
const services: WatchService[] = []
const dirs: string[] = []
const make = () => {
  const notify = vi.fn()
  const service = new WatchService(notify)
  services.push(service)
  return { service, notify }
}
const directory = async () => { const dir = await mkdtemp(join(tmpdir(), 'watch-test-')); dirs.push(dir); return dir }
const wait = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms))
afterEach(async () => { services.splice(0).forEach(s => s.shutdown()); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); vi.restoreAllMocks(); vi.useRealTimers() })

describe('branch-scoped watcher', () => {
  it('returns immediately, scopes handles by lineage and conversation, and cancels idempotently', async () => {
    const { service, notify } = make()
    const result = service.execute({ action: 'start', kind: 'process_exit', pid: process.pid }, context)
    expect(result.state).toBe('waiting')
    expect(result.autoResume).toBe(false)
    expect(() => service.execute({ action: 'status', handle: result.handle }, { ...context, lineageId: 'other' })).toThrow('owned')
    expect(() => service.execute({ action: 'cancel', handle: result.handle }, { ...context, conversationId: 'other' })).toThrow('owned')
    expect(service.execute({ action: 'list' }, { ...context, lineageId: 'other' }).watches).toEqual([])
    for (let i = 0; i < 2; i++) expect(service.execute({ action: 'cancel', handle: result.handle }, context).state).toBe('cancelled')
    await wait()
    expect(notify).not.toHaveBeenCalled()
  })

  it('times out once and shuts down without late events', async () => {
    const { service, notify } = make()
    const result = service.execute({ action: 'start', kind: 'process_exit', pid: process.pid, timeoutMs: 100 }, context)
    await wait(250)
    expect(service.execute({ action: 'status', handle: result.handle }, context).state).toBe('timed_out')
    expect(notify).toHaveBeenCalledTimes(1)
    service.execute({ action: 'start', kind: 'process_exit', pid: process.pid }, context)
    service.shutdown()
    await wait()
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('handles absent processes and does not disclose conditions', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('secret'), { code: 'ESRCH' }) })
    const { service, notify } = make()
    const result = service.execute({ action: 'start', kind: 'process_exit', pid: 123 }, context)
    await wait()
    expect(service.execute({ action: 'status', handle: result.handle }, context).state).toBe('triggered')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(notify.mock.calls)).not.toContain('secret')
    expect(notify.mock.calls[0][0]).not.toHaveProperty('pid')
  })

  it('waits for missing file creation, detects a change, and enforces workspace paths', async () => {
    const rootPath = await directory()
    const { service } = make()
    const ctx = { ...context, rootPath }
    expect(() => service.execute({ action: 'start', kind: 'file_created', path: '../escape' }, ctx)).toThrow('workspace')
    const created = service.execute({ action: 'start', kind: 'file_created', path: 'result', checkIntervalMs: 100 }, ctx)
    await wait(30)
    await writeFile(join(rootPath, 'result'), 'first')
    await wait()
    expect(service.execute({ action: 'status', handle: created.handle }, ctx).state).toBe('triggered')
    const changed = service.execute({ action: 'start', kind: 'file_changed', path: 'result', checkIntervalMs: 100 }, ctx)
    await wait(30)
    await appendFile(join(rootPath, 'result'), 'second')
    await wait()
    expect(service.execute({ action: 'status', handle: changed.handle }, ctx).state).toBe('triggered')
  })

  it('matches strings across appended chunks and regexes without exposing log text', async () => {
    const rootPath = await directory()
    const { service, notify } = make()
    const ctx = { ...context, rootPath }
    await writeFile(join(rootPath, 'log'), 'secret: REA')
    const result = service.execute({ action: 'start', kind: 'log_match', path: 'log', pattern: 'READY', checkIntervalMs: 100 }, ctx)
    await wait(30)
    await appendFile(join(rootPath, 'log'), 'DY')
    await wait()
    expect(service.execute({ action: 'status', handle: result.handle }, ctx).state).toBe('triggered')
    const regex = service.execute({ action: 'start', kind: 'log_match', path: 'log', pattern: 'REA.DY|READY', regex: true }, ctx)
    await wait(300)
    expect(service.execute({ action: 'status', handle: regex.handle }, ctx).state).toBe('triggered')
    expect(JSON.stringify(notify.mock.calls)).not.toContain('secret')
  })

  it('isolates pathological regex checks and reports fixed errors for non-files', async () => {
    const rootPath = await directory()
    const { service, notify } = make()
    const ctx = { ...context, rootPath }
    await writeFile(join(rootPath, 'log'), 'a'.repeat(20000) + '!')
    const regex = service.execute({ action: 'start', kind: 'log_match', path: 'log', pattern: '(a+)+$', regex: true }, ctx)
    await wait(700)
    expect(service.execute({ action: 'status', handle: regex.handle }, ctx).state).toBe('error')
    const dirWatch = service.execute({ action: 'start', kind: 'file_created', path: rootPath }, ctx)
    await wait(50)
    expect(service.execute({ action: 'status', handle: dirWatch.handle }, ctx).state).toBe('error')
    expect(notify).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(notify.mock.calls)).not.toContain(rootPath)
  })

  it('retries unreachable HTTP, uses expected status, and aborts in-flight requests on cancellation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('secret')).mockResolvedValue(new Response(null, { status: 204 }))
    const { service } = make()
    const result = service.execute({ action: 'start', kind: 'http_status', url: 'http://localhost:1234', expectedStatus: 204, checkIntervalMs: 100 }, context)
    await wait(250)
    expect(service.execute({ action: 'status', handle: result.handle }, context).state).toBe('triggered')
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('manual')
    fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))))
    const cancelled = service.execute({ action: 'start', kind: 'http_status', url: 'http://localhost:1234' }, context)
    await wait(30)
    service.execute({ action: 'cancel', handle: cancelled.handle }, context)
    expect(fetchMock.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true)
  })

  it('rejects invalid conditions and missing lineage, caps watches, and routes through an executor', async () => {
    const { service } = make()
    expect(() => service.execute({ action: 'start', kind: 'shell', command: 'echo no' }, context)).toThrow('Unknown')
    expect(() => service.execute({ action: 'list' }, { ...context, lineageId: null })).toThrow('branch')
    expect(() => service.execute({ action: 'start', kind: 'http_status', url: 'http://user:secret@localhost' }, context)).toThrow('credentials')
    expect(() => service.execute({ action: 'start', kind: 'process_exit', pid: -1 }, context)).toThrow('range')
    for (let i = 0; i < 16; i++) service.execute({ action: 'start', kind: 'process_exit', pid: process.pid }, context)
    expect(() => service.execute({ action: 'start', kind: 'process_exit', pid: process.pid }, context)).toThrow('capacity')
    const leaf = vi.fn().mockResolvedValue('leaf')
    const execute = createWatchExecutor(leaf, service, () => null)
    expect((await execute({ id: 'call', name: 'watcher', arguments: '{"action":"list"}' }, context)).watches).toHaveLength(16)
    expect(await execute({ id: 'call', name: 'other', arguments: '{}' }, context)).toBe('leaf')
    expect(leaf).toHaveBeenCalledTimes(1)
  })

  it('registers bridge completion immediately, deduplicates and delivers text only through the branch queue', async () => {
    const { service, notify } = make()
    const release = vi.fn()
    const retain = vi.fn(() => release)
    const deliver = vi.fn(event => ({ ...event, delivery: 'queued' }))
    service.configureContinuation({ retain, deliver })
    const ctx = { ...context, streamId: 'origin' }
    let resolve!: (result: any) => void
    const completion = new Promise<any>(done => { resolve = done })
    const first = service.registerBridgeJob('job', completion, ctx, null, 'wait-call')
    expect(first).toMatchObject({ state: 'waiting', autoResume: true, kind: 'claude_bridge' })
    expect(service.registerBridgeJob('job', completion, ctx, null).handle).toBe(first.handle)
    expect(retain).toHaveBeenCalledTimes(1)
    expect(deliver).not.toHaveBeenCalled()
    const source = { action: 'send', toolCallId: 'launch-call', messageId: 'launch-message', streamId: 'launch-stream' }
    resolve({ sessionId: 'session', job: { id: 'job', status: 'completed', source }, content: 'Private review result', truncated: true })
    await Promise.resolve()
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0][0]).toMatchObject({ source, registrationToolCallId: 'wait-call' })
    expect(deliver.mock.calls[0][2]).toContain('Source: claude_bridge send, tool call launch-call, assistant message launch-message')
    expect(deliver.mock.calls[0][2]).not.toContain('tool call wait-call')
    expect(deliver.mock.calls[0][2]).toContain('Private review result')
    expect(deliver.mock.calls[0][2]).toContain('truncated')
    expect(JSON.stringify(notify.mock.calls)).not.toContain('Private review result')
    expect(service.execute({ action: 'status', handle: first.handle }, ctx)).toMatchObject({ state: 'triggered', delivery: 'queued' })
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('has no watcher deadline for bridge jobs and labels legacy jobs without invented provenance', async () => {
    vi.useFakeTimers()
    const { service, notify } = make()
    let resolve!: (result: any) => void
    const completion = new Promise<any>(done => { resolve = done })
    const registration = service.registerBridgeJob('long-job', completion, context, null)
    await vi.advanceTimersByTimeAsync(600001)
    expect(service.execute({ action: 'status', handle: registration.handle }, context)).toMatchObject({ state: 'waiting' })
    expect(notify).not.toHaveBeenCalled()
    const deliver = vi.fn(event => ({ ...event, delivery: 'queued' }))
    service.configureContinuation({ retain: () => () => {}, deliver })
    // Use a stream-bearing registration for delivery, independent of the long watch above.
    service.registerBridgeJob('legacy', Promise.resolve({ job: { status: 'completed' }, content: 'Legacy reply' }),
      { ...context, streamId: 'origin' }, null)
    await Promise.resolve()
    expect(deliver.mock.calls[0][2]).toContain('Source tool-call reference unavailable')
    expect(deliver.mock.calls[0][0].source).toBeUndefined()
    resolve({ job: { status: 'completed' } })
    await Promise.resolve()
  })

  it('retains bridge deduplication after terminal status rows are evicted', async () => {
    const { service, notify } = make()
    const ctx = { ...context, streamId: 'origin' }
    const completion = Promise.resolve({ job: { id: 'original', status: 'completed' }, content: 'Old review' })
    const original = service.registerBridgeJob('original', completion, ctx, null)
    await Promise.resolve()
    for (let index = 0; index < 40; index++) {
      service.registerBridgeJob(`job-${index}`, Promise.resolve({ job: { status: 'completed' } }), ctx, null)
      await Promise.resolve()
    }
    expect(() => service.execute({ action: 'status', handle: original.handle }, ctx)).toThrow('owned')
    const count = notify.mock.calls.length
    expect(service.registerBridgeJob('original', completion, ctx, null)).toMatchObject({ duplicate: true, state: 'triggered' })
    await Promise.resolve()
    expect(notify).toHaveBeenCalledTimes(count)
  })

  it('suppresses cancelled/shutdown bridge messages and reports failed delivery without exposing results', async () => {
    const { service, notify } = make()
    const release = vi.fn()
    const deliver = vi.fn(() => { throw new Error('private transport error') })
    service.configureContinuation({ retain: () => release, deliver })
    const ctx = { ...context, streamId: 'origin' }
    service.registerBridgeJob('failed', Promise.resolve({ sessionId: 's', job: { id: 'failed', status: 'failed', error: 'Fixed CLI error' } }), ctx, null)
    await Promise.resolve()
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toMatchObject({ state: 'error', delivery: 'failed' })
    service.registerBridgeJob('cancelled', Promise.resolve({ job: { status: 'cancelled' } }), ctx, null)
    await Promise.resolve()
    expect(deliver).toHaveBeenCalledTimes(1)
    let resolve!: (result: any) => void
    service.registerBridgeJob('shutdown', new Promise(done => { resolve = done }), ctx, null)
    service.shutdown()
    resolve({ job: { status: 'completed' }, content: 'Late private answer' })
    await Promise.resolve()
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(notify.mock.calls)).not.toContain('private')
  })

  it('pushes completions once, replays on subscribe and clears on shutdown', () => {
    const orchestrator = new ToolOrchestrator({ persistJobs: false })
    const event = { handle: 'handle', kind: 'file_created' as const, state: 'triggered' as const, ...context, projectId: null, completedAt: new Date().toISOString() }
    const ws = { readyState: 1, on: vi.fn(), send: vi.fn() }
    orchestrator.subscribe(ws as any)
    orchestrator.publishWatchCompletion(event)
    orchestrator.publishWatchCompletion(event)
    expect(ws.send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(ws.send.mock.calls[0][0]).type).toBe('watch_completion')
    const next = { ...ws, send: vi.fn() }
    orchestrator.subscribe(next as any)
    expect(next.send).toHaveBeenCalledTimes(1)
    orchestrator.shutdown()
    const last = { ...ws, send: vi.fn() }
    orchestrator.subscribe(last as any)
    expect(last.send).not.toHaveBeenCalled()
  })
})
