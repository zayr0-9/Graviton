# Agent Context: Chat Streaming State

Last reviewed: 2026-08-01

## Purpose

Explains Redux multi-stream state, branch-aware stream selection, and how streaming
events become visible in the chat UI. Since the headless-agent-loop migration the
main chat loop runs in the local headless server (`http://127.0.0.1:3002`, inside the
Electron main process); the renderer is a thin client that **projects** server SSE
events onto the pre-existing Redux `streamChunk` vocabulary. The stream reducers and
state shape below are unchanged by that migration — only the data source changed.

## When to Open This File

Use this when changing:
- `streaming.activeIds`, `streaming.byId`, `primaryStreamId`, or `lastCompletedId`;
- stream reducers such as start/chunk/complete/abort;
- branch-aware loading state;
- the SSE-event → Redux-action projection (`sseProjection.ts`);
- visible stream selection in `Chat.tsx`.

## Key Files

### Redux state + selectors (unchanged by the migration)
- `client/ygg-chat-r/src/features/chats/chat-streaming-redux-context.md`: focused existing context doc.
- `client/ygg-chat-r/src/features/chats/chatSlice.ts`: stream state shape and reducers (`streaming` init at :183; `streamChunkReceived` :468, `streamCompleted` :667, `streamLineageUpdated` :745, `sendingStarted` :342).
- `client/ygg-chat-r/src/features/chats/chatSelectors.ts`: current view / current branch stream selectors.
- `client/ygg-chat-r/src/features/chats/streamHelpers.ts`: stream utility functions (`createEmptyStreamState`, `DEFAULT_STREAM_ID`).
- `client/ygg-chat-r/src/features/chats/streamResilience.ts`: stream resilience helpers.
- `client/ygg-chat-r/src/containers/Chat.tsx`: consumes stream selectors; sets/clears the optimistic user bubble.

### Data source: server SSE → Redux projection (thin client)
- `client/ygg-chat-r/src/features/chats/chatActions.ts`: the 3 chat thunks (`sendMessage`, `editMessageWithBranching`, `sendMessageToBranch`) build a request via `buildServerLoopRequest`, POST it to the server SSE routes on `:3002`, and drive projection. They own no loop, tool execution, or permission/hook/compaction orchestration, and **throw outside Electron**. (The manual-compaction `compactBranch` thunk is the one surviving renderer-side generation path.)
- `client/ygg-chat-r/src/features/chats/buildServerLoopRequest.ts`: `buildServerLoopRequest` — assembles the POST body (`systemPrompt` deliberately omitted; the server assembles it).
- `client/ygg-chat-r/src/features/chats/mainChatClient.ts`: `runServerChatLoop` — the SSE reader (`fetch` POST + `res.body.getReader()`, no `EventSource`); dispatches each event through the projection and captures return ids.
- `client/ygg-chat-r/src/features/chats/sseProjection.ts`: `projectServerEvent` (pure; returns ordered RTK actions, never dispatches/throws) and `normalizeServerMessage`. Server SSE members map onto the existing `streamChunkReceived` / `streamCompleted` / `streamLineageUpdated` / `messageAdded` / `messageBranchCreated` reducers — no reducer changes.
- Server SSE contract: `client/ygg-chat-r/electron/headlessServer/contracts/headlessApi.ts` (`HeadlessStreamEvent` union). SSE routes: `client/ygg-chat-r/electron/headlessServer/routes/chatRoutes.ts`; loop: `client/ygg-chat-r/electron/headlessServer/services/chatOrchestrator.ts`.

### Durable stream-run lifecycle rows (`streaming_runs` SQLite table)
- `client/ygg-chat-r/electron/headlessServer/persistence/streamingRunRepo.ts`: `StreamingRunRepo` — the **in-loop authority**. `ChatOrchestrator.runMessage` calls `upsert` (`chatOrchestrator.ts:344`, `source:'headless'`, `streamType` primary/branch) and `finish` (terminal status + `duration_ms`, `chatOrchestrator.ts:481/501/514/522`).
- `client/ygg-chat-r/src/features/chats/streamRunTracking.ts`: renderer best-effort helper — `createStreamingRun`/`finishStreamingRun` POST/PATCH `/api/streaming/runs` (`source:'renderer'`), still fired from the 3 thunks and `abortGeneration`. Both writers key on the same `streamId`.
- `client/ygg-chat-r/electron/localServer.ts`: the `/api/streaming/runs` HTTP routes the renderer helper hits (`POST` :3563, `PATCH` :3623, `GET` :3666).
- `client/ygg-chat-r/electron/tools/streamUndoManager.ts`: durable per-stream file-edit undo manifests/backups.

## Mental Model

Streaming state is not a single global boolean. It is a container:

- `activeIds`: stream IDs currently active.
- `byId`: map from stream ID to stream state.
- `primaryStreamId`: main stream for current operation.
- `lastCompletedId`: last stream that reached completion.

Each stream has buffers/events/tool calls plus lineage metadata that lets the UI
associate it with a conversation/branch.

