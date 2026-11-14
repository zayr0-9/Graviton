import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildChatErrorEnvelope } from '../../../../../shared/chatErrors'
import { ChatErrorBubble } from './ChatErrorBubble'
import { createDefaultCustomChatTheme } from '../ThemeManager/themeConfig'

const prefs = vi.hoisted(() => ({ enabled: false, dark: false }))
vi.mock('../ThemeManager/themeConfig', async importOriginal => {
  const actual = await importOriginal<typeof import('../ThemeManager/themeConfig')>()
  return { ...actual, useCustomChatTheme: () => ({ enabled: prefs.enabled, theme: actual.createDefaultCustomChatTheme() }), useHtmlDarkMode: () => prefs.dark }
})

describe('ChatErrorBubble', () => {
  beforeEach(() => { prefs.enabled = false; prefs.dark = false })

  it('explains a workspace change without suggesting an unchanged retry or exposing paths inline', () => {
    const html = renderToStaticMarkup(<ChatErrorBubble envelope={buildChatErrorEnvelope('claude_workspace_changed', {
      detail: 'Original folder: /private/workspace',
    })} onAction={() => {}} />)
    expect(html).toContain('Switch back to continue')
    expect(html).toContain('additional directory')
    expect(html).not.toContain('Try again')
    expect(html).not.toContain('/private/workspace')
    expect(html).toContain('Details')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-controls=')
    expect(html).toContain('role="alert"')
  })

  it('uses a calm borderless surface and retains accessible disabled actions and dismissal', () => {
    const html = renderToStaticMarkup(<ChatErrorBubble envelope={buildChatErrorEnvelope('internal_error')}
      onAction={() => {}} onDismiss={() => {}} actionPending />)
    expect(html).toContain('rounded-2xl')
    expect(html).toContain('backdrop-blur-xl')
    expect(html).not.toMatch(/border-rose|bg-rose|shadow-/)
    expect(html).toContain('disabled=""')
    expect(html).toContain('aria-label="Dismiss"')
    expect(html).toContain('title="Dismiss"')
    expect(html).toContain('focus-visible:ring-2')
  })

  it.each([false, true])('themes surface, text and buttons in dark mode %s', dark => {
    prefs.enabled = true; prefs.dark = dark
    const theme = createDefaultCustomChatTheme()
    const mode = dark ? 'dark' : 'light'
    const html = renderToStaticMarkup(<ChatErrorBubble envelope={buildChatErrorEnvelope('internal_error')}
      onAction={() => {}} style={{ fontSize: '15px' }} />)
    expect(html).toContain(`background-color:${theme.colors.settingsCustomThemesCardBg[mode]}`)
    expect(html).toContain(`color:${theme.colors.toolJobsPrimaryText[mode]}`)
    expect(html).toContain(`background-color:${theme.colors.settingsCustomThemesButtonBg[mode]}`)
    expect(html).toContain('font-size:15px')
  })
})
