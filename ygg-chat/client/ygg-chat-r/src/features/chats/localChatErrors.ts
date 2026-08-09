/**
 * Renderer-local chat error classifier.
 *
 * Three of the four chat transports (the raw-`fetch` POST that opens a run, the
 * reattach/resubscribe GETs, and the fire-and-forget `/resume` + `/abort` POSTs)
 * never produce an SSE frame, so the server never gets a chance to classify them.
 * Everything they can fail with is a renderer-local `throw` or a bare HTTP status.
 * This file is the classifier for exactly those, and nothing else:
 *
 *   - a frame that DID arrive over SSE already carries `envelope` — use
 *     `normalizeChatErrorEnvelope` on it, not this.
 *   - a provider failure is classified server-side — never re-guessed here.
 *
 * IRON RULE: `envelope.userMessage` is the only string ever rendered. A raw
 * `Error.message` must NEVER reach it. Renderer-local throws include genuine
 * programming errors ("Internal error: no active parent id") plus internal loop
 * vocabulary and lineage ids; all of that goes in `detail`, behind a disclosure.
 */

import {
  buildChatErrorEnvelope,
  CHAT_ERROR_DEFAULTS,
  type ChatErrorCode,
  type ChatErrorEnvelope,
} from '../../../../../shared/chatErrors'
import type { ConversationId, MessageId } from '../../../../../shared/types'
import type { ChatErrorRecord, LineageId } from './chatTypes'

/** Where in the transport lifecycle the failure happened. The phase is often the
 * only discriminator available — a non-ok `/resume` and a non-ok `/abort` are the
 * same `Response` shape and mean completely different things to the user. */
export type LocalChatErrorPhase = 'open' | 'stream' | 'reattach' | 'resume' | 'abort' | 'preflight'

export interface LocalChatErrorContext {
  phase?: LocalChatErrorPhase
  /** HTTP status when the failure was a non-ok response rather than a throw. */
  status?: number
  streamId?: string | null
  /**
   * A code the caller already knows for certain. Used by the idle watchdog, which
   * has no error object at all — it just knows nothing has arrived for N seconds.
   * Honoured ahead of every heuristic (but not ahead of `offline`, see below).
   */
  code?: ChatErrorCode
}

/** Cap on how much raw text we keep. `detail` is a disclosure, not a log sink. */
const MAX_DETAIL_LENGTH = 600

/**
 * Errors may be tagged at the throw site with a definite code. Read via a
 * well-known symbol AND a plain own property so a tag applied by any layer
 * (including the server-side `attachChatErrorCode`) survives a structured clone.
 */
const CHAT_ERROR_CODE_KEY: unique symbol = Symbol.for('ygg.chatErrorCode')

/** True only when the platform positively reports "no network". Absent/unknown
 * (`navigator` missing, e.g. under the node test runner) is NOT offline. */
export function isDeviceOffline(): boolean {
  try {
    return typeof navigator !== 'undefined' && navigator != null && (navigator as Navigator).onLine === false
  } catch {
    return false
  }
}

/** Validated against the shared table, so a stale tag from an older build can
 * never put an unknown `code` on an envelope the UI then fails to render. */
function isChatErrorCode(value: unknown): value is ChatErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CHAT_ERROR_DEFAULTS, value)
}

/** Read a code attached at the throw site, if any. */
export function getLocalAttachedChatErrorCode(error: unknown): ChatErrorCode | undefined {
  if (!error || typeof error !== 'object') return undefined
  const bag = error as Record<PropertyKey, unknown>
  const tagged = bag[CHAT_ERROR_CODE_KEY] ?? bag.chatErrorCode
  return isChatErrorCode(tagged) ? tagged : undefined
}

/** Tag a throw with a definite code so no downstream heuristic has to guess. */
export function attachLocalChatErrorCode<E>(error: E, code: ChatErrorCode): E {
  if (error && typeof error === 'object') {
    try {
      Object.defineProperty(error, CHAT_ERROR_CODE_KEY, { value: code, enumerable: false, configurable: true })
      ;(error as Record<string, unknown>).chatErrorCode = code
    } catch {
      /* frozen error object — the heuristics still apply */
    }
  }
  return error
}

