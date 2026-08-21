# Agent Context: Chat Pipeline

Last reviewed: 2026-08-01

## Purpose

Documents the primary chat **send / edit-branch / branch** generation flow after the
headless thin-client migration. The agent loop no longer runs in the React renderer.
The renderer is a **thin client** that POSTs the existing SSE routes on the local
headless Express server (`http://127.0.0.1:3002`, inside the Electron main process) and
projects the returned server SSE events onto the pre-existing Redux `streamChunk`
vocabulary. The server owns the entire loop — provider dispatch, tool execution,
permission/clarify pausing, hooks, and in-loop compaction — for **all 5 providers**
(`openrouter`, `lmstudio`, `openaichatgpt`, `zai`, `bedrock`).

This is the **same engine** that already served subagents; the new main-loop behavior is
gated on optional `ToolLoopRunInput` fields so the subagent path stays identical.

## When to Open This File

Use this when changing:
- `sendMessage`, `editMessageWithBranching`, or `sendMessageToBranch` thunks (renderer);
- the server-owned loop: `ChatOrchestrator` → `BranchOrchestrator` → `ToolLoopService`;
- provider routing / message-sink selection;
- pause/resume (tool permission, plan_md clarify) or the `/api/resume` protocol;
- server-side chat hooks or in-loop compaction;
- the SSE event contract or the SSE → Redux projection.

## Runtime Constraints

- **Electron-only.** The 3 chat thunks guard on `isElectronMode` and **throw
  `'The server-owned chat loop requires Electron.'`** on the non-Electron path
  (`chatActions.ts:1309`, `:1837`, `:2047`). There is no renderer fallback loop. Web mode is not a
  target.
- The renderer talks **only** to `:3002` (`DEFAULT_LOCAL_SERVER_ORIGIN` in
  `src/utils/api.ts`); it holds **no** loop control, tool execution, or
  permission/hook/compaction orchestration.
- **Detach/reattach (`gateway.resumableRuns` / `isResumableRunsEnabled()`, default
  ON in Electron).** A client disconnect or Chat route unmount DETACHES rather than
  aborts: the run keeps running server-side and the renderer retains its module-level
  reader or resubscribes by `streamId`; Stop cancels via `POST /api/streams/:id/abort`.
  Explicit `false` on both settings restores the legacy disconnect-abort path.
  See `agent_headless_server.md` §Detach/Reattach and `agent_chat_streaming_state.md`.
- Supplemental `systemPrompt` is deliberately **omitted** from the request body. The
  renderer forwards its selected Plan/Agent/subagent baselines plus Plan verbosity, and
  the server assembles the final prompt (`buildHeadlessSystemPrompt`) with project and
  conversation prompts. Missing baseline fields fall back to the bundled defaults.

## Key Files

### Renderer thin client (`client/ygg-chat-r/src/features/chats/`)
- `chatActions.ts` (~3,000 lines) — the 3 chat thunks: `sendMessage` (`:1104`),
  `editMessageWithBranching` (~`:1468`), `sendMessageToBranch` (~`:1865`). Also the 4
  resume resolvers and the KEPT manual-compaction `compactBranch` thunk (`:832`).
- `buildServerLoopRequest.ts` — pure builder → `{ path, body }` for the headless POST.
- `mainChatClient.ts` — `runServerChatLoop`: the SSE reader (plain `fetch` POST +
  `res.body.getReader()` + `TextDecoder`; **no** `EventSource`). Owns fetch + read +
  per-event dispatch + capturing return ids; throws on stream error / abort / no-terminal.
- `sseProjection.ts` — `projectServerEvent` (pure; server SSE event → ordered RTK actions)
  and `normalizeServerMessage` (coerce SQLite rows to the renderer `Message` shape).
- `streamRunTracking.ts` — `createStreamingRun` / `finishStreamingRun` (KEPT; live callers
  in the 3 thunks + `abortGeneration`).
- `chatSlice.ts` — chat Redux state + stream reducers (**unchanged** by the migration; the
  projection reuses the existing vocabulary).
- `chatSelectors.ts`, `chatTypes.ts` — branch/view selectors and types.

