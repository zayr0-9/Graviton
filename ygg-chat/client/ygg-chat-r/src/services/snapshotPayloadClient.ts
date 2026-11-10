import type { SnapshotPayloadReference } from '../../../../shared/snapshotPayload'
import { buildLocalApiUrl } from '../utils/api'

/** Fetch only host-issued relative identities. Never follow a payload-supplied URL.
 * Callers await this before applying deltas above the captured boundary. */
export async function readSnapshotPayload(streamId: string, reference: SnapshotPayloadReference, visit: (value: any) => void, signal?: AbortSignal): Promise<void> {
  if (!reference || !/^[a-f0-9-]{36}$/.test(reference.id) || reference.encoding !== 'json-lines' ||
    !Number.isSafeInteger(reference.bytes) || reference.bytes < 1 || reference.bytes > 512 * 1024 * 1024 ||
    !Number.isSafeInteger(reference.partBytes) || reference.partBytes < 1 || reference.partBytes > 256 * 1024 ||
    reference.parts !== Math.ceil(reference.bytes / reference.partBytes)) throw new Error('Invalid snapshot reference')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  for (let part = 0; part < reference.parts; part++) {
    const url = await buildLocalApiUrl(`/streams/${encodeURIComponent(streamId)}/snapshots/${reference.id}/parts/${part}`)
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error('Snapshot expired or unavailable; rebootstrap required')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length !== Math.min(reference.partBytes, reference.bytes - part * reference.partBytes)) throw new Error('Incomplete snapshot part')
    pending += decoder.decode(bytes, { stream: true })
    if (pending.length > 32 * 1024 * 1024) throw new Error('One snapshot event exceeds client capacity; persisted history remains available')
    let end: number
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1)
      if (line) visit(JSON.parse(line))
    }
  }
  pending += decoder.decode()
  if (pending) throw new Error('Incomplete snapshot payload')
}

export async function hydrateSnapshotEvent(event: any, signal?: AbortSignal): Promise<any> {
  if (event.type === 'snapshot_reference' || event.type === 'event_reference') {
    const isSnapshot = event.type === 'snapshot_reference'
    let captured: any
    await readSnapshotPayload(event.streamId, event.reference, value => {
      if (captured) throw new Error('Invalid snapshot envelope')
      captured = value
    }, signal)
    if (!captured || typeof captured.type !== 'string' || ['snapshot_reference', 'event_reference'].includes(captured.type) ||
      (isSnapshot && (!['bootstrap', 'child_bootstrap'].includes(captured.type) || captured.snapshot?.streamId !== event.streamId))) throw new Error('Invalid snapshot envelope')
    event = { ...captured, seq: event.seq }
  }
  if ((event.type === 'bootstrap' || event.type === 'child_bootstrap') && event.snapshot?.eventsReference) {
    const snapshot = { ...event.snapshot }
    if (event.type === 'bootstrap') {
      const events: any[] = []
      await readSnapshotPayload(snapshot.streamId, snapshot.eventsReference, value => events.push(value), signal)
      if (!Number.isSafeInteger(snapshot.eventsOffset) || snapshot.eventsOffset < 0 || snapshot.eventsOffset > snapshot.events.length) throw new Error('Invalid snapshot event boundary')
      snapshot.events = [...snapshot.events.slice(0, snapshot.eventsOffset), ...events, ...snapshot.events.slice(snapshot.eventsOffset)]
    } else {
      snapshot.text = ''; snapshot.reasoning = ''
      await readSnapshotPayload(snapshot.streamId, snapshot.eventsReference, value => {
        if (value.type !== 'chunk' || !['text', 'reasoning'].includes(value.part) || typeof value.delta !== 'string') throw new Error('Invalid child tail')
        snapshot[value.part] += value.delta
      }, signal)
    }
    delete snapshot.eventsReference
    return { ...event, snapshot }
  }
  return event
}
