/**
 * mainChatClient — the renderer thin client for the server-owned chat loop.
 *
 * Projects EVERY server SSE event through sseProjection.projectServerEvent. Owns the
 * fetch + SSE read + per-event projection dispatch + capturing the ids the calling
 * thunk must relay. Stream lifecycle (sendingStarted / AbortController / terminal tail
 * / error classification) stays in the thunk shim.
 *
 * Detach/reattach (gateway.resumableRuns + renderer isResumableRunsEnabled): when the
 * SSE body ends WITHOUT a terminal event and the run was NOT cancelled, the run is
 * still alive server-side — so we resubscribe by streamId (GET /api/streams/:id?fromSeq)
 * and replay from the last applied seq. runServerReattach is the same read path used by
 * mount-time resume after a reload. Every server frame carries a monotonic `seq` used as
 * the replay cursor (append-style chunk projection is only idempotent with the cursor).
 *
 * Failure handling: nothing in here decides what a user reads. Every failure leaves this
 * module as a classified `ChatErrorEnvelope` — thrown inside a `ChatStreamError`, or
 * returned on the result of the two deliberately non-throwing calls (runServerReattach,
 * postStreamAbort). Raw `Error.message` text stays raw: it is for logs and for
 * `envelope.detail`, never for the screen. See shared/chatErrors + localChatErrors.
 */

import { buildLocalApiUrl } from '../../utils/api'
import { isResumableRunsEnabled } from '../../helpers/serverLoopSettings'
import { chatSliceActions } from './chatSlice'
import { projectServerEvent, normalizeServerMessage, type ProjectionContext, type ServerStreamEvent } from './sseProjection'
import { attachLocalChatErrorCode, classifyLocalChatError } from './localChatErrors'
import type { Message } from './chatTypes'
import type { MessageId } from '../../../../../shared/types'
import {
  buildChatErrorEnvelope,
  normalizeChatErrorEnvelope,
  type ChatErrorEnvelope,
} from '../../../../../shared/chatErrors'

export type ServerLoopOperation = 'send' | 'edit' | 'branch'

export interface RunServerChatLoopParams {
  operation: ServerLoopOperation
  conversationId: string
  streamId: string
  /** Relative headless route path (resolved to the local server origin here). */
  path: string
  /** The POST body built by buildServerLoopRequest. */
  request: Record<string, unknown>
  signal: AbortSignal
}

export interface RunServerChatLoopDeps {
  dispatch: (action: unknown) => unknown
  getState: () => unknown
  /**
   * Called after each persisted message (user / assistant / terminal complete) has been
   * projected to Redux, so the caller can refresh views DERIVED from the message list —
   * chiefly the Heimdall node tree, which renders from its own `heimdall.treeData` slice
   * rather than the live `conversation.messages`. Best-effort; must never throw. Omitted
   * by mobile/tests. See chatActions.refreshHeimdallTreeFromState.
   */
  onMessagePersisted?: () => void
  /** Data URLs captured before send. They bridge the optimistic temp row to the
   * server-assigned user-message ID; durable metadata linking is server-owned. */
  userMessageArtifacts?: string[]
  /** Persist the highest projected sequence for reload-safe reattachment. */
  onSeq?: (seq: number, event: ServerStreamEvent) => void
}

export interface RunServerChatLoopResult {
  messageId: MessageId | null
  userMessage: Message | null
  /** True when the terminal `complete` carried a provider error (message still rendered). */
  providerError: boolean
}

const RESUBSCRIBE_MAX_ATTEMPTS = 5
const RESUBSCRIBE_BASE_DELAY_MS = 300

/**
 * The server writes an SSE heartbeat comment frame every 15s for exactly this purpose,
 * so silence longer than a few beats is a real stall and not just a slow model.
 *
 * 45s = three missed beats. Two would be too eager (one dropped beat plus a GC pause,
 * a suspended-tab throttle or a busy event loop can easily swallow ~20s of timers),
 * and a minute-plus is indistinguishable from the bug this exists to kill: the eternal
 * spinner. Note the watchdog is armed on BYTES, not on parsed events — the heartbeat
 * itself resets it, which is what makes "nothing at all arrived" a trustworthy signal.
 */