### Server chat engine (`client/ygg-chat-r/electron/headlessServer/`)
- `index.ts` — `registerHeadlessServerRoutes` (`:237`) wires the shared graph: one
  process-wide `DecisionBroker` (`:246`), the base `ToolExecutor`
  `executeToolViaOrchestrator` (`:173`), and `ChatOrchestrator` (built at `:311` with
  `toolExecutor`, `defaultToolsProvider: resolveDefaultInferenceTools`, `compactBranch`,
  `decisionBroker`, `hookRunner: runHookRequest`, `cloudChatEnabled: gatewayFlags.chat`).
- `routes/chatRoutes.ts` — 4 SSE POST routes → `runSseOrchestrator` → `orchestrator.runMessage`
  (`:219-233`), plus `POST /api/resume` (`:146`) and `POST /api/conversations/:id/compact`
  (`:174`).
- `services/chatOrchestrator.ts` — `ChatOrchestrator.runMessage` (`:288`): the top-level
  send/edit/branch driver. Builds the per-run pausing executor `createChatPausingExecutor`
  (`:95`) and a per-run `ToolLoopService`.
- `services/branchOrchestrator.ts` — `BranchOrchestrator.resolve` (`:23`): computes
  `historyLeafId` / `assistantParentId` / `userContentForInference` and persists the user
  message (all ops except `repeat`).
- `services/toolLoopService.ts` — `ToolLoopService.run` (`:626`): the actual multi-turn
  provider/tool loop for all providers.
- `services/decisionBroker.ts` — pause/resume registry (`:58`); key `${streamId}::${toolCallId}`.
- `services/chatHookService.ts` — `createChatHookSession` (`:210`): the 5 in-process chat hooks.
- `services/compactionService.ts` — `compactBranch` (`:559`) + `generateCompactionSummary`.
- `services/messageSink.ts` — `TreeMessageSink` (`:49`) / `CloudMirrorSink` (`:85`).
- `services/providerRouter.ts` — `normalizeProviderRoute` (all 5 routes; unknown → `openaichatgpt`).
- `contracts/headlessApi.ts` — the `HeadlessStreamEvent` SSE union (loosely mirrored in
  `sseProjection.ts`).

### Cloud gateway / token layer
- `routes/gatewayRoutes.ts` (`/api/gw/*`) — storage-aware CRUD/merge for
  conversations/projects/messages/attachments; collapses the old renderer dual-fetch/merge.
- `routes/cloudProxyRoutes.ts` (`/api/cloud/*`) — authenticated pass-through to Railway
  (allowlist: `/models`, `/users`, `/system-prompts`, `/stripe`, `/app-store`, `/oauth`).
- `services/railwayClient.ts` — injects the server-held Supabase JWT + relays SSE.
- `services/cloudMirrorService.ts` + `CloudMirrorSink` — server-side replacement for the
  renderer's old `dualSyncManager`.
- `services/appAuthTokenManager.ts` — the single-flight, process-wide Supabase-token
  refresher (gated by `gateway.tokenOwner` / renderer `isServerTokenOwnerEnabled`).
- `config/gatewayFlags.ts` — `resolveGatewayFlags()`.

## Data Flow (send / edit-branch / branch)

All 3 thunks share the same shape:

1. **Renderer**: dispatch `sendingStarted`, fire-and-forget `createStreamingRun`, register
   an `AbortController` (chained off the thunk `signal`), then build the request with
   `buildServerLoopRequest(op, …)` and drive it with `runServerChatLoop`.
   - `op → path`: `send → POST /conversations/{id}/messages`;
     `branch → …/messages/{messageId}/branch`;
     `edit → …/messages/{messageId}/edit-branch`.
   - Body highlights: `provider` (UI provider mapped to server slug: `google→gemini`,
     `zai/glm/z.ai→zai`, `bedrock*→bedrock`), `modelName`, `content` (raw first-turn text),
     `parentId`/`messageId`, `operationMode` + `includeOperationModePrompt`,
     `toolAutoApprove` (verbatim — undefined survives, only explicit `false` pauses),
     `hooksEnabled: isElectronMode`, `tools` (an explicit `[]` is authoritative → no tools),
     `attachmentsBase64` (turn-1 only), `streamId`, renderer-selected operation-mode
     baselines, and Plan verbosity. Supplemental `systemPrompt` remains omitted.