**Where events come from.** The renderer no longer generates stream chunks itself.
For the main chat loop, tokens/tool-calls/results arrive as server SSE events from
`:3002` and `projectServerEvent` translates each into the existing Redux
`streamChunk` actions. `runServerChatLoop` is the reader; the reducers it feeds are
identical to the pre-migration ones. Subagent/tool streams continue to flow through
their own paths.

**Path / branch anchors come from server ids.** Lineage anchors are seeded from the
server's persisted SQLite ids, not optimistic client ids: `started.parentId` seeds
the root/branch anchors; `user_message_persisted.message.id` becomes the origin /
trigger / current-branch anchor and clears the optimistic user bubble;
`complete.message.id` drives `streamCompleted{updatePath:true}`, so the renderer's
current path is rebuilt from server ids.

**Durable lifecycle rows.** Individual stream-run lifecycle is mirrored to the
SQLite `streaming_runs` table. The server `StreamingRunRepo` is now the authoritative
in-loop author (`source:'headless'`, written directly via prepared statements);
the renderer `streamRunTracking` helper still writes best-effort rows over
`/api/streaming/runs` (`source:'renderer'`) keyed on the same `streamId`. Redux
remains the live rendering state and can be pruned; `streaming_runs.status`,
`ended_at`, `end_reason`, and `duration_ms` are the durable record of when a stream
ended.

**Detach / reattach (resumable runs — `isResumableRunsEnabled()`, default ON in
Electron).** A dropped SSE connection or Chat route unmount no longer ends the run: the
server keeps it alive (see
`agent_headless_server.md` §Detach/Reattach) and the renderer re-attaches by `streamId`.
- `client/ygg-chat-r/src/features/chats/mainChatClient.ts`: on a non-terminal, non-cancel
  drop, `runServerChatLoop` resubscribes via `GET /api/streams/:id?fromSeq=<last applied
  seq>` (the `seq` cursor keeps append-style chunk projection idempotent); `postStreamAbort`
  cancels via `POST /api/streams/:id/abort`; `runServerReattach` is the reattach reader.
- `client/ygg-chat-r/src/features/chats/inflightStreams.ts`: a `localStorage`-backed record
  of runs started-but-not-finished (survives a reload). Added on send/branch/edit start;
  removed in the thunk `finally` — a reload kills the thunk first, leaving the marker.
- `resumeInFlightStreams` thunk (`chatActions.ts`): dispatched from the actual `Chat`
  route load. It skips streams with an existing module-level reader, rebuilds only orphaned
  stream slots, and resumes from each marker's persisted `lastSeq`; `410`/terminal replay
  clears the marker. Per-stream ownership allows later runs in the same conversation.
- **Stop** awaits `postStreamAbort` before closing local readers. Failed abort requests
  retain markers for reconciliation. App quit still kills all in-memory server sessions.

## Important Invariants

- UI should render the stream relevant to the current branch/view, not any globally active stream.
- Branch and subagent streams must not clobber the primary stream state accidentally.
- Stream events should be append-only enough for replay/rendering of text, reasoning, tool calls, and tool results.
- Abort/error paths must clear loading state without losing persisted messages that already completed.
- Lineage/path anchors must be derived from server `*_persisted` ids (see above), not from optimistic client ids.
- The projection (`projectServerEvent`) is pure and must not dispatch or throw; ordering of the emitted actions is load-bearing (e.g. the `error` chunk is emitted by the thunk catch after `sendingCompleted`, not by the projection).

## Gotchas

- Old code may still assume `DEFAULT_STREAM_ID`; preserve compatibility while preferring explicit stream IDs in new code.
- The optimistic user bubble is set by `Chat.tsx` and cleared by `runServerChatLoop` on `user_message_persisted` (send/edit); branch has no bubble. Pending stream fallbacks in `Chat.tsx` are deliberately short-lived to avoid flicker during message materialization.
- Multi-turn: `assistant_message_persisted` projects a complete-CHUNK (not `streamCompleted`) so `active` stays true; only the terminal `complete` sets `streamCompleted`. A `tool_loop` `turn_started` event synthesizes a per-turn boundary so turn N+1 text does not append to turn N.
- Tool-result events and persisted tool messages are related but not identical; update both paths deliberately.
- Stream Redux state is pruned; durable file-edit undo state lives under Electron app user-data `.ygg/backups/<stream>/`, keyed by `streamId` and parent user message ID.
- Durable stream lifecycle rows are best-effort; a failed `streaming_runs` write (renderer or server) must not interrupt generation.
- Terminal projection records a renderer reconciliation lease before normal stream pruning. The lease protects only explicit final/live/lineage rows and remains until an accepted persisted snapshot contains them; route entry/manual refresh retries failed reconciliation.

## Testing and Validation

- Typecheck the renderer: `npx tsc -p tsconfig.app.json --noEmit` (Electron-only; web mode is not a target).
- Projection unit tests: `client/ygg-chat-r/src/features/chats/sseProjection.test.ts` and `buildServerLoopRequest.test.ts`; detach/reattach: `mainChatClient.test.ts` + `inflightStreams.test.ts`.
- Manually verify (Electron): normal stream, branch stream, subagent/tool stream, permission/clarify pause+resume, cancellation, and post-completion display.

## Related Docs

- `agent_chat_pipeline.md`
