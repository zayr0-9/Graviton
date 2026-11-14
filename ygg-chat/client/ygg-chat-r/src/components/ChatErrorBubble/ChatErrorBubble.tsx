import { AlertTriangle, ChevronDown, ChevronRight, X } from 'lucide-react'
import React, { useId, useState } from 'react'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'
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
  'rounded-2xl bg-white/60 px-4 py-3 text-stone-800 backdrop-blur-xl dark:bg-black/20 dark:text-stone-100'

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
  const detailId = useId()
  const { enabled, theme } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()
  const color = (pair: typeof theme.colors.toolJobsPrimaryText) => enabled ? getThemeModeColor(pair, isDarkMode) : undefined
  const surfaceStyle = { backgroundColor: color(theme.colors.settingsCustomThemesCardBg), color: color(theme.colors.toolJobsPrimaryText) }
  const mutedStyle = { color: color(theme.colors.toolJobsMutedText) }
  const controlStyle = { backgroundColor: color(theme.colors.settingsCustomThemesButtonBg), color: color(theme.colors.settingsCustomThemesButtonText) }
  const detailStyle = { backgroundColor: color(theme.colors.settingsCustomThemesInnerCardBg), ...mutedStyle }
  const action = envelope.action
  const retryHint = formatWhenRetryWorks(envelope)
  const hasDetail = typeof envelope.detail === 'string' && envelope.detail.trim().length > 0

  return (
    <div
      className={`${CONTAINER_CLASS} ${className}`}
      style={{ ...surfaceStyle, ...style }}
      role='alert'
      data-chat-error-code={envelope.code}
    >
      <div className='flex items-start gap-2'>
        <AlertTriangle size={18} strokeWidth={2.25} className='mt-0.5 shrink-0 text-amber-700 dark:text-amber-300' style={mutedStyle} aria-hidden='true' />

        <div className='min-w-0 flex-1'>
          <p className='text-sm leading-relaxed whitespace-pre-wrap break-words'>{envelope.userMessage}</p>

          {retryHint && <p className='mt-1 text-xs opacity-75' style={mutedStyle}>{retryHint}</p>}

          {((action && onAction) || hasDetail) && (
            <div className='mt-2 flex flex-wrap items-center gap-3'>
              {action && onAction && (
                <button
                  type='button'
                  disabled={actionPending}
                  onClick={() => onAction(action.kind)}
                  className='rounded-full bg-black/5 px-3 py-1.5 text-xs font-medium transition-[opacity,transform] hover:opacity-80 active:scale-95 motion-reduce:transform-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white/10'
                  style={controlStyle}
                >
                  {action.label}
                </button>
              )}

              {hasDetail && (
                <button
                  type='button'
                  onClick={() => setDetailOpen(open => !open)}
                  className='flex items-center gap-1 rounded-full px-2 py-1.5 text-xs opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current'
                  style={mutedStyle}
                  aria-expanded={detailOpen}
                  aria-controls={detailId}
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
            <pre id={detailId} style={detailStyle} className='mt-2 max-h-40 overflow-auto rounded-xl bg-black/5 p-3 text-xs leading-relaxed whitespace-pre-wrap break-words dark:bg-white/5'>
              {envelope.detail}
            </pre>
          )}
        </div>

        {onDismiss && (
          <button
            type='button'
            onClick={onDismiss}
            aria-label='Dismiss'
            title='Dismiss'
            style={controlStyle}
            className='-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/5 opacity-70 transition-[opacity,transform] hover:opacity-100 active:scale-95 motion-reduce:transform-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current dark:bg-white/10'
          >
            <X size={18} strokeWidth={2.25} aria-hidden='true' />
          </button>
        )}
      </div>
    </div>
  )
}

export default ChatErrorBubble
