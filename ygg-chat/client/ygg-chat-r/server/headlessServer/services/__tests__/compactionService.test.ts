import { describe, expect, it } from 'vitest'
import { buildCompactionToolContextAppendix, buildCompactionWriteOpAppendix, finaliseCompactionContent } from '../compactionService.js'

describe('deterministic compaction finalisation', () => {
  it('pairs completed reads and child results by call id', () => {
    const messages = [{ role: 'assistant', tool_calls: JSON.stringify([
      { id: 'read', name: 'read_file', arguments: { path: '/workspace/chat.ts' } },
      { id: 'child', name: 'subagent', arguments: { prompt: 'Trace history' } },
    ]), content_blocks: [{ type: 'tool_result', tool_use_id: 'read', content: 'export const compact = true', is_error: false }] },
    { role: 'tool', tool_call_id: 'child', content: 'Child found the context bug.' }]
    const appendix = buildCompactionToolContextAppendix(messages)
    expect(appendix).toContain('read_file success')
    expect(appendix).toContain('/workspace/chat.ts')
    expect(appendix).not.toContain('export const compact = true')
    expect(appendix).toContain('Child found the context bug.')
  })

  it('extracts calls from blocks and preserves write details separately', () => {
    const messages = [{ role: 'assistant', content_blocks: [
      { type: 'tool_use', id: 'glob', name: 'glob', input: { pattern: '**/*.ts' } },
      { type: 'tool_result', tool_use_id: 'glob', content: ['src/a.ts'], is_error: false },
      { type: 'tool_use', id: 'edit', name: 'edit_file', input: { path: '/a.ts', searchPattern: 'before', replacement: 'after' } },
      { type: 'tool_result', tool_use_id: 'edit', content: { success: true }, is_error: false },
    ] }]
    expect(buildCompactionToolContextAppendix(messages)).not.toContain('src/a.ts')
    expect(buildCompactionToolContextAppendix(messages)).not.toContain('edit_file')
    expect(buildCompactionWriteOpAppendix(messages)).toContain('/a.ts')
    expect(buildCompactionWriteOpAppendix(messages)).not.toContain('searchPattern')
    expect(buildCompactionWriteOpAppendix(messages)).not.toContain('replacement')
  })

  it('updates canonical text and blocks while retaining raw output and statistics', () => {
    const raw = { type: 'responses_output_items', items: [{ type: 'reasoning', encrypted_content: 'opaque' }] }
    const update = finaliseCompactionContent({ content: 'Summary', content_blocks: [raw, { type: 'text', content: 'Summary' }],
      meta: JSON.stringify({ runStatistics: { streamId: 's' } }) }, [{ role: 'assistant',
      tool_calls: [{ id: 'r', name: 'read_file', arguments: {} }], content_blocks: [{ type: 'tool_result', tool_use_id: 'r', content: 'evidence' }] }], { id: 'instruction' })
    expect(update.content).not.toContain('evidence')
    expect(update.contentBlocks.at(-1).content).toContain('read_file')
    expect(update.contentBlocks.at(-1).content).not.toContain('evidence')
    expect(update.contentBlocks[0]).toEqual(raw)
    expect(update.meta).toMatchObject({ kind: 'compaction_summary', state: 'committed', instructionId: 'instruction', runStatistics: { streamId: 's' } })
  })
})
