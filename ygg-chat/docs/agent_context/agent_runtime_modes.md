# Agent Context: Runtime Modes

Last reviewed: 2026-08-01

## Purpose

Explains how the app behaves across web, Electron, local storage, and headless runtime modes.

## When to Open This File

Use this when changing:
- API routing or base URL selection;
- `storage_mode` behaviour;
- Electron-only features;
- local/headless server endpoints;
- gateway feature flags or the server-owned chat loop;
- code gated by `BUILD_TARGET` or runtime detection.

## Key Files

- `client/ygg-chat-r/src/config/runtimeMode.ts`: runtime/build target helpers.
- `client/ygg-chat-r/src/utils/api.ts`: local/cloud API clients. The renderer targets ONLY `http://127.0.0.1:3002` (`DEFAULT_LOCAL_SERVER_ORIGIN`); `gwApi` (`/api/gw/*`) and `cloudApi` (`/api/cloud/*`) are thin wrappers over `localApi`.
- `client/ygg-chat-r/src/lib/auth/*`: auth providers per runtime.
- `client/ygg-chat-r/src/lib/localMirror.ts`: renderer-side local mirror. Drop-in replacement for the removed `dualSyncManager`/`lib/sync/*`; cloud mirroring now lives server-side in `electron/headlessServer/services/cloudMirrorService.ts`.
- `client/ygg-chat-r/src/helpers/serverLoopSettings.ts`: renderer token-owner flag (see Feature Flags).
- `client/ygg-chat-r/electron/main.ts`: starts Electron shell and local/headless server; hosts the `app-auth:get-fresh-token` IPC token-owner gate (main.ts:1020).
- `client/ygg-chat-r/electron/localServer.ts`: local API surface on Electron.
- `client/ygg-chat-r/electron/headlessServer/index.ts`: headless server composition.
- `client/ygg-chat-r/electron/headlessServer/config/gatewayFlags.ts`: gateway feature-flag resolution (see Feature Flags).
- `shared/types.ts`: `StorageMode` and core entity contracts.

## Runtime Context

### Web Mode

- React app runs in browser/Vite/deployed web context.
- Cloud/Supabase/API behaviour depends on configured API base.
- Local Electron-only APIs are unavailable.

### Electron Mode

- Renderer runs the same React app.
- Electron main process owns window lifecycle and starts the local Express server.
- Renderer can call local API endpoints and drive the server-owned chat loop through server routes.
- Native-sensitive code belongs in `electron/`, not browser components.

### Local Storage Mode

- Entities marked `storage_mode: 'local'` should remain local-only.
- Local persistence uses SQLite behind the Electron/local server.

### Headless Mode

- The local headless Express server (`127.0.0.1:3002`) runs inside the Electron main process and OWNS the main chat agent loop for all 5 providers (openrouter, lmstudio, openaichatgpt, zai, bedrock) after the headless thin-client migration. The renderer is a thin SSE client — no loop control, tool execution, or permission/hook/compaction orchestration. See `agent_headless_server.md`.
- Headless APIs under `electron/headlessServer` expose server-side chat orchestration, providers, tool execution, and the `/api/gw/*` (storage-aware CRUD) and `/api/cloud/*` (authenticated Railway pass-through) gateway surfaces.
- Mobile LAN UI is served from the headless server and lives under `electron/headlessServer/ui/mobile`.

## Feature Flags

### Server: gateway flags (`electron/headlessServer/config/gatewayFlags.ts`)

`resolveGatewayFlags()` returns `GatewayFlags { chat, tokenOwner, crud, cloudProxy, resumableRuns }`:

