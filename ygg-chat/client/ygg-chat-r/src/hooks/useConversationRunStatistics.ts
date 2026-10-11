import { useQuery } from '@tanstack/react-query'
import type { ConversationRunStatistics } from '../../../../shared/runStatistics'
import { conversationQueryKeys } from '../features/chats/conversationQueryKeys'
import { isLocalServerRuntime, localApi } from '../utils/api'

const EMPTY_RUNS: ConversationRunStatistics[] = []

export function useConversationRunStatistics(conversationId: string | null) {
  const query = useQuery({
    queryKey: conversationId ? conversationQueryKeys.runStatistics(conversationId) : ['conversations', null, 'run-statistics'],
    queryFn: async ({ signal }) => {
      const result = await localApi.get<{ runs: ConversationRunStatistics[] }>(
        `/conversations/${encodeURIComponent(conversationId!)}/streaming-runs`, { signal }
      )
      return result.runs
    },
    enabled: Boolean(conversationId) && isLocalServerRuntime(),
    staleTime: 30000,
    refetchOnMount: 'always',
    retry: 1,
  })
  return query.data ?? EMPTY_RUNS
}
