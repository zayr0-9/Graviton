import { describe, expect, it } from 'vitest'
import type { Message } from './chatTypes'
import { buildConversationTree, buildPathToConversationMessage } from './conversationTree'

const message = (id: string, parentId: string | null, createdAt = id): Message => ({
  id,
  conversation_id: 'c1',
  role: 'user',
  content: id,
  content_plain_text: id,
  parent_id: parentId,
  children_ids: [],
  created_at: createdAt,
  model_name: 'test',
  partial: false,
  pastedContext: [],
  artifacts: [],
})

describe('buildConversationTree', () => {
  it('orders siblings deterministically and normalizes IDs', () => {
    const tree = buildConversationTree([
      message('root', null, '2024-01-01'),
      message('b', 'root', '2024-01-03'),
      message('a', 'root', '2024-01-02'),
    ])
    expect(tree?.children.map(child => child.id)).toEqual(['a', 'b'])
  })

  it('keeps orphan and cyclic components visible', () => {
    const tree = buildConversationTree([
      message('orphan', 'missing'),
      message('cycle-a', 'cycle-b'),
      message('cycle-b', 'cycle-a'),
    ])
    expect(tree?.id).toBe('root')
    expect(tree?.children.map(child => child.id)).toEqual(expect.arrayContaining(['orphan', 'cycle-a']))
  })

  it('keeps the last duplicate row and builds parent-correct paths', () => {
    const tree = buildConversationTree([message('root', null), message('child', null), message('child', 'root')])
    expect(tree?.children[0]?.id).toBe('child')
    expect(buildPathToConversationMessage([message('root', null), message('child', 'root')], 'child')).toEqual([
      'root',
      'child',
    ])
  })
})
