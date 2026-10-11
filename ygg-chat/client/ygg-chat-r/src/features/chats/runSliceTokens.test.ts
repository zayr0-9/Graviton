import { describe, expect, it } from 'vitest'
import { estimateRunSliceMessage } from './runSliceTokens'
import { estimateContentBlocksForContext, safeEstimateTokenCount } from './contextTokenEstimate'
import { deriveRunStatistics } from './runStatistics'
import type { Message } from './chatTypes'
import type { ConversationRunStatistics } from '../../../../../shared/runStatistics'

const row = (id: string, role: Message['role'], content: string, extra: Partial<Message> = {}) => ({
  id, role, content, conversation_id: 'c', content_plain_text: content, children_ids: [], model_name: 'm',
  created_at: '2026-01-01', partial: false, artifacts: [], pastedContext: [], ...extra,
} as Message)
const attributed = (id: string, content: string, blocks: any[] = []) => row(id, 'assistant', content, {
  meta: { runStatistics: { version: 1, streamId: 'r', kind: 'model_response' } }, content_blocks: blocks,
})
const run: ConversationRunStatistics = { stream_id: 'r', conversation_id: 'c', lineage_id: 'l', stream_type: 'primary',
  user_message_id: 'u', parent_message_id: 'u', assistant_message_id: 'a', final_message_id: 'a', status: 'completed',
  started_at: '2026-01-01', duration_ms: 1000, metadata: { runResponseCount: 1 } }

describe('raw run slice tokens', () => {
  it('counts the user and assistant payload once, not repeated input usage or prior transcript', () => {
    const content = 'This is the final response.'
    const user = 'Please read the file.'
    const messages = [row('old', 'assistant', 'old context '.repeat(10000)), row('u', 'user', user), attributed('a', content, [
      { type: 'text', content },
      { type: 'openai_context_usage', usage: { inputTokens: 100000, outputTokens: 20, totalTokens: 100020 } },
    ])]
    const [stats] = deriveRunStatistics(messages, ['old', 'u', 'a'], [run], 'c')
    expect(stats.tokens.total).toBe(safeEstimateTokenCount(user) + safeEstimateTokenCount(content))
    expect(stats.tokens.breakdown).toMatchObject({ input: safeEstimateTokenCount(user), output: safeEstimateTokenCount(content) })
    expect(stats.tokens.requestTotal).toBe(100020)
    expect(stats.tokens.coverage).toBe('estimated')
  })
  it('works without provider usage and includes queued inputs/tool results across compaction', () => {
    const messages = [row('u', 'user', 'first input'), attributed('a', 'first output'), row('summary', 'system', 'summary '.repeat(1000)),
      row('queued', 'user', 'another input'), attributed('b', 'final answer', [
        { type: 'text', content: 'final answer' }, { type: 'tool_result', tool_use_id: 'call', content: 'file contents' },
      ])]
    const [stats] = deriveRunStatistics(messages, messages.map(m => m.id), [{ ...run, assistant_message_id: 'b', final_message_id: 'b', metadata: { runResponseCount: 2 } }], 'c')
    expect(stats.tokens.coverage).toBe('estimated')
    expect(stats.tokens.requestCoverage).toBe('unavailable')
    expect(stats.tokens.breakdown?.user).toBe(safeEstimateTokenCount('first input') + safeEstimateTokenCount('another input'))
    expect(stats.tokens.breakdown!.tools).toBeGreaterThan(0)
    expect(stats.tokens.breakdown!.input).toBe(safeEstimateTokenCount('first input') + safeEstimateTokenCount('another input') + safeEstimateTokenCount('file contents'))
    expect(stats.tokens.breakdown!.output).toBe(safeEstimateTokenCount('first output') + safeEstimateTokenCount('final answer'))
    expect(stats.tokens.total).toBeLessThan(100)
  })
  it('does not duplicate text, reasoning, tool calls or results stored in legacy fields', () => {
    const blocks = [{ type: 'text', content: 'answer' }, { type: 'thinking', content: 'reasoning' },
      { type: 'tool_use', id: 'call', name: 'read_file', input: { path: 'a.ts' } },
      { type: 'tool_result', tool_use_id: 'call', content: 'tool response' }]
    const canonical = attributed('a', 'answer', blocks)
    const duplicate = { ...canonical, thinking_block: 'reasoning',
      tool_calls: [{ id: 'call', name: 'read_file', arguments: { path: 'a.ts' }, result: 'tool response' }] }
    expect(estimateRunSliceMessage(duplicate)).toEqual(estimateRunSliceMessage(canonical))
  })
  it('ignores usage metadata, setup notices, terminal error prose and base64 images', () => {
    expect(estimateRunSliceMessage(attributed('a', '', [{ type: 'openai_context_usage', usage: { totalTokens: 999999 } }])).total).toBe(0)
    expect(estimateRunSliceMessage(row('notice', 'user', 'system instructions'.repeat(100), { meta: { kind: 'operation_mode_change' } })).total).toBe(0)
    expect(estimateRunSliceMessage(row('error', 'assistant', 'failure', { meta: { runStatistics: { version: 1, streamId: 'r', kind: 'terminal_error' } } })).total).toBe(0)
    const imageResult = attributed('a', '', [{ type: 'tool_result', tool_use_id: 'call', content: { image: 'data:image/png;base64,' + 'a'.repeat(200000) } }])
    expect(estimateRunSliceMessage(imageResult).total).toBeLessThan(100)
  })
  it('handles serialized blocks and legacy provider representations', () => {
    const response = attributed('a', 'answer', [{ type: 'responses_output_items', items: [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }] }])
    expect(estimateRunSliceMessage(response).assistant).toBe(safeEstimateTokenCount('answer'))
    expect(estimateRunSliceMessage({ ...response, content_blocks: JSON.stringify(response.content_blocks) as any })).toEqual(estimateRunSliceMessage(response))
  })
})