const STREAM_IDLE_TIMEOUT_MS = 45_000

/** Sentinel resolved by the idle timer, distinguishable from any read result. */
const IDLE_TIMEOUT: unique symbol = Symbol('sse-idle-timeout')

/**
 * An error that carries its own classification.
 *
 * Everything this module throws is one of these, so the thunk shim can record the
 * failure by reading `.envelope` instead of re-parsing prose. `message` stays the
 * RAW technical text (for logs and `envelope.detail`); it is never rendered — only
 * `envelope.userMessage` is. The code is also attached via `attachLocalChatErrorCode`
 * so a caller that only runs `classifyLocalChatError` still lands on the right code.
 */
export interface ChatStreamError extends Error {
  envelope: ChatErrorEnvelope
  /**
   * Set when the SERVER already wrote this failure into a message row (tier 1).
   * The thunk shim must then NOT record a tier-2 `ChatErrorRecord`, or the user sees
   * the same failure twice — once as transcript content and once as a floating bubble.
   */
  persistedErrorMessageId?: string | null
}

export function createChatStreamError(
  envelope: ChatErrorEnvelope,
  rawMessage?: string,
  persistedErrorMessageId?: string | null
): ChatStreamError {
  const raw = typeof rawMessage === 'string' && rawMessage.trim() ? rawMessage : envelope.detail || envelope.userMessage
  const error = new Error(raw) as ChatStreamError
  error.envelope = envelope
  if (persistedErrorMessageId) error.persistedErrorMessageId = persistedErrorMessageId
  attachLocalChatErrorCode(error, envelope.code)
  return error
}

/** Read the tier-1 marker off a throw. Absent means the renderer owns the surface. */
export function getPersistedErrorMessageId(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const id = (error as { persistedErrorMessageId?: unknown }).persistedErrorMessageId
  return typeof id === 'string' && id ? id : null
}

/** Read the envelope off a throw, when it carries one. */
export function getChatStreamErrorEnvelope(error: unknown): ChatErrorEnvelope | undefined {
  if (!error || typeof error !== 'object') return undefined
  const envelope = (error as { envelope?: unknown }).envelope
  if (!envelope || typeof envelope !== 'object') return undefined
  const code = (envelope as { code?: unknown }).code
  return typeof code === 'string' ? (envelope as ChatErrorEnvelope) : undefined
}

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError'
}

/** Raw technical text for logs / `envelope.detail`. Never rendered. */
function rawMessageOf(error: unknown): string | undefined {
  if (error instanceof Error) return error.message || undefined
  if (typeof error === 'string') return error || undefined
  return undefined
}

/** Mutable accumulator threaded across the initial read and every reattach. */
interface StreamAccumulator {
  sawTerminal: boolean
  /** RAW/technical failure text. For logs and `envelope.detail` only — never rendered. */
  streamError: string | null
  /**
   * The classified, user-facing form of `streamError`. Carrying the whole envelope is
   * the point: `status`, `errorType`, `resetAt`, `provider` and `retryExhausted` all
   * survive to the thunk instead of being collapsed into one prose string here.
   */
  errorEnvelope: ChatErrorEnvelope | null
  /**
   * The `persistedErrorMessageId` off the terminal `error` frame: the id of the message
   * row the SERVER already wrote carrying this failure's ErrorBlock. Its presence is what
   * stops the thunk adding a second, floating bubble for the same failure.
   */
  persistedErrorMessageId: string | null
  messageId: MessageId | null
  userMessage: Message | null
  providerError: boolean
  requiresReauthentication: boolean
  /** Highest server `seq` applied — the reattach cursor. */
  lastSeq: number
  /** SSE frames that failed to parse. A run that ends having dropped frames has a
   * hole in what the user saw, which is `history_truncated`, not a generic failure. */
  droppedFrames: number
}

function newAccumulator(startSeq = 0): StreamAccumulator {
  return {
    sawTerminal: false,
    streamError: null,
    errorEnvelope: null,
    persistedErrorMessageId: null,
    messageId: null,
    userMessage: null,
    providerError: false,
    requiresReauthentication: false,
    lastSeq: startSeq,
    droppedFrames: 0,
  }
}

