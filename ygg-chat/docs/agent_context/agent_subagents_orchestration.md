# Agent Context: Subagents Orchestration

Last reviewed: 2026-08-01

## Purpose

Documents the `subagent` tool and its server-side engine in the headless local
server (`127.0.0.1:3002`). A subagent runs ONE task through `SubagentRunService`,
which drives the shared `ToolLoopService` (per-turn timeouts, split-channel tool
results, mid-run compaction, SSE lifecycle, `streaming_runs` mirroring).

That same `ToolLoopService` now ALSO powers the main chat loop
(`ChatOrchestrator`, after the headless thin-client migration). It is one engine
with two callers. They diverge only in what each INJECTS, never in the loop body:

- **MessageSink** — subagents use `SubagentTranscriptSink` (transcript rows); the
  main loop uses `TreeMessageSink` / `CloudMirrorSink` (the chat tree).
- **Tool executor** — subagents inject a `countingExecutor` whose gate is a
  STATIC auto-approve check (`assertToolAllowedWithoutAutoApprove`); the main loop
  injects `createChatPausingExecutor`, which PAUSES per tool call via the
  `DecisionBroker` and asks the renderer for a permission / clarify decision. The
  `ToolLoopService` itself has no pause/permission concept — it just awaits
  `executeTool(...)`; both differences live entirely in the injected executor.
- **Optional `ToolLoopRunInput` fields** — main-loop-only behavior (`hooks`,
  `relayFreeTierEvents`, and the cloud sink) is opt-in and left UNSET for
  subagents; subagent-only behavior (`robustness`) is opt-in and left unset for
  the main loop. Every new field defaults off, so the subagent path through the
  engine is byte-for-byte the same as before the main-loop migration.

## When to Open This File

Use this when changing:
- the `subagent` tool dispatch or its request/response contract;
- the server-side subagent engine, its transcript persistence, or its SSE route;
- subagent tool-name resolution, the read-only (auto-approve) gate, or compaction;
- the shared `ToolLoopService` — verify a change gated behind an optional field
  does not alter the default (subagent) path (see `toolLoopService.test.ts`);
- how Heimdall reads subagent transcripts.

## Key Files

- `client/ygg-chat-r/electron/headlessServer/services/toolLoopService.ts`: the SHARED
  loop engine. `MessageSink` port + `ToolExecutor` port; opt-in `ToolLoopRunInput`
  fields (`robustness`, `hooks`, `relayFreeTierEvents`, `signal`,
  `railwaySessionId`, `allowCommentaryFallbackText`). No permission/pause logic here.
- `client/ygg-chat-r/electron/headlessServer/services/subagentRunService.ts`: the subagent
  caller of the engine — `run`/`runForTool`, validation, run + `streaming_runs` lifecycle, tool
  resolution, provider auth re-sync (`refreshProviderTokens`), the `countingExecutor`
  (static read-only/auto-approve gate + tool-call counting), the transcript
  compactor, and terminal-state mapping. Sets `robustness:{ retryEmptyTurn,
  finalizeOnSilentToolEnd }`; leaves `hooks`/`relayFreeTierEvents` unset.
- `client/ygg-chat-r/electron/headlessServer/services/chatOrchestrator.ts`: the OTHER
  caller of the engine (main chat loop). `createChatPausingExecutor` is the
  main-loop counterpart to `countingExecutor` — same `ToolExecutor` port, but it
  pauses via the `DecisionBroker` (permission_required / clarify_required) instead
  of the static gate. Included here for contrast; not part of the subagent path.
- `client/ygg-chat-r/electron/headlessServer/services/decisionBroker.ts`: the main-loop
  pause/resume registry (keyed `${streamId}::${toolCallId}`). NOT used by
  subagents — subagents never pause for an interactive decision.
- `shared/operationModeToolPolicy.ts`: `assertToolAllowedWithoutAutoApprove` (the
  subagent auto-approve gate — `AUTO_APPROVE_REQUIRED_TOOL_NAMES` + all MCP/custom
  tools) and `filterToolsForOperationMode` (plan-mode tool filter, shared with the
  main loop).
