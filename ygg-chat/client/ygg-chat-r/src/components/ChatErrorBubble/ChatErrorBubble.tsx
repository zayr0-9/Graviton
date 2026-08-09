import { AlertTriangle, ChevronDown, ChevronRight, X } from 'lucide-react'
import React, { useState } from 'react'
import type { ChatErrorActionKind, ChatErrorEnvelope } from '../../../../../shared/chatErrors'

/**
 * The ONE way a chat failure is drawn.
 *
 * Two callers render it and they must not diverge:
 *  - `ChatMessage` draws a PERSISTED `ErrorBlock` (tier 1 — the server wrote it onto a
 *    real assistant message, so it survives a reload).
 *  - `Chat` draws a `ChatErrorRecord` from `chat.errorNotices` (tier 2 — failures with no
 *    message to live on: pre-persist server failures and renderer-local transport failures).
 *
 * It is deliberately presentational: no Redux, no dispatch, no routing. The caller owns
 * what `retry` or `sign_in` actually mean, because those differ per tier.
 *
 * `envelope.userMessage` is rendered verbatim and is the only string the user reads.
 * `envelope.detail` holds the raw technical text and stays behind the disclosure.
 */

const CONTAINER_CLASS =
  'border border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300 rounded-lg px-3 py-2.5'

/** Absolute reset time beats a duration — "resets at 4:30 PM" is actionable, "in 8412s" is not. */
const formatWhenRetryWorks = (envelope: ChatErrorEnvelope): string | null => {
  const resetMs =
    typeof envelope.resetAt === 'number'
      ? envelope.resetAt
      : typeof envelope.retryAfterMs === 'number'
        ? Date.now() + envelope.retryAfterMs
        : null
  if (resetMs == null || !Number.isFinite(resetMs)) return null
  const reset = new Date(resetMs)
  if (Number.isNaN(reset.getTime())) return null
  const deltaMs = resetMs - Date.now()
  if (deltaMs <= 0) return null
  // Same day -> a clock time reads best; further out, include the date.
  const sameDay = reset.toDateString() === new Date().toDateString()
  const when = sameDay
    ? reset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : reset.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return `You can try again after ${when}.`
}

export interface ChatErrorBubbleProps {
  envelope: ChatErrorEnvelope
  /** Invoked with `envelope.action.kind`. Omit to render the bubble with no button. */
  onAction?: (kind: ChatErrorActionKind) => void
  /** Omit to render no dismiss affordance (tier 1 is part of the transcript and is not dismissible). */
  onDismiss?: () => void
  /** Disables the action button while the caller is acting on it. */
  actionPending?: boolean
  className?: string
  style?: React.CSSProperties
}

export const ChatErrorBubble: React.FC<ChatErrorBubbleProps> = ({
  envelope,
  onAction,
  onDismiss,
  actionPending = false,
  className = '',
  style,
}) => {
  const [detailOpen, setDetailOpen] = useState(false)
  const action = envelope.action
  const retryHint = formatWhenRetryWorks(envelope)
  const hasDetail = typeof envelope.detail === 'string' && envelope.detail.trim().length > 0

  return (
    <div
      className={`${CONTAINER_CLASS} ${className}`}
      style={style}
      role='alert'
      data-chat-error-code={envelope.code}
    >
      <div className='flex items-start gap-2'>
        <AlertTriangle className='mt-0.5 h-4 w-4 shrink-0 opacity-80' aria-hidden='true' />

        <div className='min-w-0 flex-1'>
          <p className='text-sm leading-relaxed whitespace-pre-wrap break-words'>{envelope.userMessage}</p>

          {retryHint && <p className='mt-1 text-xs opacity-75'>{retryHint}</p>}

          {(action || hasDetail) && (
            <div className='mt-2 flex flex-wrap items-center gap-3'>
              {action && onAction && (
                <button
                  type='button'
                  disabled={actionPending}
                  onClick={() => onAction(action.kind)}
                  className='rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50'
                >
                  {action.label}
                </button>
              )}

              {hasDetail && (
                <button
                  type='button'
                  onClick={() => setDetailOpen(open => !open)}
                  className='flex items-center gap-1 text-xs opacity-70 transition-opacity hover:opacity-100'
                  aria-expanded={detailOpen}
                >
                  {detailOpen ? (
                    <ChevronDown className='h-3 w-3' aria-hidden='true' />
                  ) : (
                    <ChevronRight className='h-3 w-3' aria-hidden='true' />
                  )}
                  Details
                </button>
              )}
            </div>
          )}

          {detailOpen && hasDetail && (
            <pre className='mt-2 max-h-40 overflow-auto rounded bg-black/5 p-2 text-[11px] leading-snug whitespace-pre-wrap break-words opacity-80 dark:bg-white/5'>
              {envelope.detail}
            </pre>
          )}
        </div>

        {onDismiss && (
          <button
            type='button'
            onClick={onDismiss}
            aria-label='Dismiss'
            className='-mr-1 -mt-1 shrink-0 rounded p-1 opacity-60 transition-opacity hover:opacity-100'
          >
            <X className='h-3.5 w-3.5' aria-hidden='true' />
          </button>
        )}
      </div>
    </div>
  )
}

export default ChatErrorBubble
