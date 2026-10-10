import { describe, expect, it } from 'vitest'
import { getTitleBarHistoryDelta, recordTitleBarLocation } from './titleBarHistory'
import type { TitleBarHistory } from './titleBarHistory'

const visits = (paths: string[]): TitleBarHistory => paths.reduce<TitleBarHistory>(
  (history, pathname, index) => recordTitleBarLocation(history, index, pathname, 'PUSH'),
  new Map()
)

const chatA = '/chat/project/a'
const chatB = '/chat/project/b'
const chatC = '/chat/project/c/lineage/branch'

describe('title bar history', () => {
  it('skips login and logging in both directions', () => {
    const history = visits([chatA, '/logging', '/login', chatB])
    expect(getTitleBarHistoryDelta(history, 3, -1)).toBe(-3)
    expect(getTitleBarHistoryDelta(history, 0, 1)).toBe(3)
    expect(getTitleBarHistoryDelta(history, 0, -1)).toBeNull()
    expect(getTitleBarHistoryDelta(history, 3, 1)).toBeNull()
  })

  it('can leave an excluded page through either arrow', () => {
    const history = visits([chatA, '/logging', chatB])
    expect(getTitleBarHistoryDelta(history, 1, -1)).toBe(-1)
    expect(getTitleBarHistoryDelta(history, 1, 1)).toBe(1)
  })

  it('has no destination when only excluded or unobserved entries exist', () => {
    const history = visits(['/', '/login', '/logging', chatA])
    expect(getTitleBarHistoryDelta(history, 3, -1)).toBeNull()
    expect(getTitleBarHistoryDelta(history, 0, -1)).toBeNull()
    expect(getTitleBarHistoryDelta(new Map([[8, chatA]]), 8, -1)).toBeNull()
  })

  it('handles route casing and trailing slashes like React Router', () => {
    const history = visits([chatA, '/LOGIN/', '/Logging/', '/', chatB])
    expect(getTitleBarHistoryDelta(history, 4, -1)).toBe(-4)
  })

  it('selects the nearest eligible visit, including repeated URLs and lineage routes', () => {
    const history = visits([chatA, '/settings', '/logging', chatC, chatA])
    expect(getTitleBarHistoryDelta(history, 4, -1)).toBe(-1)
    expect(getTitleBarHistoryDelta(history, 1, 1)).toBe(2)
    expect(getTitleBarHistoryDelta(history, 3, 1)).toBe(1)
  })

  it('preserves the forward branch on POP and discards it on a new PUSH', () => {
    const original = visits([chatA, '/logging', chatB, chatC])
    const popped = recordTitleBarLocation(original, 0, chatA, 'POP')
    expect(getTitleBarHistoryDelta(popped, 0, 1)).toBe(2)
    const pushed = recordTitleBarLocation(popped, 1, '/settings', 'PUSH')
    expect([...pushed]).toEqual([[0, chatA], [1, '/settings']])
    expect(getTitleBarHistoryDelta(pushed, 1, 1)).toBeNull()
    expect(original.size).toBe(4)
  })

  it('replaces an entry without discarding the forward branch', () => {
    const history = visits([chatA, '/settings', chatB])
    const replaced = recordTitleBarLocation(history, 1, '/logging', 'REPLACE')
    expect(getTitleBarHistoryDelta(replaced, 0, 1)).toBe(2)
    const allowed = recordTitleBarLocation(replaced, 1, chatC, 'REPLACE')
    expect(getTitleBarHistoryDelta(allowed, 0, 1)).toBe(1)
    expect(getTitleBarHistoryDelta(allowed, 1, 1)).toBe(1)
  })

  it('recording the same initial POP twice is idempotent (StrictMode)', () => {
    const first = recordTitleBarLocation(new Map(), 0, chatA, 'POP')
    expect(recordTitleBarLocation(first, 0, chatA, 'POP')).toEqual(first)
  })
})
