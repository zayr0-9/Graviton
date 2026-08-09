import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
  })
})

import { buildChatErrorEnvelope } from '../../../../../shared/chatErrors'
import { readServerLoopRejection } from './chatActions'
import type { RootState } from '../../store/store'
import { selectChatErrorsForConversation, selectChatErrorsForParentMessage } from './chatSelectors'
import chatReducer, { chatSliceActions } from './chatSlice'
import type { ChatErrorRecord } from './chatTypes'

type ChatState = ReturnType<typeof chatReducer>

const asRoot = (chat: ChatState) => ({ chat }) as RootState

const record = (overrides: Partial<ChatErrorRecord> = {}): ChatErrorRecord => ({
  id: 'e1',
  conversationId: 'c1',
  envelope: buildChatErrorEnvelope('local_server_unreachable'),
  parentMessageId: 'm1',
  streamId: 's1',
  lineageId: null,
  createdAt: 1,
  dismissed: false,
  ...overrides,
})

const startedStream = (streamId: string): ChatState =>
  chatReducer(undefined, chatSliceActions.sendingStarted({ streamId, conversationId: 'c1' }))

describe('errorNotices state', () => {
  it('starts empty', () => {
    const state = chatReducer(undefined, { type: '@@init' })
    expect(state.errorNotices).toEqual({ byConversationId: {} })
  })

  it('appends a record and exposes it through the conversation selector', () => {
    const state = chatReducer(undefined, chatSliceActions.chatErrorRecorded(record()))
    expect(selectChatErrorsForConversation(asRoot(state), 'c1')).toHaveLength(1)
    expect(selectChatErrorsForConversation(asRoot(state), 'other')).toHaveLength(0)
  })

  it('dedupes on (conversationId, streamId, envelope.code) so a resubscribe storm cannot stack bubbles', () => {
    let state = chatReducer(undefined, chatSliceActions.chatErrorRecorded(record()))
    for (let i = 0; i < 9; i++) {
      state = chatReducer(state, chatSliceActions.chatErrorRecorded(record({ id: `e${i + 2}`, createdAt: i + 2 })))
    }
    expect(state.errorNotices.byConversationId.c1).toHaveLength(1)
    expect(state.errorNotices.byConversationId.c1[0].id).toBe('e1')
  })

  it('keeps a different code, a different stream, and a different conversation apart', () => {
    let state = chatReducer(undefined, chatSliceActions.chatErrorRecorded(record()))
    state = chatReducer(
      state,
      chatSliceActions.chatErrorRecorded(record({ id: 'e2', envelope: buildChatErrorEnvelope('rate_limited') }))
    )
    state = chatReducer(state, chatSliceActions.chatErrorRecorded(record({ id: 'e3', streamId: 's2' })))
    state = chatReducer(state, chatSliceActions.chatErrorRecorded(record({ id: 'e4', conversationId: 'c2' })))

    expect(state.errorNotices.byConversationId.c1).toHaveLength(3)
    expect(state.errorNotices.byConversationId.c2).toHaveLength(1)
  })

  it('does not collapse two pre-stream failures that hit different parents', () => {
    let state = chatReducer(undefined, chatSliceActions.chatErrorRecorded(record({ streamId: null })))
    state = chatReducer(
      state,
      chatSliceActions.chatErrorRecorded(record({ id: 'e2', streamId: null, parentMessageId: 'm2' }))
    )
    state = chatReducer(
      state,
      chatSliceActions.chatErrorRecorded(record({ id: 'e3', streamId: null, parentMessageId: 'm2' }))
    )
    expect(state.errorNotices.byConversationId.c1.map(r => r.id)).toEqual(['e1', 'e2'])
  })

  it('dismisses without deleting, and a re-delivery cannot resurrect the bubble', () => {
    let state = chatReducer(undefined, chatSliceActions.chatErrorRecorded(record()))
    state = chatReducer(state, chatSliceActions.chatErrorDismissed({ conversationId: 'c1', id: 'e1' }))

    expect(state.errorNotices.byConversationId.c1[0].dismissed).toBe(true)
    expect(selectChatErrorsForConversation(asRoot(state), 'c1')).toHaveLength(0)

    state = chatReducer(state, chatSliceActions.chatErrorRecorded(record({ id: 'e2' })))
    expect(selectChatErrorsForConversation(asRoot(state), 'c1')).toHaveLength(0)
  })

  it('clears only the errors anchored to a parent a later send succeeded on', () => {
    let state = chatReducer(undefined, chatSliceActions.chatErrorRecorded(record()))
    state = chatReducer(
      state,
      chatSliceActions.chatErrorRecorded(record({ id: 'e2', streamId: 's2', parentMessageId: 'm2' }))
    )
    state = chatReducer(state, chatSliceActions.chatErrorsClearedForParent({ conversationId: 'c1', parentMessageId: 'm1' }))

    expect(state.errorNotices.byConversationId.c1.map(r => r.id)).toEqual(['e2'])
  })

  // REGRESSION: a failure that happened before anything was persisted (server down, an
  // unauthenticated provider, a conversation's first turn) has no parent to anchor to.
  // These used to be explicitly RETAINED, so nothing could ever clear them: the user
  // signed in, the next message streamed perfectly, and the stale "Try again" bubble was
  // still on screen.
  it('clears unanchored errors when a later send to a real parent succeeds', () => {
    let state = chatReducer(undefined, chatSliceActions.chatErrorRecorded(record({ parentMessageId: null })))
    state = chatReducer(
      state,
      chatSliceActions.chatErrorsClearedForParent({ conversationId: 'c1', parentMessageId: 'm7' })
    )
    expect(selectChatErrorsForConversation(asRoot(state), 'c1')).toHaveLength(0)
  })

  it('clears unanchored errors when the successful send has no parent either (root turn)', () => {
    let state = chatReducer(undefined, chatSliceActions.chatErrorRecorded(record({ parentMessageId: null })))
    state = chatReducer(
      state,
      chatSliceActions.chatErrorsClearedForParent({ conversationId: 'c1', parentMessageId: null })
    )
    expect(selectChatErrorsForConversation(asRoot(state), 'c1')).toHaveLength(0)
  })

  it('a root-turn success leaves errors anchored to other parents alone', () => {
    let state = chatReducer(undefined, chatSliceActions.chatErrorRecorded(record({ parentMessageId: 'm2' })))
    state = chatReducer(
      state,
      chatSliceActions.chatErrorsClearedForParent({ conversationId: 'c1', parentMessageId: null })
    )
    expect(state.errorNotices.byConversationId.c1.map(r => r.id)).toEqual(['e1'])
  })

  // REGRESSION: the three server-loop thunks classify and surface their own failures,
  // then reject. Rejecting with a bare humanised string meant a `.unwrap()` catch re-ran
  // that prose through `classifyLocalChatError`, matched nothing, fell back to
  // `internal_error`, and drew a SECOND generic "Try again" bubble beside the real,
  // specific one. `surfaced` is the signal that stops it.
  it('a server-loop rejection is recognisable so a catch does not double-surface it', () => {
    const envelope = buildChatErrorEnvelope('provider_signin_required')
    const parsed = readServerLoopRejection({
      message: envelope.userMessage,
      envelope,
      surfaced: true,
      aborted: false,
    })
    expect(parsed?.surfaced).toBe(true)
    expect(parsed?.envelope?.code).toBe('provider_signin_required')
  })

  it('a plain string or Error is NOT a server-loop rejection (renderer-local failures still record)', () => {
    expect(readServerLoopRejection('I could not reach the model provider.')).toBeNull()
    expect(readServerLoopRejection(new Error('boom'))).toBeNull()
    expect(readServerLoopRejection(null)).toBeNull()
  })

  it('clears a whole conversation', () => {
    let state = chatReducer(undefined, chatSliceActions.chatErrorRecorded(record()))
    state = chatReducer(state, chatSliceActions.chatErrorRecorded(record({ id: 'e2', conversationId: 'c2' })))
    state = chatReducer(state, chatSliceActions.chatErrorsClearedForConversation('c1'))

    expect(state.errorNotices.byConversationId.c1).toBeUndefined()
    expect(state.errorNotices.byConversationId.c2).toHaveLength(1)
  })

  it('anchors errors to a parent message for the message-list row', () => {
    let state = chatReducer(undefined, chatSliceActions.chatErrorRecorded(record()))
    state = chatReducer(
      state,
      chatSliceActions.chatErrorRecorded(record({ id: 'e2', streamId: 's2', parentMessageId: 'm2' }))
    )
    state = chatReducer(
      state,
      chatSliceActions.chatErrorRecorded(record({ id: 'e3', streamId: 's3', parentMessageId: null }))
    )

    expect(selectChatErrorsForParentMessage(asRoot(state), 'c1', 'm1').map(r => r.id)).toEqual(['e1'])
    expect(selectChatErrorsForParentMessage(asRoot(state), 'c1', 'm2').map(r => r.id)).toEqual(['e2'])
    // A record that predates any lineage belongs to the conversation surface, not a row.
    expect(selectChatErrorsForParentMessage(asRoot(state), 'c1', null)).toHaveLength(0)
    expect(selectChatErrorsForConversation(asRoot(state), 'c1')).toHaveLength(3)
  })

  it('survives streamPruned — the entire reason it does not live in streaming.byId', () => {
    let state = startedStream('s1')
    state = chatReducer(state, chatSliceActions.chatErrorRecorded(record()))
    state = chatReducer(state, chatSliceActions.sendingCompleted({ streamId: 's1' }))
    state = chatReducer(state, chatSliceActions.streamPruned({ streamId: 's1' }))

    expect(state.streaming.byId.s1).toBeUndefined()
    expect(selectChatErrorsForConversation(asRoot(state), 'c1')).toHaveLength(1)
  })
})