- `chat` — DEFAULT ON (Phase 6 cutover). Gates the server-owned cloud (openrouter) path: `CloudMirrorSink` Railway-message-id adoption + free-tier SSE relay. Consumed via `cloudChatEnabled: gatewayFlags.chat` (index.ts:321) into `ChatOrchestrator`. An explicit Conf key `gateway.chat === false` is the escape hatch that forces it off.
- `tokenOwner` — DEFAULT OFF. Makes the server the sole Supabase-token refresher. Consumed only by the `app-auth:get-fresh-token` IPC gate (main.ts:1020), coupled to the renderer flag below.
- `crud`, `cloudProxy` — DEFAULT OFF and VESTIGIAL. The Phase 5 gateway routes mount unconditionally (`registerGatewayRoutes`/`registerCloudProxyRoutes` with hardcoded `enabled: true` in index.ts); these flags are computed but never read at the mount site. Plumbing kept.
- `resumableRuns` — DEFAULT OFF. Decouples a chat run's lifetime from its SSE socket: a bare disconnect DETACHES (the run keeps running) instead of aborting; the client resubscribes by `streamId` and only `POST /api/streams/:id/abort` cancels. Consumed by `runSseOrchestrator` + the reaper (`runSessionRegistry`). See `agent_headless_server.md` §Detach/Reattach. App-quit still kills every run (in-memory sessions).

Master override: env `YGG_GATEWAY_MODE` truthy (`/^(1|true|yes|on)$/i`) turns all five flags on and short-circuits any Conf read. Otherwise each flag reads its own Conf key (store `{ projectName: 'ygg-chat-r' }`), wrapped in try/catch so a bad/missing store keeps `chat` on and never breaks startup.

### Renderer flags (`src/helpers/serverLoopSettings.ts`)

Two independent renderer slices (the former `isServerOwnedChatLoopEnabled` / `isCloudServerLoopEnabled` chat-loop flags were deleted in the Phase 6 cutover):

- `isServerTokenOwnerEnabled()` / `setServerTokenOwnerEnabled()` — DEFAULT OFF; gated on env `VITE_SERVER_TOKEN_OWNER` or `localStorage['ygg.serverTokenOwner']`. When on, the renderer stops self-refreshing Supabase tokens and adopts the server-rotated session. Double-gated with the server `gateway.tokenOwner` flag at the IPC boundary — if the IPC reply is `ownerEnabled: false`, the renderer falls back to self-refresh (safe, no half-rollout).
- `isResumableRunsEnabled()` / `setResumableRunsEnabled()` — DEFAULT OFF; gated on env `VITE_RESUMABLE_RUNS` or `localStorage['ygg.resumableRuns']`. When on, the renderer resubscribes to a dropped run by `streamId`, routes Stop through `POST /api/streams/:id/abort`, and re-attaches to in-flight runs after a reload (`resumeInFlightStreams`). Coupled to the server `gateway.resumableRuns` flag — with the server flag off, the `/api/streams/*` routes `501` and resubscribe degrades to a harmless no-op. See `agent_chat_streaming_state.md`.

### Removed renderer flags

The former renderer loop-enable flags `isServerOwnedChatLoopEnabled()` and `isCloudServerLoopEnabled()` (and their env/localStorage overrides) were DELETED at the Phase 6 cutover. The 3 chat thunks in `src/features/chats/chatActions.ts` now unconditionally route through the server-owned loop in Electron (they throw outside Electron); there is no renderer-side loop toggle.

## Gotchas and Constraints

- Do not call Electron/local APIs from pure web flows without runtime checks.
- Do not sync `storage_mode: 'local'` data to cloud.
- Keep shared type changes backward-compatible across renderer, Electron, and headless server.
- `general_project_context.md` references a root `server/`; verify it exists before editing server paths.

## Testing and Validation

- Runtime helper/API changes: `npm --prefix client/ygg-chat-r run build:web` and/or `npm --prefix client/ygg-chat-r run build:electron`.
- Headless changes (incl. gateway flags): `npm --prefix client/ygg-chat-r run test:headless`.
- Electron tool/server changes: `npm --prefix client/ygg-chat-r run test:tools` when relevant.

## Related Docs

- `agent_project_overview.md`
- `agent_electron_main_local_server.md`
- `agent_headless_server.md`
- `agent_global_persistent_agent.md` (RETIRED tombstone — the renderer-owned global agent loop no longer exists)
