import { parseMessageMeta } from '../../../../../shared/contextInjection'
import type { ConversationId, MessageId } from '../../../../../shared/types'
import type { LineageId, Message } from './chatTypes'
import { isCompactionSummary } from './summaryPresentation'

export interface CompactionOwner {
  conversationId: ConversationId | null
  parentMessageId: MessageId | null
  lineageId?: LineageId | null
  summaryMessageId?: MessageId | null
}

// Standalone compaction has no SSE stream slot. Apply the same conversation/lineage
// ownership boundary as a normal stream, with a structural fallback for legacy paths.
// Mere ancestor membership is insufficient: sibling branches can share that parent.
export const isCompactionVisibleFor = (
  owner: CompactionOwner,
  view: {
    conversationId: ConversationId | null
    lineageId: LineageId | null
    path: readonly MessageId[]
    messages: readonly Message[]
  }
): boolean => {
  if (owner.conversationId == null || view.conversationId == null || owner.parentMessageId == null ||
    String(owner.conversationId) !== String(view.conversationId)) return false

  if (owner.lineageId != null && view.lineageId != null) {
    return String(owner.lineageId) === String(view.lineageId)
  }

  const parentIndex = view.path.findIndex(id => String(id) === String(owner.parentMessageId))
  if (parentIndex < 0) return false

  // Summary persistence can extend the selected path and clear currentLineageId.
  // Keep that completion visible, but never follow a different user/assistant branch.
  return view.path.slice(parentIndex + 1).every(id => {
    const message = view.messages.find(row => String(row.id) === String(id))
    return (owner.summaryMessageId != null && String(id) === String(owner.summaryMessageId) &&
      isCompactionSummary(message)) || parseMessageMeta(message?.meta)?.kind === 'operation_mode_change'
  })
}

export const getCompactionPresentationScope = (
  conversationId: ConversationId | null,
  streamId: string | null,
  path: readonly MessageId[],
  messages: readonly Message[],
  summaryMessageId: MessageId | null = null
): string => {
  // An in-loop compaction already has a branch-selected stream identity. Its
  // message anchors move at persistence, but the owning run must remain stable.
  if (streamId != null) return JSON.stringify([conversationId, streamId])
  const byId = new Map(messages.map(message => [String(message.id), message]))
  return JSON.stringify([conversationId, streamId, path.filter(id => {
    const message = byId.get(String(id))
    return !(summaryMessageId != null && String(id) === String(summaryMessageId) && isCompactionSummary(message)) &&
      parseMessageMeta(message?.meta)?.kind !== 'operation_mode_change'
  }).map(String)])
}