- `client/ygg-chat-r/electron/headlessServer/services/subagentToolExecutor.ts`:
  `createSubagentDispatchExecutor`, the parent-chat composite executor that intercepts
  `subagent` and calls `SubagentRunService.runForTool` in-process; all other tools
  delegate to the leaf `ToolOrchestrator` executor.
- `client/ygg-chat-r/electron/headlessServer/routes/subagentRoutes.ts`:
  `POST /api/headless/subagent/stream` (SSE + heartbeat + client-disconnect abort;
  rejects `openrouter` before opening the stream).
- `client/ygg-chat-r/electron/headlessServer/services/subagentTranscriptSink.ts`:
  `MessageSink` that writes subagent turns to the transcript instead of the chat tree.
- `client/ygg-chat-r/electron/headlessServer/persistence/subagentRunRepo.ts`: repo over
  `subagent_runs` / `subagent_messages` (shared by the localServer CRUD routes and the engine).
- `client/ygg-chat-r/electron/headlessServer/contracts/headlessApi.ts`:
  `HeadlessSubagentStreamRequest` + `HeadlessSubagentStreamEvent` (subagent
  `started`/`complete`/`error`, plus the reused main-chat `HeadlessStreamEvent`s).
- `client/ygg-chat-r/electron/headlessServer/index.ts`: wiring — the leaf
  `executeToolViaOrchestrator` is injected into `SubagentRunService`; the main
  `ChatOrchestrator` receives `createSubagentDispatchExecutor({ leafExecutor,
  subagentRunner })`. This separation prevents nested subagents while keeping
  ordinary tools on the shared orchestrator.
- `client/ygg-chat-r/electron/localServer.ts`: table DDL (`subagent_runs` /
  `subagent_messages`) + `/api/subagents/*` and `/api/conversations/:id/subagents`
  CRUD routes (delegate to `SubagentRunRepo`) that Heimdall polls.
- `client/ygg-chat-r/src/features/chats/subagentClient.ts`: renderer thin client.
  Exports `executeSubagentCall`, `abortSubagentControllers`,
  `resolveSubagentSystemPrompt`. NOTE: after the thin-client cutover only
  `abortSubagentControllers` has a live caller (`chatActions.ts` `abortGeneration`);
  `executeSubagentCall` no longer has a production caller (see Dispatch status).
- `shared/builtinToolDefinitions.ts`: the `subagent` tool schema.
- `client/ygg-chat-r/src/helpers/subagentToolSettings.ts`,
  `client/ygg-chat-r/src/helpers/operationModePromptStorage.ts`,
  `client/ygg-chat-r/src/helpers/subagentModelNames.ts`: renderer-held settings the thin
  client reads per request.
- `client/ygg-chat-r/src/components/Heimdall/Heimdall.tsx`: renders subagent badges from the
  transcripts (`GET /api/conversations/:id/subagents`, polled ~3s).

## Data Flow

1. **Entry point** — `POST /api/headless/subagent/stream` (`subagentRoutes.ts`):
   validates the body (`conversationId`/`parentMessageId`/`prompt`; rejects
   `openrouter`), opens SSE + heartbeat, wires an `AbortController` to `res` close,
   and calls `SubagentRunService.run(request, emit, signal)`.
2. `SubagentRunService.run` refreshes provider auth, resolves the requested tool
   names to definitions (always excluding `subagent`; plan mode additionally applies
   `filterToolsForOperationMode`), creates a `subagent_runs` row and a child
   `streaming_runs` row (`stream_type:'subagent'`, `parent_stream_id` = parent's
   stream id, `metadata.subagent_run_id`), emits `started`, and persists the user
   prompt as the first transcript row.
3. It runs the shared `ToolLoopService` with a `SubagentTranscriptSink`, the
   `countingExecutor` (static read-only/auto-approve gate wrapping the shared base
   `executeToolViaOrchestrator`), a transcript-aware compactor, and opt-in
   `robustness`. SSE `HeadlessStreamEvent`s stream to the client as the loop runs.
4. On success the run row is marked `completed` with the stripped final text; the
   engine emits `complete` (result + stats). Abort / provider-error / empty-response
   map to `aborted` / `error` on both the run row and `streaming_runs`, with the
   matching terminal SSE event.