/** Record a classified terminal failure on the accumulator (first one wins). */
function recordAccumulatorFailure(acc: StreamAccumulator, envelope: ChatErrorEnvelope, raw?: string): void {
  if (acc.errorEnvelope) return
  acc.errorEnvelope = envelope
  acc.streamError = raw ?? envelope.detail ?? envelope.userMessage
}

/**
 * Classify one server `error` frame WITHOUT discarding what it carried.
 *
 * The server's own `envelope` always wins — it classified the provider failure with
 * information the renderer does not have. When it is absent (an older server, or the
 * mobile LAN path), the frame's own `status` still classifies it far better than a
 * blanket `internal_error`, and `errorType` / `retryExhausted` / `provider` / `resetAt`
 * are folded into the envelope (or its `detail`) instead of being dropped on the floor.
 */
function envelopeForErrorFrame(
  event: Extract<ServerStreamEvent, { type: 'error' }>,
  raw: string
): ChatErrorEnvelope {
  const status = typeof event.status === 'number' ? event.status : undefined
  const provider = typeof event.provider === 'string' && event.provider ? event.provider : undefined
  const resetAt = typeof event.resetAt === 'number' ? event.resetAt : undefined
  const errorType = typeof event.errorType === 'string' && event.errorType ? event.errorType : undefined

  const base = event.envelope
    ? normalizeChatErrorEnvelope(event.envelope, raw)
    : classifyLocalChatError(raw, { phase: 'stream', status })

  // Everything technical the frame knew, kept together behind the Details disclosure.
  const detail = [base.detail ?? raw, errorType ? `type=${errorType}` : null, event.retryExhausted === true ? 'retries exhausted' : null]
    .filter(Boolean)
    .join(' · ')

  return buildChatErrorEnvelope(base.code, {
    ...base,
    detail,
    provider: base.provider ?? provider,
    resetAt: base.resetAt ?? resetAt,
    status: base.status ?? status,
  })
}

/** Build the per-event handler: project to Redux (in order) + capture return ids. */
function makeHandleEvent(
  acc: StreamAccumulator,
  ctx: ProjectionContext,
  operation: ServerLoopOperation,
  dispatch: (action: unknown) => unknown,
  onMessagePersisted?: () => void,
  onSeq?: (seq: number, event: ServerStreamEvent) => void
): (event: ServerStreamEvent) => void {
  return (event: ServerStreamEvent): void => {
    if (!event || typeof event.type !== 'string') return
    // Track the replay cursor. Present only on the resumable (session) path.
    const nextSeq = typeof event.seq === 'number' && event.seq > acc.lastSeq ? event.seq : null
    if (nextSeq !== null) acc.lastSeq = nextSeq
    // (a) project to Redux, in order.
    for (const action of projectServerEvent(event, ctx)) dispatch(action)
    // (b) event-specific side effects that need the operation / return ids.
    if (event.type === 'user_message_persisted') {
      acc.userMessage = normalizeServerMessage(event.message)
      if (ctx.userMessageArtifacts?.length) {
        acc.userMessage.artifacts = Array.from(
          new Set([...(acc.userMessage.artifacts || []), ...ctx.userMessageArtifacts])
        )
      }
      if (operation === 'send') dispatch(chatSliceActions.optimisticMessageCleared())
      else if (operation === 'edit') dispatch(chatSliceActions.optimisticBranchMessageCleared())
      // 'branch' uses no optimistic bubble.
      onMessagePersisted?.()
    } else if (event.type === 'assistant_message_persisted') {
      // Intermediate + re-emitted post-tool assistant rows: already projected to Redux
      // above; let the caller refresh derived views (Heimdall) so nodes appear per-turn.
      onMessagePersisted?.()
    } else if (event.type === 'complete') {
      acc.messageId = event.message?.id ?? null
      acc.providerError = event.providerError === true
      acc.sawTerminal = true
      onMessagePersisted?.()
    } else if (event.type === 'reauth_required') {
      // D2: NO forced navigation. The old handler dispatched FORCE_LOGOUT_EVENT (which
      // clears AuthContext.user, and ProtectedRoute then redirects) and set
      // `location.hash = '/login'` — from inside an SSE frame handler, mid-reply, with
      // no explanation and no way back. The classified envelope travels out instead, so
      // the transcript renders a bubble with a "Sign in" button the user chooses to press.
      const raw = typeof event.message === 'string' && event.message ? event.message : 'Server requires reauthentication'
      acc.requiresReauthentication = true
      acc.sawTerminal = true
      acc.errorEnvelope = event.envelope
        ? normalizeChatErrorEnvelope(event.envelope, raw)
        : buildChatErrorEnvelope('session_expired', { detail: raw, status: 401 })
      acc.streamError = raw
    } else if (event.type === 'error') {
      // Contract: `terminal` absent === true. An explicit `false` is a failure the server
      // loop recovered from — it is projected, but it must not end the run.
      const terminal = event.terminal !== false
      if (!acc.requiresReauthentication && terminal) {
        const raw = typeof event.error === 'string' && event.error ? event.error : 'Headless stream error'
        acc.errorEnvelope = envelopeForErrorFrame(event, raw)
        acc.streamError = raw
        // R2: the server already wrote this failure into a message row, so the bubble
        // exists as transcript content. Carrying the id out is what lets the thunk skip
        // recording a second, floating copy of the same failure.
        acc.persistedErrorMessageId =
          typeof event.persistedErrorMessageId === 'string' && event.persistedErrorMessageId
            ? event.persistedErrorMessageId
            : null
      }
      if (terminal) acc.sawTerminal = true
    }
    // Checkpoint only after projection and side effects succeed. Pending decision frames
    // are filtered by the caller so reload can replay them and rebuild their dialogs.
    if (nextSeq !== null) onSeq?.(nextSeq, event)
  }
}