2. **HTTP → loop**: `chatRoutes.ts runSseOrchestrator` opens the SSE stream and, by
   default, attaches it to a `RunSession` whose `AbortController` outlives the socket.
   `res.on('close')` only detaches. Explicit `gateway.resumableRuns=false` uses the
   legacy response-owned controller and disconnect-abort behavior.
3. **`ChatOrchestrator.runMessage`** (`chatOrchestrator.ts:288`):
   - Load conversation, `touch` conversation + project.
   - Build `hookSession` iff `hookRunner && request.hooksEnabled === true && decisionBroker`.
   - Run **UserPromptSubmit** hook (before persisting the user message; `send/branch/edit-branch`
     only) — rewrites `request.content`.
   - `resolveExecution` → `BranchOrchestrator.resolve` computes lineage + persists the user
     message.
   - `streamingRunRepo.upsert` → final `trackedStreamId`.
   - `decisionBroker.initSession(trackedStreamId, { autoApproveAll: request.toolAutoApprove !== false })`
     — **default auto-approve; pauses only on explicit `false`**.
   - Emit `started`, `user_message_persisted` (if any), `provider_routed`.
   - `history = listPathToMessage(...)`;
     `resolvedTools = filterToolsForOperationMode(request.tools ?? defaultToolsProvider(), mode)`;
     `systemPrompt = buildHeadlessSystemPrompt(...)`.
   - `isCloudRoute = cloudChatEnabled && normalizeProviderRoute(provider) === 'openrouter'`.
   - Build a per-run `ToolLoopService` with sink = `CloudMirrorSink` (cloud route) else
     `TreeMessageSink`, and `executeTool = createChatPausingExecutor(...)`.
   - `loop.run(input, emit)`.
   - Terminal: `streamingRunRepo.finish('completed')` + emit `complete`;
     `ProviderErrorAssistantResponse` → `finish('error', 'provider_error')` +
     `complete { providerError: true }`; abort → `finish('aborted')`, no error frame.
     **finally:** `decisionBroker.rejectAllForStream(trackedStreamId)`.
4. **`ToolLoopService.run`** (`toolLoopService.ts:626`): the multi-turn loop. Per tool call
   it invokes the pausing executor; per turn it folds hook context into the system prompt,
   evaluates in-loop compaction at the quiescent boundary, and honors the abort signal.
5. **Renderer projection**: `runServerChatLoop` hands every SSE event to
   `projectServerEvent`, which returns ordered actions dispatched onto the unchanged
   reducers. Terminal `complete` emits `streamCompleted`; the thunk then adds
   `sendingCompleted` + delayed `streamPruned`.

`repeat` (`POST …/messages/repeat`) is a server operation as well (no new user message),
but has no dedicated renderer thunk in this flow.

## Pause / Resume (tool permission + plan_md clarify)

The server loop pauses **mid-turn**, per tool call, to ask the renderer for a decision.

- **Where it pauses**: `createChatPausingExecutor` (`chatOrchestrator.ts:95`) wraps the base
  executor. Before delegating it `await broker.requestDecision({ streamId, toolCallId, signal })`.
  Pause is skipped when `broker.isAutoApproveAll(streamId)` or `shouldBypassPermission(...)`
  (`ALWAYS_BYPASS_TOOLS = skill_manager, mcp_manager, multi_call`; `custom_tool_manager`
  non-`invoke` actions). `plan_md` with `action==='clarify'` is intercepted here and routed
  through the broker's clarify channel (the base executor always throws on it).
- **Broker** (`decisionBroker.ts`): key `${streamId}::${toolCallId}` (conversationId is NOT
  part of the key). Holds one pending promise per (stream, toolCall) + per-stream
  auto-approve sessions; `requestDecision` rejects with `DecisionAbortedError`
  (`name='AbortError'`) on signal abort; `rejectAllForStream` (`:134`) drains on disconnect.
