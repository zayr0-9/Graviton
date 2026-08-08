import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
  })
})

import type { RootState } from '../../store/store'
import {
  selectCurrentLineageId,
  selectCurrentViewStream,
  selectCurrentViewStreamFor,
  selectDisplayMessagesFor,
} from './chatSelectors'
import chatReducer, { chatSliceActions } from './chatSlice'
import { createEmptyStreamState } from './streamHelpers'
import type { LineageId } from './chatTypes'

const lineage = (value: string) => value as LineageId

describe('renderer lineage state', () => {
  it('selects conversation, lineage, path, and focus atomically', () => {
    const state = chatReducer(undefined, chatSliceActions.lineageSelected({
      conversationId: 'conversation-a',
      lineageId: lineage('lineage-a'),
      path: ['root', 'tip'],
      focus: 'tip',
    }))

    expect(state.conversation).toMatchObject({
      currentConversationId: 'conversation-a',
      currentLineageId: 'lineage-a',
      currentPath: ['root', 'tip'],
      focusedChatMessageId: 'tip',
    })
    expect(selectCurrentLineageId({ chat: state } as RootState)).toBe('lineage-a')
  })

  it('clears lineage selection, path, and focus on a conversation switch', () => {
    let state = chatReducer(undefined, chatSliceActions.lineageSelected({
      conversationId: 'conversation-a',
      lineageId: lineage('lineage-a'),
      path: ['root', 'tip'],
      focus: 'tip',
    }))

    state = chatReducer(state, chatSliceActions.conversationSet('conversation-b'))

    expect(state.conversation.currentLineageId).toBeNull()
    expect(state.conversation.currentPath).toEqual([])
    expect(state.conversation.focusedChatMessageId).toBeNull()
  })

  it('matches an active stream by exact lineage before legacy message anchors', () => {
    let chat = chatReducer(undefined, chatSliceActions.lineageSelected({
      conversationId: 'conversation-a',
      lineageId: lineage('selected-lineage'),
      path: ['root', 'legacy-tip'],
      focus: 'legacy-tip',
    }))
    const exact = {
      ...createEmptyStreamState('branch', { lineageId: lineage('selected-lineage') }),
      active: true,
      conversationId: 'conversation-a',
      createdAt: '2024-01-01T00:00:00.000Z',
    }
    const legacyAnchor = {
      ...createEmptyStreamState('primary'),
      active: true,
      conversationId: 'conversation-a',
      currentBranchAnchorMessageId: 'legacy-tip',
      createdAt: '2025-01-01T00:00:00.000Z',
    }
    chat = {
      ...chat,
      streaming: {
        ...chat.streaming,
        activeIds: ['exact', 'legacy'],
        byId: { exact, legacy: legacyAnchor },
        primaryStreamId: 'legacy',
      },
    }

    expect(selectCurrentViewStream({ chat } as RootState)?.id).toBe('exact')
  })

  it('falls back to legacy anchors when active streams do not carry the selected lineage', () => {
    let chat = chatReducer(undefined, chatSliceActions.lineageSelected({
      conversationId: 'conversation-a',
      lineageId: lineage('selected-lineage'),
      path: ['root', 'tip'],
      focus: 'tip',
    }))
    const legacy = {
      ...createEmptyStreamState('primary'),
      active: true,
      conversationId: 'conversation-a',
      currentBranchAnchorMessageId: 'tip',
    }
    chat = {
      ...chat,
      streaming: {
        ...chat.streaming,
        activeIds: ['legacy'],
        byId: { legacy },
        primaryStreamId: 'legacy',
      },
    }

    expect(selectCurrentViewStream({ chat } as RootState)?.id).toBe('legacy')
  })
})

describe('renderer lineage stream ownership', () => {
  it('does not let a background branch replace the selected lineage', () => {
    let state = chatReducer(undefined, chatSliceActions.lineageSelected({
      conversationId: 'conversation-a',
      lineageId: lineage('lineage-b'),
      path: ['root', 'branch-b'],
      focus: 'branch-b',
    }))

    state = chatReducer(state, chatSliceActions.sendingStarted({
      streamId: 'stream-c',
      streamType: 'branch',
      conversationId: 'conversation-a',
      lineage: { lineageId: lineage('lineage-a'), rootMessageId: 'root' },
    }))
    state = chatReducer(state, chatSliceActions.streamLineageUpdated({
      streamId: 'stream-c',
      lineageId: lineage('lineage-c'),
    }))

    expect(state.streaming.byId['stream-c'].lineage.lineageId).toBe('lineage-c')
    expect(state.conversation.currentLineageId).toBe('lineage-b')
  })

  it('promotes a forked lineage when its stream still owns the selected lineage', () => {
    let state = chatReducer(undefined, chatSliceActions.lineageSelected({
      conversationId: 'conversation-a',
      lineageId: lineage('lineage-b'),
      path: ['root', 'branch-b'],
      focus: 'branch-b',
    }))

    state = chatReducer(state, chatSliceActions.sendingStarted({
      streamId: 'stream-b-fork',
      streamType: 'branch',
      conversationId: 'conversation-a',
      lineage: { lineageId: lineage('lineage-b'), rootMessageId: 'branch-b' },
    }))
    state = chatReducer(state, chatSliceActions.streamLineageUpdated({
      streamId: 'stream-b-fork',
      lineageId: lineage('lineage-b-child'),
    }))

    expect(state.conversation.currentLineageId).toBe('lineage-b-child')
  })
})


describe('pane-parameterized selectors', () => {
  it('selects sibling display paths and exact lineage streams independently', () => {
    const root = chatReducer(undefined, { type: 'test' })
    const messages = [
      { id: 'root', parent_id: null },
      { id: 'branch-a', parent_id: 'root' },
      { id: 'branch-b', parent_id: 'root' },
    ].map(({ id, parent_id }) => ({
      conversation_id: 'conversation-a',
      role: 'user' as const,
      content: id,
      content_plain_text: id,
      children_ids: [],
      created_at: '2024-01-01T00:00:00.000Z',
      model_name: 'test',
      partial: false,
      pastedContext: [],
      artifacts: [],
      id,
      parent_id,
    }))
    const streamA = {
      ...createEmptyStreamState('branch', { lineageId: lineage('lineage-a') }),
      active: true,
      conversationId: 'conversation-a',
    }
    const streamB = {
      ...createEmptyStreamState('branch', { lineageId: lineage('lineage-b') }),
      active: true,
      conversationId: 'conversation-a',
    }
    const streaming = {
      ...root.streaming,
      activeIds: ['stream-a', 'stream-b'],
      byId: { 'stream-a': streamA, 'stream-b': streamB },
      primaryStreamId: 'stream-a',
    }

    expect(selectDisplayMessagesFor(messages, ['root', 'branch-a']).map(message => message.id)).toEqual(['root', 'branch-a'])
    expect(selectDisplayMessagesFor(messages, ['root', 'branch-b']).map(message => message.id)).toEqual(['root', 'branch-b'])
    expect(selectCurrentViewStreamFor(streaming, {
      conversationId: 'conversation-a',
      lineageId: 'lineage-a',
      path: ['root', 'branch-a'],
    })?.id).toBe('stream-a')
    expect(selectCurrentViewStreamFor(streaming, {
      conversationId: 'conversation-a',
      lineageId: 'lineage-b',
      path: ['root', 'branch-b'],
    })?.id).toBe('stream-b')
  })
})