/**
 * Read one SSE Response body to completion, dispatching each parsed `data:` event.
 *
 * Two guarantees beyond "decode and dispatch":
 *  - an idle watchdog. Heartbeat comment frames are still not projected, but they now
 *    COUNT: any bytes at all rearm the timer, so `STREAM_IDLE_TIMEOUT_MS` of true
 *    silence throws a classified `stream_stalled` instead of spinning forever.
 *  - dropped-frame accounting. A frame that fails to parse used to vanish silently;
 *    it is now counted (and logged once) so the run can end as `history_truncated`.
 */
async function pump(res: Response, acc: StreamAccumulator, handleEvent: (event: ServerStreamEvent) => void): Promise<void> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const processLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return // heartbeat/comment frames: not projected, but they DID rearm the watchdog
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    let event: ServerStreamEvent
    try {
      event = JSON.parse(payload)
    } catch (parseError) {
      acc.droppedFrames += 1
      // Log ONCE per run: a malformed frame usually means every following frame is
      // malformed too, and a per-frame log would bury the one that matters.
      if (acc.droppedFrames === 1) {
        console.warn('[mainChatClient] dropped an unparseable SSE frame', {
          reason: rawMessageOf(parseError),
          preview: payload.slice(0, 200),
        })
      }
      return
    }
    handleEvent(event)
  }

  while (true) {
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const idle = new Promise<typeof IDLE_TIMEOUT>(resolve => {
      idleTimer = setTimeout(() => resolve(IDLE_TIMEOUT), STREAM_IDLE_TIMEOUT_MS)
    })
    let step: ReadableStreamReadResult<Uint8Array> | typeof IDLE_TIMEOUT
    try {
      step = await Promise.race([reader.read(), idle])
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
    }

    if (step === IDLE_TIMEOUT) {
      // The abandoned read() is released by cancelling the reader; we never read again.
      void Promise.resolve(reader.cancel()).catch(() => {})
      const raw = `No SSE activity for ${STREAM_IDLE_TIMEOUT_MS}ms (heartbeat interval is 15000ms)`
      throw createChatStreamError(classifyLocalChatError(new Error(raw), { phase: 'stream', code: 'stream_stalled' }), raw)
    }

    const { done, value } = step
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) processLine(line)
  }
  if (buffer.trim()) processLine(buffer)
}

/** Delay that resolves early (does not reject) when the signal aborts. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      resolve()
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export interface ResubscribeOutcome {
  /** How many reconnect attempts were actually made. */
  attempts: number
  /** The classified reason the LAST attempt failed, when one did. */
  lastFailure: ChatErrorEnvelope | null
}

