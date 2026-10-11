import { describe, expect, it } from 'vitest'
import { createDefaultCustomChatTheme } from '../ThemeManager/themeConfig'
import { getActionPopoverThemeStyle } from './actionPopoverTheme'

describe('Shared soft popover palette', () => {
  it.each([false, true])('uses the card shell and distinct control states (dark=%s)', isDarkMode => {
    const theme = createDefaultCustomChatTheme()
    const mode = isDarkMode ? 'dark' : 'light'
    const style = getActionPopoverThemeStyle(theme, isDarkMode) as Record<string, string>
    expect(style['--cloud-surface']).toBe(`rgb(from ${theme.colors.settingsCustomThemesCardBg[mode]} r g b / 1)`)
    expect(style['--cloud-field']).toBe(theme.colors.settingsCustomThemesInnerCardBg[mode])
    expect(style['--cloud-button']).toBe(theme.colors.settingsCustomThemesButtonBg[mode])
    expect(style['--cloud-active-bg']).toBe(theme.colors.composerToggleActiveBg[mode])
    expect(style['--cloud-muted']).toBe(theme.colors.toolJobsMutedText[mode])
  })

  it.each([false, true])('uses secondary-button colors instead of subtle background tints for switch thumbs (dark=%s)', isDarkMode => {
    const theme = createDefaultCustomChatTheme()
    const mode = isDarkMode ? 'dark' : 'light'
    theme.colors.composerToggleActiveText[mode] = isDarkMode ? '#eeedf0' : '#6f4e37'
    theme.colors.composerToggleActiveBg[mode] = isDarkMode ? '#e1daf2' : '#eedfce'
    theme.colors.settingsCustomThemesButtonBg[mode] = isDarkMode ? '#242424' : '#faf7f2'
    theme.colors.settingsCustomThemesButtonText[mode] = isDarkMode ? '#eeedf0' : '#262626'
    const style = getActionPopoverThemeStyle(theme, isDarkMode) as Record<string, string>
    expect(style['--cloud-switch-on']).toBe(theme.colors.composerToggleActiveText[mode])
    expect(style['--cloud-switch-thumb-on']).toBe(theme.colors.settingsCustomThemesButtonBg[mode])
    expect(style['--cloud-switch-thumb']).toBe(theme.colors.settingsCustomThemesButtonText[mode])
    expect(style['--cloud-switch-thumb-on']).not.toBe(theme.colors.composerToggleActiveBg[mode])
    expect(style['--cloud-switch-off']).toContain(theme.colors.toolJobsMutedText[mode])
    expect(style['--cloud-switch-off']).toContain(theme.colors.settingsCustomThemesCardBg[mode])
  })
})
