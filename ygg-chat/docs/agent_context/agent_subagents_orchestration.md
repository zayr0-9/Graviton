# Agent Context: Subagents Orchestration

Last reviewed: 2026-07-24

## Purpose

Documents the `subagent` tool: a renderer thin client that streams a task to ONE
server-side engine in the headless local server. The engine reuses the main
chat's `ToolLoopService` (per-turn timeouts, split-channel tool results, mid-run
compaction, SSE lifecycle, `streaming_runs` mirroring) so subagents share the
main loop's robustness instead of a separate, flakier implementation.

## When to Open This File

Use this when changing:
- the `subagent` tool dispatch or its request/response contract;
- the server-side subagent engine, its transcript persistence, or its SSE route;
- subagent tool-name resolution, the read-only (auto-approve) gate, or compaction;
- how Heimdall reads subagent transcripts.

## Key Files

- `client/ygg-chat-r/src/features/chats/subagentClient.ts`: thin client — builds the
  request from tool args + Settings, streams SSE, returns the final text. Exports
  `executeSubagentCall`, `abortSubagentControllers`, `resolveSubagentSystemPrompt`.
- `client/ygg-chat-r/src/features/chats/chatActions.ts`: `executeLocalTool` routes
  `name === 'subagent'` to the thin client (parent permission dialog unchanged).
- `client/ygg-chat-r/electron/headlessServer/routes/subagentRoutes.ts`:
  `POST /api/headless/subagent/stream` (SSE + heartbeat + client-disconnect abort).
- `client/ygg-chat-r/electron/headlessServer/services/subagentRunService.ts`: the engine —
  validation, run + `streaming_runs` lifecycle, tool resolution, auth re-sync, the
  counting/read-only tool executor, the transcript compactor, terminal state mapping.
- `client/ygg-chat-r/electron/headlessServer/services/toolLoopService.ts`: shared loop with a
  `MessageSink` port (`messageSink.ts`) plus `signal`, `railwaySessionId`,
  `allowCommentaryFallbackText`, and `robustness` (empty-turn retry + finalization).
- `client/ygg-chat-r/electron/headlessServer/services/subagentTranscriptSink.ts`: `MessageSink`
  that writes subagent turns to the transcript instead of the chat tree.
- `client/ygg-chat-r/electron/headlessServer/persistence/subagentRunRepo.ts`: repo over
  `subagent_runs` / `subagent_messages` (shared by the localServer CRUD routes and the engine).
- `client/ygg-chat-r/electron/localServer.ts`: table DDL + `/api/subagents/*` CRUD routes
  (delegate to `SubagentRunRepo`) that Heimdall polls.
- `shared/builtinToolDefinitions.ts`: the `subagent` tool schema.
- `client/ygg-chat-r/src/helpers/subagentToolSettings.ts`,
  `client/ygg-chat-r/src/helpers/operationModePromptStorage.ts`,
  `client/ygg-chat-r/src/helpers/subagentModelNames.ts`: renderer-held settings the thin
  client reads per request.
- `client/ygg-chat-r/src/components/Heimdall/Heimdall.tsx`: renders subagent badges from the
  transcripts (`GET /api/conversations/:id/subagents`, polled ~3s).

## Data Flow

1. The model calls the `subagent` tool. `executeLocalTool` (after the parent
   permission dialog) calls `executeSubagentCall`.
2. The thin client builds the request from tool args + localStorage settings + Redux
   (system prompt composition, provider/model resolution, tool-name selection,
   `maxTurns`, `autoApprove = inheritAutoApprove && chat.toolAutoApprove`) and POSTs
   to `/api/headless/subagent/stream`.
3. The engine resolves tool names to definitions, creates a `subagent_runs` row and a
   child `streaming_runs` row (`stream_type: 'subagent'`, `parent_stream_id` = parent's
   stream id, `metadata.subagent_run_id`), emits `started`, and persists the user prompt.
4. It runs `ToolLoopService` with a `SubagentTranscriptSink` (turns → `subagent_messages`),
   a counting/read-only tool executor, and a transcript-aware compactor. SSE events stream
   to the client as the loop progresses.
5. On completion the run row is marked `completed` with the stripped final text; the engine
   emits `complete` (result + stats). The thin client returns the final text, which the
   parent loop persists as the `subagent` tool_result.
6. Heimdall reads the transcript via the localServer `/api/subagents/*` routes.

## Important Invariants

- **One loop engine.** Turn control, timeout, split-channel results, compaction, retry,
  and finalization live only in `ToolLoopService`. Subagents differ only in the injected
  `MessageSink` (transcript vs. chat tree) and opt-in `robustness` flags.
- **Transcripts, not the chat tree.** Subagent turns never enter the conversation message
  tree; they go to `subagent_runs` / `subagent_messages`.
- **No nested subagents.** The engine always excludes `subagent` from a subagent's tool set.
- **Auto-approve gate.** With `autoApprove: false`, mutating/unknown tools (write/bash/MCP/
  custom) return a structured "denied: requires auto-approve" tool_result; read-only tools run.
- **Local providers only.** `openrouter` subagents fall back to the default local provider
  client-side and are rejected server-side.
- **Abort = close the SSE connection.** The route aborts an `AbortController` on `res` close;
  the signal is threaded into the provider request and tool jobs; run + `streaming_runs`
  statuses become `aborted`. The client also runs a 60s idle watchdog.
- **Empty output is a typed failure**, never a fake-success "No response generated": the loop
  retries an empty turn once, finalizes when tools ran but produced no answer, and otherwise
  raises `ProviderEmptyResponseError`.
- **Settings travel per request.** The renderer composes the system prompt and selects tools;
  the server stores nothing between runs.

## Testing and Validation

```bash
npm --prefix client/ygg-chat-r run test:headless          # engine, repo, route, tool-loop
npx vitest run src/features/chats/subagentClient.test.ts   # thin client (request + SSE)
npm --prefix client/ygg-chat-r run build:electron:main
```

Manual: trigger a subagent from chat with auto-approve on and off, stop mid-run, and confirm
the Heimdall badge shows the transcript and `subagent_runs.status` ends `completed`/`aborted`.
Curl smoke: `POST /api/headless/subagent/stream` with a valid `conversationId`/`parentMessageId`.

## Related Docs

- `agent_headless_server.md`
- `agent_chat_pipeline.md`
- `agent_heimdall.md`
- `agent_local_tools_runtime.md`
- `agent_context_compaction_memory.md`