/**
 * After a non-terminal drop, resubscribe by streamId and replay from the cursor until
 * the run reaches a terminal event, the signal aborts, or the run is gone (410).
 * Throws only when the run is confirmed gone; transient failures back off and retry.
 *
 * Every attempt emits a `reconnecting` notice through `handleEvent`, because the
 * alternative is ~4.5s of an apparently dead transcript: the run is not streaming, no
 * error has happened yet, and nothing on screen changes. The notice is non-terminal —
 * it never touches `error`/`status`/`active` — and a repeat replaces the previous one.
 */
async function resubscribeUntilTerminal(
  streamId: string,
  acc: StreamAccumulator,
  handleEvent: (event: ServerStreamEvent) => void,
  signal: AbortSignal
): Promise<ResubscribeOutcome> {
  const outcome: ResubscribeOutcome = { attempts: 0, lastFailure: null }

  for (let attempt = 1; attempt <= RESUBSCRIBE_MAX_ATTEMPTS; attempt++) {
    if (signal.aborted || acc.sawTerminal || acc.streamError) return outcome
    outcome.attempts = attempt
    handleEvent({
      type: 'notice',
      code: 'reconnecting',
      message: attempt === 1 ? 'Reconnecting…' : `Reconnecting… (attempt ${attempt} of ${RESUBSCRIBE_MAX_ATTEMPTS})`,
      attempt,
      maxAttempts: RESUBSCRIBE_MAX_ATTEMPTS,
    })

    await abortableDelay(RESUBSCRIBE_BASE_DELAY_MS * attempt, signal)
    if (signal.aborted || acc.sawTerminal) return outcome

    let res: Response
    try {
      const url = await buildLocalApiUrl(`/streams/${encodeURIComponent(streamId)}?fromSeq=${acc.lastSeq}`)
      res = await fetch(url, { signal })
    } catch (error) {
      if (isAbortError(error)) return outcome
      // Transient network error → back off and retry, but keep WHY: if every attempt
      // fails this is the only surviving explanation for the run's death.
      outcome.lastFailure = classifyLocalChatError(error, { phase: 'reattach', streamId })
      continue
    }

    if (res.status === 410) {
      const raw = 'The server-owned run is no longer available (it was cancelled or expired).'
      throw createChatStreamError(buildChatErrorEnvelope('run_expired', { detail: raw, status: 410 }), raw)
    }
    if (!res.ok || !res.body) {
      outcome.lastFailure = classifyLocalChatError(new Error(`Stream resubscribe failed (HTTP ${res.status})`), {
        phase: 'reattach',
        status: res.status,
        streamId,
      })
      continue // transient → retry
    }

    try {
      await pump(res, acc, handleEvent)
    } catch (error) {
      if (isAbortError(error)) return outcome
      const envelope = getChatStreamErrorEnvelope(error) ?? classifyLocalChatError(error, { phase: 'reattach', streamId })
      outcome.lastFailure = envelope
      // A stall is not transient: the run is alive and silent, so re-attaching only
      // buys more silence. Fail the run here with the classification we have.
      if (envelope.code === 'stream_stalled') {
        recordAccumulatorFailure(acc, envelope, rawMessageOf(error))
        return outcome
      }
      continue // dropped again → retry with a longer backoff
    }
    if (acc.sawTerminal || acc.streamError) return outcome
    // else dropped again → loop retries with a longer backoff
  }
  return outcome
}

/**
 * Drive one server-owned chat run over SSE, projecting events into Redux.
 * Returns the persisted user message and the terminal assistant message id.
 * Throws on stream error or (client/server) abort; the thunk shim owns the catch.
 */