/** The raw technical text, for `detail` only. NEVER for `userMessage`. */
function rawTextOf(error: unknown): string | undefined {
  if (error == null) return undefined
  let text: string
  if (error instanceof Error) {
    text = error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message
  } else if (typeof error === 'string') {
    text = error
  } else {
    try {
      text = JSON.stringify(error)
    } catch {
      text = String(error)
    }
  }
  text = (text ?? '').trim()
  if (!text) return undefined
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH)}…` : text
}

/** Message text used ONLY for matching. Never rendered. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message ?? ''
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  return ''
}

function nameOf(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { name?: unknown }).name === 'string') {
    return (error as { name: string }).name
  }
  return ''
}

/** A status carried on the error itself (`LocalApiError`, or a fetch wrapper). */
function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const status = (error as { status?: unknown }).status
  if (typeof status === 'number' && Number.isFinite(status)) return status
  // `mainChatClient` throws the status inside the message: "…failed (HTTP 503)".
  const match = messageOf(error).match(/\bHTTP\s+(\d{3})\b/i)
  return match ? Number(match[1]) : undefined
}

/** Map a bare HTTP status onto a code. Shared by the ctx.status and the
 * status-embedded-in-the-message paths so they can never disagree. */
function codeForStatus(status: number): ChatErrorCode | undefined {
  if (status === 401 || status === 403) return 'session_expired'
  if (status === 410) return 'run_expired'
  if (status === 429) return 'rate_limited'
  if (status >= 400 && status < 500) return 'server_rejected_request'
  if (status >= 500) return 'server_rejected_request'
  return undefined
}

/**
 * Classify a failure that happened in the renderer, on a transport that cannot
 * carry an SSE `error` frame. ALWAYS returns a complete envelope.
 *
 * Precedence, highest first:
 *  1. `navigator.onLine === false` — a dead network explains every other symptom,
 *     so it beats every heuristic below. Deliberate: telling someone the server is
 *     unreachable when their wifi is off sends them debugging the wrong thing.
 *  2. a code the caller/throw-site stated outright (watchdog, tagged throws).
 *  3. definite HTTP statuses (410 gone, 401 auth) regardless of phase.
 *  4. the phase, for the two transports whose failure meaning is phase-defined.
 *  5. message/type heuristics against the exact throws in `mainChatClient` /
 *     `chatActions` / `api.ts`.
 *  6. any remaining status.
 *  7. `internal_error`.
 */
export function classifyLocalChatError(error: unknown, ctx: LocalChatErrorContext = {}): ChatErrorEnvelope {
  const status = ctx.status ?? statusOf(error)
  const detail = rawTextOf(error)
  const overrides = { detail, ...(typeof status === 'number' ? { status } : {}) }
  const envelope = (code: ChatErrorCode): ChatErrorEnvelope => buildChatErrorEnvelope(code, overrides)

  // 1 — offline beats everything.
  if (isDeviceOffline()) return envelope('offline')

  // 2 — the caller already knows.
  const stated = ctx.code ?? getLocalAttachedChatErrorCode(error)
  if (stated) return envelope(stated)

  // 3 — statuses that mean one thing on every transport.
  if (status === 410) return envelope('run_expired')
  if (status === 401 || status === 403) return envelope('session_expired')

  const message = messageOf(error)
  const name = nameOf(error)

  // 4 — phases whose failure meaning is defined by the phase, not by the error.
  //     `/resume` carries a user's tool decision; if the POST fails the run stays
  //     parked forever waiting for an answer that will never arrive.
  if (ctx.phase === 'resume') return envelope('decision_not_delivered')
  //     `/abort` failing means we could not confirm the stop — the run may live on.
  if (ctx.phase === 'abort') return envelope('stop_not_confirmed')

  // 5 — heuristics against the exact renderer-local throws.

  // `api.ts` handleLocalApiError: `TypeError` whose message mentions fetch.
  // Also the bare `fetch()` rejection in `mainChatClient` / `chatActions`, which
  // bypasses handleLocalApiError entirely and so never gets its friendlier text.
  if (error instanceof TypeError && /fetch|network/i.test(message)) return envelope('local_server_unreachable')
  if (/failed to fetch|networkerror|load failed|err_connection|econnrefused/i.test(message)) {
    return envelope('local_server_unreachable')
  }
  // handleLocalApiError's own rethrow.
  if (/local server not available/i.test(message)) return envelope('local_server_unreachable')

  // `chatActions.ts`: "The server-owned chat loop requires Electron."
  if (/requires electron|needs the desktop app|not supported in this runtime/i.test(message)) {
    return envelope('unsupported_runtime')
  }

  // `mainChatClient.ts`: the resubscribe path, "no longer available (cancelled or expired)".
  if (/no longer available|run (is )?gone|run expired/i.test(message)) return envelope('run_expired')

  // `mainChatClient.ts:303`: "Headless stream ended without a terminal event".
  if (/without a terminal event|stream ended unexpectedly/i.test(message)) return envelope('stream_interrupted')

  // A user-initiated cancel that reached here instead of being handled upstream.
  if (name === 'AbortError' || /^message cancelled$/i.test(message.trim())) return envelope('cancelled')

  // 6 — anything else with a status. `open`/`preflight` non-2xx means the request
  //     was rejected before a single token was produced, so nothing was sent.
  if (typeof status === 'number') {
    const byStatus = codeForStatus(status)
    if (byStatus) return envelope(byStatus)
  }

  // A drop mid-stream with no other signal is an interruption, not an internal bug.
  if (ctx.phase === 'stream' || ctx.phase === 'reattach') return envelope('stream_interrupted')

  // 7 — genuine programming errors land here ("Internal error: no active parent id").
  //     Their text is in `detail`; the user sees the generic prose. That is the point.
  return envelope('internal_error')
}

// ─────────────────────────────────────────────────────────────────────────────
// Record helper — one call site for the thunks.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatErrorRecordContext {
  conversationId: ConversationId
  /** Anchors the bubble in the tree. Null when the failure predates any lineage. */
  parentMessageId?: MessageId | null
  streamId?: string | null
  lineageId?: LineageId | null
  /** Overridable for deterministic tests. */
  id?: string
  createdAt?: number
}

function newRecordId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (typeof c?.randomUUID === 'function') return `chat-error-${c.randomUUID()}`
  return `chat-error-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Build the `ChatErrorRecord` the notices slice stores, from an already-classified
 * envelope. Deliberately NOT importing `chatSlice` — pass the action creator in, or
 * hand the record to whatever `dispatch` you already have.
 */
