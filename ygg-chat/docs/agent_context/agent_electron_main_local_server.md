# Agent Context: Electron Main and Local Server

Last reviewed: 2026-08-21

## Purpose

Documents Electron main/preload responsibilities and the embedded local Express server used by the desktop app. Since the headless main-agent-loop migration, that same Express app (on `127.0.0.1:3002`) also co-mounts the server-owned chat engine and the cloud gateway — the renderer is now a thin client that talks ONLY to `:3002`.

Since the Phase 1 server/client separation, the server graph is runtime-neutral. Both hosts start it through one factory: `createYggServer(config, capabilities)`. Electron is one host. A standalone Node process is the other host (`npm run build:server` then `npm run start:server`).

The directory layout matches the boundary. `client/ygg-chat-r/server/` holds the whole runtime-neutral graph (composition modules at its root, plus `headlessServer/`, `tools/`, `mcp/`, `skills/`, `hooks/`, `lsp/`, `utils/`). `client/ygg-chat-r/electron/` is only the host shell: `main.ts`, `preload.ts`, `electronHostAdapter.ts`, `browseWeb.ts`, `UtilityToolRuntimeHost.ts`, and `esbuild.main.mjs`. Built bundles (`main.mjs`, `preload.mjs`, `toolRuntimeUtility.mjs`, `localAnalyticsWorker.mjs`) still land in `electron/`, so packaged runtime paths did not change.

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

- `client/ygg-chat-r/electron/main.ts`: Electron entry and window/server lifecycle. It starts the server through `createYggServer(buildElectronServerConfig(...), buildElectronHostCapabilities())` and stops it through the returned handle's single-flight `close()`. IPC `app-auth:get-fresh-token` (gated on `resolveGatewayFlags().tokenOwner`).
- `client/ygg-chat-r/electron/electronHostAdapter.ts`: the Electron host adapter. It supplies paths (`userData`, `temp`, resources), the Conf-backed config/secret stores, `restart`, `openExternal`, the `utilityProcess` tool sandbox, and the BrowserWindow-backed `browse_web` engine. Only Electron-side files import `electron`.
- `client/ygg-chat-r/server/` (root modules): the runtime-neutral server composition — `serverConfig.ts` (validated `YggServerConfig`), `hostCapabilities.ts` (capability contracts), `serverHost.ts` (injected host context + host-gated tool names), `createYggServer.ts` (factory + lifecycle handle), `builtinToolRegistry.ts` (all 25 movable built-in tool registrations; `browse_web` registers only when the host supplies a browser engine), `toolSandboxPolicy.ts` (the 14-tool out-of-process whitelist), `corsPolicy.ts`, `nodeStores.ts`, and `standaloneEntry.ts` (the standalone CLI). Nothing under `server/` may import `electron`; `npm run build:server` fails the build on any such import. The server graph also must not depend on Electron's ambient types (`typecheck:server` runs without them; see `headlessServer/providers/webStreamTypes.ts` for the shared stream-result shape).
- `client/ygg-chat-r/electron/preload.ts`: renderer preload bridge.
- `client/ygg-chat-r/server/localServer.ts`: the single embedded Express app (prefers port 3002, falls back to other local ports). Since the decomposition it is a ~2,300-line composition shell: module state, SQLite init + schema migrations + prepared statements, tool sandbox wiring, the IDE-context WebSocket server, `setupServer()` (which only registers route modules), and the start/stop lifecycle. `setupServer()` calls `registerHeadlessServerRoutes(app, { db, statements, orchestrator })`, mounting the headless chat engine + cloud gateway onto the SAME app/port. (Claude Code + GlobalAgentLoop routes and `agent_*` prepared statements have been REMOVED — see "Removed / retired".)
- `client/ygg-chat-r/server/routes/`: the local-API route modules extracted from `localServer.ts`, one register function each, code moved verbatim: `openaiOAuthRoutes.ts` (OpenAI ChatGPT OAuth + the port-1455 callback server), `runStateRoutes.ts` (`/api/streaming/runs*`, `/api/subagents/*`), `syncStorageRoutes.ts` (`/api/sync/*`, `/api/local/attachments/*`), `memoryRoutes.ts` (`/api/memory/*` + the `memory_manage` tool handler), `hookRoutes.ts`, `undoRoutes.ts`, `toolExecutionRoutes.ts` (`/api/tools/execute`, `/api/custom-tools*`), `appStoreRoutes.ts` (`/api/app-store/*`, `/api/app/restart`), `jobRoutes.ts` (`/api/jobs*`), `analyticsRoutes.ts` (`/api/sync/stats`, `/api/local/analytics/dashboard`), `userProjectRoutes.ts` (`/api/local/users*`, `/api/local/projects*`, conversation-meta patches), `noteSearchRoutes.ts` (`/api/local/conversations/search*`; returns `searchNotes`/`searchTopLevelUserMessages` for the tool registry), and `conversationRoutes.ts` (`/api/local/conversations*`, `/api/local/messages/*` — registered after the search routes so `/search*` wins over `/:id`).
- `client/ygg-chat-r/server/localOperations.ts`: local storage/operation helpers.
- `client/ygg-chat-r/server/localToolsRoutes.ts`: HTML tools route/table integration (registered via `registerToolsRoutes`).
- `client/ygg-chat-r/server/envLoader.ts`: environment loading.
- `client/ygg-chat-r/server/proxyGateway.ts`: proxy/gateway support.
- `client/ygg-chat-r/server/openaiChatgptOAuth.ts`: local OpenAI OAuth helpers (login/OAuth stays Electron-bound by design).
- `client/ygg-chat-r/server/headlessServer/index.ts`: `registerHeadlessServerRoutes` — wires the chat engine (`ChatOrchestrator`, `DecisionBroker`, `CompactionService`), subagents, and both gateway surfaces.

