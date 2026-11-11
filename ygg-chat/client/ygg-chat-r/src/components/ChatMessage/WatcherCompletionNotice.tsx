import { Bell } from 'lucide-react'
import { CompactMessageNotice, type CompactMessageNoticeProps } from './CompactMessageNotice'

/** Identify by server provenance, never by user-authored text that happens to match. */
export { isWatcherCompletionMessage } from '../../../../../shared/watchEvents'

const statusLabel = (status: string) => status === 'timed_out' ? 'timed out' : status === 'error' ? 'failed' : status.replace(/_/g, ' ')

/** Keep the event description, not the model-only continuation instructions or delegated result. */
export function getWatcherCompletionLabel(content: string): string {
  const watch = /^Watcher completion: (process_exit|file_created|file_changed|log_match|http_status) watch ([\w-]+) (triggered|timed_out|error)\./.exec(content)
  if (watch) return `Watcher ${statusLabel(watch[3])} · ${watch[1]} · ${watch[2].slice(0, 8)}`
  // Subagent and Claude bridge completions start with a source line, then their fixed event sentence.
  const subagent = /Subagent completion \([^)]*\)\. Handle ([^,\s]+), run [^,\s]+, attempt [^,\s]+, status (\w+)\./.exec(content)
  if (subagent) return `Subagent ${statusLabel(subagent[2])} · ${subagent[1]}`
  if (content.startsWith('Subagent completion unavailable')) return 'Subagent result unavailable'
  const bridge = /Claude bridge job completion \([^)]*\)\. Session [^,\s]+, job ([^,\s]+), status (\w+)\./.exec(content)
  if (bridge) return `Claude job ${statusLabel(bridge[2])} · ${bridge[1].slice(0, 8)}`
  return 'Watcher completed'
}

export function WatcherCompletionNotice({ content, ...props }: CompactMessageNoticeProps & { content: string }) {
  return (
    <CompactMessageNotice {...props} kind='watcher' title={content}
      icon={<Bell size={14} className='shrink-0' aria-hidden='true' />}>
      {getWatcherCompletionLabel(content)}
    </CompactMessageNotice>
  )
}
