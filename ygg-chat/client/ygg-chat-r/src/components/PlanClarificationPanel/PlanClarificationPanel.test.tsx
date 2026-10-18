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

describe('PlanClarificationPanel manual answers', () => {
  it('always renders a one-row manual input, capped at three lines', () => {
    const html = renderToStaticMarkup(<PlanClarificationPanel {...props} />)
    expect(html).toContain('Write my own answer')
    expect(html).toContain('rows="1"')
    expect(html).toContain('max-h-[76px]')
    expect(html).toContain('resize-none overflow-y-auto')
    expect(html).toContain('aria-label="Your answer: Which scope?"')
  })

  it('uses the custom manual label even when no suggested options exist', () => {
    const request = { id: 'freeform', questions: [{ question: 'What next?', manualLabel: 'Something else' }] }
    const html = renderToStaticMarkup(<PlanClarificationPanel {...props} request={request} />)
    expect(html).toContain('Something else')
    expect(html).toContain('<textarea')
  })

  it('keeps existing manual options without duplicating them', () => {
    const request = { ...props.request, questions: [{
      ...props.request.questions[0],
      options: [{ id: 'custom', label: 'Other answer', manual: true }],
    }] }
    const html = renderToStaticMarkup(<PlanClarificationPanel {...props} request={request} />)
    expect(html).toContain('Other answer')
    expect(html).not.toContain('Write my own answer')
  })

  it.each(['', '   ', 'My preferred approach'])('validates manual answer %j', manualText => {
    vi.mocked(useState).mockReturnValue([{ scope: { optionId: 'manual', manualText } }, vi.fn()])
    const submit = buttonMarkup(renderToStaticMarkup(<PlanClarificationPanel {...props} />), 'Submit answers')
    expect(submit.includes('disabled=""')).toBe(!manualText.trim())
  })

  it('does not confuse a model option named manual with the custom answer', () => {
    const request = { ...props.request, questions: [{
      ...props.request.questions[0], options: [{ id: 'manual', label: 'Manual installation' }],
    }] }
    vi.mocked(useState).mockReturnValue([{ scope: { optionId: 'manual', manualText: '' } }, vi.fn()])
    const html = renderToStaticMarkup(<PlanClarificationPanel {...props} request={request} />)
    expect(html).toContain('Write my own answer')
    expect(buttonMarkup(html, 'Submit answers')).not.toContain('disabled=""')
  })
})
