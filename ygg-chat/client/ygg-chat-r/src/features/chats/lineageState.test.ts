import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
  })
})

import type { RootState } from '../../store/store'
import { selectCurrentLineageId, selectCurrentViewStream } from './chatSelectors'
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
