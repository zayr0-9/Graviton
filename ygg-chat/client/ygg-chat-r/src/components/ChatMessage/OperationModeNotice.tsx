import { Code2, MessageCircle } from 'lucide-react'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'

export function OperationModeNotice({ mode, initial = false }: { mode: 'plan' | 'execute'; initial?: boolean }) {
  const { theme, enabled } = useCustomChatTheme()
  const dark = useHtmlDarkMode()
  const Icon = mode === 'plan' ? MessageCircle : Code2
  const name = mode === 'plan' ? 'Chat' : 'Agent'
  return (
    <div className='flex items-center gap-2 px-3 py-2 text-xs text-stone-500 dark:text-stone-400'
      style={enabled ? { color: getThemeModeColor(theme.colors.toolJobsMutedText, dark) } : undefined}>
      <Icon size={14} strokeWidth={2} aria-hidden='true' />
      <span>{initial ? `${name} mode` : `Switched to ${name}`}</span>
      <span className='opacity-70'>· {mode === 'plan' ? 'Read-only' : 'Editing enabled'}</span>
    </div>
  )
}
