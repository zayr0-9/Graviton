import { describe, expect, it } from 'vitest'
import { createDefaultCustomChatTheme, sanitizeCustomTheme } from './themeConfig'

describe('Agents pill grid background theme keys', () => {
  it('fills missing keys in older themes with distinct light and dark defaults', () => {
    const theme = sanitizeCustomTheme({ colors: { settingsCustomThemesInnerCardBg: { light: '#ffffff', dark: '#000000' } } })
    const defaults = createDefaultCustomChatTheme()
    expect(theme.colors.agentsGridStreamingCardBg).toEqual(defaults.colors.agentsGridStreamingCardBg)
    expect(theme.colors.agentsGridIdleCardBg).toEqual(defaults.colors.agentsGridIdleCardBg)
    for (const mode of ['light', 'dark'] as const) {
      expect(theme.colors.agentsGridStreamingCardBg[mode]).not.toBe(theme.colors.agentsGridIdleCardBg[mode])
    }
  })

  it('preserves independently customized streaming and idle colors', () => {
    const colors = {
      agentsGridStreamingCardBg: { light: '#aabbcc', dark: '#112233' },
      agentsGridIdleCardBg: { light: '#ddeeff', dark: '#445566' },
    }
    const theme = sanitizeCustomTheme({ colors })
    expect(theme.colors.agentsGridStreamingCardBg).toEqual(colors.agentsGridStreamingCardBg)
    expect(theme.colors.agentsGridIdleCardBg).toEqual(colors.agentsGridIdleCardBg)
  })
})
