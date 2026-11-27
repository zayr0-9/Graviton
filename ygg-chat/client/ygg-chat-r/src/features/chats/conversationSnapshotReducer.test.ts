import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
  })
})

import chatReducer, { chatSliceActions } from './chatSlice'
import type { Message } from './chatTypes'
import { buildConversationTree } from './conversationTree'

const message = (id: string, parentId: string | null): Message => ({
  id,
  conversation_id: 'a',
  role: 'assistant',
  content: id,
  content_plain_text: id,
  parent_id: parentId,
  children_ids: [],
  created_at: id,
  model_name: 'test',
  partial: false,
  pastedContext: [],
  artifacts: [],
})

describe('conversationSnapshotApplied', () => {
  it('installs messages/tree atomically and preserves a valid selected tip', () => {
    let state = chatReducer(undefined, chatSliceActions.conversationSet('a'))
    state = chatReducer(state, chatSliceActions.conversationPathSet(['root', 'tip']))
    const messages = [message('root', null), message('tip', 'root')]
    state = chatReducer(state, chatSliceActions.conversationSnapshotApplied({
      conversationId: 'a',
      messages,
      tree: buildConversationTree(messages),
    }))
    expect(state.conversation.snapshotConversationId).toBe('a')
    expect(state.conversation.currentPath).toEqual(['root', 'tip'])
    expect(state.heimdall.treeData?.children[0]?.id).toBe('tip')
  })

  it('clears the installed snapshot on A to B but retains it for same-conversation remounts', () => {
    let state = chatReducer(undefined, chatSliceActions.conversationSet('a'))
    const messages = [message('root', null)]
    state = chatReducer(state, chatSliceActions.conversationSnapshotApplied({
      conversationId: 'a',
      messages,
      tree: buildConversationTree(messages),
    }))
    const same = chatReducer(state, chatSliceActions.conversationSet('a'))
    expect(same.conversation.messages).toHaveLength(1)

    const switched = chatReducer(same, chatSliceActions.conversationSet('b'))
    expect(switched.conversation.messages).toEqual([])
    expect(switched.heimdall.treeData).toBeNull()
    expect(switched.conversation.snapshotConversationId).toBeNull()
  })

  it('ignores cross-conversation snapshot payloads', () => {
    const state = chatReducer(undefined, chatSliceActions.conversationSet('b'))
    const next = chatReducer(state, chatSliceActions.conversationSnapshotApplied({
      conversationId: 'a',
      messages: [message('wrong', null)],
      tree: null,
    }))
    expect(next.conversation.messages).toEqual([])
  })
})

describe('messageBodiesHydrated', () => {
  const compact: Message = { ...message('old', null), revision: 2, body_omitted: true, body_omitted_chars: 900, artifacts: ['kept.png'],
    content_blocks: [{ type: 'tool_result', index: 0, tool_use_id: 't', is_error: false, omitted: true } as unknown as NonNullable<Message['content_blocks']>[number]] }
  const full: Message = { ...message('old', null), revision: 2, artifacts: [], content_blocks: [{ type: 'tool_result', index: 0, tool_use_id: 't', content: 'output', is_error: false }] }
  const seeded = () => {
    const state = chatReducer(undefined, chatSliceActions.conversationSet('a'))
    return chatReducer(state, chatSliceActions.conversationSnapshotApplied({ conversationId: 'a', messages: [compact, message('tip', 'old')], tree: null }))
  }

  it('installs full bodies, clears the flag and keeps renderer artifacts', () => {
    const state = seeded()
    const next = chatReducer(state, chatSliceActions.messageBodiesHydrated({ conversationId: 'a', messages: [full] }))
    const row = next.conversation.messages[0]
    expect(row.content_blocks).toEqual(full.content_blocks)
    expect(row.body_omitted).toBeUndefined()
    expect(row.body_omitted_chars).toBeUndefined()
    expect(row.artifacts).toEqual(['kept.png'])
    expect(next.conversation.messages[1]).toBe(state.conversation.messages[1])
  })

  it('ignores rows that are not compacted, older fetched revisions and other conversations', () => {
    const state = seeded()
    const stale = chatReducer(state, chatSliceActions.messageBodiesHydrated({ conversationId: 'a', messages: [{ ...full, revision: 1 }] }))
    expect(stale.conversation.messages[0].body_omitted).toBe(true)
    const other = chatReducer(state, chatSliceActions.messageBodiesHydrated({ conversationId: 'b', messages: [full] }))
    expect(other.conversation.messages[0].body_omitted).toBe(true)
    const untouched = chatReducer(state, chatSliceActions.messageBodiesHydrated({ conversationId: 'a', messages: [{ ...full, id: 'tip', content: 'replaced' }] }))
    expect(untouched.conversation.messages[1].content).toBe('tip')
  })
})
