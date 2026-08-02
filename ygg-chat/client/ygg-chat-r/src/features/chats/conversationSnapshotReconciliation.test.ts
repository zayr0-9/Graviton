import { describe, expect, it } from 'vitest'
import type { Message } from './chatTypes'
import { reconcileConversationSnapshot } from './conversationSnapshotReconciliation'

const message = (id: string, parentId: string | null, content = id): Message => ({
  id,
  conversation_id: 'c1',
  role: 'assistant',
  content,
  content_plain_text: content,
  parent_id: parentId,
  children_ids: [],
  created_at: id,
  model_name: 'test',
  partial: false,
  pastedContext: [],
  artifacts: [],
})

describe('reconcileConversationSnapshot', () => {
  it('preserves protected live rows, their ancestors, and protected same-ID content', () => {
    const result = reconcileConversationSnapshot({
      fetchedMessages: [message('root', null), message('assistant', 'root', 'stale')],
      liveMessages: [
        message('root', null),
        message('assistant', 'root', 'live'),
        message('terminal', 'assistant', 'final'),
      ],
      protections: [{ messageIds: ['terminal', 'assistant'] }],
    })
    expect(result.map(row => [row.id, row.content])).toEqual([
      ['root', 'root'],
      ['assistant', 'live'],
      ['terminal', 'final'],
    ])
  })

  it('treats fetched omissions as deletions without protection', () => {
    const result = reconcileConversationSnapshot({
      fetchedMessages: [message('root', null)],
      liveMessages: [message('root', null), message('deleted', 'root')],
    })
    expect(result.map(row => row.id)).toEqual(['root'])
  })

  it('preserves only the minimal ancestor chain for a terminal lease', () => {
    const result = reconcileConversationSnapshot({
      fetchedMessages: [],
      liveMessages: [message('root', null), message('terminal', 'root'), message('sibling', 'root')],
      protections: [{ messageIds: ['terminal'] }],
    })
    expect(result.map(row => row.id)).toEqual(['root', 'terminal'])
  })
})
