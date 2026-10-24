---
paths:
  - "client/ygg-chat-r/src/features/chats/chatSlice.ts"
  - "client/ygg-chat-r/src/features/chats/chatSelectors.ts"
  - "client/ygg-chat-r/src/features/chats/stream*.ts"
  - "client/ygg-chat-r/src/features/chats/inflightStreams.ts"
  - "client/ygg-chat-r/src/features/chats/mainChatClient.ts"
  - "client/ygg-chat-r/src/features/chats/sseProjection.ts"
---

# Agent Context: Chat Streaming State

Last reviewed: 2026-08-01

## Purpose

Explains Redux multi-stream state, branch-aware stream selection, and how streaming
events become visible in the chat UI. Since the headless-agent-loop migration the
main chat loop runs in the local headless server (`http://127.0.0.1:3002`, inside the
Electron main process); the renderer is a thin client that **projects** server SSE
events onto the pre-existing Redux `streamChunk` vocabulary. The projection reuses the Redux stream vocabulary; current state also includes
compaction, durable errors, stream-keyed decisions, mode changes, and queued inputs.

## When to Open This File

Use this when changing:
- `streaming.activeIds`, `streaming.byId`, `primaryStreamId`, or `lastCompletedId`;
- stream reducers such as start/chunk/complete/abort;
- branch-aware loading state;
- the SSE-event → Redux-action projection (`sseProjection.ts`);
- visible stream selection in `Chat.tsx`.

## Key Files

### Redux state + selectors
- `client/ygg-chat-r/src/features/chats/chat-streaming-redux-context.md`: focused existing context doc.
- `client/ygg-chat-r/src/features/chats/chatSlice.ts`: stream state shape and reducers (`streaming` init at :183; `streamChunkReceived` :468, `streamCompleted` :667, `streamLineageUpdated` :745, `sendingStarted` :342).
- `client/ygg-chat-r/src/features/chats/chatSelectors.ts`: current view / current branch stream selectors.
- `client/ygg-chat-r/src/features/chats/streamHelpers.ts`: stream utility functions (`createEmptyStreamState`, `DEFAULT_STREAM_ID`).
- `client/ygg-chat-r/src/features/chats/streamResilience.ts`: stream resilience helpers.
- `client/ygg-chat-r/src/containers/Chat.tsx`: consumes stream selectors; sets/clears the optimistic user bubble.

### Data source: server SSE → Redux projection (thin client)
- `client/ygg-chat-r/src/features/chats/chatActions.ts`: the chat thunks build requests for the local server and drive projection. `sendMessage`, `editMessageWithBranching`, and `sendMessageToBranch` use the SSE loop routes; `compactBranch` uses the persisted compact route. They own no loop, tool execution, or permission/hook/compaction generation.
- `client/ygg-chat-r/src/features/chats/buildServerLoopRequest.ts`: `buildServerLoopRequest` — assembles the POST body (`systemPrompt` deliberately omitted; the server assembles it).
- `client/ygg-chat-r/src/features/chats/mainChatClient.ts`: `runServerChatLoop` — the SSE reader (`fetch` POST + `res.body.getReader()`, no `EventSource`); dispatches each event through the projection and captures return ids.
- `client/ygg-chat-r/src/features/chats/sseProjection.ts`: `projectServerEvent` (pure; returns ordered RTK actions, never dispatches/throws) and `normalizeServerMessage`. Server SSE members map onto the existing `streamChunkReceived` / `streamCompleted` / `streamLineageUpdated` / `messageAdded` / `messageBranchCreated` reducers plus dedicated compaction/error/decision/mode/queue reducers.
- Server SSE contract: `shared/headlessApi.ts` (`HeadlessStreamEvent` union). SSE routes: `client/ygg-chat-r/server/headlessServer/routes/chatRoutes.ts`; loop: `client/ygg-chat-r/server/headlessServer/services/chatOrchestrator.ts`.

### Durable stream-run lifecycle rows (`streaming_runs` SQLite table)
- `client/ygg-chat-r/server/headlessServer/persistence/streamingRunRepo.ts`: `StreamingRunRepo` — the **in-loop authority**. `ChatOrchestrator.runMessage` calls `upsert` (`chatOrchestrator.ts:344`, `source:'headless'`, `streamType` primary/branch) and `finish` (terminal status + `duration_ms`, `chatOrchestrator.ts:481/501/514/522`).
- `client/ygg-chat-r/src/features/chats/streamRunTracking.ts`: renderer best-effort helper — `createStreamingRun`/`finishStreamingRun` POST/PATCH `/api/streaming/runs` (`source:'renderer'`), still fired from the 3 thunks and `abortGeneration`. Both writers key on the same `streamId`.
- `client/ygg-chat-r/server/routes/runStateRoutes.ts`: `/api/streaming/runs` POST/PATCH/GET used by renderer tracking; mounted by `server/localServer.ts`.
- `client/ygg-chat-r/server/tools/streamUndoManager.ts`: durable per-stream file-edit undo manifests/backups.

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
  Its byte-activity watchdog reads `streamIdleTimeoutMs` from
  `helpers/toolExecutionSettings.ts` for each reader. The default is 120 seconds and the
  Electron Settings page allows 45–600 seconds; 15-second heartbeat comments reset it.
