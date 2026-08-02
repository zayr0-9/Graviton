import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useStore } from 'react-redux'
import type { Store } from 'redux'
import type { ConversationId } from '../../../../shared/types'
import { useAppDispatch, useAppSelector } from './redux'
import { useAuth } from './useAuth'
import type { ConversationMessagesTreeData } from '../features/chats/conversationMessagesApi'
import { coordinateConversationSnapshot } from '../features/chats/conversationSnapshotCoordinator'
import { conversationQueryKeys } from '../features/chats/conversationQueryKeys'
import type { RootState } from '../store/store'

export function useConversationSnapshotCoordinator(
  conversationId: ConversationId | null,
  storageMode?: 'local' | 'cloud'
) {
  const dispatch = useAppDispatch()
  const reduxStore = useStore() as Store<RootState>
  const queryClient = useQueryClient()
  const { accessToken } = useAuth()
  const currentConversationId = useAppSelector(state => state.chat.conversation.currentConversationId)
  const activeStreamKey = useAppSelector(state => {
    if (conversationId == null) return ''
    return state.chat.streaming.activeIds
      .filter(streamId => {
        const stream = state.chat.streaming.byId[streamId]
        return stream?.active && stream.conversationId != null && String(stream.conversationId) === String(conversationId)
      })
      .sort()
      .join('|')
  })
  const [acceptedConversationId, setAcceptedConversationId] = useState<string | null>(null)
  const [data, setData] = useState<ConversationMessagesTreeData | undefined>(() =>
    conversationId == null
      ? undefined
      : queryClient.getQueryData<ConversationMessagesTreeData>(conversationQueryKeys.messages(conversationId))
  )
  const [isFetching, setIsFetching] = useState(false)
  const [isFetched, setIsFetched] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const mountedConversationRef = useRef(conversationId == null ? null : String(conversationId))
  const previousActiveKeyRef = useRef(activeStreamKey)

  useEffect(() => {
    mountedConversationRef.current = conversationId == null ? null : String(conversationId)
    setData(
      conversationId == null
        ? undefined
        : queryClient.getQueryData<ConversationMessagesTreeData>(conversationQueryKeys.messages(conversationId))
    )
    setAcceptedConversationId(null)
    setIsFetched(false)
    setError(null)
  }, [conversationId, queryClient])

  const refresh = useCallback(async (): Promise<ConversationMessagesTreeData | undefined> => {
    if (conversationId == null) return undefined
    const requestedId = String(conversationId)
    setIsFetching(true)
    setError(null)
    try {
      const result = await coordinateConversationSnapshot({
        conversationId,
        storageMode,
        accessToken,
        queryClient,
        getState: reduxStore.getState,
        dispatch: action => dispatch(action),
      })
      if (result.accepted && mountedConversationRef.current === requestedId) {
        setData(result.data)
        setAcceptedConversationId(requestedId)
        setIsFetched(true)
        return result.data
      }
      return undefined
    } catch (cause) {
      if (mountedConversationRef.current === requestedId && !(cause instanceof DOMException && cause.name === 'AbortError')) {
        setError(cause instanceof Error ? cause : new Error(String(cause)))
        setIsFetched(true)
      }
      return undefined
    } finally {
      if (mountedConversationRef.current === requestedId) setIsFetching(false)
    }
  }, [accessToken, conversationId, dispatch, queryClient, reduxStore, storageMode])

  // Route entry always requests an authoritative persisted snapshot. Cached data is
  // display-only until this generation is accepted by the coordinator.
  useEffect(() => {
    if (conversationId == null || String(currentConversationId ?? '') !== String(conversationId)) return
    void refresh()
  }, [conversationId, currentConversationId, refresh])

  // Terminal reconciliation is independent of stream pruning. The listener records a
  // lease; this transition supplies the persistence retry after the final SSE projection.
  useEffect(() => {
    const previous = previousActiveKeyRef.current
    previousActiveKeyRef.current = activeStreamKey
    if (previous && !activeStreamKey) void refresh()
  }, [activeStreamKey, refresh])

  const ownsCurrentConversation = acceptedConversationId === (conversationId == null ? null : String(conversationId))
  return {
    data: ownsCurrentConversation ? data : undefined,
    acceptedConversationId: ownsCurrentConversation ? acceptedConversationId : null,
    isFetched: ownsCurrentConversation && isFetched,
    isFetching,
    error,
    refresh,
  }
}
