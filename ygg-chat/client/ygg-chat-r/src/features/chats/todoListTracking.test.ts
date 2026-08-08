import { describe, expect, it } from 'vitest'
import { extractLatestTodoList } from './todoListTracking'

const assistantMessage = (id: string, blocks: unknown) => ({
  id,
  role: 'assistant',
  content_blocks: blocks,
})

describe('extractLatestTodoList', () => {
  it('extracts a direct todo_list result', () => {
    const result = extractLatestTodoList([
      assistantMessage('message-1', [
        { type: 'tool_use', id: 'todo-1', name: 'todo_list', input: { action: 'create' } },
        {
          type: 'tool_result',
          tool_use_id: 'todo-1',
          content: JSON.stringify({ id: 'ember-atlas-sage', content: '- [ ] First\n- [x] Second' }),
        },
      ]),
    ])

    expect(result).toEqual({
      name: 'ember-atlas-sage',
      action: 'create',
      items: [
        { text: 'First', done: false },
        { text: 'Second', done: true },
      ],
      messageId: 'message-1',
    })
  })

  it('extracts a todo_list result nested inside multi_call', () => {
    const result = extractLatestTodoList([
      assistantMessage('message-2', [
        {
          type: 'tool_use',
          id: 'batch-1',
          name: 'multi_call',
          input: {
            calls: [
              { tool: 'read_file', args: { path: 'README.md' } },
              { tool: 'todo_list', args: { action: 'edit', name: 'ember-atlas-sage' } },
            ],
          },
        },
        {
          type: 'tool_result',
          tool_use_id: 'batch-1',
          content: JSON.stringify({
            parallel: false,
            stopOnError: true,
            results: [
              { tool: 'read_file', ok: true, data: { content: 'README' } },
              {
                tool: 'todo_list',
                ok: true,
                data: { success: true, content: '- [x] First\n- [ ] Second' },
              },
            ],
          }),
        },
      ]),
    ])

    expect(result).toEqual({
      name: 'ember-atlas-sage',
      action: 'edit',
      items: [
        { text: 'First', done: true },
        { text: 'Second', done: false },
      ],
      messageId: 'message-2',
    })
  })

  it('uses the latest successful nested todo operation in a batch', () => {
    const result = extractLatestTodoList([
      assistantMessage('message-3', [
        {
          type: 'tool_use',
          id: 'batch-2',
          name: 'multi_call',
          input: {
            calls: [
              { tool: 'todo_list', args: { action: 'create' } },
              { toolName: 'todo_list', args: { action: 'edit', name: 'latest-list' } },
            ],
          },
        },
        {
          type: 'tool_result',
          tool_use_id: 'batch-2',
          content: {
            results: [
              { tool: 'todo_list', ok: true, data: { id: 'old-list', content: '- [ ] Old' } },
              { tool: 'todo_list', ok: true, data: { content: '- [x] Latest' } },
            ],
          },
        },
      ]),
    ])

    expect(result?.name).toBe('latest-list')
    expect(result?.action).toBe('edit')
    expect(result?.items).toEqual([{ text: 'Latest', done: true }])
  })

  it('ignores failed or mismatched nested results', () => {
    const result = extractLatestTodoList([
      assistantMessage('message-4', [
        {
          type: 'tool_use',
          id: 'batch-3',
          name: 'multi_call',
          input: { calls: [{ tool: 'todo_list', args: { action: 'edit', name: 'sample' } }] },
        },
        {
          type: 'tool_result',
          tool_use_id: 'batch-3',
          content: JSON.stringify({
            results: [{ tool: 'todo_list', ok: false, error: 'failed' }],
          }),
        },
      ]),
    ])

    expect(result).toBeNull()
  })
})