### Headless chat engine + gateway (mounted onto the same `:3002` app)

- `client/ygg-chat-r/server/headlessServer/routes/chatRoutes.ts`: server-owned MAIN chat loop. `POST /api/conversations/:id/messages`, `.../repeat`, `.../:messageId/branch`, `.../:messageId/edit-branch` (SSE) → `ChatOrchestrator.runMessage`; plus `POST /api/resume` (pause/resume decisions) and `POST /api/conversations/:id/compact` (manual compaction).
- `client/ygg-chat-r/server/headlessServer/routes/gatewayRoutes.ts`: `/api/gw/*` — storage-aware CRUD/merge for conversations/projects/messages/attachments (collapses the old renderer `shouldUseLocalApi` dual-fetch/merge + dual-write). Local leg is an in-process loopback to `/api/app/*`; cloud leg goes through `railwayClient`.
- `client/ygg-chat-r/server/headlessServer/routes/cloudProxyRoutes.ts`: `/api/cloud/*` — authenticated pass-through to Railway (allowlist: `/models`, `/users`, `/system-prompts`, `/stripe`, `/app-store`, `/oauth`; anything else → 403).
- `client/ygg-chat-r/server/headlessServer/config/gatewayFlags.ts`: `resolveGatewayFlags()` → `{ chat, tokenOwner, crud, cloudProxy }`. `chat` defaults ON (post-cutover); `tokenOwner` default OFF; `crud`/`cloudProxy` are VESTIGIAL (the gateway routes mount with hardcoded `enabled: true` in `index.ts` regardless). Master override env `YGG_GATEWAY_MODE`.
- Supporting services: `headlessServer/services/{chatOrchestrator,decisionBroker,chatHookService,compactionService,messageSink,railwayClient,cloudMirrorService,appAuthTokenManager}.ts`. Deeper detail lives in `agent_headless_server.md`.

## Runtime Context

- Electron main process owns native capabilities.
- Renderer should access native/local features through preload/local API, not direct Node APIs.
- Local server listens on `127.0.0.1:3002` in Electron local mode (fallback ports if taken). `:3002` now hosts three surfaces on one app: local `/api/app/*` CRUD, the cloud gateway (`/api/gw/*`, `/api/cloud/*`), and the server-owned chat SSE routes.
- The MAIN chat agent loop is NO LONGER renderer-owned. It runs server-side (`ChatOrchestrator` → `ToolLoopService`); the renderer's chat thunks POST the SSE routes and project the events onto existing Redux state. Tool execution, permission/hook/compaction orchestration all live server-side. The chat thunks require a local-server runtime — Electron or the standalone browser target (`isLocalServerRuntime()` in `src/utils/api.ts`); they throw in plain web mode.

### Standalone server (Phase 1)

- Build: `npm run build:server` → `dist-server/ygg-server.mjs` plus the Node-ABI sandbox bundle and copied assets (prompts, mobile UI, theme templates). One-time per Node version: `npm run install:server-native` installs a Node-ABI `better-sqlite3` under `dist-server/` (kept separate from the Electron-ABI build in `node_modules`).
- Run: `YGG_DATA_DIR=<dir> npm run start:server`. Environment contract documented at the top of `server/standaloneEntry.ts` (`YGG_HOST`, `YGG_PORT`, `YGG_DB_PATH`, `YGG_TEMP_DIR`, `YGG_RESOURCES_DIR`, `YGG_PROMPTS_DIR`, `YGG_OAUTH_CALLBACK_ENABLED`, `YGG_CORS_ALLOWED_ORIGINS`, `YGG_ALLOW_NON_LOOPBACK_BIND`, `YGG_TOOLS_RUNTIME`, `YGG_TOOL_RUNTIME_FALLBACK`).
- Security defaults differ from desktop on purpose: loopback bind only (non-loopback refused without the explicit override), loopback/allowlist CORS instead of permissive, OAuth callback listener OFF, tool runtime `utility` with the in-process fallback DISABLED (a sandbox failure fails the tool call), and `browse_web` absent from the advertised tool list (no browser engine capability — follow-on F1 in the Phase 1 plan).
- Browser dev target: `npm run dev:standalone` (Vite proxies `/api`, `/lsp`, `/ide-context` to the standalone server; `VITE_ENVIRONMENT=standalone` makes the renderer use same-origin/configured Ygg routes).

