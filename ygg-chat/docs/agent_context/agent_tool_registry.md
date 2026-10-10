---
paths:
  - "shared/builtinToolDefinitions.ts"
  - "client/ygg-chat-r/server/headlessServer/services/contextStatusTool.ts"
  - "client/ygg-chat-r/server/builtinToolRegistry.ts"
  - "client/ygg-chat-r/server/headlessServer/index.ts"
  - "client/ygg-chat-r/src/features/chats/toolDefinitions.ts"
  - "client/ygg-chat-r/server/tools/customTool*.ts"
  - "client/ygg-chat-r/server/mcp/**"
---

# Agent Context: Tool Registry

Last reviewed: 2026-06-16

## Purpose

Documents how built-in, custom, and MCP tool definitions are exposed to the model/runtime and rendered in the app.

## When to Open This File

Use this when changing:
- tool schemas or visibility;
- model-visible tool lists;
- custom/MCP tool merging;
- built-in tool definitions shared between renderer and Electron.

## Key Files

- `client/ygg-chat-r/src/features/chats/toolDefinitions.ts`: merged frontend tool registry.
- `shared/builtinToolDefinitions.ts`: shared schemas for built-in tools.
- `shared/types.ts`: tool definition and call/result contracts.
- `docs/tool-permissions.md`: permission flow overview.
- `client/ygg-chat-r/server/tools/*`: built-in tool implementations.
- `client/ygg-chat-r/server/tools/customToolLoader.ts`: custom tool definition loading.
- `client/ygg-chat-r/server/mcp/*`: MCP tool discovery/management.

## Runtime Context

- The model sees tool schemas built from the active registry.
- `repl` is a branch-shared (parent and children) composite dispatcher, not a leaf job: invoke stores nested results via the caller's policy-aware executor; synchronous QuickJS exec processes values and show explicitly reveals bounded output. See [REPL tool](../repl-tool.md) for scope, limits, direct-only exceptions and restart behavior.
- Built-in tools have shared schemas and server-owned implementations hosted by the local server. `multi_call` is a headless-server composite implementation rather than a `toolOrchestrator` leaf handler: it expands nested calls and sends each through normal policy-aware execution.
- `context_status` is an enabled, no-argument read-only built-in intercepted in-process by `server/headlessServer/services/contextStatusTool.ts`. `ToolLoopService` supplies a run-local meter callback; direct calls and nested `multi_call` use the invoking run's history/provider/model, never renderer navigation. It bypasses interactive permissions and is allowed in Chat mode. It calculates headroom against `totalContextLimit` (model/configured window, not credits) and returns only remaining tokens, rounded whole-number remaining percent, and a brief approximation note.
- Renderer-selected schemas exclude custom tools; discover/invoke them through `custom_tool_manager`. Server requests omitting `tools` use defaults that also include enabled custom definitions directly.
- MCP tools are discovered/invoked through the stable `mcp_manager` schema (`list`, `list_tools`, `invoke`). Individual MCP schemas appear only in discovery tool results, never in model tool definitions. Shared policy, request shaping and the loop strip direct MCP schemas, including legacy client inputs/refresh hooks. Settings/iframe registries and direct host handlers remain available separately.

## Important Invariants

- Tool schema names must match execution names exactly.
- Keep shared schemas in sync with server implementations and utility-runtime registrations.
- Do not expose unsafe capabilities without permission and operation-mode gates.
- App/iframe permissions are separate from normal model tool visibility.

## Extension Points

- Add built-ins by updating shared definitions, server implementation/registration, applicable utility-runtime registration, and tests.
- Add custom tool capabilities in custom tool loader/manager and docs.
- Add MCP visibility changes in MCP manager/routes and frontend merge logic.

## Testing and Validation

- Built-in tool changes: `npm --prefix client/ygg-chat-r run test:tools`.
- Schema/type changes: `npm --prefix client/ygg-chat-r run build:electron`.
- Manual check that model-visible tool list contains expected definitions and excludes hidden tools.

## Related Docs

- `agent_local_tools_runtime.md`
- `agent_custom_tools.md`
- `agent_html_iframe_apps.md`
- `docs/tool-permissions.md`
