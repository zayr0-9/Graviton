import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { buildAgentForkGroups, type AgentStreamListItem } from '../../hooks/useRunningAgentStreams'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'
import { AgentMessageTooltip } from './AgentMessageTooltip'
import { AgentRunPreview, type AgentPreviewScrollState } from './AgentRunPreview'
import { AgentGridRow } from './AgentGridRow'
import { getAgentGridColumns } from './agentGridSplit'
import { useVisibleAgentGridRows } from './useVisibleAgentGridRows'

interface AgentsMonitorGridProps {
  activeStreams: AgentStreamListItem[]
  streamHistory: AgentStreamListItem[]
  grouped: boolean
  onOpenFork: (stream: AgentStreamListItem) => void
  onOpenChat: (stream: AgentStreamListItem) => void
  /** True while the pill is being drag-resized; card height is re-measured on release. */
  resizing?: boolean
}

const MIN_CARD_REM = 16
const VIEWPORT_SETTLE_MS = 150

/**
 * Cards fill the grid's visible height so one row occupies the pill; further rows are
 * reached by scrolling. Before the first measurement (or in SSR) use the static fallback.
 */
export function getAgentGridCardHeight(columns: number, viewportPx?: number | null): string {
  if (viewportPx && viewportPx > 0) return `max(${MIN_CARD_REM}rem, ${Math.floor(viewportPx)}px)`
  const scale = columns >= 3 ? 1.5 : columns === 2 ? 1.25 : 1
  return `max(${20 * scale}rem, min(${52 * scale}dvh, ${28 * scale}rem))`
}

/** One live transcript per fork; expanding is optional, never required to monitor output. */
export function AgentsMonitorGrid({ activeStreams, streamHistory, grouped, onOpenFork, onOpenChat, resizing = false }: AgentsMonitorGridProps) {
  const gridRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewportHeight, setViewportHeight] = useState<number | null>(null)
  const resizingRef = useRef(resizing)
  resizingRef.current = resizing
  const measureViewportRef = useRef<() => void>(() => {})
  // View state only: transcript data stays in Redux, even while offscreen.
  const scrollStates = useRef(new Map<string, AgentPreviewScrollState>())
  const [columns, setColumns] = useState(1)
  const { theme, enabled } = useCustomChatTheme()
  const dark = useHtmlDarkMode()
  const forks = useMemo(() => {
    const { activeForks, historyForks } = buildAgentForkGroups(activeStreams, streamHistory)
    return [...activeForks, ...historyForks]
  }, [activeStreams, streamHistory])
  useEffect(() => {
    const keys = new Set(forks.map(fork => fork.key))
    for (const key of scrollStates.current.keys()) if (!keys.has(key)) scrollStates.current.delete(key)
  }, [forks])
  const rowCount = Math.ceil(forks.length / columns)
  const visibleRows = useVisibleAgentGridRows(gridRef, scrollRef, rowCount, columns)
  const textStyle: CSSProperties & Record<'--agents-grid-streaming-bg' | '--agents-grid-idle-bg', string | undefined> = {
    color: enabled ? getThemeModeColor(theme.colors.toolJobsPrimaryText, dark) : undefined,
    '--agents-grid-streaming-bg': enabled ? getThemeModeColor(theme.colors.composerToggleActiveBg, dark) : undefined,
    '--agents-grid-idle-bg': enabled ? getThemeModeColor(theme.colors.settingsCustomThemesInnerCardBg, dark) : undefined,
  }
  const mutedStyle = { color: enabled ? getThemeModeColor(theme.colors.toolJobsMutedText, dark) : undefined }

  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const updateColumns = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      setColumns(getAgentGridColumns(grid.getBoundingClientRect().width, window.innerWidth, rem, forks.length))
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

  // Observe the scroller, not the grid: the grid's height depends on card height.
  // Never re-measure per frame during a pill drag; other resizes commit once settled.
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const measure = () => {
      const style = getComputedStyle(scroller)
      const inner = scroller.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0)
      setViewportHeight(current => (current === inner ? current : inner))
    }
    measureViewportRef.current = measure
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (resizingRef.current) return
      clearTimeout(timer)
      timer = setTimeout(measure, VIEWPORT_SETTLE_MS)
    })
    observer.observe(scroller)
    return () => { observer.disconnect(); clearTimeout(timer) }
  }, [])

  useLayoutEffect(() => {
    if (!resizing) measureViewportRef.current()
  }, [resizing])

  return (
    <section aria-label='Agent forks' className='flex h-full min-h-0 flex-1 flex-col overflow-hidden' style={textStyle}>
      <div ref={scrollRef} className='min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2 thin-scrollbar'>
        {forks.length === 0 && <p className='p-3 text-sm text-neutral-500' style={mutedStyle}>No captured agent forks yet.</p>}
        <div ref={gridRef} className='flex flex-col gap-3'>
          {Array.from({ length: rowCount }, (_, rowIndex) => {
            const row = forks.slice(rowIndex * columns, (rowIndex + 1) * columns)
            return <div key={rowIndex} data-agent-grid-row={rowIndex}>
              <AgentGridRow label={`Agent row ${rowIndex + 1}`}>
          {row.map(fork => {
            const stream = fork.representative
            let scrollState = scrollStates.current.get(fork.key)
            if (!scrollState) {
              scrollState = { top: 0, following: true }
              scrollStates.current.set(fork.key, scrollState)
            }
            const active = fork.activeStreams.length > 0
            const cardStyle = { backgroundColor: enabled ? getThemeModeColor(theme.colors[active ? 'agentsGridStreamingCardBg' : 'agentsGridIdleCardBg'], dark) : undefined }
            const name = stream.conversationTitle || `Conversation ${stream.conversationId || 'Unknown'}`
            return (
              <section key={fork.key} aria-label={`${name} · ${fork.displayName}`} className={`flex min-w-0 flex-col overflow-hidden rounded-2xl ${active ? 'bg-orange-50 dark:bg-orange-900/20' : 'bg-black/[0.035] dark:bg-white/5'}`} style={{ ...cardStyle, height: getAgentGridCardHeight(columns, viewportHeight) }}>
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
                {(visibleRows === null || visibleRows.has(rowIndex)) && <AgentRunPreview scrollState={scrollState} streamId={stream.streamId} grouped={grouped} isStreaming={active} wholeFork fillHeight transcriptLabel={`${name} · ${fork.displayName} transcript`} />}
              </section>
            )
          })}
              </AgentGridRow>
            </div>
          })}
        </div>
      </div>
    </section>
  )
}
