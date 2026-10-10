import type { CSSProperties } from 'react'
import { FAST_MODE_ANIMATIONS, type FastModeAnimation } from '../../helpers/fastModeAnimationSettings'
import { getThemeModeColor, type CustomChatTheme } from '../ThemeManager/themeConfig'

export const getFastModePalette = (animation: FastModeAnimation, dark: boolean, theme?: CustomChatTheme): CSSProperties => {
  const colors = FAST_MODE_ANIMATIONS.find(option => option.id === animation)?.colors || FAST_MODE_ANIMATIONS[14].colors
  const palette = theme
    ? [theme.colors.composerToggleActiveBg, theme.colors.sendButtonAnimationColor,
        theme.colors.chatProgressBarFill, theme.colors.composerToggleActiveBorder].map(color => getThemeModeColor(color, dark))
    : colors
  const surface = theme ? getThemeModeColor(theme.colors.chatPanelBg, dark) : '#162338'
  // Retain hue in dark mode: tint the surface, rather than dimming the entire effect.
  const mix = (color: string, amount: number) => `color-mix(in srgb, ${color} ${amount}%, ${surface})`
  return {
    '--fm-base': dark ? mix(palette[0], 38) : palette[0],
    '--fm-a': dark ? mix(palette[1], 65) : palette[1],
    '--fm-b': dark ? mix(palette[2], 62) : palette[2],
    '--fm-c': dark ? mix(palette[3], 60) : palette[3],
    '--fm-light': dark ? mix(palette[1], 40) : theme ? `color-mix(in srgb, ${palette[1]} 18%, white)` : '#f4fbff',
    '--fm-edge': dark ? mix(palette[2], 70) : theme ? `color-mix(in srgb, ${palette[2]} 30%, white)` : '#ffffff',
  } as CSSProperties
}
