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

it('explicit host deletion wins over protected live and stale fetched rows', () => {
  const row = message('deleted', null)
  expect(reconcileConversationSnapshot({ fetchedMessages: [row], liveMessages: [row], protections: [{ messageIds: ['deleted'] }], deletedMessageIds: ['deleted'] })).toEqual([])
})

it('keeps a hydrated live row over a compacted fetched row of the same revision, but takes a newer compacted row', () => {
  const hydrated: Message = { ...message('old', null, 'full'), revision: 3, content_blocks: [{ type: 'tool_result', index: 0, tool_use_id: 't', content: 'big output', is_error: false }] }
  const compacted: Message = { ...message('old', null, 'full'), revision: 3, body_omitted: true, content_blocks: [{ type: 'tool_result', index: 0, tool_use_id: 't', is_error: false, omitted: true } as unknown as NonNullable<Message['content_blocks']>[number]] }
  expect(reconcileConversationSnapshot({ fetchedMessages: [compacted], liveMessages: [hydrated] })).toEqual([hydrated])
  const newer = { ...compacted, revision: 4 }
  expect(reconcileConversationSnapshot({ fetchedMessages: [newer], liveMessages: [hydrated] })).toEqual([newer])
  // A live row that is itself compacted does not shadow the fetched copy.
  expect(reconcileConversationSnapshot({ fetchedMessages: [compacted], liveMessages: [compacted] })).toEqual([compacted])
})
