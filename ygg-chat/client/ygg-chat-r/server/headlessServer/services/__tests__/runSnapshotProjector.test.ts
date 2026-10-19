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

it('uses pending decision authority rather than replayed prompts', () => {
  const projector = new RunSnapshotProjector()
  projector.apply({ type: 'permission_required', streamId: 's', toolCallId: 't', toolName: 'write_file', toolInput: {} })
  projector.apply({ type: 'decision_settled', streamId: 's', toolCallId: 't', revision: 1, outcome: 'resolved' })
  const snapshot = projector.snapshot({ epoch: 'e', streamId: 's', conversationId: 'c', stateSeq: 2, persisted: [], pendingDecisions: [] })
  expect(snapshot.events).toEqual([])
  expect(snapshot.pendingDecisions).toEqual([])
})
