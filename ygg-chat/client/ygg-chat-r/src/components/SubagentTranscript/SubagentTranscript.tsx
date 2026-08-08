import 'boxicons'
import 'boxicons/css/boxicons.min.css'
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import type { SubagentRunRow } from '../../../../../shared/types'
import { useSubagentByToolCall } from '../../hooks/useQueries'
import { buildLocalApiUrl, environment } from '../../utils/api'
import { Button } from '../Button/button'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'
import {
  REASONING_CHEVRON_BASE_CLASS,
  REASONING_TEXT_MARKDOWN_CLASS,
  TOOL_CHEVRON_BASE_CLASS,
  TOOL_NAME_ERROR_CLASS,
  TOOL_NAME_RUNNING_CLASS,
  TOOL_NAME_SUCCESS_CLASS,
} from '../ChatMessage/chatMessageShared'

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Parse a persisted content_blocks column (array | JSON string | null) into an array. */
function normalizeContentBlocks(blocks: any): any[] {
  if (!blocks) return []
  if (Array.isArray(blocks)) return blocks
  if (typeof blocks === 'string') {
    try {
      const parsed = JSON.parse(blocks)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

/**
 * Flatten a run's persisted messages into a single ordered list of renderable
 * blocks (thinking / text / tool_use / tool_result). Mirrors Heimdall's
 * buildDedicatedSubagentMap per-run logic. The initial user prompt is rendered
 * separately (see SubagentRunView) so it is skipped here to avoid duplication.
 */
function flattenRunToBlocks(run: SubagentRunRow): any[] {
  const combined: any[] = []
  const messages = Array.isArray(run.messages) ? run.messages : []
  const prompt = (run.prompt ?? '').trim()

  messages.forEach(message => {
    if (message.role === 'user' && (message.content ?? '').trim() === prompt) return
    const blocks = normalizeContentBlocks(message.content_blocks)
    const hasTextBlock = blocks.some((block: any) => block?.type === 'text')
    if (message.thinking_block) {
      combined.push({ type: 'thinking', content: message.thinking_block })
    }
    if (message.content && message.content.trim() && !hasTextBlock) {
      combined.push({ type: 'text', content: message.content })
    }
    if (blocks.length > 0) combined.push(...blocks)
  })

  if (run.status === 'error' && run.error) {
    combined.push({ type: 'text', content: `Subagent error: ${run.error}` })
  }
  return combined
}

// ── Status presentation ─────────────────────────────────────────────────────

type KnownStatus = 'running' | 'completed' | 'error' | 'aborted'

const STATUS_BADGE_CLASS: Record<KnownStatus, string> = {
  running: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  error: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  aborted: 'bg-stone-200 text-stone-600 dark:bg-neutral-700 dark:text-stone-300',
}

const STATUS_LABEL: Record<KnownStatus, string> = {
  running: 'Running',
  completed: 'Completed',
  error: 'Error',
  aborted: 'Aborted',
}

function asKnownStatus(status: string | null | undefined): KnownStatus {
  return status === 'running' || status === 'completed' || status === 'error' || status === 'aborted'
    ? status
    : 'running'
}

/**
 * Tool-name class for a subagent tool card, derived from the *run status* rather
 * than the card's result-derived class. An async spawn's tool result is just a
 * handle, so the generic card would show "success" while the run is still going —
 * this keeps the running shimmer until the run actually terminates.
 */
export function subagentStatusToolNameClass(status: string | null | undefined): string {
  switch (asKnownStatus(status)) {
    case 'running':
      return TOOL_NAME_RUNNING_CLASS
    case 'error':
      return TOOL_NAME_ERROR_CLASS
    case 'aborted':
    case 'completed':
    default:
      return TOOL_NAME_SUCCESS_CLASS
  }
}

/**
 * The tool-name span for a subagent tool card, with its class driven by the live
 * run status (fetched here so ChatMessage's renderToolCallGroupCard — which runs
 * inside a map — never calls a hook itself). Falls back to the card's own class
 * until the run resolves (or when not on electron, where the query is disabled).
 */
export const SubagentToolName: React.FC<{
  toolCallId: string
  name: string
  fallbackClass: string
}> = ({ toolCallId, name, fallbackClass }) => {
  const { data } = useSubagentByToolCall(toolCallId)
  const run = data?.runs?.[0]
  const className = run ? subagentStatusToolNameClass(run.status) : fallbackClass
  return <span className={className}>{name || 'tool'}</span>
}

const StatusBadge: React.FC<{ status: string | null | undefined }> = ({ status }) => {
  const known = asKnownStatus(status)
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${STATUS_BADGE_CLASS[known]}`}
    >
      {known === 'running' && <span className='h-1.5 w-1.5 rounded-full bg-current animate-pulse' aria-hidden='true' />}
      {STATUS_LABEL[known]}
    </span>
  )
}

// ── Block + run renderers ─────────────────────────────────────────────────────

/**
 * Collapsed-by-default disclosure for a transcript block: a clickable header
 * row (label + chevron) and a smooth expand/collapse body using the same
 * `tool-expand-container`/`tool-expand-content` transition classes as the main
 * chat's tool/process cards. Defaults to the tool-chevron styling; reasoning
 * blocks pass the reasoning chevron class.
 */
const CollapsibleBlock: React.FC<{
  label: string
  labelClass?: string
  lineLabelClass?: string
  chevronBaseClass?: string
  content: React.ReactNode
}> = ({ label, labelClass, lineLabelClass, chevronBaseClass = TOOL_CHEVRON_BASE_CLASS, content }) => {
  const [isExpanded, setIsExpanded] = useState(false)
  return (
    <div className='min-w-0 max-w-full space-y-1'>
      <button
        type='button'
        onClick={() => setIsExpanded(v => !v)}
        aria-expanded={isExpanded}
        className='flex min-w-0 max-w-full flex-wrap items-center gap-1.5 group/tool hover:opacity-80 transition-opacity cursor-pointer outline-none'
      >
        {lineLabelClass ? (
          <span className={lineLabelClass}>{label}</span>
        ) : (
          <span className={labelClass ?? ''}>{label}</span>
        )}
        <svg
          className={`${chevronBaseClass} ${isExpanded ? 'open' : ''}`}
          fill='none'
          viewBox='0 0 24 24'
          stroke='currentColor'
        >
          <path strokeLinecap='round' strokeLinejoin='round' strokeWidth={2} d='M9 5l7 7-7 7' />
        </svg>
      </button>
      <div className={`tool-expand-container ${isExpanded ? 'open' : ''}`}>
        <div className='tool-expand-content'>{content}</div>
      </div>
    </div>
  )
}

const TranscriptBlock: React.FC<{ block: any }> = ({ block }) => {
  if (block.type === 'text') {
    const textContent = block.content ?? block.text
    if (!textContent) return null
    return (
      <div className='prose prose-sm dark:prose-invert max-w-none text-stone-700 dark:text-stone-300 prose-p:my-1 prose-pre:my-2 prose-pre:bg-stone-100 dark:prose-pre:bg-neutral-800 prose-code:text-orange-600 dark:prose-code:text-orange-400 prose-pre:text-xs prose-pre:overflow-x-auto'>
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}>
          {textContent}
        </ReactMarkdown>
      </div>
    )
  }

  if (block.type === 'tool_use') {
    const input = block.input
    const inputText = input == null ? null : typeof input === 'string' ? input : JSON.stringify(input, null, 2)
    return (
      <CollapsibleBlock
        label={block.name || 'tool'}
        labelClass={TOOL_NAME_SUCCESS_CLASS}
        content={
          inputText != null ? (
            <pre className='whitespace-pre-wrap break-words text-[0.8125em] leading-relaxed text-neutral-500 dark:text-neutral-400'>
              {inputText}
            </pre>
          ) : null
        }
      />
    )
  }

  if (block.type === 'tool_result') {
    const isError = block.is_error
    const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content, null, 2)
    return (
      <CollapsibleBlock
        label={isError ? 'Error' : 'Result'}
        labelClass={isError ? TOOL_NAME_ERROR_CLASS : TOOL_NAME_SUCCESS_CLASS}
        content={
          <pre className='whitespace-pre-wrap break-words text-[0.8125em] leading-relaxed text-neutral-500 dark:text-neutral-400'>
            {content}
          </pre>
        }
      />
    )
  }

  if (block.type === 'thinking' && block.content) {
    return (
      <CollapsibleBlock
        label='Thinking'
        chevronBaseClass={REASONING_CHEVRON_BASE_CLASS}
        lineLabelClass='text-[0.8125em] leading-none text-neutral-800 dark:text-neutral-500'
        content={
          <div className={REASONING_TEXT_MARKDOWN_CLASS}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.content}</ReactMarkdown>
          </div>
        }
      />
    )
  }

  return null
}

/** Renders a single subagent run: status header + prompt + flattened transcript. */
export const SubagentRunView: React.FC<{ run: SubagentRunRow; index?: number; total?: number }> = ({
  run,
  index,
  total,
}) => {
  const blocks = flattenRunToBlocks(run)
  const prompt = (run.prompt ?? '').trim()
  const showRunLabel = typeof total === 'number' && total > 1

  return (
    <div className='px-5 py-4'>
      <div className='flex flex-wrap items-center gap-2 mb-3'>
        {showRunLabel && (
          <span className='inline-flex items-center justify-center w-6 h-6 rounded-full bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 text-xs font-bold'>
            {(index ?? 0) + 1}
          </span>
        )}
        <span className='text-xs font-semibold text-orange-600 dark:text-orange-400 uppercase tracking-wider'>
          Subagent Run
        </span>
        <StatusBadge status={run.status} />
        {run.handle && (
          <span className='text-[10px] font-mono text-stone-500 dark:text-stone-400'>#{run.handle}</span>
        )}
        {run.model_name && (
          <span className='text-[10px] text-stone-400 dark:text-stone-500'>{run.model_name}</span>
        )}
      </div>

      {prompt && (
        <div className='mb-3'>
          <div className='text-[10px] font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wider mb-1'>
            Prompt
          </div>
          <div className='prose prose-sm dark:prose-invert max-w-none text-stone-800 dark:text-stone-200 prose-p:my-1 prose-pre:my-2 prose-pre:bg-stone-100 dark:prose-pre:bg-neutral-800 prose-code:text-orange-600 dark:prose-code:text-orange-400 prose-pre:text-xs prose-pre:overflow-x-auto'>
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}>
              {prompt}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {blocks.length > 0 ? (
        <div className='space-y-3 mt-3'>
          {blocks.map((block, blockIdx) => (
            <TranscriptBlock key={blockIdx} block={block} />
          ))}
        </div>
      ) : (
        run.status === 'running' && (
          <div className='text-xs text-stone-500 dark:text-stone-400 italic'>Subagent is still working…</div>
        )
      )}
    </div>
  )
}

/** Standalone transcript for a set of runs (no modal chrome). */
export const SubagentTranscript: React.FC<{ runs: SubagentRunRow[] }> = ({ runs }) => (
  <div className='divide-y divide-stone-100 dark:divide-neutral-800'>
    {runs.map((run, i) => (
      <SubagentRunView key={run.id} run={run} index={i} total={runs.length} />
    ))}
  </div>
)

// ── Live streaming (Phase 6) ──────────────────────────────────────────────────

interface SubagentLiveState {
  /** Streamed text for the in-progress (not-yet-persisted) turn. */
  text: string
  /** Streamed reasoning for the in-progress turn. */
  reasoning: string
  /** Terminal reached (complete/error) or the stream was already gone (410). */
  done: boolean
}

const EMPTY_LIVE: SubagentLiveState = { text: '', reasoning: '', done: false }

/**
 * Subscribe to a running subagent's child stream (GET /api/streams/:streamId) and
 * expose the in-progress turn's streamed text/reasoning. On each turn boundary
 * (assistant_message_persisted) and on the terminal complete/error it invalidates
 * the persisted transcript query so the modal folds finished turns into the clean
 * transcript. Enabled only while a run is actually running (and on electron); a
 * 410 (session already reaped) just resolves `done` and the persisted view stands.
 * Re-runs when `streamId` changes — which is exactly how a resume re-targets.
 */
export function useSubagentLiveStream(
  toolCallId: string | null,
  streamId: string | null | undefined,
  active: boolean
): SubagentLiveState {
  const queryClient = useQueryClient()
  const [state, setState] = useState<SubagentLiveState>(EMPTY_LIVE)
  const textRef = useRef('')
  const reasoningRef = useRef('')

  useEffect(() => {
    if (!active || !streamId || environment !== 'electron') {
      setState(EMPTY_LIVE)
      return
    }
    let cancelled = false
    const controller = new AbortController()
    textRef.current = ''
    reasoningRef.current = ''
    setState(EMPTY_LIVE)

    const invalidatePersisted = () => {
      void queryClient.invalidateQueries({ queryKey: ['subagents', 'by-tool-call', toolCallId] })
    }

    const applyEvent = (event: any) => {
      if (cancelled || !event || typeof event.type !== 'string') return
      if (event.type === 'chunk' && typeof event.delta === 'string') {
        if (event.part === 'text') {
          textRef.current += event.delta
          setState({ text: textRef.current, reasoning: reasoningRef.current, done: false })
        } else if (event.part === 'reasoning') {
          reasoningRef.current += event.delta
          setState({ text: textRef.current, reasoning: reasoningRef.current, done: false })
        }
      } else if (event.type === 'assistant_message_persisted') {
        // A turn just landed in the transcript — fold it in and reset the live tail.
        textRef.current = ''
        reasoningRef.current = ''
        setState({ text: '', reasoning: '', done: false })
        invalidatePersisted()
      } else if (event.type === 'complete' || event.type === 'error') {
        setState(s => ({ ...s, done: true }))
        invalidatePersisted()
      }
    }

    const run = async () => {
      try {
        const url = await buildLocalApiUrl(`/streams/${encodeURIComponent(streamId)}?fromSeq=0`)
        const res = await fetch(url, { signal: controller.signal })
        if (!res.ok || !res.body) {
          // 410 => the run already ended and its session was reaped; persisted stands.
          if (!cancelled) setState(s => ({ ...s, done: true }))
          return
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read()
          if (done || cancelled) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data:')) continue
            const data = line.slice('data:'.length).trim()
            if (!data || data === '[DONE]') continue
            try {
              applyEvent(JSON.parse(data))
            } catch {
              /* ignore malformed frame */
            }
          }
        }
      } catch {
        // Network error / aborted — leave the persisted transcript as the source of truth.
        if (!cancelled) setState(s => ({ ...s, done: true }))
      }
    }
    void run()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [toolCallId, streamId, active, queryClient])

  return state
}

// ── Modal ───────────────────────────────────────────────────────────────────

interface SubagentTranscriptModalProps {
  /** The provider tool_call id whose run(s) to show; null closes the modal. */
  toolCallId: string | null
  onClose: () => void
}

/**
 * Chat-scoped modal that fetches and shows a subagent's persisted transcript when
 * a tool card's "View transcript" button is clicked. Portals to <body> so it
 * escapes any transform/overflow container (mirrors ImageModal).
 */
export const SubagentTranscriptModal: React.FC<SubagentTranscriptModalProps> = ({ toolCallId, onClose }) => {
  const { data, isLoading, isError, error } = useSubagentByToolCall(toolCallId)
  const runs = data?.runs ?? []
  const streamId = data?.streamId ?? null
  const anyRunning = runs.some(run => run.status === 'running')
  // Subscribe to the child stream only while a run is actually running (the hook
  // no-ops otherwise). Re-targets automatically when streamId changes on resume.
  const live = useSubagentLiveStream(toolCallId, streamId, anyRunning && !!toolCallId)
  const { theme: customTheme, enabled: customThemeEnabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()
  if (!toolCallId) return null

  const showLiveTail = anyRunning && !live.done && Boolean(live.text || live.reasoning)
  const pickThemeColor = (color: { light: string; dark: string }, fallback: string) =>
    customThemeEnabled ? getThemeModeColor(color, isDarkMode) : fallback
  const themeColors = {
    backdrop: pickThemeColor(customTheme.colors.toolJobsModalBackdrop, 'rgba(0, 0, 0, 0.4)'),
    surface: pickThemeColor(customTheme.colors.toolJobsModalBg, isDarkMode ? '#18181b' : '#fafafa'),
    border: pickThemeColor(customTheme.colors.toolJobsModalBorder, isDarkMode ? '#404040' : '#e7e5e4'),
    panel: pickThemeColor(customTheme.colors.toolJobsPanelBg, isDarkMode ? 'rgba(23, 23, 23, 0.6)' : 'rgba(250, 250, 250, 0.8)'),
    primaryText: pickThemeColor(customTheme.colors.toolJobsPrimaryText, isDarkMode ? '#f5f5f5' : '#292524'),
    mutedText: pickThemeColor(customTheme.colors.toolJobsMutedText, isDarkMode ? '#a3a3a3' : '#78716c'),
    errorBg: pickThemeColor(customTheme.colors.toolJobsErrorBg, isDarkMode ? 'rgba(127, 29, 29, 0.2)' : 'rgba(255, 241, 242, 0.85)'),
    errorText: pickThemeColor(customTheme.colors.toolJobsErrorText, isDarkMode ? '#fda4af' : '#dc2626'),
    liveBadgeBg: pickThemeColor(customTheme.colors.toolJobsLiveBadgeBg, isDarkMode ? 'rgba(6, 78, 59, 0.3)' : 'rgba(209, 250, 229, 1)'),
    liveBadgeText: pickThemeColor(customTheme.colors.toolJobsLiveBadgeText, isDarkMode ? '#a7f3d0' : '#047857'),
    buttonBg: pickThemeColor(customTheme.colors.settingsCustomThemesButtonBg, isDarkMode ? 'rgba(38, 38, 38, 0.8)' : '#ffffff'),
    buttonBorder: pickThemeColor(customTheme.colors.settingsCustomThemesButtonBorder, isDarkMode ? '#525252' : '#d4d4d4'),
    buttonText: pickThemeColor(customTheme.colors.settingsCustomThemesButtonText, isDarkMode ? '#e5e5e5' : '#404040'),
  }

  return createPortal(
    <div
      role='dialog'
      aria-modal='true'
      aria-label='Subagent transcript'
      className='fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-6 backdrop-blur-[2px]'
      style={customThemeEnabled ? { backgroundColor: themeColors.backdrop } : undefined}
      onClick={onClose}
    >
      <div
        className='bg-neutral-50 dark:bg-zinc-900/70 backdrop-blur-xl border border-stone-200 dark:border-neutral-700 rounded-2xl flex flex-col max-h-[85vh] w-[90%] max-w-2xl'
        style={
          customThemeEnabled
            ? {
                backgroundColor: isDarkMode
                  ? `color-mix(in srgb, ${themeColors.surface} 70%, transparent)`
                  : themeColors.surface,
                borderColor: themeColors.border,
                backdropFilter: isDarkMode ? 'blur(24px)' : undefined,
              }
            : undefined
        }
        onClick={e => e.stopPropagation()}
      >
        <div
          className='flex justify-between items-center px-5 py-4 border-b border-stone-200 dark:border-neutral-800 shrink-0'
          style={customThemeEnabled ? { borderColor: themeColors.border } : undefined}
        >
          <h3
            className='flex items-center gap-2 text-base font-semibold text-stone-800 dark:text-stone-100'
            style={customThemeEnabled ? { color: themeColors.primaryText } : undefined}
          >
            Subagent Transcript{runs.length > 1 ? ` (${runs.length})` : ''}
            {anyRunning && (
              <span
                className='inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400'
                style={customThemeEnabled ? { backgroundColor: themeColors.liveBadgeBg, color: themeColors.liveBadgeText } : undefined}
              >
                <span className='h-1.5 w-1.5 rounded-full bg-current animate-pulse' aria-hidden='true' />
                Live
              </span>
            )}
          </h3>
          <Button
            variant='outline2'
            size='small'
            onClick={onClose}
            aria-label='Close subagent transcript'
            title='Close'
            style={customThemeEnabled ? { backgroundColor: themeColors.buttonBg, borderColor: themeColors.buttonBorder, color: themeColors.buttonText } : undefined}
          >
            <i className='bx bx-x text-lg' aria-hidden='true'></i>
          </Button>
        </div>

        <div className='overflow-y-auto flex-1 thin-scrollbar'
          style={customThemeEnabled ? { color: themeColors.primaryText } : undefined}>
          {isLoading && (
            <div
              className='px-5 py-4 text-xs text-stone-500 dark:text-stone-400'
              style={customThemeEnabled ? { color: themeColors.mutedText } : undefined}
            >
              Loading transcript…
            </div>
          )}
          {!isLoading && isError && (
            <div
              className='px-5 py-4 text-xs text-red-600 dark:text-red-400'
              style={customThemeEnabled ? { backgroundColor: themeColors.errorBg, color: themeColors.errorText } : undefined}
            >
              Failed to load transcript{error instanceof Error ? `: ${error.message}` : ''}
            </div>
          )}
          {!isLoading && !isError && runs.length === 0 && (
            <div
              className='px-5 py-4 text-xs text-stone-500 dark:text-stone-400'
              style={customThemeEnabled ? { color: themeColors.mutedText } : undefined}
            >
              No subagent transcript found for this tool call.
            </div>
          )}
          {!isLoading && !isError && runs.length > 0 && <SubagentTranscript runs={runs} />}

          {/* Live tail: the in-progress turn's streamed output, folded into the
              persisted transcript as each turn lands. */}
          {showLiveTail && (
            <div
              className='px-5 py-4 border-t border-stone-100 dark:border-neutral-800'
              style={customThemeEnabled ? { backgroundColor: themeColors.panel, borderColor: themeColors.border } : undefined}
            >
              <div
                className='flex items-center gap-2 mb-2 text-[10px] font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400'
                style={customThemeEnabled ? { backgroundColor: themeColors.liveBadgeBg, color: themeColors.liveBadgeText } : undefined}
              >
                <span className='h-1.5 w-1.5 rounded-full bg-current animate-pulse' aria-hidden='true' />
                Streaming
              </div>
              {live.reasoning && (
                <div className='mb-2 prose prose-sm dark:prose-invert max-w-none text-stone-500 dark:text-stone-400 prose-p:my-1'>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{live.reasoning}</ReactMarkdown>
                </div>
              )}
              {live.text && (
                <div className='prose prose-sm dark:prose-invert max-w-none text-stone-700 dark:text-stone-300 prose-p:my-1 prose-pre:my-2 prose-pre:bg-stone-100 dark:prose-pre:bg-neutral-800 prose-code:text-orange-600 dark:prose-code:text-orange-400 prose-pre:text-xs prose-pre:overflow-x-auto'>
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}>
                    {live.text}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

export default SubagentTranscriptModal
