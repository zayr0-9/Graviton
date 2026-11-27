import { describe, expect, it } from 'vitest'
import { compactMessageBody } from '../messageBodyCompaction.js'

describe('compactMessageBody', () => {
  it('returns null when nothing is large enough to drop, so small rows are never flagged', () => {
    expect(compactMessageBody(null)).toBeNull()
    expect(compactMessageBody('not blocks')).toBeNull()
    expect(compactMessageBody([
      { type: 'text', index: 0, content: 'x'.repeat(100_000) },
      { type: 'thinking', index: 1, content: 'short reasoning' },
      { type: 'tool_use', index: 2, id: 't1', name: 'todo_list', input: { action: 'set', items: 'a,b' } },
      { type: 'tool_result', index: 3, tool_use_id: 't1', content: 'done', is_error: false },
      { type: 'context_usage', index: 4, usage: { usedTokens: 10 } },
      { type: 'context_injection', index: 5, path: '/x', text: 'y'.repeat(5000) },
    ])).toBeNull()
  })

  it.each([
    { html: '<p>' + 'x'.repeat(800) + '</p>' },
    JSON.stringify({ type: 'text/html', content: '<p>' + 'x'.repeat(800) + '</p>' }),
  ])('keeps a layout hint when omitting an HTML tool result', content => {
    const block = { type: 'tool_result', index: 0, tool_use_id: 'app', content, is_error: false }
    expect(compactMessageBody([block])?.content_blocks).toEqual([
      { type: 'tool_result', index: 0, tool_use_id: 'app', is_error: false, omitted: true, html_omitted: true },
    ])
    expect(block).toHaveProperty('content', content)
  })

  it('drops large payloads, keeps small scalars and reports what it removed', () => {
    const result = compactMessageBody([
      { type: 'thinking', index: 0, content: 'r'.repeat(1000) },
      { type: 'tool_use', index: 1, id: 't1', name: 'edit_file', input: { path: '/src/a.ts', old: 'o'.repeat(600), new: 'n'.repeat(600), dryRun: false } },
      { type: 'tool_result', index: 2, tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }], is_error: false, patch: 'p'.repeat(2000) },
      { type: 'responses_output_items', index: 3, items: [{ type: 'message', content: 'c'.repeat(3000) }] },
      { type: 'image', index: 4, url: 'data:image/png;base64,' + 'A'.repeat(4000) },
      'malformed',
    ])
    expect(result).not.toBeNull()
    expect(result!.content_blocks).toEqual([
      { type: 'thinking', index: 0, content: 'r'.repeat(160), omitted: true },
      { type: 'tool_use', index: 1, id: 't1', name: 'edit_file', input: { path: '/src/a.ts', dryRun: false }, omitted: true },
      { type: 'tool_result', index: 2, tool_use_id: 't1', is_error: false, omitted: true },
      { type: 'responses_output_items', index: 3, omitted: true },
      { type: 'image', index: 4, omitted: true },
      'malformed',
    ])
    expect(result!.omittedChars).toBeGreaterThan(840 + 1200 + 2000 + 3000 + 4000)
  })
})
