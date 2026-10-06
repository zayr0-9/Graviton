import { cloneElement, createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import LoggingDashboard from './LoggingDashboard'

const state = vi.hoisted(() => ({ enabled: false, data: undefined as unknown }))
// SSR has no layout measurements. Keep real Recharts rendering, but supply dimensions.
vi.mock('recharts', async importOriginal => {
  const actual = await importOriginal<typeof import('recharts')>()
  return { ...actual, ResponsiveContainer: ({ children }: { children: ReactElement }) =>
    cloneElement(children as ReactElement<{ width: number; height: number }>, { width: 500, height: 256 }) }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))
vi.mock('framer-motion', () => ({ useReducedMotion: () => true }))
vi.mock('../config/runtimeMode', () => ({ isCommunityMode: false }))
vi.mock('../components/ThemeManager/themeConfig', () => ({ useCustomChatTheme: () => ({ enabled: false, theme: { colors: {} } }),
  useHtmlDarkMode: () => false, getThemeModeColor: () => undefined }))
vi.mock('../hooks/useLoggingAnalytics', () => ({
  useCloudLoggingAnalytics: () => ({ data: state.data, isEnabled: state.enabled, isFetching: false, error: null,
    dataUpdatedAt: 0, refetch: vi.fn() }),
  useLocalLoggingAnalytics: () => ({ data: undefined, isEnabled: false, isFetching: false, error: null, dataUpdatedAt: 0, refetch: vi.fn() }),
}))

beforeEach(() => { state.data = undefined; state.enabled = false })
describe('logging dashboard chrome', () => {
  it('uses labelled icon actions, section navigation, and an honest supported range', () => {
    const html = renderToStaticMarkup(createElement(LoggingDashboard))
    expect(html).toContain('Usage &amp; reliability')
    expect(html).toContain('aria-label="Back"')
    expect(html).toContain('aria-label="Refresh analytics"')
    expect(html).toContain('aria-label="Analytics sections"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('Last 365 days')
    expect(html).not.toContain('9999')
    expect(html).not.toContain('shadow-')
    expect(html).not.toContain('transition-all')
  })
  it('suppresses stale cloud account data while signed out', () => {
    state.data = { filters: { available: { projects: [{ id: 'private-project', name: 'Private account project' }], conversations: [], models: [] } } }
    const html = renderToStaticMarkup(createElement(LoggingDashboard))
    expect(html).not.toContain('Private account project')
    expect(html).not.toContain('private-project')
    expect(html).toContain('Sign in to load cloud analytics')
  })
})

describe('logging dashboard charts', () => {
  it('renders real line and bar series with axes for populated overview data', () => {
    state.enabled = true
    state.data = {
      rangeDays: 30,
      filters: { available: { projects: [], conversations: [], models: [] } },
      summary: { netCreditsConsumed: 2, messagesTotal: 5, activeDays: 1 },
      spend: { daily: [{ date: '2026-10-01', netCreditsConsumed: 2 }],
        burnRate: { creditsPerDay: 2, projectedDaysRemaining: null } },
      models: { topByCredits: [], tokenMixByModel: [] },
      activity: { messagesPerDay: [{ date: '2026-10-01', count: 5 }], messagesByRole: { assistant: 5 } },
      tools: { requested: { byName: {} }, jobs: { total: 0, byTool: [] } },
      payments: { currentPlan: null, currentCreditsBalance: null, history: { monthlyAllocation: [], topups: [] } },
    }
    const html = renderToStaticMarkup(createElement(LoggingDashboard))
    expect(html).toContain('recharts-line-dots')
    expect(html).toContain('recharts-dot')
    expect(html).toContain('recharts-bar-rectangle')
    expect(html.match(/recharts-xAxis/g)).toHaveLength(2)
    expect(html.match(/recharts-yAxis/g)).toHaveLength(2)
  })
})
