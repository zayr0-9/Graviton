import { describe, expect, it } from 'vitest'
import type { ContentBlock, HookRunRecord, Message } from '../../features/chats/chatTypes'
import { getAgentProgress } from './agentActivity'
import { projectPersistedAgentRows } from './persistedAgentRows'

const text = (content: string, index = 0): Extract<ContentBlock, { type: 'text' }> => ({ type: 'text', index, content })
const thought = (index = 0): ContentBlock => ({ type: 'thinking', index, content: 'Working' })
const tool = (id: string, index = 0, name = 'read_file'): ContentBlock => ({ type: 'tool_use', id, name, input: {}, index })
const result = (tool_use_id: string, index = 0, content: unknown = 'ok'): ContentBlock => ({ type: 'tool_result', tool_use_id, content, index, is_error: false })
const replay = (items: unknown[], index = 0) => ({ type: 'responses_output_items', items, index }) as unknown as ContentBlock
const usage = { type: 'context_usage', index: 0 } as unknown as ContentBlock
const context: ContentBlock = { type: 'context_injection', path: 'rule.md', label: 'Rule', text: 'Context', reason: 'path_glob_match' }
const msg = (id: string, blocks: ContentBlock[], extra?: Partial<Message>) => ({
  id, role: 'assistant', content: '', content_blocks: blocks, ...extra,
}) as Message
const project = (messages: Message[], footer?: string, hideReasoning = false) =>
  projectPersistedAgentRows(messages, message => message.content_blocks, () => false, id => id === footer, hideReasoning)

const shape = (rows: ReturnType<typeof project>) => rows.map(row => row.kind === 'process_group'
  ? row.fragments.map(part => [part.message.id, part.blocks.map(block => block.type)])
  : [row.message.id, row.displayBlocks?.map(block => block.type) ?? 'standalone'])

describe('persisted transcript grouping', () => {
  it('joins both sides of a mixed Codex message to their neighbours, not to each other', () => {
    // Stored shape: context usage, reasoning, commentary, call, replay metadata, late result;
    // the following two persisted rows contain partial reasoning and a terminal error.
    const before = msg('before', [tool('old'), result('old')])
    const paragraph = text('Checking.', 3)
    const mixed = msg('mixed', [usage, thought(1), thought(2), paragraph, tool('todo', 4, 'todo_list'),
      replay([{ type: 'reasoning', summary: [{ text: 'Duplicate' }] },
        { type: 'message', role: 'assistant', content: [{ text: paragraph.content }] },
        { type: 'function_call', id: 'todo', name: 'todo_list' }], 5), result('todo', 6)])
    const partial = msg('partial', [thought()])
    const failure = msg('error', [{ type: 'error', index: 0, envelope: { code: 'stream_interrupted', userMessage: 'Connection interrupted', recoverability: 'retryable' }, excludeFromContext: true }])
    const rows = project([before, mixed, partial, failure], 'error')
    expect(shape(rows)).toEqual([
      [['before', ['tool_use', 'tool_result']], ['mixed', ['thinking', 'thinking']]],
      ['mixed', ['text']],
      [['mixed', ['tool_use', 'tool_result']], ['partial', ['thinking']]],
      ['error', ['error']],
    ])
    expect(rows[3].footerAnchor).toBe('error')
    const counts = rows.flatMap(row => row.kind === 'process_group'
      ? [getAgentProgress(row.fragments.flatMap(part => part.blocks)).completed] : [])
    expect(counts).toEqual([1, 1])
    expect(rows[2].id).toBe(project([before, mixed])[2].id)
  })

  it('keeps distinct process segments and puts a footer only after the last fragment', () => {
    const messages = [msg('a', [thought(), text('First', 1), thought(2), text('Next', 3), thought(4)]), msg('b', [tool('b')])]
    const rows = project(messages, 'a')
    expect(rows.map(row => row.kind)).toEqual(['process_group', 'message', 'process_group', 'message', 'process_group', 'process_group'])
    expect(new Set(rows.map(row => `${row.kind}-${row.id}`)).size).toBe(rows.length)
    expect(rows.map(row => row.footerAnchor)).toEqual([undefined, undefined, undefined, undefined, 'a', undefined])
    expect(project([msg('a', [thought()])])[0].id).toBe(rows[0].id)
  })

  it('keeps late results at their call and an interactive result at its visible anchor', () => {
    const app = tool('app', 3, 'custom_app')
    const html = result('app', 6, { html: '<p>Fixture</p>' })
    const rows = project([msg('a', [tool('a'), text('OK', 1), thought(2), app, tool('b', 4), result('a', 5), html])])
    expect(shape(rows)).toEqual([
      [['a', ['tool_use', 'tool_result']]], ['a', ['text']], [['a', ['thinking']]],
      ['a', ['tool_use', 'tool_result']], [['a', ['tool_use']]],
    ])
    expect(rows[3]).toMatchObject({ displayBlocks: [app, html] })
  })

  it('keeps real hooks on one fragment and allows context-only continuations', () => {
    const hooks = [{ id: 'hook' }] as HookRunRecord[]
    const grouped = project([msg('a', [tool('a'), text('OK', 1), thought(2), context], { hook_runs: hooks }), msg('ctx', [context]), msg('b', [tool('b')])])
    expect(grouped[0]).toMatchObject({ fragments: [{ ownsHooks: false }] })
    expect(grouped[1]).toMatchObject({ hookRunsAttached: true })
    expect(grouped[2]).toMatchObject({ fragments: [{ ownsHooks: true }, { message: { id: 'ctx' } }, { message: { id: 'b' } }] })
    expect(project([msg('ctx', [context])])[0]).toMatchObject({ kind: 'message', displayBlocks: [context] })
  })

  it('uses ordered Responses items only as a fallback and keeps whitespace from splitting groups', () => {
    const messages = [msg('a', [tool('a')]), msg('legacy', [replay([
      { type: 'reasoning', summary: [{ text: 'Analysis' }] },
      { type: 'message', role: 'assistant', content: [{ text: 'OK' }] },
      { type: 'function_call', call_id: 'legacy', name: 'read_file', arguments: '{}' },
    ])]), msg('meta', [usage]), msg('b', [text('  '), tool('b')])]
    expect(shape(project(messages))).toEqual([
      [['a', ['tool_use']], ['legacy', ['thinking']]], ['legacy', ['text']],
      [['legacy', ['tool_use']], ['meta', []], ['b', ['tool_use']]],
    ])
    expect(shape(project(messages, undefined, true))).toEqual([
      [['a', ['tool_use']]], ['legacy', ['text']], [['legacy', ['tool_use']], ['meta', []], ['b', ['tool_use']]],
    ])
  })
})
