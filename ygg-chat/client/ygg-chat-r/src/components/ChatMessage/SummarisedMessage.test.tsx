import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SummarisedMessage } from './SummarisedMessage'
import { createDefaultCustomChatTheme } from '../ThemeManager/themeConfig'

const { state } = vi.hoisted(() => ({
  state: { chat: { conversation: { messages: [
    { id: 'summary', note: '__auto_compaction_summary__' },
    { id: 'committed', role: 'assistant', meta: { kind: 'compaction_summary', state: 'committed' } },
    { id: 'summarising', role: 'assistant', meta: { compactionPhase: 'summarising' } },
    { id: 'instruction', role: 'user', meta: { kind: 'compaction_instruction' } },
    { id: 'resume', role: 'user', meta: { kind: 'compaction_resume' } },
    { id: 'image-info', role: 'user', note: '__generated_image_path_hint__' },
    { id: 'watch', role: 'user', meta: { kind: 'watcher_completion' } },
  ] } } },
}))

vi.mock('react-redux', () => ({ useSelector: (selector: (value: unknown) => unknown) => selector(state) }))
vi.mock('../../hooks/redux', () => ({ useAppDispatch: () => { throw new Error('Rich renderer mounted') } }))
vi.mock('../../features/chats/chatActions', () => ({
  AUTO_COMPACTION_NOTE: '__auto_compaction_summary__',
  GENERATED_IMAGE_PATH_HINT_NOTE: '__generated_image_path_hint__',
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
  it('renders persisted image-reference rows as notices without mounting the rich renderer', () => {
    const content = 'Model-only reference to /private/generated/image.png'
    const html = renderToStaticMarkup(<ChatMessage id='image-info' role='user' content={content}
      width='w-full' customThemeEnabled={false} />)
    expect(html).toContain('Image attached')
    expect(html).toContain('id="message-image-info"')
    expect(html).toContain('data-chat-image-attachment="true"')
    expect(html).not.toContain('/private/generated/image.png')
    expect(html).not.toContain('rounded-2xl')
    expect(content).toBe('Model-only reference to /private/generated/image.png')
  })
  it('also bypasses rich user bubbles for provenance-tagged watcher completions', () => {
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

  it.each(['summary', 'committed'])('never mounts the rich renderer or exposes %s payloads through ChatMessage', id => {
    const content = '# Full summary\n'.repeat(10000)
    const blocks = [{ type: 'text' as const, index: 0, content: 'Hidden block summary' }]
    const html = renderToStaticMarkup(
      <ChatMessage id={id} role={id === 'summary' ? 'system' : 'assistant'} content={content} contentBlocks={blocks}
        width='w-full' customThemeEnabled={false} />
    )
    expect(html).toContain('Conversation summarised')
    expect(html).not.toContain('Full summary')
    expect(html).not.toContain('Hidden block summary')
    expect(html.length).toBeLessThan(2000)
    expect(blocks[0].content).toBe('Hidden block summary')
  })
})

it.each(['instruction', 'resume', 'summarising'])('does not expose %s content, even in a tooltip', id => {
  const html = renderToStaticMarkup(<ChatMessage id={id} role={id === 'summarising' ? 'assistant' : 'user'}
    content='SECRET_SUMMARY_PAYLOAD' contentBlocks={[{ type: 'text', index: 0, content: 'SECRET_BLOCK' }]}
    width='w-full' customThemeEnabled={false} />)
  expect(html).not.toContain('SECRET_')
  if (id === 'instruction' || id === 'summarising') expect(html).toBe('')
  else expect(html).toContain('Resuming after compaction')
})
