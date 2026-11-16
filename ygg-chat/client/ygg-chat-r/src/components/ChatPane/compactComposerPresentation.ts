import type { CSSProperties } from 'react'
import { getActionPopoverThemeStyle } from '../ActionPopover/actionPopoverTheme'
import { getThemeModeColor, type CustomChatTheme } from '../ThemeManager/themeConfig'

/** Fixed overlay coordinates in the layout viewport, constrained to the visual viewport. */
export function getCompactMenuPosition(anchor: { top: number; left: number; width: number }, viewport: {
  top: number; left: number; width: number; height: number; layoutHeight: number
}, pane?: { left: number; width: number }) {
  const margin = 8
  const bottomEdge = Math.max(viewport.top + margin, Math.min(anchor.top - margin, viewport.top + viewport.height - margin))
  const width = Math.max(0, Math.min(pane ? pane.width - margin * 2 : Math.min(420, anchor.width), viewport.width - margin * 2))
  const left = pane ? pane.left + margin : anchor.left
  return {
    left: Math.max(viewport.left + margin, Math.min(left, viewport.left + viewport.width - margin - width)),
    width,
    bottom: Math.max(0, viewport.layoutHeight - bottomEdge),
    maxHeight: Math.max(0, bottomEdge - viewport.top - margin),
  }
}

/** A local translucent exception: shared desktop popovers remain opaque. */
export function getCompactComposerThemeStyle(theme: CustomChatTheme, dark: boolean): CSSProperties {
  const palette = getActionPopoverThemeStyle(theme, dark)
  return {
    ...palette,
    '--quiet-glass': `color-mix(in srgb, ${getThemeModeColor(theme.colors.settingsCustomThemesCardBg, dark)} 88%, transparent)`,
    '--quiet-text': getThemeModeColor(theme.colors.toolJobsPrimaryText, dark),
    '--quiet-muted': getThemeModeColor(theme.colors.toolJobsMutedText, dark),
    '--quiet-control-text': getThemeModeColor(theme.colors.settingsCustomThemesButtonText, dark),
  } as CSSProperties
}
