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
})
