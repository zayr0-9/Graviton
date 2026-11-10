import type { ConversationId } from '../../../../../shared/types'
import { localApi } from '../../utils/api'
import type { ChatNode, Message } from './chatTypes'

export interface ConversationMessagesTreeData {
  messages: Message[]
  tree: ChatNode | null
}

export interface FetchConversationMessagesTreeOptions {
  /** Omit the redundant server tree when the caller rebuilds from messages. */
  includeTree?: boolean
  signal?: AbortSignal
}

export async function fetchConversationMessagesTree(
  conversationId: ConversationId,
  options: FetchConversationMessagesTreeOptions = {}
): Promise<ConversationMessagesTreeData> {
  const requestOptions = options.signal ? { signal: options.signal } : undefined
  // The authoritative renderer snapshot builds its tree from enriched flat rows.
  const treeQuery = options.includeTree === false ? '?includeTree=false' : ''
  return localApi.get<ConversationMessagesTreeData>(
    `/app/conversations/${conversationId}/messages/tree${treeQuery}`,
    requestOptions
  )
}
