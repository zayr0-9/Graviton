import type { ReactNode } from 'react'
import { MESSAGE_NOTICE_ROW_CLASS, MESSAGE_NOTICE_WRAPPER_CLASS } from './chatMessageShared'
import {
  type CustomChatTheme,
  getCustomChatThemeEnabled,
  getStoredCustomChatTheme,
  getThemeModeColor,
} from '../ThemeManager/themeConfig'

export interface CompactMessageNoticeProps {
  id?: string
  className?: string
  customTheme?: CustomChatTheme
  customThemeEnabled?: boolean
  isDarkMode?: boolean
}

/** Shared display-only chrome for automated transcript notices. */
export function CompactMessageNotice({
  id, className, customTheme = getStoredCustomChatTheme(),
  customThemeEnabled = getCustomChatThemeEnabled(),
  isDarkMode = typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  icon, children, title, kind,
}: CompactMessageNoticeProps & { icon: ReactNode; children: ReactNode; title: string; kind: 'summary' | 'watcher' | 'image' | 'status' }) {
  return (
    <div id={id} className={`${MESSAGE_NOTICE_WRAPPER_CLASS} ${className ?? ''}`}
      data-chat-summary={kind === 'summary' ? 'true' : undefined}
      data-chat-watcher={kind === 'watcher' ? 'true' : undefined}
      data-chat-image-attachment={kind === 'image' ? 'true' : undefined}>
      <div className={`${MESSAGE_NOTICE_ROW_CLASS} text-xs text-stone-500 dark:text-stone-400`}
        style={customThemeEnabled ? { color: getThemeModeColor(customTheme.colors.toolJobsMutedText, isDarkMode) } : undefined}
        title={title}>
        {icon}
        <span className='min-w-0 truncate'>{children}</span>
      </div>
    </div>
  )
}
