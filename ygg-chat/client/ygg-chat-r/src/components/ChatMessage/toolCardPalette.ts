import type { CSSProperties } from 'react'
import { modulateColor, type ColorModulation } from '../ThemeManager/colorModulation'
import { getThemeModeColor, type CustomChatTheme, type ThemeColorPair } from '../ThemeManager/themeConfig'

/**
 * Key/value palette for tool cards, derived from the active theme at render time.
 *
 * Each slot borrows an existing `markdownSyntax*` token and modulates it (saturation, lightness,
 * alpha) per mode, so a tool card and a JSON code block agree under any theme while the card stays
 * calmer than highlighted code. The sources follow the highlight.js mapping in `index.css`:
 * `.hljs-attr` (JSON keys) is the variable colour, `.hljs-string` the string colour,
 * `.hljs-number`/`.hljs-literal` the number colour, `.hljs-punctuation` the punctuation colour.
 *
 * Tune the look here. Keep it to two accent hues plus neutrals: keys and literals carry colour,
 * nested strings are pulled most of the way back to the text colour, and top-level string values
 * are plain text. Do not add theme tokens for this surface.
 */

type ThemeColors = CustomChatTheme['colors']

/** Theme colour keys that hold a light/dark pair (excludes the role and node maps). */
export type ThemeColorPairKey = {
  [K in keyof ThemeColors]: ThemeColors[K] extends ThemeColorPair ? K : never
}[keyof ThemeColors]

export type ToolCardSlot = 'key' | 'text' | 'string' | 'literal' | 'punctuation'

export interface ToolCardSlotSpec {
  source: ThemeColorPairKey
  light?: ColorModulation
  dark?: ColorModulation
}

export const TOOL_CARD_PALETTE: Readonly<Record<ToolCardSlot, ToolCardSlotSpec>> = {
  /** Field names, top-level and nested. */
  key: { source: 'markdownSyntaxVariable', light: { saturate: 0.8 }, dark: { saturate: 0.75 } },
  /** Plain values and the base colour of tokenised JSON, a step quieter than prose code. */
  text: { source: 'markdownSyntaxBase', light: { lighten: 8 }, dark: { lighten: -12 } },
  /** Strings nested inside objects and arrays. Mostly desaturated so a list of them is not a wall of colour. */
  string: { source: 'markdownSyntaxString', light: { saturate: 0.55 }, dark: { saturate: 0.5, lighten: -6 } },
  /** Numbers, booleans and null. */
  literal: { source: 'markdownSyntaxNumber', light: { saturate: 0.85 }, dark: { saturate: 0.8 } },
  /** The colon after a key and the braces, brackets, commas and quotes of nested JSON. */
  punctuation: { source: 'markdownSyntaxPunctuation', light: { alpha: 0.75 }, dark: { alpha: 0.75 } },
}

export type ToolCardThemeCssVariable = '--tool-key' | '--tool-text' | '--tool-string' | '--tool-literal' | '--tool-punctuation'

export const TOOL_CARD_CSS_VARIABLES: Readonly<Record<ToolCardSlot, ToolCardThemeCssVariable>> = {
  key: '--tool-key',
  text: '--tool-text',
  string: '--tool-string',
  literal: '--tool-literal',
  punctuation: '--tool-punctuation',
}

export type ToolCardThemeCssProperties = CSSProperties & Record<ToolCardThemeCssVariable, string>

export const resolveToolCardSlotColor = (theme: CustomChatTheme, slot: ToolCardSlot, isDarkMode: boolean): string => {
  const spec = TOOL_CARD_PALETTE[slot]
  const base = getThemeModeColor(theme.colors[spec.source], isDarkMode)
  return modulateColor(base, (isDarkMode ? spec.dark : spec.light) ?? {})
}

/**
 * The `--tool-*` variables for one theme and mode. `ChatMessage` memoizes this per message (the
 * default theme stands in while the custom theme is off, like `getMarkdownThemeVars`) and
 * `ToolCallGroupCard` sets it on every card wrapper.
 */
export const getToolCardThemeVars = (theme: CustomChatTheme, isDarkMode: boolean): ToolCardThemeCssProperties => {
  const vars = {} as Record<ToolCardThemeCssVariable, string>
  for (const slot of Object.keys(TOOL_CARD_PALETTE) as ToolCardSlot[]) {
    vars[TOOL_CARD_CSS_VARIABLES[slot]] = resolveToolCardSlotColor(theme, slot, isDarkMode)
  }
  return vars
}
