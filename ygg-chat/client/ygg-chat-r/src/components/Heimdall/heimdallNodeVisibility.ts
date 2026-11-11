import { isCompactionMessage } from '../../../../../shared/compaction'
import type { ChatNode } from '../../features/chats/chatTypes'
import { isContextInjectionMessage } from '../../../../../shared/contextInjection'
import { isRunSettingsNotification } from '../../../../../shared/accessNotifications'
import { isWatcherCompletionMessage } from '../../../../../shared/watchEvents'

/** Shared semantic-noise filter; do not hide real reasoning/tool activity. */
export function isHeimdallScaffoldingMessage(message: unknown, filterEmptyMessages = true): boolean {
  return shouldPromoteHeimdallNode({
    isContextInjection: isContextInjectionMessage(message),
    isCompaction: isCompactionMessage(message),
    isWatcherCompletion: isWatcherCompletionMessage(message),
    isOperationModeChange: isRunSettingsNotification(message),
    isEmpty: false,
    hasSiblings: false,
    filterEmptyMessages,
  })
}

/** Assemble the visible forest without bringing a filtered message root back. */
export function buildHeimdallVisibleRoot(nodes: ChatNode[]): ChatNode | null {
  if (nodes.length === 0) return null
  if (nodes.length === 1) return nodes[0]
  return { id: 'root', message: 'Conversation', sender: 'assistant', children: nodes }
}

export interface HeimdallNodeVisibilityInput {
  isCompaction?: boolean
  /** Automated watcher/subagent/Claude-bridge completion delivered as a user row. */
  isWatcherCompletion?: boolean
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
  isCompaction,
  isWatcherCompletion,
  isContextInjection,
  isOperationModeChange,
  isEmpty,
  hasSiblings,
  filterEmptyMessages,
}: HeimdallNodeVisibilityInput): boolean {
  // Context scaffolding is always hidden. Mode transitions and automated completion
  // deliveries belong to the explicit visual-noise filter: keep them inspectable when
  // filtering is off, but promote their descendants even across branch points when on.
  if (isContextInjection) return true
  if (isOperationModeChange || isCompaction || isWatcherCompletion) return filterEmptyMessages
  return filterEmptyMessages && isEmpty && !hasSiblings
}
