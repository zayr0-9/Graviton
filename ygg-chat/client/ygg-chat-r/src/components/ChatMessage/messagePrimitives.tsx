import React from 'react'
import { ChevronRight } from 'lucide-react'
import {
  DISCLOSURE_BODY_CLASS,
  DISCLOSURE_CHEVRON_CLASS,
  DISCLOSURE_LABEL_CLASS,
  DISCLOSURE_LABEL_LAYOUT_CLASS,
  DISCLOSURE_ROW_CLASS,
  DISCLOSURE_SUMMARY_CLASS,
  MONO_DETAIL_CLASS,
  MONO_KEY_CLASS,
  stringifyToolValue,
  SURFACE_CARD_PADDING_CLASS,
  SURFACE_INNER_CLASS,
  TEXT_DETAIL_CLASS,
  TEXT_MICRO_CLASS,
} from './chatMessageShared'

/**
 * Shared building blocks for every content block kind in a chat message.
 *
 * Design (docs/agent_context/agent_design.md): flat glass, tone over outline, one
 * disclosure row shape for reasoning, tool cards, and grouped agent steps, one card
 * surface for structured detail. Motion names its properties and follows the shared
 * CSS tokens in index.css.
 */

export type DisclosureTone = 'neutral' | 'running' | 'success' | 'error'

const TONE_LABEL_CLASS: Record<DisclosureTone, string> = {
  neutral: 'text-neutral-700 dark:text-neutral-300',
  running: 'text-neutral-700 dark:text-neutral-300 tool-name-shimmer',
  success: 'text-neutral-700 dark:text-neutral-300',
  error: 'text-red-600 dark:text-red-400',
}

interface DisclosureRowProps {
  /** Primary label. A string gets the tone class; a node is rendered as is. */
  label: React.ReactNode
  /** Optional muted text shown while collapsed. */
  summary?: React.ReactNode
  /** Always-visible muted text placed after the label, before the summary. */
  meta?: React.ReactNode
  expanded: boolean
  onToggle: () => void
  tone?: DisclosureTone
  /** Optional leading glyph, 14px. */
  leading?: React.ReactNode
  /** Actions on the right. Rendered outside the toggle button so clicks do not toggle. */
  trailing?: React.ReactNode
  controlsId?: string
  className?: string
  /** Hide the summary once expanded (default true). */
  hideSummaryWhenExpanded?: boolean
}

export const DisclosureRow: React.FC<DisclosureRowProps> = ({
  label,
  summary,
  meta,
  expanded,
  onToggle,
  tone = 'neutral',
  leading,
  trailing,
  controlsId,
  className,
  hideSummaryWhenExpanded = true,
}) => {
  const showSummary = summary != null && summary !== '' && (!expanded || !hideSummaryWhenExpanded)
  // A node label brings its own typography, so it gets the layout slot WITHOUT a text size.
  // Applying one here as well would multiply two em-relative sizes and render it small.
  const labelNode =
    typeof label === 'string' ? (
      <span className={`${DISCLOSURE_LABEL_CLASS} ${TONE_LABEL_CLASS[tone]}`}>{label}</span>
    ) : (
      <span className={`${DISCLOSURE_LABEL_LAYOUT_CLASS} inline-flex items-center`}>{label}</span>
    )

  return (
    <div className={`flex min-w-0 w-full items-center gap-1 ${className ?? ''}`}>
      <button
        type='button'
        onClick={onToggle}
        className={`${DISCLOSURE_ROW_CLASS} min-w-0 flex-1`}
        aria-expanded={expanded}
        aria-controls={controlsId}
      >
        {leading && <span className='flex shrink-0 items-center text-neutral-400 dark:text-neutral-500'>{leading}</span>}
        {labelNode}
        {meta != null && meta !== '' && (
          <span className={`shrink-0 truncate ${TEXT_DETAIL_CLASS} leading-none text-neutral-500 dark:text-neutral-500`}>{meta}</span>
        )}
        {showSummary ? <span className={DISCLOSURE_SUMMARY_CLASS}>{summary}</span> : <span className='min-w-0 flex-1' />}
        <ChevronRight
          size={14}
          strokeWidth={2.25}
          aria-hidden='true'
          className={`${DISCLOSURE_CHEVRON_CLASS} ${expanded ? 'rotate-90' : ''}`}
        />
      </button>
      {trailing && <div className='flex shrink-0 items-center gap-1 pr-1'>{trailing}</div>}
    </div>
  )
}

interface DisclosurePanelProps {
  expanded: boolean
  children: React.ReactNode
  id?: string
  /** Streaming rows disable the height transition so the virtual list measures instantly. */
  disableTransition?: boolean
  onTransitionEnd?: () => void
  /** Skip the inner inset, for children that draw their own surface edge to edge. */
  flush?: boolean
}

