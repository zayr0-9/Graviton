import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RunningAgentsFloatingButton } from './RunningAgentsFloatingButton'

const themeState = vi.hoisted(() => ({ enabled: true, dark: false, tint: { light: '#aabbcc', dark: '#112233' } }))
vi.mock('../ThemeManager/themeConfig', async importOriginal => {
  const actual = await importOriginal<typeof import('../ThemeManager/themeConfig')>()
  return {
    ...actual,
    useCustomChatTheme: () => {
      const theme = actual.createDefaultCustomChatTheme()
      return { enabled: themeState.enabled, theme: {
        ...theme,
        colors: { ...theme.colors, streamingAnimationColor: themeState.tint },
      } }
    },
    useHtmlDarkMode: () => themeState.dark,
  }
})
vi.mock('../ChatSelection/ChatSelectionProvider', () => ({ useChatNavigate: () => vi.fn() }))
vi.mock('../../features/chats', () => ({
  selectCurrentConversationId: () => null,
  selectCurrentPath: () => [],
}))
vi.mock('../../hooks/redux', () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: (selector: (state: any) => unknown) => selector({ ui: { notifications: [] } }),
}))
vi.mock('../../hooks/useRunningAgentStreams', () => ({
  useRunningAgentStreams: () => ({ activeStreams: [], streamHistory: [], streamingRoot: { byId: {} } }),
  buildAgentForkGroups: () => ({ activeForks: [], historyForks: [] }),
}))
vi.mock('../../hooks/useQueries', () => ({ useConversationBranchDebugData: () => ({}) }))
vi.mock('./useAgentsPillResize', () => ({
  useAgentsPillResize: () => ({ size: null, limits: { width: 1000 }, dragging: false }),
}))
vi.mock('./AgentRunPreview', () => ({ AgentRunPreview: () => null }))
vi.mock('./AgentsMonitorGrid', () => ({ AgentsMonitorGrid: () => null }))

const render = () => renderToStaticMarkup(<RunningAgentsFloatingButton onOpenApps={() => {}} />)

describe('agents pill theme tint', () => {
  beforeEach(() => {
    themeState.enabled = true
    themeState.dark = false
    themeState.tint = { light: '#aabbcc', dark: '#112233' }
  })

  it.each([false, true])('borrows streamingAnimationColor for both gradient layers (dark=%s)', dark => {
    themeState.dark = dark
    const html = render()
    const rgb = dark ? '17, 34, 51' : '170, 187, 204'
    expect(html).toContain(`radial-gradient(circle at 16% 0%, rgba(${rgb}, 0.18), transparent 42%)`)
    expect(html).toContain(`linear-gradient(135deg, rgba(${rgb}, 0.22), transparent 56%)`)
    // Settings primary-button blue and accent purple must not tint the shell.
    expect(html).not.toContain(`rgba(${dark ? '37, 99, 235' : '59, 130, 246'}, 0.18)`)
    expect(html).not.toContain('rgba(139, 92, 246, 0.15) 22%')
  })

  it('accepts CSS color expressions from custom themes', () => {
    themeState.tint.light = 'var(--brand-color)'
    const html = render()
    expect(html).toContain('color-mix(in srgb, var(--brand-color) 18%, transparent)')
    expect(html).toContain('color-mix(in srgb, var(--brand-color) 22%, transparent)')
  })

  it('uses the existing neutral fallback when the custom theme is disabled', () => {
    themeState.enabled = false
    const html = render()
    expect(html).not.toContain('radial-gradient')
    expect(html).not.toContain('linear-gradient')
    expect(html).toContain('bg-white/75')
    expect(html).toContain('dark:bg-yBlack-900/75')
  })
})
