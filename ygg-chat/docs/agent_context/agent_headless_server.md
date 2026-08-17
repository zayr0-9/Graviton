# Agent Context: Headless Server

Last reviewed: 2026-08-01

## Purpose

Documents the local **headless Express server** (`http://127.0.0.1:3002`) that runs inside the Electron main process. After the "headless main agent loop" migration (branch `feat/headless-agent-loop`, Phases 0–6, live), this server OWNS the main chat agent loop for **all 5 providers** (`openrouter`, `lmstudio`, `openaichatgpt`, `zai`, `bedrock`) — not just subagents. It also owns pause/resume (permission + plan clarify), in-process Ygg hooks, server-side compaction, the cloud gateway (`/api/gw/*`, `/api/cloud/*`), and the sole Supabase-token refresher.

The React renderer is now a **thin client**: it POSTs the SSE chat routes here and projects server events onto the existing Redux `streamChunk` vocabulary. It keeps no loop control, no tool execution, and no permission/hook/compaction orchestration. Electron-only scope (the renderer thunks throw outside Electron); non-Electron web mode is not a target.

## When to Open This File

Use this when changing:
- the `/api/conversations/*` SSE chat routes or the server-owned chat loop;
- pause/resume (`DecisionBroker`, `POST /api/resume`);
- in-process chat hooks (`chatHookService`);
- server-side compaction (`compactionService`);
- the cloud gateway surfaces (`/api/gw/*` CRUD/merge, `/api/cloud/*` pass-through) or the Railway client;
- the sole token refresher (`appAuthTokenManager`) and its `gateway.tokenOwner` gate;
- detach/reattach of runs (`runSessionRegistry`, `gateway.resumableRuns`, `/api/streams/*`);
- the `HeadlessStreamEvent` SSE union (any change needs matching renderer projection + mobile/test updates);
- headless provider support or the shared `ToolLoopService`.

## Key Files

Wiring root:
- `client/ygg-chat-r/electron/headlessServer/index.ts` — `registerHeadlessServerRoutes` builds the shared graph: one process-wide `DecisionBroker`; the leaf `executeToolViaOrchestrator` (submit→poll `toolOrchestrator`, timeout/cancel support) used by ordinary and child tools; one shared `SubagentRunService`; and a main-chat `createSubagentDispatchExecutor` that intercepts `subagent` in-process before delegating other names to the leaf executor. `ChatOrchestrator` is wired with that composite executor, `defaultToolsProvider: resolveDefaultInferenceTools`, compaction, hooks, and gateway flags. The gateway surfaces mount unconditionally.

Chat loop engine:
- `services/chatOrchestrator.ts` — `ChatOrchestrator.runMessage` (main entry). Builds a fresh per-run `ToolLoopService`, chooses the message sink, wires the pausing executor + hook session, and finishes/aborts the run. `createChatPausingExecutor` (`chatOrchestrator.ts:95`) is the per-run tool wrapper; `ALWAYS_BYPASS_TOOLS` (`chatOrchestrator.ts:47`) = `skill_manager, mcp_manager, multi_call`.
- `services/branchOrchestrator.ts` — `BranchOrchestrator.resolve` computes continuation/branch semantics (`historyLeafId`, `assistantParentId`, `userContentForInference`) and persists the user message.
- `services/toolLoopService.ts` — shared assistant tool-call continuation loop. Persists via an injectable `MessageSink`; supports abort, per-run `maxTurns`, empty-turn retry + finalization, in-loop compaction, and `input.hooks` (`foldSystemPrompt`/`hookContext`/`runStop`). Same engine that serves subagents; new main-loop behavior is gated on optional `ToolLoopRunInput` fields.
- `services/decisionBroker.ts` — pause/resume registry (see below).
- `services/chatHookService.ts` — in-process Ygg hooks (see below).
- `services/compactionService.ts` — summary generation + `__auto_compaction_summary__` persistence (`AUTO_COMPACTION_NOTE`, `compactionService.ts:4`).
- `services/messageSink.ts` — `TreeMessageSink` (`:49`, local-authoritative) vs `CloudMirrorSink` (`:85`, adopts Railway ids).
- `services/providerRouter.ts` — `normalizeProviderRoute` resolves all 5 routes (unknown → `openaichatgpt`).
- `persistence/streamingRunRepo.ts` — durable `streaming_runs` lifecycle rows (`upsert` mints/reuses `streamId`, `finish` writes terminal status).

