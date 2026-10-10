import { configureStore } from '@reduxjs/toolkit'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true,
    value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } })
})

import chatReducer, { chatSliceActions as chat } from './chatSlice'
import { projectServerEvent, type ServerStreamEvent } from './sseProjection'
import { createEmptyStreamState, isStreamMessageAlreadyRendered } from './streamHelpers'

const setup = () => {
  const store = configureStore({ reducer: { chat: chatReducer } })
  const streamId = 'visibility-test'
  const conversationId = 'conversation'
  store.dispatch(chat.sendingStarted({ streamId, conversationId }))
  const emit = (event: ServerStreamEvent) => {
    for (const action of projectServerEvent(event, { streamId, conversationId })) store.dispatch(action)
  }
  const stream = () => store.getState().chat.streaming.byId[streamId]
  return { store, streamId, emit, stream }
}

const assistant = (id: string, tool = false) => ({
  id, role: 'assistant', conversation_id: 'conversation', content: tool ? '' : 'Answer',
  parent_id: null, children_ids: [], created_at: '2026-10-09',
  content_blocks: tool ? [{ type: 'tool_use', index: 0, id: 'call', name: 'read_file', input: {} }] : [],
})

describe('live transcript duplicate suppression', () => {
  it('shows post-tool text before persistence while retaining the previous branch anchor', () => {
    const { emit, stream } = setup()
    const rendered = new Set<string>()
    emit({ type: 'tool_loop', status: 'turn_started', turn: 1 } as ServerStreamEvent)
    emit({ type: 'chunk', part: 'tool_call', toolCall: { id: 'call', name: 'read_file', arguments: {} } })
    expect(isStreamMessageAlreadyRendered(stream(), rendered)).toBe(false)
    emit({ type: 'assistant_message_persisted', message: assistant('a', true) })
    rendered.add('a')
    expect(stream().status).toBe('waiting_for_tool')
    expect(isStreamMessageAlreadyRendered(stream(), rendered)).toBe(true)
    emit({ type: 'chunk', part: 'tool_result', toolResult: { tool_use_id: 'call', content: 'file text' } })
    expect(isStreamMessageAlreadyRendered(stream(), rendered)).toBe(true)

    emit({ type: 'tool_loop', status: 'turn_started', turn: 2 } as ServerStreamEvent)
    expect(stream()).toMatchObject({ liveMessageId: null, streamingMessageId: null,
      lastCompletedMessageId: 'a', messageId: 'a', persistedTurnMessageId: null })
    emit({ type: 'chunk', part: 'reasoning', delta: 'Thinking after tools' })
    expect(isStreamMessageAlreadyRendered(stream(), rendered)).toBe(false)
    for (const delta of ['A partial answer', ' that keeps streaming']) {
      emit({ type: 'chunk', part: 'text', delta })
      expect(stream().buffer).toContain(delta)
      expect(isStreamMessageAlreadyRendered(stream(), rendered)).toBe(false)
    }
    emit({ type: 'assistant_message_persisted', message: assistant('b') })
    // Until the row is actually rendered, keep the live response visible.
    expect(isStreamMessageAlreadyRendered(stream(), rendered)).toBe(false)
    rendered.add('b')
    expect(stream().status).toBe('active')
    expect(isStreamMessageAlreadyRendered(stream(), rendered)).toBe(true)
  })

  it('clears persisted-turn ownership on reset and on a subsequent generation', () => {
    const { store, streamId, emit, stream } = setup()
    emit({ type: 'assistant_message_persisted', message: assistant('a') })
    store.dispatch(chat.streamChunkReceived({ streamId, chunk: { type: 'reset' } }))
    expect(stream().persistedTurnMessageId).toBeNull()
    emit({ type: 'assistant_message_persisted', message: assistant('b') })
    store.dispatch(chat.streamChunkReceived({ streamId, chunk: { type: 'generation_started', messageId: 'c' } }))
    expect(stream().persistedTurnMessageId).toBeNull()
    expect(isStreamMessageAlreadyRendered(stream(), new Set(['b']))).toBe(false)
    expect(isStreamMessageAlreadyRendered(stream(), new Set(['c']))).toBe(true)
  })

  it('suppresses a terminal persisted answer without a per-turn persistence frame', () => {
    const { emit, stream } = setup()
    emit({ type: 'chunk', part: 'text', delta: 'Answer' })
    emit({ type: 'complete', message: assistant('a') } as ServerStreamEvent)
    expect(stream().persistedTurnMessageId).toBe('a')
    expect(isStreamMessageAlreadyRendered(stream(), new Set(['a']))).toBe(true)
  })

  it('supports legacy live IDs without treating completed branch anchors as live rows', () => {
    const stream = createEmptyStreamState()
    stream.lastCompletedMessageId = 'previous'
    stream.messageId = 'previous'
    expect(isStreamMessageAlreadyRendered(stream, new Set(['previous']))).toBe(false)
    stream.streamingMessageId = 'live'
    expect(isStreamMessageAlreadyRendered(stream, new Set(['live']))).toBe(true)
  })
})
