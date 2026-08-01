import { describe, expect, it } from 'vitest'
import { estimateHistoryMessageTokens } from '../toolLoopService.js'

/**
 * Regression guard for the auto-compaction "fires too early" bug (compaction triggered
 * at ~50k reported tokens on a 258k-window ChatGPT model). Root cause: the compaction
 * projection (projectedReplayTokens) summed approximateTokens(wholeDbRow), which
 *   (a) counted each tool result TWICE — once as the {role:'tool'} history entry and again
 *       merged into the assistant row's content_blocks,
 *   (b) counted message text up to 3x (content + plain_text_content + content_blocks), and
 *   (c) re-escaped the already-stringified content_blocks plus row metadata,
 * inflating the estimate ~4x. Via resolveOpenAIContinuationCompaction's
 * Math.max(reported, projected), the inflated projection crossed the threshold while real
 * reported usage was still low. estimateHistoryMessageTokens de-inflates it: one canonical
 * text representation per message, and 0 for {role:'tool'} duplicates.
 */
describe('estimateHistoryMessageTokens (compaction projection de-inflation)', () => {
  const rough = (s: string) => Math.ceil(s.length / 4)

  it('counts a role:tool entry as 0 (already merged into the assistant content_blocks)', () => {
    const toolEntry = { role: 'tool', tool_call_id: 't1', content: 'X'.repeat(4000) }
    expect(estimateHistoryMessageTokens(toolEntry)).toBe(0)
  })

  it('does not triple-count content duplicated across content / plain_text_content / content_blocks', () => {
    const text = 'Y'.repeat(4000)
    const row = {
      role: 'assistant',
      content: text,
      plain_text_content: text, // duplicate column the DB writes
      content_blocks: JSON.stringify([{ type: 'text', text }]),
    }
    const estimate = estimateHistoryMessageTokens(row)
    // Canonical single representation (~content_blocks string), NOT content+plain+blocks summed.
    // Comfortably under 2x one copy — the old whole-row estimate was ~3x+.
    expect(estimate).toBeLessThan(rough(text) * 2)
    expect(estimate).toBeGreaterThanOrEqual(rough(text))
  })

  it('is far below the old whole-row JSON estimate for a tool-heavy assistant row', () => {
    const text = 'Z'.repeat(2000)
    const toolResult = 'R'.repeat(8000)
    const blocks = [
      { type: 'text', text },
      { type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: '/a/b' } },
      { type: 'tool_result', tool_use_id: 'tu1', content: toolResult },
    ]
    const assistantRow = {
      id: 'm1',
      parent_id: 'm0',
      children_ids: JSON.stringify(['m2']),
      role: 'assistant',
      content: text,
      plain_text_content: text,
      content_blocks: JSON.stringify(blocks),
      tool_calls: JSON.stringify([{ id: 'tu1', name: 'read_file', result: toolResult }]),
      created_at: '2026-08-01T00:00:00.000Z',
      note: null,
    }
    const oldWholeRow = Math.ceil(JSON.stringify(assistantRow).length / 4)
    const deInflated = estimateHistoryMessageTokens(assistantRow)
    // The de-inflated estimate must be materially smaller than the pre-fix whole-row estimate.
    expect(deInflated).toBeLessThan(oldWholeRow)
    // And it must still reflect the real payload (blocks carry text + tool_result).
    expect(deInflated).toBeGreaterThanOrEqual(rough(toolResult))
  })

  it('falls back to content when there are no content_blocks (plain user turn)', () => {
    const text = 'hello world '.repeat(50)
    expect(estimateHistoryMessageTokens({ role: 'user', content: text })).toBe(rough(text))
  })

  it('handles null / primitive inputs without throwing', () => {
    expect(estimateHistoryMessageTokens(null)).toBe(0)
    expect(estimateHistoryMessageTokens(undefined)).toBe(0)
    expect(estimateHistoryMessageTokens('plain string')).toBe(Math.ceil('plain string'.length / 4))
  })
})
