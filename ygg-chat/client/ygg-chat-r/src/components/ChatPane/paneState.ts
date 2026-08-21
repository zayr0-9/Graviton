import type { MessageId } from '../../../../../shared/types'
import type { ChatErrorRecord, LineageId, Message } from '../../features/chats/chatTypes'
import { buildBranchPathForMessage } from '../../features/chats/pathUtils'

export interface ChatPaneIdentity {
  conversationId: string
  lineageId: LineageId | null
  path: readonly MessageId[]
  streamId: string | null
}

/** Select durable failures belonging to one pane without copying the canonical error store. */
export function selectErrorsForPane(
  errors: readonly ChatErrorRecord[],
  identity: ChatPaneIdentity
): ChatErrorRecord[] {
  const pathIds = new Set(identity.path.map(id => String(id)))
  return errors.filter(record => {
    if (record.streamId && record.streamId === identity.streamId) return true
    if (
      identity.lineageId != null &&
      record.lineageId != null &&
      String(record.lineageId) === String(identity.lineageId)
    ) {
      return true
    }
    return record.parentMessageId != null && pathIds.has(String(record.parentMessageId))
  })
}

/**
 * Advance only the pane-local path after the server assigns persisted IDs. Canonical messages stay
 * shared, while the primary Redux currentPath is deliberately untouched for a parallel send.
 */
export function advancePanePath(
  messages: readonly Message[],
  previousPath: readonly MessageId[],
  userMessageId: MessageId | null | undefined,
  finalMessageId: MessageId | null | undefined
): MessageId[] {
  if (finalMessageId != null) {
    const rebuilt = buildBranchPathForMessage(messages as Message[], finalMessageId)
    if (rebuilt.length > 0) return rebuilt
  }

  const next = [...previousPath]
  if (userMessageId != null && !next.some(id => String(id) === String(userMessageId))) next.push(userMessageId)
  if (finalMessageId != null && !next.some(id => String(id) === String(finalMessageId))) next.push(finalMessageId)
  return next
}
