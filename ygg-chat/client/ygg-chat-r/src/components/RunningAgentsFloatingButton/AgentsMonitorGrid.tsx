import { useId } from 'react'
import { LayoutGrid } from 'lucide-react'
import { buildAgentForkGroups, type AgentStreamListItem } from '../../hooks/useRunningAgentStreams'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'
import { AgentMessageTooltip } from './AgentMessageTooltip'

interface AgentsMonitorGridProps {
  activeStreams: AgentStreamListItem[]
  streamHistory: AgentStreamListItem[]
  onOpenFork: (stream: AgentStreamListItem) => void
}

/** One card per confirmed fork. Clicking opens its captured chronological transcript. */
export function AgentsMonitorGrid({ activeStreams, streamHistory, onOpenFork }: AgentsMonitorGridProps) {
  const titleId = useId()
  const { theme, enabled } = useCustomChatTheme()
  const dark = useHtmlDarkMode()
  const { activeForks, historyForks } = buildAgentForkGroups(activeStreams, streamHistory)
  const forks = [...activeForks, ...historyForks]
  const textStyle = { color: enabled ? getThemeModeColor(theme.colors.toolJobsPrimaryText, dark) : undefined }
  const mutedStyle = { color: enabled ? getThemeModeColor(theme.colors.toolJobsMutedText, dark) : undefined }
  const cardStyle = { backgroundColor: enabled ? getThemeModeColor(theme.colors.settingsCustomThemesInnerCardBg, dark) : undefined }

  return (
    <section aria-labelledby={titleId} className='flex h-full min-h-0 flex-1 flex-col overflow-hidden' style={textStyle}>
      <header className='flex shrink-0 flex-wrap items-center gap-2 px-3 py-3'>
        <h2 id={titleId} className='flex items-center gap-2 text-sm font-semibold'>
          <LayoutGrid size={16} strokeWidth={2.25} aria-hidden='true' /> Agent forks
        </h2>
        <span className='text-xs text-neutral-500 dark:text-neutral-400' style={mutedStyle}>
          {activeForks.length} active · {historyForks.length} completed
        </span>
      </header>
      <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2 thin-scrollbar'>
        {forks.length === 0 && <p className='p-3 text-sm text-neutral-500' style={mutedStyle}>No captured agent forks yet.</p>}
        <div className='grid gap-3' style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 18rem), 1fr))' }}>
          {forks.map(fork => {
            const stream = fork.representative
            const active = fork.activeStreams.length > 0
            const name = stream.conversationTitle || `Conversation ${stream.conversationId || 'Unknown'}`
            return (
              <div key={fork.key} className='min-w-0 rounded-2xl bg-black/[0.035] dark:bg-white/5' style={cardStyle}>
                <button type='button' onClick={() => onOpenFork(stream)} aria-label={`Preview ${name} · ${fork.displayName}`}
                  className='flex min-h-40 w-full min-w-0 flex-col gap-2 rounded-2xl p-4 text-left transition-[background-color,color] duration-150 hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 dark:hover:bg-white/5'>
                  <span className='w-full truncate text-sm font-semibold' title={name}>{name}</span>
                  <span className='text-xs text-neutral-500 dark:text-neutral-400' style={mutedStyle}>{fork.displayName}</span>
                  <span className='flex items-center gap-2 text-xs'>
                    <span className={`h-2 w-2 rounded-full ${fork.hasError ? 'bg-rose-500' : active ? 'bg-emerald-500' : 'bg-neutral-400'}`}
                      style={{ backgroundColor: enabled ? getThemeModeColor(theme.colors[fork.hasError ? 'toolJobsProgressFailed' : active ? 'toolJobsProgressRunning' : 'toolJobsProgressCompleted'], dark) : undefined }} aria-hidden='true' />
                    {fork.hasError ? 'Ended with error' : active ? stream.activityLabel : 'Completed'}
                  </span>
                  <span className='text-xs text-neutral-500 dark:text-neutral-400' style={mutedStyle}>
                    {fork.activeStreams.length} running · {fork.completedStreams.length} completed runs
                  </span>
                  <span className='mt-auto text-xs font-medium'>View full fork transcript →</span>
                </button>
                {stream.parentMessageText && <div className='px-4 pb-3'>
                  <AgentMessageTooltip text={stream.parentMessageText}>
                    <p className='truncate text-xs text-neutral-500 dark:text-neutral-400' style={mutedStyle}>{stream.parentMessageText}</p>
                  </AgentMessageTooltip>
                </div>}
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
