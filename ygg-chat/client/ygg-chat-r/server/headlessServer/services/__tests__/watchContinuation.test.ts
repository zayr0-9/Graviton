import { describe, expect, it, vi } from 'vitest'
import { ChatOrchestrator } from '../chatOrchestrator.js'
import { MessageInputQueue } from '../messageInputQueue.js'
import { OperationModeControl } from '../operationModeControl.js'
import { WatchService } from '../watchService.js'
import { launchQueuedSuccessor } from '../../routes/chatRoutes.js'
import { RunSessionRegistry } from '../runSessionRegistry.js'

function harness() {
  const orchestrator = Object.create(ChatOrchestrator.prototype) as any
  orchestrator.inputRuns = new Map()
  orchestrator.watchPins = new Map()
  let head = 'final'
  orchestrator.lineageRepo = { get: (id: string) => id === 'branch' ? { id, conversation_id: 'chat', head_message_id: head } : null }
  const add = (id: string, state?: 'completed' | 'failed', lineageId = 'branch') => {
    const queue = new MessageInputQueue(id, 'chat', lineageId, () => {})
    if (state) queue.tryClose()
    const run = { queue, request: { conversationId: 'chat', lineageId, provider: 'openaichatgpt', modelName: 'test', toolAutoApprove: false, hooksEnabled: true },
      control: new OperationModeControl('plan'), head, terminal: state }
    orchestrator.inputRuns.set(id, run)
    return run
  }
  const context = { conversationId: 'chat', lineageId: 'branch', messageId: 'tool-parent', streamId: 'origin' }
  const submission = { requestId: 'watcher:handle', content: 'Watcher completion: triggered', watcherCompletion: { handle: 'handle', originMessageId: 'tool-parent' } }
  return { orchestrator, add, context, submission, setHead: (id: string) => { head = id } }
}

