import { Archive } from 'lucide-react'
import {
  type CustomChatTheme,
  getCustomChatThemeEnabled,
  getStoredCustomChatTheme,
  getThemeModeColor,
} from '../ThemeManager/themeConfig'

interface SummarisedMessageProps {
  id?: string
  className?: string
  customTheme?: CustomChatTheme
  customThemeEnabled?: boolean
  isDarkMode?: boolean
}

/** Display-only compaction marker. Deliberately accepts no summary content or blocks. */
export function SummarisedMessage({
  id,
  className,
  customTheme = getStoredCustomChatTheme(),
  customThemeEnabled = getCustomChatThemeEnabled(),
  isDarkMode = typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
}: SummarisedMessageProps) {
  return (
    <div id={id} className={`px-0 py-1 sm:px-2 ${className ?? ''}`} data-chat-summary='true'>
      <div
        className='flex h-8 items-center gap-2 px-2.5 text-xs text-stone-500 dark:text-stone-400'
        style={customThemeEnabled ? { color: getThemeModeColor(customTheme.colors.toolJobsMutedText, isDarkMode) } : undefined}
        title='Earlier context is preserved in a summary and still used by the model.'
      >
        <Archive size={14} className='shrink-0' aria-hidden='true' />
        <span>Conversation summarised</span>
      </div>
    </div>
  )
}
