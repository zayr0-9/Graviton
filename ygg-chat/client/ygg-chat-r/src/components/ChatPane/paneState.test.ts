import { describe, expect, it } from 'vitest'
import type { ChatErrorRecord, Message } from '../../features/chats/chatTypes'
import { advancePanePath, selectErrorsForPane } from './paneState'

const message = (id: string, parentId: string | null): Message => ({
  id,
  conversation_id: 'conversation-a',
  role: id.startsWith('u') ? 'user' : 'assistant',
  content: id,
  content_plain_text: id,
  parent_id: parentId,
  children_ids: [],
  created_at: '2026-01-01T00:00:00.000Z',
  model_name: 'test',
  partial: false,
  pastedContext: [],
  artifacts: [],
})

const error = (overrides: Partial<ChatErrorRecord>): ChatErrorRecord => ({
  id: 'error',
  conversationId: 'conversation-a',
  envelope: { code: 'internal_error', userMessage: 'Failed', recoverability: 'retryable' },
  parentMessageId: null,
  streamId: null,
  lineageId: null,
  createdAt: 1,
  dismissed: false,
  ...overrides,
})

describe('chat pane state helpers', () => {
  it('routes errors by stream, exact lineage, or a parent on the pane path', () => {
    const errors = [
      error({ id: 'stream', streamId: 'stream-b' }),
      error({ id: 'lineage', lineageId: 'lineage-b' as any }),
      error({ id: 'parent', parentMessageId: 'u-b' }),
      error({ id: 'sibling', parentMessageId: 'u-a', lineageId: 'lineage-a' as any }),
    ]

    expect(
      selectErrorsForPane(errors, {
        conversationId: 'conversation-a',
        lineageId: 'lineage-b' as any,
        path: ['root', 'u-b'],
        streamId: 'stream-b',
      }).map(record => record.id)
    ).toEqual(['stream', 'lineage', 'parent'])
  })

  it('rebuilds a pane path from canonical persisted messages when available', () => {
    const messages = [message('root', null), message('u-b', 'root'), message('a-b', 'u-b')]
    expect(advancePanePath(messages, ['root'], 'u-b', 'a-b')).toEqual(['root', 'u-b', 'a-b'])
  })

  it('appends server ids locally when the canonical snapshot has not caught up yet', () => {
    expect(advancePanePath([message('root', null)], ['root'], 'u-b', 'a-b')).toEqual(['root', 'u-b', 'a-b'])
  })
})