Cloud gateway + token layer:
- `routes/gatewayRoutes.ts` — `/api/gw/*` storage-aware CRUD/merge.
- `routes/cloudProxyRoutes.ts` — `/api/cloud/*` authenticated pass-through.
- `services/railwayClient.ts` — Bearer-injecting Railway client (`passthrough` / `request` / `stream`).
- `services/cloudMirrorService.ts` — mirrors Railway-authoritative entities into SQLite (server-side replacement for the deleted renderer `dualSyncManager`).
- `services/appAuthTokenManager.ts` — single-flight, process-wide Supabase-token refresher.
- `config/gatewayFlags.ts` — `resolveGatewayFlags()` → `{ chat, tokenOwner, crud, cloudProxy, resumableRuns }`.
- `services/runSessionRegistry.ts` — per-`streamId` `RunSession` (seq'd event buffer + attach/detach + run-owned abort) enabling detach/reattach (§Detach/Reattach). Gated by `gateway.resumableRuns` (default ON; explicit false is the rollback path).

Subagents / other:
- `services/subagentRunService.ts` + `services/subagentToolExecutor.ts` + `routes/subagentRoutes.ts` — the shared subagent engine, the parent-chat in-process dispatcher, and the direct `POST /api/headless/subagent/stream` SSE route (see `agent_subagents_orchestration.md`). Reuses `ToolLoopService`.
- `contracts/headlessApi.ts` — `HeadlessMessageRequest`, `HeadlessStreamEvent` union (§SSE below), `HeadlessSubagentStreamEvent`.
- `providers/*`, `stream/*` (SSE writer), `ui/mobile/src/*` (mobile LAN UI), `README.md`, `HEADLESS_API_GUIDE.md`.

## Server API map

All routes are served on `http://127.0.0.1:3002`; the renderer resolves them via `buildLocalApiUrl` (`DEFAULT_LOCAL_SERVER_ORIGIN = 'http://127.0.0.1:3002'`, `src/utils/api.ts:10`).

### Chat loop (SSE) — `routes/chatRoutes.ts`
Four POST routes → `runSseOrchestrator` → `orchestrator.runMessage(request, emit, signal)` (`chatRoutes.ts:219`–`233`):

| Route | Operation |
|---|---|
| `POST /api/conversations/:id/messages` | `send` |
| `POST /api/conversations/:id/messages/repeat` | `repeat` |
| `POST /api/conversations/:id/messages/:messageId/branch` | `branch` |
| `POST /api/conversations/:id/messages/:messageId/edit-branch` | `edit-branch` |

Plus non-SSE POSTs on the same router:
- `POST /api/resume` (`chatRoutes.ts:146`) — resolves a paused decision (plain JSON; see Pause/Resume).
- `POST /api/conversations/:id/compact` — the standalone manual-compaction path → `compactionService.compactBranch`.
- **`GET /api/streams/:streamId`** + **`POST /api/streams/:streamId/abort`** — resubscribe / explicit-cancel, active only under `gateway.resumableRuns` (else `501`); see §Detach/Reattach.

Each SSE request creates one `AbortController`. In the **legacy** path it is aborted on `res.on('close')`, so a dropped client cancels in-flight provider/tool work AND unblocks a loop paused on a decision. Under `gateway.resumableRuns` a close instead **DETACHES** and the run keeps going (§Detach/Reattach).

### Cloud gateway CRUD/merge — `routes/gatewayRoutes.ts` (`/api/gw/*`)
Storage-aware surface owning **conversations, projects, messages, attachments** (local ⊕ cloud). Collapses the renderer's old `shouldUseLocalApi` dual-fetch/merge + dual-write into the server. Per route: LOCAL leg = in-process loopback `fetch` to the app's own `/api/app/*` routes (byte-for-byte reuse); CLOUD leg = `railway.passthrough`. Reads run both legs and merge with the renderer's exact rules via pure helpers (`mergeConversationLists`, `mergeProjects`, `mergeRecent`, `mergeConversationsPaginated`, `mergeByProjectPaginated`, plus `dedupById`, `gatewayRoutes.ts:60`–`100`). No cloud session ⇒ cloud leg skipped (community/local-only). Writes route by storage mode (renderer `?storageMode=` hint authoritative, else SQLite `storage_mode` row, else `cloud`); cloud writes mirror the authoritative entity into SQLite. Covers list/paginated/by-project/recent/favorites/search reads, single-entity GET/POST/PATCH/DELETE, conversation sub-fields (`system-prompt`, `context`, `research-note`, `cwd`, `project`), message bulk/tree/update/deleteMany, and attachment link + cloud-only multipart upload.

### Cloud pass-through — `routes/cloudProxyRoutes.ts` (`/api/cloud/*`)
Single `app.all('/api/cloud/*', …)` (`cloudProxyRoutes.ts:42`) strips the prefix and forwards `<method> <rest+query>` via `railway.passthrough`, relaying status/body verbatim so cloud errors reach the renderer unchanged. **Allowlist only** — `CLOUD_PROXY_ALLOWED_PREFIXES` (`cloudProxyRoutes.ts:24`) = `/models, /users, /system-prompts, /stripe, /app-store, /oauth`; anything else → 403 (`isCloudProxyPathAllowed`). Railway stays authoritative for these (free-tier metering / Stripe / cloud-DB / `/users`); the server proxies, it does not own them.

### Other route modules (unchanged by this migration)
`crudRoutes` (`/api/app/*` local SQLite CRUD — the gateway's local leg), `providerAuthRoutes`, `mobileUiRoutes`, `customToolsRoutes`, `customToolRpcRoutes`, `capabilityRoutes`, `ephemeralGenerateRoutes`, `testHarnessRoutes`, `subagentRoutes`.

## Orchestration (`ChatOrchestrator.runMessage`)

Data flow, in order:
1. Load conversation (throws if missing), touch conversation + project.
2. Build `hookSession` iff `hookRunner && request.hooksEnabled === true && decisionBroker`.
3. **UserPromptSubmit** hook runs *before* persisting the user message (`send`/`branch`/`edit-branch` only); may rewrite `request.content` or block → run finishes `error`.
4. `resolveExecution` → `BranchOrchestrator.resolve` persists the user message (except `repeat`).
5. `streamingRunRepo.upsert(...)` → final `trackedStreamId`.
6. `decisionBroker.initSession(trackedStreamId, { autoApproveAll: request.toolAutoApprove !== false })` (`chatOrchestrator.ts:360`) — **default auto-approve; the loop pauses only when a caller EXPLICITLY sends `toolAutoApprove: false`.** The mobile LAN UI never sends it, so it always auto-approves.
7. Emit `started`, `user_message_persisted` (if any), `provider_routed`.
8. Build history, resolved tools (`filterToolsForOperationMode`), and system prompt (server-assembled; the renderer deliberately omits `systemPrompt`).
9. `isCloudRoute = cloudChatEnabled && normalizeProviderRoute(provider) === 'openrouter'` (`chatOrchestrator.ts:412`).
10. Per-run loop build (`chatOrchestrator.ts:418`–`475`): fresh `ToolLoopService` with `sink = CloudMirrorSink` (cloud route) else `TreeMessageSink`, `executeTool = createChatPausingExecutor(...)`, `relayFreeTierEvents: isCloudRoute`, and `input.hooks = hookSession.toolLoopHooks()`.
11. `loop.run(input, emit)`.
12. Terminal handling: success → `streamingRunRepo.finish('completed')` + `complete`; `ProviderErrorAssistantResponse` → `finish('error', endReason:'provider_error')` + `complete { providerError:true }`; abort → `finish('aborted')` and return (no `error` frame); other error → `finish('error')` + rethrow. **finally:** `decisionBroker.rejectAllForStream(trackedStreamId)` drains pending decisions + session.

Signal threading: one `AbortController` per SSE request → `runMessage(…, signal)` → pausing executor uses `context.signal ?? signal` for `broker.requestDecision` (disconnect rejects the paused promise) and `loop.run` gets `input.signal` (checked each turn / before each tool, forwarded to the provider). Abort is classified by `isAbortError` (`name === 'AbortError'`).

## Pause/Resume (`DecisionBroker` + `POST /api/resume`)

The loop pauses mid-turn to ask the renderer for a tool-permission or `plan_md` clarify decision.

- **Key** (`decisionBroker.ts:54`): `` `${streamId}::${toolCallId}` `` — `conversationId` is NOT part of the key; one pending decision per (stream, toolCall).
- **Where it pauses:** inside `createChatPausingExecutor` (`chatOrchestrator.ts:95`), per tool call, *before* delegating to the base executor — `await broker.requestDecision({ streamId, toolCallId, signal })`. `ToolLoopService` itself has no pause concept. Pause is skipped when `broker.isAutoApproveAll(streamId)` or the tool is bypassed (`ALWAYS_BYPASS_TOOLS`, plus `custom_tool_manager` non-`invoke` actions).
- **SSE decision events** emitted by the pausing executor before awaiting: `permission_required` `{streamId, toolCallId, toolName, toolInput}` and `clarify_required` `{streamId, toolCallId, toolName, questions}` (the latter for `plan_md action==='clarify'`, intercepted and routed through the broker's clarify channel).
- **`POST /api/resume`** (`chatRoutes.ts:146`, plain JSON): requires `streamId` + `toolCallId` (400 otherwise). Decoding: `body.decision` string → permission (`allow_once | allow_always | deny`); `body.answers`/`body.cancelled` → clarify; `body.result`/`body.error` → tool-bridge decision (future). `decisionBroker.resolve(...)` → 200 `{success:true}` if matched, else **409**.
- Wrapper handling: `deny` → throw (`is_error` tool_result); `allow_always` → `broker.setAutoApproveAll(streamId)` then execute; `allow_once` → execute.
- Renderer side: the 4 resolver thunks (`respondToToolPermission`, `respondToToolPermissionAndEnableAll`, `respondToPlanClarification`, `cancelPlanClarification`) POST `/api/resume` via `postDecisionResume`; the old module-level `pending*Resolve` promises are **deleted**.

## Detach / reattach — resumable runs (`gateway.resumableRuns`, default ON)

`services/runSessionRegistry.ts` decouples a run's lifetime from its SSE socket. With the flag ON, `runSseOrchestrator` (`chatRoutes.ts`) routes `emit` through a per-`streamId` `RunSession` instead of writing straight to `res`, and the **session** (not `res.on('close')`) owns the `AbortController`:

- **A bare client disconnect DETACHES** (`res.on('close') → session.detach`) — the loop keeps running in the Electron main process; it no longer aborts.
- The session buffers every event with a monotonic `seq` (bounded ring buffer), fans out to at most one attached subscriber (last-attach-wins), and lingers after a terminal event so a late reconnect still receives the tail.
- **`GET /api/streams/:streamId?fromSeq=N`** — resubscribe: attach, replay buffered frames with `seq > N`, then stream live. Because `permission_required` / `clarify_required` frames are in the buffer, a **parked decision re-surfaces on replay for free** (no broker change). `410 Gone` when the run was already evicted → the client reloads persisted messages. `seq` rides on each SSE frame as the replay cursor (append-style chunk projection is only idempotent with it).
- **`POST /api/streams/:streamId/abort`** — the ONLY thing that cancels now (a disconnect only detaches). Aborting the session signal also unblocks any paused decision via the existing signal→broker path.
- **Reaper** (`registry.startReaper`, started by default): evicts terminal sessions after
  one minute and cancels+evicts still-running sessions detached for five minutes. The
  event buffer is capped at 20,000 frames. **App quit kills every session** (in-memory) —
  the accepted ceiling; there is no cross-restart durability.
- Sessions accept one subscriber and use last-attach-wins semantics; renderer per-stream
  reader ownership prevents route remounts from replacing a surviving subscriber.
- A repeated POST that reuses an existing `streamId` is treated as an idempotent re-attach to the existing session; it must never start a second orchestrator run. The registry also exposes abort-before-replace for explicit replacement callers. Never restore delete-without-abort: it orphaned branch runs outside abort, reattach, and reaper reachability.
- Explicit `gateway.resumableRuns === false`: `runSseOrchestrator` keeps the legacy path
  (disconnect == abort) and `/api/streams/*` return `501`.
- Renderer counterpart: `mainChatClient.ts` (in-session resubscribe + `postStreamAbort`) + `resumeInFlightStreams` (mount-time re-attach after a reload) + `inflightStreams.ts` (localStorage tracking) — see `agent_chat_streaming_state.md`.

## In-process chat hooks (`chatHookService.ts`)

`createChatHookSession` (`chatHookService.ts:210`) runs Ygg hooks IN-PROCESS (same Electron main process, no HTTP) at 5 lifecycle points. Lineage/metadata are rebuilt from `ConversationRepo` per call; `additionalContext` accumulates into a shared `hookContext[]` (`appendHookAdditionalContext`) that the loop folds into the per-turn system prompt via `foldSystemPrompt` then clears.

1. **UserPromptSubmit** — before user-message persistence (`send`/`branch`/`edit-branch`); returns the effective prompt; `blocked` → throw (run finishes `error`). Carries `project`.
2. **PreToolUse** — in the pausing executor BEFORE any permission prompt/clarify; `updatedInput` rewrites the tool arguments; `permissionDecision === 'deny'` → throw (→ `is_error` tool_result).
3. **PostToolUse** — success path after execute; payload `toolResult`.
4. **PostToolUseFailure** — catch path, but **NOT on abort** (aborts rethrow unwrapped); fires on PreToolUse deny AND permission deny.
5. **Stop** — the loop calls `input.hooks.runStop` on a natural stop; `blocked === true` forces one more turn (empty user turn parented on the just-persisted assistant), appending the reason to `hookContext`.

Memory-context injection is intentionally NOT ported.

## Compaction

Two paths, both via `CompactionService.compactBranch`, which persists a `role:'system'`, `note:'__auto_compaction_summary__'` message:
- **In-loop (auto):** runs inside `ToolLoopService.run` at the quiescent boundary after a tool-executing turn (OpenAI/Codex continuation policy). Emits `context_compaction` `threshold_reached`→`started`→`completed`; a successful summary replaces pre-compaction replay history and becomes the next parent. Failure emits `failed` + throws (`endReason: context_compaction_failed`). The renderer no longer orchestrates in-loop compaction.
- **Manual button:** `POST /api/conversations/:id/compact` (`chatRoutes.ts:174`). The renderer's standalone `compactBranch` thunk (manual-compaction button) was **KEPT** and is still fully client-side (the one surviving renderer-side generation path).

## Message sink selection & Railway-id adoption (`messageSink.ts`)

Chosen per-run in `runMessage` (`chatOrchestrator.ts:421`):
- **`CloudMirrorSink`** iff `isCloudRoute` (`gateway.chat` ON && provider route `openrouter`). It passes `id: draft.providerMessageId ?? undefined` into `createMessage` (`messageSink.ts:94`), so the local SQLite row adopts Railway's authoritative message id; also sets `relayFreeTierEvents: true` so `openRouterProvider` emits the free-tier events (else dropped). Falls back to a minted uuid when the provider surfaced no id.
- **`TreeMessageSink`** for every other provider (`openaichatgpt`, `lmstudio`, `zai`, `bedrock`) and whenever `gateway.chat` is off — mints local uuids, ignores `providerMessageId`. Native providers stay local-authoritative.

`providerMessageId` is sourced from `output.raw?.id` at the persist sites in `toolLoopService.ts`.

## Cloud client & token layer

- **`railwayClient.ts`** — base URL `YGG_API_URL → VITE_API_URL → webdrasil default` (`:65`). Every request injects `Authorization: Bearer <token>` from `AppAuthTokenManager.getFreshAppToken()`; binary bodies forwarded verbatim (multipart boundary intact). On `401` (not aborted) it does exactly one `forceRefresh` retry. Three methods: `passthrough` (verbatim status/body, never throws on HTTP status — lets `/api/cloud/*` mirror cloud errors), `request<T>` (throws on non-2xx), `stream` (SSE relay to `onEvent`, abortable via `signal`).
- **`appAuthTokenManager.ts`** — `SingleFlightAppAuthTokenManager`, a **process-wide memoized singleton** (`createAppAuthTokenManager`, `:81`). The single `inflight` lock is what makes the server the sole refresher — two instances would reintroduce the refresh_token race. `getFreshAppToken()` reads the Conf `auth_session`, refreshes iff `refreshToken` present AND (`forceRefresh` OR near-expiry 5-min skew), sharing one in-flight `refreshElectronAppAuthSession`; a failed refresh resolves (never rejects) so callers fall back to the stale read. Wraps `providers/electronAppAuth.ts`.
- **Token-owner coupling:** the server flag `gateway.tokenOwner` (default OFF) is enforced at the IPC boundary — `electron/main.ts:1020` handler `app-auth:get-fresh-token` returns `{ownerEnabled:false}` unless `resolveGatewayFlags().tokenOwner` is on (never throws). Renderer double-gate: `isServerTokenOwnerEnabled()` (`src/helpers/serverLoopSettings.ts:39`, localStorage `ygg.serverTokenOwner` / env `VITE_SERVER_TOKEN_OWNER`, default OFF) AND the IPC reply's `ownerEnabled:true` — only then does `requestServerTokenRefresh()` (`src/lib/jwtUtils.ts:28`) adopt the server-rotated session; any other outcome → renderer self-refreshes (safe fallback, no half-rollout).

## Feature flags (`config/gatewayFlags.ts`)

`resolveGatewayFlags()` → `{ chat, tokenOwner, crud, cloudProxy }` (`gatewayFlags.ts:39`):
- Master override `YGG_GATEWAY_MODE` env truthy (`/^(1|true|yes|on)$/i`) → all four `true`, short-circuiting Conf.
- Otherwise defaults: **`chat = true`** and **`resumableRuns = true`** (each uses
  `!== false`; explicit false is the escape hatch), while `tokenOwner`, `crud`, and
  `cloudProxy` remain false. A bad/missing Conf store keeps both default-on paths active.
- **Only `chat` and `tokenOwner` are live.** `chat` feeds `cloudChatEnabled` into `ChatOrchestrator`; `tokenOwner` is consumed only by the `main.ts` IPC gate. **`crud`/`cloudProxy` are vestigial** — the Phase 5 gateway routes mount with hardcoded `enabled: true` (`index.ts:271`,`273`) regardless of these flags.

## Full SSE event union (`HeadlessStreamEvent`, `contracts/headlessApi.ts:132`)

Every member (the 5 events added by this migration are marked **NEW**):

1. `started` `{operation, conversationId, parentId, provider, modelName, streamId?}`
2. `user_message_persisted` `{message}`
3. `provider_routed` `{provider, modelName}`
4. `tool_loop` `{status: turn_started | turn_completed | max_turns_reached | empty_turn_retry | finalization_turn, turn, maxTurns, continued?}`
5. `tool_execution` `{status: started | completed | failed, toolCallId, toolName, durationMs?, error?}`
6. `chunk` (text/reasoning) `{part: text | reasoning, delta}`
7. `chunk` (image) `{part: image, url, mimeType?}`
8. `chunk` (tool_call) `{part: tool_call, toolCall}`
9. `chunk` (tool_result) `{part: tool_result, toolResult}`
10. `context_usage` `{usage}`
11. `context_compaction` `{status: threshold_reached | started | completed | failed, turn, reportedTokens, projectedTokens, effectiveTokens, contextLength, thresholdPercent, parentMessageId?, summaryMessage?, error?}`
12. `assistant_message_persisted` `{message}`
13. **NEW** `permission_required` `{streamId?, toolCallId, toolName, toolInput, turn?}` — server paused for a tool-permission decision.
14. **NEW** `clarify_required` `{streamId?, toolCallId, toolName, questions}` — server paused for a `plan_md` clarify.
15. **NEW** `tool_request` `{streamId?, toolCallId, toolName, toolInput}` — renderer-bound tool execution (contract-defined; **no current emitter**, reserved for the future tool bridge).
16. **NEW** `free_generations_update` `{remaining, isFreeTier?}` — openrouter free-tier meter frame.
17. **NEW** `generation_limit_reached` `{message?}` — openrouter free-tier exhaustion.
18. `complete` `{message, providerError?}`
19. `error` `{error, provider?, modelName?, retryExhausted?, status?, errorType?, resetAt?, assistantMessage?}`

Free-tier events (16–17) are emitted by `providers/openRouterProvider.ts` (`:417` exhaustion 403, `:488` meter frame) **only** when `relayFreeTierEvents` is set (i.e. the server-owned cloud route); subagents / flag-off leave it unset ⇒ drop parity. A separate `HeadlessSubagentStreamEvent` union (`headlessApi.ts:93`) extends this with subagent-specific `started`/`complete`/`error` shapes.

## Renderer thin client (pointer)

The renderer's 3 chat thunks (`sendMessage`, `editMessageWithBranching`, `sendMessageToBranch`) live in `src/features/chats/chatActions.ts` (~3,003 lines, down from ~9,400). They build the request with `buildServerLoopRequest` (`src/features/chats/buildServerLoopRequest.ts:104`), drive the SSE stream with `runServerChatLoop` (`src/features/chats/mainChatClient.ts:52`, plain `fetch` + `getReader()` — no `EventSource`), and project each server event onto existing Redux reducers via the pure `projectServerEvent` (`src/features/chats/sseProjection.ts:92`). The renderer keeps the optimistic user bubble, the permission/clarify dialogs (existing reducers unchanged), stream-lifecycle scaffolding, `streamRunTracking.ts` (KEPT, live callers), and the manual `compactBranch` thunk. CRUD/attachments still renderer-issued but routed through `gwApi`/`cloudApi`/`localApi` (`src/utils/api.ts:536`–`537`), which all hit `:3002`.

## Retired / removed (do not reference as live)

- **Claude Code:** `electron/tools/claudeCode.ts` + its localServer routes + CC thunks/types/reducers/`selectCCSlashCommands` — GONE.
- **GlobalAgentLoop (GAL):** `services/GlobalAgentLoop.ts`, `GlobalAgentBootstrap.tsx`, `hooks/useGlobalAgentCache.ts`, `hooks/useGlobalAgentMessages.ts`, `helpers/agentSettingsStorage.ts`, GAL localServer routes, `agent_*` DB tables — GONE.
- **Renderer sync layer:** `src/features/chats/dualSyncManager.ts` and the whole `src/lib/sync/` dir — GONE, replaced server-side by `services/cloudMirrorService.ts` + `CloudMirrorSink`. `src/lib/localMirror.ts` is the KEPT drop-in for the few remaining renderer sync calls (imported under a legacy `dualSync` alias — name only, not the deleted module).
- **Renderer loop flags:** `isServerOwnedChatLoopEnabled` / `isCloudServerLoopEnabled` and their env/localStorage overrides — DELETED; `serverLoopSettings.ts` now keeps only the token-owner slice.
- **Removed symbols:** `executeToolWithPermissionCheck`, the module-level `pending*Resolve` promises — GONE.
- **Grep trap:** two never-compiled test fixtures (`electron/tools/__tests__/dummyfile.ts.test`, `dummyFilechatAction.ts.test`) are verbatim snapshots of the old deleted code — they still textually contain `claudeCode`, `agent_settings`, `lib/sync/dualSyncManager`, etc. These are fixture inputs, not live code.

## Provider notes

- All 5 providers (`openrouter`, `lmstudio`, `openaichatgpt`, `zai`, `bedrock`) run the server-owned loop. `normalizeProviderRoute` resolves the route; unknown → `openaichatgpt`.
- Only the `openrouter` route is a "cloud route" (CloudMirrorSink + Railway id adoption + free-tier SSE relay); the other 4 stay local-authoritative on `TreeMessageSink`.
- Login/OAuth (Supabase SDK + deep-link redirect), a few Supabase-direct renderer calls (login allowlist, public `updates` bucket, OAuth consent popup) remain renderer/Electron-bound BY DESIGN — not moved.

## Important invariants

- The renderer is a thin client: no server-owned loop control, tool execution, or permission/hook/compaction orchestration in the renderer. The chat thunks require Electron (they throw otherwise).
- `toolAutoApprove` is undefined-by-default and the loop pauses ONLY on an explicit `false` (`!== false` test at `chatOrchestrator.ts:360`). Never coerce absence to `false`.
- `DecisionBroker` key is `${streamId}::${toolCallId}` — `conversationId` is not part of it. Always drain with `rejectAllForStream` in the run's finally.
- Any change to the `HeadlessStreamEvent` union needs a matching renderer projection (`sseProjection.ts`) + mobile/test harness update.
- `appAuthTokenManager` must remain a single process-wide instance; two instances reintroduce the refresh_token race.
- Railway stays authoritative for free-tier metering / Stripe / cloud-DB / `/users`; the server proxies, it does not own them.
- Persistence repos own DB details; routes/services should not scatter SQL. Keep route-level parity with desktop conversation/message tree semantics. For split-channel tool results, persist/stream only compact `persistedContent`; send ephemeral `modelContent` only in continuation history.

## Testing and Validation

```bash
npm --prefix client/ygg-chat-r run test:headless
npm --prefix client/ygg-chat-r run build:electron:main
```

Gateway-flag defaults are asserted in `electron/headlessServer/config/__tests__/gatewayFlags.test.ts` (`{chat:true, tokenOwner:false, crud:false, cloudProxy:false}`, all-true under `YGG_GATEWAY_MODE`). Renderer projection/request builders: `sseProjection.test.ts`, `buildServerLoopRequest.test.ts`.

Manual harness: `http://localhost:<local-server-port>/headless/openai-test` when the local server is running.

## OpenAI Context Usage

- `OpenAiChatgptProvider` normalizes Codex usage and `ToolLoopService` emits a `context_usage` SSE event for every completed OpenAI provider turn.
- Usage snapshots replace one another across full-replay tool continuations; they are not cumulative.
- Assistant messages carry the snapshot in `context_usage` and in a structured content block so local persistence and renderer reloads retain it without changing other-provider behavior.

## Related Docs

- `agent_runtime_modes.md`
- `agent_chat_pipeline.md`
- `agent_local_tools_runtime.md`
- `agent_subagents_orchestration.md`
