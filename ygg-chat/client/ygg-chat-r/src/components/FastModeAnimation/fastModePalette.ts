import type { CSSProperties } from 'react'
import type { OperationMode } from '../../features/chats/chatTypes'
import { getThemeModeColor, type CustomChatTheme } from '../ThemeManager/themeConfig'

export const resolveComposerAgentTint = (dark: boolean, theme?: CustomChatTheme, border?: {
  animation: string
  lightColor: string
  darkColor: string
}): string => {
  if (theme) return getThemeModeColor(theme.colors.chatInputAreaBorder, dark)
  if (border && border.animation !== 'none') return dark ? border.darkColor : border.lightColor
  return dark ? '#c2410c' : '#93c5fd'
}

export const getFastModePalette = (dark: boolean, operationMode: OperationMode, theme?: CustomChatTheme,
  agentTint = resolveComposerAgentTint(dark, theme)): CSSProperties => {
  const surface = theme ? getThemeModeColor(theme.colors.chatPanelBg, dark) : dark ? '#172336' : '#eef2f7'
  // Resolve the tint's hue without its border opacity, then control layer strength here.
  // Chat stays near the neutral theme surface; Agent uses the existing composer tint.
  const accent = operationMode === 'execute'
    ? `rgb(from ${agentTint} r g b / 1)`
    : theme
      ? `color-mix(in srgb, ${surface} 78%, ${dark ? '#a5b8ce' : '#91a5c0'})`
      : dark ? '#6a88ae' : '#91a5c0'
  const mix = (color: string, amount: number, base = surface) => `color-mix(in srgb, ${color} ${amount}%, ${base})`
  // Pastel/theme accents can be almost as light as the surface. Separate luminance,
  // not hue: darker moving colors on light surfaces, brighter colors on dark ones.
  // Clamp only the layer color; leave the mode-colored background restrained.
  const layer = `oklch(from ${accent} clamp(${dark ? '0.60, l, 0.74' : '0.48, l, 0.62'}) c h / 1)`
  const light = dark ? mix(layer, 16, '#c2d0e2') : '#ffffff'
  return {
    '--fm-base': mix(accent, dark ? 26 : 24),
    '--fm-a': mix(layer, dark ? 78 : 86),
    '--fm-b': mix(layer, dark ? 62 : 68),
    '--fm-c': mix(layer, dark ? 46 : 50),
    '--fm-light': mix(layer, dark ? 12 : 8, light),
    '--fm-edge': mix(layer, dark ? 24 : 54, light),
  } as CSSProperties
}
