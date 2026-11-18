import { readSystemNotificationPrefs, type SystemNotificationPrefs } from '../ui/systemNotificationPrefs'
import { getChatSelectionHref } from './chatSelection'
import type { StreamState } from './chatTypes'

/** Wire shape sent to `electron/systemNotifications.ts` (validated again in main). */
export type SystemRunNotificationPayload = {
  id: string
  kind: 'primary' | 'branch'
  title: string
  body: string
  conversationId: string
  projectId: string | null
  messageId: string
  lineageId: string | null
}

type ConversationLike = { id: unknown; title?: string | null; project_id?: unknown }

type NotificationsApi = NonNullable<NonNullable<Window['electronAPI']>['notifications']>

/**
 * Build the OS notification for a completed run, or null when it must not notify.
 *
 * Only main Chat runs and branch runs qualify; watcher, subagent and tool streams
 * do not. `before` is the stream as it was BEFORE this `streamCompleted`: a run that
 * was not live then is a replay of an already-finished run (reconnect/bootstrap),
 * not a fresh completion.
 */
export function buildSystemRunNotification(
  before: StreamState | undefined,
  messageId: unknown,
  conversations: readonly ConversationLike[]
): SystemRunNotificationPayload | null {
  if (!before || messageId == null) return null
  if (before.streamType !== 'primary' && before.streamType !== 'branch') return null
  if (!before.active || before.finished || before.status === 'completed') return null
  const conversationId = before.conversationId
  if (conversationId == null) return null

  const conversation = conversations.find(item => String(item.id) === String(conversationId))
  const lineageId = before.lineage?.lineageIdConfirmed && before.lineage.lineageId ? String(before.lineage.lineageId) : null
  const kind = before.streamType
  return {
    // Keyed by response, not by the renderer-local stream ID, so the main and
    // floating windows observing one run produce one notification.
    id: `run-complete:${String(conversationId)}:${String(messageId)}`,
    kind,
    title: conversation?.title?.trim() || 'Graviton',
    // No response text: the notification can appear on a locked screen.
    body: kind === 'branch' ? 'Branch run finished' : 'Response finished',
    conversationId: String(conversationId),
    projectId: conversation?.project_id != null ? String(conversation.project_id) : null,
    messageId: String(messageId),
    lineageId,
  }
}

export function getSystemNotificationsApi(): NotificationsApi | null {
  if (typeof window === 'undefined') return null
  return window.electronAPI?.notifications ?? null
}

/** Fire-and-forget; a browser shared-UI client (no preload) is a no-op. */
export function showSystemRunNotification(
  payload: SystemRunNotificationPayload | null,
  prefs: SystemNotificationPrefs = readSystemNotificationPrefs(),
  api: NotificationsApi | null = getSystemNotificationsApi()
): boolean {
  if (!payload || !prefs.enabled || !api) return false
  void api.show(payload, { onlyWhenUnfocused: prefs.when === 'unfocused' }).catch(() => {})
  return true
}

/** Where a clicked OS notification lands: the confirmed fork, else the completed response. */
export function getSystemNotificationHref(payload: SystemRunNotificationPayload): string {
  const destination = { conversationId: payload.conversationId, projectId: payload.projectId }
  return payload.lineageId
    ? getChatSelectionHref({ ...destination, kind: 'lineage', lineageId: payload.lineageId, messageId: payload.messageId })
    : getChatSelectionHref({ ...destination, kind: 'message', messageId: payload.messageId })
}