- `client/ygg-chat-r/src/features/chats/inflightStreams.ts`: a `localStorage`-backed record
  of runs started-but-not-finished (survives a reload). Added on send/branch/edit start;
  removed in the thunk `finally` — a reload kills the thunk first, leaving the marker.
- `resumeInFlightStreams` thunk (`chatActions.ts`): dispatched from the actual `Chat`
  route load. It skips streams with an existing module-level reader, rebuilds only orphaned
  stream slots, and resumes from each marker's persisted `lastSeq`; `410`/terminal replay
  clears the marker. Per-stream ownership allows later runs in the same conversation.
- **Stop** awaits `postStreamAbort` before closing local readers. Failed abort requests
  retain markers for reconciliation. App quit still kills all in-memory server sessions.

## Parallel Pane Projection

The desktop parallel pane reuses canonical `conversation.messages` and `streaming.byId`, but all view/transient state remains pane-owned. It must not use singleton `selectCurrentViewStream` or mutate the primary `conversation.currentPath`.

- `selectCurrentViewStreamFor(streaming, { conversationId, lineageId, path })` and `selectDisplayMessagesFor(messages, path)` accept explicit pane identity.
- `SendMessagePayload` supports explicit `streamType` and `updatePath`. Existing sends default to `streamType:'primary'` and `updatePath:true`; parallel continuations pass `streamType:'branch'` and `updatePath:false`.
- `sendMessage` applies the terminal path policy at the SSE projection dispatch boundary with `applyStreamProjectionPolicy`. The wire event remains unchanged and the base `projectServerEvent` remains backward-compatible.
- Resumable inflight records persist `updatePath`; reattach reapplies the same policy so a reloaded parallel run cannot advance the primary path.
- The parallel controller advances its own path from server-persisted user/final IDs through `ChatPane/paneState.ts`.
- Per-stream permission, operation-mode-upgrade, and clarification maps are the decision authority for each pane. Durable errors remain canonical and are projected into a pane by stream, lineage, or branch parent.

## Important Invariants

- UI should render the stream relevant to the current branch/view, not any globally active stream.
- Branch and subagent streams must not clobber the primary stream state accidentally.
- Stream events should be append-only enough for replay/rendering of text, reasoning, tool calls, and tool results.
- Abort/error paths must clear loading state without losing persisted messages that already completed.
- Lineage/path anchors must be derived from server `*_persisted` ids (see above), not from optimistic client ids.
- The projection (`projectServerEvent`) is pure and must not dispatch or throw; ordering of the emitted actions is load-bearing (e.g. the `error` chunk is emitted by the thunk catch after `sendingCompleted`, not by the projection).

## Gotchas

- Old code may still assume `DEFAULT_STREAM_ID`; preserve compatibility while preferring explicit stream IDs in new code.
- The optimistic user bubble is set by `Chat.tsx` and cleared by `runServerChatLoop` on `user_message_persisted` (send/edit); branch has no bubble. Pending stream fallbacks in `Chat.tsx` are scoped to conversation and the selection's fallback ownership revision. They remain eligible through message materialization and same-view refocus, but become ineligible after a different view is selected. Pending/failed navigation does not expose another branch's stream controls or decisions.
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

## Per-run transcript statistics

Desktop primary and parallel transcripts derive one display-only footer per terminal main run.
`useConversationRunStatistics` reads the conversation streaming-run endpoint through Query;
terminal Redux events trigger a coalesced, bounded refresh. Intermediate persisted assistant
messages and transport disconnects do not finalize statistics.

- Headless lifecycle is authoritative. Compatibility renderer POST/PATCH tracking cannot replace
  server-owned rows; main chat thunks no longer write duplicate lifecycle timestamps.
- Main sinks stamp `meta.runStatistics` with stream ID, version, and model-response/error kind.
  Terminal metadata includes response count; cancelled runs retain separate assistant and
  structural endpoints. Cloud tree reads enrich messages with locally recorded provenance.
- Tool counts include all invocation rows for that run ID, including wrappers/nested attempts,
  but never separate subagent streams. Historical missing recording is not treated as zero.
