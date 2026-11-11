import { describe, expect, it, vi } from 'vitest'
import { ClaudeSessionService } from '../claudeSessionService.js'
import { DecisionBroker } from '../decisionBroker.js'
import { extractContextUsageFromBlocks } from '../../../../../../shared/contextUsage.js'

// The same minimal SDK/persistence doubles as claudeSessionService.test.ts.
function fixture(events: any[]) {
  const rows: any[] = []
  const state: any = {}
  const sessions = {
    branch: vi.fn(() => state.branch), checkpoint: vi.fn(() => state.checkpoint), reserve: vi.fn(),
    session: vi.fn((_lineage, session_id, status) => { state.branch = { session_id, state: status } }), record: vi.fn(),
  }
  const sdk = { query: vi.fn(() => Object.assign((async function* () { for (const event of events) yield event })(), { close: vi.fn() })),
    forkSession: vi.fn(async () => ({ sessionId: 'fork' })), getSessionMessages: vi.fn(async () => []) }
  const sink = { persistAssistantMessage: vi.fn(draft => { const row = { ...draft, id: `row${rows.length}` }; rows.push(row); return row }),
    updateAssistantToolState: vi.fn((id, update) => ({ ...rows.find(row => row.id === id), ...update })) }
  const broker = new DecisionBroker()
  broker.initSession('stream', { autoApproveAll: false })
  const emit = vi.fn()
  const input: any = { request: { conversationId: 'c', provider: 'Claude Code', modelName: 'claude-sonnet-5-5', content: 'hello', streamId: 'stream', operationMode: 'execute' },
    lineageId: 'l', userMessage: { id: 'u' }, parentId: 'u', sourceMessageId: null, fork: false, cwd: '/workspace', sink, emit }
  const service = new ClaudeSessionService({ sessions: sessions as any, broker, executable: async () => '/mock/claude', sdk: async () => sdk as any,
    messages: { get: vi.fn(() => null), updateClaudeProjection: vi.fn((id, content, contentBlocks, meta) => ({ id, content, content_blocks: contentBlocks, meta })) } as any })
  return { service, input, emit }
}

const frame = (event: any, parent: string | null = null) => ({ type: 'stream_event', session_id: 's', parent_tool_use_id: parent, event })
const assistant = (id: string, usage: any, parent: string | null = null) => ({ type: 'assistant', uuid: `uuid-${id}`, session_id: 's', parent_tool_use_id: parent,
  message: { id, model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'answer' }], usage } })
const result = (extra: any = {}) => ({ type: 'result', subtype: 'success', is_error: false, session_id: 's', ...extra })
const modelUsage = {
  'claude-sonnet-5-5': { inputTokens: 30, outputTokens: 400, cacheReadInputTokens: 5000, cacheCreationInputTokens: 900, costUSD: 0.5, contextWindow: 1_000_000, maxOutputTokens: 64_000, webSearchRequests: 0 },
  'claude-haiku-5-5': { inputTokens: 10, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 200, costUSD: 0.1, contextWindow: 200_000, maxOutputTokens: 32_000, webSearchRequests: 0 },
}
const usageBlock = (row: any) => row.content_blocks.find((block: any) => block.type === 'context_usage')

describe('Claude run context usage', () => {
  it('stores the last main-agent call, the reported window and session totals on the final row', async () => {
    const f = fixture([
      frame({ type: 'message_start', message: { id: 'msg', model: 'claude-sonnet-5-5',
        usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 1 } } }),
      frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } }),
      // Envelopes repeat the call's usage, with output as counted when the block finished.
      assistant('msg', { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 5 }),
      result({ modelUsage, total_cost_usd: 0.6 }),
    ])
    const final = await f.service.run(f.input)
    expect(usageBlock(final).usage).toMatchObject({
      provider: 'claude', model: 'claude-sonnet-5-5', responseId: 'msg',
      inputTokens: 1000, cachedInputTokens: 900, cacheCreationInputTokens: 90, outputTokens: 40, usedTokens: 1040,
      contextWindow: 1_000_000,
      session: { costUsd: 0.6, inputTokens: 40, outputTokens: 500, cacheReadInputTokens: 5000, cacheCreationInputTokens: 1100 },
    })
    expect(f.emit).toHaveBeenCalledWith({ type: 'context_usage', usage: usageBlock(final).usage })
    // Readers (meter, analytics) get the same snapshot back from the persisted blocks.
    expect(extractContextUsageFromBlocks(final.content_blocks)).toEqual(usageBlock(final).usage)
  })

  it('ignores child-agent calls, which use their own context', async () => {
    const f = fixture([
      assistant('main', { input_tokens: 5, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, output_tokens: 20 }),
      frame({ type: 'message_start', message: { id: 'child', model: 'claude-haiku-5-5', usage: { input_tokens: 99_999, output_tokens: 1 } } }, 'tool'),
      assistant('child', { input_tokens: 99_999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 7 }, 'tool'),
      result({ modelUsage }),
    ])
    const final = await f.service.run(f.input)
    expect(usageBlock(final).usage).toMatchObject({ responseId: 'main', usedTokens: 2025, contextWindow: 1_000_000 })
  })

  it('stores nothing when Claude reported no usage', async () => {
    const f = fixture([assistant('msg', undefined), result()])
    const final = await f.service.run(f.input)
    expect(usageBlock(final)).toBeUndefined()
    expect(f.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'context_usage' }))
  })
})
