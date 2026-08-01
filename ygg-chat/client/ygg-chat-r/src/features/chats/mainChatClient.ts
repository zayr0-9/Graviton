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
 */

import { buildLocalApiUrl } from '../../utils/api'
import { isResumableRunsEnabled } from '../../helpers/serverLoopSettings'
import { chatSliceActions } from './chatSlice'
import { projectServerEvent, normalizeServerMessage, type ProjectionContext, type ServerStreamEvent } from './sseProjection'
import type { Message } from './chatTypes'
import type { MessageId } from '../../../../../shared/types'

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
}

export interface RunServerChatLoopResult {
  messageId: MessageId | null
  userMessage: Message | null
  /** True when the terminal `complete` carried a provider error (message still rendered). */
  providerError: boolean
}

const RESUBSCRIBE_MAX_ATTEMPTS = 5
const RESUBSCRIBE_BASE_DELAY_MS = 300

/** Mutable accumulator threaded across the initial read and every reattach. */
interface StreamAccumulator {
  sawTerminal: boolean
  streamError: string | null
  messageId: MessageId | null
  userMessage: Message | null
  providerError: boolean
  /** Highest server `seq` applied — the reattach cursor. */
  lastSeq: number
}

function newAccumulator(startSeq = 0): StreamAccumulator {
  return { sawTerminal: false, streamError: null, messageId: null, userMessage: null, providerError: false, lastSeq: startSeq }
}

/** Build the per-event handler: project to Redux (in order) + capture return ids. */
function makeHandleEvent(
  acc: StreamAccumulator,
  ctx: ProjectionContext,
  operation: ServerLoopOperation,
  dispatch: (action: unknown) => unknown
): (event: ServerStreamEvent) => void {
  return (event: ServerStreamEvent): void => {
    if (!event || typeof event.type !== 'string') return
    // Track the replay cursor. Present only on the resumable (session) path.
    if (typeof event.seq === 'number' && event.seq > acc.lastSeq) acc.lastSeq = event.seq
    // (a) project to Redux, in order.
    for (const action of projectServerEvent(event, ctx)) dispatch(action)
    // (b) event-specific side effects that need the operation / return ids.
    if (event.type === 'user_message_persisted') {
      acc.userMessage = normalizeServerMessage(event.message)
      if (operation === 'send') dispatch(chatSliceActions.optimisticMessageCleared())
      else if (operation === 'edit') dispatch(chatSliceActions.optimisticBranchMessageCleared())
      // 'branch' uses no optimistic bubble.
    } else if (event.type === 'complete') {
      acc.messageId = event.message?.id ?? null
      acc.providerError = event.providerError === true
      acc.sawTerminal = true
    } else if (event.type === 'error') {
      acc.streamError = typeof event.error === 'string' && event.error ? event.error : 'Headless stream error'
      acc.sawTerminal = true
    }
  }
}

