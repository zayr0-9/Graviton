import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ChevronRight, CircleCheck, CircleDashed, CircleX, Clock3 } from 'lucide-react'
import type { HookRunRecord } from '../../features/chats/chatTypes'
import { localApi } from '../../utils/api'
import { TEXT_DETAIL_CLASS, TEXT_MICRO_CLASS } from './chatMessageShared'
import { ACTIVE_HOOK_RUN_STATUSES, areHookRunSetsEqual, didHookRunsSettle, hasActiveHookRuns } from './hookActivityState'

interface HookActivityCardProps {
  initialRuns: HookRunRecord[]
  messageId: string
  event?: string
  fontSizeOffset?: number
  onLayoutChange?: () => void
  onRunsUpdated?: (runs: HookRunRecord[]) => void
  onRunsSettled?: () => void
}
const eventLabel = (event: string) => event === 'Stop' ? 'Reply finished' : event.replace(/([a-z])([A-Z])/g, '$1 $2')
const scopeLabel = (scope: HookRunRecord['scope']) => scope === 'local_override' ? 'local override' : scope
const durationLabel = (value: number | null) => value == null ? '' : value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`

function mergeRuns(current: HookRunRecord[], incoming: HookRunRecord[]): HookRunRecord[] {
  const byId = new Map(current.map(run => [run.id, run]))
  for (const run of incoming) {
    const previous = byId.get(run.id)
    if (!previous || new Date(run.updatedAt).getTime() >= new Date(previous.updatedAt).getTime()) byId.set(run.id, run)
  }
  return Array.from(byId.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export function summarizeHookRuns(runs: HookRunRecord[]): string {
  const failed = runs.filter(run => run.status === 'failed' || run.status === 'timed_out').length
  const running = runs.filter(run => ACTIVE_HOOK_RUN_STATUSES.has(run.status)).length
  if (failed) return `${failed} failed`
  if (running) return `${running} running`
  return `${runs.length} ran`
}

function statusIcon(status: HookRunRecord['status']) {
  if (status === 'failed' || status === 'timed_out') return <CircleX size={15} className='text-red-500' />
  if (ACTIVE_HOOK_RUN_STATUSES.has(status)) return <CircleDashed size={15} className='animate-spin text-amber-500' />
  if (status === 'skipped') return <Clock3 size={15} className='text-stone-500' />
  return <CircleCheck size={15} className='text-emerald-500' />
}

export const HookActivityCard: React.FC<HookActivityCardProps> = ({ initialRuns, messageId, event, fontSizeOffset = 0, onLayoutChange, onRunsUpdated, onRunsSettled }) => {
  const [runs, setRuns] = useState(initialRuns)
  const [expanded, setExpanded] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const onRunsUpdatedRef = useRef(onRunsUpdated)
  const onRunsSettledRef = useRef(onRunsSettled)
  useEffect(() => { onRunsUpdatedRef.current = onRunsUpdated }, [onRunsUpdated])
  useEffect(() => { onRunsSettledRef.current = onRunsSettled }, [onRunsSettled])
  useEffect(() => setRuns(current => {
    const merged = mergeRuns(current, initialRuns)
    return areHookRunSetsEqual(current, merged) ? current : merged
  }), [initialRuns])
  const active = hasActiveHookRuns(runs)

  useEffect(() => {
    if (!active || !messageId) return
    let cancelled = false
    let timer: number | null = null
    let currentRuns = runs
    const schedule = () => {
      if (!cancelled && hasActiveHookRuns(currentRuns)) timer = window.setTimeout(refresh, 1200)
    }
    const refresh = async () => {
      try {
        const response = await localApi.get<{ runs: HookRunRecord[] }>(`/hooks/runs?messageId=${encodeURIComponent(messageId)}&limit=500`)
        if (cancelled) return
        const incoming = response.runs || []
        const settled = didHookRunsSettle(hasActiveHookRuns(currentRuns), incoming)
        const changed = !areHookRunSetsEqual(currentRuns, incoming)
        currentRuns = incoming
        if (changed) {
          setRuns(incoming)
          onRunsUpdatedRef.current?.(incoming)
        }
        if (settled) onRunsSettledRef.current?.()
      } catch { /* durable diagnostics remain available even if refresh fails */ }
      schedule()
    }
    void refresh()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [active, messageId])

  useEffect(() => { onLayoutChange?.() }, [expanded, openId, runs, onLayoutChange])

  const summary = useMemo(() => summarizeHookRuns(runs), [runs])
  if (runs.length === 0) return null

  return (
    <div className='rounded-2xl bg-white/50 backdrop-blur-xl dark:bg-black/15' style={fontSizeOffset ? { fontSize: `calc(1em + ${fontSizeOffset}px)` } : undefined} data-testid='hook-activity-card'>
      <button type='button' className='flex w-full items-center gap-2.5 rounded-2xl px-3.5 py-2.5 text-left hover:bg-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 dark:hover:bg-white/5' onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>
        <Activity size={18} className={runs.some(run => run.status === 'failed' || run.status === 'timed_out') ? 'text-red-500' : 'text-cyan-600 dark:text-cyan-300'} />
        <span className={`font-mono ${TEXT_MICRO_CLASS} font-bold uppercase tracking-[0.12em] text-cyan-700 dark:text-cyan-300`}>Hooks</span>
        <span className={`${TEXT_DETAIL_CLASS} text-stone-600 dark:text-stone-300`}>· {new Set(runs.map(run => run.event)).size === 1 ? eventLabel(event || runs[0].event) : 'Multiple lifecycle points'} · {summary}</span>
        <ChevronRight size={18} className={`ml-auto transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`} />
      </button>
      {expanded && <ul className='space-y-1 px-2 pb-2'>
        {runs.map(run => {
          const detailOpen = openId === run.id
          const failed = run.status === 'failed' || run.status === 'timed_out'
          return <li key={run.id} className='rounded-xl bg-black/[0.025] dark:bg-white/[0.035]'>
            <button type='button' onClick={() => setOpenId(detailOpen ? null : run.id)} className='flex w-full items-center gap-2 px-2.5 py-2 text-left' aria-expanded={detailOpen}>
              {statusIcon(run.status)}
              <span className='min-w-0 flex-1 truncate font-mono text-xs text-stone-800 dark:text-stone-100'>{run.label}</span>
              <span className='text-[11px] text-stone-500'>{eventLabel(run.event)} · {scopeLabel(run.scope)}</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase ${failed ? 'bg-red-500/10 text-red-600 dark:text-red-300' : 'bg-black/5 text-stone-600 dark:bg-white/10 dark:text-stone-300'}`}>{run.status}</span>
              <span className='w-10 text-right text-[11px] text-stone-500'>{durationLabel(run.durationMs)}</span>
            </button>
            {detailOpen && <div className='space-y-2 px-3 pb-3 text-xs text-stone-600 dark:text-stone-300'>
              <p>{run.outcomeSummary || run.outcomeCode || run.status}</p>
              {run.errorSummary && <pre className='max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-red-500/10 p-2 text-red-700 dark:text-red-200'>{run.errorSummary}</pre>}
              {run.stderrPreview && <Details label='stderr' value={run.stderrPreview} />}
              {run.stdoutPreview && <Details label='output' value={run.stdoutPreview} />}
              <dl className='grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 break-all font-mono text-[11px]'>
                <dt>command</dt><dd>{run.configuredCommand}</dd>
                {run.executedCommand && run.executedCommand !== run.configuredCommand && <><dt>executed</dt><dd>{run.executedCommand}</dd></>}
                <dt>source</dt><dd>{run.sourceFile}</dd>
                <dt>cwd</dt><dd>{run.cwd || '—'}</dd>
                <dt>time</dt><dd>{run.completedAt || run.startedAt || run.createdAt}</dd>
                <dt>log</dt><dd>{run.logPath || '—'}{run.logFallback ? ' (fallback)' : ''}</dd>
              </dl>
            </div>}
          </li>
        })}
      </ul>}
    </div>
  )
}

const Details: React.FC<{ label: string; value: string }> = ({ label, value }) => <div><p className='mb-1 font-mono text-[10px] uppercase tracking-wider'>{label}</p><pre className='max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-black/5 p-2 dark:bg-white/5'>{value}</pre></div>

export default HookActivityCard
