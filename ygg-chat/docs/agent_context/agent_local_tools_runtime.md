# Agent Context: Local Tools Runtime

Last reviewed: 2026-08-01

## Purpose

Documents Electron-side local tool implementations, execution routes, job orchestration, utility runtime, and validation. Tool *execution* for the main chat loop now runs inside the headless server loop (see "Server-Owned Chat Loop Execution"); this file remains the reference for the tool implementations and the in-process orchestrator they all share.

## When to Open This File

Use this when changing:
- built-in tools such as read/edit/bash/ripgrep/glob;
- tool execution endpoints;
- background tool jobs;
- WSL/PowerShell/file safety behaviour;
- tool tests.

## Key Files

- `client/ygg-chat-r/electron/tools/*`: built-in tool implementations.
- `client/ygg-chat-r/electron/tools/runtime/*`: utility tool runtime protocol/host.
- `client/ygg-chat-r/electron/toolRuntimeUtility.ts`: utility runtime entry.
- `client/ygg-chat-r/electron/localServer.ts`: embedded local server (prefers :3002). Initializes `toolOrchestrator`, registers built-in/custom/MCP tool handlers with it, and hosts the legacy `POST /api/tools/execute` + job routes (submit/list/get/cancel, WebSocket subscribe). Mounts the headless server (`registerHeadlessServerRoutes`) which owns the chat loop.
- `client/ygg-chat-r/electron/tools/orchestrator/*`: background job queue/lifecycle (`toolOrchestrator` singleton). The SAME in-process orchestrator serves both the legacy job routes and the server chat/subagent loops.
- `client/ygg-chat-r/electron/headlessServer/index.ts` (`executeToolViaOrchestrator`): the leaf `ToolExecutor` for the server-owned chat + subagent loops. Parses args, honors `context.signal`, `toolOrchestrator.submit(...)`, then polls `toolOrchestrator.getJob(...)` every 100ms until terminal or `timeoutMs` (clamped 1s–600s, default 300s). No HTTP round-trip, no renderer involvement.
- `client/ygg-chat-r/electron/headlessServer/services/multiCallExecutor.ts`: in-process `multi_call` composite dispatcher. Runs up to 20 validated leaf calls sequentially or with concurrency capped at 4, preserves result order, forwards abort/workspace context, and routes each nested call back through the caller's policy-aware executor. Recursive `multi_call`, `html_renderer`, and `plan_md` with `action:'display'` are rejected; `subagent` is permitted for parent-chat batches.
- `client/ygg-chat-r/electron/headlessServer/services/toolLoopService.ts` (`ToolLoopService.run`): server-side agent loop; calls `this.executeTool(toolCall, ctx)` per tool call.
- `client/ygg-chat-r/electron/headlessServer/services/chatOrchestrator.ts` (`createChatPausingExecutor`): per-run executor wrapper that pauses each tool call for permission/clarify before delegating to the base executor.
- `client/ygg-chat-r/src/services/ToolJobManager.ts`: renderer client for the tool-jobs UI/background jobs (still live — `ToolJobsModal`, `useToolJobs`). It subscribes first, reconciles `/jobs` after every subscription/reconnect, fetches active jobs independently of history pagination, and exposes acknowledged live status. It is not part of the main chat loop's execution path.
- `client/ygg-chat-r/electron/tools/__tests__/*`: tool tests.
- `client/ygg-chat-r/electron/tools/TEST_PLAN.md`: tool test plan.

## Server-Owned Chat Loop Execution

The main chat agent loop no longer runs in the React renderer; it runs inside the local headless Express server (127.0.0.1:3002) in the Electron main process. Tool execution follows the loop, not the renderer:

1. `ChatOrchestrator.runMessage` (`electron/headlessServer/services/chatOrchestrator.ts`) builds a per-run `ToolLoopService`.
2. `ToolLoopService.run` (`toolLoopService.ts`) drives turns and calls `this.executeTool(toolCall, ctx)` for each tool call.
3. `executeTool` is the pausing wrapper `createChatPausingExecutor` (`chatOrchestrator.ts:95`). Per tool call it optionally pauses on `DecisionBroker.requestDecision` (unless the stream is auto-approve or the tool is in `ALWAYS_BYPASS_TOOLS` = `skill_manager`/`mcp_manager`/`multi_call`, or a non-`invoke` `custom_tool_manager` action). PreToolUse hooks may deny/rewrite args before any prompt.
4. On approval it delegates to the base executor `executeToolViaOrchestrator` (`index.ts:173`), which runs the tool through the shared in-process `toolOrchestrator` (same registered handlers as the legacy job routes).

