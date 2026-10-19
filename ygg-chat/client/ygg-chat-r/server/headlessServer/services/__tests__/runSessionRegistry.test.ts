import { describe, expect, it } from 'vitest'
import {
  RunSession,
  RunSessionRegistry,
  type BufferedEvent,
  type RunSubscriber,
} from '../runSessionRegistry.js'

// Minimal event factory — publish() only cares about `type` for terminal detection.
const ev = (o: Record<string, unknown>) => o as never

function recorder() {
  const frames: BufferedEvent[] = []
  const state = { ended: false }
  const sub: RunSubscriber = {
    send: f => frames.push(f),
    end: () => {
      state.ended = true
    },
  }
  return { sub, frames, state }
}

describe('RunSession', () => {
  it('publish assigns strictly increasing seq, buffers, and fans out to the live subscriber', () => {
    const session = new RunSession('s1', 'c1')
    const r = recorder()
    expect(session.attach(r.sub)).toEqual({ status: 'attached-live' })

    session.publish(ev({ type: 'started' }))
    session.publish(ev({ type: 'chunk', part: 'text', delta: 'a' }))
    session.publish(ev({ type: 'chunk', part: 'text', delta: 'b' }))

    expect(r.frames.map(f => f.seq)).toEqual([1, 2, 3])
    expect(r.frames[1].event).toMatchObject({ delta: 'a' })
    expect(session.latestSeq).toBe(3)
    expect(session.status).toBe('running')
  })

  it('detach does NOT abort the run — signal stays live, status stays running', () => {
    const session = new RunSession('s1', 'c1')
    const r = recorder()
    session.attach(r.sub)
    session.publish(ev({ type: 'started' }))

    session.detach(r.sub)

    expect(session.signal.aborted).toBe(false)
    expect(session.status).toBe('running')
    expect(session.detachedAt).not.toBeNull()
    expect(session.hasSubscriber()).toBe(false)
  })

  it('reattach replays only frames after the cursor (fromSeq)', () => {
    const session = new RunSession('s1', 'c1')
    session.publish(ev({ type: 'started' })) // seq 1
    session.publish(ev({ type: 'chunk', delta: 'a' })) // seq 2
    session.publish(ev({ type: 'chunk', delta: 'b' })) // seq 3

    const r = recorder()
    const result = session.attach(r.sub, 1)
    expect(result).toEqual({ status: 'attached-live' })
    expect(r.frames.map(f => f.seq)).toEqual([2, 3])

    // A future frame continues to flow to the reattached subscriber.
    session.publish(ev({ type: 'chunk', delta: 'c' })) // seq 4
    expect(r.frames.map(f => f.seq)).toEqual([2, 3, 4])
  })

  it('reattach from 0 replays the whole buffer (parked permission event re-surfaces)', () => {
    const session = new RunSession('s1', 'c1')
    session.publish(ev({ type: 'started' }))
    session.publish(ev({ type: 'permission_required', toolCallId: 't1', toolName: 'bash' }))

    const r = recorder()
    session.attach(r.sub, 0)
    expect(r.frames.map(f => f.event.type)).toEqual(['started', 'permission_required'])
  })

  it('late attach after a terminal event replays the tail and ends the subscriber', () => {
    const session = new RunSession('s1', 'c1')
    session.publish(ev({ type: 'started' }))
    session.publish(ev({ type: 'complete', message: { id: 'a1' } }))
    expect(session.status).toBe('completed')
    expect(session.terminalAt).not.toBeNull()

    const r = recorder()
    const result = session.attach(r.sub, 0)
    expect(result).toEqual({ status: 'replayed-terminal', finalStatus: 'completed' })
    expect(r.frames.map(f => f.event.type)).toEqual(['started', 'complete'])
    expect(r.state.ended).toBe(true)
  })

  it('publishing a terminal event flushes and releases the live subscriber', () => {
    const session = new RunSession('s1', 'c1')
    const r = recorder()
    session.attach(r.sub)
    session.publish(ev({ type: 'started' }))
    session.publish(ev({ type: 'complete', message: { id: 'a1' } }))
    expect(r.state.ended).toBe(true)
    expect(session.hasSubscriber()).toBe(false)
  })

  it('returns truncated when the cursor predates the retained buffer', () => {
    const session = new RunSession('s1', 'c1', 2) // cap 2
    session.publish(ev({ type: 'a' })) // seq 1 -> dropped
    session.publish(ev({ type: 'b' })) // seq 2 -> dropped
    session.publish(ev({ type: 'c' })) // seq 3
    session.publish(ev({ type: 'd' })) // seq 4  (droppedThrough now 2)

    const r = recorder()
    expect(session.attach(r.sub, 1)).toEqual({ status: 'truncated' })
    expect(r.frames.length).toBe(0)
  })

  it('cancel aborts the signal and marks the run cancelled; a later error keeps the classification', () => {
    const session = new RunSession('s1', 'c1')
    session.cancel()
    expect(session.signal.aborted).toBe(true)
    expect(session.status).toBe('cancelled')

    session.publish(ev({ type: 'error', error: 'aborted' }))
    expect(session.status).toBe('cancelled') // NOT downgraded to 'errored'
    expect(session.terminalAt).not.toBeNull()
  })

  it('attaching a second viewer preserves both subscribers', () => {
    const session = new RunSession('s1', 'c1')
    const a = recorder()
    const b = recorder()
    session.attach(a.sub)
    session.attach(b.sub)
    expect(a.state.ended).toBe(false)
    expect(session.hasSubscriber()).toBe(true)

    session.publish(ev({ type: 'chunk', delta: 'x' }))
    expect(b.frames.length).toBe(1)
    expect(a.frames.length).toBe(1)
    session.detach(a.sub)
    session.publish(ev({ type: 'chunk', delta: 'y' }))
    expect(a.frames.length).toBe(1)
    expect(b.frames.length).toBe(2)
    expect(session.signal.aborted).toBe(false)
  })
})

