import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SubagentRunView } from './SubagentTranscript'

vi.mock('boxicons', () => ({}))
vi.mock('../../hooks/useQueries', () => ({ useSubagentByToolCall: vi.fn() }))
vi.mock('../../utils/api', () => ({ environment: 'electron', buildLocalApiUrl: vi.fn() }))
vi.mock('../ThemeManager/themeConfig', () => ({
  getThemeModeColor: (_theme: unknown, _mode: unknown, _key: unknown, fallback: string) => fallback,
  useCustomChatTheme: () => ({}),
  useHtmlDarkMode: () => false,
}))

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
