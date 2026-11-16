import { describe, expect, it } from 'vitest'
import { createDefaultCustomChatTheme } from '../ThemeManager/themeConfig'
import { getCompactComposerThemeStyle, getCompactMenuPosition } from './compactComposerPresentation'

describe('compact composer presentation', () => {
  it('anchors 8px above the input, not the viewport top', () => {
    expect(getCompactMenuPosition({ top: 700, left: 16, width: 358 }, {
      top: 0, left: 0, width: 390, height: 844, layoutHeight: 844,
    })).toEqual({ left: 16, width: 358, bottom: 152, maxHeight: 684 })
  })
  it('uses the full pane width for Activity with an 8px edge inset', () => {
    expect(getCompactMenuPosition({ top: 700, left: 120, width: 480 }, {
      top: 0, left: 0, width: 1100, height: 844, layoutHeight: 844,
    }, { left: 100, width: 650 })).toEqual({ left: 108, width: 634, bottom: 152, maxHeight: 684 })
  })
  it('bounds the popup to the keyboard/panned visual viewport', () => {
    const result = getCompactMenuPosition({ top: 760, left: -20, width: 500 }, {
      top: 100, left: 10, width: 320, height: 400, layoutHeight: 844,
    })
    expect(result).toEqual({ left: 18, width: 304, bottom: 352, maxHeight: 384 })
  })
  it.each([false, true])('uses semantic theme colors with local translucency (dark=%s)', dark => {
    const theme = createDefaultCustomChatTheme()
    const mode = dark ? 'dark' : 'light'
    theme.colors.settingsCustomThemesCardBg[mode] = '#123456'
    theme.colors.toolJobsPrimaryText[mode] = '#abcdef'
    theme.colors.toolJobsMutedText[mode] = '#789abc'
    theme.colors.settingsCustomThemesButtonText[mode] = '#fedcba'
    const style = getCompactComposerThemeStyle(theme, dark) as Record<string, string>
    expect(style['--quiet-glass']).toBe('color-mix(in srgb, #123456 88%, transparent)')
    expect(style['--quiet-text']).toBe('#abcdef')
    expect(style['--quiet-muted']).toBe('#789abc')
    expect(style['--quiet-control-text']).toBe('#fedcba')
    expect(style['--cloud-active-text']).toBe(theme.colors.composerToggleActiveText[mode])
  })
})