describe('user abort is not an error condition', () => {
  it('leaves no error on the slot after a clean Stop', () => {
    let state = startedStream('s1')
    state = chatReducer(state, chatSliceActions.streamingAborted({ streamId: 's1' }))
    expect(state.streaming.byId.s1.error).toBeNull()

    state = chatReducer(state, chatSliceActions.sendingCompleted({ streamId: 's1' }))
    expect(state.streaming.byId.s1).toMatchObject({ status: 'completed', finished: true, error: null })
  })

  it('leaves no error on any slot after Stop all', () => {
    let state = startedStream('s1')
    state = chatReducer(state, chatSliceActions.allStreamsAborted())
    expect(state.streaming.byId.s1.error).toBeNull()
  })

  it('still honours an explicitly supplied abort reason', () => {
    let state = startedStream('s1')
    state = chatReducer(state, chatSliceActions.streamingAborted({ streamId: 's1', error: 'Run vanished' }))
    expect(state.streaming.byId.s1.error).toBe('Run vanished')
  })

  it('does not clear a genuine failure that already put the slot in status=error', () => {
    let state = startedStream('s1')
    state = chatReducer(
      state,
      chatSliceActions.streamChunkReceived({ streamId: 's1', chunk: { type: 'error', error: 'boom' } })
    )
    expect(state.streaming.byId.s1.status).toBe('error')

    state = chatReducer(state, chatSliceActions.sendingCompleted({ streamId: 's1' }))
    expect(state.streaming.byId.s1.error).not.toBeNull()
  })
})

