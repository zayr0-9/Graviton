import type { LucideIcon } from 'lucide-react'
import { MESSAGE_NOTICE_ROW_CLASS, MESSAGE_NOTICE_WRAPPER_CLASS, QUIET_MUTED_CLASS, TEXT_DETAIL_CLASS, TEXT_LABEL_CLASS } from './chatMessageShared'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'

/** Shared compact chrome for transcript mode/access notifications. */
export function RunSettingsNotice({ icon: Icon, label, detail }: { icon: LucideIcon; label: string; detail: string }) {
  const { theme, enabled } = useCustomChatTheme()
  const dark = useHtmlDarkMode()
  return (
    <div className={MESSAGE_NOTICE_WRAPPER_CLASS}>
      <div className={`${MESSAGE_NOTICE_ROW_CLASS} ${QUIET_MUTED_CLASS}`}
        style={enabled ? { color: getThemeModeColor(theme.colors.toolJobsMutedText, dark) } : undefined}>
        <Icon size={16} strokeWidth={1.75} className='shrink-0' aria-hidden='true' />
        <span className={`min-w-0 truncate ${TEXT_LABEL_CLASS} font-medium`}>{label}</span>
        <span className={`min-w-0 truncate ${TEXT_DETAIL_CLASS}`}>· {detail}</span>
      </div>
    </div>
  )
}
