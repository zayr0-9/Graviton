import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { applyClaudeTaskEvent, type ClaudeBackgroundTask } from '../../../../../shared/claudeProvider'
import { BackgroundTaskView, backgroundTaskTone } from './BackgroundTaskView'
import { buildToolCallGroupsFromBlocks, isExcludedFromProcessRunGrouping } from './chatMessageShared'

const system = (subtype: string, fields: Record<string, unknown>) => ({ type: 'system', subtype, task_id: 't1', ...fields })
const fold = (events: any[]) => events.reduce<ClaudeBackgroundTask | undefined>((task, event) => applyClaudeTaskEvent(task, event) ?? task, undefined)!

describe('Claude background task state', () => {
  it('follows a workflow from start through agent progress to its summary', () => {
    const started = system('task_started', { task_type: 'local_workflow', workflow_name: 'red-blue', description: 'Two agents' })
    const running = fold([started,
      system('task_progress', { description: 'Colors: red', workflow_progress: [{ type: 'workflow_agent', index: 1, label: 'red', phaseTitle: 'Colors', state: 'start' }] }),
      system('task_progress', { description: 'Colors: blue', usage: { total_tokens: 500, tool_uses: 1, duration_ms: 900 },
        workflow_progress: [{ type: 'workflow_agent', index: 1, label: 'red', phaseTitle: 'Colors', state: 'done' },
          { type: 'workflow_agent', index: 2, label: 'blue', phaseTitle: 'Colors', state: 'start' }] })])
    expect(running).toEqual({ id: 't1', kind: 'local_workflow', status: 'running', description: 'Two agents', workflowName: 'red-blue',
      activity: 'Colors: blue', usage: { totalTokens: 500, toolUses: 1, durationMs: 900 },
      agents: [{ label: 'red', phase: 'Colors', state: 'done' }, { label: 'blue', phase: 'Colors', state: 'start' }] })

    const done = fold([started, system('task_notification', { status: 'completed', summary: 'Workflow completed' })])
    expect(done).toMatchObject({ status: 'completed', summary: 'Workflow completed' })
    expect(done).not.toHaveProperty('activity')
  })

  it('maps killed to stopped, keeps an error summary, and ignores progress after the end', () => {
    const killed = fold([system('task_started', { description: 'x' }), system('task_updated', { patch: { status: 'killed', error: 'Stopped by user' } }),
      system('task_progress', { description: 'late', workflow_progress: [{ type: 'workflow_agent', index: 1, label: 'late', state: 'start' }] })])
    expect(killed).toMatchObject({ status: 'stopped', summary: 'Stopped by user' })
    expect(killed.agents).toBeUndefined()
  })

  it("keeps an agent's progress summary and last tool until it ends", () => {
    const started = system('task_started', { task_type: 'local_agent', description: 'Implement P5' })
    const summarised = system('task_progress', { description: 'Implement P5', summary: ' Running vitest suites ', last_tool_name: 'Bash',
      usage: { total_tokens: 340_000, tool_uses: 12, duration_ms: 252_000 } })
    // Summaries come about every 30s; the progress events between them carry none.
    const between = system('task_progress', { description: 'Implement P5', last_tool_name: 'Read', usage: { total_tokens: 341_000, tool_uses: 13, duration_ms: 253_000 } })
    const running = fold([started, summarised, between])
    expect(running).toMatchObject({ status: 'running', progress: 'Running vitest suites', lastTool: 'Read', usage: { totalTokens: 341_000, toolUses: 13 } })
    const done = fold([started, summarised, between, system('task_notification', { status: 'completed', summary: 'Done' })])
    expect(done).not.toHaveProperty('progress')
    expect(done).not.toHaveProperty('lastTool')
    expect(done.summary).toBe('Done')
  })

  it('returns null for events that are not task events', () => {
    expect(applyClaudeTaskEvent(undefined, { type: 'system', subtype: 'init' })).toBeNull()
    expect(applyClaudeTaskEvent(undefined, { type: 'system', subtype: 'background_tasks_changed', tasks: [] })).toBeNull()
  })
})

describe('Claude background task card', () => {
  const task: ClaudeBackgroundTask = { id: 't1', kind: 'local_workflow', status: 'running', description: 'Two agents', workflowName: 'red-blue',
    activity: 'Colors: blue', agents: [{ label: 'red', phase: 'Colors', state: 'done' }, { label: 'blue', phase: 'Colors', state: 'start' }],
    usage: { totalTokens: 1800, toolUses: 2, durationMs: 65_000 } }

  it('shows the workflow, its agents and usage while it runs', () => {
    const html = renderToStaticMarkup(<BackgroundTaskView task={task} />)
    for (const text of ['red-blue', 'Two agents', 'running', 'red', 'blue', 'done', 'Colors: blue', '1.8K tokens', '2 tool uses', '1m 5s']) {
      expect(html).toContain(text)
    }
    expect(backgroundTaskTone(task)).toBe('running')
  })

  it("shows a running agent's progress summary and last tool", () => {
    const html = renderToStaticMarkup(<BackgroundTaskView task={{ id: 't2', kind: 'local_agent', status: 'running', description: 'Implement P5',
      progress: 'Running vitest suites', lastTool: 'Bash', usage: { totalTokens: 340_000, toolUses: 12, durationMs: 252_000 } }} />)
    for (const text of ['Implement P5', 'Running vitest suites', 'Last tool: Bash', '340K tokens', '12 tool uses', '4m 12s']) expect(html).toContain(text)
  })

  it('shows the summary once ended; agents that never finished read as stopped', () => {
    const html = renderToStaticMarkup(<BackgroundTaskView task={{ ...task, status: 'stopped', activity: undefined, summary: 'Stopped' }} />)
    expect(html).toContain('Stopped')
    expect(html).not.toContain('Colors: blue')
    expect(html).toContain('stopped')
    expect(backgroundTaskTone({ ...task, status: 'failed' })).toBe('error')
  })

  it('carries the task onto the call\'s render group and keeps workflows out of collapsed agent steps', () => {
    const groups = buildToolCallGroupsFromBlocks([
      { type: 'tool_use', id: 'w1', name: 'Workflow', input: {}, index: 0 },
      { type: 'tool_result', tool_use_id: 'w1', content: 'launched', is_error: false, task, index: 1 },
    ] as any)
    expect(groups.get(0)?.results[0].task).toBe(task)
    expect(isExcludedFromProcessRunGrouping('Workflow', {})).toBe(true)
    expect(isExcludedFromProcessRunGrouping('Bash', {})).toBe(false)
  })
})
