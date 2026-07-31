import { describe, it, expect } from 'vitest'
import { DecisionBroker, DecisionAbortedError } from '../decisionBroker.js'

describe('DecisionBroker', () => {
  it('resolves a pending decision by (streamId, toolCallId)', async () => {
    const broker = new DecisionBroker()
    const p = broker.requestDecision<'allow_once' | 'deny'>({ streamId: 's1', toolCallId: 't1' })
    expect(broker.hasPending('s1', 't1')).toBe(true)

    const matched = broker.resolve('s1', 't1', 'allow_once')
    expect(matched).toBe(true)
    await expect(p).resolves.toBe('allow_once')
    expect(broker.hasPending('s1', 't1')).toBe(false)
  })

  it('resolve() returns false when there is no matching pending decision', () => {
    const broker = new DecisionBroker()
    expect(broker.resolve('nope', 'nope', 'deny')).toBe(false)
  })

  it('rejects the pending promise when the abort signal fires (client disconnect)', async () => {
    const broker = new DecisionBroker()
    const controller = new AbortController()
    const p = broker.requestDecision({ streamId: 's1', toolCallId: 't1', signal: controller.signal })

    controller.abort()

    await expect(p).rejects.toBeInstanceOf(DecisionAbortedError)
    expect(broker.hasPending('s1', 't1')).toBe(false)
  })

  it('rejects immediately if the signal is already aborted at request time', async () => {
    const broker = new DecisionBroker()
    const controller = new AbortController()
    controller.abort()
    await expect(
      broker.requestDecision({ streamId: 's1', toolCallId: 't1', signal: controller.signal })
    ).rejects.toBeInstanceOf(DecisionAbortedError)
    expect(broker.hasPending('s1', 't1')).toBe(false)
  })

  it('rejectAllForStream drains every pending decision for that stream only', async () => {
    const broker = new DecisionBroker()
    const a = broker.requestDecision({ streamId: 's1', toolCallId: 't1' })
    const b = broker.requestDecision({ streamId: 's1', toolCallId: 't2' })
    const other = broker.requestDecision({ streamId: 's2', toolCallId: 't1' })

    broker.rejectAllForStream('s1')

    await expect(a).rejects.toBeInstanceOf(DecisionAbortedError)
    await expect(b).rejects.toBeInstanceOf(DecisionAbortedError)
    expect(broker.hasPending('s2', 't1')).toBe(true)

    broker.resolve('s2', 't1', 'allow_once')
    await expect(other).resolves.toBe('allow_once')
  })

  it('tracks per-stream auto-approve sessions independently', () => {
    const broker = new DecisionBroker()
    expect(broker.isAutoApproveAll('s1')).toBe(false)
    broker.setAutoApproveAll('s1')
    expect(broker.isAutoApproveAll('s1')).toBe(true)
    expect(broker.isAutoApproveAll('s2')).toBe(false)
    broker.rejectAllForStream('s1')
    expect(broker.isAutoApproveAll('s1')).toBe(false)
  })

  it('supersedes a stale pending entry for the same key', async () => {
    const broker = new DecisionBroker()
    const first = broker.requestDecision({ streamId: 's1', toolCallId: 't1' })
    const second = broker.requestDecision({ streamId: 's1', toolCallId: 't1' })

    await expect(first).rejects.toThrow(/Superseded/)
    broker.resolve('s1', 't1', 'deny')
    await expect(second).resolves.toBe('deny')
  })

  it('reject() settles a pending decision with the given error', async () => {
    const broker = new DecisionBroker()
    const p = broker.requestDecision({ streamId: 's1', toolCallId: 't1' })
    const err = new Error('resume-error')
    expect(broker.reject('s1', 't1', err)).toBe(true)
    await expect(p).rejects.toBe(err)
    expect(broker.hasPending('s1', 't1')).toBe(false)
  })

  it('reject() returns false when there is no matching pending decision', () => {
    const broker = new DecisionBroker()
    expect(broker.reject('nope', 'nope', new Error('x'))).toBe(false)
  })

  it('rejectAllForStream matches the exact stream, not a bare string prefix (s1 vs s10)', async () => {
    const broker = new DecisionBroker()
    const s1 = broker.requestDecision({ streamId: 's1', toolCallId: 't1' })
    const s10 = broker.requestDecision({ streamId: 's10', toolCallId: 't1' })

    broker.rejectAllForStream('s1')

    await expect(s1).rejects.toBeInstanceOf(DecisionAbortedError)
    expect(broker.hasPending('s10', 't1')).toBe(true)

    broker.resolve('s10', 't1', 'allow_once')
    await expect(s10).resolves.toBe('allow_once')
  })

  it('aborting a superseded signal does not settle the superseding entry', async () => {
    const broker = new DecisionBroker()
    const ctrlA = new AbortController()
    const ctrlB = new AbortController()
    const first = broker.requestDecision({ streamId: 's1', toolCallId: 't1', signal: ctrlA.signal })
    const second = broker.requestDecision({ streamId: 's1', toolCallId: 't1', signal: ctrlB.signal })

    await expect(first).rejects.toThrow(/Superseded/)

    // ctrlA's listener must have been cleaned up on supersede: aborting it is a no-op.
    ctrlA.abort()
    expect(broker.hasPending('s1', 't1')).toBe(true)

    broker.resolve('s1', 't1', 'allow_once')
    await expect(second).resolves.toBe('allow_once')
  })
})
