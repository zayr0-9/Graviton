import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RunStatisticsFooter } from './RunStatisticsFooter'
import { createDefaultCustomChatTheme } from '../ThemeManager/themeConfig'
import type { RunStatisticsFooterData } from '../../features/chats/runStatistics'

const statistics: RunStatisticsFooterData = {
  streamId: 'r', anchorMessageId: 'empty', status: 'aborted', durationMs: 42000,
  tools: { count: 3, coverage: 'recorded' }, tokens: { total: 0, covered: 0, responses: 0, coverage: 'unavailable' },
}

describe('RunStatisticsFooter', () => {
  it('renders stopped empty-text runs as standalone accessible chrome', () => {
    const html = renderToStaticMarkup(<RunStatisticsFooter statistics={statistics} />)
    expect(html).toContain('aria-label="Run statistics"')
    expect(html).toContain('Stopped · 42s · 3 tool calls · Tokens unavailable')
    expect(html).not.toContain('prose')
    expect(html).toContain('run-statistics-track')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('Slice tokens estimate transcript content once, excluding replayed history.')
  })
  it('uses custom muted colors without requiring a text response component', () => {
    const theme = createDefaultCustomChatTheme()
    theme.colors.toolJobsMutedText.dark = '#123456'
    const html = renderToStaticMarkup(<RunStatisticsFooter statistics={statistics} customTheme={theme} customThemeEnabled isDarkMode />)
    expect(html).toContain('color:#123456')
  })
})

it('reveals cumulative request usage without a per-role token breakdown', () => {
  const html = renderToStaticMarkup(<RunStatisticsFooter statistics={{ ...statistics, status: 'completed', tokens: {
    total: 120, covered: 2, responses: 2, coverage: 'estimated',
    breakdown: { total: 120, user: 20, assistant: 30, tools: 70 }, requestTotal: 100000, requestCoverage: 'reported',
  } }} />)
  expect(html).toContain('~120 tokens')
  expect(html).not.toContain('Slice estimate:')
  expect(html).not.toContain('20 user')
  expect(html).not.toContain('30 assistant/reasoning')
  expect(html).not.toContain('70 tools')
  expect(html).toContain('Request usage: 100K tokens cumulative')
})
