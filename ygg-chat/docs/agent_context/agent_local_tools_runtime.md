# Agent Context: Local Tools Runtime

Last reviewed: 2026-06-16

## Purpose

Documents Electron-side local tool implementations, execution routes, job orchestration, utility runtime, and validation.

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
- `client/ygg-chat-r/electron/localServer.ts`: registers and executes local tools.
- `client/ygg-chat-r/electron/tools/orchestrator/*`: background job queue/lifecycle.
- `client/ygg-chat-r/src/services/ToolJobManager.ts`: renderer client for tool jobs.
- `client/ygg-chat-r/electron/tools/__tests__/*`: tool tests.
- `client/ygg-chat-r/electron/tools/TEST_PLAN.md`: tool test plan.

## Data Flow

1. Model emits a tool call or user/agent invokes a tool manager action.
2. Renderer permission checks may run first depending on tool and mode.
3. Renderer posts to local server tool execution routes or job routes.
4. Local server dispatches to built-in/custom/MCP implementation.
5. Tool returns structured success/error payload.
6. Result is emitted into stream state and/or persisted as a tool result message.

## Important Invariants

- File tools must respect workspace/root path and safety constraints.
- Mutating operations should be explicit and auditable.
- Shell tools must avoid hanging interactive commands and should capture bounded output.
- Tool result shapes should remain stable for ChatMessage/tool rendering.
- Large/model-only tool payloads use split channels: `displayContent`/`persistedContent` stay compact, while ephemeral `modelContent` is used only for the immediate provider continuation. Never persist `modelContent` in chat history, tool-job rows, hooks, or logs.
- `view_image` returns compact path/MIME/size metadata for display and persistence, with exactly one typed `input_image` data URL in ephemeral `modelContent`.
- Background jobs need status transitions: pending -> running -> completed/failed/cancelled.

## Gotchas

- On Windows/Electron, Bash may route through WSL/path conversion; PowerShell may be required for native paths.
- `edit_file` uses layered matching and line hints; preserve validation semantics.
- `edit_file` and `multi_edit` in execute mode create managed per-stream undo backups through `streamUndoManager`; keep local-server and utility-runtime registration behavior aligned.
- Tests may depend on temporary filesystem harnesses in `electron/tools/__tests__/helpers`.

## Testing and Validation

```bash
npm --prefix client/ygg-chat-r run test:tools
```

For targeted Vitest runs, use the relevant config in `client/ygg-chat-r/vitest.tools.config.ts`.

## Related Docs

- `agent_tool_registry.md`
- `agent_tool_permissions.md` (future recommended)
- `docs/tool-permissions.md`