### Local server ⊕ headless server (ownership boundary)

- `localServer.ts` still owns: the Express app + port lifecycle, local SQLite `/api/app/*` CRUD, OAuth callback server (1455) + login/OAuth deep-links, and registration of tools/skills/MCP/LSP/proxy/local-ops routes.
- `headlessServer/*` (mounted via `registerHeadlessServerRoutes`) owns: the server-owned chat loop + pause/resume decisions, subagent runs, hooks-in-loop, compaction, and BOTH gateway surfaces (`/api/gw/*` storage-aware CRUD/merge, `/api/cloud/*` Railway pass-through) plus the token layer (`appAuthTokenManager`, `railwayClient`, `cloudMirrorService`).
- Railway stays AUTHORITATIVE for cloud DB / free-tier metering / Stripe / `/users`; the local server proxies, it does not own them.

### Removed / retired

- Claude Code: `electron/tools/claudeCode.ts` + its `localServer.ts` routes — GONE.
- GlobalAgentLoop (GAL): its `localServer.ts` routes and the `agent_settings` / `agent_sessions` / `agent_tasks` tables + prepared statements — GONE (no live CREATE/INSERT/prepared statements remain).
- `dualSyncManager` / `lib/sync/*` — replaced server-side by `cloudMirrorService` + `CloudMirrorSink` (no live module remains; only inert comment/docstring mentions, e.g. in `services/cloudMirrorService.ts` and `routes/gatewayRoutes.ts`).
- Note for greppers: two inert test fixtures (`server/tools/__tests__/dummyfile.ts.test`, `dummyFilechatAction.ts.test`, odd `.ts.test` extension) are verbatim snapshots of the OLD pre-migration source. They are read as plain text by `editFile.test.ts`, never imported/compiled — a grep for the retired names WILL hit them, but they are fixtures, not live code.

## Important Invariants

- Keep renderer/main boundaries explicit and secure.
- Do not expose broad native capabilities over preload without validation.
- Local server route changes can affect renderer, tools, mobile UI, and iframe apps.
- Startup/shutdown changes must clean up server, windows, and long-running processes (local server, OAuth callback server on 1455).
- Both gateway surfaces mount UNCONDITIONALLY (`enabled: true`) — the renderer is a thin client and has no local-vs-cloud CRUD fallback; do not gate them on `gateway.crud`/`gateway.cloudProxy` (those flags are vestigial).
- `gateway.chat === false` (Conf) is the escape hatch that forces the server chat loop off; otherwise it defaults ON.
- Server-as-sole-token-refresher is gated: the `app-auth:get-fresh-token` IPC returns `ownerEnabled:false` unless `gateway.tokenOwner` is on, so the renderer keeps self-refreshing (no half-rollout).

## Extension Points

- New local APIs belong in a route module under `server/routes/` with a register function, wired from `setupServer()`. Do not add inline route blocks to `localServer.ts`.
- Chat-engine / gateway changes belong under `headlessServer/*`, not `localServer.ts` (see `agent_headless_server.md`).
- New native capabilities should be mediated by typed request/response shapes.
- New tool registrations should update shared definitions and tests.

## Testing and Validation

- Build Electron: `npm --prefix client/ygg-chat-r run build:electron`.
- Build main/preload bundle: `npm --prefix client/ygg-chat-r run build:electron:main`.
- Build standalone server: `npm --prefix client/ygg-chat-r run build:server` (also the electron-import leak check).
- Server graph unit tests: `npm --prefix client/ygg-chat-r run test:server`.
- Tool/local route changes: `npm --prefix client/ygg-chat-r run test:tools`.
- Headless chat engine + gateway (chatRoutes/gatewayRoutes/cloudProxyRoutes/gatewayFlags/services): `npm --prefix client/ygg-chat-r run test:headless`.

## Related Docs

- `agent_runtime_modes.md`
- `agent_local_tools_runtime.md`
- `agent_headless_server.md`
- `agent_hooks_system.md`
