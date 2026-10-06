import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SummarisedMessage } from './SummarisedMessage'
import { createDefaultCustomChatTheme } from '../ThemeManager/themeConfig'

const { state } = vi.hoisted(() => ({
  state: { chat: { conversation: { messages: [{ id: 'summary', note: '__auto_compaction_summary__' }] } } },
}))

vi.mock('react-redux', () => ({ useSelector: (selector: (value: unknown) => unknown) => selector(state) }))
vi.mock('../../hooks/redux', () => ({ useAppDispatch: () => { throw new Error('Rich renderer mounted') } }))
vi.mock('../../features/chats/chatActions', () => ({
  AUTO_COMPACTION_NOTE: '__auto_compaction_summary__',
  fetchMcpTools: vi.fn(),
}))
vi.mock('../../features/chats/chatSlice', () => ({ chatSliceActions: {} }))
vi.mock('../../utils/api', () => ({ environment: 'local', localApi: {} }))
vi.mock('../HtmlIframeRegistry/HtmlIframeRegistry', () => ({}))
vi.mock('../ImageModal/ImageModal', () => ({}))
vi.mock('./MessageActions', () => ({}))
vi.mock('../MermaidDiagram', () => ({}))
vi.mock('../TextArea/TextArea', () => ({}))
vi.mock('./ToolCallGroupCard', () => ({}))
vi.mock('./HookActivityCard', () => ({}))
vi.mock('./ContextInjectionCard', () => ({}))
vi.mock('../MarkdownLink/MarkdownLink', () => ({ MarkdownLink: () => null, markdownUrlTransform: (url: string) => url }))

import { ChatMessage } from './ChatMessage'

describe('SummarisedMessage', () => {
  it('also bypasses rich user bubbles for provenance-tagged watcher completions', () => {
    state.chat.conversation.messages.push({ id: 'watch', role: 'user', meta: { kind: 'watcher_completion' } } as any)
    const content = 'Watcher completion: process_exit watch 075f30b0-fd46-4839-9cd4-3793b8cc8444 triggered. Continue the original task.'
    const html = renderToStaticMarkup(<ChatMessage id='watch' role='user' content={content} width='w-full' customThemeEnabled={false} />)
    expect(html).toContain('Watcher triggered')
    expect(html).toContain('data-chat-watcher="true"')
    expect(html).not.toContain('rounded-2xl')
    expect(html).not.toContain('>Watcher completion:')
    expect(content).toContain('Continue the original task.')
  })
  it('renders a compact notice with a stable message anchor', () => {
    const html = renderToStaticMarkup(
      <SummarisedMessage id='message-summary' customThemeEnabled={false} />
    )
    expect(html).toContain('Conversation summarised')
    expect(html).toContain('id="message-summary"')
    expect(html).toContain('data-chat-summary="true"')
  })

  it('uses the custom theme muted text color', () => {
    const theme = createDefaultCustomChatTheme()
    theme.colors.toolJobsMutedText.dark = '#123456'
    const html = renderToStaticMarkup(
      <SummarisedMessage customTheme={theme} customThemeEnabled isDarkMode />
    )
    expect(html).toContain('color:#123456')
  })

  it('never mounts the rich renderer or exposes summary payloads through ChatMessage', () => {
    const content = '# Full summary\n'.repeat(10000)
    const blocks = [{ type: 'text' as const, index: 0, content: 'Hidden block summary' }]
    const html = renderToStaticMarkup(
      <ChatMessage id='summary' role='system' content={content} contentBlocks={blocks}
        width='w-full' customThemeEnabled={false} />
    )
    expect(html).toContain('Conversation summarised')
    expect(html).not.toContain('Full summary')
    expect(html).not.toContain('Hidden block summary')
    expect(html.length).toBeLessThan(2000)
    expect(blocks[0].content).toBe('Hidden block summary')
  })
})
