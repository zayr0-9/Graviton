import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  const selectionRequestId = useAppSelector(state => state.chat.selection.requestId)
  const snapshotConversationId = useAppSelector(state => state.chat.conversation.snapshotConversationId)
  // Each mounted conversation visit owns its callbacks, not just its in-flight requests.
  // An old A callback must stay invalid after A -> B -> A or Settings -> Back.
  const visit = useMemo(() => ({ active: false }), [conversationId, queryClient])
  const activeVisitRef = useRef(visit)
  const attemptedSelectionRef = useRef<string | null>(null)
  const autoRefreshRef = useRef<(() => Promise<ConversationMessagesTreeData | undefined>) | null>(null)
  const latestRefreshRef = useRef<{ visit: typeof visit; revision: number; promise: Promise<ConversationMessagesTreeData | undefined> } | null>(null)
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
  const [failure, setFailure] = useState<{ error: Error; revision: number; requestId: string | null } | null>(null)
  const mountedConversationRef = useRef(conversationId == null ? null : String(conversationId))
  const refreshRevisionRef = useRef(0)
  const previousActiveKeyRef = useRef(activeStreamKey)

  useEffect(() => {
    refreshRevisionRef.current += 1
    visit.active = true
    activeVisitRef.current = visit
    autoRefreshRef.current = null
    latestRefreshRef.current = null
    mountedConversationRef.current = conversationId == null ? null : String(conversationId)
    setData(
      conversationId == null
        ? undefined
        : queryClient.getQueryData<ConversationMessagesTreeData>(conversationQueryKeys.messages(conversationId))
    )
    setAcceptedConversationId(null)
    setIsFetching(false)
    setIsFetched(false)
    setFailure(null)
    return () => { visit.active = false; refreshRevisionRef.current += 1 }
  }, [conversationId, queryClient, visit])

  const refresh = useCallback((): Promise<ConversationMessagesTreeData | undefined> => {
    if (conversationId == null) return Promise.resolve(undefined)
    const requestedId = String(conversationId)
    // A completed send/branch can retain a refresh callback from the prior route.
    // It must not take loading ownership away from the newly mounted conversation.
    if (!visit.active || activeVisitRef.current !== visit || mountedConversationRef.current !== requestedId ||
        String(reduxStore.getState().chat.conversation.currentConversationId ?? '') !== requestedId) return Promise.resolve(undefined)
    attemptedSelectionRef.current = reduxStore.getState().chat.selection.requestId
    const revision = ++refreshRevisionRef.current
    // Conversation identity alone is insufficient: same-chat refreshes overlap,
    // and an A -> B -> A visit must not revive a request from the earlier visit.
    const ownsRefresh = () => visit.active && activeVisitRef.current === visit && refreshRevisionRef.current === revision &&
      mountedConversationRef.current === requestedId &&
      String(reduxStore.getState().chat.conversation.currentConversationId ?? '') === requestedId
    setIsFetching(true)
    setFailure(null)
    const promise = (async () => {
      try {
        const result = await coordinateConversationSnapshot({
          conversationId,
          storageMode,
          accessToken,
          queryClient,
          getState: reduxStore.getState,
          isCurrent: ownsRefresh,
          dispatch: action => dispatch(action),
        })
        if (result.accepted && ownsRefresh()) {
          setFailure(null)
          setData(result.data)
          setAcceptedConversationId(requestedId)
          setIsFetched(true)
          return result.data
        }
        // Resolver-owned refreshes must wait for the replacement instead of treating
        // cancellation as proof that a message/lineage is missing in the old snapshot.
        const latest = latestRefreshRef.current
        if (visit.active && activeVisitRef.current === visit && latest?.visit === visit && latest.revision > revision &&
            String(reduxStore.getState().chat.conversation.currentConversationId ?? '') === requestedId) return latest.promise
        return undefined
      } catch (cause) {
        // The coordinator already filters owned cancellation; any remaining error
        // belongs to this load, including an unsolicited transport AbortError.
        if (ownsRefresh()) {
          setFailure({ error: cause instanceof Error ? cause : new Error(String(cause)), revision,
            requestId: reduxStore.getState().chat.selection.requestId })
          setIsFetched(true)
        }
        return undefined
      } finally {
        if (ownsRefresh()) setIsFetching(false)
      }
    })()
    latestRefreshRef.current = { visit, revision, promise }
    return promise
  }, [accessToken, conversationId, dispatch, queryClient, reduxStore, storageMode, visit])

  // Route entry always requests an authoritative persisted snapshot. Cached data is
  // display-only until this generation is accepted by the coordinator.
  useEffect(() => {
    if (conversationId == null || String(currentConversationId ?? '') !== String(conversationId)) return
    const contextChanged = autoRefreshRef.current !== refresh
    autoRefreshRef.current = refresh
    // In-place focus uses the accepted snapshot. A new intent after a failed load
    // must fetch again, but do not duplicate a Retry that already started loading.
    if (contextChanged || ((acceptedConversationId !== String(conversationId) || String(snapshotConversationId) !== String(conversationId)) &&
        attemptedSelectionRef.current !== selectionRequestId)) void refresh()
  }, [conversationId, currentConversationId, refresh, selectionRequestId, acceptedConversationId, snapshotConversationId])

  // Terminal reconciliation is independent of stream pruning. The listener records a
  // lease; this transition supplies the persistence retry after the final SSE projection.
  useEffect(() => {
    const previous = previousActiveKeyRef.current
    previousActiveKeyRef.current = activeStreamKey
    if (previous && !activeStreamKey) void refresh()
  }, [activeStreamKey, refresh])

  const routeConversationId = conversationId == null ? null : String(conversationId)
  const ownsCurrentConversation = visit.active && activeVisitRef.current === visit &&
    acceptedConversationId === routeConversationId && String(snapshotConversationId) === routeConversationId
  // Effects reset state after render. Never expose A's failure to Chat's selection
  // effect on the first B render, before those resets have committed.
  const ownsMountedConversation = visit.active && activeVisitRef.current === visit && mountedConversationRef.current === routeConversationId
  // Read ownership again in the consumer effect: an earlier effect may have started
  // a replacement since this render captured the old error/loading flags.
  const isCurrentError = useCallback(() => Boolean(failure && visit.active && activeVisitRef.current === visit &&
    failure.revision === refreshRevisionRef.current && failure.requestId === reduxStore.getState().chat.selection.requestId &&
    String(reduxStore.getState().chat.conversation.currentConversationId ?? '') === routeConversationId),
  [failure, reduxStore, routeConversationId, visit])
  return {
    data: ownsCurrentConversation ? data : undefined,
    acceptedConversationId: ownsCurrentConversation ? acceptedConversationId : null,
    isFetched: ownsCurrentConversation && isFetched,
    isFetching: ownsMountedConversation && isFetching,
    error: ownsMountedConversation && failure?.requestId === selectionRequestId ? failure?.error ?? null : null,
    isCurrentError,
    refresh,
  }
}
