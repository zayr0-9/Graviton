import { useEffect } from 'react'
import { useStore } from 'react-redux'
import { useChatNavigate } from '../components/ChatSelection/ChatSelectionProvider'
import { getSystemNotificationHref, getSystemNotificationsApi } from '../features/chats/systemRunNotifications'
import { uiActions } from '../features/ui'
import type { RootState } from '../store/store'
import { useAppDispatch } from './redux'

/**
 * Open the run behind a clicked OS notification. Main parks the payload until it is
 * taken, so this also covers a window created by the click and late subscription.
 */
export function useSystemNotificationActivation(): void {
  const navigate = useChatNavigate()
  const dispatch = useAppDispatch()
  const store = useStore<RootState>()

  useEffect(() => {
    const api = getSystemNotificationsApi()
    if (!api) return
    const take = () => {
      void api.takeActivation().then(payload => {
        // Main hands a payload out once; never drop it, even if this effect re-ran meanwhile.
        if (!payload) return
        // The pill would otherwise replay this completion after the user already opened it.
        store.getState().ui.notifications
          .filter(item => item.kind === 'branch_stream_completed' &&
            String(item.conversationId) === payload.conversationId && String(item.messageId) === payload.messageId)
          .forEach(item => dispatch(uiActions.notificationDismissed(item.id)))
        navigate(getSystemNotificationHref(payload))
      }).catch(() => {})
    }

    take()
    const unsubscribe = api.onActivated(take)
    return unsubscribe
  }, [navigate, dispatch, store])
}
