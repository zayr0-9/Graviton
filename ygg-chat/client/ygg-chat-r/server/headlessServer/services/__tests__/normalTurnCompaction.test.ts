import { describe, expect, it, vi } from 'vitest'
import { ToolLoopService } from '../toolLoopService.js'
import type { MessageSink } from '../messageSink.js'
import { isCommittedCompaction, contextUsageAfterCompaction, normalizeCompactionThreshold } from '../../../../../../shared/compaction.js'
import { trimHistoryToLatestCompaction } from '../compactionService.js'
import { toCodexMessages } from '../../providers/codex/codexRequestItems.js'
import { toHyperMessages } from '../../providers/hyperRouterAdapter.js'

class Sink implements MessageSink {
  rows: any[] = []
  persistAssistantMessage(draft: any) {
    const row = { id: `a${this.rows.length}`, role: 'assistant', parent_id: draft.parentId,
      content: draft.content, content_blocks: draft.contentBlocks, tool_calls: draft.toolCalls,
      meta: draft.meta, context_usage: draft.contextUsage }
    this.rows.push(row)
    return row
  }
  persistControlMessage(draft: any) {
    const row = { id: `u${this.rows.length}`, role: 'user', parent_id: draft.parentId, content: draft.content, meta: draft.meta }
    this.rows.push(row)
    return row
  }
  updateAssistantToolState(id: string, update: any) {
    const row = this.rows.find(row => row.id === id)
    Object.assign(row, { content_blocks: update.contentBlocks, tool_calls: update.toolCalls })
    return row
  }
  finaliseCompaction(id: string, update: any) {
    const row = this.rows.find(row => row.id === id)
    if (!isCommittedCompaction(row)) Object.assign(row, { content: update.content, content_blocks: update.contentBlocks, meta: update.meta })
    return row
  }
}
const usage = { provider: 'openai', inputTokens: 9000, cachedInputTokens: 8000, outputTokens: 10,
  totalTokens: 9010, usedTokens: 9010, reasoningTokens: 0, recordedAt: '2026-01-01' }
