import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ContextInjectionCard } from './ContextInjectionCard'
import { DISCLOSURE_LABEL_CLASS, QUIET_ROW_CLASS } from './chatMessageShared'
import type { CustomChatTheme } from '../ThemeManager/themeConfig'

vi.mock('../ThemeManager/themeConfig', () => ({
  useHtmlDarkMode: () => false,
  getCustomChatThemeEnabled: () => false,
  getThemeModeColor: (pair: { light: string; dark: string }, dark: boolean) => dark ? pair.dark : pair.light,
}))

const entries = [{ path: 'docs/agent_context/agent_custom_tools.md', label: 'Tool instructions', text: 'Private expanded content', reason: 'path_glob_match' }]

const colors = Object.fromEntries([
  'contextCardBg', 'contextCardHoverBg', 'contextCardTitleText', 'contextCardMetaText',
  'contextCardPathText', 'contextCardMutedText', 'contextCardBadgeBg', 'contextCardBadgeText',
  'contextCardCodeBg', 'contextCardCodeText',
].map(key => [key, { light: '#345678', dark: '#abcdef' }]))
const theme = { colors } as unknown as CustomChatTheme

describe('ContextInjectionCard quiet rows', () => {
  it.each(['inline', 'launch'] as const)('shares quiet geometry for %s context', variant => {
    const html = renderToStaticMarkup(<ContextInjectionCard entries={entries} variant={variant} customThemeEnabled={false} />)
    expect(html).toContain(QUIET_ROW_CLASS)
    expect(html).toContain(DISCLOSURE_LABEL_CLASS)
    expect(html).toContain('Path rule matched')
    expect(html).toContain('1 file')
    expect(html).toContain('width="16"')
    expect(html).toContain('width="14"')
    expect(html).toContain('title="docs/agent_context/agent_custom_tools.md"')
    expect(html).not.toContain('backdrop-blur')
    expect(html).not.toContain('rounded-2xl')
    expect(html).not.toContain('text-violet')
    expect(html).not.toContain('Private expanded content')
    expect(html).toContain('aria-expanded="false"')
    const panelId = html.match(/aria-controls="([^"]+)"/)?.[1]
    expect(panelId).toBeTruthy()
    expect(html).toContain(`id="${panelId}"`)
  })

  it.each([false, true])('preserves custom text colors without a resting surface, dark=%s', dark => {
    const html = renderToStaticMarkup(<ContextInjectionCard entries={entries} customTheme={theme} customThemeEnabled isDarkMode={dark} fontSizeOffset={2} />)
    expect(html).toContain(`color:${dark ? '#abcdef' : '#345678'}`)
    expect(html).not.toContain('background-color:')
    expect(html).toContain('font-size:calc(1em + 2px)')
  })

  it('does not render empty context', () => {
    expect(renderToStaticMarkup(<ContextInjectionCard entries={[]} />)).toBe('')
  })
})
