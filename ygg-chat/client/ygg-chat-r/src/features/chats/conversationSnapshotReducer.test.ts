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
