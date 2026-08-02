import type { QueryClient } from '@tanstack/react-query'
import type { ConversationId, ProjectWithLatestConversation } from '../../../../../shared/types'
import { environment, gwApi, localApi } from '../../utils/api'
import { isCommunityMode } from '../../config/runtimeMode'
import type { Conversation } from '../conversations/conversationTypes'
import type { ChatNode, Message } from './chatTypes'

export interface ConversationMessagesTreeData {
  messages: Message[]
  tree: ChatNode | null
  meta?: { storage_mode: 'local' | 'cloud' }
}

export interface FetchConversationMessagesTreeOptions {
  storageMode?: 'local' | 'cloud'
  accessToken?: string | null
  queryClient?: QueryClient | null
  signal?: AbortSignal
}

const isElectronCommunityMode = (): boolean => environment === 'electron' && isCommunityMode

export async function fetchConversationMessagesTree(
  conversationId: ConversationId,
  options: FetchConversationMessagesTreeOptions = {}
): Promise<ConversationMessagesTreeData> {
  const { queryClient, signal } = options
  const requestOptions = signal ? { signal } : undefined

  if (isElectronCommunityMode()) {
    return localApi.get<ConversationMessagesTreeData>(
      `/app/conversations/${conversationId}/messages/tree`,
      requestOptions
    )
  }

  let effectiveStorageMode = options.storageMode
  if (!effectiveStorageMode && queryClient) {
    const conversationQueries = queryClient.getQueriesData<Conversation[]>({ queryKey: ['conversations'] })
    for (const [, data] of conversationQueries) {
      if (!Array.isArray(data)) continue
      const match = data.find(conversation => String(conversation.id) === String(conversationId))
      if (match?.storage_mode) {
        effectiveStorageMode = match.storage_mode
        break
      }
      if (!match?.project_id || !options.accessToken) continue
      const projectQueries = queryClient.getQueriesData<ProjectWithLatestConversation[]>({ queryKey: ['projects'] })
      for (const [, projects] of projectQueries) {
        const project = projects?.find(candidate => String(candidate.id) === String(match.project_id))
        if (project?.storage_mode) {
          effectiveStorageMode = project.storage_mode
          break
        }
      }
      if (effectiveStorageMode) break
    }
  }

  if (!effectiveStorageMode && environment === 'electron') {
    try {
      return await localApi.get<ConversationMessagesTreeData>(
        `/app/conversations/${conversationId}/messages/tree`,
        requestOptions
      )
    } catch (error) {
      if (signal?.aborted) throw error
      effectiveStorageMode = 'cloud'
    }
  }

  return gwApi.get<ConversationMessagesTreeData>(
    `/conversations/${conversationId}/messages/tree`,
    requestOptions
  )
}
