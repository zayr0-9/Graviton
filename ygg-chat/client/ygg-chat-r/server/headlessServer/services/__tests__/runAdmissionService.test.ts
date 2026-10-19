import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { OperationReceiptRepo, OPERATION_RECEIPT_SCHEMA } from '../../persistence/operationReceiptRepo.js'
import { RunAdmissionService } from '../runAdmissionService.js'
import { RunSessionRegistry } from '../runSessionRegistry.js'
import { ChatOrchestrator } from '../chatOrchestrator.js'
import type { HeadlessMessageRequest } from '../../../../../../shared/headlessApi.js'

const request = (id: string): HeadlessMessageRequest => ({ operation: 'send', conversationId: 'c', parentId: null,
  provider: 'test', modelName: 'test', content: id, operationId: id, streamId: `s-${id}`, fullAccess: false })

it('accepts before effects, queues a second stale client, and never reexecutes a retry after restart/eviction', () => {
  const db = new Database(':memory:')
  try {
    db.exec(OPERATION_RECEIPT_SCHEMA)
    const receipts = new OperationReceiptRepo(db)
    const sessions = new RunSessionRegistry()
    const executed: string[] = []; const queued: string[] = []
    let active: string | undefined
    const orchestrator = {
      classifyOrdinarySend: () => ({ lineageId: null, parentId: null, activeStreamId: active }),
      runMessage: (input: HeadlessMessageRequest) => {
        expect(receipts.get(input.operationId!)?.receipt.status).toBe('accepted')
        executed.push(input.operationId!); active = input.streamId!
        return new Promise<void>(() => {})
      },
      submitQueuedMessage: (_c: string, _s: string, input: any) => {
        expect(receipts.get(input.requestId)?.receipt.status).toBe('accepted')
        queued.push(input.requestId); return {}
      },
    }
    const service = new RunAdmissionService({ epoch: 'one', receipts, sessions, orchestrator })
    expect(service.admit(request('a'), 'one').disposition).toBe('started')
    expect(service.admit(request('b'), 'one')).toMatchObject({ disposition: 'queued', streamId: 's-a' })
    sessions.delete('s-a')
    expect(service.admit(request('a'), 'one').streamId).toBe('s-a')
    expect(() => service.admit({ ...request('a'), fullAccess: true }, 'one')).toThrow('another request')
    const restarted = new RunAdmissionService({ epoch: 'two', receipts, sessions, orchestrator })
    expect(restarted.admit(request('a'), 'one').status).toBe('interrupted')
    expect(() => restarted.admit(request('unknown'), 'one')).toThrow('restarted')
    expect(executed).toEqual(['a']); expect(queued).toEqual(['b'])
  } finally { db.close() }
})

describe('read-only lineage admission', () => {
  function fixture() {
    const host = Object.create(ChatOrchestrator.prototype) as any
    const rows = [{ id: 'old', conversation_id: 'c', parent_id: null }, { id: 'head', conversation_id: 'c', parent_id: 'old' },
      { id: 'sibling', conversation_id: 'c', parent_id: 'old' }, { id: 'foreign', conversation_id: 'other' }]
    host.conversationRepo = { getById: () => ({}), getMessageById: (id: string) => rows.find(row => row.id === id), listMessages: () => rows }
    const lineage = { id: 'l', conversation_id: 'c', status: 'active', head_message_id: 'head' }
    host.lineageRepo = { get: (id: string) => id === 'l' ? lineage : null, resolve: () => lineage,
      getDetail: () => ({ ...lineage, pathMessageIds: ['old', 'head'] }) }
    host.inputRuns = new Map([['active', { queue: { lineageId: 'l' }, request: { conversationId: 'c', operation: 'send', parentId: 'old' }, head: 'head' }]])
    return host
  }
  it('queues a historical ancestor but rejects siblings, missing and foreign parents', () => {
    const host = fixture()
    expect(host.classifyOrdinarySend({ ...request('a'), parentId: 'old', lineageId: 'l' }).activeStreamId).toBe('active')
    for (const parentId of ['sibling', 'missing', 'foreign']) expect(() => host.classifyOrdinarySend({ ...request('a'), parentId, lineageId: 'l' })).toThrow('branch head')
    host.inputRuns.clear()
    expect(() => host.classifyOrdinarySend({ ...request('a'), parentId: 'old', lineageId: 'l' })).toThrow('branch head')
    expect(host.classifyOrdinarySend({ ...request('a'), parentId: 'head', lineageId: 'l' }).activeStreamId).toBeUndefined()
  })
})

it('retains queue acceptance after mailbox loss and preserves completed receipts across restart', () => {
  const db = new Database(':memory:')
  try {
    db.exec(OPERATION_RECEIPT_SCHEMA)
    const receipts = new OperationReceiptRepo(db)
    let calls = 0
    const orchestrator = { runMessage: async () => {}, submitQueuedMessage: () => { calls++; return {} } }
    const service = new RunAdmissionService({ epoch: 'e', receipts, orchestrator, sessions: new RunSessionRegistry() })
    const submission = { requestId: 'q', content: 'next', fullAccess: false }
    service.enqueue('c', 's', submission, 'e')
    service.enqueue('c', 's', submission, 'e')
    expect(calls).toBe(1)
    expect(() => service.enqueue('c', 's', { ...submission, fullAccess: true }, 'e')).toThrow('another request')
    receipts.settleQueue('q', 'completed')
    receipts.finishStream('s', 'failed') // The run outcome cannot overwrite a delivered queue receipt.
    new RunAdmissionService({ epoch: 'new', receipts, orchestrator, sessions: new RunSessionRegistry() })
    expect(receipts.get('q')?.receipt).toMatchObject({ status: 'accepted', outcome: 'completed' })
    expect(calls).toBe(1)
  } finally { db.close() }
})

it('rejects manual compaction while its lineage has an active reservation', () => {
  const db = new Database(':memory:')
  try {
    db.exec(OPERATION_RECEIPT_SCHEMA)
    const service = new RunAdmissionService({ epoch: 'e', receipts: new OperationReceiptRepo(db), sessions: new RunSessionRegistry(),
      orchestrator: { runMessage: async () => {}, classifyOrdinarySend: () => ({ lineageId: 'l', parentId: 'head', activeStreamId: 'active' }), submitQueuedMessage: () => { throw new Error('must not queue compaction') } } })
    expect(() => service.admit({ ...request('compact'), manualCompaction: true }, 'e')).toThrow('finish before compacting')
  } finally { db.close() }
})
