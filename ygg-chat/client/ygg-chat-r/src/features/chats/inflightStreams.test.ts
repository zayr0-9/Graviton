import { beforeEach, describe, expect, it } from 'vitest'
import {
  addInflightStream,
  removeInflightStream,
  listInflightStreams,
  clearInflightStreams,
  updateInflightStreamCursor,
  type InflightStreamRecord,
} from './inflightStreams'

function installMemoryLocalStorage() {
  const store = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  }
}

const rec = (streamId: string, conversationId: string): InflightStreamRecord => ({
  streamId,
  conversationId,
  streamType: 'primary',
  parentMessageId: null,
})

describe('inflightStreams', () => {
  beforeEach(() => {
    installMemoryLocalStorage()
    clearInflightStreams()
  })

  it('adds and lists records', () => {
    addInflightStream(rec('s1', 'c1'))
    addInflightStream(rec('s2', 'c1'))
    addInflightStream(rec('s3', 'c2'))
    expect(listInflightStreams().map(r => r.streamId).sort()).toEqual(['s1', 's2', 's3'])
    expect(listInflightStreams('c1').map(r => r.streamId).sort()).toEqual(['s1', 's2'])
    expect(listInflightStreams('c2').map(r => r.streamId)).toEqual(['s3'])
  })

  it('remove deletes only the targeted record; unknown id is a no-op', () => {
    addInflightStream(rec('s1', 'c1'))
    addInflightStream(rec('s2', 'c1'))
    removeInflightStream('s1')
    removeInflightStream('does-not-exist')
    expect(listInflightStreams().map(r => r.streamId)).toEqual(['s2'])
  })

  it('overwrites by streamId and preserves pane-owned terminal path policy', () => {
    addInflightStream(rec('s1', 'c1'))
    addInflightStream({
      streamId: 's1',
      conversationId: 'c1',
      streamType: 'branch',
      parentMessageId: 'm9',
      updatePath: false,
    })
    const all = listInflightStreams()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ streamType: 'branch', parentMessageId: 'm9', updatePath: false })
  })

  it('persists only a newer replay cursor', () => {
    addInflightStream(rec('s1', 'c1'))
    updateInflightStreamCursor('s1', 8)
    updateInflightStreamCursor('s1', 3)
    expect(listInflightStreams('c1')[0]).toMatchObject({ lastSeq: 8 })
  })

  it('survives a "reload" (persists to storage, re-read fresh)', () => {
    addInflightStream(rec('s1', 'c1'))
    // Simulate a reload: the module reads localStorage fresh on each call, so a new
    // list() call sees the persisted entry.
    expect(listInflightStreams('c1')).toHaveLength(1)
  })

  it('missing localStorage degrades to a no-op (never throws)', () => {
    delete (globalThis as any).localStorage
    expect(() => addInflightStream(rec('s1', 'c1'))).not.toThrow()
    expect(listInflightStreams()).toEqual([])
  })
})
