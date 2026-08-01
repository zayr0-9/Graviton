# Agent Context: Project Overview

Last reviewed: 2026-08-01

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

Note: `general_project_context.md` mentions a `server/` directory, but this checkout does not contain one. Treat cloud/server references as historical or external (the cloud backend lives on Railway; the local server is embedded in the Electron main process — see Runtime Map).

## Runtime Map

Electron is the primary target. The Electron main process hosts a local **headless Express/SQLite server** on `http://127.0.0.1:3002`, and the renderer is a **thin client** that owns no agent loop.

- **Server-owned main chat loop.** The renderer's 3 chat thunks — `sendMessage`, `editMessageWithBranching`, `sendMessageToBranch` in `client/ygg-chat-r/src/features/chats/chatActions.ts` — POST the SSE chat routes on `:3002` and project the server's SSE events onto the existing Redux `streamChunk` vocabulary. Reader: `client/ygg-chat-r/src/features/chats/mainChatClient.ts` (`runServerChatLoop`); projection: `client/ygg-chat-r/src/features/chats/sseProjection.ts` (`projectServerEvent`); request builder: `client/ygg-chat-r/src/features/chats/buildServerLoopRequest.ts`. The thunks throw outside Electron (no renderer fallback loop).
- **Server engine (all 5 providers: openrouter, lmstudio, openaichatgpt, zai, bedrock).** `electron/headlessServer/routes/chatRoutes.ts` → `services/chatOrchestrator.ts` (`ChatOrchestrator.runMessage`) → `services/branchOrchestrator.ts` → `services/toolLoopService.ts` (`ToolLoopService.run`). Wiring root: `electron/headlessServer/index.ts` (`registerHeadlessServerRoutes`). Tool execution, permission prompts, hooks, and in-loop compaction all run server-side (same engine that serves subagents). Compaction: `services/compactionService.ts` (in-loop auto + a manual `POST /api/conversations/:id/compact`; the renderer keeps only the manual `compactBranch` button thunk).
- **Pause/resume.** The loop pauses mid-turn for tool-permission and `plan_md` clarify decisions via `services/decisionBroker.ts` (`DecisionBroker`, keyed `${streamId}::${toolCallId}`), emitting `permission_required` / `clarify_required` SSE events; the renderer answers with `POST /api/resume`. In-process hooks fire at 5 lifecycle points in `services/chatHookService.ts` (same Electron process, no HTTP).
- **Cloud gateway.** The renderer talks ONLY to `:3002`. `electron/headlessServer/routes/gatewayRoutes.ts` (`/api/gw/*`) is storage-aware CRUD/merge for conversations/projects/messages/attachments (collapses the old renderer dual-fetch/dual-write). `electron/headlessServer/routes/cloudProxyRoutes.ts` (`/api/cloud/*`) is an authenticated pass-through to Railway (models/users/system-prompts/Stripe/app-store/OAuth). `services/railwayClient.ts` injects the server-held Supabase JWT and relays SSE; `services/cloudMirrorService.ts` + the `CloudMirrorSink` in `services/messageSink.ts` mirror Railway rows into SQLite. Railway remains authoritative for free-tier metering / Stripe / cloud DB / `/users`.
- **Gateway feature flags.** `electron/headlessServer/config/gatewayFlags.ts` (`resolveGatewayFlags()`) → `{ chat, tokenOwner, crud, cloudProxy }`. `chat` defaults ON (post-cutover; a Conf key `gateway.chat === false` is the escape hatch that forces the cloud/openrouter server path off). `tokenOwner` (default OFF) gates the server-as-sole Supabase-token refresher (`services/appAuthTokenManager.ts`, paired with the renderer flag in `client/ygg-chat-r/src/helpers/serverLoopSettings.ts`). `crud`/`cloudProxy` are vestigial — the gateway routes mount unconditionally (`enabled: true`). `YGG_GATEWAY_MODE` (truthy env) is a master override that turns all flags on.
- **Local storage mode.** `storage_mode: 'local'` entities stay in SQLite and do not sync to cloud; the gateway routes honor this per-write, server-side.
- **Headless/mobile.** The same local server exposes headless chat/provider/tool APIs and a mobile LAN UI; subagents run through the same engine.
- **Web mode.** Non-Electron web mode is NOT a target for the server-owned chat loop; the thin-client chat thunks require Electron.

**Retired / removed** (do not look for these):
- The renderer-owned chat loop (the former ~9,400-line `chatActions.ts`; now ~3,000 lines of thin-client delegation).
- Claude Code — `electron/tools/claudeCode.ts` plus its local-server routes and renderer thunks/types/reducers.
- Global Agent Loop (GAL) — `services/GlobalAgentLoop.ts`, `GlobalAgentBootstrap.tsx`, `hooks/useGlobalAgentCache.ts`, `hooks/useGlobalAgentMessages.ts`, `helpers/agentSettingsStorage.ts`, its routes, and the `agent_*` DB tables.
- The renderer's `dualSyncManager` + `src/lib/sync/*` — replaced by server-side `services/cloudMirrorService.ts` + `CloudMirrorSink`. (`src/lib/localMirror.ts` is the kept, slimmed drop-in for the few remaining renderer-side sync calls.)
- Removed renderer symbols: `isServerOwnedChatLoopEnabled`, `isCloudServerLoopEnabled`, `executeToolWithPermissionCheck`, the module-level `pending*Resolve` promises. (Note: verbatim snapshots of the old code survive only as inert test fixtures under `electron/tools/__tests__/*.ts.test` — never imported/compiled.)

## Key Files

- `general_project_context.md`: broad architecture map.
- `package.json`: root workspace and scripts.
- `client/ygg-chat-r/package.json`: app scripts, dependencies, test commands.
- `shared/types.ts`: shared domain contracts.
- `shared/builtinToolDefinitions.ts`: built-in tool schema contracts.
- `client/ygg-chat-r/src/App.tsx`: app shell and runtime bootstraps.
- `client/ygg-chat-r/src/main.tsx`: React/Redux/React Query bootstrap.
- `client/ygg-chat-r/electron/main.ts`: Electron process entry.
- `client/ygg-chat-r/electron/localServer.ts`: embedded local API server (CRUD/tools).
- `client/ygg-chat-r/electron/headlessServer/index.ts`: headless server route wiring — server-owned chat loop (`ChatOrchestrator`) + cloud gateway.
- `client/ygg-chat-r/src/features/chats/chatActions.ts`: thin-client chat thunks that delegate to the server loop.
- `client/ygg-chat-r/src/features/chats/mainChatClient.ts` + `sseProjection.ts`: SSE reader and Redux projection.

## Common Commands

From repository root:

```bash
npm run dev
npm run dev:electron
npm run build
npm run build:web
npm run build:electron
```

From `client/ygg-chat-r`:

```bash
npm run lint
npm run test:tools
npm run test:headless
npm run build:electron:main
```

## Agent Workflow

1. Read this overview and the most relevant subsystem doc.
2. Open key files listed by the subsystem doc before editing.
3. Preserve runtime boundaries: browser UI, Electron main, local/headless server, shared contracts.
4. For chat-loop / tool / gateway work, verify Electron/local-server (`:3002`) assumptions — the renderer is a thin client.
5. Run the narrowest validation command that covers the changed subsystem (`test:headless` for the server engine/gateway; `test:tools` for tools).

## Related Docs

- `general_project_context.md`
- `docs/agent_context/AGENT.md` (subsystem-doc maintenance rules)
- `docs/agent_context/agent_headless_server.md` (server engine + cloud gateway)
- `docs/agent_context/agent_runtime_modes.md`