- **SSE decision events** (emitted by the pausing executor):
  `permission_required { streamId, toolCallId, toolName, toolInput }`,
  `clarify_required { streamId, toolCallId, toolName, questions }`.
- **`POST /api/resume`** (`chatRoutes.ts:146`, plain JSON): requires `streamId` + `toolCallId`;
  `decision` string → permission (`allow_once|allow_always|deny`); `answers`/`cancelled` →
  clarify; matched → 200, else **409** (stale click). `deny` → throw
  `'Tool execution denied by user'`; `allow_always` atomically enables the stream and resolves all permission waiters already parked for that stream, including parallel `multi_call` workers.
- **Renderer resolvers** (`chatActions.ts`): `respondToToolPermission` (`:2880`),
  `respondToToolPermissionAndEnableAll` (`:2915`), `respondToPlanClarification` (`:2892`),
  `cancelPlanClarification` (`:2904`) — all POST `/api/resume` via `postDecisionResume`
  (`:2869`), reading `{ streamId, toolCallId }` from Redux. Public signatures are unchanged
  (zero `Chat.tsx` changes). The old module-level `pending*Resolve` promises are **removed**.
- **Abort**: Stop first awaits `POST /api/streams/:id/abort`, then closes the local
  reader and clears UI state. If the abort request fails, the in-flight marker is retained
  for reconciliation; the run otherwise continues until completion or the detached reaper.

## Hooks (server-side, in-process)

`chatHookService.ts createChatHookSession` (`:210`) runs Ygg hooks **in the same Electron
main process** (no HTTP) at 5 lifecycle points. Lineage/metadata are rebuilt from
`ConversationRepo` per call; `additionalContext` accumulates into the per-turn system prompt.

1. **UserPromptSubmit** — in `runMessage` before user-message persistence; rewrites the
   prompt; `blocked` throws (finishes run `error`).
2. **PreToolUse** — in the pausing executor BEFORE any permission prompt/clarify; may rewrite
   arguments or `deny` (throw → `is_error` tool_result).
3. **PostToolUse** — success path after execute (fires even for clarify).
4. **PostToolUseFailure** — catch path, but **NOT on abort** (deliberate divergence).
5. **Stop** — called by the loop on a natural stop (`toolLoopService.ts:727` via
   `input.hooks.runStop`); `blocked` forces one more (empty) turn.

Wiring: the executor Pre/Post/Failure are interleaved inside `createChatPausingExecutor`;
the loop side gets `hookSession.toolLoopHooks()` → `{ hookContext, foldSystemPrompt, runStop }`
as `input.hooks`. Absent for subagents/tests/mobile ⇒ hooks off, loop behavior unchanged.

## Compaction (server-side)

Both paths run through `CompactionService`:
- **In-loop (auto)**: inside `ToolLoopService.run` at the quiescent boundary after a
  tool-executing turn (`toolLoopService.ts:940`, `resolveOpenAIContinuationCompaction`). At
  the threshold it emits `context_compaction` (`threshold_reached → started`), calls
  `compactBranch`, re-anchors the stream to the `__auto_compaction_summary__` system marker,
  resets `history = [summaryMessage]` and emits `completed`. Failure → `failed` + throw
  (`endReason: context_compaction_failed`).
- **Manual button**: `POST /api/conversations/:id/compact` (`chatRoutes.ts:174`) →
  `compactionService.compactBranch` (`:559`) → persists a `role:'system'`,
  `note:'__auto_compaction_summary__'` message. The renderer's standalone `compactBranch`
  thunk (`chatActions.ts:832`) still drives this button client-side (the ONE surviving
  renderer-side generation path); in-loop auto-compaction moved server-side.

## Provider routing, message sinks, cloud gateway

- **Provider routing**: `normalizeProviderRoute` (`providerRouter.ts`) resolves all 5 routes.
- **Message-id authority / sinks** (`messageSink.ts`):
  - `CloudMirrorSink` iff `isCloudRoute` (`gateway.chat` on **and** provider route is
    `openrouter`): adopts Railway's authoritative message id
    (`id: draft.providerMessageId ?? undefined`, `messageSink.ts:94`) and sets
    `relayFreeTierEvents: true` so `openRouterProvider` emits `free_generations_update` /
    `generation_limit_reached` (else dropped).
  - `TreeMessageSink` for every other provider and whenever `gateway.chat` is off —
    local-authoritative, mints local uuids.
