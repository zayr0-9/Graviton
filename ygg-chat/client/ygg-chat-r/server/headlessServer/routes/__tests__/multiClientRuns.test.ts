import express from 'express'
import Database from 'better-sqlite3'
import type { Server } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { registerChatRoutes } from '../chatRoutes.js'
import { RunSessionRegistry } from '../../services/runSessionRegistry.js'
import { RunSnapshotProjector } from '../../services/runSnapshotProjector.js'
import { DecisionBroker } from '../../services/decisionBroker.js'
import { RunAdmissionService } from '../../services/runAdmissionService.js'
import { OperationReceiptRepo, OPERATION_RECEIPT_SCHEMA } from '../../persistence/operationReceiptRepo.js'
import type { HeadlessMessageRequest, HeadlessStreamEvent } from '../../../../../../shared/headlessApi.js'

let server: Server | undefined
let db: Database.Database | undefined
afterEach(async () => { server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server!.close(() => resolve())); db?.close() })

it('two independent clients join one run, queue and settle one shared decision without duplicate execution', async () => {
  db = new Database(':memory:'); db.exec(OPERATION_RECEIPT_SCHEMA)
  const sessions = new RunSessionRegistry()
  const broker = new DecisionBroker()
  sessions.setMainSessionFactory(session => {
    const projector = new RunSnapshotProjector()
    session.setProjector(event => projector.apply(event))
    session.setSnapshotProvider(() => projector.snapshot({ epoch: 'e', streamId: session.streamId, conversationId: 'c',
      stateSeq: session.latestSeq, persisted: [], pendingDecisions: broker.snapshot(session.streamId).pending }))
  })
  let executions = 0; let queued = 0; let active: string | undefined
  let emit!: (event: HeadlessStreamEvent) => void
  const orchestrator = {
    classifyOrdinarySend: () => ({ lineageId: null, parentId: null, activeStreamId: active }),
    submitQueuedMessage: () => { queued++; return {} },
    runMessage: (request: HeadlessMessageRequest, publish: typeof emit) => {
      executions++; active = request.streamId!; emit = publish
      publish({ type: 'started', operation: 'send', conversationId: 'c', parentId: null, provider: 'test', modelName: 'test' })
      publish({ type: 'chunk', part: 'text', delta: 'hello' })
      return new Promise<void>(() => {})
    },
  }
  const app = express(); app.use(express.json())
  registerChatRoutes(app, { orchestrator, runSessions: sessions, resumableRuns: true, decisionBroker: broker,
    admissions: new RunAdmissionService({ epoch: 'e', receipts: new OperationReceiptRepo(db), sessions, orchestrator }) })
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve))
  const origin = `http://127.0.0.1:${(server.address() as any).port}`
  const post = (path: string, body: any) => fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const first = await (await post('/api/conversations/c/admissions', { epoch: 'e', operationId: 'a', streamId: 's', content: 'one' })).json()
  expect(first.disposition).toBe('started')
  const prompt = { type: 'permission_required' as const, streamId: 's', toolCallId: 'tool', toolName: 'read_file', toolInput: {} }
  const waiting = broker.requestDecision({ streamId: 's', toolCallId: 'tool', kind: 'permission', prompt })
  emit(prompt)
  const clients = await Promise.all([fetch(`${origin}/api/streams/s?bootstrap=1`), fetch(`${origin}/api/streams/s?bootstrap=1`)])
  const readers = clients.map(response => response.body!.getReader())
  for (const reader of readers) {
    const data = new TextDecoder().decode((await reader.read()).value)
    expect(data).toContain('"type":"bootstrap"')
    expect(data).toContain('"delta":"hello"')
    expect(data).toContain('"toolCallId":"tool"')
  }
  const second = await (await post('/api/conversations/c/admissions', { epoch: 'e', operationId: 'b', streamId: 'other', content: 'two' })).json()
  expect(second).toMatchObject({ disposition: 'queued', streamId: 's' })
  expect(executions).toBe(1); expect(queued).toBe(1)
  expect((await post('/api/resume', { streamId: 's', toolCallId: 'tool', decision: 'allow_once' })).status).toBe(200)
  expect((await post('/api/resume', { streamId: 's', toolCallId: 'tool', decision: 'deny' })).status).toBe(409)
  await expect(waiting).resolves.toBe('allow_once')
  for (const reader of readers) expect(new TextDecoder().decode((await reader.read()).value)).toContain('decision_settled')
  await Promise.all(readers.map(reader => reader.cancel()))
  expect(sessions.get('s')?.signal.aborted).toBe(false)
})
