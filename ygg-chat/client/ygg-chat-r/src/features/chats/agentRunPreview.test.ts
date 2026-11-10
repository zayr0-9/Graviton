import { configureStore } from '@reduxjs/toolkit'
import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true,
    value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } })
})
import chatReducer, { chatSliceActions as chat } from './chatSlice'
import previewReducer, { agentRunPreviewActions as preview, agentRunPreviewMiddleware, MAX_FINISHED_AGENT_FORKS } from './agentRunPreviewSlice'
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

  it('folds Claude per-block re-persistence of one API message into a single entry', () => {
    const store = setup()
    start(store, 'a')
    const persisted = (id: string, content: string, blocks: any[]) =>
      store.dispatch(chat.streamChunkReceived({ streamId: 'a', chunk: { type: 'complete',
        message: { ...message(id, 'assistant', content), content_blocks: blocks } } }))
    const thinking = { type: 'thinking', index: 0, content: 'plan' }
    const answer = { type: 'text', index: 1, content: 'answer' }
    const call = { type: 'tool_use', index: 2, id: 'tool', name: 'Bash', input: {} }
    store.dispatch(chat.streamChunkReceived({ streamId: 'a', chunk: { type: 'generation_started' } }))
    store.dispatch(chat.streamChunkReceived({ streamId: 'a', chunk: { type: 'chunk', part: 'reasoning', delta: 'plan' } }))
    persisted('r', '', [thinking])
    // Mid-message boundary before the text block of the same API message.
    store.dispatch(chat.streamChunkReceived({ streamId: 'a', chunk: { type: 'generation_started' } }))
    text(store, 'a', 'answer')
    persisted('r', 'answer', [thinking, answer])
    persisted('r', 'answer', [thinking, answer, call])
    store.dispatch(chat.streamChunkReceived({ streamId: 'a', chunk: { type: 'chunk', part: 'tool_call',
      toolCall: { id: 'tool', name: 'Bash', arguments: {} } } }))
    store.dispatch(chat.streamChunkReceived({ streamId: 'a', chunk: { type: 'chunk', part: 'tool_result',
      toolResult: { tool_use_id: 'tool', content: 'ok', is_error: false } } }))
    // Next API message.
    store.dispatch(chat.streamChunkReceived({ streamId: 'a', chunk: { type: 'generation_started' } }))
    text(store, 'a', 'final')
    persisted('r2', 'final', [{ type: 'text', index: 0, content: 'final' }])
    const run = store.getState().agentRunPreviews.byStreamId.a
    expect(run.entries.map(entry => entry.message?.id)).toEqual(['r', 'r2'])
    const blocks = buildAgentPreviewRows(run).flatMap(row => row.blocks)
    expect(blocks.filter(block => block.type === 'text').map(block => block.content)).toEqual(['answer', 'final'])
    expect(blocks.filter(block => block.type === 'tool_use')).toHaveLength(1)
    expect(blocks.find(block => block.type === 'tool_result')).toMatchObject({ content: 'ok' })
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

  describe('finished fork cap', () => {
    const runForks = (store: ReturnType<typeof setup>, count: number, finish: (index: number) => boolean) => {
      for (let index = 0; index < count; index++) {
        vi.setSystemTime(Date.UTC(2026, 10, 1, 0, 0, index))
        start(store, `s${index}`, `fork-${index}`)
        text(store, `s${index}`, `out ${index}`)
        if (finish(index)) store.dispatch(chat.sendingCompleted({ streamId: `s${index}` }))
      }
    }
    const retained = (store: ReturnType<typeof setup>) => Object.keys(store.getState().agentRunPreviews.byStreamId).sort()

    it(`keeps only the newest ${MAX_FINISHED_AGENT_FORKS} finished forks and releases older transcripts`, () => {
      vi.useFakeTimers()
      try {
        const store = setup()
        runForks(store, 7, () => true)
        expect(retained(store)).toEqual(['s2', 's3', 's4', 's5', 's6'])
        expect(Object.values(store.getState().agentRunPreviews.latestByFork).sort()).toEqual(['s2', 's3', 's4', 's5', 's6'])
        // Late events for an evicted run must not recreate it without a fresh start.
        store.dispatch(chat.sendingCompleted({ streamId: 's0' }))
        text(store, 's1', 'late')
        expect(retained(store)).toEqual(['s2', 's3', 's4', 's5', 's6'])
      } finally { vi.useRealTimers() }
    })

    it('never evicts a fork that still has an active run, and does not count it toward the cap', () => {
      vi.useFakeTimers()
      try {
        const store = setup()
        // s0 is the oldest but still running; s1..s6 finish.
        runForks(store, 7, index => index !== 0)
        expect(retained(store)).toEqual(['s0', 's2', 's3', 's4', 's5', 's6'])
        // Once s0 finishes it is the oldest finished fork and is released.
        store.dispatch(chat.sendingCompleted({ streamId: 's0' }))
        expect(retained(store)).toEqual(['s2', 's3', 's4', 's5', 's6'])
      } finally { vi.useRealTimers() }
    })

    it('keeps completed runs of the same fork together with the fork', () => {
      vi.useFakeTimers()
      try {
        const store = setup()
        runForks(store, 5, () => true)
        vi.setSystemTime(Date.UTC(2026, 10, 2))
        start(store, 'new-run', 'fork-0')
        store.dispatch(chat.sendingCompleted({ streamId: 'new-run' }))
        // Still five forks: a second run on fork-0 evicts nothing.
        expect(retained(store)).toEqual(['new-run', 's0', 's1', 's2', 's3', 's4'])
        vi.setSystemTime(Date.UTC(2026, 10, 3))
        start(store, 's9', 'fork-9')
        store.dispatch(chat.sendingCompleted({ streamId: 's9' }))
        // fork-0 is ordered by its newest run, so its older s0 survives; fork-1 is released.
        expect(retained(store)).toEqual(['new-run', 's0', 's2', 's3', 's4', 's9'])
      } finally { vi.useRealTimers() }
    })
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
