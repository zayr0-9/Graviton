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

  it('last attach wins — the prior subscriber is ended', () => {
    const session = new RunSession('s1', 'c1')
    const a = recorder()
    const b = recorder()
    session.attach(a.sub)
    session.attach(b.sub)
    expect(a.state.ended).toBe(true)
    expect(session.hasSubscriber()).toBe(true)

    session.publish(ev({ type: 'chunk', delta: 'x' }))
    expect(b.frames.length).toBe(1)
    expect(a.frames.length).toBe(0)
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
    const reg = new RunSessionRegistry({ policy: { terminalLingerMs: 1_000, idleDetachedMs: 1_000 } })
    const s = reg.create('s1', null)
    s.publish(ev({ type: 'complete', message: { id: 'a1' } }))
    const terminalAt = s.terminalAt as number

    expect(reg.reap(terminalAt + 999)).toEqual([]) // still lingering
    expect(reg.size()).toBe(1)
    expect(reg.reap(terminalAt + 1_001)).toEqual(['s1']) // past linger
    expect(reg.size()).toBe(0)
  })

  it('reaper cancels + evicts a still-running session abandoned past the idle bound', () => {
    const reg = new RunSessionRegistry({ policy: { terminalLingerMs: 1_000, idleDetachedMs: 1_000 } })
    const s = reg.create('s1', null)
    const r = recorder()
    s.attach(r.sub)
    s.publish(ev({ type: 'started' }))
    s.detach(r.sub)
    const detachedAt = s.detachedAt as number

    expect(reg.reap(detachedAt + 999)).toEqual([]) // still within grace
    expect(reg.size()).toBe(1)

    const evicted = reg.reap(detachedAt + 1_001)
    expect(evicted).toEqual(['s1'])
    expect(s.signal.aborted).toBe(true) // the abandoned run was cancelled
    expect(reg.size()).toBe(0)
  })

  it('reaper does NOT evict a running session that still has a subscriber', () => {
    const reg = new RunSessionRegistry({ policy: { terminalLingerMs: 1, idleDetachedMs: 1 } })
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
