/**
 * SSE -> Redux projection for the server-owned chat loop (Phase 1).
 *
 * `projectServerEvent` is a PURE function: given one server SSE event it returns
 * the ordered list of Redux actions to dispatch, mapping the server event
 * vocabulary onto the EXISTING chatSlice reducers so no reducer needs to change.
 * It NEVER dispatches and NEVER throws. Operation-specific concerns (the
 * optimistic-message clear, terminal messageId capture, error rethrow) are owned
 * by runServerChatLoop, which knows the operation.
 *
 * The renderer and the electron headless server are separate TS projects, so the
 * server's HeadlessStreamEvent union is mirrored loosely here rather than imported
 * across the boundary. Keep this in sync with
 * electron/headlessServer/contracts/headlessApi.ts.
 */

import { chatSliceActions } from './chatSlice'
import type { Message } from './chatTypes'

/** Loose mirror of the server's HeadlessStreamEvent union. */
export interface ServerStreamEvent {
  type: string
  [key: string]: any
}

export interface ProjectionContext {
  streamId: string
  conversationId: string
}

/** A dispatch-ready RTK action ({ type, payload }). */
export type ProjectedAction = { type: string; payload?: unknown }

function parseMaybeJson<T>(value: any, fallback: T): T {
  if (value === null || value === undefined) return fallback
  if (typeof value !== 'string') return value as T
  if (value === 'null') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/**
 * Normalize a raw server (SQLite) message row into the renderer `Message` shape.
 * Server rows carry tool_calls/content_blocks/children_ids as JSON strings and
 * lack renderer-only fields (artifacts/pastedContext/partial), so consumers that
 * do Array.isArray(...) checks (e.g. the complete-chunk tool detection) need this.
 */
export function normalizeServerMessage(row: any): Message {
  if (!row || typeof row !== 'object') return row as Message
  return {
    ...row,
    children_ids: parseMaybeJson<any[]>(row.children_ids, []),
    tool_calls: typeof row.tool_calls === 'string' ? parseMaybeJson<any>(row.tool_calls, null) : (row.tool_calls ?? null),
    content_blocks:
      typeof row.content_blocks === 'string' ? parseMaybeJson<any>(row.content_blocks, null) : (row.content_blocks ?? null),
    artifacts: Array.isArray(row.artifacts) ? row.artifacts : [],
    pastedContext: Array.isArray(row.pastedContext) ? row.pastedContext : [],
    partial: row.partial ?? false,
    content_plain_text: row.content_plain_text ?? row.content,
    model_name: row.model_name ?? 'unknown',
  } as Message
}

function coerceToolCall(toolCall: any): any {
  return {
    id: toolCall?.id,
    name: toolCall?.name,
    arguments: toolCall?.arguments,
    status: toolCall?.status ?? 'executing',
    result: toolCall?.result,
  }
}

function coerceToolResult(toolResult: any): any {
  return {
    tool_use_id: toolResult?.tool_use_id,
    content: toolResult?.content,
    is_error: !!toolResult?.is_error,
  }
}

/**
 * Map a single server SSE event to zero or more Redux actions (in dispatch order).
 * See the Phase 1 projection table. Terminal `complete` emits `streamCompleted`
 * here; the error chunk for `error` is intentionally NOT emitted here (owned by
 * runServerChatLoop + the thunk catch to preserve the load-bearing
 * sendingCompleted-before-error ordering).
 */
export function projectServerEvent(event: ServerStreamEvent, ctx: ProjectionContext): ProjectedAction[] {
  const { streamId } = ctx
  switch (event.type) {
    case 'started': {
      const parentId = event.parentId ?? null
      if (!parentId) return []
      return [
        chatSliceActions.streamLineageUpdated({
          streamId,
          rootMessageId: parentId,
          branchAnchorMessageId: parentId,
          currentBranchAnchorMessageId: parentId,
        }),
      ]
    }

    case 'user_message_persisted': {
      const message = normalizeServerMessage(event.message)
      return [
        chatSliceActions.messageAdded(message),
        chatSliceActions.messageBranchCreated({ newMessage: message }),
        chatSliceActions.streamLineageUpdated({
          streamId,
          originMessageId: message.id,
          branchAnchorMessageId: message.id,
          triggerUserMessageId: message.id,
          currentBranchAnchorMessageId: message.id,
        }),
      ]
    }

    case 'tool_loop': {
      // Synthesize the per-turn boundary the server does not send: clear the live
      // buffers so turn N+1 text does not append onto turn N (keeps active=true).
      if (event.status === 'turn_started') {
        return [chatSliceActions.streamChunkReceived({ streamId, chunk: { type: 'generation_started', messageId: null } })]
      }
      return []
    }

    case 'chunk': {
      const part = event.part
      if (part === 'text' || part === 'reasoning') {
        return [chatSliceActions.streamChunkReceived({ streamId, chunk: { type: 'chunk', part, delta: event.delta } })]
      }
      if (part === 'image') {
        return [
          chatSliceActions.streamChunkReceived({
            streamId,
            chunk: { type: 'chunk', part: 'image', url: event.url, mimeType: event.mimeType },
          }),
        ]
      }
      if (part === 'tool_call') {
        return [
          chatSliceActions.streamChunkReceived({
            streamId,
            chunk: { type: 'chunk', part: 'tool_call', toolCall: coerceToolCall(event.toolCall) },
          }),
        ]
      }
      if (part === 'tool_result') {
        return [
          chatSliceActions.streamChunkReceived({
            streamId,
            chunk: { type: 'chunk', part: 'tool_result', toolResult: coerceToolResult(event.toolResult) },
          }),
        ]
      }
      return []
    }

    case 'assistant_message_persisted': {
      // Per-turn: persist the assistant row and close the turn with a complete-CHUNK
      // (NOT streamCompleted — that keeps active=true for multi-turn loops).
      const message = normalizeServerMessage(event.message)
      return [
        chatSliceActions.messageAdded(message),
        chatSliceActions.messageBranchCreated({ newMessage: message }),
        chatSliceActions.streamChunkReceived({ streamId, chunk: { type: 'complete', message } }),
      ]
    }

    case 'complete': {
      // Terminal (once per run): persist final message and finalize the stream.
      const message = normalizeServerMessage(event.message)
      return [
        chatSliceActions.messageAdded(message),
        chatSliceActions.messageBranchCreated({ newMessage: message }),
        chatSliceActions.streamCompleted({ streamId, messageId: message.id, updatePath: true }),
      ]
    }

    case 'error': {
      // Persist any partial assistant row; the error CHUNK is emitted by the
      // thunk catch (after sendingCompleted), not here.
      if (event.assistantMessage) {
        return [chatSliceActions.messageAdded(normalizeServerMessage(event.assistantMessage))]
      }
      return []
    }

    case 'permission_required': {
      // Carry streamId + toolCallId so the resolver thunk can POST /resume (Phase 2).
      return [
        chatSliceActions.toolPermissionRequested({
          toolCall: { id: event.toolCallId, name: event.toolName, arguments: event.toolInput, status: 'pending' } as any,
          streamId,
          toolCallId: event.toolCallId,
        }),
      ]
    }

    case 'operation_mode_upgrade_required': {
      return [
        chatSliceActions.operationModeUpgradeRequested({
          toolCall: { id: event.toolCallId, name: event.toolName, arguments: event.toolInput, status: 'pending' } as any,
          streamId,
          toolCallId: event.toolCallId,
        }),
      ]
    }

    case 'clarify_required': {
      return [
        chatSliceActions.planClarificationRequested({
          id: event.toolCallId,
          questions: event.questions,
          streamId,
          toolCallId: event.toolCallId,
        } as any),
      ]
    }

    case 'free_generations_update': {
      return [
        chatSliceActions.freeGenerationsUpdated({ remaining: event.remaining, isFreeTier: event.isFreeTier ?? true }),
      ]
    }

    case 'generation_limit_reached': {
      return [chatSliceActions.freeTierLimitModalShown()]
    }

    case 'context_compaction': {
      // The server persists an automatic summary outside the ordinary assistant-message
      // stream. Project its completed marker so the active branch and context meter
      // immediately share the same replay boundary as the server.
      if (event.status !== 'completed' || !event.summaryMessage) return []
      const message = normalizeServerMessage(event.summaryMessage)
      return [
        chatSliceActions.messageAdded(message),
        chatSliceActions.messageBranchCreated({ newMessage: message }),
        chatSliceActions.streamLineageUpdated({
          streamId,
          branchAnchorMessageId: message.id,
          currentBranchAnchorMessageId: message.id,
        }),
      ]
    }

    // provider_routed, context_usage, tool_execution, tool_request: no-ops in Phase 1.
    default:
      return []
  }
}
