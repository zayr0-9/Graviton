import React, { useMemo } from 'react'
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

export const PlanMdToolView: React.FC<PlanMdToolViewProps> = ({ args, result, className = '' }) => {
  const parsedResult = useMemo(() => parseRecord(result), [result])

  const name = toString(parsedResult.name) || toString(args?.name) || 'Plan'
  const path = toString(parsedResult.path)
  const content = toString(parsedResult.content) || toString(parsedResult.modelContent) || toString(parsedResult.message)
  const exists = parsedResult.exists !== false

  if (!content) return null

  return (
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

      {path && (
        <div className='truncate px-3 pb-2 font-mono text-[10px] text-neutral-400 dark:text-neutral-500' title={path}>
          {path}
        </div>
      )}

      <div className='max-h-[52vh] overflow-auto border-t border-neutral-200/60 px-3 py-2 dark:border-neutral-800/80 thin-scrollbar'>
        <div
          className={`${SHARED_TEXT_MARKDOWN_CLASS} !pb-0 text-[13px] sm:text-[13px] xl:text-[13px] 2xl:text-[13px] 3xl:text-[13px]`}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}>
            {content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  )
}

export default PlanMdToolView
