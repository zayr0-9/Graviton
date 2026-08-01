# Agent Context: Global Persistent Agent — RETIRED

Last reviewed: 2026-08-01

> **STATUS: RETIRED / REMOVED.** The Global Persistent Agent (GAL — the singleton
> renderer-owned "global agent loop") no longer exists. It was deleted in the
> headless thin-client migration (branch `feat/headless-agent-loop`, Phases 0–6,
> complete and live). This file is a tombstone: do **not** use it as a guide to
> current behavior — none of the code it used to describe is in the tree anymore.
>
> **Where the agent loop lives now:** the main chat agent loop runs server-side in
> the local headless Express server (`127.0.0.1:3002`) inside the Electron main
> process. See [`agent_headless_server.md`](agent_headless_server.md) for the
> server-owned loop and [`agent_subagents_orchestration.md`](agent_subagents_orchestration.md)
> for the subagent engine that superseded it.

## Why it was removed

The persistent/global renderer agent was a renderer-owned singleton loop that
ticked against local SQLite-backed `/api/agent/*` endpoints. The headless
migration moved **all** agent execution (main chat loop and subagents) out of the
React renderer and into the server-owned engine
(`electron/headlessServer/services/`: `chatOrchestrator.ts` → `branchOrchestrator.ts` →
`toolLoopService.ts`, with the `DecisionBroker` pause/resume protocol). The
renderer is now a thin client that only POSTs SSE routes on `:3002` and projects
events onto Redux. A separate renderer-side "global agent loop" no longer has a
place in that architecture, so it — along with the Claude Code tool it was paired
with — was deleted rather than migrated.

## Deleted files and symbols (confirmed gone from the tree)

| Path / symbol | Status |
|---|---|
| `client/ygg-chat-r/src/services/GlobalAgentLoop.ts` | DELETED |
| `client/ygg-chat-r/src/GlobalAgentBootstrap.tsx` | DELETED |
| `client/ygg-chat-r/src/hooks/useGlobalAgentCache.ts` | DELETED |
| `client/ygg-chat-r/src/hooks/useGlobalAgentMessages.ts` | DELETED |
| `client/ygg-chat-r/src/helpers/agentSettingsStorage.ts` | DELETED |
| GAL routes in `electron/localServer.ts` (`/api/agent/*`, `/api/agent-settings`) | REMOVED (no live references remain) |
| `agent_settings` / `agent_sessions` / `agent_tasks` DB tables | REMOVED (no live CREATE/INSERT/prepared statements in `electron/**`) |

Retired in the same migration (paired subsystems):

- `client/ygg-chat-r/electron/tools/claudeCode.ts` — the Claude Code tool + its
  routes/thunks/reducers. DELETED.
- `client/ygg-chat-r/src/features/chats/dualSyncManager.ts` and
  `client/ygg-chat-r/src/lib/sync/` — DELETED; replaced server-side by
  `electron/headlessServer/services/cloudMirrorService.ts` + the `CloudMirrorSink`
  (see [`agent_headless_server.md`](agent_headless_server.md)).

## Grep traps (do not be misled)

- **Stale test fixtures still contain the old code as inert text.**
  `electron/tools/__tests__/dummyfile.ts.test` (snapshot of the old
  `localServer.ts`) and `electron/tools/__tests__/dummyFilechatAction.ts.test`
  (snapshot of the old `chatActions.ts`) are read as plain-text inputs by
  `editFile.test.ts`. They are never imported or compiled. They still mention
  `claudeCode`, `executeClaudeCode`, `agent_settings/agent_sessions/agent_tasks`,
  and `lib/sync/dualSyncManager` — those hits are fixtures, not live code.
- **Unrelated:** `isPersistentGlobalAgentType` / `ex_agent_type` in
  `client/ygg-chat-r/src/features/chats/chatSelectors.ts` belong to the separate
  `ex_agent` message-type feature and have nothing to do with the deleted GAL.

## Related docs (current)

- [`agent_headless_server.md`](agent_headless_server.md) — the server-owned main chat loop that replaced this subsystem.
- [`agent_subagents_orchestration.md`](agent_subagents_orchestration.md) — the subagent engine sharing the same server-side execution path.
- [`agent_electron_main_local_server.md`](agent_electron_main_local_server.md) — the Electron main process / local server surface.
- [`agent_html_iframe_apps.md`](agent_html_iframe_apps.md) — iframe app permission model (formerly cross-referenced here for `appPermissions.agent`).
- [`agent_chat_pipeline.md`](agent_chat_pipeline.md), [`agent_chat_streaming_state.md`](agent_chat_streaming_state.md) — renderer thin-client chat pipeline and streaming state.
