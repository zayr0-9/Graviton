/**
 * mainChatClient — the renderer thin client for the server-owned chat loop.
 *
 * Phase 0 SKELETON. Wired in Phase 1. This will adapt the proven subagentClient
 * SSE reader (data:-line parse, 60s idle watchdog, abort registry, isStreamActive
 * gate) but, unlike subagentClient (which discards structural events), it will
 * project EVERY server event via sseProjection.projectServerEvent and dispatch
 * the results, and own the client end of the Phase 2 pause/resume (POST /resume).
 *
 * Inert until Phase 1: nothing imports runServerChatLoop yet, and the delegation
 * shim in the three chatActions thunks is added behind isServerOwnedChatLoopEnabled().
 */

export type ServerLoopOperation = 'send' | 'edit' | 'branch'

export interface RunServerChatLoopParams {
  operation: ServerLoopOperation
  conversationId: string
  streamId: string
  /** send: parent + content; edit: originalMessageId + newContent; branch: parentId + content. */
  request: Record<string, unknown>
}

/** Thunk-style deps injected from the calling chatActions thunk (dispatch/getState). */
export interface RunServerChatLoopDeps {
  dispatch: (action: unknown) => unknown
  getState: () => unknown
}

/**
 * Drive one server-owned chat run over SSE, projecting events into Redux.
 * Phase 1 implements the fetch + reader + projection loop.
 */
export async function runServerChatLoop(
  _params: RunServerChatLoopParams,
  _deps: RunServerChatLoopDeps
): Promise<void> {
  throw new Error('runServerChatLoop is not implemented until Phase 1 (non-interactive thin-client slice).')
}
