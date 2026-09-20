import { describe, expect, it } from 'vitest'
import type { Conversation } from '../features/conversations/conversationTypes'
import { buildAgentConversationLookup, retainAgentParentPreview } from './useRunningAgentStreams'

const conversation = (id: string, title: string, projectId: string): Conversation => ({
  id,
  user_id: 'user-1',
  title,
  project_id: projectId,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  system_prompt: null,
  conversation_context: null,
  research_note: null,
})

describe('buildAgentConversationLookup', () => {
  it('retains an originating conversation when route-scoped Redux data moves to another project', () => {
    const conversationA = conversation('conversation-a', 'Conversation A', 'project-a')
    const conversationB = conversation('conversation-b', 'Conversation B', 'project-b')

    const lookup = buildAgentConversationLookup([conversationA, conversationB], [conversationB])

    expect(lookup.get('conversation-a')).toMatchObject({
      title: 'Conversation A',
      project_id: 'project-a',
    })
  })

  it('prefers current route data over a stale global conversation record', () => {
    const staleConversation = conversation('conversation-a', 'Old title', 'project-a')
    const currentConversation = conversation('conversation-a', 'Updated title', 'project-a')

    const lookup = buildAgentConversationLookup([staleConversation], [currentConversation])

    expect(lookup.get('conversation-a')?.title).toBe('Updated title')
  })
})


describe('retainAgentParentPreview', () => {
  it('keeps the originating message preview when navigation removes that conversation messages from Redux', () => {
    const cached = { messageId: 'message-a', text: 'Original request from conversation A' }

    expect(retainAgentParentPreview({ messageId: null, text: null }, cached)).toEqual(cached)
  })

  it('uses a currently resolved preview instead of stale cached content', () => {
    const current = { messageId: 'message-a', text: 'Updated request' }
    const cached = { messageId: 'message-a', text: 'Old request' }

    expect(retainAgentParentPreview(current, cached)).toEqual(current)
  })
})
