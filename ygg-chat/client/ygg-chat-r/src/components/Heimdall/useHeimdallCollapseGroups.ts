import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { localApi } from '../../utils/api'
import type { HeimdallCollapseGroup } from './heimdallCollapse'

const EMPTY: HeimdallCollapseGroup[] = []

export const heimdallCollapseQueryKey = (conversationId: unknown) =>
  ['conversations', String(conversationId), 'heimdall-collapse-groups'] as const

const endpoint = (conversationId: unknown) =>
  `/local/conversations/${encodeURIComponent(String(conversationId))}/heimdall-collapse-groups`

/**
 * Collapse groups persisted per conversation in SQLite (migration v13). Edits apply
 * to the Query cache immediately; PUTs (full replacement) are serialized so an
 * older write can never land after a newer one. A failed save refetches server truth.
 */
export function useHeimdallCollapseGroups(conversationId: unknown) {
  const queryClient = useQueryClient()
  const enabled = conversationId != null && conversationId !== ''
  const queryKey = useMemo(() => heimdallCollapseQueryKey(conversationId), [conversationId])
  const { data } = useQuery({
    queryKey,
    enabled,
    queryFn: async () => (await localApi.get<{ groups?: HeimdallCollapseGroup[] }>(endpoint(conversationId))).groups ?? [],
  })

  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  // A remount for another conversation must not share the previous chain's ordering.
  useEffect(() => {
    saveChainRef.current = Promise.resolve()
  }, [conversationId])

  const updateGroups = useCallback((groups: HeimdallCollapseGroup[]) => {
    if (!enabled) return
    // A GET already in flight must not overwrite this newer local edit.
    void queryClient.cancelQueries({ queryKey })
    queryClient.setQueryData(queryKey, groups)
    saveChainRef.current = saveChainRef.current.then(async () => {
      try {
        const result = await localApi.put<{ groups?: HeimdallCollapseGroup[] }>(endpoint(conversationId), { groups })
        // Adopt the server's pruned copy only if no newer edit replaced ours meanwhile.
        if (queryClient.getQueryData(queryKey) === groups) queryClient.setQueryData(queryKey, result.groups ?? [])
      } catch (error) {
        console.error('[Heimdall] Failed to save collapsed nodes:', error)
        void queryClient.invalidateQueries({ queryKey })
      }
    })
  }, [enabled, queryClient, queryKey, conversationId])

  return { groups: data ?? EMPTY, updateGroups }
}
