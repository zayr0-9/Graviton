import { describe, expect, it } from 'vitest'
import { createDefaultCustomChatTheme, sanitizeCustomTheme } from './themeConfig'

describe('Agents pill grid background theme keys', () => {
  it('fills missing keys in older themes with distinct light and dark defaults', () => {
    const theme = sanitizeCustomTheme({ colors: { settingsCustomThemesInnerCardBg: { light: '#ffffff', dark: '#000000' } } })
    const defaults = createDefaultCustomChatTheme()
    expect(theme.colors.agentsGridStreamingCardBg).toEqual(defaults.colors.agentsGridStreamingCardBg)
    expect(theme.colors.agentsGridIdleCardBg).toEqual(defaults.colors.agentsGridIdleCardBg)
    expect(theme.colors.agentsGridStreamingCardBg.light).toBe('var(--agents-grid-streaming-bg)')
    expect(theme.colors.agentsGridIdleCardBg.dark).toBe('var(--agents-grid-idle-bg)')
    for (const mode of ['light', 'dark'] as const) {
      expect(theme.colors.agentsGridStreamingCardBg[mode]).not.toBe(theme.colors.agentsGridIdleCardBg[mode])
    }
  })

  it('migrates earlier fixed defaults while preserving per-mode overrides', () => {
    const theme = sanitizeCustomTheme({ colors: {
      agentsGridStreamingCardBg: { light: 'rgba(16, 185, 129, 0.12)', dark: '#112233' },
      agentsGridIdleCardBg: { light: '#ddeeff', dark: 'rgba(255, 255, 255, 0.05)' },
    } })
    expect(theme.colors.agentsGridStreamingCardBg).toEqual({ light: 'var(--agents-grid-streaming-bg)', dark: '#112233' })
    expect(theme.colors.agentsGridIdleCardBg).toEqual({ light: '#ddeeff', dark: 'var(--agents-grid-idle-bg)' })
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
