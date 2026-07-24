# Agent Context: Headless Server

Last reviewed: 2026-06-16

## Purpose

Documents the extracted headless server under Electron local server: chat APIs, provider routing, persistence repos, SSE events, tool loop, and mobile LAN UI.

## When to Open This File

Use this when changing:
- `/api/headless/*` routes;
- server-side chat orchestration;
- headless provider support;
- server-side tool loop behaviour;
- mobile LAN UI served by headless server.

## Key Files

- `client/ygg-chat-r/electron/headlessServer/README.md`: status and current phase notes.
- `client/ygg-chat-r/electron/headlessServer/HEADLESS_API_GUIDE.md`: API guide.
- `client/ygg-chat-r/electron/headlessServer/index.ts`: headless server composition.
- `client/ygg-chat-r/electron/headlessServer/routes/*`: route modules.
- `client/ygg-chat-r/electron/headlessServer/services/chatOrchestrator.ts`: main server-side chat orchestration.
- `client/ygg-chat-r/electron/headlessServer/services/branchOrchestrator.ts`: continuation/branch semantics.
- `client/ygg-chat-r/electron/headlessServer/services/toolLoopService.ts`: shared assistant tool-call continuation loop; persists via an injectable `MessageSink` (`messageSink.ts`) and supports abort, per-run `maxTurns`, and opt-in robustness (empty-turn retry + finalization).
- `client/ygg-chat-r/electron/headlessServer/services/subagentRunService.ts` + `routes/subagentRoutes.ts`: the `subagent` tool engine and its `POST /api/headless/subagent/stream` SSE route (see `agent_subagents_orchestration.md`). Reuses `ToolLoopService` with a transcript `MessageSink` (`subagentTranscriptSink.ts`) over `persistence/subagentRunRepo.ts`.
- `client/ygg-chat-r/electron/headlessServer/providers/*`: provider adapters/token handling.
- `client/ygg-chat-r/electron/headlessServer/persistence/*`: project/conversation/message repos, including `streamingRunRepo.ts` for durable stream lifecycle rows.
- `client/ygg-chat-r/electron/headlessServer/stream/*`: SSE writer/event types.
- `client/ygg-chat-r/electron/headlessServer/ui/mobile/src/*`: mobile UI.

## Data Flow

1. Client/mobile/test harness calls a headless chat route.
2. Route validates request and delegates to `ChatOrchestrator`.
3. Orchestrator resolves branch/continuation semantics and persists messages through repos.
4. Provider router dispatches to provider implementation.
5. `ToolLoopService` handles assistant tool-call continuation and server-side tool execution bridge.
6. SSE events stream lifecycle, text/reasoning/tool information back to caller.
7. Headless orchestration mirrors run start/completion/error into SQLite `streaming_runs` when a local DB is available; the `started` SSE event may include the resolved `streamId`.

## Current Provider Notes

- OpenAI ChatGPT provider is implemented for server-side generation.
- OpenRouter and LM Studio may be TODO/not implemented in some headless paths; verify current provider files before assuming support.

## Important Invariants

- Keep route-level parity with desktop conversation/message tree semantics.
- SSE event schema changes need matching mobile/test harness updates.
- Persistence repos should own DB details; routes/services should not scatter SQL logic.
- Tool loop behaviour should remain compatible with desktop stream/tool semantics where possible.
- For split-channel tool results, persist and stream only compact `persistedContent`; send ephemeral `modelContent` only in continuation history.

## Testing and Validation

```bash
npm --prefix client/ygg-chat-r run test:headless
npm --prefix client/ygg-chat-r run build:electron:main
```

Manual harness: `http://localhost:<local-server-port>/headless/openai-test` when local server is running.

## Related Docs

- `agent_runtime_modes.md`
- `agent_chat_pipeline.md`
- `agent_local_tools_runtime.md`
- `agent_subagents_orchestration.md`

## OpenAI Context Usage

- `OpenAiChatgptProvider` normalizes Codex usage and `ToolLoopService` emits a `context_usage` SSE event for every completed OpenAI provider turn.
- Usage snapshots replace one another across full-replay tool continuations; they are not cumulative.
- Assistant messages carry the snapshot in `context_usage` and in a structured content block so local persistence and renderer reloads retain it without changing other-provider behavior.


## Mid-run Context Compaction

`ToolLoopService` supports an injected branch compactor and explicit auto-compaction policy fields. For OpenAI/Codex only, a continued tool turn checks the latest normalized usage plus projected replay after tool-result persistence. Threshold, start, completion, and failure are emitted as `context_compaction` SSE events. A successful summary replaces pre-compaction replay history and becomes the next parent; a failure pauses the run before another inference call.
