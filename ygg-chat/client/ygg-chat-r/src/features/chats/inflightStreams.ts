/**
 * inflightStreams — a localStorage-backed record of chat runs the renderer STARTED
 * but has not seen finish. It survives a renderer reload (unlike Redux/module state),
 * so on the next load the thin client can re-attach to a still-running server-owned
 * run by streamId (see resumeInFlightStreams + runServerReattach).
 *
 * Lifecycle (only when resumable runs are enabled):
 *   - add on send/branch/edit start,
 *   - remove when the run reaches a terminal state OR is explicitly aborted OR the
 *     thunk unwinds. A RELOAD kills the thunk before it can remove the entry, which
 *     is exactly the signal mount-time resume keys off.
 *
 * Keyed by streamId. Stores just enough to rebuild the stream slot (sendingStarted)
 * before replay: conversationId, streamType, and the parent message id.
 */

export interface InflightStreamRecord {
  streamId: string
  conversationId: string
  streamType: 'primary' | 'branch'
  parentMessageId: string | null
  /** Whether terminal replay may advance the singleton primary conversation path. */
  updatePath?: boolean
  /** Highest server event sequence projected by this renderer. */
  lastSeq?: number
}

const STORAGE_KEY = 'ygg.inflightStreams'

function readAll(): Record<string, InflightStreamRecord> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, InflightStreamRecord>) : {}
  } catch {
    return {}
  }
}

function writeAll(map: Record<string, InflightStreamRecord>): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // ignore (storage unavailable / quota)
  }
}

export function addInflightStream(record: InflightStreamRecord): void {
  if (!record.streamId) return
  const map = readAll()
  map[record.streamId] = record
  writeAll(map)
}

export function updateInflightStreamCursor(streamId: string, lastSeq: number): void {
  if (!streamId || !Number.isFinite(lastSeq) || lastSeq < 0) return
  const map = readAll()
  const record = map[streamId]
  if (!record || (record.lastSeq ?? 0) >= lastSeq) return
  map[streamId] = { ...record, lastSeq }
  writeAll(map)
}

export function removeInflightStream(streamId: string | null | undefined): void {
  if (!streamId) return
  const map = readAll()
  if (map[streamId]) {
    delete map[streamId]
    writeAll(map)
  }
}

/** All tracked runs, optionally filtered to one conversation. */
export function listInflightStreams(conversationId?: string): InflightStreamRecord[] {
  const all = Object.values(readAll())
  return conversationId ? all.filter(r => r.conversationId === conversationId) : all
}

export function clearInflightStreams(): void {
  writeAll({})
}
