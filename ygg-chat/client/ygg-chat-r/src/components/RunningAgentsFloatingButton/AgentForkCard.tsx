import type { CSSProperties, ReactNode } from 'react'
import {
  buildAgentForkGroups,
  getAgentForkKey,
  summarizeAgentStreamId,
  type AgentForkGroup,
  type AgentStreamListItem,
} from '../../hooks/useRunningAgentStreams'
import { AgentRunCard, type AgentCardStatus } from './AgentRunCard'
export { agentCardToneClass, agentStatusDotClass, useAgentCardTheme, type AgentCardStatus } from './AgentRunCard'
import { AgentRunPreview, type AgentPreviewScrollState } from './AgentRunPreview'
import { AgentFollowUpComposer } from './AgentFollowUpComposer'

export const forkName = (fork: AgentForkGroup) =>
  fork.representative.conversationTitle || `Conversation ${fork.representative.conversationId || 'Unknown'}`

/**
 * One status drives the header dot, label, card tone and the transcript's working indicator.
 * It reads the stream list, so the header and the transcript can never disagree.
 */
export function getAgentCardStatus(fork: AgentForkGroup, run?: AgentStreamListItem): AgentCardStatus {
  const active = run ? fork.activeStreams.some(stream => stream.streamId === run.streamId) : fork.activeStreams.length > 0
  const hasError = run ? run.hasError : fork.hasError
  // The label never names the current tool; the transcript already shows live activity.
  return { active, hasError, label: hasError ? 'Ended with error' : active ? 'Running' : 'Completed' }
}

/** The fork a focused preview shows: the same group its grid card would render, live as runs start and end. */
export function resolvePreviewFork(selected: AgentStreamListItem, activeStreams: readonly AgentStreamListItem[],
  streamHistory: readonly AgentStreamListItem[]): AgentForkGroup {
  const { activeForks, historyForks } = buildAgentForkGroups(activeStreams, streamHistory)
  const key = getAgentForkKey(selected)
  return [...activeForks, ...historyForks].find(fork => fork.key === key)
    // A notification can name a run that is no longer listed; show it on its own.
    ?? buildAgentForkGroups([], [selected]).historyForks[0]
}

export const cardIconButtonClass = 'flex shrink-0 items-center justify-center rounded-full text-neutral-500 transition-[background-color,color,transform] duration-150 hover:bg-black/5 hover:text-neutral-900 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-white'

interface AgentForkCardProps {
  fork: AgentForkGroup
  /** Show this one run instead of the whole fork (notification and recent-run previews). */
  run?: AgentStreamListItem
  grouped: boolean
  onOpenChat: (stream: AgentStreamListItem) => void
  /** Makes the title a preview button. Without it the title is plain text. */
  onOpen?: (stream: AgentStreamListItem) => void
  /** Controls before the title, e.g. Back. */
  leading?: ReactNode
  /** Controls after the title, e.g. collapse and hide. */
  actions?: ReactNode
  scrollState?: AgentPreviewScrollState
  /** The grid skips offscreen transcripts; the header always renders. */
  mountTranscript?: boolean
  fillHeight?: boolean
  className?: string
  style?: CSSProperties
}

/**
 * The agents pill's only fork view: grid cells and the focused preview both render this,
 * so header, status, request text, Open chat and transcript stay in step.
 */
export function AgentForkCard({ fork, run, grouped, onOpenChat, onOpen, leading, actions, scrollState,
  mountTranscript = true, fillHeight = true, className = '', style }: AgentForkCardProps) {
  const stream = run ?? fork.representative
  const status = getAgentCardStatus(fork, run)
  const name = forkName(fork)
  const label = `${name} · ${fork.displayName}`
  // Fork cards show no run-count summary; only a single-run card names its run.
  const detail = run ? `Run ${summarizeAgentStreamId(run.streamId)}` : null
  return (
    <AgentRunCard forkKey={fork.key} name={name} identifier={fork.displayName} status={status}
      detail={detail} detailTitle={run?.streamId} prompt={stream.parentMessageText} leading={leading}
      className={className} style={style} onOpen={onOpen && (() => onOpen(stream))} actions={<>
          <button type='button' disabled={!stream.conversationId} onClick={() => onOpenChat(stream)} aria-label={`Open chat for ${label}`}
            className='shrink-0 rounded-full px-2 py-1 text-xs font-medium hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:opacity-50 dark:hover:bg-white/5'>
            Open chat ↗
          </button>
          {actions}
      </>}>
      {mountTranscript && <AgentRunPreview scrollState={scrollState} streamId={stream.streamId} grouped={grouped}
        isStreaming={status.active} wholeFork={!run} fillHeight={fillHeight}
        transcriptLabel={run ? `${name} · run ${summarizeAgentStreamId(run.streamId)} transcript` : `${label} transcript`} />}
      {!run && (stream.streamType === 'primary' || stream.streamType === 'branch') &&
        <AgentFollowUpComposer fork={fork} onOpenChat={onOpenChat} />}
    </AgentRunCard>
  )
}
