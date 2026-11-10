---
paths:
  - "client/ygg-chat-r/server/headlessServer/**"
  - "shared/headlessApi.ts"
---

# Agent Context: Headless Server

Last reviewed: 2026-11-10 (fully-local migration)

## Purpose

Documents the local **headless Express server** (`http://127.0.0.1:3002`) that runs inside the Electron main process. After the "headless main agent loop" migration (branch `feat/headless-agent-loop`, Phases 0–6, live), this server OWNS the main chat agent loop for every provider route (`openaichatgpt`, `openrouterbyok`, `lmstudio`, `zai`, `bedrock`; Claude Code uses its own session backend) — not just subagents. It also owns pause/resume (permission + plan clarify), in-process Ygg hooks, server-side compaction, and the local data gateway (`/api/gw/*`). Graviton is fully local: there is no hosted backend, cloud proxy or account session.

The React renderer is now a **thin client**: it POSTs the SSE chat routes here and projects server events onto the existing Redux `streamChunk` vocabulary. It keeps no loop control, no tool execution, and no permission/hook/compaction orchestration. The thunks require a host client (Electron, or the browser-client/standalone targets served by the host).

## When to Open This File

Use this when changing:
- the `/api/conversations/*` SSE chat routes or the server-owned chat loop;
- pause/resume (`DecisionBroker`, `POST /api/resume`);
- in-process chat hooks (`chatHookService`);
- server-side compaction (`compactionService`);
- the local data gateway (`/api/gw/*`, a facade over `/api/app/*`);
- ChatGPT (Codex) credential handling (`server/auth/runtime.ts`, see `agent_auth.md`);
- detach/reattach of runs (`runSessionRegistry`, `/api/streams/*`);
- the `HeadlessStreamEvent` SSE union (any change needs matching renderer projection + mobile/test updates);
- headless provider support or the shared `ToolLoopService`.

## Key Files

Wiring root:
- `client/ygg-chat-r/server/headlessServer/index.ts` — `registerHeadlessServerRoutes` builds the shared graph: one process-wide `DecisionBroker`; the leaf `executeToolViaOrchestrator` (submit→poll `toolOrchestrator`, timeout/cancel support) used by ordinary and child tools; one shared `SubagentRunService`; and a main-chat `createSubagentDispatchExecutor` that intercepts `subagent` in-process before delegating other names to the leaf executor. `ChatOrchestrator` is wired with that composite executor, `defaultToolsProvider: resolveDefaultInferenceTools`, compaction and hooks. Resumable runs are always on; the request guard rejects unknown provider names with 400.

Chat loop engine:
- `services/chatOrchestrator.ts` — `ChatOrchestrator.runMessage` (main entry). Builds a fresh per-run `ToolLoopService`, chooses the message sink, wires the pausing executor + hook session, and finishes/aborts the run. `createChatPausingExecutor` (`chatOrchestrator.ts:95`) is the per-run tool wrapper; `ALWAYS_BYPASS_TOOLS` (`chatOrchestrator.ts:47`) = `skill_manager, multi_call, context_status`; MCP discovery/management actions also bypass, but `mcp_manager invoke` requires normal approval.
- `services/branchOrchestrator.ts` — `BranchOrchestrator.resolve` computes continuation/branch semantics (`historyLeafId`, `assistantParentId`, `userContentForInference`) and persists the user message.
- `services/toolLoopService.ts` — shared assistant tool-call continuation loop. Persists via an injectable `MessageSink`; supports abort, per-run `maxTurns`, empty-turn retry + finalization, in-loop compaction, and `input.hooks` (`foldSystemPrompt`/`hookContext`/`runStop`). Same engine that serves subagents; new main-loop behavior is gated on optional `ToolLoopRunInput` fields.
- `services/decisionBroker.ts` — pause/resume registry (see below).
- `services/chatHookService.ts` — in-process Ygg hooks (see below).
- `services/compactionService.ts` — summary generation + `__auto_compaction_summary__` persistence (`AUTO_COMPACTION_NOTE`, `compactionService.ts:4`).
- `services/messageSink.ts` — `TreeMessageSink` (the only main-chat sink; mints local ids).
- `services/providerRouter.ts` — `resolveProviderRoute` (strict; unknown → `null`, rejected with 400 / `UnknownProviderError`), lenient `normalizeProviderRoute` for classification, and the legacy alias `openrouter` → `openrouterbyok`.
- `providers/providerTypes.ts` — the shared provider contract (`ProviderGenerateInput`, `ProviderTurnContext` as `turnContext`, `attachPartialOutput`, `HeadlessProvider`).
- `persistence/streamingRunRepo.ts` — durable `streaming_runs` lifecycle rows (`upsert` mints/reuses `streamId`, `finish` writes terminal status).

