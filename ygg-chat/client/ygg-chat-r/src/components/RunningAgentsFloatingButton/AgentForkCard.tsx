import type { CSSProperties, ReactNode } from 'react'
import {
  buildAgentForkGroups,
  getAgentForkKey,
  summarizeAgentStreamId,
  type AgentForkGroup,
  type AgentStreamListItem,
} from '../../hooks/useRunningAgentStreams'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode, type CustomChatTheme, type ThemeColorPair } from '../ThemeManager/themeConfig'
import { AgentMessageTooltip } from './AgentMessageTooltip'
import { AgentRunPreview, type AgentPreviewScrollState } from './AgentRunPreview'
import { AgentFollowUpComposer } from './AgentFollowUpComposer'

export const forkName = (fork: AgentForkGroup) =>
  fork.representative.conversationTitle || `Conversation ${fork.representative.conversationId || 'Unknown'}`

export interface AgentCardStatus { active: boolean; hasError: boolean; label: string }

/**
 * One status drives the header dot, label, card tone and the transcript's working indicator.
 * It reads the stream list, so the header and the transcript can never disagree.
 */
export function getAgentCardStatus(fork: AgentForkGroup, run?: AgentStreamListItem): AgentCardStatus {
  const active = run ? fork.activeStreams.some(stream => stream.streamId === run.streamId) : fork.activeStreams.length > 0
  const hasError = run ? run.hasError : fork.hasError
  const stream = run ?? fork.representative
  return { active, hasError, label: hasError ? 'Ended with error' : active ? stream.activityLabel : 'Completed' }
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

export const agentStatusDotClass = (status: AgentCardStatus) =>
  status.hasError ? 'bg-rose-500' : status.active ? 'bg-emerald-500' : 'bg-neutral-400'

export const cardIconButtonClass = 'flex shrink-0 items-center justify-center rounded-full text-neutral-500 transition-[background-color,color,transform] duration-150 hover:bg-black/5 hover:text-neutral-900 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-white'

type ThemeColors = CustomChatTheme['colors']
type ThemeColorKey = { [Key in keyof ThemeColors]: ThemeColors[Key] extends ThemeColorPair ? Key : never }[keyof ThemeColors]

/** Theme keys shared by every agent card surface; Tailwind classes remain the disabled-theme fallback. */
export function useAgentCardTheme() {
  const { theme, enabled } = useCustomChatTheme()
  const dark = useHtmlDarkMode()
  const color = (key: ThemeColorKey) => enabled ? getThemeModeColor(theme.colors[key], dark) : undefined
  return {
    color,
    mutedStyle: { color: color('toolJobsMutedText') },
    secondaryStyle: enabled ? { backgroundColor: color('settingsCustomThemesButtonBg'), color: color('settingsCustomThemesButtonText') } : undefined,
    panelStyle: enabled ? { backgroundColor: color('settingsCustomThemesInnerCardBg') } : undefined,
    cardStyle: (active: boolean) => ({ backgroundColor: color(active ? 'agentsGridStreamingCardBg' : 'agentsGridIdleCardBg') }),
    statusDotStyle: (status: AgentCardStatus) => ({ backgroundColor: color(status.hasError
      ? 'toolJobsProgressFailed' : status.active ? 'toolJobsProgressRunning' : 'toolJobsProgressCompleted') }),
  }
}

export const agentCardToneClass = (active: boolean) => active ? 'bg-orange-50 dark:bg-orange-900/20' : 'bg-black/[0.035] dark:bg-white/5'

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
  const { mutedStyle, cardStyle, statusDotStyle } = useAgentCardTheme()
  const stream = run ?? fork.representative
  const status = getAgentCardStatus(fork, run)
  const name = forkName(fork)
  const label = `${name} · ${fork.displayName}`
  const detail = run
    ? `Run ${summarizeAgentStreamId(run.streamId)}`
    : `${fork.activeStreams.length} running · ${fork.completedStreams.length} completed runs`
  const titleContent = <>
    <span className='min-w-0 flex-1 truncate text-sm font-semibold' title={name}>{name}</span>
    <span className='shrink-0 text-xs text-neutral-500 dark:text-neutral-400' style={mutedStyle}>{fork.displayName}</span>
  </>

  return (
    <section data-agent-fork-key={fork.key} aria-label={label}
      className={`flex min-w-0 flex-col overflow-hidden rounded-2xl ${agentCardToneClass(status.active)} ${className}`}
      style={{ ...cardStyle(status.active), ...style }}>
      <div className='flex w-full min-w-0 shrink-0 flex-col gap-1 px-3 py-2'>
        <div className='flex min-w-0 items-center gap-1'>
          {leading}
          {onOpen ? (
            <button type='button' onClick={() => onOpen(stream)} aria-label={`Preview ${label}`}
              className='flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 dark:hover:bg-white/5'>
              {titleContent}
            </button>
          ) : <div className='flex min-w-0 flex-1 items-center gap-2'>{titleContent}</div>}
          {actions}
        </div>
        <div className='flex min-w-0 items-center gap-2 text-xs'>
          <span className='flex shrink-0 items-center gap-2 whitespace-nowrap'>
            <span className={`h-2 w-2 shrink-0 rounded-full ${agentStatusDotClass(status)}`} style={statusDotStyle(status)} aria-hidden='true' />
            {status.label}
          </span>
          <span className='min-w-0 flex-1 truncate text-neutral-500 dark:text-neutral-400' style={mutedStyle} title={run ? run.streamId : detail}>
            {detail}
          </span>
          <button type='button' disabled={!stream.conversationId} onClick={() => onOpenChat(stream)} aria-label={`Open chat for ${label}`}
            className='shrink-0 rounded-full px-2 py-1 font-medium hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:opacity-50 dark:hover:bg-white/5'>
            Open chat ↗
          </button>
        </div>
      </div>
      {stream.parentMessageText && <div className='shrink-0 px-3 pb-1'>
        <AgentMessageTooltip text={stream.parentMessageText}>
          <p className='truncate text-xs text-neutral-500 dark:text-neutral-400' style={mutedStyle}>{stream.parentMessageText}</p>
        </AgentMessageTooltip>
      </div>}
      {mountTranscript && <AgentRunPreview scrollState={scrollState} streamId={stream.streamId} grouped={grouped}
        isStreaming={status.active} wholeFork={!run} fillHeight={fillHeight}
        transcriptLabel={run ? `${name} · run ${summarizeAgentStreamId(run.streamId)} transcript` : `${label} transcript`} />}
      {!run && (stream.streamType === 'primary' || stream.streamType === 'branch') &&
        <AgentFollowUpComposer fork={fork} onOpenChat={onOpenChat} />}
    </section>
  )
}