describe('watcher branch continuation', () => {
  it('queues into the live origin with stable request-id deduplication', () => {
    const h = harness(); const origin = h.add('origin')
    h.orchestrator.retainWatch(h.context)
    for (let i = 0; i < 2; i++) h.orchestrator.submitWatchMessage('chat', 'branch', 'origin', h.submission)
    expect(origin.queue.snapshot().items).toHaveLength(1)
    expect(origin.queue.claim()?.submission).toEqual(h.submission)
    expect(() => h.orchestrator.submitWatchMessage('other', 'branch', 'origin', h.submission)).toThrow('unavailable')
  })

  it('routes to a newer same-lineage live run, never a sibling branch', () => {
    const h = harness(); h.add('origin', 'completed'); h.setHead('new-head')
    const latest = h.add('latest')
    const sibling = h.add('sibling', undefined, 'fork')
    const result = h.orchestrator.submitWatchMessage('chat', 'branch', 'origin', h.submission)
    expect(result.snapshot.streamId).toBe('latest')
    expect(latest.queue.snapshot().items).toHaveLength(1)
    expect(sibling.queue.snapshot().items).toEqual([])
  })

  it('starts one successor from current tail with permissions/mode/provenance intact', () => {
    const h = harness(); h.add('origin', 'completed'); h.setHead('new-tail'); h.add('latest', 'completed')
    const result = h.orchestrator.submitWatchMessage('chat', 'branch', 'origin', h.submission)
    expect(result.restart).toMatchObject({ parentId: 'new-tail', lineageId: 'branch', operation: 'send',
      operationMode: 'plan', toolAutoApprove: false, hooksEnabled: true, watcherCompletion: h.submission.watcherCompletion })
    expect(h.orchestrator.submitWatchMessage('chat', 'branch', 'origin', h.submission)).toEqual({ restartStreamId: result.restart.streamId })
    const sessions = new RunSessionRegistry()
    const runMessage = vi.fn(async (_request, emit) => emit({ type: 'complete', message: { id: 'answer' } }))
    launchQueuedSuccessor({ runMessage }, sessions, result.restart)
    launchQueuedSuccessor({ runMessage }, sessions, result.restart)
    expect(runMessage).toHaveBeenCalledTimes(1)
    expect(sessions.get(result.restart.streamId)?.status).toBe('completed')
  })

  it('joins a trusted successor while setup is awaiting instead of losing another completion', () => {
    const h = harness(); const origin = h.add('origin', 'completed')
    const first = h.orchestrator.submitWatchMessage('chat', 'branch', 'origin', h.submission)
    const successor = h.add(first.restart.streamId)
    successor.queue.lineageId = null // before runMessage resolves the lineage
    expect(origin.successor).toBe(first.restart.streamId)
    const second = { ...h.submission, requestId: 'watcher:second' }
    expect(h.orchestrator.submitWatchMessage('chat', 'branch', 'origin', second).snapshot.streamId).toBe(first.restart.streamId)
    expect(successor.queue.snapshot().items).toHaveLength(1)
  })

  it('reaps an unattended successor rather than leaking a permission waiter', () => {
    const sessions = new RunSessionRegistry()
    const request = { conversationId: 'chat', streamId: 'unattended', operation: 'send' as const, content: 'completion', provider: 'openaichatgpt', modelName: 'test' }
    const runMessage = vi.fn(() => new Promise<void>(() => {}))
    launchQueuedSuccessor({ runMessage }, sessions, request)
    const session = sessions.get('unattended')!
    expect(session.detachedAt).not.toBeNull()
    sessions.reap(Date.now() + 600000)
    expect(session.signal.aborted).toBe(true)
    expect(sessions.get('unattended')).toBeUndefined()
  })

  it('retains origin/latest mailboxes while watching and releases the pin once', () => {
    const h = harness(); h.add('origin', 'completed')
    const release = h.orchestrator.retainWatch(h.context)
    h.add('latest', 'completed')
    for (let i = 0; i < 100; i++) h.add(`unrelated-${i}`, 'completed', `fork-${i}`)
    h.orchestrator.pruneInputRuns()
    expect(h.orchestrator.inputRuns.size).toBe(64)
    expect(h.orchestrator.inputRuns.has('origin')).toBe(true)
    expect(h.orchestrator.inputRuns.has('latest')).toBe(true)
    release(); release()
    expect(h.orchestrator.watchPins.size).toBe(0)
  })

  it('persists watcher provenance as an ordinary user row, without contaminating normal input', () => {
    const h = harness()
    h.orchestrator.messageRepo = { createMessage: vi.fn(draft => ({ id: 'user', ...draft })) }
    h.orchestrator.statements = {}
    h.orchestrator.createUserMessage({ conversationId: 'chat', modelName: 'test', watcherCompletion: h.submission.watcherCompletion },
      'safe-tail', h.submission.content)
    expect(h.orchestrator.messageRepo.createMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      parentId: 'safe-tail', role: 'user', meta: { kind: 'watcher_completion', handle: 'handle', originMessageId: 'tool-parent' },
    }))
    h.orchestrator.createUserMessage({ conversationId: 'chat', modelName: 'test' }, 'next-tail', 'normal input')
    expect(h.orchestrator.messageRepo.createMessage).toHaveBeenLastCalledWith(expect.objectContaining({ meta: undefined }))
  })

  it('rejects ambiguous initializing ownership rather than routing into a fork', () => {
    const h = harness(); h.add('origin', 'completed')
    const initializing = h.add('initializing')
    initializing.queue.lineageId = null
    expect(() => h.orchestrator.submitWatchMessage('chat', 'branch', 'origin', h.submission)).toThrow('initializing')
    expect(() => h.orchestrator.retainWatch({ ...h.context, streamId: undefined })).toThrow('main-chat')
  })

  it('does not restart stopped, failed, deleted or stale branches', () => {
    const h = harness(); h.add('origin', 'completed'); h.add('stopped', 'failed')
    expect(() => h.orchestrator.submitWatchMessage('chat', 'branch', 'origin', h.submission)).toThrow('stopped or failed')
    h.add('latest', 'completed'); h.setHead('externally-advanced')
    expect(() => h.orchestrator.submitWatchMessage('chat', 'branch', 'origin', h.submission)).toThrow('advanced')
    h.orchestrator.lineageRepo.get = () => null
    expect(() => h.orchestrator.submitWatchMessage('chat', 'branch', 'origin', h.submission)).toThrow('unavailable')
  })

  it('delivers a watch terminal event once and releases resources on delivery failure/cancellation', async () => {
    const notify = vi.fn(); const retain = vi.fn(() => vi.fn()); const deliver = vi.fn(() => { throw new Error('private failure') })
    const service = new WatchService(notify)
    service.configureContinuation({ retain, deliver })
    const context = { conversationId: 'chat', lineageId: 'branch', messageId: 'message', streamId: 'origin' }
    const result = service.execute({ action: 'start', kind: 'process_exit', pid: process.pid, timeoutMs: 100 }, context)
    expect(result.autoResume).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toMatchObject({ state: 'timed_out', delivery: 'failed' })
    expect(JSON.stringify(notify.mock.calls)).not.toContain('private')
    expect(retain.mock.results[0].value).toHaveBeenCalledTimes(1)
    service.execute({ action: 'start', kind: 'process_exit', pid: process.pid }, context)
    service.shutdown()
    expect(retain.mock.results[1].value).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledTimes(1)
  })
})