describe('RunSessionRegistry', () => {
  it('create is idempotent per streamId; get/delete behave', () => {
    const reg = new RunSessionRegistry()
    const s1 = reg.create('s1', 'c1')
    const s1again = reg.create('s1', 'c1')
    expect(s1).toBe(s1again)
    expect(reg.get('s1')).toBe(s1)
    expect(reg.size()).toBe(1)
    reg.delete('s1')
    expect(s1.signal.aborted).toBe(false)
    expect(reg.get('s1')).toBeUndefined()
    expect(reg.size()).toBe(0)
  })

  it('replace aborts and detaches the old owner before installing a fresh session', () => {
    const reg = new RunSessionRegistry()
    const old = reg.create('s1', 'c1')
    const subscriber = recorder()
    old.attach(subscriber.sub)

    const replacement = reg.replace('s1', 'c1')

    expect(replacement).not.toBe(old)
    expect(reg.get('s1')).toBe(replacement)
    expect(old.signal.aborted).toBe(true)
    expect(old.hasSubscriber()).toBe(false)
    expect(replacement.signal.aborted).toBe(false)
  })

  it('cancel by id aborts the session; unknown id returns false', () => {
    const reg = new RunSessionRegistry()
    const s = reg.create('s1', null)
    expect(reg.cancel('s1')).toBe(true)
    expect(s.signal.aborted).toBe(true)
    expect(reg.cancel('nope')).toBe(false)
  })

  it('reaper evicts a terminal session only after the linger window', () => {
    const reg = new RunSessionRegistry({ policy: { terminalLingerMs: 1_000 } })
    const s = reg.create('s1', null)
    s.publish(ev({ type: 'complete', message: { id: 'a1' } }))
    const terminalAt = s.terminalAt as number

    expect(reg.reap(terminalAt + 999)).toEqual([]) // still lingering
    expect(reg.size()).toBe(1)
    expect(reg.reap(terminalAt + 1_001)).toEqual(['s1']) // past linger
    expect(reg.size()).toBe(0)
  })

  it('reaper never cancels a running session with no viewers', () => {
    const reg = new RunSessionRegistry({ policy: { terminalLingerMs: 1_000 } })
    const s = reg.create('s1', null)
    const r = recorder()
    s.attach(r.sub)
    s.publish(ev({ type: 'started' }))
    s.detach(r.sub)
    const detachedAt = s.detachedAt as number

    expect(reg.reap(detachedAt + 999)).toEqual([]) // still within grace
    expect(reg.size()).toBe(1)

    const evicted = reg.reap(Number.MAX_SAFE_INTEGER)
    expect(evicted).toEqual([])
    expect(s.signal.aborted).toBe(false)
    expect(reg.size()).toBe(1)
  })

  it('reaper does NOT evict a running session that still has a subscriber', () => {
    const reg = new RunSessionRegistry({ policy: { terminalLingerMs: 1 } })
    const s = reg.create('s1', null)
    const r = recorder()
    s.attach(r.sub)
    s.publish(ev({ type: 'started' }))
    // attached => detachedAt is null => never eligible for the idle reap.
    expect(reg.reap(Number.MAX_SAFE_INTEGER)).toEqual([])
    expect(reg.size()).toBe(1)
    expect(s.signal.aborted).toBe(false)
  })
})

