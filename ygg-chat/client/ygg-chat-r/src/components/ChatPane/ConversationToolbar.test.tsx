import { useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react', async original => {
  const actual = await original<typeof import('react')>()
  return { ...actual, useState: vi.fn(actual.useState) }
})
import { ConversationToolbar } from './ConversationToolbar'
import { createDefaultCustomChatTheme } from '../ThemeManager/themeConfig'

const theme = createDefaultCustomChatTheme()
const props = {
  title: 'Design review', backgroundColor: 'rgba(255,255,255,0.8)', treeVisible: true, cloning: false,
  customTheme: theme, customThemeEnabled: false, isDarkMode: false,
  onToggleTree: vi.fn(), onRefresh: vi.fn(), onClone: vi.fn(), onRename: vi.fn(), onEditingChange: vi.fn(),
}

beforeEach(() => {
  vi.mocked(useState).mockReset()
  vi.mocked(useState).mockImplementation((initial?: unknown): [unknown, ReturnType<typeof vi.fn>] => [typeof initial === 'function' ? initial() : initial, vi.fn()])
})

describe('ConversationToolbar', () => {
  it('keeps rename to one row with an accessible label and no idle helper-text padding', () => {
    vi.mocked(useState).mockReturnValueOnce([true, vi.fn()])
    const html = renderToStaticMarkup(<ConversationToolbar {...props} />)
    expect(html).toContain('aria-label="Rename conversation"')
    expect(html).toContain('class="sr-only">Conversation title')
    expect(html).toContain('aria-label="Save title"')
    expect(html).toContain('aria-label="Cancel rename"')
    expect(html).toContain('value="Design review"')
    expect(html).not.toContain('Enter to save · Escape to cancel')
    expect(html).not.toContain('pt-2 pb-1')
  })

  it('renders a compact copy confirmation with explicit cancel and copy actions', () => {
    vi.mocked(useState).mockReturnValueOnce([false, vi.fn()]).mockReturnValueOnce([true, vi.fn()])
    const html = renderToStaticMarkup(<ConversationToolbar {...props} />)
    expect(html).toContain('<dialog')
    expect(html).toContain('aria-labelledby=')
    expect(html).toContain('Copy conversation?')
    expect(html).toContain('The original stays unchanged.')
    expect(html).toContain('>Cancel</button>')
    expect(html).toContain('>Copy</button>')
    expect(html).not.toContain('Could not copy')
  })

  it('disables confirmation actions while copying', () => {
    vi.mocked(useState).mockReturnValueOnce([false, vi.fn()]).mockReturnValueOnce([true, vi.fn()])
    const html = renderToStaticMarkup(<ConversationToolbar {...props} cloning />)
    expect(html).toMatch(/disabled=""[^>]*>Cancel<\/button>/)
    expect(html).toMatch(/disabled=""[^>]*>Copying…<\/button>/)
  })

  it('shows the title and direct circular controls without a conversation list, outline, or shadow', () => {
    const html = renderToStaticMarkup(<ConversationToolbar {...props} />)
    expect(html).toContain('Design review')
    expect(html).toContain('aria-label="Edit conversation title"')
    expect(html).toContain('aria-label="Refresh messages"')
    expect(html).toContain('aria-label="Clone conversation"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('h-11 w-11')
    expect(html).toContain('backdrop-blur-[12px]')
    expect(html).toContain('background-color:rgba(255,255,255,0.8)')
    expect(html).not.toMatch(/combobox|listbox|<select|shadow-|border|transition-all/)
  })

  it('provides an untitled fallback, a tree toggle label, and a disabled clone state', () => {
    const html = renderToStaticMarkup(<ConversationToolbar {...props} title='' treeVisible={false} cloning />)
    expect(html).toContain('Untitled conversation')
    expect(html).toContain('aria-label="Show tree view"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('disabled=""')
    expect(html).toContain('aria-busy="true"')
  })

  it('uses semantic custom theme colors for title, controls, and active tree toggle', () => {
    const customTheme = createDefaultCustomChatTheme()
    customTheme.colors.toolJobsPrimaryText.dark = '#123456'
    customTheme.colors.settingsCustomThemesButtonBg.dark = '#234567'
    customTheme.colors.settingsCustomThemesButtonText.dark = '#345678'
    customTheme.colors.composerToggleActiveBg.dark = '#456789'
    customTheme.colors.composerToggleActiveText.dark = '#56789a'
    const html = renderToStaticMarkup(<ConversationToolbar {...props} customTheme={customTheme} customThemeEnabled isDarkMode />)
    expect(html).toContain('color:#123456')
    expect(html).toContain('background-color:#234567;color:#345678')
    expect(html).toContain('background-color:#456789;color:#56789a')
  })
})
