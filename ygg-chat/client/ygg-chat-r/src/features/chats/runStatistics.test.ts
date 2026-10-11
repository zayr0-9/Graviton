import { describe, expect, it } from 'vitest'
import type { Message } from './chatTypes'
import type { ConversationRunStatistics } from '../../../../../shared/runStatistics'
import { deriveRunStatistics, formatRunStatistics, formatRunStatisticsDetails, placeRunFooters, interleaveRunFooters } from './runStatistics'

const message = (id: string, streamId?: string, tokens?: number, kind = 'model_response'): Message => ({
  id, conversation_id: 'c', role: streamId ? 'assistant' : 'user', content: '',
  content_plain_text: '', children_ids: [], created_at: '2026-01-01', model_name: 'm', partial: false,
  pastedContext: [], artifacts: [],
  meta: streamId ? { runStatistics: { version: 1, streamId, kind } } : null,
  content_blocks: tokens == null ? [] : [{ type: 'openai_context_usage', usage: { inputTokens: tokens - 2, outputTokens: 2,
    cachedInputTokens: 3, reasoningTokens: 1, totalTokens: tokens, responseId: id } }] as any,
} as Message)
const run = (id: string, endpoint: string, status: ConversationRunStatistics['status'] = 'completed'): ConversationRunStatistics => ({
  stream_id: id, conversation_id: 'c', lineage_id: 'l', stream_type: 'primary', status,
  parent_message_id: endpoint, assistant_message_id: endpoint, final_message_id: endpoint, duration_ms: 42000, started_at: '2026-01-01',
  tool_statistics: { count: 12, coverage: 'recorded' },
})

