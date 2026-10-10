import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('framer-motion', () => ({ useReducedMotion: () => false }))
vi.mock('../ThemeManager/themeConfig', () => ({
  useCustomChatTheme: () => ({ theme: { colors: { toolJobsMutedText: { light: '#737373', dark: '#a3a3a3' } } }, enabled: true }),
  useHtmlDarkMode: () => false,
  getThemeModeColor: (pair: { light: string }) => pair.light,
}))
import { StreamingThinkingIndicator } from './StreamingThinkingIndicator'

describe('StreamingThinkingIndicator', () => {
  it('keeps normal streaming text without a compaction bar', () => {
    const html = renderToStaticMarkup(<StreamingThinkingIndicator />)
    expect(html).toContain('Thinking')
    expect(html).toContain('rounded-md px-2.5 py-0.5')
    expect(html).not.toContain('role="progressbar"')
  })

  it.each(['inline', 'tab'] as const)('shows compacting with indeterminate semantics in %s placement', variant => {
    const html = renderToStaticMarkup(<StreamingThinkingIndicator variant={variant} compacting />)
    expect(html).toContain('>Compacting</span>')
    expect(html).toContain('tool-name-shimmer')
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('flex min-w-[5.75rem] items-center gap-2')
    expect(html).toContain('h-[2px] w-16 shrink-0')
    expect(html.indexOf('>Compacting</span>')).toBeLessThan(html.indexOf('role="progressbar"'))
    expect(html).toContain('duration unknown')
    expect(html).not.toContain('aria-valuenow=')
    expect(html).not.toContain('streaming-pixel')
    expect(html).toContain('color:#737373')
  })

  it('fills instantly on confirmed completion and stops shimmer', () => {
    const html = renderToStaticMarkup(<StreamingThinkingIndicator compacting compactionCompleted />)
    expect(html).toContain('>Compacted</span>')
    expect(html).toContain('data-completed="true"')
    expect(html).toContain('aria-valuenow="100"')
    expect(html).not.toContain('tool-name-shimmer')
  })
})
