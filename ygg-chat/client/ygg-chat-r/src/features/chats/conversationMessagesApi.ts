import type { ConversationId } from '../../../../../shared/types'
import { localApi } from '../../utils/api'
import type { ChatNode, Message } from './chatTypes'

export interface ConversationMessagesTreeData {
  messages: Message[]
  tree: ChatNode | null
  /** Present only for a branch read: durable sibling IDs and revisions, without bodies. */
  retained?: Array<[string, number]>
}

export interface FetchConversationMessagesTreeOptions {
  /** Omit the redundant server tree when the caller rebuilds from messages. */
  includeTree?: boolean
  branch?: { tip?: string; lineage?: string }
  signal?: AbortSignal
}

export async function fetchConversationMessagesTree(
  conversationId: ConversationId,
  options: FetchConversationMessagesTreeOptions = {}
): Promise<ConversationMessagesTreeData> {
  const requestOptions = options.signal ? { signal: options.signal } : undefined
  // The authoritative renderer snapshot builds its tree from enriched flat rows.
  const params = new URLSearchParams()
  if (options.includeTree === false) params.set('includeTree', 'false')
  if (options.branch) {
    params.set('scope', 'branch')
    if (options.branch.tip) params.set('tip', options.branch.tip)
    if (options.branch.lineage) params.set('lineage', options.branch.lineage)
  }
  const treeQuery = params.size ? `?${params}` : ''
  return localApi.get<ConversationMessagesTreeData>(
    `/app/conversations/${conversationId}/messages/tree${treeQuery}`,
    requestOptions
  )
}
