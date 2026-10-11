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
  const light = dark ? mix(accent, 20, '#a5b8ce') : '#ffffff'
  return {
    '--fm-base': mix(accent, 30),
    '--fm-a': mix(accent, 67),
    '--fm-b': mix(accent, 50),
    '--fm-c': mix(accent, 37),
    '--fm-light': mix(accent, 18, light),
    '--fm-edge': mix(accent, 30, light),
  } as CSSProperties
}
