# Agent Context: Electron Main and Local Server

Last reviewed: 2026-08-01

## Purpose

Documents Electron main/preload responsibilities and the embedded local Express server used by the desktop app. Since the headless main-agent-loop migration, that same Express app (on `127.0.0.1:3002`) also co-mounts the server-owned chat engine and the cloud gateway — the renderer is now a thin client that talks ONLY to `:3002`.

## When to Open This File

Use this when changing:
- BrowserWindow lifecycle;
- preload APIs;
- app startup/shutdown;
- local API routes (`/api/app/*` SQLite CRUD);
- local server registration for tools, hooks, MCP, skills, headless chat engine, cloud gateway;
- OAuth callbacks in local runtime;
- the server-owned chat loop / gateway ownership boundary (see "Local server ⊕ headless server" below).

## Key Files

- `client/ygg-chat-r/electron/main.ts`: Electron entry and window/server lifecycle; `startLocalServer`/`stopLocalServer`; IPC `app-auth:get-fresh-token` (gated on `resolveGatewayFlags().tokenOwner`, `main.ts:1020`).
- `client/ygg-chat-r/electron/preload.ts`: renderer preload bridge.
- `client/ygg-chat-r/electron/localServer.ts`: the single embedded Express app (prefers port 3002, falls back to other local ports). Owns local `/api/app/*` SQLite CRUD (conversations/projects/messages/attachments), health, OAuth callback server (port 1455), and route registration for tools/skills/MCP/LSP/proxy/local-ops. At `localServer.ts:2758` it calls `registerHeadlessServerRoutes(app, { db, statements })`, mounting the headless chat engine + cloud gateway onto the SAME app/port. (Claude Code + GlobalAgentLoop routes and `agent_*` prepared statements have been REMOVED — see "Removed / retired".)
- `client/ygg-chat-r/electron/localOperations.ts`: local storage/operation helpers.
- `client/ygg-chat-r/electron/localToolsRoutes.ts`: HTML tools route/table integration (registered via `registerToolsRoutes`).
- `client/ygg-chat-r/electron/envLoader.ts`: environment loading.
- `client/ygg-chat-r/electron/proxyGateway.ts`: proxy/gateway support.
- `client/ygg-chat-r/electron/openaiChatgptOAuth.ts`: local OpenAI OAuth helpers (login/OAuth stays Electron-bound by design).
- `client/ygg-chat-r/electron/headlessServer/index.ts`: `registerHeadlessServerRoutes` — wires the chat engine (`ChatOrchestrator`, `DecisionBroker`, `CompactionService`), subagents, and both gateway surfaces.

### Headless chat engine + gateway (mounted onto the same `:3002` app)

- `client/ygg-chat-r/electron/headlessServer/routes/chatRoutes.ts`: server-owned MAIN chat loop. `POST /api/conversations/:id/messages`, `.../repeat`, `.../:messageId/branch`, `.../:messageId/edit-branch` (SSE) → `ChatOrchestrator.runMessage`; plus `POST /api/resume` (pause/resume decisions) and `POST /api/conversations/:id/compact` (manual compaction).
- `client/ygg-chat-r/electron/headlessServer/routes/gatewayRoutes.ts`: `/api/gw/*` — storage-aware CRUD/merge for conversations/projects/messages/attachments (collapses the old renderer `shouldUseLocalApi` dual-fetch/merge + dual-write). Local leg is an in-process loopback to `/api/app/*`; cloud leg goes through `railwayClient`.
- `client/ygg-chat-r/electron/headlessServer/routes/cloudProxyRoutes.ts`: `/api/cloud/*` — authenticated pass-through to Railway (allowlist: `/models`, `/users`, `/system-prompts`, `/stripe`, `/app-store`, `/oauth`; anything else → 403).
- `client/ygg-chat-r/electron/headlessServer/config/gatewayFlags.ts`: `resolveGatewayFlags()` → `{ chat, tokenOwner, crud, cloudProxy }`. `chat` defaults ON (post-cutover); `tokenOwner` default OFF; `crud`/`cloudProxy` are VESTIGIAL (the gateway routes mount with hardcoded `enabled: true` in `index.ts` regardless). Master override env `YGG_GATEWAY_MODE`.
- Supporting services: `headlessServer/services/{chatOrchestrator,decisionBroker,chatHookService,compactionService,messageSink,railwayClient,cloudMirrorService,appAuthTokenManager}.ts`. Deeper detail lives in `agent_headless_server.md`.