/** Read one SSE Response body to completion, dispatching each parsed `data:` event. */
async function pump(res: Response, handleEvent: (event: ServerStreamEvent) => void): Promise<void> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const processLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return // skips heartbeat comment frames
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    let event: ServerStreamEvent
    try {
      event = JSON.parse(payload)
    } catch {
      return
    }
    handleEvent(event)
  }

  while (true) {
    const { done, value } = await reader.read()
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

/**
 * After a non-terminal drop, resubscribe by streamId and replay from the cursor until
 * the run reaches a terminal event, the signal aborts, or the run is gone (410).
 * Throws only when the run is confirmed gone; transient failures back off and retry.
 */
async function resubscribeUntilTerminal(
  streamId: string,
  acc: StreamAccumulator,
  handleEvent: (event: ServerStreamEvent) => void,
  signal: AbortSignal
): Promise<void> {
  for (let attempt = 1; attempt <= RESUBSCRIBE_MAX_ATTEMPTS; attempt++) {
    if (signal.aborted || acc.sawTerminal || acc.streamError) return
    await abortableDelay(RESUBSCRIBE_BASE_DELAY_MS * attempt, signal)
    if (signal.aborted || acc.sawTerminal) return

    let res: Response
    try {
      const url = await buildLocalApiUrl(`/api/streams/${encodeURIComponent(streamId)}?fromSeq=${acc.lastSeq}`)
      res = await fetch(url, { signal })
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') return
      continue // transient network error → back off and retry
    }

    if (res.status === 410) {
      throw new Error('The server-owned run is no longer available (it was cancelled or expired).')
    }
    if (!res.ok || !res.body) continue // transient → retry
    await pump(res, handleEvent)
    if (acc.sawTerminal || acc.streamError) return
    // else dropped again → loop retries with a longer backoff
  }
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
  const { dispatch } = deps
  const ctx: ProjectionContext = { streamId, conversationId }
  const acc = newAccumulator()
  const handleEvent = makeHandleEvent(acc, ctx, operation, dispatch)

  const url = await buildLocalApiUrl(path)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(`Headless chat request failed (HTTP ${res.status})${text ? `: ${text}` : ''}`)
  }

  await pump(res, handleEvent)

  // A non-terminal, non-cancel end means the SSE dropped but the run is still alive
  // server-side — resubscribe and finish it. Only when resumable runs are enabled.
  if (!acc.sawTerminal && !acc.streamError && !signal.aborted && isResumableRunsEnabled()) {
    await resubscribeUntilTerminal(streamId, acc, handleEvent, signal)
  }

  if (acc.streamError) throw new Error(acc.streamError)
  if (!acc.sawTerminal) {
    if (signal.aborted) {
      const abortError = new Error('Message cancelled')
      abortError.name = 'AbortError'
      throw abortError
    }
    throw new Error('Headless stream ended without a terminal event')
  }

  return { messageId: acc.messageId, userMessage: acc.userMessage, providerError: acc.providerError }
}

export interface RunServerReattachResult extends RunServerChatLoopResult {
  /** The server had no live run for that streamId (410) — the caller should reconcile. */
  gone: boolean
  /** A terminal event was observed during (re)attach. */
  terminal: boolean
}

/**
 * Re-attach to an already-running (or lingering-terminal) server-owned run by streamId
 * and project its events. Used by mount-time resume after a reload — the CALLER must
 * dispatch `sendingStarted` first (to rebuild the stream slot) and handle terminal
 * cleanup. Never throws: returns `gone:true` when the run is unavailable.
 */
export async function runServerReattach(
  params: { streamId: string; conversationId: string; operation: ServerLoopOperation; fromSeq?: number; signal: AbortSignal },
  deps: RunServerChatLoopDeps
): Promise<RunServerReattachResult> {
  const { streamId, conversationId, operation, fromSeq = 0, signal } = params
  const { dispatch } = deps
  const ctx: ProjectionContext = { streamId, conversationId }
  const acc = newAccumulator(fromSeq)
  const handleEvent = makeHandleEvent(acc, ctx, operation, dispatch)

  try {
    const url = await buildLocalApiUrl(`/api/streams/${encodeURIComponent(streamId)}?fromSeq=${fromSeq}`)
    const res = await fetch(url, { signal })
    if (res.status === 410) {
      return { messageId: null, userMessage: null, providerError: false, gone: true, terminal: false }
    }
    if (!res.ok || !res.body) {
      return { messageId: acc.messageId, userMessage: acc.userMessage, providerError: acc.providerError, gone: true, terminal: false }
    }
    await pump(res, handleEvent)
    // A mid-replay drop (still not terminal) → keep resubscribing.
    if (!acc.sawTerminal && !acc.streamError && !signal.aborted && isResumableRunsEnabled()) {
      await resubscribeUntilTerminal(streamId, acc, handleEvent, signal).catch(() => {
        /* gone/expired → fall through with terminal:false */
      })
    }
  } catch (error) {
    if ((error as { name?: string }).name !== 'AbortError') {
      return { messageId: acc.messageId, userMessage: acc.userMessage, providerError: acc.providerError, gone: true, terminal: acc.sawTerminal }
    }
  }

  return {
    messageId: acc.messageId,
    userMessage: acc.userMessage,
    providerError: acc.providerError,
    gone: false,
    terminal: acc.sawTerminal,
  }
}

/** Explicitly cancel a server-owned run. Under resumable runs this is what Stop calls
 * (a bare socket close only detaches). Best-effort; never throws. */
export async function postStreamAbort(streamId: string): Promise<boolean> {
  try {
    const url = await buildLocalApiUrl(`/api/streams/${encodeURIComponent(streamId)}/abort`)
    const res = await fetch(url, { method: 'POST' })
    return res.ok
  } catch {
    return false
  }
}
