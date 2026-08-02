import type { Message } from './chatTypes'

export interface ConversationSnapshotProtection {
  messageIds: Iterable<string>
}

export interface ReconcileConversationSnapshotInput {
  fetchedMessages: Message[]
  liveMessages: Message[]
  protections?: ConversationSnapshotProtection[]
}

const idOf = (message: Pick<Message, 'id'>): string => String(message.id)
const parentOf = (message: Pick<Message, 'parent_id'>): string | null =>
  message.parent_id == null || String(message.parent_id) === '' ? null : String(message.parent_id)

/**
 * Reconciles durable rows with the live SSE projection. Fetched omissions are deletion
 * authority unless the omitted row is explicitly protected by an active stream or a
 * terminal reconciliation lease. Ancestors of protected rows are retained only as needed.
 */
export function reconcileConversationSnapshot({
  fetchedMessages,
  liveMessages,
  protections = [],
}: ReconcileConversationSnapshotInput): Message[] {
  const liveById = new Map(liveMessages.map(message => [idOf(message), message]))
  const fetchedById = new Map(fetchedMessages.map(message => [idOf(message), message]))
  const protectedIds = new Set<string>()

  for (const protection of protections) {
    for (const id of protection.messageIds) protectedIds.add(String(id))
  }

  // Retain the minimal live ancestor chain for every protected row.
  for (const protectedId of [...protectedIds]) {
    const seen = new Set<string>()
    let current: string | null = protectedId
    while (current && !seen.has(current)) {
      seen.add(current)
      const live = liveById.get(current)
      if (!live) break
      protectedIds.add(current)
      current = parentOf(live)
    }
  }

  const reconciled = fetchedMessages.map(message => {
    const live = liveById.get(idOf(message))
    if (!live || !protectedIds.has(idOf(message))) return message
    // Durable fields/attachment metadata come from the fetched row; volatile live
    // projection fields win only while explicitly protected.
    return {
      ...message,
      content: live.content,
      content_plain_text: live.content_plain_text,
      partial: live.partial,
      thinking_block: live.thinking_block,
      tool_calls: live.tool_calls,
      content_blocks: live.content_blocks,
      artifacts: live.artifacts?.length ? live.artifacts : message.artifacts,
      pastedContext: live.pastedContext?.length ? live.pastedContext : message.pastedContext,
    }
  })

  const included = new Set(reconciled.map(idOf))
  for (const message of liveMessages) {
    const id = idOf(message)
    if (protectedIds.has(id) && !included.has(id) && !fetchedById.has(id)) {
      reconciled.push(message)
      included.add(id)
    }
  }

  return reconciled
}