Data gateway + run sessions:
- `routes/gatewayRoutes.ts` — `/api/gw/*` local facade over `/api/app/*` (and SQLite for attachments); see below.
- `routes/lineageRoutes.ts` — lineage reads mounted under `/api/gw/*`.
- `services/runSessionRegistry.ts` — per-`streamId` `RunSession` (seq'd event buffer + attach/detach + run-owned abort) enabling detach/reattach (§Detach/Reattach). Always on.

Subagents / other:
- `services/subagentRunService.ts` + `services/subagentToolExecutor.ts` + `routes/subagentRoutes.ts` — the shared subagent engine, the parent-chat in-process dispatcher, and the direct `POST /api/headless/subagent/stream` SSE route (see `agent_subagents_orchestration.md`). Reuses `ToolLoopService`.
- `shared/headlessApi.ts` — `HeadlessMessageRequest`, `HeadlessStreamEvent` union (§SSE below), `HeadlessSubagentStreamEvent`.
- `providers/*`, `stream/*` (SSE writer), `ui/mobile/src/*` (mobile LAN UI), `README.md`, `HEADLESS_API_GUIDE.md`.

## Server API map

Routes use the resolved local server origin (preferred `http://127.0.0.1:3002`, with fallback ports); the renderer resolves them via `buildLocalApiUrl` (`DEFAULT_LOCAL_SERVER_ORIGIN = 'http://127.0.0.1:3002'`, `src/utils/api.ts:10`).

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
- **`GET /api/streams/:streamId`** + **`POST /api/streams/:streamId/abort`** — resubscribe / explicit-cancel (always available); see §Detach/Reattach.

Each SSE request creates one `AbortController`. In the **legacy** path it is aborted on `res.on('close')`, so a dropped client cancels in-flight provider/tool work AND unblocks a loop paused on a decision. In production the route uses a run session, so a close instead **DETACHES** and the run keeps going (§Detach/Reattach).

### Data gateway — `routes/gatewayRoutes.ts` (`/api/gw/*`)
The renderer's data surface for **conversations, projects, messages, attachments, research notes**. Every route forwards over in-process loopback to the local `/api/app/*` routes (byte-for-byte reuse) and translates the renderer's canonical camelCase bodies to local snake_case. `GET /api/gw/conversations/:id/messages/tree` calls `buildConversationMessagesTreePayload` (`appAutomationRoutes.ts`) directly because it is the hot read refetched on every stream end. `/paginated` is real offset paging (`limit`/`cursor`). Attachment reads/links/unlinks use SQLite statements directly; `GET /api/gw/attachments/:id` returns 404 when missing. Legacy `?storageMode=` hints are ignored. New conversations are created with `storage_mode='local'` (the column default is `'cloud'` and list queries filter `'local'`).

### Other route modules (unchanged by this migration)
`crudRoutes` (`/api/app/*` local SQLite CRUD — the gateway's target), `providerAuthRoutes`, `mobileUiRoutes`, `customToolsRoutes`, `customToolRpcRoutes`, `capabilityRoutes`, `ephemeralGenerateRoutes`, `testHarnessRoutes`, `subagentRoutes`.

## Orchestration (`ChatOrchestrator.runMessage`)

Data flow, in order:
1. Load conversation (throws if missing), touch conversation + project.
2. Build `hookSession` iff `hookRunner && request.hooksEnabled === true && decisionBroker`.
3. **UserPromptSubmit** hook runs *before* persisting the user message (`send`/`branch`/`edit-branch` only); may rewrite `request.content` or block → run finishes `error`.
4. `resolveExecution` → `BranchOrchestrator.resolve` persists the user message (except `repeat`).
5. `streamingRunRepo.upsert(...)` → final `trackedStreamId`.
6. `decisionBroker.initSession(trackedStreamId, { autoApproveAll: request.toolAutoApprove !== false })` (`chatOrchestrator.ts:360`) — **default auto-approve; ordinary tool-permission prompts occur only when a caller explicitly sends `toolAutoApprove: false`.** The mobile LAN UI never sends it, so ordinary tool permissions auto-approve; clarify and mode-upgrade decisions remain separate interactive channels.
7. Emit `started`, `user_message_persisted` (if any), `provider_routed`.
8. Build history, resolved tools (`filterToolsForOperationMode`), and system prompt (server-assembled; the renderer deliberately omits `systemPrompt`).
9. Per-run loop build: fresh `ToolLoopService` with `sink = TreeMessageSink`, `executeTool = createChatPausingExecutor(...)`, and `input.hooks = hookSession.toolLoopHooks()`.
10. `loop.run(input, emit)`. Each provider attempt receives a child abort signal and
    an activity-based idle timer (180-second default) that is rearmed by provider stream
    events. Continuous streaming is therefore not cut off by total elapsed time. A true
    idle timeout fences/aborts the attempt and persists the loop-owned streamed snapshot
    before error handling; parent cancellation preserves a non-empty snapshot without an
    ErrorBlock. Attempts that already exposed renderable output are not retried.
11. Success finishes the ledger and emits `complete`. Provider-error-as-assistant-response finishes with error status and emits `complete { providerError:true }` pointing at the persisted error row when available. Abort finishes as `aborted` and emits terminal `error` with a cancellation envelope, without persisting an ErrorBlock. Other failures publish one classified terminal `error` and rethrow marked as already published, preventing duplicate route errors. Finally, `decisionBroker.rejectAllForStream(trackedStreamId)` drains decisions/session.

Signal threading: one `AbortController` per SSE request → `runMessage(…, signal)` → pausing executor uses `context.signal ?? signal` for `broker.requestDecision` (disconnect rejects the paused promise) and `loop.run` gets `input.signal` (checked each turn / before each tool, forwarded to the provider). Abort is classified by `isAbortError` (`name === 'AbortError'`).

## Pause/Resume (`DecisionBroker` + `POST /api/resume`)

The loop pauses mid-turn to ask the renderer for a tool-permission or `plan_md` clarify decision.

- **Key** (`decisionBroker.ts:54`): `` `${streamId}::${toolCallId}` `` — `conversationId` is NOT part of the key; one pending decision per (stream, toolCall).
- **Where it pauses:** inside `createChatPausingExecutor` (`chatOrchestrator.ts:95`), per tool call, *before* delegating to the base executor — `await broker.requestDecision({ streamId, toolCallId, signal })`. `ToolLoopService` itself has no pause concept. Pause is skipped when `broker.isAutoApproveAll(streamId)` or the tool is bypassed (`ALWAYS_BYPASS_TOOLS`, plus `custom_tool_manager` non-`invoke` actions).
- **SSE decision events** emitted by the pausing executor before awaiting: `permission_required` `{streamId, toolCallId, toolName, toolInput}` and `clarify_required` `{streamId, toolCallId, toolName, questions}` (the latter for `plan_md action==='clarify'`, intercepted and routed through the broker's clarify channel).
- **`POST /api/resume`** (`chatRoutes.ts:146`, plain JSON): requires `streamId` + `toolCallId` (400 otherwise). Decoding: `body.decision` string → permission (`allow_once | allow_always | deny`); `body.answers`/`body.cancelled` → clarify; `body.result`/`body.error` → tool-bridge decision (future). `decisionBroker.resolve(...)` → 200 `{success:true}` if matched, else **409**.
- Wrapper handling: `deny` → throw (`is_error` tool_result); `allow_always` atomically promotes the stream and releases every permission waiter already parked for that stream (parallel `multi_call` workers included), while leaving clarify/operation-mode waits interactive; `allow_once` → execute.
- Renderer side: the 4 resolver thunks (`respondToToolPermission`, `respondToToolPermissionAndEnableAll`, `respondToPlanClarification`, `cancelPlanClarification`) POST `/api/resume` via `postDecisionResume`; the old module-level `pending*Resolve` promises are **deleted**.

## Detach / reattach — resumable runs (always on)

`services/runSessionRegistry.ts` decouples a run's lifetime from its SSE socket. `runSseOrchestrator` (`chatRoutes.ts`) routes `emit` through a per-`streamId` `RunSession` instead of writing straight to `res`, and the **session** (not `res.on('close')`) owns the `AbortController`:

- **A bare client disconnect DETACHES** (`res.on('close') → session.detach`) — the loop keeps running in the Electron main process; it no longer aborts.
- The session buffers every event with a monotonic `seq` (bounded ring buffer), fans out to at most one attached subscriber (last-attach-wins), and lingers after a terminal event so a late reconnect still receives the tail.
- **`GET /api/streams/:streamId?fromSeq=N`** — resubscribe: attach, replay buffered frames with `seq > N`, then stream live. Because `permission_required` / `clarify_required` frames are in the buffer, a **parked decision re-surfaces on replay for free** (no broker change). `410 Gone` when the run was already evicted → the client reloads persisted messages. `seq` rides on each SSE frame as the replay cursor (append-style chunk projection is only idempotent with it).
- **`POST /api/streams/:streamId/abort`** — explicit client cancellation (disconnect detaches; the reaper, explicit replacement, and process shutdown can also stop runs). Aborting the session signal also unblocks any paused decision via the existing signal→broker path.
- **Reaper** (`registry.startReaper`, started by default): evicts terminal sessions after
  one minute and cancels+evicts still-running sessions detached for five minutes. The
  event buffer is capped at 20,000 frames. **App quit kills every session** (in-memory) —
  the accepted ceiling; there is no cross-restart durability.
- Sessions accept one subscriber and use last-attach-wins semantics; renderer per-stream
  reader ownership prevents route remounts from replacing a surviving subscriber.
- A repeated POST that reuses an existing `streamId` is treated as an idempotent re-attach to the existing session; it must never start a second orchestrator run. The registry also exposes abort-before-replace for explicit replacement callers. Never restore delete-without-abort: it orphaned branch runs outside abort, reattach, and reaper reachability.
- The legacy disconnect-aborts path remains only for requests without a stream id/session
  (tests and direct callers); the `gateway.resumableRuns` opt-out flag is removed.
- Renderer counterpart: `mainChatClient.ts` (in-session resubscribe + `postStreamAbort`) + `resumeInFlightStreams` (mount-time re-attach after a reload) + `inflightStreams.ts` (localStorage tracking) — see `agent_chat_streaming_state.md`.

## In-process chat hooks (`chatHookService.ts`)

`createChatHookSession` runs eight lifecycle events in-process in the server. Lineage/metadata are rebuilt from `ConversationRepo.listMessageLineage` per call, but only once the runner has matched a handler (`HookRunRequest.resolveLineage`); an event with no hook never reads the conversation. Awaited `additionalContext` is buffered into transcript context injections: prompt/session output on the user message, tool-hook output on tool results, Stop output on continuation. Main chat sets `hookContextPlacement: 'transcript'`; system-prompt folding is an explicit legacy alternative.

1. **UserPromptSubmit** — before user-message persistence (`send`/`branch`/`edit-branch`); returns the effective prompt; `blocked` → throw (run finishes `error`). Carries `project`.
2. **PreToolUse** — in the pausing executor BEFORE any permission prompt/clarify; `updatedInput` rewrites the tool arguments; `permissionDecision === 'deny'` → throw (→ `is_error` tool_result).
3. **PostToolUse** — success path after execute; payload `toolResult`.
4. **PostToolUseFailure** — catch path, but **NOT on abort** (aborts rethrow unwrapped); fires on PreToolUse deny AND permission deny.
5. **Stop** — the loop calls `input.hooks.runStop` on a natural stop; `blocked === true` forces one more turn (empty user turn parented on the just-persisted assistant), appending the reason to `hookContext`.

6. **SessionStart** — `startup` when launch context is built and `compact` after automatic compaction.
7. **PreCompact** — before automatic compaction.
8. **InstructionsLoaded** — loader notification dispatched without awaiting completion.

Markdown auto-memory is loaded independently by `ConversationContextLoader` from the cwd-based `MEMORY.md` index. Legacy aggregate-memory injection and its background writer are retired.

## Compaction

Two paths, both via `CompactionService.compactBranch`, which persists a `role:'system'`, `note:'__auto_compaction_summary__'` message:
- **In-loop (auto):** runs inside `ToolLoopService.run` at the quiescent boundary after a tool-executing turn (OpenAI/Codex continuation policy). Emits `context_compaction` `threshold_reached`→`started`→`completed`; a successful summary replaces pre-compaction replay history and becomes the next parent. Failure emits `failed` + throws (recorded `endReason: 'error'`, code `compaction_failed`). The renderer no longer orchestrates in-loop compaction.
- **Manual button / renderer prechecks:** the renderer `compactBranch` thunk POSTs `POST /api/conversations/:id/compact`. `CompactionService.compactBranch` generates and persists the system summary before returning its server-assigned ID.

## Message sink (`messageSink.ts`)

Every main-chat run persists through `TreeMessageSink`, which mints local message ids (it never adopts provider ids). Subagents use `SubagentTranscriptSink`. Identity and ChatGPT credentials: see `agent_auth.md`.

## Selected SSE events (`HeadlessStreamEvent`, `shared/headlessApi.ts`)

Historical core summary (migration additions marked **NEW**). This is not
exhaustive: the shared contract also defines queued-message, operation-mode,
context-injection, hook-activity, tools-updated and notice events and
classified terminal envelopes. Use `shared/headlessApi.ts` as the authoritative union.

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
16. `complete` `{message, providerError?}`
17. `error` `{error, provider?, modelName?, retryExhausted?, status?, errorType?, resetAt?, assistantMessage?}`

The retired free-tier/reauth frames (`free_generations_update`, `generation_limit_reached`, `reauth_required`) are no longer part of the union. A separate `HeadlessSubagentStreamEvent` union (`headlessApi.ts:93`) extends this with subagent-specific `started`/`complete`/`error` shapes.

## Renderer thin client (pointer)

The renderer's 3 chat thunks (`sendMessage`, `editMessageWithBranching`, `sendMessageToBranch`) live in `src/features/chats/chatActions.ts` (thin-client thunks). They build the request with `buildServerLoopRequest` (`src/features/chats/buildServerLoopRequest.ts:104`), drive the SSE stream with `runServerChatLoop` (`src/features/chats/mainChatClient.ts:52`, plain `fetch` + `getReader()` — no `EventSource`), and project each server event onto existing Redux reducers via the pure `projectServerEvent` (`src/features/chats/sseProjection.ts:92`). The renderer keeps the optimistic user bubble, the permission/clarify dialogs (existing reducers unchanged), stream-lifecycle scaffolding, `streamRunTracking.ts` (KEPT, live callers), and the manual `compactBranch` thunk. CRUD/attachments are renderer-issued through `gwApi`/`localApi` (`src/utils/api.ts`), which both hit the local host.

## Retired / removed (do not reference as live)

- **Claude Code:** `electron/tools/claudeCode.ts` + its localServer routes + CC thunks/types/reducers/`selectCCSlashCommands` — GONE.
- **GlobalAgentLoop (GAL):** `services/GlobalAgentLoop.ts`, `GlobalAgentBootstrap.tsx`, `hooks/useGlobalAgentCache.ts`, `hooks/useGlobalAgentMessages.ts`, `helpers/agentSettingsStorage.ts`, GAL localServer routes, `agent_*` DB tables — GONE.
- **Cloud layer (fully-local migration, 2026-11):** the hosted OpenRouter provider, `/api/cloud/*` proxy, `railwayClient`, `appAuthTokenManager`, `cloudMirrorService`/`CloudMirrorSink`, gateway feature flags, `/api/sync/*`, renderer `dualSyncManager`/`lib/sync`/`localMirror`, free-tier events and the Supabase app session — GONE.
- **Renderer loop flags:** `isServerOwnedChatLoopEnabled` / `isCloudServerLoopEnabled` and their env/localStorage overrides — DELETED; `serverLoopSettings.ts` keeps resumable-run settings.
- **Removed symbols:** `executeToolWithPermissionCheck`, the module-level `pending*Resolve` promises — GONE.
- **Grep trap:** two never-compiled test fixtures (`server/tools/__tests__/dummyfile.ts.test`, `dummyFilechatAction.ts.test`) are verbatim snapshots of the old deleted code — they still textually contain `claudeCode`, `agent_settings`, `lib/sync/dualSyncManager`, etc. These are fixture inputs, not live code.

## Provider notes

- Routes: `openaichatgpt` (Codex/ChatGPT OAuth), `openrouterbyok` (user's own OpenRouter key, direct to openrouter.ai), `lmstudio`, `zai`, `bedrock`; Claude Code runs on its session backend. All local-authoritative on `TreeMessageSink`.
- The legacy name `openrouter` (the retired hosted route) is an alias for `openrouterbyok`. Unknown names are rejected (400 `unknown provider "x"`).

## Important invariants

- The renderer is a thin client: no server-owned loop control, tool execution, or permission/hook/compaction orchestration in the renderer. The chat thunks require a host client.
- `toolAutoApprove` is undefined-by-default and ordinary permission prompts occur only on an explicit `false` (`!== false` test at `chatOrchestrator.ts:360`). Never coerce absence to `false`.
- `DecisionBroker` key is `${streamId}::${toolCallId}` — `conversationId` is not part of it. Always drain with `rejectAllForStream` in the run's finally.
- Any change to the `HeadlessStreamEvent` union needs a matching renderer projection (`sseProjection.ts`) + mobile/test harness update.
- ChatGPT credential ownership/refresh serialization stays in the process-wide `AuthSessionManager` (codex slot only).
- Graviton has no hosted backend; the only remote services are user-configured providers/MCP servers, the anonymous app-store listing and the GitHub update feed.
- Persistence repos own DB details; routes/services should not scatter SQL. Keep route-level parity with desktop conversation/message tree semantics. For split-channel tool results, persist/stream only compact `persistedContent`; send ephemeral `modelContent` only in continuation history.

## Testing and Validation

```bash
npm --prefix client/ygg-chat-r run test:headless
npm --prefix client/ygg-chat-r run build:electron:main
```

Gateway: `gatewayRoutes.normalizers.test.ts`, `gatewayRoutes.attachments.test.ts`. Renderer projection/request builders: `sseProjection.test.ts`, `buildServerLoopRequest.test.ts`.

Manual harness: `http://localhost:<local-server-port>/headless/openai-test` when the local server is running.

## OpenAI Context Usage

- `OpenAiChatgptProvider` normalizes Codex usage and `ToolLoopService` emits a `context_usage` SSE event for every completed OpenAI provider turn.
- Provider liveness is separate from client SSE liveness: server heartbeat comments keep
  the renderer connection alive, while only provider events rearm the provider-turn idle
  timeout. Timeout aborts the child provider attempt, not the run-wide signal, so a silent
  attempt with no visible output may still use the configured transient retry policy.
- Usage snapshots replace one another across full-replay tool continuations; they are not cumulative.
- Assistant messages carry the snapshot in `context_usage` and in a structured content block so local persistence and renderer reloads retain it without changing other-provider behavior.

## Related Docs

- `agent_runtime_modes.md`
- `agent_chat_pipeline.md`
- `agent_local_tools_runtime.md`
- `agent_subagents_orchestration.md`

## Shared-client migration overrides (2026-10-19)

Historical single-subscriber/idle-reaper/opt-out statements above are superseded. Production host resumability is mandatory; viewers detach independently and never cancel execution by disappearing. The reaper evicts terminal payloads only. Shared source builds serve attached browsers without making the host a separate web product.

`runAdmissionService.ts` and `operationReceiptRepo.ts` own JSON ordinary-send acceptance and durable retry tombstones. Compatible active-lineage sends queue, access-policy changes require acknowledgement, and interrupted commands are not replayed after restart. `runSnapshotProjector.ts` provides main-run bootstrap at S with exact host revisions and current decisions/queue. Fresh reducers cannot reuse only a persisted cursor. `DecisionBroker` registers before emitting prompts and broadcasts metadata-only settlements to all run readers. Receipt outcome recording is independent of projector failures.

Child/oversized snapshot support, full settings/iframe parity and mobile retirement remain incomplete. Runtime still advertises `sharedRuns:false`; see `../shared-ui-implementation-status.md` for acceptance limits and actual validation.

## Snapshot payload and receipt continuation

Current turn events spill through `SnapshotEventJournal` into private server-temp scratch with a process-wide 512 MiB budget. Immutable prefix leases supply bounded parts for bootstrap and large individual events; viewers detach while hydrating then replay above S. Capacity errors do not cancel execution. Main bootstrap includes exact rows/deletion IDs; child bootstrap includes its persisted transcript and current tail. Scratch is disposed on host stop/terminal eviction; confirmed-dead PID directories are reclaimed. Decision receipts are kind-scoped (upgrade and approval may share a tool-call ID); migrations 10–11 preserve prototype receipts. Compact retry tombstones are not pruned into permission to reexecute old commands.

## Claude session execution backend (v1)

`Claude Code` main chats bypass ToolLoopService after shared admission/lineage setup. `services/claudeSessionService.ts` uses the version-pinned Agent SDK with the installed CLI, projecting native transcript/tool events into the existing message tree/SSE contract. Migration 12 persists branch session identity and exact native checkpoints. Provider is locked after first accepted input (the Claude model may change between turns); completed response checkpoints support native historical forks. Claude owns tools/context/compaction; Graviton tools and context injection are not supported on this backend. Queued input goes to the live session through `ClaudeQueuedInput` and becomes a user row only when Claude starts it (see `../claude-provider-v1.md` § Queued input). Configured Graviton Stop side-effect hooks run after successful native response persistence, with explicit user-turn identity and shared activity/diagnostics; other hook lifecycles and Stop-driven native continuation remain unsupported. SDK native permission requests honor the accepted Graviton Ask / Allow all policy through DecisionBroker; Allow all can promote a pending run without enabling SDK permission bypass. See `../claude-provider-v1.md` for scope, storage, recovery and live smoke.