export async function runServerChatLoop(
  params: RunServerChatLoopParams,
  deps: RunServerChatLoopDeps
): Promise<RunServerChatLoopResult> {
  const { operation, conversationId, streamId, path, request, signal } = params
  const { dispatch, getState, onMessagePersisted, onSeq, userMessageArtifacts } = deps
  const ctx: ProjectionContext = { streamId, conversationId, userMessageArtifacts }
  const acc = newAccumulator()
  const handleEvent = makeHandleEvent(acc, ctx, operation, dispatch, onMessagePersisted, onSeq)

  if (operation === 'branch' || operation === 'edit') {
    const state = getState() as any
    const conversation = state?.chat?.conversation
    const stream = state?.chat?.streaming?.byId?.[streamId]
    console.info('[LineageForkDebug][Renderer] request', {
      operation,
      conversationId,
      streamId,
      operationId: request.operationId ?? null,
      requestedLineageId: request.lineageId ?? null,
      sourceMessageId: operation === 'branch'
        ? path.match(/\/messages\/([^/]+)\/branch$/)?.[1] ?? null
        : path.match(/\/messages\/([^/]+)\/edit-branch$/)?.[1] ?? null,
      parentId: request.parentId ?? null,
      selectedLineageId: conversation?.currentLineageId ?? null,
      selectedPath: Array.isArray(conversation?.currentPath) ? conversation.currentPath.map(String) : [],
      focusedMessageId: conversation?.focusedChatMessageId ?? null,
      streamLineageId: stream?.lineage?.lineageId ?? null,
      streamRootMessageId: stream?.lineage?.rootMessageId ?? null,
      streamOriginMessageId: stream?.lineage?.originMessageId ?? null,
    })
  }

  const url = await buildLocalApiUrl(path)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    })
  } catch (error) {
    if (isAbortError(error)) throw error
    // Nothing was sent: a dead local server, or the device is offline.
    throw createChatStreamError(classifyLocalChatError(error, { phase: 'open', streamId }), rawMessageOf(error))
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    const raw = `Headless chat request failed (HTTP ${res.status})${text ? `: ${text}` : ''}`
    throw createChatStreamError(classifyLocalChatError(new Error(raw), { phase: 'open', status: res.status, streamId }), raw)
  }

  /**
   * A transport failure during the read, held rather than thrown: a mid-stream socket
   * drop is the SAME situation as a clean non-terminal EOF — the run is still alive
   * server-side — so it must reach the resubscribe gate below instead of unwinding past
   * it. (Throwing here also made the thunk's `finally` delete the localStorage inflight
   * marker, which took mount-time resume out with it.)
   */
  let dropFailure: { envelope: ChatErrorEnvelope; raw?: string } | null = null
  try {
    await pump(res, acc, handleEvent)
  } catch (error) {
    if (isAbortError(error) || signal.aborted) throw error
    const envelope = getChatStreamErrorEnvelope(error) ?? classifyLocalChatError(error, { phase: 'stream', streamId })
    if (envelope.code === 'stream_stalled') {
      // Silence is not a dropped socket: the run is attached and producing nothing, so
      // reconnecting to it would only re-attach to the same silence. Fail it here.
      recordAccumulatorFailure(acc, envelope, rawMessageOf(error))
    } else {
      dropFailure = { envelope, raw: rawMessageOf(error) }
    }
  }

  // A non-terminal, non-cancel end means the SSE dropped but the run is still alive
  // server-side — resubscribe and finish it. Only when resumable runs are enabled.
  let resubscribe: ResubscribeOutcome | null = null
  if (!acc.sawTerminal && !acc.streamError && !signal.aborted && isResumableRunsEnabled()) {
    resubscribe = await resubscribeUntilTerminal(streamId, acc, handleEvent, signal)
  }

  // The reconnect never got there: the run died with the drop that started it. Which
  // prose depends on whether we actually tried — "I couldn't reconnect" is a lie if
  // resumable runs are off and we never did.
  if (!acc.sawTerminal && !acc.errorEnvelope && dropFailure && !signal.aborted) {
    const triedToReconnect = (resubscribe?.attempts ?? 0) > 0
    const detail = [dropFailure.raw ?? dropFailure.envelope.detail, resubscribe?.lastFailure?.detail]
      .filter(Boolean)
      .join(' · ')
    const envelope = triedToReconnect
      ? buildChatErrorEnvelope(acc.droppedFrames ? 'history_truncated' : 'connection_lost', { detail })
      : buildChatErrorEnvelope(dropFailure.envelope.code, { ...dropFailure.envelope, detail })
    recordAccumulatorFailure(acc, envelope, dropFailure.raw)
  }

  if (acc.streamError || acc.errorEnvelope) {
    if (operation === 'branch' || operation === 'edit') {
      const state = getState() as any
      const conversation = state?.chat?.conversation
      const stream = state?.chat?.streaming?.byId?.[streamId]
      console.error('[LineageForkDebug][Renderer] failed', {
        error: acc.streamError,
        operation,
        conversationId,
        streamId,
        operationId: request.operationId ?? null,
        requestedLineageId: request.lineageId ?? null,
        sourceMessageId: operation === 'branch'
          ? path.match(/\/messages\/([^/]+)\/branch$/)?.[1] ?? null
          : path.match(/\/messages\/([^/]+)\/edit-branch$/)?.[1] ?? null,
        parentId: request.parentId ?? null,
        selectedLineageId: conversation?.currentLineageId ?? null,
        selectedPath: Array.isArray(conversation?.currentPath) ? conversation.currentPath.map(String) : [],
        focusedMessageId: conversation?.focusedChatMessageId ?? null,
        streamLineageId: stream?.lineage?.lineageId ?? null,
        streamRootMessageId: stream?.lineage?.rootMessageId ?? null,
        streamOriginMessageId: stream?.lineage?.originMessageId ?? null,
        lastSeq: acc.lastSeq,
      })
    }
    // The throw CARRIES the classification. `message` stays the raw/technical string
    // (logs, `envelope.detail`); the thunk shim reads `.envelope` and never re-parses it.
    throw createChatStreamError(
      acc.errorEnvelope ?? classifyLocalChatError(new Error(acc.streamError ?? ''), { phase: 'stream', streamId }),
      acc.streamError ?? undefined,
      acc.persistedErrorMessageId
    )
  }
  if (!acc.sawTerminal) {
    if (signal.aborted) {
      const abortError = new Error('Message cancelled')
      abortError.name = 'AbortError'
      throw attachLocalChatErrorCode(abortError, 'cancelled')
    }
    // Frames were dropped, so what the user saw has a hole in it — that is a different
    // (and more accurate) story than a generic interruption, and the saved copy is whole.
    const raw = acc.droppedFrames
      ? `Headless stream ended without a terminal event after dropping ${acc.droppedFrames} unparseable frame(s)`
      : 'Headless stream ended without a terminal event'
    throw createChatStreamError(
      buildChatErrorEnvelope(acc.droppedFrames ? 'history_truncated' : 'stream_interrupted', { detail: raw }),
      raw
    )
  }

  return { messageId: acc.messageId, userMessage: acc.userMessage, providerError: acc.providerError }
}

