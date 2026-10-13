import { useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlanClarificationPanel } from './PlanClarificationPanel'
import { createDefaultCustomChatTheme } from '../ThemeManager/themeConfig'

vi.mock('react', async original => {
  const actual = await original<typeof import('react')>()
  return { ...actual, useState: vi.fn(actual.useState) }
})

vi.mock('../ThemeManager/themeConfig', async original => {
  const actual = await original<typeof import('../ThemeManager/themeConfig')>()
  return {
    ...actual,
    useCustomChatTheme: () => ({ theme, enabled }),
    useHtmlDarkMode: () => dark,
  }
})

const theme = createDefaultCustomChatTheme()
let enabled = true
let dark = false
const props = {
  request: { id: 'clarification-test', questions: [{ id: 'scope', question: 'Which scope?', options: [{ id: 'minimal', label: 'Minimal' }] }] },
  onSubmit: vi.fn(),
  onCancel: vi.fn(),
}

beforeEach(() => {
  enabled = true
  dark = false
  vi.mocked(useState).mockReset()
  vi.mocked(useState).mockReturnValue([{}, vi.fn()])
})

const buttonMarkup = (html: string, label: string) => {
  const button = html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0]
  expect(button).toBeDefined()
  return button!
}

describe('PlanClarificationPanel button colours', () => {
  it.each([false, true])('uses secondary theme colours for Cancel and disabled Submit (dark=%s)', isDark => {
    dark = isDark
    const mode = dark ? 'dark' : 'light'
    theme.colors.settingsCustomThemesButtonBg[mode] = '#123456'
    theme.colors.settingsCustomThemesButtonText[mode] = '#abcdef'
    const html = renderToStaticMarkup(<PlanClarificationPanel {...props} />)
    const cancel = buttonMarkup(html, 'Cancel')
    const submit = buttonMarkup(html, 'Submit answers')
    expect(cancel).toContain('background-color:#123456;color:#abcdef')
    expect(submit).toContain('background-color:#123456;color:#abcdef;opacity:0.5')
    expect(submit).toContain('disabled=""')
  })

  it.each([false, true])('uses primary theme colours for enabled Submit (dark=%s)', isDark => {
    dark = isDark
    const mode = dark ? 'dark' : 'light'
    theme.colors.settingsCustomThemesPrimaryButtonBg[mode] = '#654321'
    theme.colors.settingsCustomThemesPrimaryButtonText[mode] = '#fedcba'
    vi.mocked(useState).mockReturnValue([{ scope: { optionId: 'minimal', manualText: '' } }, vi.fn()])
    const submit = buttonMarkup(renderToStaticMarkup(<PlanClarificationPanel {...props} />), 'Submit answers')
    expect(submit).toContain('background-color:#654321;color:#fedcba')
    expect(submit).not.toContain('disabled=""')
    expect(submit).not.toContain('opacity:0.5')
  })

  it('keeps default button styles when custom themes are disabled', () => {
    enabled = false
    const html = renderToStaticMarkup(<PlanClarificationPanel {...props} />)
    expect(buttonMarkup(html, 'Cancel')).not.toContain('style=')
    expect(buttonMarkup(html, 'Submit answers')).not.toContain('style=')
  })
})
