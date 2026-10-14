import { useLayoutEffect, useRef, useState } from 'react'
import { buildAgentForkGroups, type AgentStreamListItem } from '../../hooks/useRunningAgentStreams'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'
import { AgentMessageTooltip } from './AgentMessageTooltip'
import { AgentRunPreview } from './AgentRunPreview'

interface AgentsMonitorGridProps {
  activeStreams: AgentStreamListItem[]
  streamHistory: AgentStreamListItem[]
  grouped: boolean
  onOpenFork: (stream: AgentStreamListItem) => void
  onOpenChat: (stream: AgentStreamListItem) => void
}

export function getAgentGridCardHeight(columns: number): string {
  const scale = columns >= 3 ? 1.5 : columns === 2 ? 1.25 : 1
  return `max(${20 * scale}rem, min(${52 * scale}dvh, ${28 * scale}rem))`
}

/** One live transcript per fork; expanding is optional, never required to monitor output. */
export function AgentsMonitorGrid({ activeStreams, streamHistory, grouped, onOpenFork, onOpenChat }: AgentsMonitorGridProps) {
  const gridRef = useRef<HTMLDivElement>(null)
  const [columns, setColumns] = useState(1)
  const { theme, enabled } = useCustomChatTheme()
  const dark = useHtmlDarkMode()
  const { activeForks, historyForks } = buildAgentForkGroups(activeStreams, streamHistory)
  const forks = [...activeForks, ...historyForks]
  const textStyle = { color: enabled ? getThemeModeColor(theme.colors.toolJobsPrimaryText, dark) : undefined }
  const mutedStyle = { color: enabled ? getThemeModeColor(theme.colors.toolJobsMutedText, dark) : undefined }

  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const updateColumns = () => {
      const tracks = getComputedStyle(grid).gridTemplateColumns.trim()
      const visibleTracks = tracks.split(/\s+/).filter(track => parseFloat(track) > 0)
      setColumns(Math.max(1, Math.min(3, visibleTracks.length)))
    }
    updateColumns()
    const observer = new ResizeObserver(updateColumns)
    observer.observe(grid)
    // Breakpoints can change the column count without changing the pill width.
    window.addEventListener('resize', updateColumns)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateColumns)
    }
  }, [forks.length])

  return (
    <section aria-label='Agent forks' className='flex h-full min-h-0 flex-1 flex-col overflow-hidden' style={textStyle}>
      <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2 thin-scrollbar'>
        {forks.length === 0 && <p className='p-3 text-sm text-neutral-500' style={mutedStyle}>No captured agent forks yet.</p>}
        <div ref={gridRef} className='grid grid-cols-1 gap-3 md:[grid-template-columns:repeat(auto-fit,minmax(min(100%,max(18rem,calc((100%_-_0.75rem)/2))),1fr))] xl:[grid-template-columns:repeat(auto-fit,minmax(min(100%,max(18rem,calc((100%_-_1.5rem)/3))),1fr))]'>
          {forks.map(fork => {
            const stream = fork.representative
            const active = fork.activeStreams.length > 0
            const cardStyle = { backgroundColor: enabled ? getThemeModeColor(theme.colors[active ? 'agentsGridStreamingCardBg' : 'agentsGridIdleCardBg'], dark) : undefined }
            const name = stream.conversationTitle || `Conversation ${stream.conversationId || 'Unknown'}`
            return (
              <section key={fork.key} aria-label={`${name} · ${fork.displayName}`} className={`flex min-w-0 flex-col overflow-hidden rounded-2xl ${active ? 'bg-emerald-500/[0.12] dark:bg-emerald-500/[0.16]' : 'bg-black/[0.035] dark:bg-white/5'}`} style={{ ...cardStyle, height: getAgentGridCardHeight(columns) }}>
                <div className='flex w-full min-w-0 shrink-0 flex-col gap-1 px-3 py-2'>
                  <button type='button' onClick={() => onOpenFork(stream)} aria-label={`Preview ${name} · ${fork.displayName}`}
                    className='flex w-full min-w-0 items-center gap-2 rounded-lg text-left hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 dark:hover:bg-white/5'>
                    <span className='min-w-0 flex-1 truncate text-sm font-semibold' title={name}>{name}</span>
                    <span className='shrink-0 text-xs text-neutral-500 dark:text-neutral-400' style={mutedStyle}>{fork.displayName}</span>
                  </button>
                  <div className='flex min-w-0 items-center gap-2 text-xs'>
                    <span className='flex shrink-0 items-center gap-2 whitespace-nowrap'>
                      <span className={`h-2 w-2 shrink-0 rounded-full ${fork.hasError ? 'bg-rose-500' : active ? 'bg-emerald-500' : 'bg-neutral-400'}`}
                        style={{ backgroundColor: enabled ? getThemeModeColor(theme.colors[fork.hasError ? 'toolJobsProgressFailed' : active ? 'toolJobsProgressRunning' : 'toolJobsProgressCompleted'], dark) : undefined }} aria-hidden='true' />
                      {fork.hasError ? 'Ended with error' : active ? stream.activityLabel : 'Completed'}
                    </span>
                    <span className='min-w-0 flex-1 truncate text-neutral-500 dark:text-neutral-400' style={mutedStyle}
                      title={`${fork.activeStreams.length} running · ${fork.completedStreams.length} completed runs`}>
                      {fork.activeStreams.length} running · {fork.completedStreams.length} completed runs
                    </span>
                    <button type='button' disabled={!stream.conversationId} onClick={() => onOpenChat(stream)} aria-label={`Open chat for ${name} · ${fork.displayName}`}
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
                <AgentRunPreview streamId={stream.streamId} grouped={grouped} isStreaming={active} wholeFork fillHeight transcriptLabel={`${name} · ${fork.displayName} transcript`} />
              </section>
            )
          })}
        </div>
      </div>
    </section>
  )
}