export interface RunServerReattachResult extends RunServerChatLoopResult {
  /** The server had no live run for that streamId (410) — the caller should reconcile. */
  gone: boolean
  /** A terminal event was observed during (re)attach. */
  terminal: boolean
  /**
   * Present ONLY when something actually went wrong.
   *
   * This is what stops "the reattach failed" and "there was nothing to do" from being
   * the same value: `{gone:false, terminal:false}` used to be returned for a 500, for a
   * network throw and for a healthy-but-still-running replay alike. With no envelope the
   * result means "nothing to report"; with one it means "this failed, and here is the
   * classified reason" — including the terminal-error case, where the run ended in a
   * failure the caller must surface (nothing throws on this path to do it for them).
   */
  envelope?: ChatErrorEnvelope
}

/**
 * Re-attach to an already-running (or lingering-terminal) server-owned run by streamId
 * and project its events. Used by mount-time resume after a reload — the CALLER must
 * dispatch `sendingStarted` first (to rebuild the stream slot) and handle terminal
 * cleanup. Never throws: returns `gone:true` when the run is unavailable, and an
 * `envelope` whenever the attempt failed.
 */
export async function runServerReattach(
  params: { streamId: string; conversationId: string; operation: ServerLoopOperation; fromSeq?: number; signal: AbortSignal },
  deps: RunServerChatLoopDeps
): Promise<RunServerReattachResult> {
  const { streamId, conversationId, operation, fromSeq = 0, signal } = params
  const { dispatch, onMessagePersisted, onSeq } = deps
  const ctx: ProjectionContext = { streamId, conversationId }
  const acc = newAccumulator(fromSeq)
  const handleEvent = makeHandleEvent(acc, ctx, operation, dispatch, onMessagePersisted, onSeq)

  try {
    const url = await buildLocalApiUrl(`/streams/${encodeURIComponent(streamId)}?fromSeq=${fromSeq}`)
    const res = await fetch(url, { signal })
    if (res.status === 410) {
      // Not an error the user caused, but not a no-op either: this reply never finished
      // in front of them and the server no longer has it.
      return {
        messageId: null,
        userMessage: null,
        providerError: false,
        gone: true,
        terminal: false,
        envelope: buildChatErrorEnvelope('run_expired', { status: 410, detail: `GET /streams/${streamId} → 410` }),
      }
    }
    if (!res.ok || !res.body) {
      const raw = `Stream reattach failed (HTTP ${res.status})`
      return {
        messageId: acc.messageId,
        userMessage: acc.userMessage,
        providerError: acc.providerError,
        gone: false,
        terminal: false,
        envelope: classifyLocalChatError(new Error(raw), { phase: 'reattach', status: res.status, streamId }),
      }
    }
    await pump(res, acc, handleEvent)
    // A mid-replay drop (still not terminal) → keep resubscribing.
    if (!acc.sawTerminal && !acc.streamError && !signal.aborted && isResumableRunsEnabled()) {
      try {
        await resubscribeUntilTerminal(streamId, acc, handleEvent, signal)
      } catch (error) {
        // Used to be `.catch(() => {})`: the run being confirmed gone looked identical to
        // a healthy replay. Classify it and hand it back.
        if (!isAbortError(error)) {
          const envelope = getChatStreamErrorEnvelope(error) ?? classifyLocalChatError(error, { phase: 'reattach', streamId })
          return {
            messageId: acc.messageId,
            userMessage: acc.userMessage,
            providerError: acc.providerError,
            gone: false,
            terminal: acc.sawTerminal,
            envelope,
          }
        }
      }
    }
  } catch (error) {
    if (!isAbortError(error)) {
      return {
        messageId: acc.messageId,
        userMessage: acc.userMessage,
        providerError: acc.providerError,
        gone: false,
        terminal: acc.sawTerminal,
        envelope: getChatStreamErrorEnvelope(error) ?? classifyLocalChatError(error, { phase: 'reattach', streamId }),
      }
    }
  }

  return {
    messageId: acc.messageId,
    userMessage: acc.userMessage,
    providerError: acc.providerError,
    gone: false,
    terminal: acc.sawTerminal,
    // A terminal `error`/`reauth_required` frame during replay: nothing throws here, so
    // this is the ONLY way the caller learns the run ended badly.
    ...(acc.errorEnvelope ? { envelope: acc.errorEnvelope } : {}),
  }
}