5. Heimdall reads the transcript via the localServer `/api/subagents/*` +
   `/api/conversations/:id/subagents` routes.

### Dispatch status (how the `subagent` tool is invoked)

Both entry paths now share the server-side `SubagentRunService`:

- Direct callers POST `POST /api/headless/subagent/stream`; the route projects the
  service lifecycle onto SSE.
- Parent chat tool calls go through `createSubagentDispatchExecutor`
  (`services/subagentToolExecutor.ts`). It intercepts `subagent` before the ordinary
  `ToolOrchestrator` registry, builds a child request from the parent tool context,
  and awaits `SubagentRunService.runForTool` in-process. The returned final text is
  the parent loop's tool result.
- Ordinary parent tools and child leaf tools use `executeToolViaOrchestrator`.
  Both paths also have the in-process `multi_call` composite available; each nested
  child call re-enters the subagent approval/operation-mode policy before leaf execution.
  `multi_call` rejects nested `multi_call` and `subagent`, and `SubagentRunService`
  never receives the parent subagent dispatcher, so recursive agents remain impossible.
- Parent operation mode, stream/message/tool-call lineage, root path, provider/model,
  abort signal, and auto-approve policy are forwarded. `orchestratorMode:true` uses
  the requested child tool names; otherwise the server default child tool set is used.
  OpenRouter parents fall back to the local ChatGPT subagent provider, matching the
  retained renderer client's local-only rule.

The old renderer dispatcher remains deleted. `subagentClient.executeSubagentCall`
is retained for direct renderer/SSE use and tests, but the server-owned main loop
does not round-trip through the renderer or the unfinished `tool_request` bridge.

## Important Invariants

- **One loop engine, injected differences.** Turn control, timeout, split-channel
  results, compaction, retry, and finalization live only in `ToolLoopService`.
  Subagents vs. the main loop differ ONLY in the injected `MessageSink`, the
  injected `ToolExecutor`, and which optional `ToolLoopRunInput` fields are set —
  never in a branch inside the loop.
- **Static auto-approve gate, no pause.** The subagent `countingExecutor` decides
  synchronously: with `autoApprove:false`, mutating/unknown tools (write/delete/
  bash/powershell/MCP/custom, per `AUTO_APPROVE_REQUIRED_TOOL_NAMES`) throw a
  structured "denied: requires auto-approve" error that the loop turns into an
  `is_error` tool_result; read-only tools run. Subagents NEVER use the
  `DecisionBroker` and never emit `permission_required`/`clarify_required`.
- **Transcripts, not the chat tree.** Subagent turns go to `subagent_runs` /
  `subagent_messages` via `SubagentTranscriptSink`; they never enter the
  conversation message tree.
- **No nested subagents.** The engine always excludes `subagent` from a subagent's tool set.
- **Local providers only.** `openrouter` subagents fall back to the default local
  provider client-side and are rejected server-side (`subagentRoutes.ts`).
- **Abort = close the SSE connection.** The route aborts an `AbortController` on
  `res` close; the signal threads into the provider request and tool jobs; run +
  `streaming_runs` statuses become `aborted`. The client also runs a 60s idle watchdog.
- **Empty output is a typed failure**, never a fake-success "No response generated":
  the loop retries an empty turn once, finalizes when tools ran but produced no
  answer, and otherwise raises `ProviderEmptyResponseError`.
- **Settings travel per request.** The caller composes the system prompt and selects
  tools; the server stores nothing between runs.

## Testing and Validation

```bash
npm --prefix client/ygg-chat-r run test:headless          # engine, repo, route, tool-loop
npx vitest run src/features/chats/subagentClient.test.ts   # thin client (request + SSE)
npm --prefix client/ygg-chat-r run build:electron:main
```

Manual: trigger the engine (currently via a direct `POST /api/headless/subagent/stream`
with a valid `conversationId`/`parentMessageId`, or through whatever dispatcher is
wired) with auto-approve on and off, stop mid-run, and confirm the Heimdall badge
shows the transcript and `subagent_runs.status` ends `completed`/`aborted`.

## Related Docs

- `agent_headless_server.md`
- `agent_chat_pipeline.md`
- `agent_heimdall.md`
- `agent_local_tools_runtime.md`
- `agent_context_compaction_memory.md`
