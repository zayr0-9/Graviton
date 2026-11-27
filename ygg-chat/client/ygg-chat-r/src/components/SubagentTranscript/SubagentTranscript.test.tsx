import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SubagentRunView, SubagentTranscript } from './SubagentTranscript'
import { subagentPreviewRows } from './subagentPreviewRows'

vi.mock('boxicons', () => ({}))
vi.mock('../../hooks/useQueries', () => ({ useSubagentByToolCall: vi.fn() }))
vi.mock('../../utils/api', () => ({ buildLocalApiUrl: vi.fn() }))
vi.mock('../../hooks/redux', () => ({ useAppSelector: (select: (state: object) => unknown) => select({}) }))
vi.mock('../ChatMessage/ChatMessage', () => ({ ChatMessage: ({ role, content, contentBlocks, readOnly, groupToolReasoningRuns }: any) =>
  <p data-role={role} data-preview={readOnly && groupToolReasoningRuns}>{contentBlocks.length ? contentBlocks.map((b: any) => b.content ?? b.name).join(' ') : content}</p> }))
vi.mock('../ThemeManager/themeConfig', async importOriginal => {
  const actual = await importOriginal<typeof import('../ThemeManager/themeConfig')>()
  return { ...actual, useCustomChatTheme: () => ({ enabled: false, theme: actual.createDefaultCustomChatTheme() }), useHtmlDarkMode: () => false }
})

describe('subagent steering transcript', () => {
  it('keeps later instructions even when they repeat the original task', () => {
    const run: any = {
      id: 'run-1', prompt: 'Repeat task', status: 'completed', turns_used: 2, tool_calls_used: 0,
      messages: [
        { id: 'initial', role: 'user', content: 'Repeat task' },
        { id: 'answer', role: 'assistant', content: 'First answer' },
        { id: 'steering', role: 'user', content: 'Repeat task' },
        { id: 'resume', role: 'user', content: 'New direction' },
      ],
    }
    const html = renderToStaticMarkup(<SubagentRunView run={run} />)
    expect(html.match(/Repeat task/g)).toHaveLength(2)
    expect(html).toContain('New direction')
  })
})

describe('subagent run cards', () => {
  it('keeps reasoning, paired tools and subsequent prose together with ordered indexes', () => {
    const run: any = { messages: [
      { id: 'a', role: 'assistant', thinking_block: 'Checking', content_blocks: JSON.stringify([{ type: 'tool_use', id: 'x', name: 'repl', input: { action: 'show' } }]) },
      { id: 'b', role: 'tool', content: 'Failed', content_blocks: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'Failed' }] },
      { id: 'c', role: 'assistant', content: 'Done', content_blocks: [{ type: 'text', text: 'Done' }] },
    ] }
    const rows = subagentPreviewRows(run)
    expect(rows).toHaveLength(1)
    expect(rows[0].blocks).toEqual([
      { type: 'thinking', index: 0, content: 'Checking' },
      { type: 'tool_use', index: 1, id: 'x', name: 'repl', input: { action: 'show' } },
      { type: 'tool_result', index: 2, tool_use_id: 'x', is_error: true, content: 'Failed' },
      { type: 'text', index: 3, content: 'Done', text: 'Done' },
    ])
  })

  it('puts the live tail in its own run card only, without fork actions', () => {
    const runs: any[] = [{ id: 'a', status: 'running', handle: '1' }, { id: 'b', status: 'running', handle: '2', model_name: 'Model B' }]
    const html = renderToStaticMarkup(<SubagentTranscript runs={runs} live={{ runId: 'b', text: 'Live reply', reasoning: 'Checking', done: false }} />)
    const [a, b] = html.split('</section>')
    expect(a).not.toContain('Live reply')
    expect(b).toContain('Model B')
    expect(b).toContain('Checking Live reply')
    expect(b).toContain('data-preview="true"')
    expect(html).not.toContain('Open chat')
    const done = renderToStaticMarkup(<SubagentTranscript runs={runs} live={{ runId: 'b', text: 'Live reply', reasoning: '', done: true }} />)
    expect(done).not.toContain('Live reply')
  })
})
