import type { LucideIcon } from 'lucide-react'
import { MESSAGE_NOTICE_ROW_CLASS, MESSAGE_NOTICE_WRAPPER_CLASS } from './chatMessageShared'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'

/** Shared compact chrome for transcript mode/access notifications. */
export function RunSettingsNotice({ icon: Icon, label, detail }: { icon: LucideIcon; label: string; detail: string }) {
  const { theme, enabled } = useCustomChatTheme()
  const dark = useHtmlDarkMode()
  return (
    <div className={MESSAGE_NOTICE_WRAPPER_CLASS}>
      <div className={`${MESSAGE_NOTICE_ROW_CLASS} text-xs text-stone-500 dark:text-stone-400`}
        style={enabled ? { color: getThemeModeColor(theme.colors.toolJobsMutedText, dark) } : undefined}>
        <Icon size={14} strokeWidth={2} className='shrink-0' aria-hidden='true' />
        <span className='min-w-0 truncate'>{label} <span className='opacity-70'>· {detail}</span></span>
      </div>
    </div>
  )
}
