import { useCallback, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { TranscriptRevision } from '../../../../shared/transcriptRevision'
import { gwApi } from '../utils/api'

export const transcriptRevisionsKey = (conversationId: string | null | undefined, lineageId: string | null | undefined) =>
  ['transcript-revisions', conversationId, lineageId] as const

export function useTranscriptRevisions(conversationId: string | null | undefined, lineageId: string | null | undefined) {
  const queryClient = useQueryClient()
  const path = `/conversations/${encodeURIComponent(conversationId ?? '')}/lineages/${encodeURIComponent(lineageId ?? '')}/transcript-revisions`
  const { data } = useQuery({ queryKey: transcriptRevisionsKey(conversationId, lineageId), enabled: Boolean(conversationId && lineageId),
    queryFn: () => gwApi.get<TranscriptRevision[]>(path), staleTime: Infinity, retry: false })
  const byMessage = useMemo(() => new Map(data?.map(revision => [revision.messageId, revision])), [data])
  const undo = useCallback(async (messageId: string, revisionId: number) => {
    if (!conversationId || !lineageId) return
    try {
      await gwApi.post(`${path}/${encodeURIComponent(messageId)}/undo`, { revisionId })
    } finally {
      await queryClient.invalidateQueries({ queryKey: transcriptRevisionsKey(conversationId, lineageId) })
    }
  }, [queryClient, conversationId, lineageId, path])
  return { byMessage, undo }
}