describe('run statistics', () => {
  it('segments by run rather than queued user-role boundaries and excludes sibling/subagent runs', () => {
    const messages = [message('u'), message('a', 'r1', 10), message('queued'), message('b', 'r1', 20),
      message('u2'), message('c', 'r2', 5), message('sibling', 'r3', 100)]
    const path = ['u', 'a', 'queued', 'b', 'u2', 'c']
    const stats = deriveRunStatistics(messages, path, [{ ...run('r1', 'b'), user_message_id: 'u', metadata: { runResponseCount: 2 } }, { ...run('r2', 'c'), user_message_id: 'u2' }, run('r3', 'sibling'),
      { ...run('sub', 'b'), stream_type: 'subagent' }], 'c')
    expect(stats.map(s => [s.streamId, s.anchorMessageId, s.tokens.requestTotal])).toEqual([['r1', 'b', 30], ['r2', 'c', 5]])
    expect(stats[0].tokens.coverage).toBe('estimated')
    expect(stats[0].tokens.total).toBe(0) // usage blocks are metadata, not raw transcript payload
    expect(formatRunStatistics(stats[0])).toBe('42s · 12 tool calls · ~0 tokens')
    expect(formatRunStatisticsDetails(stats[0])).toContain('Request usage: 30 tokens cumulative')
  })
  it('retains shared-prefix footers on descendant branches but not a run cut before its terminus', () => {
    const messages = [message('a', 'r1', 10), message('b', 'r1', 20), message('fork', 'r2', 5)]
    expect(deriveRunStatistics(messages, ['a', 'fork'], [run('r1', 'b'), run('r2', 'fork')], 'c').map(s => s.streamId)).toEqual(['r2'])
    expect(deriveRunStatistics(messages, ['a', 'b', 'fork'], [run('r1', 'b')], 'c')).toHaveLength(1)
  })
  it('supports empty/tool-only, stopped and failed output, ignoring active runs', () => {
    const messages = [message('a', 'stopped'), message('e', 'failed', undefined, 'terminal_error')]
    const stats = deriveRunStatistics(messages, ['a', 'e'], [run('stopped', 'a', 'aborted'), run('failed', 'e', 'error'), run('active', 'e', 'running')], 'c')
    expect(stats).toHaveLength(2)
    expect(formatRunStatistics(stats[0])).toBe('Stopped · 42s · 12 tool calls · Tokens unavailable')
    expect(stats[1].tokens.responses).toBe(0)
    expect(formatRunStatistics(stats[1])).toContain('Failed')
  })
  it('deduplicates provider response usage and marks missing/failed usage partial', () => {
    const a = message('a', 'r', 10)
    const copy = { ...a, id: 'b' }
    const missing = message('c', 'r')
    const [stats] = deriveRunStatistics([a, copy, missing], ['a', 'b', 'c'], [run('r', 'c')], 'c')
    expect(stats.tokens.requestTotal).toBe(10)
    expect(stats.tokens.requestCoverage).toBe('partial')
    expect(formatRunStatisticsDetails(stats)).toContain('(partial)')
  })
  it('does not invent historical token/tool totals or branch membership without a path', () => {
    const old = message('old')
    const [stats] = deriveRunStatistics([old], ['old'], [{ ...run('r', 'old'), parent_message_id: null, tool_statistics: undefined }], 'c', 'l')
    expect(formatRunStatistics(stats)).toBe('42s · Tools unavailable · Tokens unavailable')
    expect(deriveRunStatistics([old], [], [run('r', 'old')], 'c')).toEqual([])
  })
  it('requires exact lineage for a no-output run at a shared input anchor', () => {
    const stopped = { ...run('r', 'u', 'aborted'), assistant_message_id: null }
    expect(deriveRunStatistics([message('u')], ['u'], [stopped], 'c', 'other')).toEqual([])
    expect(deriveRunStatistics([message('u')], ['u'], [stopped], 'c', 'l')).toHaveLength(1)
  })
  it('places filtered endpoints after preceding selected content, never on later unrelated content', () => {
    const [stats] = deriveRunStatistics([message('a', 'r', 10), message('b', 'r', 10)], ['a', 'b', 'u2'], [run('r', 'b')], 'c')
    expect([...placeRunFooters([stats], ['a', 'b', 'u2'], ['a', 'u2']).keys()]).toEqual(['a'])
  })
  it('handles terminal completion without message ID and repeated records once', () => {
    const terminal = { ...run('r', 'a'), assistant_message_id: null, final_message_id: null }
    expect(deriveRunStatistics([message('a', 'r', 5)], ['a'], [terminal, terminal], 'c')).toHaveLength(1)
  })
})

describe('run attribution coverage', () => {
  it('marks missing intermediate attribution partial even when all remaining rows have usage', () => {
    const a = message('a', undefined, 10)
    const b = message('b', 'r', 20)
    const [stats] = deriveRunStatistics([a, b], ['a', 'b'], [{ ...run('r', 'b'), metadata: { runResponseCount: 2 } }], 'c')
    expect(stats.tokens).toMatchObject({ requestTotal: 20, requestCoverage: 'partial' })
  })
  it('places failures after the terminal error, not an earlier response or trailing mode notice', () => {
    const a = message('a', 'r', 10)
    const e = message('e', 'r', undefined, 'terminal_error')
    const mode = message('mode')
    const [stats] = deriveRunStatistics([a, e, mode], ['a', 'e', 'mode'], [{ ...run('r', 'a', 'error'), final_message_id: 'mode' }], 'c')
    expect(stats.anchorMessageId).toBe('e')
  })
})

it('keeps the footer outside a collapsed process group and before the next run', () => {
  const [stats] = deriveRunStatistics([message('a', 'r', 5), message('b', 'r', 10)], ['a', 'b'], [run('r', 'b')], 'c')
  const rows = interleaveRunFooters([
    { kind: 'process_group' as const, memberMessageIds: ['a', 'b'] },
    { kind: 'message' as const, message: { id: 'next' } },
  ], new Map([['b', [stats]]]))
  expect(rows.map(row => row.kind)).toEqual(['transcript', 'run_stats', 'transcript'])
})
