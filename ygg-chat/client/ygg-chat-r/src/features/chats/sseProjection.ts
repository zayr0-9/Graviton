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
 * The event union is IMPORTED from the shared wire contract, not mirrored here.
 * Adding a server event type therefore surfaces as an unhandled `switch` case
 * rather than as a silent runtime no-op.
 *
 * FAILURE DATA IS NEVER DISCARDED. Every frame that carries a classified failure
 * (`error`, `reauth_required`, `generation_limit_reached`, a badged `complete`) or
 * an explained silence (`notice`, a failed `tool_execution`) projects something.
 * The two surfaces are:
 *   - an in-order `streamChunkReceived` (`type:'error'` / `type:'notice'`), which
 *     shows the failure where it happened inside the live transcript;
 *   - a durable `chatErrorRecorded`, which survives the 30s pruning of the
 *     streaming slot and anchors a bubble in the tree.
 *
 * ONE SURFACE PER EVENT. Two rules keep the count at one:
 *   - status prose is projected ONLY from an explicit `notice` frame. The server
 *     already emits one beside every `tool_loop provider_retry` /
 *     `tool_loop max_turns_reached` / `context_compaction started` frame
 *     (toolLoopService), so deriving a second notice from those frames here would
 *     say the same thing twice.
 *   - a durable `chatErrorRecorded` (tier 2) is created for an `error` frame ONLY
 *     when it carries no `persistedErrorMessageId` — that field means the server
 *     already wrote the failure into a message row (tier 1), which IS the bubble.
 * And a cancel is not a failure at all: an `error` frame whose envelope code is
 * `cancelled` projects nothing.
 *
 * IRON RULE: only `envelope.userMessage` is ever rendered. Raw server text
 * (`event.error`, `event.message`) goes to `envelope.detail`, behind a disclosure.
 */

import { chatSliceActions } from './chatSlice'
import { buildChatErrorRecord } from './localChatErrors'
import type { ContentBlock, LineageId, Message } from './chatTypes'
import {
  buildChatErrorEnvelope,
  normalizeChatErrorEnvelope,
  type ChatErrorEnvelope,
  type ChatNoticeCode,
} from '../../../../../shared/chatErrors'
import type { HeadlessStreamFrame } from '../../../../../shared/headlessApi'
import type { ConversationId, MessageId } from '../../../../../shared/types'

/**
 * One server SSE frame as the renderer receives it: a HeadlessStreamEvent plus the
 * optional `seq` cursor spliced on by the resumable path.
 */
export type ServerStreamEvent = HeadlessStreamFrame

