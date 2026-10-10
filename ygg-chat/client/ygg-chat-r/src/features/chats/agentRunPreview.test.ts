import { configureStore } from '@reduxjs/toolkit'
import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true,
    value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } })
})
import chatReducer, { chatSliceActions as chat } from './chatSlice'
import previewReducer, { agentRunPreviewActions as preview, agentRunPreviewMiddleware } from './agentRunPreviewSlice'
import { buildAgentPreviewRows } from '../../components/RunningAgentsFloatingButton/agentPreviewContent'
import { buildForkPreviewRows, selectForkPreviewRuns } from '../../components/RunningAgentsFloatingButton/agentForkPreview'
import type { Message } from './chatTypes'
import { buildChatErrorEnvelope } from '../../../../../shared/chatErrors'

const setup = () => configureStore({
  reducer: { chat: chatReducer, agentRunPreviews: previewReducer, conversations: () => ({ items: [] }) },
  middleware: getDefault => getDefault().prepend(agentRunPreviewMiddleware),
})
const message = (id: string, role: Message['role'], content: string): Message => ({
  id, role, content, conversation_id: 'background', children_ids: [], parent_id: null,
  created_at: '2026-10-01', model_name: 'test', partial: false, content_plain_text: content,
  artifacts: [], pastedContext: [],
})
const start = (store: ReturnType<typeof setup>, streamId: string, fork = 'fork') => {
  store.dispatch(chat.sendingStarted({ streamId, conversationId: 'background' }))
  store.dispatch(chat.streamLineageUpdated({ streamId, lineageId: fork }))
}
const text = (store: ReturnType<typeof setup>, streamId: string, delta: string) =>
  store.dispatch(chat.streamChunkReceived({ streamId, chunk: { type: 'chunk', part: 'text', delta } }))

