---
paths:
  - "package.json"
  - "client/ygg-chat-r/package.json"
  - "client/ygg-chat-r/src/main.tsx"
  - "client/ygg-chat-r/src/App.tsx"
  - "client/ygg-chat-r/electron/main.ts"
  - "client/ygg-chat-r/server/createYggServer.ts"
---

# Agent Context: Project Overview

Last reviewed: 2026-11-10

## Purpose

High-level orientation for `ygg-chat`, a full-stack AI chat and agent harness with a React UI, Electron desktop runtime, local Express/SQLite server, agentic tools, custom tools, MCP, hooks, and headless/mobile surfaces.

## When to Open This File

Open this first when:
- you are new to the repository;
- a task crosses frontend, Electron, tools, and persistence boundaries;
- you need to decide which subsystem context file to read next.

## Top-Level Layout

- `client/ygg-chat-r/`: main app workspace: React/Vite frontend plus Electron/backend/tooling code.
- `shared/`: cross-runtime shared contracts and tool/provider metadata.
- `docs/`: general docs and this `agent_context` directory.
- Root `*.md` context files: existing deep context docs for HTML iframe apps, themes, compaction, streams. (Some — e.g. `PERSISTENT_AGENT_CONTEXT.md` — describe the retired Global Agent Loop; see Runtime Map.)
- `package.json`: root npm workspace wrapper and top-level scripts.

The host-neutral local backend lives in `client/ygg-chat-r/server/`, not a top-level `server/`. Electron starts it through `server/createYggServer.ts` with `electron/electronHostAdapter.ts`; the existing `server/standaloneEntry.ts` starts the same graph under Node. Graviton is fully local: there is no hosted backend, account or `.env`. Older root context files can still contain pre-migration paths.

## Runtime Map

Electron is the primary target. The Electron main process hosts the shared **headless Express/SQLite server**, preferring `http://127.0.0.1:3002` with fallback ports, and the renderer is a **thin client** that owns no agent loop. Resolve the actual origin via `src/utils/api.ts` rather than hardcoding the preferred port.

- **Server-owned main chat loop.** The renderer's 3 chat thunks — `sendMessage`, `editMessageWithBranching`, `sendMessageToBranch` in `client/ygg-chat-r/src/features/chats/chatActions.ts` — POST the SSE chat routes on `:3002` and project the server's SSE events onto the existing Redux `streamChunk` vocabulary. Reader: `client/ygg-chat-r/src/features/chats/mainChatClient.ts` (`runServerChatLoop`); projection: `client/ygg-chat-r/src/features/chats/sseProjection.ts` (`projectServerEvent`); request builder: `client/ygg-chat-r/src/features/chats/buildServerLoopRequest.ts`. The thunks require a local-server runtime (Electron or the existing standalone target), with no renderer fallback loop.
- **Server engine (provider routes: openaichatgpt, openrouterbyok, lmstudio, zai, bedrock; Claude Code has its own session backend).** `server/headlessServer/routes/chatRoutes.ts` → `services/chatOrchestrator.ts` (`ChatOrchestrator.runMessage`) → `services/branchOrchestrator.ts` → `services/toolLoopService.ts` (`ToolLoopService.run`). Wiring root: `server/headlessServer/index.ts` (`registerHeadlessServerRoutes`). Tool execution, permission prompts, hooks, and in-loop compaction all run server-side (same engine that serves subagents). Compaction: `services/compactionService.ts` (in-loop auto + a manual `POST /api/conversations/:id/compact`; the renderer keeps only the manual `compactBranch` button thunk).
- **Pause/resume.** The loop pauses mid-turn for tool-permission and `plan_md` clarify decisions via `services/decisionBroker.ts` (`DecisionBroker`, keyed `${streamId}::${toolCallId}`), emitting `permission_required` / `clarify_required` SSE events; the renderer answers with `POST /api/resume`. In-process hooks fire at eight lifecycle events in `services/chatHookService.ts` (same Electron process, no HTTP).
- **Local data gateway.** The renderer talks ONLY to `:3002`. `server/headlessServer/routes/gatewayRoutes.ts` (`/api/gw/*`) is a local facade over `/api/app/*` for conversations/projects/messages/attachments. There is no cloud leg, `/api/cloud/*` proxy, gateway feature flag or storage mode; all data lives in local SQLite.
- **Network.** Outbound traffic is limited to user-configured model providers, MCP servers, the app-store catalog (`agent_app_store.md`) and GitHub Releases for updates.
- **Headless/mobile.** The same local server exposes headless chat/provider/tool APIs and a mobile LAN UI; subagents run through the same engine.
- **No web product.** Delivery surfaces come from `__BUILD_TARGET__` (`electron`, `browser-client`, `standalone`); all are host clients of the local server.

