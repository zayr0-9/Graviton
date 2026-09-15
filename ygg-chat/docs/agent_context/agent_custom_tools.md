---
paths:
  - "client/ygg-chat-r/server/tools/customTool*.ts"
  - "client/ygg-chat-r/server/utils/managedToolPaths.ts"
  - "client/ygg-chat-r/custom-tools/**"
---

# Agent Context: Custom Tools

Last reviewed: 2026-06-16

## Purpose

Documents custom tool discovery, format, management, RPC/UI tool behaviour, and managed filesystem paths.

## When to Open This File

Use this when changing:
- custom tool loader/manager;
- `definition.json` schema handling;
- custom tool install/reload/enable/disable flows;
- RPC custom tool protocol;
- custom tools that return HTML UI.

## Key Files

- `client/ygg-chat-r/electron/tools/customToolLoader.ts`: scans/parses custom tools.
- `client/ygg-chat-r/electron/tools/customToolManager.ts`: management and invocation tool.
- `client/ygg-chat-r/electron/utils/managedToolPaths.ts`: managed custom tool paths.
- `client/ygg-chat-r/custom-tools/CUSTOM_TOOLS_GUIDE.md`: guide for custom tools.
- `client/ygg-chat-r/custom-tools/RPC_TOOL_GUIDE.md`: RPC custom tool guide.
- `client/ygg-chat-r/custom-tools/CUSTOM_TOOLS_LEGACY_GUIDE.md`: legacy reference.
- `client/ygg-chat-r/custom-tools/gitnexus_native/*`: example bundled custom tool.
- `html_frame_context.md`: HTML app/iframe context.

## Definition Shape

A custom tool usually contains:

- `definition.json`: name, description, enabled flag, input schema, optional permissions.
- `index.js`: CommonJS `execute` implementation.
- `ui.html`: optional UI asset for HTML-returning tools.

Custom tools may include `appPermissions`, especially for iframe apps that need persistent-agent access.

## Important Invariants

- Agents should invoke custom tools through `custom_tool_manager`, not by calling undeclared tool names directly.
- Loader should preserve `appPermissions` for iframe bridge enforcement.
- Invalid tool definitions should fail safely and report useful errors.
- Managed paths must not allow arbitrary overwrite outside expected custom-tool directories.

## Testing and Validation

- `npm --prefix client/ygg-chat-r run test:tools`
- Specifically inspect tests around `customToolLoader` and `customToolManager`.
- Manual validation: list, read/get, invoke, enable/disable, reload.

## Related Docs

- `agent_tool_registry.md`
- `agent_html_iframe_apps.md`
- `html_frame_context.md`
