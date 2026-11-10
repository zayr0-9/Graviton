import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../utils/api', () => ({ buildLocalApiUrl: async (value: string) => `http://host/api${value}` }))
import { hydrateSnapshotEvent, readSnapshotPayload } from './snapshotPayloadClient'
afterEach(() => vi.unstubAllGlobals())
it('hydrates immutable multipart unicode before returning the S-boundary envelope', async () => {
  const text = '🙂'.repeat(1000)
  const bytes = new TextEncoder().encode(JSON.stringify({ type: 'chunk', part: 'text', delta: text }) + '\n')
  const reference = { id: '12345678-1234-1234-1234-123456789abc', bytes: bytes.length, partBytes: 193, parts: Math.ceil(bytes.length / 193), encoding: 'json-lines' as const }
  const fetcher = vi.fn(async (url: string) => {
    const part = Number(url.split('/').at(-1))
    return new Response(bytes.slice(part * 193, (part + 1) * 193))
  })
  vi.stubGlobal('fetch', fetcher)
  const event = await hydrateSnapshotEvent({ type: 'bootstrap', seq: 23, snapshot: { streamId: 's', stateSeq: 23, events: [{ type: 'started' }, { type: 'complete' }], eventsOffset: 1, eventsReference: reference } })
  expect(event.seq).toBe(23)
  expect(event.snapshot.events.map((value: any) => value.type)).toEqual(['started', 'chunk', 'complete'])
  expect(event.snapshot.events[1].delta).toBe(text)
  expect(event.snapshot.eventsReference).toBeUndefined()
  expect(fetcher.mock.calls.every(([url]) => url.startsWith('http://host/api/streams/s/snapshots/'))).toBe(true)
})
it('fails a partial snapshot instead of installing mixed or truncated state', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('short')))
  await expect(readSnapshotPayload('s', { id: '12345678-1234-1234-1234-123456789abc', bytes: 10, partBytes: 10, parts: 1, encoding: 'json-lines' }, () => {})).rejects.toThrow('Incomplete snapshot part')
})