/** The outcome of an explicit Stop. `ok:false` means the run may STILL be generating. */
export interface StreamAbortResult {
  ok: boolean
  /** HTTP status, when a response came back at all. */
  status?: number
  /** Present only when `ok` is false. `code:'run_expired'` (410) means the run was
   * already gone, i.e. the stop is moot rather than unconfirmed. */
  envelope?: ChatErrorEnvelope
}

/**
 * Explicitly cancel a server-owned run. Under resumable runs this is what Stop calls
 * (a bare socket close only detaches). Never throws — but a failure is now REPORTED
 * rather than flattened into `false`: previously a timed-out or rejected abort was
 * indistinguishable from a clean one at the type level, so the UI said "stopped" while
 * the server kept generating and kept billing.
 */
export async function postStreamAbort(streamId: string): Promise<StreamAbortResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5_000)
  try {
    const url = await buildLocalApiUrl(`/streams/${encodeURIComponent(streamId)}/abort`)
    const res = await fetch(url, { method: 'POST', signal: controller.signal })
    if (res.ok) return { ok: true, status: res.status }
    const raw = `Stream abort failed (HTTP ${res.status})`
    return {
      ok: false,
      status: res.status,
      envelope: classifyLocalChatError(new Error(raw), { phase: 'abort', status: res.status, streamId }),
    }
  } catch (error) {
    // Includes the 5s timeout above (an AbortError). Phase 'abort' classifies both as
    // `stop_not_confirmed`, which is exactly what the user needs to know.
    return { ok: false, envelope: classifyLocalChatError(error, { phase: 'abort', streamId }) }
  } finally {
    clearTimeout(timeout)
  }
}
