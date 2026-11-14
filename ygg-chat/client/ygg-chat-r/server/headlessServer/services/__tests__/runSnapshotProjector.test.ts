import { describe, expect, it } from 'vitest'
import { RunSnapshotProjector } from '../runSnapshotProjector.js'
import { RunSession } from '../runSessionRegistry.js'

it('bootstraps compact current output beyond replay retention and then receives only newer deltas', () => {
  const session = new RunSession('s', 'c', 1)
  const projector = new RunSnapshotProjector()
  session.setProjector(event => projector.apply(event))
  session.setSnapshotProvider(() => projector.snapshot({ epoch: 'epoch', streamId: 's', conversationId: 'c', stateSeq: session.latestSeq,
    persisted: [{ id: 'u', revision: 3, row: { id: 'u', revision: 3 } }], pendingDecisions: [] }))
  session.publish({ type: 'started', operation: 'send', conversationId: 'c', parentId: 'u', provider: 'test', modelName: 'test' })
  session.publish({ type: 'chunk', part: 'text', delta: 'hello' })
  session.publish({ type: 'chunk', part: 'text', delta: ' world' })
  const frames: any[] = []
  expect(session.attachSnapshot({ send: event => frames.push(event), end: () => {} }).status).toBe('attached-live')
  expect(frames[0].event.snapshot.stateSeq).toBe(3)
  expect(frames[0].event.snapshot.events.filter((event: any) => event.type === 'chunk')).toEqual([{ type: 'chunk', part: 'text', delta: 'hello world' }])
  session.publish({ type: 'chunk', part: 'text', delta: '!' })
  expect(frames[1].seq).toBe(4)
  // Captured snapshots cannot be mutated by subsequent chunks.
  expect(frames[0].event.snapshot.events.at(-1).delta).toBe('hello world')
})

it('keeps only the latest background task set, across turn resets', () => {
  const projector = new RunSnapshotProjector()
  const task = { id: 'srv', kind: 'local_bash', description: 'dev server', toolUseId: 'b1' }
  projector.apply({ type: 'background_tasks', streamId: 's', turnActive: true, tasks: [task] })
  projector.apply({ type: 'tool_loop', status: 'turn_started', turn: 2, maxTurns: 0 })
  projector.apply({ type: 'background_tasks', streamId: 's', turnActive: false, tasks: [task] })
  const snapshot = projector.snapshot({ epoch: 'e', streamId: 's', conversationId: 'c', stateSeq: 3, persisted: [], pendingDecisions: [] })
  expect(snapshot.events.filter(event => event.type === 'background_tasks'))
    .toEqual([{ type: 'background_tasks', streamId: 's', turnActive: false, tasks: [task] }])
})

it('uses pending decision authority rather than replayed prompts', () => {
  const projector = new RunSnapshotProjector()
  projector.apply({ type: 'permission_required', streamId: 's', toolCallId: 't', toolName: 'write_file', toolInput: {} })
  projector.apply({ type: 'decision_settled', streamId: 's', toolCallId: 't', revision: 1, outcome: 'resolved' })
  const snapshot = projector.snapshot({ epoch: 'e', streamId: 's', conversationId: 'c', stateSeq: 2, persisted: [], pendingDecisions: [] })
  expect(snapshot.events).toEqual([])
  expect(snapshot.pendingDecisions).toEqual([])
})

it('keeps the replay anchor on the head when an earlier row is persisted again', () => {
  const projector = new RunSnapshotProjector()
  const row = (id: string, content = '') => ({ type: 'assistant_message_persisted' as const, message: { id, content } })
  const anchor = () => (projector.snapshot({ epoch: 'e', streamId: 's', conversationId: 'c', stateSeq: 1, persisted: [], pendingDecisions: [] })
    .events.find(event => event.type === 'assistant_message_persisted') as any)?.message
  projector.apply(row('launch'))
  projector.apply({ type: 'tool_loop', status: 'turn_started', turn: 2, maxTurns: 0 })
  projector.apply(row('head', 'first block'))
  projector.apply(row('head', 'both blocks')) // The head itself persisted again: its newest copy is kept.
  // A background task's progress lands on the call that launched it, long after that row.
  projector.apply(row('launch', 'task progress'))
  projector.apply({ type: 'tool_loop', status: 'turn_started', turn: 3, maxTurns: 0 })
  expect(anchor()).toEqual({ id: 'head', content: 'both blocks' })
})