describe('error and notice stream events', () => {
  it('logs an error event in order and never puts raw text in front of the user', () => {
    let state = startedStream('s1')
    state = chatReducer(
      state,
      chatSliceActions.streamChunkReceived({ streamId: 's1', chunk: { type: 'chunk', delta: 'partial answer' } })
    )
    state = chatReducer(
      state,
      chatSliceActions.streamChunkReceived({
        streamId: 's1',
        chunk: {
          type: 'error',
          error: 'Provider turn 7/400 exploded at lineage 9f2c',
          errorEnvelope: buildChatErrorEnvelope('provider_unavailable', {
            detail: 'Provider turn 7/400 exploded at lineage 9f2c',
          }),
        },
      })
    )

    const events = state.streaming.byId.s1.events
    expect(events.map(e => e.type)).toEqual(['text', 'error'])
    const envelope = events[1].errorEnvelope!
    expect(envelope.code).toBe('provider_unavailable')
    expect(envelope.userMessage).not.toContain('Provider turn')
    expect(envelope.detail).toContain('Provider turn 7/400')
    expect(state.streaming.byId.s1).toMatchObject({ status: 'error', active: false })
    // The partial text stays; the error is a separate event, it never overwrites it.
    expect(state.streaming.byId.s1.buffer).toBe('partial answer')
  })

  it('builds a complete envelope even when the server sends no envelope at all', () => {
    let state = startedStream('s1')
    state = chatReducer(
      state,
      chatSliceActions.streamChunkReceived({ streamId: 's1', chunk: { type: 'error', error: 'raw 500' } })
    )
    const envelope = state.streaming.byId.s1.events[0].errorEnvelope!
    expect(envelope.code).toBe('internal_error')
    expect(envelope.userMessage.length).toBeGreaterThan(0)
    expect(envelope.detail).toBe('raw 500')
    expect(state.streaming.byId.s1.error).toBe(envelope.userMessage)
  })

  it('keeps the exemption that lets an error chunk through after active goes false', () => {
    let state = startedStream('s1')
    // The send thunks dispatch sendingCompleted BEFORE the error chunk on a client failure.
    state = chatReducer(state, chatSliceActions.sendingCompleted({ streamId: 's1' }))
    state = chatReducer(
      state,
      chatSliceActions.streamChunkReceived({
        streamId: 's1',
        chunk: { type: 'error', errorEnvelope: buildChatErrorEnvelope('local_server_unreachable') },
      })
    )

    expect(state.streaming.byId.s1.events.map(e => e.type)).toEqual(['error'])
    expect(state.streaming.byId.s1.status).toBe('error')
  })

  it('does not tear the stream down for a non-terminal error', () => {
    let state = startedStream('s1')
    state = chatReducer(
      state,
      chatSliceActions.streamChunkReceived({
        streamId: 's1',
        chunk: { type: 'error', terminal: false, errorEnvelope: buildChatErrorEnvelope('tool_failed') },
      })
    )

    expect(state.streaming.byId.s1.events.map(e => e.type)).toEqual(['error'])
    expect(state.streaming.byId.s1).toMatchObject({ active: true, error: null })
    expect(state.streaming.activeIds).toEqual(['s1'])
  })

  it('records a notice in order without ending the run, and coalesces repeats', () => {
    let state = startedStream('s1')
    state = chatReducer(
      state,
      chatSliceActions.streamChunkReceived({
        streamId: 's1',
        chunk: { type: 'notice', code: 'reconnecting', message: 'Reconnecting…', attempt: 1, maxAttempts: 3 },
      })
    )
    state = chatReducer(
      state,
      chatSliceActions.streamChunkReceived({
        streamId: 's1',
        chunk: { type: 'notice', code: 'reconnecting', message: 'Reconnecting…', attempt: 2, maxAttempts: 3 },
      })
    )

    const events = state.streaming.byId.s1.events
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'notice', noticeCode: 'reconnecting', attempt: 2, maxAttempts: 3 })
    expect(state.streaming.byId.s1).toMatchObject({ active: true, status: 'active', error: null })
  })
})
