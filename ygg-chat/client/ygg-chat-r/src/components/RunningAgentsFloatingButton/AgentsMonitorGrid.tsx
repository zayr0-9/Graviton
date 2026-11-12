import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { ChevronsLeftRight, ChevronsRightLeft, Eye, EyeOff } from 'lucide-react'
import { useAppSelector } from '../../hooks/redux'
import { buildAgentForkGroups, type AgentForkGroup, type AgentStreamListItem } from '../../hooks/useRunningAgentStreams'
import { isAgentForkHidden } from '../../features/ui/runningAgentsUiSlice'
import { forkHasPreviewContent } from './agentForkPreview'
import type { AgentPreviewScrollState } from './AgentRunPreview'
import { AgentForkCard, agentCardToneClass, agentStatusDotClass, cardIconButtonClass, forkName, getAgentCardStatus, useAgentCardTheme } from './AgentForkCard'
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
  /** Session-only user hides: fork key → stream IDs seen when hidden. */
  hiddenForks?: Record<string, string[]>
  onHideFork?: (fork: AgentForkGroup) => void
  onShowFork?: (key: string) => void
  onShowAllForks?: () => void
  /** The hidden list is opened from the pill header toggle; the list renders above the cards. */
  hiddenListOpen?: boolean
  hiddenListId?: string
  onHiddenListOpenChange?: (open: boolean) => void
  hiddenToggleRef?: RefObject<HTMLButtonElement | null>
  /** Session-only: forks narrowed to a strip so their row neighbours take the width. */
  collapsedForks?: readonly string[]
  onToggleForkCollapsed?: (key: string, collapsed: boolean) => void
  /** Owned by the pill so reading positions survive opening a preview and coming back. */
  scrollStates?: Map<string, AgentPreviewScrollState>
}

const NO_COLLAPSED_FORKS: readonly string[] = []

/** A strip only helps when a neighbour can take the width; an all-collapsed row shows expanded. */
export function getEffectiveCollapsedCells(rowKeys: readonly string[], collapsed: ReadonlySet<string>): boolean[] {
  const flags = rowKeys.map(key => collapsed.has(key))
  return flags.every(Boolean) ? flags.map(() => false) : flags
}

const NO_HIDDEN_FORKS: Record<string, string[]> = {}
const forkStreamIds = (fork: AgentForkGroup) => [...fork.activeStreams, ...fork.completedStreams].map(stream => stream.streamId)

/**
 * Grid membership shared by the grid and the pill header's hidden toggle. A finished fork with
 * no captured output would only say "Waiting for run output…" until its preview is released;
 * live forks always stay because their card carries the working animation.
 */
