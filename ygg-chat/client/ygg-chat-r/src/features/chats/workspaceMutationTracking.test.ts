import { describe, expect, it } from 'vitest'
import type { Message } from './chatTypes'
import { extractBranchFileMutations, indexWorkspaceMutationTurns } from './workspaceMutationTracking'

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

const message = (id: Message['id'], role: Message['role'], fields: Partial<Message> = {}): Message => ({
  ...claudeTurn([]), id, role, ...fields,
})

const edit = (id: string, path: string) => ({ type: 'tool_use', id, name: 'edit_file', input: { path } })
const result = (id: string, success = true) => ({ type: 'tool_result', tool_use_id: id, content: { success } })

describe('highlighted-turn file mutations', () => {
  it('uses the same full turn for the prompt and reply, counting repeated paths only within that turn', () => {
    const firstPrompt = message('u1', 'user')
    const firstCall = { ...claudeTurn([edit('e1', '/shared.ts')]), id: 'call-1' }
    const firstResult = message('result-1', 'tool', { tool_call_id: 'e1', content: '{"success":true}' })
    const firstReply = message('reply-1', 'assistant', { content: 'First reply' })
    const secondPrompt = message('u2', 'user')
    const secondCall = { ...claudeTurn([
      edit('e2', '/shared.ts'), result('e2'), edit('e3', '/shared.ts'), result('e3'),
      edit('e4', '/new.ts'), result('e4'), edit('failed', '/failed.ts'), result('failed', false),
    ]), id: 'call-2' }
    const secondReply = message('reply-2', 'assistant', { content: 'Second reply' })
    const branch = [firstPrompt, firstCall, firstResult, firstReply, secondPrompt, secondCall, secondReply]
    const turns = indexWorkspaceMutationTurns(branch)

    expect(turns.get('u1')).toBe(turns.get('reply-1'))
    expect(turns.get('u2')).toBe(turns.get('reply-2'))
    expect(extractBranchFileMutations(turns.get('u1')!).latestByPath.map(s => [s.path, s.mutationCount]))
      .toEqual([['/shared.ts', 1]])
    expect(extractBranchFileMutations(turns.get('reply-2')!).latestByPath.map(s => [s.path, s.mutationCount]))
      .toEqual([['/new.ts', 1], ['/shared.ts', 2]])
    expect(extractBranchFileMutations(branch).latestByPath.map(s => [s.path, s.mutationCount]))
      .toEqual([['/new.ts', 1], ['/shared.ts', 3]])
  })

  it('does not split a turn at settings, context, or compaction control rows', () => {
    const prefix = message('system', 'assistant')
    const prompt = message('u1', 'user')
    const notices = ['operation_mode_change', 'full_access_change', 'context_injection', 'compaction_resume']
      .map(kind => message(kind, 'user', { meta: JSON.stringify({ kind }) }))
    const reply = message('reply', 'assistant')
    const next = message('next', 'user')
    const turns = indexWorkspaceMutationTurns([prefix, prompt, ...notices, reply, next])

    expect(turns.get('u1')).toEqual([prompt, ...notices, reply])
    for (const notice of notices) expect(turns.get(String(notice.id))).toBe(turns.get('reply'))
    expect(turns.has('system')).toBe(false)
    expect(turns.has('off-branch')).toBe(false)
    expect(extractBranchFileMutations(turns.get('next')!).latestByPath).toEqual([])
  })
})
