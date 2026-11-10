import React, { useEffect, useRef, useState } from 'react'
import { ChevronDown, Square, SquareTerminal } from 'lucide-react'
import type { HeadlessBackgroundTask, HeadlessBackgroundTaskOutput } from '../../../../../shared/headlessApi'
import {
  backgroundTaskHasOutput,
  backgroundTaskKindLabel,
  backgroundTaskMetrics,
  backgroundTaskStatusLine,
  backgroundTasksSummary,
  fetchBackgroundTaskOutput,
  stopBackgroundTask,
} from '../../features/chats/backgroundTasks'
import { MESSAGE_BLOCK_INSET_CLASS } from '../ChatMessage/chatMessageShared'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'
import { STREAMING_TAB_SURFACE_CLASS, type StreamingThinkingIndicatorVariant } from './StreamingThinkingIndicator'

const OUTPUT_POLL_MS = 2_000

type BackgroundTasksIndicatorProps = {
  conversationId: string
  streamId: string
  tasks: HeadlessBackgroundTask[]
  /** Claude finished its turn: the run is open only for these tasks. */
  idle: boolean
  variant?: StreamingThinkingIndicatorVariant
  style?: React.CSSProperties
}

/**
 * The background tasks keeping a Claude run open, with a way to stop each one. While the turn is
 * idle this stands in for the "Composing" indicator, which would otherwise suggest Claude is working.
 */
export const BackgroundTasksIndicator = React.memo(function BackgroundTasksIndicator({
  conversationId,
  streamId,
  tasks,
  idle,
  variant = 'inline',
  style,
}: BackgroundTasksIndicatorProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { theme, enabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()
  const mutedColor = enabled ? getThemeModeColor(theme.colors.toolJobsMutedText, isDarkMode) : undefined

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])
  useEffect(() => { if (!tasks.length) setOpen(false) }, [tasks.length])

  if (!tasks.length) return null
  const summary = backgroundTasksSummary(tasks.length)
  const surfaceClassName = variant === 'tab' ? STREAMING_TAB_SURFACE_CLASS : `relative rounded-md ${MESSAGE_BLOCK_INSET_CLASS} py-0.5`

  return (
    <div
      ref={rootRef}
      className={`inline-flex items-center text-[0.75em] leading-[1.2] text-neutral-500 dark:text-neutral-400 ${surfaceClassName}`}
      style={{ color: mutedColor, ...style }}
    >
      <button
        type='button'
        className='relative z-10 flex items-center gap-1.5 rounded font-medium hover:text-neutral-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current dark:hover:text-neutral-200'
        aria-expanded={open}
        aria-haspopup='dialog'
        aria-label={idle ? `Claude finished; ${summary} still running` : `${summary} running`}
        onClick={() => setOpen(value => !value)}
      >
        <SquareTerminal aria-hidden='true' className='h-3.5 w-3.5 shrink-0' />
        <span>{idle ? `Waiting on ${summary}` : summary}</span>
        <ChevronDown aria-hidden='true' className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          role='dialog'
          aria-label='Background tasks'
          className='absolute bottom-full left-0 z-50 mb-2 w-[min(28rem,calc(100vw-2rem))] rounded-xl bg-neutral-50/95 p-1.5 text-[12px] text-neutral-700 shadow-lg backdrop-blur-xl dark:bg-neutral-900/95 dark:text-neutral-200'
        >
          <p className='px-2 pb-1.5 pt-1 text-[11px] text-neutral-500 dark:text-neutral-400'>
            {idle
              ? 'Claude finished its reply. These keep the run open; you can still send messages. Stopping the run ends them all.'
              : 'Running alongside Claude.'}
          </p>
          <ul className='flex max-h-80 flex-col gap-1 overflow-y-auto'>
            {tasks.map(task => (
              <BackgroundTaskRow key={task.id} task={task} conversationId={conversationId} streamId={streamId} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
})

function BackgroundTaskRow({ task, conversationId, streamId }: { task: HeadlessBackgroundTask; conversationId: string; streamId: string }) {
  const [stopping, setStopping] = useState(false)
  const [showOutput, setShowOutput] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const output = useTaskOutput(showOutput, { conversationId, streamId, taskId: task.id })
  const statusLine = backgroundTaskStatusLine(task)
  const metrics = backgroundTaskMetrics(task)

  const stop = async () => {
    setStopping(true)
    setError(null)
    try {
      await stopBackgroundTask({ conversationId, streamId, taskId: task.id })
      // The row disappears when the run's next background_tasks event drops it.
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStopping(false)
    }
  }

  return (
    <li className='rounded-lg px-2 py-1.5 hover:bg-neutral-200/50 dark:hover:bg-neutral-800/60'>
      <div className='flex items-center gap-2'>
        <span className='shrink-0 rounded bg-neutral-200/70 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'>
          {backgroundTaskKindLabel(task.kind)}
        </span>
        <span className='min-w-0 flex-1 truncate' title={task.description}>{task.description || task.id}</span>
        {backgroundTaskHasOutput(task) && (
          <button
            type='button'
            className='shrink-0 rounded px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-200 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-100'
            aria-expanded={showOutput}
            onClick={() => setShowOutput(value => !value)}
          >
            {showOutput ? 'Hide output' : 'Output'}
          </button>
        )}
        <button
          type='button'
          className='flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400'
          disabled={stopping}
          onClick={() => void stop()}
          aria-label={`Stop ${task.description || task.id}`}
        >
          <Square aria-hidden='true' className='h-2.5 w-2.5 fill-current' />
          {stopping ? 'Stopping…' : 'Stop'}
        </button>
      </div>
      {(statusLine || metrics) && (
        <div className='mt-0.5 min-w-0 text-[11px] leading-snug text-neutral-500 dark:text-neutral-400'>
          {statusLine && <p className='truncate' title={statusLine}>{statusLine}</p>}
          {metrics && <p className='truncate tabular-nums'>{metrics}</p>}
        </div>
      )}
      {error && <p role='alert' className='mt-1 text-[11px] text-red-600 dark:text-red-400'>{error}</p>}
      {showOutput && (
        <pre className='mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-neutral-200/60 p-2 font-mono text-[11px] leading-snug text-neutral-700 dark:bg-neutral-950/70 dark:text-neutral-300'>
          {output.error ? output.error : output.value == null ? 'Loading…' : output.value.output || 'No output yet.'}
          {output.value?.truncated ? '\n… showing the last 8 KiB' : ''}
        </pre>
      )}
    </li>
  )
}

/** Polls the task's output tail while it is shown. */
function useTaskOutput(enabled: boolean, target: { conversationId: string; streamId: string; taskId: string }) {
  const [state, setState] = useState<{ value: HeadlessBackgroundTaskOutput | null; error: string | null }>({ value: null, error: null })
  const { conversationId, streamId, taskId } = target
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const value = await fetchBackgroundTaskOutput({ conversationId, streamId, taskId })
        if (!cancelled) setState({ value, error: null })
      } catch (cause) {
        if (!cancelled) setState(previous => ({ ...previous, error: cause instanceof Error ? cause.message : String(cause) }))
      }
      if (!cancelled) timer = setTimeout(poll, OUTPUT_POLL_MS)
    }
    void poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [enabled, conversationId, streamId, taskId])
  return state
}
