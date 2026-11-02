import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../ThemeManager/themeConfig', () => ({
  useCustomChatTheme: () => ({ theme: { colors: { toolJobsMutedText: { light: '#737373', dark: '#a3a3a3' } } }, enabled: false }),
  useHtmlDarkMode: () => false,
  getThemeModeColor: (pair: { light: string }) => pair.light,
}))
import { BackgroundTasksIndicator } from './BackgroundTasksIndicator'

const server = { id: 'srv', kind: 'local_bash', description: 'dev server on :8090', toolUseId: 'b1' }

describe('BackgroundTasksIndicator', () => {
  it('names what an idle run is waiting on', () => {
    const html = renderToStaticMarkup(<BackgroundTasksIndicator conversationId='c' streamId='s' tasks={[server]} idle variant='tab' />)
    expect(html).toContain('Waiting on 1 background task')
    expect(html).toContain('Claude finished; 1 background task still running')
    expect(html).toContain('rounded-t-xl')
    expect(html).not.toContain('Composing')
  })

  it('counts tasks running alongside an active turn', () => {
    const html = renderToStaticMarkup(<BackgroundTasksIndicator conversationId='c' streamId='s'
      tasks={[server, { ...server, id: 'wf', kind: 'local_workflow' }]} idle={false} />)
    expect(html).toContain('>2 background tasks<')
    expect(html).not.toContain('Waiting on')
  })

  it('renders nothing without tasks', () => {
    expect(renderToStaticMarkup(<BackgroundTasksIndicator conversationId='c' streamId='s' tasks={[]} idle />)).toBe('')
  })
})