- **Cloud gateway**: renderer CRUD/attachments go through `gwApi`/`cloudApi`/`localApi`
  (all `:3002`). `/api/gw/*` merges local ⊕ cloud server-side (replacing the old
  `shouldUseLocalApi` dual-fetch/merge). `/api/cloud/*` is an allowlisted authenticated
  pass-through to Railway, which stays **authoritative** for free-tier metering, Stripe,
  cloud DB, and `/users`.

## Feature flags

`config/gatewayFlags.ts resolveGatewayFlags()` → `{ chat, tokenOwner, crud, cloudProxy }`.
- `chat` — **DEFAULT ON** post-cutover (Conf `gateway.chat !== false`; explicit `false` is the
  escape hatch). Feeds `cloudChatEnabled` into `ChatOrchestrator`.
- `tokenOwner` — default OFF; consumed only by the `main.ts` IPC gate + renderer
  `isServerTokenOwnerEnabled` (`src/helpers/serverLoopSettings.ts`).
- `crud` / `cloudProxy` — **vestigial** (default-false; the routes mount with hardcoded
  `enabled: true`, so the flags are computed but not read at the mount site).
- Master override env `YGG_GATEWAY_MODE` (truthy) turns all four on.

## SSE event → Redux projection (`sseProjection.ts`)

| Server SSE event | Projected Redux action(s) — existing reducers |
|---|---|
| `started` (has `parentId`) | `streamLineageUpdated{ rootMessageId, branchAnchorMessageId, currentBranchAnchorMessageId }` |
| `user_message_persisted` | `messageAdded` + `messageBranchCreated` + `streamLineageUpdated{ originMessageId, triggerUserMessageId, … }`; also clears the optimistic bubble in `runServerChatLoop` |
| `tool_loop` (`turn_started`) | `streamChunkReceived{ type:'generation_started' }` (per-turn boundary; keeps `active=true`) |
| `chunk` `text`/`reasoning` | `streamChunkReceived{ type:'chunk', part, delta }` |
| `chunk` `image` | `streamChunkReceived{ type:'chunk', part:'image', url, mimeType }` |
| `chunk` `tool_call` | `streamChunkReceived{ type:'chunk', part:'tool_call', toolCall }` |
| `chunk` `tool_result` | `streamChunkReceived{ type:'chunk', part:'tool_result', toolResult }` |
| `assistant_message_persisted` (per-turn) | `messageAdded` + `messageBranchCreated` + complete-**chunk** (NOT `streamCompleted`) |
| `complete` (terminal, once) | `messageAdded` + `messageBranchCreated` + `streamCompleted{ updatePath:true }` |
| `error` | `messageAdded(assistantMessage)` only if present; the error **chunk** is emitted by the thunk catch after `sendingCompleted` |
| `permission_required` | `toolPermissionRequested{ toolCall, streamId, toolCallId }` |
| `clarify_required` | `planClarificationRequested{ id, questions, streamId, toolCallId }` |
| `free_generations_update` | `freeGenerationsUpdated{ remaining, isFreeTier }` |
| `generation_limit_reached` | `freeTierLimitModalShown()` |
| `provider_routed`, `context_usage`, `context_compaction`, `tool_execution`, `tool_request` | `[]` (no-op) |

Full union: `contracts/headlessApi.ts` `HeadlessStreamEvent`.

## Important Invariants

- Branch lineage and parent ids are **server-assigned** (SQLite ids). The renderer rebuilds
  its current path from `started.parentId`, `user_message_persisted.message.id`, and
  `complete.message.id` — not from locally minted ids.
- Tool calls are permission-gated unless the session is auto-approve
  (`toolAutoApprove !== false`) or the tool is in the bypass set.
- The `subagent` tool is dispatched in-process by the server-owned main loop through
  `subagentToolExecutor.ts` into the **same** `SubagentRunService`; the retained
  `subagentClient.ts` is the direct SSE client. See `agent_subagents_orchestration.md`.
