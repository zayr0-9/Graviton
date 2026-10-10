import { describe, expect, it } from 'vitest'
import type { Conversation } from '../../features/conversations/conversationTypes'
import { groupConversationsByProject } from './conversationProjectGroups'

function conversation(id: string, projectId?: string | null): Conversation {
  return {
    id,
    project_id: projectId,
    user_id: 'user',
    title: id,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    system_prompt: null,
    conversation_context: null,
    research_note: null,
  }
}

describe('groupConversationsByProject', () => {
  it('groups by project ID and preserves first-seen group and chat order', () => {
    const chats = [conversation('b1', 'b'), conversation('a1', 'a'), conversation('b2', 'b')]
    const groups = groupConversationsByProject(chats, [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }])

    expect(groups).toEqual([
      { projectId: 'b', name: 'Beta', conversations: [chats[0], chats[2]] },
      { projectId: 'a', name: 'Alpha', conversations: [chats[1]] },
    ])
    expect(groups[0].conversations[0]).toBe(chats[0])
    expect(chats.map(chat => chat.id)).toEqual(['b1', 'a1', 'b2'])
  })

  it('keeps identically named projects separate, including local and cloud chats', () => {
    const local = { ...conversation('local', 'a'), storage_mode: 'local' as const }
    const cloud = { ...conversation('cloud', 'b'), storage_mode: 'cloud' as const }
    const groups = groupConversationsByProject([local, cloud], [{ id: 'a', name: 'Same' }, { id: 'b', name: 'Same' }])

    expect(groups.map(group => group.projectId)).toEqual(['a', 'b'])
    expect(groups.map(group => group.name)).toEqual(['Same', 'Same'])
    expect(groups.flatMap(group => group.conversations)).toEqual([local, cloud])
  })

  it('places null and missing project IDs together under No project at the end', () => {
    const chats = [conversation('none', null), conversation('a1', 'a'), conversation('missing')]
    expect(groupConversationsByProject(chats, [{ id: 'a', name: 'Alpha' }])).toEqual([
      { projectId: 'a', name: 'Alpha', conversations: [chats[1]] },
      { projectId: null, name: 'No project', conversations: [chats[0], chats[2]] },
    ])
  })

  it('keeps unresolved projects separate and chats available while names load or fail', () => {
    const chats = [conversation('a1', 'a'), conversation('b1', 'b'), conversation('a2', 'a')]
    const groups = groupConversationsByProject(chats, [])
    expect(groups.map(group => [group.projectId, group.name])).toEqual([
      ['a', 'Unknown project'], ['b', 'Unknown project'],
    ])
    expect(groups[0].conversations).toEqual([chats[0], chats[2]])
    expect(groups[1].conversations).toEqual([chats[1]])
    expect(groupConversationsByProject(chats, [{ id: 'a', name: 'Loaded' }])[0].name).toBe('Loaded')
  })

  it('trims project names and falls back for blank names', () => {
    const groups = groupConversationsByProject(
      [conversation('a1', 'a'), conversation('b1', 'b')],
      [{ id: 'a', name: ' Alpha ' }, { id: 'b', name: '  ' }]
    )
    expect(groups.map(group => group.name)).toEqual(['Alpha', 'Unknown project'])
  })

  it('does not render projects with no selectable chats', () => {
    expect(groupConversationsByProject([], [{ id: 'a', name: 'Alpha' }])).toEqual([])
  })
})
