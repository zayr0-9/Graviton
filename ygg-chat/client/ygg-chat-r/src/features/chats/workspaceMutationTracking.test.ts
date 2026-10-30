import { describe, expect, it } from 'vitest'
import type { Message } from './chatTypes'
import { extractBranchFileMutations } from './workspaceMutationTracking'

const claudeTurn = (blocks: unknown[]): Message => ({
  id: 'm1', conversation_id: 'c', role: 'assistant', content: '', content_blocks: blocks,
  parent_id: null, children_ids: [], created_at: '2026-10-29T00:00:00Z', model_name: 'claude', partial: false,
} as unknown as Message)

describe('native Claude file tools', () => {
  it('records Edit and Write, taking create from the patch', () => {
    const { latestByPath } = extractBranchFileMutations([claudeTurn([
      { type: 'tool_use', id: 'e', name: 'Edit', input: { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' } },
      { type: 'tool_result', tool_use_id: 'e', content: 'The file has been updated.', is_error: false },
      { type: 'tool_use', id: 'w', name: 'Write', input: { file_path: '/w/new.ts', content: 'x' } },
      { type: 'tool_result', tool_use_id: 'w', content: 'File created.', is_error: false,
        patch: { filePath: '/w/new.ts', kind: 'create', hunks: [] } },
    ])])
    expect(latestByPath.map(summary => [summary.path, summary.latestMutation.operation, summary.latestMutation.toolName]))
      .toEqual([['/w/new.ts', 'create', 'Write'], ['/w/a.ts', 'edit', 'Edit']])
  })

  it('skips failed and unanswered native edits', () => {
    const { history } = extractBranchFileMutations([claudeTurn([
      { type: 'tool_use', id: 'e', name: 'Edit', input: { file_path: '/w/a.ts' } },
      { type: 'tool_result', tool_use_id: 'e', content: '<tool_use_error>no match</tool_use_error>', is_error: true },
      { type: 'tool_use', id: 'p', name: 'Write', input: { file_path: '/w/b.ts' } },
    ])])
    expect(history).toEqual([])
  })
})