const base = { provider: 'openaichatgpt', modelName: 'test', conversationId: 'c', assistantParentId: 'root',
  history: [{ id: 'root', role: 'user', content: 'Implement the feature' }], userContent: '',
  systemPrompt: 'Unchanged system', contextLength: 10000, maxTurns: 8, streamId: 'same-stream',
  tools: [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object' } }] }
function harness(outputs: any[], overrides: any = {}) {
  const sink = new Sink()
  const calls: any[] = []
  const router = { generate: vi.fn(async (provider: string, input: any) => {
    calls.push({ provider, input: structuredClone({ ...input, signal: undefined }) })
    const output = outputs.shift()
    if (output instanceof Error) throw output
    if (!output) throw new Error('Unexpected provider request')
    return output
  }) }
  const service = new ToolLoopService({ sink, providerRouter: router as any,
    executeTool: async () => 'README contents', ...overrides })
  return { service, sink, calls, router }
}

describe('ordinary persisted compaction turns', () => {
  it('extends the normal prefix, commits assistant context and resumes in the same stream', async () => {
    const h = harness([
      { content: '', toolCalls: [{ id: 't', name: 'read_file', arguments: { path: 'README' } }], contextUsage: usage },
      { content: 'Summary: implement the feature.', contextUsage: usage },
      { content: 'Implemented.' },
    ])
    const events: any[] = []
    const result = await h.service.run(base, event => events.push(event))
    expect(result.finalAssistantMessage.content).toBe('Implemented.')
    expect(h.calls).toHaveLength(3)
    const summaryRequest = h.calls[1].input
    expect(summaryRequest.systemPrompt).toBe(base.systemPrompt)
    expect(summaryRequest.tools).toEqual(base.tools)
    expect(summaryRequest.railwayTurn.conversationId).toBe('c')
    expect(summaryRequest.history[0]).toEqual(base.history[0])
    expect(summaryRequest.history.at(-1).meta.kind).toBe('compaction_instruction')
    expect(summaryRequest.history.some((row: any) => row.content_blocks?.some?.((b: any) => b.type === 'tool_result'))).toBe(true)
    const summary = h.sink.rows.find(isCommittedCompaction)
    expect(summary.role).toBe('assistant')
    expect(summary.content).toContain('README contents')
    expect(h.calls[2].input.history[0].id).toBe(summary.id)
    expect(h.calls[2].input.history.at(-1).meta.kind).toBe('compaction_resume')
    expect(events.filter(event => event.type === 'context_compaction' && event.status === 'completed')).toHaveLength(1)
    expect(events.some(event => event.type === 'complete')).toBe(false)
  })

  it.each(['lmstudio', 'zai', 'bedrock', 'openrouter'])('triggers for %s with the configured percentage', async provider => {
    const h = harness([{ content: 'Short summary' }, { content: 'Done' }])
    await h.service.run({ ...base, provider, compactionThresholdPercent: 40,
      history: [{ id: 'root', role: 'user', content: 'x'.repeat(20000) }] }, () => {})
    expect(h.calls[0].input.history.at(-1).meta.kind).toBe('compaction_instruction')
    expect(h.calls[0].provider).toBe(provider)
    expect(h.sink.rows.filter(isCommittedCompaction)).toHaveLength(1)
  })

  it('manual compaction uses an existing tagged instruction and ends without resume', async () => {
    const h = harness([{ content: 'Summary only' }])
    await h.service.run({ ...base, manualCompaction: true, history: [...base.history,
      { id: 'manual', role: 'user', content: 'Summarise', meta: { kind: 'compaction_instruction' } }] }, () => {})
    expect(h.calls).toHaveLength(1)
    expect(h.sink.rows.filter(row => row.role === 'user')).toHaveLength(0)
    expect(h.sink.rows[0].meta.instructionId).toBe('manual')
  })

  it('executes normal tools while summarising and preserves those results', async () => {
    const h = harness([
      { content: '', toolCalls: [{ id: 'summary-tool', name: 'read_file', arguments: { path: 'during' } }] },
      { content: 'Summary after inspecting' },
    ])
    await h.service.run({ ...base, manualCompaction: true }, () => {})
    expect(h.sink.rows.filter(isCommittedCompaction)).toHaveLength(1)
    expect(h.sink.rows.find(isCommittedCompaction).content).toContain('during')
    expect(h.sink.rows.find(isCommittedCompaction).content).toContain('README contents')
  })

  it('holds queued input until summary commits, then answers it after an otherwise completed task', async () => {
    const h = harness([{ content: 'Task finished', contextUsage: usage }, { content: 'Summary' }, { content: 'Follow-up answered' }])
    let delivered = false
    await h.service.run({ ...base, flushQueuedMessages: async () => {
      if (!delivered && h.sink.rows.some(isCommittedCompaction)) {
        delivered = true
        return { rows: [{ id: 'queued', role: 'user', content: 'Now do the follow-up' }], delivered: 1 }
      }
      return { rows: [], delivered: 0 }
    }, closeInputQueue: () => delivered }, () => {})
    expect(h.calls[1].input.history.some((row: any) => row.id === 'queued')).toBe(false)
    expect(h.calls[2].input.history.some((row: any) => row.id === 'queued')).toBe(true)
  })

  it.each(['failure', 'cancellation'])('does not deliver queued input when manual compaction ends in %s', async outcome => {
    const controller = new AbortController()
    const h = harness([])
    h.router.generate.mockImplementationOnce(async () => {
      if (outcome === 'cancellation') controller.abort()
      throw new Error('Summary failed')
    })
    const flushQueuedMessages = vi.fn(async () => ({ rows: [], delivered: 0 }))
    await expect(h.service.run({ ...base, manualCompaction: true, signal: controller.signal,
      flushQueuedMessages }, () => {})).rejects.toThrow()
    expect(flushQueuedMessages).not.toHaveBeenCalled()
    expect(h.sink.rows.some(isCommittedCompaction)).toBe(false)
  })

  it('never commits an empty or cancelled summary', async () => {
    const empty = harness([{ content: '' }])
    await expect(empty.service.run({ ...base, manualCompaction: true }, () => {})).rejects.toThrow('empty summary')
    expect(empty.sink.rows.some(isCommittedCompaction)).toBe(false)
    const controller = new AbortController()
    const cancelled = harness([{ content: 'too late' }])
    cancelled.router.generate.mockImplementationOnce(async () => { controller.abort(); return { content: 'too late' } })
    await expect(cancelled.service.run({ ...base, manualCompaction: true, signal: controller.signal }, () => {})).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelled.sink.rows.some(isCommittedCompaction)).toBe(false)
  })

  it('reserves a continuation turn before automatic compaction', async () => {
    const h = harness([])
    await expect(h.service.run({ ...base, maxTurns: 1,
      history: [{ role: 'user', content: 'x'.repeat(50000) }] }, () => {})).rejects.toThrow('Not enough turns')
    expect(h.calls).toHaveLength(0)
    expect(h.sink.rows).toHaveLength(0)
  })

  it('keeps disabled automatic compaction authoritative', async () => {
    const h = harness([{ content: 'Done' }])
    await h.service.run({ ...base, autoCompactionEnabled: false,
      history: [{ role: 'user', content: 'x'.repeat(50000) }] }, () => {})
    expect(h.sink.rows.some(isCommittedCompaction)).toBe(false)
  })

  it('replays the appendix in both text-first and block-first adapters', async () => {
    const h = harness([{ content: 'Summary' }])
    const history = [...base.history, { id: 'read', role: 'assistant', content: '',
      tool_calls: [{ id: 't', name: 'read_file', arguments: {} }],
      content_blocks: [{ type: 'tool_result', tool_use_id: 't', content: 'preserved evidence' }] }]
    await h.service.run({ ...base, history, manualCompaction: true }, () => {})
    const summary = h.sink.rows.find(isCommittedCompaction)
    const input = { modelName: 'test', history: [summary], userContent: '', tools: [] }
    expect(JSON.stringify(toCodexMessages(input))).toContain('preserved evidence')
    expect(JSON.stringify(toHyperMessages(input))).toContain('preserved evidence')
  })

  it('recognises only committed boundaries and drops old request usage from the live meter', () => {
    const summary = { role: 'assistant', content: 'Summary', meta: JSON.stringify({ kind: 'compaction_summary', state: 'committed' }),
      context_usage: usage, content_blocks: [{ type: 'openai_context_usage', usage }] }
    expect(trimHistoryToLatestCompaction([...base.history, summary])).toEqual([summary])
    expect(contextUsageAfterCompaction([...base.history, summary])[0].context_usage).toBeUndefined()
    expect(contextUsageAfterCompaction([summary])[0].content_blocks).toEqual([])
    expect(isCommittedCompaction({ ...summary, meta: { kind: 'compaction_summary', state: 'generating' } })).toBe(false)
    expect(isCommittedCompaction({ role: 'system', note: '__auto_compaction_summary__' })).toBe(true)
    expect(normalizeCompactionThreshold(NaN)).toBe(85)
    expect(normalizeCompactionThreshold(0)).toBe(1)
    expect(normalizeCompactionThreshold(100)).toBe(95)
  })
})

it.each(['failure', 'cancellation'])('tags partial compaction output on %s so reload cannot expose it as ordinary prose', async outcome => {
  const controller = new AbortController()
  const h = harness([])
  h.router.generate.mockImplementationOnce((async (_provider: string, _input: any, emit: (event: any) => void) => {
    emit({ type: 'chunk', part: 'text', delta: 'Partial summary payload' })
    if (outcome === 'cancellation') controller.abort()
    throw Object.assign(new Error('provider stopped'), { partialOutput: {
      content: 'Partial summary payload', reasoning: 'Summary reasoning', toolCalls: [], contentBlocks: [],
    } })
  }) as any)
  const events: any[] = []
  await expect(h.service.run({ ...base, manualCompaction: true, signal: controller.signal }, event => events.push(event))).rejects.toThrow()
  const partial = h.sink.rows.find(row => row.content === 'Partial summary payload')
  expect(partial?.meta).toMatchObject({ compactionPhase: 'summarising', compactionId: expect.any(String) })
  expect(isCommittedCompaction(partial)).toBe(false)
  expect(events.some(event => event.type === 'assistant_message_persisted' && event.message.id === partial.id)).toBe(true)
})
