import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acknowledgeFullAccessNotification, getPendingFullAccessNotification,
  isFullAccessEnabled, setFullAccessEnabled, subscribeFullAccess,
} from './fullAccessSettings'

// The access default stays global, but the deferred notice belongs to its origin.
afterEach(() => setFullAccessEnabled(false))

describe('deferred Full access notification', () => {
  it('queues only in the conversation where access was enabled, without writing a message', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeFullAccess(listener)
    setFullAccessEnabled(true, 'c1')
    expect(isFullAccessEnabled()).toBe(true)
    expect(listener).toHaveBeenCalledOnce()
    expect(getPendingFullAccessNotification('c1')).toEqual(expect.any(String))
    expect(getPendingFullAccessNotification('c2')).toBeUndefined()
    unsubscribe()
  })

  it('retains the pending notice until matching durable acknowledgement and ignores old streams', () => {
    setFullAccessEnabled(true, 'c1')
    const first = getPendingFullAccessNotification('c1')!
    acknowledgeFullAccessNotification('c2', first)
    acknowledgeFullAccessNotification('c1', 'wrong')
    expect(getPendingFullAccessNotification('c1')).toBe(first)
    setFullAccessEnabled(false)
    expect(getPendingFullAccessNotification('c1')).toBeUndefined()
    setFullAccessEnabled(true, 'c1')
    const second = getPendingFullAccessNotification('c1')!
    expect(second).not.toBe(first)
    acknowledgeFullAccessNotification('c1', first)
    expect(getPendingFullAccessNotification('c1')).toBe(second)
    acknowledgeFullAccessNotification('c1', second)
    expect(getPendingFullAccessNotification('c1')).toBeUndefined()
    expect(isFullAccessEnabled()).toBe(true)
  })

  it('does not queue another notice for an unchanged enabled setting', () => {
    setFullAccessEnabled(true, 'c1')
    const id = getPendingFullAccessNotification('c1')!
    setFullAccessEnabled(true, 'c2')
    expect(getPendingFullAccessNotification('c1')).toBe(id)
    expect(getPendingFullAccessNotification('c2')).toBeUndefined()
  })
})