Permission/clarify decisions are NOT renderer-owned pre-checks anymore. The loop pauses server-side and asks via SSE `permission_required` / `clarify_required`; the renderer answers with `POST /api/resume` (`electron/headlessServer/routes/chatRoutes.ts`). Broker key = `` `${streamId}::${toolCallId}` `` (`electron/headlessServer/services/decisionBroker.ts`). Abort/disconnect (`res.on('close')`) rejects pending decisions and cancels the in-flight orchestrator job. Subagents use the same base executor via `SubagentRunService`.

## Data Flow

1. Model emits a tool call inside the server-owned chat loop (`ToolLoopService.run`) — or a user/agent invokes a tool-manager action, or the tool-jobs UI submits a background job.
2. For the chat loop, the server pauses per tool call for permission/clarify via `DecisionBroker` (renderer answers `POST /api/resume`) unless auto-approved or bypassed. There is no renderer-side pre-execution permission check.
3. The loop calls the base executor `executeToolViaOrchestrator` in-process (Electron main), which submits to `toolOrchestrator` and polls `getJob` until terminal. The legacy `POST /api/tools/execute` + job routes in `localServer.ts` remain for the tool-jobs UI / background jobs, not the chat loop.
4. Composite `multi_call` calls are intercepted in-process; each nested call re-enters the chat permission/hook wrapper or the subagent approval gate before reaching the leaf executor. Ordinary calls go directly to `toolOrchestrator`, which dispatches to the registered built-in/custom/MCP implementation.
5. Tool returns a structured success/error payload.
6. Result is streamed to the renderer as SSE `tool_execution` / `chunk` (`tool_result`) events and persisted as a tool-result message via the loop's message sink (`TreeMessageSink`/`CloudMirrorSink`).

## Important Invariants

- File tools must respect workspace/root path and safety constraints.
- Mutating operations should be explicit and auditable.
- Shell tools must avoid hanging interactive commands and should capture bounded output.
- Tool result shapes should remain stable for ChatMessage/tool rendering.
- The chat loop and the legacy job routes execute through the SAME in-process `toolOrchestrator` and its registered handlers — keep tool registration in `localServer.ts` and any new execution entry point consistent, so behaviour is identical regardless of caller.
- Large/model-only tool payloads use split channels: `displayContent`/`persistedContent` stay compact, while ephemeral `modelContent` is used only for the immediate provider continuation. Never persist `modelContent` in chat history, tool-job rows, hooks, or logs.
- `view_image` returns compact path/MIME/size metadata for display and persistence, with exactly one typed `input_image` data URL in ephemeral `modelContent`.
- Background jobs need status transitions: pending -> running -> completed/failed/cancelled.
- Interactive decision state is keyed by `streamId` in Redux; concurrent branch runs must never overwrite another branch's permission/clarify/operation-mode correlation.
- A duplicate resumable-run POST for an existing `streamId` must reattach to that `RunSession` instead of starting a replacement; explicit replacement callers must abort the old session before replacing it. Deleting without aborting creates an unreachable run that no UI, reaper, or Stop request can reach.
- The Tool Jobs live badge means the WebSocket subscription was acknowledged, not merely that a socket object exists.

## Gotchas

- On macOS/Linux, GUI-launched Electron inherits a minimal `PATH`. The Bash tool runs commands through the user's configured `$SHELL` as an interactive login shell (`-lic`) and falls back to `/bin/bash`; native ripgrep execution imports that shell's `PATH` before spawning `rg`, so terminal-managed Homebrew/nvm/asdf paths remain available.
- On Windows/Electron, Bash may route through WSL/path conversion; PowerShell may be required for native paths.
- `edit_file` uses layered matching and line hints; preserve validation semantics.
- `edit_file` and `multi_edit` in execute mode create managed per-stream undo backups through `streamUndoManager`; keep local-server and utility-runtime registration behavior aligned.
- Tests may depend on temporary filesystem harnesses in `electron/tools/__tests__/helpers`.
- Two large test fixtures under `electron/tools/__tests__/` use a `.ts.test` extension (`dummyfile.ts.test`, `dummyFilechatAction.ts.test`) and are verbatim snapshots of pre-migration source read as plain text by `editFile.test.ts`. They are never imported/compiled but still contain retired symbols (e.g. `claudeCode`, `dualSyncManager`); grepping the tree will hit them — they are fixtures, not live code.

## Testing and Validation

```bash
npm --prefix client/ygg-chat-r run test:tools
```

For targeted Vitest runs, use the relevant config in `client/ygg-chat-r/vitest.tools.config.ts`.

## Related Docs

- `agent_tool_registry.md`
- `agent_tool_permissions.md` (future recommended — not yet present)
- `docs/tool-permissions.md`
