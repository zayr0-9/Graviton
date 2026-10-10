import { useState } from 'react'
import { X } from 'lucide-react'
import type { QueuedMessageView } from '../../../../../shared/queuedMessages'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'

export function QueuedMessages({ items, onCancel, onRestore }: {
  items: QueuedMessageView[]
  onCancel: (requestId: string) => Promise<unknown>
  onRestore: (content: string) => void
}) {
  const { theme, enabled } = useCustomChatTheme()
  const dark = useHtmlDarkMode()
  const [error, setError] = useState('')
  const visible = items.filter(item => item.status !== 'delivered' && item.status !== 'cancelled')
  if (!visible.length) return null
  const rowStyle = enabled ? {
    backgroundColor: getThemeModeColor(theme.colors.toolJobsPanelBg, dark),
    color: getThemeModeColor(theme.colors.toolJobsPrimaryText, dark),
  } : undefined
  const mutedStyle = enabled ? { color: getThemeModeColor(theme.colors.toolJobsMutedText, dark) } : undefined
  const buttonStyle = enabled ? {
    backgroundColor: getThemeModeColor(theme.colors.settingsCustomThemesButtonBg, dark),
    color: getThemeModeColor(theme.colors.settingsCustomThemesButtonText, dark),
  } : undefined
  return <div className='mx-3 mb-2 space-y-1 text-xs text-neutral-700 dark:text-neutral-200'>
    {visible.map(item => <div key={item.requestId} className='flex items-center gap-2 rounded-xl bg-black/5 px-3 py-2 dark:bg-white/5' style={rowStyle}>
      <span className='shrink-0 text-neutral-500 dark:text-neutral-400' style={mutedStyle}>{item.status === 'failed' ? 'Not sent' : item.status === 'delivering' ? 'Sending' : 'Queued'}</span>
      <span className='min-w-0 flex-1 truncate' title={item.error || item.content}>{item.content}</span>
      {item.attachmentCount > 0 && <span className='text-neutral-500 dark:text-neutral-400' style={mutedStyle}>{item.attachmentCount} attachment(s)</span>}
      {item.status === 'failed' && <button type='button' className='shrink-0 rounded-full px-2 py-1 hover:opacity-80 focus-visible:outline focus-visible:outline-2' style={buttonStyle} onClick={() => onRestore(item.content)}>Restore text</button>}
      {item.status !== 'delivering' && <button type='button' title='Remove queued message' aria-label='Remove queued message'
        className='rounded-full p-1 hover:bg-black/5 dark:hover:bg-white/10 hover:opacity-80 focus-visible:outline focus-visible:outline-2' style={buttonStyle}
        onClick={() => { setError(''); void onCancel(item.requestId).catch(() => setError('Could not remove this message. It may already be processing.')) }}>
        <X size={14} />
      </button>}
    </div>)}
    {error && <p role='alert' className='text-rose-700 dark:text-rose-300' style={enabled ? { color: getThemeModeColor(theme.colors.toolJobsErrorText, dark) } : undefined}>{error}</p>}
  </div>
}
