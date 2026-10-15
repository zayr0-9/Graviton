import type { CSSProperties, ReactNode } from 'react'
import { DisclosurePanel, DisclosureRow } from './messagePrimitives'
import { QUIET_MUTED_CLASS, TEXT_DETAIL_CLASS } from './chatMessageShared'
import { useStreamingThinkingWord } from '../StreamingThinkingIndicator/useStreamingThinkingWord'
import './agentActivity.css'

export function AttachedActivity({ children }: { children: ReactNode }) {
  return <div className='agent-attached-activity ml-[18px] min-w-0 pl-2'>{children}</div>
}

/** Only history collapses. Context/hook components remain mounted and independently interactive. */
export function AgentSteps({ id, expanded, onToggle, summary, activity, status, active, history, style }: {
  id: string
  expanded: boolean
  onToggle: () => void
  summary?: string
  activity?: ReactNode
  status?: string
  active?: boolean
  history: ReactNode
  style?: CSSProperties
}) {
  const rotating = Boolean(active && status === 'Continuing agent work')
  const thinkingWord = useStreamingThinkingWord(rotating)
  const statusLabel = rotating ? thinkingWord : status
  return <div className='min-w-0 max-w-full' data-agent-steps='true'>
    <div style={style}>
      <DisclosureRow label='Agent steps' labelSize='group' summary={summary} hideSummaryWhenExpanded={false}
        expanded={expanded} onToggle={onToggle} controlsId={`${id}-panel`} />
    </div>
    {/* Measured chat rows change height immediately; motion is opacity/chevron only. */}
    <DisclosurePanel id={`${id}-panel`} expanded={expanded} disableTransition flush>
      <div className='agent-history-reveal pl-2.5'>{history}</div>
    </DisclosurePanel>
    {(activity || status) && <AttachedActivity>
      {activity}
      {status && <div className={`flex min-h-8 items-center gap-2 px-2.5 ${QUIET_MUTED_CLASS}`} style={style} role='status' aria-label={rotating ? 'Assistant is working' : undefined}>
        <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-60' aria-hidden='true' />
        <span aria-hidden={rotating || undefined} className={`${TEXT_DETAIL_CLASS} leading-normal ${active ? 'tool-name-shimmer' : ''}`}>{statusLabel}</span>
      </div>}
    </AttachedActivity>}
  </div>
}
