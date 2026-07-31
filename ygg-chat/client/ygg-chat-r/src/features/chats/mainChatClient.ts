/**
 * mainChatClient — the renderer thin client for the server-owned chat loop (Phase 1).
 *
 * Adapts the proven subagentClient / mobile-UI SSE reader, but projects EVERY
 * server event through sseProjection.projectServerEvent instead of discarding
 * structural events. Owns ONLY the fetch + SSE read + per-event projection
 * dispatch + capturing the ids the calling thunk must relay. Stream lifecycle
 * (sendingStarted / AbortController / terminal tail / error classification) stays
 * in the thunk shim.
 *
 * Phase 1 routes ONLY auto-approve + local-provider (LM Studio / Zai) conversations
 * here, so no pause/resume (permission_required / clarify_required) is exercised.
 */

import { buildLocalApiUrl } from '../../utils/api'
import { chatSliceActions } from './chatSlice'
import { projectServerEvent, normalizeServerMessage, type ProjectionContext } from './sseProjection'
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
}

/**
 * Drive one server-owned chat run over SSE, projecting events into Redux.
 * Returns the persisted user message and the terminal assistant message id.
 * Throws on stream error or (client/server) abort; the thunk shim owns the
 * catch (sendingCompleted -> error chunk / cancel classification).
 */
export async function runServerChatLoop(
  params: RunServerChatLoopParams,
  deps: RunServerChatLoopDeps
): Promise<RunServerChatLoopResult> {
  const { operation, conversationId, streamId, path, request, signal } = params
  const { dispatch } = deps
  const ctx: ProjectionContext = { streamId, conversationId }

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

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let sawTerminal = false
  let streamError: string | null = null
  let messageId: MessageId | null = null
  let userMessage: Message | null = null

  const handleEvent = (event: any): void => {
    if (!event || typeof event.type !== 'string') return
    // (a) project to Redux, in order.
    for (const action of projectServerEvent(event, ctx)) dispatch(action)
    // (b) event-specific side effects that need the operation / return ids.
    if (event.type === 'user_message_persisted') {
      userMessage = normalizeServerMessage(event.message)
      if (operation === 'send') dispatch(chatSliceActions.optimisticMessageCleared())
      else if (operation === 'edit') dispatch(chatSliceActions.optimisticBranchMessageCleared())
      // 'branch' uses no optimistic bubble.
    } else if (event.type === 'complete') {
      messageId = event.message?.id ?? null
      sawTerminal = true
    } else if (event.type === 'error') {
      streamError = typeof event.error === 'string' && event.error ? event.error : 'Headless stream error'
      sawTerminal = true
    }
  }

  const processLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return // skips heartbeat comment frames
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    let event: any
    try {
      event = JSON.parse(payload)
    } catch {
      return
    }
    handleEvent(event)
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) processLine(line)
  }
  if (buffer.trim()) processLine(buffer)

  if (streamError) throw new Error(streamError)
  if (!sawTerminal) {
    if (signal.aborted) {
      const abortError = new Error('Message cancelled')
      abortError.name = 'AbortError'
      throw abortError
    }
    throw new Error('Headless stream ended without a terminal event')
  }

  return { messageId, userMessage }
}
