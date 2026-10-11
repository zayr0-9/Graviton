import type { LucideIcon } from 'lucide-react'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'

/** Shared compact chrome for transcript mode/access notifications. */
export function RunSettingsNotice({ icon: Icon, label, detail }: { icon: LucideIcon; label: string; detail: string }) {
  const { theme, enabled } = useCustomChatTheme()
  const dark = useHtmlDarkMode()
  return (
    <div className='flex items-center gap-2 px-3 py-2 text-xs text-stone-500 dark:text-stone-400'
      style={enabled ? { color: getThemeModeColor(theme.colors.toolJobsMutedText, dark) } : undefined}>
      <Icon size={14} strokeWidth={2} aria-hidden='true' />
      <span>{label}</span>
      <span className='opacity-70'>· {detail}</span>
    </div>
  )
}
