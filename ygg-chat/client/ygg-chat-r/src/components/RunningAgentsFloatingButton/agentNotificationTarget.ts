import type { UiNotification } from '../../features/ui'
import type { AgentStreamListItem } from '../../hooks/useRunningAgentStreams'

/** Resolve the completed execution, never just the newest run in its conversation/fork. */
export function getAgentNotificationStreamId(
  notification: UiNotification,
  streams: readonly AgentStreamListItem[]
): string | null {
  if (notification.kind !== 'branch_stream_completed') return null
  if (notification.streamId) return notification.streamId

  // Older notifications have no execution ID. Match only their exact response.
  const messageId = String(notification.messageId)
  return streams.find(stream =>
    stream.conversationId === String(notification.conversationId) &&
    [stream.finalMessageId, stream.lastCompletedMessageId, stream.messageId, stream.anchorMessageId]
      .some(id => id != null && id === messageId)
  )?.streamId ?? null
}

/** Keep the preview-first interaction even after a run's transcript was superseded. */
export function getAgentNotificationPreview(
  notification: UiNotification,
  streams: readonly AgentStreamListItem[],
  buildItem: (streamId: string) => AgentStreamListItem
): AgentStreamListItem | null {
  if (notification.kind !== 'branch_stream_completed') return null
  const streamId = getAgentNotificationStreamId(notification, streams) ?? `notification:${notification.id}`
  const item = streams.find(stream => stream.streamId === streamId) ?? buildItem(streamId)
  return {
    ...item,
    conversationId: String(notification.conversationId),
    projectId: notification.projectId != null ? String(notification.projectId) : item.projectId,
    conversationTitle: item.conversationTitle ?? notification.title,
    anchorMessageId: String(notification.messageId),
  }
}
