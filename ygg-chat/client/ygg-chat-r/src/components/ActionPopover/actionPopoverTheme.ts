import type { CSSProperties } from 'react'
import { getThemeModeColor, type CustomChatTheme } from '../ThemeManager/themeConfig'

/** Shared soft-popover palette: shell, controls, and selected states stay distinct. */
export function getActionPopoverThemeStyle(theme: CustomChatTheme, isDarkMode: boolean): CSSProperties {
  const color = (pair: CustomChatTheme['colors']['settingsCustomThemesCardBg']) => getThemeModeColor(pair, isDarkMode)
  return {
    // Composer overlays must remain readable above acrylic/mica, even with alpha theme colors.
    '--cloud-surface': `rgb(from ${color(theme.colors.settingsCustomThemesCardBg)} r g b / 1)`,
    '--cloud-text': color(theme.colors.toolJobsPrimaryText),
    '--cloud-field': color(theme.colors.settingsCustomThemesInnerCardBg),
    '--cloud-button': color(theme.colors.settingsCustomThemesButtonBg),
    '--cloud-muted': color(theme.colors.toolJobsMutedText),
    '--cloud-button-text': color(theme.colors.settingsCustomThemesButtonText),
    '--cloud-active-bg': color(theme.colors.composerToggleActiveBg),
    '--cloud-active-text': color(theme.colors.composerToggleActiveText),
    // Keep the strong active track, but use secondary-button colors for distinct thumbs.
    '--cloud-switch-on': color(theme.colors.composerToggleActiveText),
    '--cloud-switch-off': `color-mix(in srgb, ${color(theme.colors.toolJobsMutedText)} 30%, ${color(theme.colors.settingsCustomThemesCardBg)})`,
    '--cloud-switch-thumb': color(theme.colors.settingsCustomThemesButtonText),
    '--cloud-switch-thumb-on': color(theme.colors.settingsCustomThemesButtonBg),
  } as CSSProperties
}
