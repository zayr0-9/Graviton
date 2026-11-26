import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentBlock, StreamEvent } from '../../features/chats/chatTypes'
import { HIDE_REASONING_BLOCKS_KEY } from '../../helpers/hideReasoningSettings'
import { createDefaultCustomChatTheme } from '../ThemeManager/themeConfig'

const { state } = vi.hoisted(() => ({
  state: { chat: { conversation: { messages: [] }, attachments: { backup: {} }, tools: [] }, conversations: { items: [] } },
}))

vi.mock('react-redux', () => ({ useSelector: (selector: (value: unknown) => unknown) => selector(state) }))
vi.mock('../../hooks/redux', () => ({ useAppDispatch: () => vi.fn() }))
vi.mock('../../hooks/useMediaQuery', () => ({ useIsMobile: () => false }))
vi.mock('../ChatSelection/ChatSelectionProvider', () => ({ useChatNavigate: () => vi.fn() }))
vi.mock('../../features/chats/chatActions', () => ({
  AUTO_COMPACTION_NOTE: '__auto_compaction_summary__',
  GENERATED_IMAGE_PATH_HINT_NOTE: '__generated_image_path_hint__',
  fetchMcpTools: vi.fn(),
}))
vi.mock('../../features/chats/chatSlice', () => ({ chatSliceActions: {} }))
vi.mock('../../utils/api', () => ({ localApi: {} }))
vi.mock('../HtmlIframeRegistry/HtmlIframeRegistry', () => ({ useHtmlIframeRegistry: () => null }))
vi.mock('../ImageModal/ImageModal', () => ({ ImageModal: () => null }))
vi.mock('./MessageActions', () => ({ MessageActions: () => null }))
vi.mock('../MermaidDiagram', () => ({
  MermaidDiagram: () => null,
  getMermaidSource: () => '',
  isMermaidCodeBlock: () => false,
  prepareMermaidMarkdown: (markdown: string) => markdown,
}))
vi.mock('../TextArea/TextArea', () => ({ TextArea: () => null }))
vi.mock('./ToolCallGroupCard', () => ({ ToolCallGroupCard: () => <div>tool-card</div> }))
vi.mock('./HookActivityCard', () => ({ HookActivityCard: () => null }))
vi.mock('./ContextInjectionCard', () => ({ ContextInjectionCard: () => null }))
vi.mock('../MarkdownLink/MarkdownLink', () => ({ MarkdownLink: () => null, markdownUrlTransform: (url: string) => url }))

import { ChatMessage } from './ChatMessage'

const theme = createDefaultCustomChatTheme()
const render = (props: { contentBlocks?: ContentBlock[]; streamEvents?: StreamEvent[] }) =>
  renderToStaticMarkup(<ChatMessage id='a1' role='assistant' content='' width='w-full'
    customTheme={theme} customThemeEnabled={false} isDarkMode={false} {...props} />)

const thinkingThenAnswer: ContentBlock[] = [
  { type: 'thinking', index: 0, content: 'Secret plan' },
  { type: 'tool_use', index: 1, id: 't1', name: 'read_file', input: { path: 'a.ts' } },
  { type: 'text', index: 2, content: 'Final answer' },
]

describe('ChatMessage reasoning visibility', () => {
  let storage: Map<string, string>
  beforeEach(() => {
    storage = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('shows reasoning by default', () => {
    const html = render({ contentBlocks: thinkingThenAnswer })
    expect(html).toContain('Secret plan')
    expect(html).toContain('tool-card')
    expect(html).toContain('Final answer')
  })

  it('hides persisted reasoning but keeps tools and the answer', () => {
    storage.set(HIDE_REASONING_BLOCKS_KEY, 'true')
    const html = render({ contentBlocks: thinkingThenAnswer })
    expect(html).not.toContain('Secret plan')
    expect(html).not.toContain('Reasoning')
    expect(html).toContain('tool-card')
    expect(html).toContain('Final answer')
  })

  it('draws nothing for a reasoning-only row while hidden', () => {
    storage.set(HIDE_REASONING_BLOCKS_KEY, 'true')
    expect(render({ contentBlocks: [{ type: 'thinking', index: 0, content: 'Secret plan' }] })).toBe('')
  })

  it('hides live reasoning deltas', () => {
    storage.set(HIDE_REASONING_BLOCKS_KEY, 'true')
    const html = render({ streamEvents: [
      { type: 'reasoning', delta: 'Secret plan' },
      { type: 'text', delta: 'Streaming answer' },
    ] as StreamEvent[] })
    expect(html).not.toContain('Secret plan')
    expect(html).toContain('Streaming answer')
  })
})
