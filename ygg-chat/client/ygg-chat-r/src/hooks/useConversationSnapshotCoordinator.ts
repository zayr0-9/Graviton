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
  const refreshRevisionRef = useRef(0)
  const previousActiveKeyRef = useRef(activeStreamKey)

  useEffect(() => {
    refreshRevisionRef.current += 1
    mountedConversationRef.current = conversationId == null ? null : String(conversationId)
    setData(
      conversationId == null
        ? undefined
        : queryClient.getQueryData<ConversationMessagesTreeData>(conversationQueryKeys.messages(conversationId))
    )
    setAcceptedConversationId(null)
    setIsFetching(false)
    setIsFetched(false)
    setError(null)
    return () => { refreshRevisionRef.current += 1 }
  }, [conversationId, queryClient])

  const refresh = useCallback(async (): Promise<ConversationMessagesTreeData | undefined> => {
    if (conversationId == null) return undefined
    const requestedId = String(conversationId)
    // A completed send/branch can retain a refresh callback from the prior route.
    // It must not take loading ownership away from the newly mounted conversation.
    if (mountedConversationRef.current !== requestedId ||
        String(reduxStore.getState().chat.conversation.currentConversationId ?? '') !== requestedId) return undefined
    const revision = ++refreshRevisionRef.current
    // Conversation identity alone is insufficient: same-chat refreshes overlap,
    // and an A -> B -> A visit must not revive a request from the earlier visit.
    const ownsRefresh = () => refreshRevisionRef.current === revision &&
      mountedConversationRef.current === requestedId &&
      String(reduxStore.getState().chat.conversation.currentConversationId ?? '') === requestedId
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
      if (result.accepted && ownsRefresh()) {
        setError(null)
        setData(result.data)
        setAcceptedConversationId(requestedId)
        setIsFetched(true)
        return result.data
      }
      return undefined
    } catch (cause) {
      if (ownsRefresh() && !(cause instanceof DOMException && cause.name === 'AbortError')) {
        setError(cause instanceof Error ? cause : new Error(String(cause)))
        setIsFetched(true)
      }
      return undefined
    } finally {
      if (ownsRefresh()) setIsFetching(false)
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

  const routeConversationId = conversationId == null ? null : String(conversationId)
  const ownsCurrentConversation = acceptedConversationId === routeConversationId
  // Effects reset state after render. Never expose A's failure to Chat's selection
  // effect on the first B render, before those resets have committed.
  const ownsMountedConversation = mountedConversationRef.current === routeConversationId
  return {
    data: ownsCurrentConversation ? data : undefined,
    acceptedConversationId: ownsCurrentConversation ? acceptedConversationId : null,
    isFetched: ownsCurrentConversation && isFetched,
    isFetching: ownsMountedConversation && isFetching,
    error: ownsMountedConversation ? error : null,
    refresh,
  }
}
