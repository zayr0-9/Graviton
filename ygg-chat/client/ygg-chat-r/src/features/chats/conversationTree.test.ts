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
  it('honors persisted children_ids order before deterministic fallback order', () => {
    const root = message('root', null, '2024-01-01')
    root.children_ids = ['b', 'a']
    const tree = buildConversationTree([
      root,
      message('a', 'root', '2024-01-02'),
      message('b', 'root', '2024-01-03'),
      message('c', 'root', '2024-01-04'),
    ])
    expect(tree?.children.map(child => child.id)).toEqual(['b', 'a', 'c'])
  })

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


describe('summary tree presentation', () => {
  it('keeps the summary payload out of the tree without changing canonical content or paths', () => {
    const summary = { ...message('summary', 'parent'), role: 'system' as const,
      note: '__auto_compaction_summary__', content: '# Large summary\n'.repeat(10000) }
    const originalContent = summary.content
    const rows = [message('parent', null), summary, message('child', 'summary')]
    const tree = buildConversationTree(rows)
    expect(tree?.children[0].message).toBe('Conversation summarised. Earlier context is preserved for the model.')
    expect(tree?.children[0].children[0].id).toBe('child')
    expect(JSON.stringify(tree)).not.toContain('Large summary')
    expect(summary.content).toBe(originalContent)
    expect(buildPathToConversationMessage(rows, 'child')).toEqual(['parent', 'summary', 'child'])
  })

  it('does not hide ordinary messages that mention summaries', () => {
    const row = message('ordinary', null)
    row.content = 'Here is a summary of the work.'
    row.note = 'summary'
    expect(buildConversationTree([row])?.message).toBe(row.content)
  })
})