- Compaction is additive: a synthetic `__auto_compaction_summary__` system message, never a
  deletion.
- Hooks can rewrite prompts/tool inputs or block execution; keep hook call sites ordered.
- `toolAutoApprove` and `hooksEnabled` are forwarded **verbatim** (no `undefined → false`
  coercion); the server gates on `!== false` / `=== true` respectively.

## Retired / removed (do not reference as live)

These were part of the old renderer-owned world and are **gone**:
- Claude Code: `electron/tools/claudeCode.ts` + its routes + CC thunks/types/reducers
  (`selectCCSlashCommands`).
- GlobalAgentLoop: `services/GlobalAgentLoop.ts`, `GlobalAgentBootstrap.tsx`,
  `hooks/useGlobalAgentCache.ts`, `hooks/useGlobalAgentMessages.ts`,
  `helpers/agentSettingsStorage.ts`, and the `agent_*` DB tables.
- `dualSyncManager.ts` + `lib/sync/*` — replaced by server-side `CloudMirrorService`/
  `CloudMirrorSink`. (A `dualSync` alias name survives only as a local import of the KEPT
  `src/lib/localMirror.ts`.)
- Renderer flags `isServerOwnedChatLoopEnabled` / `isCloudServerLoopEnabled` and the
  renderer's `executeToolWithPermissionCheck` + `pending*Resolve` promises.

Note: two odd-extension test fixtures (`electron/tools/__tests__/dummyfile.ts.test`,
`dummyFilechatAction.ts.test`) are verbatim snapshots of the pre-migration source read as
plain text by `editFile.test.ts`; they are never imported/compiled. A grep for any deleted
name above will hit these fixtures — they are not live code.

KEPT despite older plan notes: `streamRunTracking.ts`, `src/lib/localMirror.ts`, the 4
resume resolver thunks, and the manual-compaction `compactBranch` thunk.

## Extension Points

- Add provider behavior in `providerRouter.ts` + the relevant `providers/*` module.
- Add a new SSE event only with (a) a `HeadlessStreamEvent` member in
  `contracts/headlessApi.ts`, (b) an emitter in the loop, and (c) a `projectServerEvent`
  case mapping it onto existing (or new) reducers.
- Add tool-loop behavior in `ToolLoopService` behind an optional `ToolLoopRunInput` field so
  the subagent path stays unaffected.

## Testing and Validation

- Type/build: `npm --prefix client/ygg-chat-r run build:electron`.
- Server engine: `npm --prefix client/ygg-chat-r run test:headless` (covers
  `chatOrchestrator.phase2 / .hooks / .clarify`, `decisionBroker`, `chatHookService`,
  `branchOrchestrator`, `gatewayFlags`).
- Renderer projection/request: `sseProjection.test.ts`, `buildServerLoopRequest.test.ts`.
- Manually verify send, tool call, denial, allow-all, plan clarify, branch, edit-branch,
  stop, and abort if UI behavior changes.

## Related Docs

- `agent_chat_streaming_state.md` — Redux multi-stream state + branch-aware selectors.
- `agent_headless_server.md` — the `:3002` server, routes, and lifecycle.
- `agent_subagents_orchestration.md` — the shared engine's subagent path.
- `agent_hooks_system.md` — Ygg hooks (discovery, lifecycle, payloads).
- `agent_context_compaction_memory.md` — compaction/memory details.
- `agent_tool_registry.md`, `agent_local_tools_runtime.md` — tool definitions + execution.

## OpenAI Context Usage

- OpenAI/Codex `response.completed.response.usage` is normalized at the shared provider
  boundary (`OpenAiChatgptProvider`) and attached to assistant messages as `context_usage`
  plus an `openai_context_usage` content block. Each completed provider/tool turn **replaces**
  the previous snapshot rather than summing.
- This usage now flows through the **server** loop; the renderer receives `context_usage` as
  an SSE event (currently projected as a no-op — usage is read from the persisted message).
- Authoritative provider usage applies only to the OpenAI provider; other providers retain
  Graviton's `tokenx` estimation. Auto-compaction retains the 85% model-context threshold,
  now evaluated inside `ToolLoopService` (see Compaction above).
