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

  it('derives switch track and thumb colors from the active theme instead of blue/white', () => {
    const theme = createDefaultCustomChatTheme()
    theme.colors.composerToggleActiveText.light = '#6f4e37'
    theme.colors.composerToggleActiveBg.light = '#eedfce'
    theme.colors.settingsCustomThemesButtonBg.light = '#faf7f2'
    const style = getActionPopoverThemeStyle(theme, false) as Record<string, string>
    expect(style['--cloud-switch-on']).toBe('#6f4e37')
    expect(style['--cloud-switch-thumb-on']).toBe('#eedfce')
    expect(style['--cloud-switch-thumb']).toBe('#faf7f2')
    expect(style['--cloud-switch-off']).toContain(theme.colors.toolJobsMutedText.light)
    expect(style['--cloud-switch-off']).toContain(theme.colors.settingsCustomThemesCardBg.light)
  })
})