export const DisclosurePanel: React.FC<DisclosurePanelProps> = ({
  expanded,
  children,
  id,
  disableTransition,
  onTransitionEnd,
  flush,
}) => (
  <div
    id={id}
    className={`tool-expand-container ${expanded ? 'open' : ''}`}
    style={disableTransition ? { transition: 'none' } : undefined}
    onTransitionEnd={onTransitionEnd}
  >
    {/*
      `.tool-expand-content` is the grid child that collapses to a 0fr track. It must carry no
      vertical padding: with border-box sizing the used height can never fall below padding, so
      padding here keeps a collapsed panel that many pixels tall on every closed disclosure.
      The body padding therefore goes one level deeper.
    */}
    <div className='tool-expand-content'>
      <div className={flush ? '' : DISCLOSURE_BODY_CLASS}>{children}</div>
    </div>
  </div>
)

export type BadgeTone = 'neutral' | 'success' | 'error' | 'info' | 'warning'

const BADGE_TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'bg-black/[0.06] text-neutral-600 dark:bg-white/[0.08] dark:text-neutral-300',
  success: 'bg-emerald-500/12 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300',
  error: 'bg-red-500/12 text-red-700 dark:bg-red-400/15 dark:text-red-300',
  info: 'bg-blue-500/12 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300',
  warning: 'bg-amber-500/14 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300',
}

export const Badge: React.FC<{ tone?: BadgeTone; children: React.ReactNode; className?: string }> = ({
  tone = 'neutral',
  children,
  className,
}) => (
  <span
    className={`inline-flex min-w-0 max-w-full items-center rounded-full px-2 py-[2px] ${TEXT_MICRO_CLASS} font-medium leading-none tracking-wide [overflow-wrap:anywhere] ${BADGE_TONE_CLASS[tone]} ${className ?? ''}`}
  >
    {children}
  </span>
)

interface SurfaceCardProps {
  title?: React.ReactNode
  index?: number
  badge?: React.ReactNode
  /** Extra header controls, right aligned. */
  actions?: React.ReactNode
  children?: React.ReactNode
  className?: string
  /** Remove the content padding, for children that draw their own layout. */
  flush?: boolean
}

/** Flat inner card for structured tool detail. Header is a tone change, not a divider. */
export const SurfaceCard: React.FC<SurfaceCardProps> = ({ title, index, badge, actions, children, className, flush }) => {
  const hasHeader = title != null || badge != null || actions != null || typeof index === 'number'
  return (
    <div className={`${SURFACE_INNER_CLASS} ${className ?? ''}`}>
      {hasHeader && (
        <div className={`flex min-w-0 flex-wrap items-center gap-2 ${SURFACE_CARD_PADDING_CLASS}`}>
          {typeof index === 'number' && (
            <span className={`inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-black/[0.06] px-1 ${TEXT_MICRO_CLASS} font-semibold text-neutral-600 dark:bg-white/[0.08] dark:text-neutral-300`}>
              {index + 1}
            </span>
          )}
          {title != null && (
            <span className={`min-w-0 flex-1 basis-0 truncate ${TEXT_DETAIL_CLASS} font-medium text-neutral-700 dark:text-neutral-200`}>
              {title}
            </span>
          )}
          {badge}
          {actions && <div className='ml-auto flex shrink-0 items-center gap-1'>{actions}</div>}
        </div>
      )}
      {children != null && (
        <div className={flush ? '' : `${SURFACE_CARD_PADDING_CLASS} ${hasHeader ? 'pt-0' : ''} space-y-1`}>{children}</div>
      )}
    </div>
  )
}

/** `key: value` rows in monospace. */
export const FieldRows: React.FC<{
  record: Record<string, unknown> | null
  fallback?: { key: string; value: unknown }
}> = ({ record, fallback }) => {
  const entries: Array<[string, unknown]> = record
    ? Object.entries(record)
    : fallback
      ? [[fallback.key, fallback.value]]
      : []

  if (entries.length === 0) {
    return <div className={`${MONO_DETAIL_CLASS} italic opacity-70`}>No fields</div>
  }

  return (
    <div className={`${MONO_DETAIL_CLASS} space-y-0.5 whitespace-pre-wrap`}>
      {entries.map(([fieldKey, fieldValue]) => (
        <div key={fieldKey} className='min-w-0 max-w-full'>
          <span className={MONO_KEY_CLASS}>{fieldKey}:</span> <span>{stringifyToolValue(fieldValue)}</span>
        </div>
      ))}
    </div>
  )
}

/** Section label inside an expanded tool body: `input`, `output`, plus badges. */
export const SectionLabel: React.FC<{ label: string; children?: React.ReactNode }> = ({ label, children }) => (
  <div className='flex min-w-0 max-w-full flex-wrap items-center gap-1.5 pb-1'>
    <span className={`font-mono ${TEXT_MICRO_CLASS} uppercase tracking-[0.12em] text-neutral-400 dark:text-neutral-600`}>{label}</span>
    {children}
  </div>
)
