/**
 * SSE -> Redux projection for the server-owned chat loop.
 *
 * Phase 0 SKELETON. `projectServerEvent` is a PURE function: given one server
 * SSE event it returns the list of Redux actions to dispatch, mapping the
 * server event vocabulary onto the EXISTING `streamChunkReceived` chunk shapes
 * (plus messageAdded / messageBranchCreated / streamCompleted and the
 * permission/clarify dialog reducers) so no reducer needs to change.
 *
 * The full mapping table is implemented in Phase 1. Kept pure + inert here so it
 * is unit-testable in isolation and imported by nothing yet.
 *
 * NOTE: the renderer and the electron headless server are separate TS projects,
 * so the server's HeadlessStreamEvent type is mirrored loosely here rather than
 * imported across the boundary.
 */

/** Loose mirror of the server's HeadlessStreamEvent union (see contracts/headlessApi.ts). */
export interface ServerStreamEvent {
  type: string
  [key: string]: any
}

export interface ProjectionContext {
  streamId: string
  conversationId: string
}

/** A dispatch-ready action descriptor: { type, payload } as produced by RTK slice actions. */
export interface ProjectedAction {
  type: string
  payload?: unknown
}

/**
 * Map a single server SSE event to zero or more Redux actions.
 * Phase 1 fills in the full mapping table; today it is a no-op passthrough.
 */
export function projectServerEvent(_event: ServerStreamEvent, _ctx: ProjectionContext): ProjectedAction[] {
  // TODO(Phase 1): implement the full event -> action mapping:
  //   started -> generation_started; user_message_persisted -> messageAdded +
  //   messageBranchCreated + streamLineageUpdated; chunk:* -> streamChunkReceived;
  //   assistant_message_persisted -> messageAdded + complete(per-turn);
  //   complete -> streamCompleted; error -> streamChunkReceived(error);
  //   permission_required -> toolPermissionRequested; clarify_required ->
  //   planClarificationRequested; free_generations_update / generation_limit_reached.
  return []
}
