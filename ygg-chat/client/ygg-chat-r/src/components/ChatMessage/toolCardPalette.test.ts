import { describe, expect, it } from 'vitest'
import { parseCssColor, rgbaToHsla } from '../ThemeManager/colorModulation'
import { createDefaultCustomChatTheme, type CustomChatTheme } from '../ThemeManager/themeConfig'
import {
  getToolCardThemeVars,
  resolveToolCardSlotColor,
  TOOL_CARD_CSS_VARIABLES,
  TOOL_CARD_PALETTE,
  type ThemeColorPairKey,
} from './toolCardPalette'

const HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/

const themeWith = (overrides: Partial<Pick<CustomChatTheme['colors'], ThemeColorPairKey>>): CustomChatTheme => {
  const theme = createDefaultCustomChatTheme()
  return { ...theme, colors: { ...theme.colors, ...overrides } }
}

const hslOf = (color: string) => rgbaToHsla(parseCssColor(color)!)

describe('getToolCardThemeVars', () => {
  it.each([false, true])('resolves every slot to hex for the default theme (dark=%s)', isDarkMode => {
    const vars = getToolCardThemeVars(createDefaultCustomChatTheme(), isDarkMode)
    for (const variable of Object.values(TOOL_CARD_CSS_VARIABLES)) {
      expect(vars[variable]).toMatch(HEX)
    }
    expect(Object.keys(vars)).toHaveLength(Object.keys(TOOL_CARD_PALETTE).length)
  })

  it('is deterministic for equal inputs', () => {
    const theme = createDefaultCustomChatTheme()
    expect(getToolCardThemeVars(theme, true)).toEqual(getToolCardThemeVars(theme, true))
  })

  it('keeps keys and literals on distinct hues from the text in both default modes', () => {
    for (const isDarkMode of [false, true]) {
      const vars = getToolCardThemeVars(createDefaultCustomChatTheme(), isDarkMode)
      expect(vars['--tool-key']).not.toBe(vars['--tool-text'])
      expect(vars['--tool-literal']).not.toBe(vars['--tool-text'])
      expect(vars['--tool-key']).not.toBe(vars['--tool-literal'])
    }
  })
})

describe('resolveToolCardSlotColor', () => {
  it('derives the key colour from the syntax variable token with reduced saturation', () => {
    const theme = themeWith({ markdownSyntaxVariable: { light: '#ff0000', dark: '#00ff00' } })
    const light = hslOf(resolveToolCardSlotColor(theme, 'key', false))
    expect(light.h).toBeCloseTo(0, 0)
    expect(light.s).toBeCloseTo(80, 0)
    expect(light.l).toBeCloseTo(50, 0)
    const dark = hslOf(resolveToolCardSlotColor(theme, 'key', true))
    expect(dark.h).toBeCloseTo(120, 0)
    expect(dark.s).toBeCloseTo(75, 0)
    expect(dark.l).toBeCloseTo(50, 0)
  })

  it('lightens the text slot in light mode and darkens it in dark mode', () => {
    const theme = themeWith({ markdownSyntaxBase: { light: '#000000', dark: '#ffffff' } })
    expect(resolveToolCardSlotColor(theme, 'text', false)).toBe('#141414')
    expect(resolveToolCardSlotColor(theme, 'text', true)).toBe('#e0e0e0')
  })

  it('makes punctuation translucent', () => {
    const theme = themeWith({ markdownSyntaxPunctuation: { light: '#475569', dark: '#a8a29e' } })
    expect(resolveToolCardSlotColor(theme, 'punctuation', false)).toBe('#475569bf')
    expect(resolveToolCardSlotColor(theme, 'punctuation', true)).toBe('#a8a29ebf')
  })

  it('passes an unparseable theme value through untouched', () => {
    const theme = themeWith({ markdownSyntaxNumber: { light: 'rebeccapurple', dark: 'rebeccapurple' } })
    expect(resolveToolCardSlotColor(theme, 'literal', false)).toBe('rebeccapurple')
  })
})