export interface ProjectionContext {
  streamId: string
  conversationId: ConversationId
  /**
   * Anchors a durable error record in the tree when the failing frame carries no
   * message of its own (a pre-message failure: reauth, free-tier exhaustion).
   * Optional so the caller may omit it; the record then anchors at the root.
   */
  parentMessageId?: MessageId | null
  lineageId?: LineageId | null
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
 * Coerce `content_blocks` off a server row, preserving any persisted `ErrorBlock`.
 *
 * An ErrorBlock is tier 1 of the error surface — the failure the server already
 * wrote into message content. Two things must survive the round trip or the block
 * is worse than useless: a COMPLETE envelope (so the bubble has prose to render
 * even if the row predates a later code), and `excludeFromContext: true` (without
 * it the next turn replays "I couldn't reach the provider" to the model as its own
 * prior words). Both are re-asserted here rather than trusted from the row.
 */
function coerceContentBlocks(value: any): ContentBlock[] | null {
  const blocks = typeof value === 'string' ? parseMaybeJson<any>(value, null) : (value ?? null)
  if (!Array.isArray(blocks)) return blocks
  return blocks.map((block: any) => {
    if (!block || block.type !== 'error') return block
    return {
      ...block,
      type: 'error',
      index: typeof block.index === 'number' ? block.index : 0,
      envelope: normalizeChatErrorEnvelope(block.envelope, typeof block.error === 'string' ? block.error : undefined),
      excludeFromContext: true,
    }
  }) as ContentBlock[]
}

/**
 * Normalize a raw server (SQLite) message row into the renderer `Message` shape.
 * Server rows carry tool_calls/content_blocks/children_ids as JSON strings and
 * lack renderer-only fields (artifacts/pastedContext/partial), so consumers that
 * do Array.isArray(...) checks (e.g. the complete-chunk tool detection) need this.
 *
 * NULL-SAFE BY CONTRACT: a missing/malformed row returns `null`, never a throw.
 * `case 'complete'` guards on the result so a malformed terminal frame still
 * finalizes the stream — a throw here would defeat that guard and leave a spinner
 * running forever.
 */
export function normalizeServerMessage(row: any): Message {
  if (!row || typeof row !== 'object') return null as unknown as Message
  return {
    ...row,
    children_ids: parseMaybeJson<any[]>(row.children_ids, []),
    tool_calls: typeof row.tool_calls === 'string' ? parseMaybeJson<any>(row.tool_calls, null) : (row.tool_calls ?? null),
    content_blocks: coerceContentBlocks(row.content_blocks),
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
 * A non-terminal status line, in order among the streamed content ("Retrying 2 of
 * 3", "Summarising earlier turns"). Never persisted, never touches stream status.
 */
function noticeAction(
  streamId: string,
  code: ChatNoticeCode,
  message: string,
  counters: { attempt?: number; maxAttempts?: number } = {}
): ProjectedAction {
  return chatSliceActions.streamChunkReceived({
    streamId,
    chunk: {
      type: 'notice',
      code,
      message,
      ...(typeof counters.attempt === 'number' ? { attempt: counters.attempt } : {}),
      ...(typeof counters.maxAttempts === 'number' ? { maxAttempts: counters.maxAttempts } : {}),
    },
  })
}

/**
 * An in-order error event inside the live transcript. `terminal` is the contract
 * from the wire (absent === true): only a terminal one may end the run, so a
 * failure the loop recovered from stays visible without tearing the stream down.
 */
function errorChunkAction(streamId: string, envelope: ChatErrorEnvelope, terminal: boolean): ProjectedAction {
  return chatSliceActions.streamChunkReceived({
    streamId,
    chunk: { type: 'error', errorEnvelope: envelope, error: envelope.detail, terminal },
  })
}

/**
 * Strip the call to action from an envelope built for an in-loop failure.
 * A "Try again" button next to a tool error the model already recovered from
 * would resend the whole message — the one thing the user did not ask for.
 */
function withoutAction(envelope: ChatErrorEnvelope): ChatErrorEnvelope {
  const { action: _discarded, ...rest } = envelope
  return rest
}

/**
 * The durable (tier 2) record for a failure that arrived over SSE. It outlives the
 * streaming slot, which is pruned 30s after a run and is unreachable once it
 * carries an error, so this is the only surface a user can still act on later.
 */
function recordAction(
  envelope: ChatErrorEnvelope,
  ctx: ProjectionContext,
  anchor: { parentMessageId?: MessageId | null; lineageId?: LineageId | null } = {}
): ProjectedAction {
  return chatSliceActions.chatErrorRecorded(
    buildChatErrorRecord(envelope, {
      conversationId: ctx.conversationId,
      parentMessageId: anchor.parentMessageId ?? ctx.parentMessageId ?? null,
      streamId: ctx.streamId,
      lineageId: anchor.lineageId ?? ctx.lineageId ?? null,
    })
  )
}

/**
 * Map a single server SSE event to zero or more Redux actions (in dispatch order).
 * See the Phase 1 projection table. Terminal `complete` emits `streamCompleted`
 * here; the terminal error CHUNK for `error` is intentionally NOT emitted here
 * (owned by runServerChatLoop + the thunk catch to preserve the load-bearing
 * sendingCompleted-before-error ordering). What IS emitted here for `error` is the
 * durable record — not ordering sensitive, and previously dropped on the floor.
 */
export function projectServerEvent(event: ServerStreamEvent, ctx: ProjectionContext): ProjectedAction[] {
  const { streamId } = ctx
  switch (event.type) {
    case 'started': {
      const parentId = event.parentId ?? null
      const lineageId = event.lineageId ?? null
      if (!parentId && !lineageId) return []
      return [
        chatSliceActions.streamLineageUpdated({
          streamId,
          ...(lineageId ? { lineageId } : {}),
          ...(parentId
            ? {
                rootMessageId: parentId,
                branchAnchorMessageId: parentId,
                currentBranchAnchorMessageId: parentId,
              }
            : {}),
        } as any),
      ]
    }

    case 'user_message_persisted': {
      const message = normalizeServerMessage(event.message)
      return [
        chatSliceActions.messageAdded(message),
        chatSliceActions.messageBranchCreated({ newMessage: message }),
        chatSliceActions.streamLineageUpdated({
          streamId,
          lineageId: event.lineageId ?? (message as any).lineage_id ?? undefined,
          originMessageId: message.id,
          branchAnchorMessageId: message.id,
          triggerUserMessageId: message.id,
          currentBranchAnchorMessageId: message.id,
        } as any),
      ]
    }

    case 'tool_loop': {
      // Synthesize the per-turn boundary the server does not send: clear the live
      // buffers so turn N+1 text does not append onto turn N (keeps active=true).
      if (event.status === 'turn_started') {
        return [chatSliceActions.streamChunkReceived({ streamId, chunk: { type: 'generation_started', messageId: null } })]
      }
      // `provider_retry` and `max_turns_reached` are multi-second silences with a
      // cause, and the user is told about both — by the server, which emits an
      // explicit `notice` frame (code `retrying` / `max_turns_reached`) beside each
      // of these, carrying the prose and the attempt counters. Deriving a second
      // notice here from the same frame was the duplicate: one event, two lines.
      // The `notice` case below is now the single projection site for status prose.
      return []
    }

    case 'tool_execution': {
      // started/completed/aborted are already visible as tool_call + tool_result
      // chunks. `failed` is not: without this the toolName and the error text are
      // dropped and the transcript shows a tool that simply never returned.
      if (event.status !== 'failed') return []
      const envelope = withoutAction(
        buildChatErrorEnvelope('tool_failed', {
          userMessage: `The ${event.toolName} tool failed.`,
          detail: event.error,
        })
      )
      // Non-terminal: the loop feeds the failure back to the model and continues.
      return [errorChunkAction(streamId, envelope, false)]
    }

    case 'notice': {
      return [
        noticeAction(streamId, event.code, event.message, { attempt: event.attempt, maxAttempts: event.maxAttempts }),
      ]
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
      const lineageId = event.lineageId ?? (message as any).lineage_id ?? null
      return [
        chatSliceActions.messageAdded(message),
        chatSliceActions.messageBranchCreated({ newMessage: message }),
        ...(lineageId
          ? [chatSliceActions.streamLineageUpdated({ streamId, lineageId } as any)]
          : []),
        chatSliceActions.streamChunkReceived({ streamId, chunk: { type: 'complete', message } }),
      ]
    }

    case 'complete': {
      // Terminal (once per run): persist final message and finalize the stream.
      // A malformed frame must still finalize — a stream that never completes is a
      // spinner that never stops — so the message projection is guarded, not assumed.
      const message = normalizeServerMessage(event.message)
      const lineageId = event.lineageId ?? (message as any)?.lineage_id ?? null
      return [
        ...(message
          ? [chatSliceActions.messageAdded(message), chatSliceActions.messageBranchCreated({ newMessage: message })]
          : []),
        ...(lineageId
          ? [chatSliceActions.streamLineageUpdated({ streamId, lineageId } as any)]
          : []),
        chatSliceActions.streamCompleted({ streamId, messageId: (message as any)?.id, updatePath: true }),
        // A completion the server badged with `providerError` finished, but not
        // cleanly. Record the envelope so a degraded run is distinguishable from a
        // good one instead of looking identical to it.
        ...(event.envelope
          ? [
              recordAction(normalizeChatErrorEnvelope(event.envelope), ctx, {
                parentMessageId: (message as any)?.parent_id ?? null,
                lineageId,
              }),
            ]
          : []),
      ]
    }

    case 'error': {
      // D1 (partial text is never lost) is no longer served here: the loop persists
      // whatever the provider streamed before it failed as an ORDINARY assistant row
      // with its own `assistant_message_persisted` frame, which this projection
      // already adds AND branches onto the rendered path. `event.assistantMessage`
      // has no emitter anywhere on the server, so reading it was dead code.
      //
      // The terminal error CHUNK is still emitted by the thunk catch (after
      // sendingCompleted), not here. What may be added here is the durable record.
      const terminal = event.terminal !== false
      const envelope = normalizeChatErrorEnvelope(event.envelope, event.error)

      // R3: pressing Stop is a normal outcome. The orchestrator emits a terminal
      // `error` frame with `code:'cancelled'` on abort so a reconnecting client stops
      // hanging — but a cancel must leave nothing red behind: no in-transcript error
      // chunk, and above all no durable record (which would outlive the run and offer
      // a "Try again" for something the user deliberately stopped).
      if (envelope.code === 'cancelled') return []

      const actions: ProjectedAction[] = []

      // A non-terminal failure never reaches the thunk catch (the stream does not
      // reject), so nothing else would ever show it. Emit it here, in order, with
      // terminal:false so the reducer leaves `active`/`status` alone.
      if (!terminal) actions.push(errorChunkAction(streamId, envelope, false))

      // R2, the tier-1/tier-2 discriminator: `persistedErrorMessageId` is the id of
      // the assistant row whose content_blocks already carry this failure's
      // ErrorBlock. That row is the bubble; a record here would be a second one for
      // the same failure. Only a failure with nothing to attach to gets tier 2.
      if (!event.persistedErrorMessageId) {
        actions.push(recordAction(envelope, ctx, { lineageId: event.lineageId ?? null }))
      }
      return actions
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
      // D3: exhaustion is a chat bubble, not a blocking modal. The modal stole the
      // whole window for a message that belongs next to the send that hit the limit.
      return [recordAction(buildChatErrorEnvelope('free_tier_exhausted', { detail: event.message }), ctx)]
    }

    case 'reauth_required': {
      // D2: a bubble with "Sign in", never a forced redirect. The code and action are
      // asserted here rather than taken from the wire, so no server can turn an
      // expired session into an unrecognised envelope with no affordance.
      const supplied = event.envelope
      const envelope = buildChatErrorEnvelope('session_expired', {
        userMessage: supplied?.userMessage,
        detail: supplied?.detail ?? event.message,
        // Honour a server-supplied label, but only on the sign_in action itself.
        action: supplied?.action?.kind === 'sign_in' ? supplied.action : undefined,
        provider: supplied?.provider,
        status: supplied?.status,
      })
      return [recordAction(envelope, ctx)]
    }

    case 'context_compaction': {
      // Compaction is a multi-second, model-driven pause in the middle of a reply.
      // Silence there reads as a hang, so every status says something — but the
      // START is announced by the server's own `notice{code:'compacting'}` frame,
      // emitted beside this one. Only the COMPLETED notice below is ours (the
      // server sends none), so the pause is explained exactly once.
      if (event.status === 'started') return []
      if (event.status === 'failed') {
        // Non-terminal here: the run either recovers or fails on its own terminal
        // frame. The `compact` action on the default envelope is the real remedy.
        return [errorChunkAction(streamId, buildChatErrorEnvelope('compaction_failed', { detail: event.error }), false)]
      }
      if (event.status !== 'completed') return []

      // The server persists an automatic summary outside the ordinary assistant-message
      // stream. Project its completed marker so the active branch and context meter
      // immediately share the same replay boundary as the server.
      const actions: ProjectedAction[] = [
        noticeAction(streamId, 'compacting', 'Summarised earlier turns to make room in the context window.'),
      ]
      if (!event.summaryMessage) return actions
      const message = normalizeServerMessage(event.summaryMessage)
      actions.push(
        chatSliceActions.messageAdded(message),
        chatSliceActions.messageBranchCreated({ newMessage: message }),
        chatSliceActions.streamLineageUpdated({
          streamId,
          branchAnchorMessageId: message.id,
          currentBranchAnchorMessageId: message.id,
        })
      )
      return actions
    }

    // provider_routed, context_usage, tool_request: no-ops in Phase 1.
    default:
      return []
  }
}
