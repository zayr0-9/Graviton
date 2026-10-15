import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FullAccessNotice } from './FullAccessNotice'
import { OperationModeNotice } from './OperationModeNotice'
import { isFullAccessNotification, isRunSettingsNotification } from '../../../../../shared/accessNotifications'

vi.mock('../ThemeManager/themeConfig', () => ({
  useCustomChatTheme: () => ({ enabled: true, theme: { colors: { toolJobsMutedText: { light: '#111111', dark: '#123456' } } } }),
  useHtmlDarkMode: () => true,
  getThemeModeColor: (pair: { light: string; dark: string }, dark: boolean) => dark ? pair.dark : pair.light,
}))

describe('FullAccessNotice', () => {
  it('shares exact mode-notice chrome and custom-theme text', () => {
    const access = renderToStaticMarkup(<FullAccessNotice />)
    const mode = renderToStaticMarkup(<OperationModeNotice mode='execute' />)
    const chrome = 'flex h-8 min-w-0 w-full items-center gap-2 px-2.5 text-neutral-500 dark:text-neutral-400'
    expect(access).toContain(chrome)
    expect(mode).toContain(chrome)
    expect(access).toContain('color:#123456')
    expect(mode).toContain('color:#123456')
    expect(access).toContain('Full access enabled')
    expect(access).toContain('Approvals still apply')
    expect(mode).toContain('Switched to Agent')
    expect(mode).toContain('text-[0.8125em] font-medium')
    expect(mode).toContain('text-[0.75em]')
    expect(mode).toContain('width="16"')
    expect(mode).not.toContain('<button')
    expect(mode).not.toContain('opacity-70')
  })
  it('uses provenance, not lookalike prose, and keeps access separate from mode', () => {
    expect(isFullAccessNotification({ meta: '{"kind":"full_access_change"}' })).toBe(true)
    expect(isRunSettingsNotification({ meta: { kind: 'full_access_change' } })).toBe(true)
    expect(isRunSettingsNotification({ meta: { kind: 'operation_mode_change', mode: 'plan' } })).toBe(true)
    expect(isFullAccessNotification({ meta: { kind: 'operation_mode_change' } })).toBe(false)
    expect(isFullAccessNotification({ content: 'Full access enabled', meta: '{bad' })).toBe(false)
  })
})
