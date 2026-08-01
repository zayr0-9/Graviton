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
- `client/ygg-chat-r/electron/tools/*`: built-in tool implementations.
- `client/ygg-chat-r/electron/tools/customToolLoader.ts`: custom tool definition loading.
- `client/ygg-chat-r/electron/mcp/*`: MCP tool discovery/management.

## Runtime Context

- The model sees tool schemas built from the active registry.
- Built-in tools have shared schemas and Electron implementations. `multi_call` is a headless-server composite implementation rather than a `toolOrchestrator` leaf handler: it expands nested calls and sends each through normal policy-aware execution.
- Custom tools should be discovered/managed through `custom_tool_manager`, not called directly by undeclared names.
- MCP tools are discovered through MCP manager routes and merged if model-visible.

## Important Invariants

- Tool schema names must match execution names exactly.
- Keep shared schema changes in sync with Electron implementations.
- Do not expose unsafe capabilities without permission and operation-mode gates.
- App/iframe permissions are separate from normal model tool visibility.

## Extension Points

- Add built-in tools by updating shared definitions, Electron implementation, local server registration, and tests.
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