describe('multi-client failure isolation', () => {
  it('does not terminate for recoverable errors or a failed viewer', () => {
    const session = new RunSession('s', 'c')
    const healthy = recorder()
    session.attach(healthy.sub)
    session.attach({ send: () => { throw new Error('closed') }, end: () => {} })
    session.publish(ev({ type: 'error', error: 'retrying', terminal: false }))
    expect(session.status).toBe('running')
    expect(healthy.state.ended).toBe(false)
    session.publish(ev({ type: 'complete', message: { id: 'm' } }))
    session.publish(ev({ type: 'chunk', delta: 'late' }))
    expect(healthy.frames).toHaveLength(2)
    expect(healthy.state.ended).toBe(true)
  })
  it('rejects truncated zero and future cursors', () => {
    const session = new RunSession('s', 'c', 1)
    session.publish(ev({ type: 'started' }))
    session.publish(ev({ type: 'chunk', delta: 'x' }))
    expect(session.attach(recorder().sub, 0).status).toBe('truncated')
    expect(session.attach(recorder().sub, 99).status).toBe('truncated')
  })
})

it('does not reap a cancelled run before its terminal frame is published', () => {
  const registry = new RunSessionRegistry({ policy: { terminalLingerMs: 1 } })
  const session = registry.create('cancel-unwind', 'c')
  session.cancel()
  expect(session.terminalAt).toBeNull()
  expect(registry.reap(Date.now() + 60000)).toEqual([])
  session.publish(ev({ type: 'error', error: 'cancelled' }))
  expect(registry.reap(session.terminalAt! + 2)).toEqual(['cancel-unwind'])
})

it('isolates snapshot projector failures from execution and healthy observers', () => {
  const session = new RunSession('projection-error', 'c')
  session.setProjector(() => { throw new Error('bad payload') })
  const viewer = recorder()
  session.attach(viewer.sub)
  expect(() => session.publish(ev({ type: 'chunk', part: 'text', delta: 'still running' }))).not.toThrow()
  expect(session.status).toBe('running')
  expect(viewer.frames).toHaveLength(1)
  expect(() => session.attachSnapshot(recorder().sub)).toThrow('unavailable')
})

it('leases a large individual event without a large first socket write', () => {
  const session = new RunSession('large', 'c')
  const frames: any[] = []
  session.attach({ send: frame => frames.push(frame), end: () => {} })
  session.publish({ type: 'chunk', part: 'text', delta: 'x'.repeat(400000) })
  expect(frames[0].event.type).toBe('event_reference')
  expect(JSON.stringify(frames[0]).length).toBeLessThan(1000)
  const reference = frames[0].event.reference
  const content = Buffer.concat(Array.from({ length: reference.parts }, (_, part) => session.snapshotPayloads.readPart(reference.id, part)!)).toString('utf8')
  expect(JSON.parse(content).delta).toHaveLength(400000)
  session.dispose()
})
