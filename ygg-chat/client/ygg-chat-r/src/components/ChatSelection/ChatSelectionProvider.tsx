import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { useStore } from 'react-redux'
import { useLocation, useNavigate, type NavigateOptions, type To } from 'react-router-dom'
import type { Store } from 'redux'
import type { RootState } from '../../store/store'
import { useAppSelector } from '../../hooks/redux'
import { gwApi } from '../../utils/api'
import { createChatRouteGate, getChatSelectionHref, parseChatSelectionHref, type ChatSelectionTarget } from '../../features/chats/chatSelection'
import { createChatSelectionController } from '../../features/chats/chatSelectionController'

interface SelectionOptions extends NavigateOptions {
  source?: string
  inPlace?: boolean
}
interface SelectionContextValue {
  select: (target: ChatSelectionTarget, options?: SelectionOptions) => void
  navigate: (to: To | number, options?: NavigateOptions) => void
  snapshotFailed: (conversationId: string) => void
  resolve: (acceptedConversationId: string | null, refresh: () => Promise<unknown>) => Promise<void>
}
const SelectionContext = createContext<SelectionContextValue | null>(null)

export function ChatSelectionProvider({ children }: { children: ReactNode }) {
  const store = useStore() as Store<RootState>
  const routerNavigate = useNavigate()
  const location = useLocation()
  const userId = useAppSelector(state => state.users.currentUser?.id)
  const controller = useMemo(() => createChatSelectionController({
    getState: () => store.getState().chat,
    dispatch: action => store.dispatch(action),
    loadLineage: (target, signal) => gwApi.get(
      `/conversations/${encodeURIComponent(target.conversationId)}/lineages/${encodeURIComponent(target.lineageId)}`,
      { signal }
    ),
  }), [store])
  const routeGate = useMemo(createChatRouteGate, [])
  const previousUserRef = useRef(userId)

  const select = useCallback((target: ChatSelectionTarget, options: SelectionOptions = {}) => {
    const requestId = controller.request(target, options.source ?? 'navigation')
    if (options.inPlace) return
    const href = getChatSelectionHref(target)
    routeGate.expect(requestId, href)
    routerNavigate(href, {
      ...options,
      state: {
        ...options.state,
        ...(target.storageMode ? { storageMode: target.storageMode } : {}),
        chatSelectionRequestId: requestId,
      },
    })
  }, [controller, routerNavigate, routeGate])

  const navigate = useCallback((to: To | number, options?: NavigateOptions) => {
    if (typeof to === 'number') { routerNavigate(to); return }
    const href = typeof to === 'string' ? to : `${to.pathname ?? ''}${to.search ?? ''}${to.hash ?? ''}`
    const target = parseChatSelectionHref(href, options?.state?.storageMode)
    if (target) select(target, options)
    else routerNavigate(to, options)
  }, [routerNavigate, select])

  // Location keys identify visits, not permanent target deduplication. Returning via POP must
  // reapply an old entry, while snapshot changes must never replay its hash after an in-place click.
  useLayoutEffect(() => {
    const href = `${location.pathname}${location.search}${location.hash}`
    if (!routeGate.consume(location.key, href, location.state?.chatSelectionRequestId)) return
    const target = parseChatSelectionHref(href, location.state?.storageMode)
    if (target) controller.request(target, 'route')
    else controller.cancel()
  }, [controller, location, routeGate])

  useLayoutEffect(() => {
    if (previousUserRef.current && previousUserRef.current !== userId) controller.cancel()
    previousUserRef.current = userId
  }, [controller, userId])

  const value = useMemo(() => ({ select, navigate, resolve: controller.resolve, snapshotFailed: controller.snapshotFailed }), [controller, navigate, select])
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>
}

export function useChatSelection(): SelectionContextValue {
  const value = useContext(SelectionContext)
  if (!value) throw new Error('Chat selection requires ChatSelectionProvider')
  return value
}

/** Drop-in router facade: recognized chat routes select centrally; other navigation is unchanged. */
export function useChatNavigate() {
  return useChatSelection().navigate
}
