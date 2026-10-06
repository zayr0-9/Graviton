import type { Project } from '../../../../../shared/types'
import type { Conversation } from '../../features/conversations/conversationTypes'

export interface ConversationProjectGroup {
  projectId: string | null
  name: string
  conversations: Conversation[]
}

export function groupConversationsByProject(
  conversations: readonly Conversation[],
  projects: readonly Pick<Project, 'id' | 'name'>[]
): ConversationProjectGroup[] {
  const projectNames = new Map(projects.map(project => [String(project.id), project.name]))
  const groups = new Map<string | null, ConversationProjectGroup>()

  for (const conversation of conversations) {
    const projectId = conversation.project_id ? String(conversation.project_id) : null
    let group = groups.get(projectId)
    if (!group) {
      group = {
        projectId,
        name: projectId === null ? 'No project' : projectNames.get(projectId)?.trim() || 'Unknown project',
        conversations: [],
      }
      groups.set(projectId, group)
    }
    group.conversations.push(conversation)
  }

  // Keep first-seen project and conversation ordering, with unassigned chats last.
  const result = [...groups.values()].filter(group => group.projectId !== null)
  const unassigned = groups.get(null)
  if (unassigned) result.push(unassigned)
  return result
}