**Retired / removed** (do not look for these):
- The renderer-owned chat loop (the former ~9,400-line `chatActions.ts`; now thin-client delegation).
- Claude Code — `electron/tools/claudeCode.ts` plus its local-server routes and renderer thunks/types/reducers.
- Global Agent Loop (GAL) — `services/GlobalAgentLoop.ts`, `GlobalAgentBootstrap.tsx`, `hooks/useGlobalAgentCache.ts`, `hooks/useGlobalAgentMessages.ts`, `helpers/agentSettingsStorage.ts`, its routes, and the `agent_*` DB tables.
- The cloud layer (fully-local migration, 2026-11): Supabase/Railway auth and sync, `dualSyncManager`/`src/lib/sync/*`/`localMirror.ts`, `cloudMirrorService`/`CloudMirrorSink`, `/api/cloud/*`, gateway flags, the hosted OpenRouter provider, Stripe billing, Vercel analytics and the web build.
- Removed renderer symbols: `isServerOwnedChatLoopEnabled`, `isCloudServerLoopEnabled`, `executeToolWithPermissionCheck`, the module-level `pending*Resolve` promises. Treat references to deleted renderer loops and old `electron/tools/` paths as historical, not current implementation entrypoints.

## Key Files

- `general_project_context.md`: broad architecture map.
- `package.json`: root workspace and scripts.
- `client/ygg-chat-r/package.json`: app scripts, dependencies, test commands.
- `shared/types.ts`: shared domain contracts.
- `shared/builtinToolDefinitions.ts`: built-in tool schema contracts.
- `client/ygg-chat-r/src/App.tsx`: app shell and runtime bootstraps.
- `client/ygg-chat-r/src/main.tsx`: React/Redux/React Query bootstrap.
- `client/ygg-chat-r/electron/main.ts`: Electron process entry.
- `client/ygg-chat-r/server/localServer.ts`: embedded local API server (CRUD/tools).
- `client/ygg-chat-r/server/headlessServer/index.ts`: headless server route wiring — server-owned chat loop (`ChatOrchestrator`) + local data gateway.
- `client/ygg-chat-r/src/features/chats/chatActions.ts`: thin-client chat thunks that delegate to the server loop.
- `client/ygg-chat-r/src/features/chats/mainChatClient.ts` + `sseProjection.ts`: SSE reader and Redux projection.

## Common Commands

From repository root:

```bash
npm run dev:electron
npm run build:electron
```

From `client/ygg-chat-r`:

```bash
npm run lint
npm run test:tools
npm run test:headless
npm run test:renderer
npm run test:server
npm run typecheck:server
npm run build:electron:main
```

The existing Node-host build uses `npm run build:server`; `npm run start:server`
requires a writable `YGG_DATA_DIR` and the standalone native dependency setup.
Legacy `dev`/`build:web` scripts still exist but are not desktop validation targets.

## Agent Workflow

1. Read this overview and the most relevant subsystem doc.
2. Open key files listed by the subsystem doc before editing.
3. Preserve runtime boundaries: browser UI, Electron main, local/headless server, shared contracts.
4. For chat-loop / tool / gateway work, verify Electron/local-server (`:3002`) assumptions — the renderer is a thin client.
5. Run the narrowest validation command that covers the changed subsystem (`test:headless` for the server engine/gateway; `test:tools` for tools).

## Related Docs

- `general_project_context.md`
- `docs/agent_context/AGENT.md` (subsystem-doc maintenance rules)
- `docs/agent_context/agent_headless_server.md` (server engine + local data gateway)
- `docs/agent_context/agent_runtime_modes.md`
