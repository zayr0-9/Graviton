# Agent Context Index

Last reviewed: 2026-08-01

This directory contains subsystem-specific context files for agents working in `ygg-chat`.

## Supported Runtime Scope

- This repository targets the **local Electron application only**.
- Do not preserve, add, test, or plan web-mode behavior in this repository unless the user explicitly requests it.
- Do not add web fallbacks or branch new implementation logic on `VITE_ENVIRONMENT === 'web'`; web support lives in a separate repository.
- Treat Electron main/preload, the renderer, the local Express server, local SQLite persistence, and local/headless tool execution as the supported runtime surface.
- Existing web-mode code may remain for now when unrelated, but it is not a compatibility constraint for new changes and should not drive architecture or validation decisions.

Start here, then open the smallest relevant subsystem context file before editing code. These docs are intentionally operational: they point to entry files, runtime constraints, data flow, invariants, and validation commands.

## Core

- `agent_project_overview.md` - repository layout, workspace scripts, runtime map, and how to use the context set.
- `agent_runtime_modes.md` - legacy runtime map; for this repository, apply the local-Electron-only scope above.

## Chat

- `agent_chat_pipeline.md` - renderer thin-client send/edit/branch flow that drives the **server-owned** agent loop on `:3002` (providers, tools, pause/resume, persistence).
- `agent_chat_streaming_state.md` - Redux multi-stream state, branch-aware selectors, streaming invariants (now fed by server SSE → Redux projection).
- `agent_branch.md` - conversation branching/edit/repeat: renderer placement hints vs. server-side lineage resolution (`BranchOrchestrator`).
- `agent_chat_container.md` - `Chat.tsx` main screen orchestration, message rendering, composer, routing, and Heimdall integration.
- `agent_md_renderer.md` - Markdown/text response rendering from `Chat.tsx` into `ChatMessage`, including `content_blocks`, stream events, prose/code styling, and renderer invariants.
- `agent_heimdall.md` - Heimdall conversation tree rendering, node selection, notes, search, subagent badges, and selected-node actions.
- `agent_message_storage_shape.md` - per-conversation message schema, `parent_id`/`children_ids` tree shape, normalization, and write/read invariants.

## Tools

- `agent_tool_registry.md` - built-in, custom, and MCP tool definitions visible to model/runtime.
- `agent_local_tools_runtime.md` - Electron tool implementations, execution routes, utility host, and tests.
- `agent_custom_tools.md` - custom tool loading, definition format, RPC/UI tools, managed paths.
- `agent_mcp.md` - MCP transports, configuration, remote OAuth, credential persistence, routes, and validation.

## Agent Runtime

- `agent_global_persistent_agent.md` - **RETIRED** tombstone: the renderer-owned global agent loop was deleted in the headless migration; the agent loop is now server-owned.
- `agent_headless_server.md` - the local `:3002` server that now **owns the main chat agent loop** for all providers (pause/resume, in-loop hooks, compaction), plus the cloud gateway (`/api/gw/*`, `/api/cloud/*`), token layer, subagents, and mobile UI.
- `agent_subagents_orchestration.md` - the `subagent` tool: renderer thin client + the shared server-side engine (the same `ToolLoopService` that now runs the main chat loop — subagents auto-approve, the main loop pauses), transcript persistence, SSE route.

## Platform and Integration

- `agent_electron_main_local_server.md` - Electron main/preload/local Express server responsibilities; hosts the `headlessServer` routes + cloud gateway; Claude Code + GlobalAgentLoop routes retired.
- `agent_html_iframe_apps.md` - custom app iframe rendering, bridge permissions, HTML cache.
- `agent_hooks_system.md` - Ygg hook lifecycle and hook runner; for the main chat loop, hooks now run **in-process inside the server loop** (`chatHookService`), sync/async execution, model feedback.
- `agent_floating_agent_button_design.md` - floating agent/app button animation, shell layout, inline stream-completion notifications, and reusable compact-to-expanded design pattern.

## Design

- `agent_design.md` - shared UI design patterns, including the circular Lucide glass control-button style used by Heimdall.

## Coverage Notes

This MVP set deliberately covers the highest-risk agent-editing surfaces first. The compaction and memory surface is covered by:

- `agent_context_compaction_memory.md`

Potential future context topics that do not yet have dedicated files in this checkout include projects/conversations/messages, providers/models, auth/provider tokens, local storage sync, frontend app shell, settings/preferences, theme UI, IDE/LSP context, and workspace mutations.

## Maintenance Rules

- Keep these docs concise and file-oriented.
- Prefer links to source files over copied implementation details.
- Update a subsystem doc in the same PR/change when moving its core files or changing its invariants.
- If an agent doc conflicts with source code, source code wins and the doc should be corrected.