describe('agent run previews', () => {
  it.each(['read_file', 'bash', 'multi_call'])(
    'keeps failed %s results without duplicate tool-failed bubbles in live and retained previews', toolName => {
      const store = setup()
      start(store, 'a')
      store.dispatch(chat.streamChunkReceived({ streamId: 'a', chunk: { type: 'chunk', part: 'tool_call',
        toolCall: { id: 'tool', name: toolName, arguments: {} } } }))
      const envelope = buildChatErrorEnvelope('tool_failed', {
        userMessage: `The ${toolName} tool failed.`, detail: 'Permission denied.',
      })
      store.dispatch(chat.streamChunkReceived({ streamId: 'a', chunk: { type: 'error', terminal: false,
        errorEnvelope: envelope } }))
      const failedResult = { type: 'tool_result' as const, index: 1,
        tool_use_id: 'tool', content: 'Permission denied.', is_error: true }
      store.dispatch(chat.streamChunkReceived({ streamId: 'a', chunk: { type: 'chunk', part: 'tool_result',
        toolResult: failedResult } }))
      const liveRun = store.getState().agentRunPreviews.byStreamId.a
      expect(buildAgentPreviewRows(liveRun)[0].blocks.map(block => block.type)).toEqual(['tool_use', 'tool_result'])
      expect(buildAgentPreviewRows(liveRun)[0].blocks[1]).toMatchObject(failedResult)
      expect(liveRun.entries[0].stream?.events.some(event => event.type === 'error')).toBe(true)

      const providerError = { type: 'error' as const, index: 3,
        envelope: buildChatErrorEnvelope('provider_timeout'), excludeFromContext: true as const }
      const assistant = message('m', 'assistant', '')
      assistant.content_blocks = [
        { type: 'tool_use', index: 0, id: 'tool', name: toolName, input: {} },
        failedResult,
        { type: 'error', index: 2, envelope, excludeFromContext: true },
        providerError,
      ]
      store.dispatch(preview.messageReceived({ streamId: 'a', message: assistant }))
      store.dispatch(chat.sendingCompleted({ streamId: 'a' }))
      store.dispatch(chat.streamPruned({ streamId: 'a' }))
      const run = store.getState().agentRunPreviews.byStreamId.a
      const blocks = buildAgentPreviewRows(run)[0].blocks
      expect(blocks.map(block => block.type)).toEqual(['tool_use', 'tool_result', 'error'])
      expect(blocks[1]).toMatchObject(failedResult)
      expect(blocks[2]).toMatchObject({ envelope: providerError.envelope })
      expect(run.entries[0].message?.content_blocks).toHaveLength(4)
    }
  )

  it('hides Heimdall scaffolding but keeps requests, tools and reasoning; compaction uses a placeholder', () => {
    const store = setup()
    start(store, 'a')
    const context = { ...message('ctx', 'user', '<system-reminder>instructions</system-reminder>'), meta: { kind: 'context_injection' } }
    const mode = { ...message('mode', 'user', '<system-reminder>mode</system-reminder>'), meta: JSON.stringify({ kind: 'operation_mode_change' }) }
    const request = message('u', 'user', 'Actual request')
    const summary = { ...message('summary', 'system', 'Long private summary'), note: '__auto_compaction_summary__' }
    for (const row of [context, mode, request, summary]) store.dispatch(preview.messageReceived({ streamId: 'a', message: row }))
    store.dispatch(chat.streamChunkReceived({ streamId: 'a', chunk: { type: 'chunk', part: 'reasoning', delta: 'thinking' } }))
    const run = store.getState().agentRunPreviews.byStreamId.a
    const rows = buildAgentPreviewRows(run)
    expect(rows.map(row => row.content)).toEqual(['Actual request', 'Conversation summarised. Earlier context is preserved for the model.', ''])
    expect(rows[2].blocks[0]).toMatchObject({ type: 'thinking', content: 'thinking' })
    expect(run.entries).toHaveLength(5) // Canonical retained data is untouched.
  })
  it('keeps live connection-error bubbles visible', () => {
    const store = setup()
    start(store, 'a')
    const envelope = buildChatErrorEnvelope('connection_lost')
    store.dispatch(chat.streamChunkReceived({ streamId: 'a', chunk: { type: 'error', errorEnvelope: envelope } }))
    const blocks = buildAgentPreviewRows(store.getState().agentRunPreviews.byStreamId.a)[0].blocks
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'error', envelope })
  })

  it('ends every retained stream on Stop all', () => {
    const store = setup()
    start(store, 'a', 'one')
    start(store, 'b', 'two')
    store.dispatch(chat.allStreamsAborted())
    store.dispatch(chat.streamPruned({ streamId: 'a' }))
    expect(Object.values(store.getState().agentRunPreviews.byStreamId).every(run => !run.stream.active && run.completedAt)).toBe(true)
  })

  it('lets enriched persisted tool results supersede earlier streamed placeholders', () => {
    const store = setup()
    start(store, 'a')
    store.dispatch(chat.streamChunkReceived({ streamId: 'a', chunk: { type: 'chunk', part: 'tool_result',
      toolResult: { tool_use_id: 'tool', content: 'pending', is_error: false } } }))
    const assistant = message('m', 'assistant', '')
    assistant.content_blocks = [
      { type: 'tool_use', index: 0, id: 'tool', name: 'bash', input: {} },
      { type: 'tool_result', index: 1, tool_use_id: 'tool', content: 'final', is_error: false },
    ]
    store.dispatch(preview.messageReceived({ streamId: 'a', message: assistant }))
    store.dispatch(chat.streamChunkReceived({ streamId: 'a', chunk: { type: 'generation_started' } }))
    text(store, 'a', 'next turn')
    store.dispatch(preview.messageReceived({ streamId: 'a', message: assistant }))
    const blocks = buildAgentPreviewRows(store.getState().agentRunPreviews.byStreamId.a)[0].blocks
    expect(blocks.find(block => block.type === 'tool_result')).toMatchObject({ content: 'final' })
    expect(blocks.find(block => block.type === 'text')).toMatchObject({ content: 'next turn' })
  })

  it('renders responses-only turns beside ordinary blocks without losing text', () => {
    const store = setup()
    start(store, 'a')
    const assistant = message('m', 'assistant', '')
    assistant.content_blocks = [{ type: 'responses_output_items', items: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'provider text' }] },
    ] }] as any
    store.dispatch(preview.messageReceived({ streamId: 'a', message: assistant }))
    store.dispatch(chat.streamChunkReceived({ streamId: 'a', chunk: { type: 'generation_started' } }))
    text(store, 'a', 'ordinary text')
    const blocks = buildAgentPreviewRows(store.getState().agentRunPreviews.byStreamId.a)[0].blocks
    expect(blocks.filter(block => block.type === 'text').map(block => block.content)).toEqual(['provider text', 'ordinary text'])
  })
  it('captures a background run through turn resets and pruning without duplicate text', () => {
    const store = setup()
    store.dispatch(chat.conversationSet('other'))
    start(store, 'a')
    store.dispatch(preview.messageReceived({ streamId: 'a', message: message('u', 'user', 'request') }))
    text(store, 'a', 'first')
    store.dispatch(preview.messageReceived({ streamId: 'a', message: message('m1', 'assistant', 'first') }))
    store.dispatch(chat.streamChunkReceived({ streamId: 'a', chunk: { type: 'generation_started' } }))
    text(store, 'a', 'second')
    store.dispatch(preview.messageReceived({ streamId: 'a', message: message('m2', 'assistant', 'second') }))
    store.dispatch(preview.messageReceived({ streamId: 'a', message: message('m2', 'assistant', 'second') }))
    store.dispatch(chat.sendingCompleted({ streamId: 'a' }))
    store.dispatch(chat.streamPruned({ streamId: 'a' }))
    const run = store.getState().agentRunPreviews.byStreamId.a
    expect(run.entries).toHaveLength(3)
    expect(run.partial).toBe(false)
    expect(buildAgentPreviewRows(run).flatMap(row => row.blocks).filter(block => block.type === 'text').map(block => block.content))
      .toEqual(['request', 'first', 'second'])
    expect(store.getState().chat.conversation.messages).toEqual([])
  })

  it('retains all confirmed fork runs; older concurrent completion cannot take latest ownership', () => {
    const store = setup()
    start(store, 'a')
    start(store, 'z')
    start(store, 'sibling', 'other-fork')
    text(store, 'a', 'old')
    store.dispatch(chat.sendingCompleted({ streamId: 'a' }))
    expect(store.getState().agentRunPreviews.byStreamId.a).toBeDefined()
    expect(store.getState().agentRunPreviews.byStreamId.z).toBeDefined()
    expect(store.getState().agentRunPreviews.byStreamId.sibling).toBeDefined()
    expect(buildAgentPreviewRows(store.getState().agentRunPreviews.byStreamId.a)[0].blocks).toContainEqual(expect.objectContaining({ content: 'old' }))
    expect(Object.values(store.getState().agentRunPreviews.latestByFork)).toContain('z')
    store.dispatch(chat.sendingCompleted({ streamId: 'a' }))
    expect(store.getState().agentRunPreviews.byStreamId.a).toBeDefined()
  })

  it('keeps source-lineage runs separate until confirmation and preserves older payload', () => {
    const store = setup()
    start(store, 'a')
    store.dispatch(chat.sendingCompleted({ streamId: 'a' }))
    store.dispatch(chat.sendingStarted({ streamId: 'z', conversationId: 'background', lineage: { lineageId: 'fork' } }))
    expect(Object.keys(store.getState().agentRunPreviews.byStreamId)).toHaveLength(2)
    store.dispatch(chat.streamLineageUpdated({ streamId: 'z', lineageId: 'fork' }))
    expect(store.getState().agentRunPreviews.byStreamId.a).toBeDefined()
  })

  it('preserves partial output on stop and accepts the post-completion error chunk', () => {
    const store = setup()
    start(store, 'a')
    text(store, 'a', 'partial')
    store.dispatch(chat.streamingAborted({ streamId: 'a' }))
    store.dispatch(chat.sendingCompleted({ streamId: 'a' }))
    store.dispatch(chat.streamChunkReceived({ streamId: 'a', chunk: { type: 'error', error: 'failure' } }))
    const run = store.getState().agentRunPreviews.byStreamId.a
    expect(run.stream.buffer).toBe('partial')
    expect(run.stream.error).toBeTruthy()
    expect(buildAgentPreviewRows(run)[0].blocks.some(block => block.type === 'error')).toBe(true)
    store.dispatch({ type: 'users/clearUser' })
    expect(store.getState().agentRunPreviews.byStreamId).toEqual({})
  })

  it('updates tool results arriving after persistence and keeps text outside process blocks', () => {
    const store = setup()
    start(store, 'a')
    const assistant = message('m', 'assistant', '')
    assistant.content_blocks = [{ type: 'tool_use', index: 0, id: 'tool', name: 'bash', input: {} }]
    store.dispatch(preview.messageReceived({ streamId: 'a', message: assistant }))
    store.dispatch(chat.streamChunkReceived({ streamId: 'a', chunk: { type: 'chunk', part: 'tool_result',
      toolResult: { tool_use_id: 'tool', content: 'done', is_error: false } } }))
    store.dispatch(chat.streamChunkReceived({ streamId: 'a', chunk: { type: 'generation_started' } }))
    text(store, 'a', 'answer')
    const blocks = buildAgentPreviewRows(store.getState().agentRunPreviews.byStreamId.a)[0].blocks
    expect(blocks.map(block => block.type)).toEqual(['tool_use', 'tool_result', 'text'])
    expect(blocks[1]).toMatchObject({ content: 'done' })
  })
})


describe('whole fork retention', () => {
  it('retains successive completed/pruned runs and late enrichment in chronological transcript', () => {
    const store = setup()
    start(store, 'first')
    text(store, 'first', 'First response')
    store.dispatch(chat.sendingCompleted({ streamId: 'first' }))
    store.dispatch(chat.streamPruned({ streamId: 'first' }))
    start(store, 'second')
    text(store, 'second', 'Second response')
    store.dispatch(chat.sendingCompleted({ streamId: 'second' }))
    store.dispatch(chat.streamPruned({ streamId: 'second' }))
    store.dispatch(preview.messageReceived({ streamId: 'first', message: message('first-message', 'assistant', 'Enriched first response') }))
    const runs = selectForkPreviewRuns(store.getState().agentRunPreviews.byStreamId, 'second')
    expect(runs).toHaveLength(2)
    const texts = buildForkPreviewRows(runs).flatMap(row => row.blocks).filter(block => block.type === 'text').map(block => block.content)
    expect(texts).toEqual(['Enriched first response', 'Second response'])
    store.dispatch({ type: 'users/clearUser' })
    expect(store.getState().agentRunPreviews.byStreamId).toEqual({})
  })
})
