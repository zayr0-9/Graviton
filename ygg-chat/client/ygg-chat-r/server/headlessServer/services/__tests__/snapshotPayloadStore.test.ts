import { describe, expect, it } from 'vitest'
import { SnapshotEventJournal, SnapshotPayloadStore } from '../snapshotPayloadStore.js'

function read(store: SnapshotPayloadStore, reference: ReturnType<SnapshotPayloadStore['freeze']>): string {
  return Buffer.concat(Array.from({ length: reference.parts }, (_, part) => store.readPart(reference.id, part)!)).toString('utf8')
}
describe('immutable snapshot payloads', () => {
  it('pins output across appends, turn reset and multiple readers without truncating unicode', () => {
    const store = new SnapshotPayloadStore()
    try {
      const journal = new SnapshotEventJournal<{ delta: string }>(store, 100)
      const text = '🙂'.repeat(100_000)
      journal.append({ delta: text })
      const first = journal.snapshot().eventsReference!
      journal.append({ delta: 'later' })
      const second = journal.snapshot().eventsReference!
      journal.reset()
      expect(JSON.parse(read(store, first).trim()).delta).toBe(text)
      expect(read(store, second).split('\n').filter(Boolean).map(line => JSON.parse(line).delta)).toEqual([text, 'later'])
      expect(store.readPart(first.id, -1)).toBeUndefined()
      expect(store.readPart(first.id, first.parts)).toBeUndefined()
    } finally { store.dispose() }
  })
  it('expires immutable copies and fails explicitly at capacity', () => {
    const store = new SnapshotPayloadStore(1000, 10)
    try {
      const journal = store.createJournal()
      store.append(journal, 'a'.repeat(600))
      expect(store.freeze(journal).bytes).toBe(600)
      expect(() => store.append(journal, 'b'.repeat(401))).toThrow(/capacity/)
      store.remove(journal)
      store.reap(Date.now() + 100)
      const reference = store.capture({ delta: 'ok' })
      expect(store.readPart(reference.id, 0)).toBeDefined()
      store.reap(Date.now() + 100)
      expect(store.readPart(reference.id, 0)).toBeUndefined()
    } finally { store.dispose() }
  })
})