describe('run slice token directions', () => {
  it('counts tool results as input and generated calls/text/reasoning as output', () => {
    const input = { path: 'a.ts' }
    const estimate = estimateRunSliceMessage(attributed('a', 'answer', [
      { type: 'text', content: 'answer' }, { type: 'thinking', content: 'reasoning' },
      { type: 'tool_use', id: 'call', name: 'read_file', input },
      { type: 'tool_result', tool_use_id: 'call', content: 'tool response' },
    ]))
    expect(estimate.input).toBe(safeEstimateTokenCount('tool response'))
    expect(estimate.output).toBe(safeEstimateTokenCount('answer') + safeEstimateTokenCount('reasoning') +
      safeEstimateTokenCount('read_file') + estimateContentBlocksForContext([{ content: input }]))
    expect(estimate.total).toBe(estimate.input + estimate.output)
  })
  it('supports legacy tool calls/results without changing direction or counting duplicates', () => {
    const call = { id: 'call', name: 'read_file', arguments: { path: 'a.ts' }, result: 'tool response' }
    const estimate = estimateRunSliceMessage({ ...attributed('a', 'answer'), tool_calls: [call, call] })
    expect(estimate.input).toBe(safeEstimateTokenCount(call.result))
    expect(estimate.output).toBe(safeEstimateTokenCount('answer') + safeEstimateTokenCount(call.name) + estimateContentBlocksForContext([{ content: call.arguments }]))
    expect(estimate.total).toBe(estimate.input + estimate.output)
  })
  it('counts standalone tool messages as input, using blocks instead of mirrored content', () => {
    const legacy = row('tool', 'tool', 'tool response')
    const canonical = { ...legacy, content_blocks: [{ type: 'tool_result', index: 0, tool_use_id: 'call', content: 'tool response', is_error: false }] as Message['content_blocks'] }
    expect(estimateRunSliceMessage(legacy)).toEqual(estimateRunSliceMessage(canonical))
    expect(estimateRunSliceMessage(canonical)).toMatchObject({ input: safeEstimateTokenCount('tool response'), output: 0 })
  })
  it('excludes an assistant parent from both directions when a continuation starts after it', () => {
    const messages = [row('old', 'assistant', 'earlier response '.repeat(1000)), row('queued', 'user', 'new input'), attributed('a', 'new output')]
    const [stats] = deriveRunStatistics(messages, messages.map(m => m.id), [{ ...run, user_message_id: null, parent_message_id: 'old' }], 'c')
    expect(stats.tokens.breakdown).toMatchObject({ input: safeEstimateTokenCount('new input'), output: safeEstimateTokenCount('new output') })
    expect(stats.tokens.total).toBe(safeEstimateTokenCount('new input') + safeEstimateTokenCount('new output'))
  })
})