- Default tokens are a `tokenx` estimate of raw payload in the bounded run slice: user input,
  assistant/reasoning, and tool arguments/results counted once. Mirrored legacy fields,
  usage blocks, setup notices, compaction summaries, and inherited history are excluded.
  The footer shows `~6K ↑ · ~2K ↓`: input (↑) is user text plus tool results; output (↓)
  is assistant/reasoning plus generated tool names/arguments. A `~` marks estimates;
  unknown slice boundaries remain unavailable. Provider-reported cumulative request
  usage is separate hover detail, never the default token count.
- Hover/focus slides the footer right-to-left slowly to reveal cumulative request usage,
  without a per-role token breakdown. The single-line height remains stable; reduced motion disables sliding.
- Footer eligibility uses the pane's canonical path. Process grouping stops at footer boundaries;
  footers stay outside collapsed disclosures and use stable stream-ID virtual row keys.
- No statistics row enters inference history, persistence, compaction, or branch navigation.

## Primary selection ownership

`chatSelection.ts` / `chatSelectionController.ts` own explicit view-selection transactions. `ChatSelectionProvider` is the router facade used by primary navigation callers. Navigation never aborts runs or clears stream buffers/decision maps. Chat derives animations, live output, Stop/Queue and decisions from one effective view stream; no stream means no singleton decision fallback.

`SendingStartedPayload.selectionRevision` captures the renderer request revision before async preparation. Stream path advancement is gated by view ownership; projected `messageBranchCreated` includes stream identity, and parallel `updatePath:false` applies to first-user/turn insertion as well as terminal completion. Reattach does not claim a new view merely by rebuilding a stream slot. Confirmed mismatched lineages are excluded from anchor-based stream selection.

## Passive observer transcript following

Discovered/reloaded main runs use `followSelectedTip` separately from `updatePath`/selection ownership. `followSelectedTip.ts` permits only adjacent persisted rows on the currently selected conversation/lineage, with complete same-conversation ancestry and cycle checks; empty/pending/error views fail closed. `chatSlice` applies it to turn insertion, queue/mode rows and completion and preserves it through bootstrap. Explicit parallel `updatePath:false` slots without this flag never advance the primary path. This prevents per-generation transient resets from hiding all prior persisted tools on an observer while keeping the composer anchor consistent with the visible transcript. The agent pill's retained preview projection remains unchanged. Tests: `followSelectedTip.test.ts`, plus real two-browser reload/three-turn/expanded-history coverage in `scripts/test-browser-workspace.cjs`.

## Post-compaction durable tail

`context_injection_persisted` and `compaction_control_persisted` advance the selected head through guarded `queuedMessageInserted`, without replacing the original trigger user message. Manual compaction can return `complete.message = summary` after persisting restored context below it. `streamContinuationTail.ts` prevents completion/replayed summary upserts from rewinding that selected context/control/settings tail. Otherwise the next ordinary admission sends the summary as a stale parent and rejects until reload. Regression: `compactionBranchHead.test.ts` and `scripts/test-browser-workspace.cjs` (manual `/compact`, restored context, immediate follow-up, no refresh). Parallel ownership and passive observer adjacency guards remain unchanged.

## Compact reconnect selection recovery

Main bootstrap events are a compact current-turn projection, not a full persisted turn journal. `mainChatClient` gates selection through `streamBootstrapReset`, hydrates exact persisted rows and projects the compact events, then calls `streamBootstrapReconciled`. Recovery advances monotonically through validated descendants of the selected tip, including missing offline turns; it never rewinds to replayed user/summary ancestors or claims sibling/parallel/empty observer views. Terminal restored-context tails also update durable stream anchors. Ordinary live observer following remains adjacent-only; watch continuation retains its separate ancestry policy. Regression: `mainChatClient.test.ts`, `followSelectedTip.test.ts`, real-projector forced-disconnect coverage in `scripts/test-browser-workspace.cjs`.

## Rejoin after replay eviction

An initial reattach 410 no longer implies failure. `reattachRunOutcome.ts` consults the existing exact `/streaming/runs/:id` host ledger and requires matching stream/conversation plus `source=headless`. Completed runs and explicit Stop are reconciled quietly; error/host-restart-aborted outcomes retain interruption notices, while absent/untrusted/unreadable/running records remain uncertain. `resumeInFlightStreams` retires only that marker, clears only its old run_expired notice, skips the expired queue request and emits targeted HOST_DATA_CHANGED for the existing visit-fenced snapshot refresh. It does not synthesize message/path advancement or touch another live run/draft. Active-reader midstream resubscribe failures remain conservative. Tests: `reattachRunOutcome.test.ts`, `mainChatClient.test.ts`, resume wiring in `watchContinuationSelection.test.ts`.
