import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Maximize2, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { SHARED_TEXT_MARKDOWN_CLASS } from '../ChatMessage/chatMessageShared'

interface PlanMdToolViewProps {
  args?: Record<string, unknown> | null
  result: unknown
  className?: string
}

type UnknownRecord = Record<string, unknown>

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseRecord = (raw: unknown): UnknownRecord => {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return isRecord(parsed) ? parsed : { content: raw }
    } catch {
      return { content: raw }
    }
  }
  return isRecord(raw) ? raw : {}
}

const toString = (value: unknown): string => (typeof value === 'string' ? value : '')

const PlanMarkdown: React.FC<{ content: string; className?: string }> = ({ content, className = '' }) => (
  <div
    className={`${SHARED_TEXT_MARKDOWN_CLASS} !pb-0 !text-[0.8125em] sm:!text-[0.8125em] xl:!text-[0.8125em] 2xl:!text-[0.8125em] 3xl:!text-[0.8125em] ${className}`}
  >
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}>
      {content}
    </ReactMarkdown>
  </div>
)

export const PlanMdToolView: React.FC<PlanMdToolViewProps> = ({ args, result, className = '' }) => {
  const parsedResult = useMemo(() => parseRecord(result), [result])
  const [isFullscreen, setIsFullscreen] = useState(false)
  const fullscreenButtonRef = useRef<HTMLButtonElement | null>(null)

  const name = toString(parsedResult.name) || toString(args?.name) || 'Plan'
  const path = toString(parsedResult.path)
  const content = toString(parsedResult.content) || toString(parsedResult.modelContent) || toString(parsedResult.message)
  const exists = parsedResult.exists !== false

  const closeFullscreen = useCallback(() => {
    setIsFullscreen(false)
    window.requestAnimationFrame(() => fullscreenButtonRef.current?.focus())
  }, [])

  useEffect(() => {
    if (!isFullscreen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeFullscreen()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [closeFullscreen, isFullscreen])

  if (!content) return null

  const fullscreenModal = isFullscreen
    ? createPortal(
        <div
          role='dialog'
          aria-modal='true'
          aria-label={`${name} plan`}
          className='fixed inset-0 z-[1200] flex items-center justify-center bg-black/30 p-3 backdrop-blur-sm sm:p-6'
          onMouseDown={closeFullscreen}
        >
          <div
            className='flex h-[calc(100vh-1.5rem)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white/95 backdrop-blur-xl dark:bg-yBlack-900/95 sm:h-[calc(100vh-3rem)]'
            onMouseDown={event => event.stopPropagation()}
          >
            <div className='flex min-w-0 items-center justify-between gap-3 px-4 py-3 sm:px-6'>
              <div className='min-w-0'>
                <div className='flex min-w-0 items-center gap-2'>
                  <span className='shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-blue-700 dark:bg-blue-500/15 dark:text-blue-200'>
                    plan
                  </span>
                  <h2 className='min-w-0 truncate text-sm font-semibold text-neutral-800 dark:text-neutral-100' title={name}>
                    {name}
                  </h2>
                </div>
                {path && <p className='mt-1 truncate font-mono text-[10px] text-neutral-400 dark:text-neutral-500' title={path}>{path}</p>}
              </div>
              <button
                type='button'
                onClick={closeFullscreen}
                className='flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-neutral-500 transition-[background-color,color,transform] duration-150 hover:bg-neutral-100 hover:text-neutral-900 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-white dark:focus-visible:ring-orange-400/70'
                title='Close fullscreen plan'
                aria-label='Close fullscreen plan'
              >
                <X size={18} strokeWidth={2.25} aria-hidden='true' />
              </button>
            </div>
            <div className='min-h-0 flex-1 overflow-auto border-t border-neutral-200/60 px-4 py-4 dark:border-neutral-800/80 thin-scrollbar sm:px-6'>
              <PlanMarkdown content={content} className='!text-base sm:!text-base xl:!text-base 2xl:!text-base 3xl:!text-base' />
            </div>
          </div>
        </div>,
        document.body
      )
    : null

  return (
    <>
      <div
        className={`min-w-0 flex-1 overflow-hidden rounded-xl border border-neutral-200/70 bg-white/55 dark:border-neutral-800/80 dark:bg-neutral-950/25 ${className}`}
      >
        <div className='flex min-w-0 items-center justify-between gap-3 px-3 py-2'>
          <div className='flex min-w-0 items-center gap-2'>
            <span className='shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-blue-700 dark:bg-blue-500/15 dark:text-blue-200'>
              plan
            </span>
            <span className='min-w-0 truncate text-xs font-semibold text-neutral-800 dark:text-neutral-100' title={name}>
              {name}
            </span>
          </div>
          <div className='flex shrink-0 items-center gap-2'>
            <button
              ref={fullscreenButtonRef}
              type='button'
              onClick={() => setIsFullscreen(true)}
              className='inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-1 text-[10px] font-medium text-neutral-600 transition-[background-color,color,transform] duration-150 hover:bg-neutral-200 hover:text-neutral-900 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 dark:bg-white/5 dark:text-neutral-300 dark:hover:bg-white/10 dark:hover:text-white dark:focus-visible:ring-orange-400/70'
              title='Open fullscreen plan'
              aria-label='Open fullscreen plan'
            >
              <Maximize2 size={13} strokeWidth={2.25} aria-hidden='true' />
              Fullscreen
            </button>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                exists
                  ? 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300'
                  : 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300'
              }`}
            >
              {exists ? 'displayed' : 'missing'}
            </span>
          </div>
        </div>

        {path && (
          <div className='truncate px-3 pb-2 font-mono text-[10px] text-neutral-400 dark:text-neutral-500' title={path}>
            {path}
          </div>
        )}

        <div className='max-h-[52vh] overflow-auto border-t border-neutral-200/60 px-3 py-2 dark:border-neutral-800/80 thin-scrollbar'>
          <PlanMarkdown content={content} />
        </div>
      </div>
      {fullscreenModal}
    </>
  )
}

export default PlanMdToolView
