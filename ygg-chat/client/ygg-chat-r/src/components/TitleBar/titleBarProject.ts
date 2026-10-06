import { matchPath } from 'react-router-dom'
import type { Conversation } from '../../features/conversations/conversationTypes'

export const getTitleBarProjectId = (
  pathname: string,
  conversations: ReadonlyArray<Pick<Conversation, 'id' | 'project_id'>>
): string | null => {
  const route = matchPath('/chat/:projectId/:conversationId', pathname)
    ?? matchPath('/chat/:projectId/:conversationId/lineage/:lineageId', pathname)
  if (!route) return null

  const { projectId, conversationId } = route.params
  if (projectId && projectId !== 'unknown' && projectId !== 'null') return projectId

  // Only use metadata for the conversation in the URL, never the previous selection.
  const conversation = conversations.find(item => String(item.id) === conversationId)
  return conversation?.project_id != null ? String(conversation.project_id) : null
}
