import React, { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { buildChatErrorEnvelope, type ChatErrorActionKind } from '../../../../../shared/chatErrors'
import { uiActions } from '../../features/ui'
import type { UiErrorNotice } from '../../features/ui/uiSlice'
import { useAppDispatch, useAppSelector } from '../../hooks/redux'
import { ChatErrorBubble } from '../ChatErrorBubble/ChatErrorBubble'

/**
 * The app's out-of-thread surface.
 *
 * It does two unrelated jobs, and that is on purpose — both are global lifecycle
 * concerns with no other home:
 *
 *  1. It garbage-collects `ui.notifications`. Those are NAVIGABLE notices
 *     ("your background branch finished"); `RunningAgentsFloatingButton` draws them
 *     as a transient inline banner but never removes them from the store, so this
 *     8s timer is the only thing that does. Unchanged from before.
 *
 *  2. It RENDERS `ui.errorNotices` — failures with no chat bubble to live on.
 *     Update/delete a message, clone a conversation, rename, set a research note,
 *     set cwd: all of these used to fail into `console.error` and nowhere else.
 *     The chat error bubble belongs to the chat stream, so these needed a global
 *     surface. This is it.
 *
 * Why keep this component instead of deleting it as dead code: job 1 is load-bearing
 * (deleting it leaks notifications until the 6-item cap evicts them), and job 2 had
 * no owner at all. Deleting would have removed the GC and left the mutation failures
 * invisible. Making it render is the strictly better of the two options offered.
 *
 * The error visual itself is `ChatErrorBubble` — the ONE error visual in the app.
 * This component adds positioning and action wiring, not a second design.
 */

const AUTO_DISMISS_MS = 8000

/**
 * Which `ChatErrorAction` kinds a GLOBAL surface can honestly perform.
 *
 * `retry` / `compact` / `switch_mode` / `reconnect_provider` are deliberately absent:
 * they need the originating call site's closure, which cannot live in Redux. Rendering
 * a Retry button that does nothing is worse than rendering no button, so the bubble is
 * given no `onAction` in those cases and draws message + dismiss only.
 */
const isGloballyActionable = (notice: UiErrorNotice): boolean => {
  const kind = notice.envelope.action?.kind
  if (!kind) return false
  return kind === 'sign_in' || kind === 'open_settings' || kind === 'upgrade' || kind === 'reload_conversation'
}

export const GlobalNotifications: React.FC = () => {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const notifications = useAppSelector(state => state.ui.notifications)
  const errorNotices = useAppSelector(state => state.ui.errorNotices)
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    const activeIds = new Set(notifications.map(item => item.id))

    for (const notification of notifications) {
      if (timersRef.current.has(notification.id)) continue

      const timeout = setTimeout(() => {
        dispatch(uiActions.notificationDismissed(notification.id))
      }, AUTO_DISMISS_MS)

      timersRef.current.set(notification.id, timeout)
    }

    for (const [id, timeout] of timersRef.current.entries()) {
      if (activeIds.has(id)) continue
      clearTimeout(timeout)
      timersRef.current.delete(id)
    }
  }, [dispatch, notifications])

  useEffect(() => {
    return () => {
      for (const timeout of timersRef.current.values()) {
        clearTimeout(timeout)
      }
      timersRef.current.clear()
    }
  }, [])

  // Error notices are NOT auto-dismissed. A failed save that vanishes after 8s is
  // barely better than a console line — the user must see it and close it.
  const handleAction = (notice: UiErrorNotice) => (kind: ChatErrorActionKind) => {
    switch (kind) {
      case 'sign_in':
        navigate('/login')
        break
      case 'open_settings':
        navigate('/settings')
        break
      case 'upgrade':
        navigate('/paymentplan')
        break
      case 'reload_conversation':
        // Re-runs the current route's loaders/effects; the notice's own ids are not
        // enough to route anywhere better (we rarely have the projectId).
        navigate(0)
        break
      default:
        return
    }
    dispatch(uiActions.errorNoticeDismissed(notice.id))
  }

  if (errorNotices.length === 0) return null

  return (
    <div
      // Bottom-LEFT: RunningAgentsFloatingButton owns bottom-right at z-1500.
      className='pointer-events-none fixed bottom-4 left-4 z-[1400] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2'
      role='region'
      aria-label='Notifications'
    >
      {errorNotices.map(notice => (
        <ChatErrorBubble
          key={notice.id}
          className='pointer-events-auto shadow-lg backdrop-blur-md'
          envelope={notice.envelope}
          onAction={isGloballyActionable(notice) ? handleAction(notice) : undefined}
          onDismiss={() => dispatch(uiActions.errorNoticeDismissed(notice.id))}
        />
      ))}
    </div>
  )
}

/**
 * Top-level render-crash boundary.
 *
 * There is no ErrorBoundary anywhere in `src/`, so any throw during render blanks
 * the entire app to a white screen with nothing but a console trace. This class is
 * the fix, but it has to WRAP the tree — and the tree is assembled in `App.tsx`,
 * which this agent does not own. It is exported from here, ready to use; see the
 * cross-file request to wrap `appShell` in `App.tsx`.
 *
 * It reuses `ChatErrorBubble` so a crash looks like every other failure, and it puts
 * the raw `Error.message` + component stack in `detail` (behind the disclosure)
 * rather than on screen.
 */
interface AppErrorBoundaryProps {
  children: React.ReactNode
}

interface AppErrorBoundaryState {
  detail: string | null
}

export class AppErrorBoundary extends React.Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { detail: null }

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { detail: error instanceof Error ? (error.stack || error.message) : String(error) }
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error('[AppErrorBoundary] render crash', error, info.componentStack)
  }

  render(): React.ReactNode {
    if (this.state.detail == null) return this.props.children

    return (
      <div className='flex min-h-screen items-center justify-center p-6'>
        <ChatErrorBubble
          className='w-full max-w-md'
          envelope={buildChatErrorEnvelope('internal_error', {
            userMessage: 'Something went wrong and this screen stopped working. Reloading usually fixes it.',
            action: { kind: 'reload_conversation', label: 'Reload app' },
            detail: this.state.detail,
          })}
          onAction={() => window.location.reload()}
        />
      </div>
    )
  }
}

export default GlobalNotifications