export function useAgentGridForks(activeStreams: AgentStreamListItem[], streamHistory: AgentStreamListItem[],
  hiddenForks: Record<string, string[]> = NO_HIDDEN_FORKS): { forks: AgentForkGroup[]; hiddenList: AgentForkGroup[] } {
  const allForks = useMemo(() => {
    const { activeForks, historyForks } = buildAgentForkGroups(activeStreams, streamHistory)
    return [...activeForks, ...historyForks]
  }, [activeStreams, streamHistory])
  const finishedIds = useMemo(() => allForks.filter(fork => fork.activeStreams.length === 0)
    .map(fork => fork.representative.streamId), [allForks])
  // A string result keeps token updates from rerendering the grid or the pill.
  const emptyIdsKey = useAppSelector(state => JSON.stringify(finishedIds.filter(id =>
    !forkHasPreviewContent(state.agentRunPreviews.byStreamId, id))))
  return useMemo(() => {
    const empty = new Set<string>(JSON.parse(emptyIdsKey))
    const shown: AgentForkGroup[] = []
    const hidden: AgentForkGroup[] = []
    for (const fork of allForks) {
      if (fork.activeStreams.length === 0 && empty.has(fork.representative.streamId)) continue
      ;(isAgentForkHidden(hiddenForks, fork.key, forkStreamIds(fork)) ? hidden : shown).push(fork)
    }
    return { forks: shown, hiddenList: hidden }
  }, [allForks, emptyIdsKey, hiddenForks])
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
export function AgentsMonitorGrid({ activeStreams, streamHistory, grouped, onOpenFork, onOpenChat, resizing = false,
  hiddenForks = NO_HIDDEN_FORKS, onHideFork, onShowFork, onShowAllForks,
  hiddenListOpen = false, hiddenListId, onHiddenListOpenChange, hiddenToggleRef,
  collapsedForks = NO_COLLAPSED_FORKS, onToggleForkCollapsed, scrollStates: sharedScrollStates }: AgentsMonitorGridProps) {
  const gridRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewportHeight, setViewportHeight] = useState<number | null>(null)
  const resizingRef = useRef(resizing)
  resizingRef.current = resizing
  const measureViewportRef = useRef<() => void>(() => {})
  // View state only: transcript data stays in Redux, even while offscreen.
  const ownScrollStates = useRef(new Map<string, AgentPreviewScrollState>())
  const scrollStates = sharedScrollStates ?? ownScrollStates.current
  const [columns, setColumns] = useState(1)
  const { color, mutedStyle, secondaryStyle, panelStyle, cardStyle, statusDotStyle } = useAgentCardTheme()
  const { forks, hiddenList } = useAgentGridForks(activeStreams, streamHistory, hiddenForks)
  const hiddenOpen = hiddenListOpen && hiddenList.length > 0
  const closeHiddenList = () => onHiddenListOpenChange?.(false)
  const focusCard = (key: string) => requestAnimationFrame(() => {
    const card = Array.from(gridRef.current?.querySelectorAll<HTMLElement>('[data-agent-fork-key]') ?? [])
      .find(element => element.dataset.agentForkKey === key)
    card?.querySelector<HTMLButtonElement>('button')?.focus()
  })
  const hideFork = (fork: AgentForkGroup) => {
    onHideFork?.(fork)
    requestAnimationFrame(() => hiddenToggleRef?.current?.focus())
  }
  const collapsedSet = useMemo(() => new Set(collapsedForks), [collapsedForks])
  // The toggle unmounts as the card swaps layout; keep keyboard focus on its replacement.
  const toggleCollapsed = (key: string, collapsed: boolean) => {
    onToggleForkCollapsed?.(key, collapsed)
    requestAnimationFrame(() => {
      const card = Array.from(gridRef.current?.querySelectorAll<HTMLElement>('[data-agent-fork-key]') ?? [])
        .find(element => element.dataset.agentForkKey === key)
      card?.querySelector<HTMLButtonElement>('[data-card-collapse-toggle]')?.focus()
    })
  }
  const showFork = (fork: AgentForkGroup) => {
    onShowFork?.(fork.key)
    focusCard(fork.key)
  }
  useEffect(() => {
    const keys = new Set(forks.map(fork => fork.key))
    for (const key of scrollStates.keys()) if (!keys.has(key)) scrollStates.delete(key)
  }, [forks, scrollStates])
  const rowCount = Math.ceil(forks.length / columns)
  const visibleRows = useVisibleAgentGridRows(gridRef, scrollRef, rowCount, columns)
  const textStyle: CSSProperties & Record<'--agents-grid-streaming-bg' | '--agents-grid-idle-bg', string | undefined> = {
    color: color('toolJobsPrimaryText'),
    '--agents-grid-streaming-bg': color('composerToggleActiveBg'),
    '--agents-grid-idle-bg': color('settingsCustomThemesInnerCardBg'),
  }

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
      {hiddenOpen && <div id={hiddenListId} role='region' aria-label='Hidden agent forks'
        className='mx-2 mb-2 flex max-h-56 shrink-0 flex-col rounded-2xl bg-black/[0.035] p-1.5 dark:bg-white/5' style={panelStyle}
        onKeyDown={event => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          closeHiddenList()
          hiddenToggleRef?.current?.focus()
        }}>
        <div className='flex shrink-0 items-center justify-between gap-2 px-2 py-1'>
          <span className='text-xs font-semibold'>Hidden from grid</span>
          <button type='button' onClick={() => { const first = hiddenList[0]; onShowAllForks?.(); closeHiddenList(); if (first) focusCard(first.key) }}
            className='rounded-full px-2.5 py-1 text-xs font-medium transition-[background-color,color,opacity] duration-150 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 bg-white/70 text-neutral-700 dark:bg-white/10 dark:text-neutral-200'
            style={secondaryStyle}>
            Show all
          </button>
        </div>
        <ul className='min-h-0 overflow-y-auto overscroll-contain thin-scrollbar'>
          {hiddenList.map(fork => {
            const name = forkName(fork)
            const status = getAgentCardStatus(fork)
            return (
              <li key={fork.key} className='flex min-w-0 items-center gap-2 rounded-xl px-2 py-1.5 text-xs'>
                <span className={`h-2 w-2 shrink-0 rounded-full ${agentStatusDotClass(status)}`} style={statusDotStyle(status)} aria-hidden='true' />
                <span className='min-w-0 flex-1 truncate font-medium' title={name}>{name}</span>
                <span className='shrink-0 text-neutral-500 dark:text-neutral-400' style={mutedStyle}>{fork.displayName} · {status.label}</span>
                <button type='button' onClick={() => showFork(fork)} aria-label={`Show ${name} · ${fork.displayName}`} title='Show in grid'
                  className='flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-[background-color,color,opacity,transform] duration-150 hover:opacity-90 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 bg-white/70 text-neutral-700 dark:bg-white/10 dark:text-neutral-200'
                  style={secondaryStyle}>
                  <Eye size={16} strokeWidth={2.25} aria-hidden='true' />
                </button>
              </li>
            )
          })}
        </ul>
      </div>}
      <div ref={scrollRef} className='min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2 thin-scrollbar'>
        {forks.length === 0 && <p className='p-3 text-sm text-neutral-500' style={mutedStyle}>
          {hiddenList.length > 0 ? 'All agent forks are hidden.' : 'No captured agent forks yet.'}
        </p>}
        <div ref={gridRef} className='flex flex-col gap-3'>
          {Array.from({ length: rowCount }, (_, rowIndex) => {
            const row = forks.slice(rowIndex * columns, (rowIndex + 1) * columns)
            const collapsedCells = getEffectiveCollapsedCells(row.map(fork => fork.key), collapsedSet)
            const expandedCount = collapsedCells.filter(collapsed => !collapsed).length
            return <div key={rowIndex} data-agent-grid-row={rowIndex}>
              <AgentGridRow label={`Agent row ${rowIndex + 1}`} collapsed={collapsedCells}>
          {row.map((fork, cellIndex) => {
            const stream = fork.representative
            let scrollState = scrollStates.get(fork.key)
            if (!scrollState) {
              scrollState = { top: 0, following: true }
              scrollStates.set(fork.key, scrollState)
            }
            const status = getAgentCardStatus(fork)
            const name = forkName(fork)
            const cardHeight = getAgentGridCardHeight(columns, viewportHeight)
            if (collapsedCells[cellIndex]) return (
              <section key={fork.key} data-agent-fork-key={fork.key} aria-label={`${name} · ${fork.displayName} (collapsed)`}
                className={`flex min-w-0 flex-col items-center gap-2 overflow-hidden rounded-2xl py-2 ${agentCardToneClass(status.active)}`}
                style={{ ...cardStyle(status.active), height: cardHeight }}>
                <button type='button' data-card-collapse-toggle onClick={() => toggleCollapsed(fork.key, false)} aria-expanded={false}
                  aria-label={`Expand ${name} · ${fork.displayName}`} title='Expand card'
                  className={`${cardIconButtonClass} h-8 w-8`} style={mutedStyle}>
                  <ChevronsLeftRight size={16} strokeWidth={2.25} aria-hidden='true' />
                </button>
                <span className={`h-2 w-2 shrink-0 rounded-full ${agentStatusDotClass(status)}`} style={statusDotStyle(status)} title={status.label} aria-hidden='true' />
                <button type='button' onClick={() => onOpenFork(stream)} aria-label={`Preview ${name} · ${fork.displayName}`} title={`${name} · ${fork.displayName}`}
                  className='min-h-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-lg px-1 py-1 text-xs font-semibold [writing-mode:vertical-rl] hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 dark:hover:bg-white/5'>
                  {name} <span className='font-normal text-neutral-500 dark:text-neutral-400' style={mutedStyle}>· {fork.displayName}</span>
                </button>
              </section>
            )
            return (
              <AgentForkCard key={fork.key} fork={fork} grouped={grouped} onOpen={onOpenFork} onOpenChat={onOpenChat}
                scrollState={scrollState} mountTranscript={visibleRows === null || visibleRows.has(rowIndex)}
                style={{ height: cardHeight }}
                actions={<>
                  {onToggleForkCollapsed && expandedCount > 1 && <button type='button' data-card-collapse-toggle onClick={() => toggleCollapsed(fork.key, true)}
                    aria-expanded aria-label={`Collapse ${name} · ${fork.displayName}`} title='Collapse card'
                    className={`${cardIconButtonClass} h-7 w-7`} style={mutedStyle}>
                    <ChevronsRightLeft size={16} strokeWidth={2.25} aria-hidden='true' />
                  </button>}
                  {onHideFork && <button type='button' onClick={() => hideFork(fork)} aria-label={`Hide ${name} · ${fork.displayName}`} title='Hide from grid'
                    className={`${cardIconButtonClass} h-7 w-7`} style={mutedStyle}>
                    <EyeOff size={16} strokeWidth={2.25} aria-hidden='true' />
                  </button>}
                </>} />
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
