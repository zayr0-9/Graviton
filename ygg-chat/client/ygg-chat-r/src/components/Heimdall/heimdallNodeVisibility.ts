import type { ChatNode } from '../../features/chats/chatTypes'

/** Assemble the visible forest without bringing a filtered message root back. */
export function buildHeimdallVisibleRoot(nodes: ChatNode[]): ChatNode | null {
  if (nodes.length === 0) return null
  if (nodes.length === 1) return nodes[0]
  return { id: 'root', message: 'Conversation', sender: 'assistant', children: nodes }
}

export interface HeimdallNodeVisibilityInput {
  isContextInjection: boolean
  isOperationModeChange: boolean
  isEmpty: boolean
  hasSiblings: boolean
  filterEmptyMessages: boolean
}

/**
 * Persisted context-injection rows are model-history scaffolding, not conversation
 * turns. Heimdall always treats them as transparent and promotes their descendants.
 * The sibling exception remains only for ordinary empty messages that carry branch
 * structure users may need to inspect.
 */
export function shouldPromoteHeimdallNode({
  isContextInjection,
  isOperationModeChange,
  isEmpty,
  hasSiblings,
  filterEmptyMessages,
}: HeimdallNodeVisibilityInput): boolean {
  // Context scaffolding is always hidden. Mode transitions belong to the explicit
  // visual-noise filter: keep them inspectable when filtering is off, but promote
  // their descendants even across branch points when filtering is on.
  if (isContextInjection) return true
  if (isOperationModeChange) return filterEmptyMessages
  return filterEmptyMessages && isEmpty && !hasSiblings
}
