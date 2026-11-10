import { isClaudeCheckpoint, isClaudeTranscriptMessage } from '../../../../../shared/claudeProvider'

export type LiveExplainSurface = 'tail' | 'virtual'

/** A closed/non-owning live row must not dismiss the other row's modal. */
export function updateLiveExplainSurface(
  current: LiveExplainSurface | null,
  surface: LiveExplainSurface,
  open: boolean
): LiveExplainSurface | null {
  return open ? surface : current === surface ? null : current
}

/**
 * Claude splits one turn into several rows, but only the turn's final row is a resumable
 * native checkpoint. Explaining text in an earlier row branches from the checkpoint that
 * ends its turn on the selected path. Null while that turn has not completed.
 */
export function resolveExplainAnchorId(
  id: string | number,
  messages: ReadonlyArray<{ id: string | number; role: string; meta?: unknown }>,
  path: ReadonlyArray<string | number>
): string | number | null {
  const byId = new Map(messages.map(message => [String(message.id), message]))
  const selected = byId.get(String(id))
  if (!selected || !isClaudeTranscriptMessage(selected) || isClaudeCheckpoint(selected)) return selected ? selected.id : null
  const start = path.findIndex(pathId => String(pathId) === String(id))
  if (start < 0) return null
  for (const pathId of path.slice(start + 1)) {
    const row = byId.get(String(pathId))
    if (!row || row.role === 'user' || !isClaudeTranscriptMessage(row)) return null
    if (isClaudeCheckpoint(row)) return row.id
  }
  return null
}

export interface LiveExplainSource {
  streamId: string | null
  messageId: string | number | null
  previousCompletedId: string | number | null
}

/** Capture the first persisted turn after opening, not the end of a multi-turn run. */
export function resolveLiveExplainSource(
  source: LiveExplainSource,
  stream: { id: string | null; lastCompletedMessageId: string | number | null },
  messages: ReadonlyArray<{ id: string | number; role: string; parent_id?: string | number | null }>
): LiveExplainSource {
  if (source.messageId != null || source.streamId !== stream.id || stream.lastCompletedMessageId == null ||
    stream.lastCompletedMessageId === source.previousCompletedId) return source
  let row = messages.find(message => String(message.id) === String(stream.lastCompletedMessageId))
  const visited = new Set<string>()
  let candidate: string | number | null = null
  while (row && row.id !== source.previousCompletedId && row.role !== 'user') {
    if (visited.has(String(row.id))) return source
    visited.add(String(row.id))
    if (row.role === 'assistant') candidate = row.id
    row = messages.find(message => String(message.id) === String(row?.parent_id))
  }
  // Missing ancestry is not proof of the first turn; retry after hydration.
  return row && candidate != null ? { ...source, messageId: candidate } : source
}