## Runtime Context

- Electron main process owns native capabilities.
- Renderer should access native/local features through preload/local API, not direct Node APIs.
- Local server listens on `127.0.0.1:3002` in Electron local mode (fallback ports if taken). `:3002` now hosts three surfaces on one app: local `/api/app/*` CRUD, the cloud gateway (`/api/gw/*`, `/api/cloud/*`), and the server-owned chat SSE routes.
- The MAIN chat agent loop is NO LONGER renderer-owned. It runs server-side in the Electron main process (`ChatOrchestrator` → `ToolLoopService`); the renderer's chat thunks POST the SSE routes and project the events onto existing Redux state. Tool execution, permission/hook/compaction orchestration all live server-side. The chat thunks require Electron (they throw otherwise).

### Local server ⊕ headless server (ownership boundary)

- `localServer.ts` still owns: the Express app + port lifecycle, local SQLite `/api/app/*` CRUD, OAuth callback server (1455) + login/OAuth deep-links, and registration of tools/skills/MCP/LSP/proxy/local-ops routes.
- `headlessServer/*` (mounted via `registerHeadlessServerRoutes`) owns: the server-owned chat loop + pause/resume decisions, subagent runs, hooks-in-loop, compaction, and BOTH gateway surfaces (`/api/gw/*` storage-aware CRUD/merge, `/api/cloud/*` Railway pass-through) plus the token layer (`appAuthTokenManager`, `railwayClient`, `cloudMirrorService`).
- Railway stays AUTHORITATIVE for cloud DB / free-tier metering / Stripe / `/users`; the local server proxies, it does not own them.

### Removed / retired

- Claude Code: `electron/tools/claudeCode.ts` + its `localServer.ts` routes — GONE.
- GlobalAgentLoop (GAL): its `localServer.ts` routes and the `agent_settings` / `agent_sessions` / `agent_tasks` tables + prepared statements — GONE (no live CREATE/INSERT/prepared statements remain).
- `dualSyncManager` / `lib/sync/*` — replaced server-side by `cloudMirrorService` + `CloudMirrorSink` (no live module remains; only inert comment/docstring mentions, e.g. in `services/cloudMirrorService.ts` and `routes/gatewayRoutes.ts`).
- Note for greppers: two inert test fixtures (`electron/tools/__tests__/dummyfile.ts.test`, `dummyFilechatAction.ts.test`, odd `.ts.test` extension) are verbatim snapshots of the OLD pre-migration source. They are read as plain text by `editFile.test.ts`, never imported/compiled — a grep for the retired names WILL hit them, but they are fixtures, not live code.

## Important Invariants

- Keep renderer/main boundaries explicit and secure.
- Do not expose broad native capabilities over preload without validation.
- Local server route changes can affect renderer, tools, mobile UI, and iframe apps.
- Startup/shutdown changes must clean up server, windows, and long-running processes (local server, OAuth callback server on 1455).
- Both gateway surfaces mount UNCONDITIONALLY (`enabled: true`) — the renderer is a thin client and has no local-vs-cloud CRUD fallback; do not gate them on `gateway.crud`/`gateway.cloudProxy` (those flags are vestigial).
- `gateway.chat === false` (Conf) is the escape hatch that forces the server chat loop off; otherwise it defaults ON.
- Server-as-sole-token-refresher is gated: the `app-auth:get-fresh-token` IPC returns `ownerEnabled:false` unless `gateway.tokenOwner` is on, so the renderer keeps self-refreshing (no half-rollout).

## Extension Points

- New local APIs usually belong in extracted route modules where practical, not as huge inline blocks in `localServer.ts`.
- Chat-engine / gateway changes belong under `headlessServer/*`, not `localServer.ts` (see `agent_headless_server.md`).
- New native capabilities should be mediated by typed request/response shapes.
- New tool registrations should update shared definitions and tests.

## Testing and Validation

- Build Electron: `npm --prefix client/ygg-chat-r run build:electron`.
- Build main/preload bundle: `npm --prefix client/ygg-chat-r run build:electron:main`.
- Tool/local route changes: `npm --prefix client/ygg-chat-r run test:tools`.
- Headless chat engine + gateway (chatRoutes/gatewayRoutes/cloudProxyRoutes/gatewayFlags/services): `npm --prefix client/ygg-chat-r run test:headless`.

## Related Docs

- `agent_runtime_modes.md`
- `agent_local_tools_runtime.md`
- `agent_headless_server.md`
- `agent_hooks_system.md`