export function buildChatErrorRecord(envelope: ChatErrorEnvelope, ctx: ChatErrorRecordContext): ChatErrorRecord {
  return {
    id: ctx.id ?? newRecordId(),
    conversationId: ctx.conversationId,
    envelope,
    parentMessageId: ctx.parentMessageId ?? null,
    streamId: ctx.streamId ?? null,
    lineageId: ctx.lineageId ?? null,
    createdAt: ctx.createdAt ?? Date.now(),
    dismissed: false,
  }
}

/**
 * Classify + build + (optionally) hand off, so a thunk's catch block is one line:
 *
 *   const { envelope } = reportLocalChatError(error, { conversationId, streamId, phase: 'open' },
 *     record => dispatch(chatSliceActions.chatErrorRecorded(record)))
 *
 * `emit` receives the record; it is where the caller passes the action creator +
 * dispatch. This module never imports `chatSlice`.
 */
export function reportLocalChatError<T = void>(
  error: unknown,
  ctx: LocalChatErrorContext & ChatErrorRecordContext,
  emit?: (record: ChatErrorRecord) => T
): { envelope: ChatErrorEnvelope; record: ChatErrorRecord; emitted: T | undefined } {
  const envelope = classifyLocalChatError(error, {
    phase: ctx.phase,
    status: ctx.status,
    streamId: ctx.streamId,
    code: ctx.code,
  })
  const record = buildChatErrorRecord(envelope, ctx)
  return { envelope, record, emitted: emit ? emit(record) : undefined }
}
