import { Bell } from 'lucide-react'
import { parseMessageMeta } from '../../../../../shared/contextInjection'
import { CompactMessageNotice, type CompactMessageNoticeProps } from './CompactMessageNotice'

/** Identify by server provenance, never by user-authored text that happens to match. */
export function isWatcherCompletionMessage(message: { role?: string; meta?: unknown } | undefined): boolean {
  return message?.role === 'user' && parseMessageMeta(message.meta)?.kind === 'watcher_completion'
}

export function WatcherCompletionNotice({ content, ...props }: CompactMessageNoticeProps & { content: string }) {
  // Keep the event description, not the model-only continuation instructions.
  const match = /^Watcher completion: (process_exit|file_created|file_changed|log_match|http_status) watch ([\w-]+) (triggered|timed_out|error)\./.exec(content)
  const label = match
    ? `Watcher ${match[3] === 'timed_out' ? 'timed out' : match[3] === 'error' ? 'failed' : 'triggered'} · ${match[1]} · ${match[2].slice(0, 8)}`
    : 'Watcher completed'
  return (
    <CompactMessageNotice {...props} kind='watcher' title={content}
      icon={<Bell size={14} className='shrink-0' aria-hidden='true' />}>
      {label}
    </CompactMessageNotice>
  )
}
