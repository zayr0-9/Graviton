---
paths:
  - "docs/agent_context/agent_runtime_modes.md"
---

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
- `client/ygg-chat-r/src/utils/api.ts`: local/cloud API clients. The renderer targets the resolved local server origin (preferred default `http://127.0.0.1:3002`, with fallback ports and foreign-instance checks); `gwApi` (`/api/gw/*`) and `cloudApi` (`/api/cloud/*`) are thin wrappers over `localApi`.
- `client/ygg-chat-r/src/lib/auth/*`: auth providers per runtime.
- `client/ygg-chat-r/src/lib/localMirror.ts`: renderer-side local mirror. Drop-in replacement for the removed `dualSyncManager`/`lib/sync/*`; cloud mirroring now lives server-side in `server/headlessServer/services/cloudMirrorService.ts`.
- `client/ygg-chat-r/src/helpers/serverLoopSettings.ts`: renderer resumable-run settings (see Feature Flags).
- `client/ygg-chat-r/electron/main.ts`: starts the Electron shell and shared server through `createYggServer`.
- `client/ygg-chat-r/electron/electronHostAdapter.ts`: desktop config and privileged host capabilities.
- `client/ygg-chat-r/server/createYggServer.ts`: host-neutral composition/lifecycle root.
- `client/ygg-chat-r/server/standaloneEntry.ts`: existing Node host with `YGG_*` environment configuration.
- `client/ygg-chat-r/server/auth/runtime.ts`: unconditional canonical auth-session ownership.
- `client/ygg-chat-r/server/localServer.ts`: local API surface on Electron.
- `client/ygg-chat-r/server/headlessServer/index.ts`: headless server composition.
- `client/ygg-chat-r/server/headlessServer/config/gatewayFlags.ts`: gateway feature-flag resolution (see Feature Flags).
- `shared/types.ts`: `StorageMode` and core entity contracts.

## Runtime Context

### Legacy Web Mode

Web build/runtime branches remain in source, but are not a supported app target in
this repository. Do not add web fallbacks or require web builds for desktop changes.
The existing standalone Node server is a host for the shared backend, not evidence
that arbitrary web-mode behavior must be preserved.

### Electron Mode

- Renderer runs the same React app.
- Electron main process owns window lifecycle and starts the local Express server.
- Renderer can call local API endpoints and drive the server-owned chat loop through server routes.
- Electron-specific capabilities belong in `electron/`. Shared backend/tool code belongs in `server/` and must not import Electron; the host adapter supplies privileged capabilities.

### Local Storage Mode

- Entities marked `storage_mode: 'local'` should remain local-only.
- Local persistence uses SQLite behind the Electron/local server.

### Headless Mode

- The local headless Express server (`127.0.0.1:3002`) runs inside the Electron main process and OWNS the main chat agent loop for all 5 providers (openrouter, lmstudio, openaichatgpt, zai, bedrock) after the headless thin-client migration. The renderer is a thin SSE client — no loop control, tool execution, or permission/hook/compaction orchestration. See `agent_headless_server.md`.
- Headless APIs under `server/headlessServer` expose server-side chat orchestration, providers, tool execution, and the `/api/gw/*` (storage-aware CRUD) and `/api/cloud/*` (authenticated Railway pass-through) gateway surfaces.
- Mobile LAN UI is served from the headless server and lives under `server/headlessServer/ui/mobile`.

## Feature Flags

### Server: gateway flags (`server/headlessServer/config/gatewayFlags.ts`)

`resolveGatewayFlags()` returns `GatewayFlags { chat, crud, cloudProxy, resumableRuns }`:

- `chat` — DEFAULT ON (Phase 6 cutover). Gates the server-owned cloud (openrouter) path: `CloudMirrorSink` Railway-message-id adoption + free-tier SSE relay. Consumed via `cloudChatEnabled: gatewayFlags.chat` (index.ts:321) into `ChatOrchestrator`. An explicit Conf key `gateway.chat === false` is the escape hatch that forces it off.
- `crud`, `cloudProxy` — DEFAULT OFF and VESTIGIAL. The Phase 5 gateway routes mount unconditionally (`registerGatewayRoutes`/`registerCloudProxyRoutes` with hardcoded `enabled: true` in index.ts); these flags are computed but never read at the mount site. Plumbing kept.
- `resumableRuns` — DEFAULT ON; explicit Conf `false` opts out. Decouples a chat run's lifetime from its SSE socket: a bare disconnect DETACHES (the run keeps running) instead of aborting; the client resubscribes by `streamId`; explicit cancellation uses `POST /api/streams/:id/abort`, while detached-run reaping, replacement, and process shutdown can also stop runs. Consumed by `runSseOrchestrator` + the reaper (`runSessionRegistry`). See `agent_headless_server.md` §Detach/Reattach. App-quit still kills every run (in-memory sessions).

Master override: env `YGG_GATEWAY_MODE` truthy (`/^(1|true|yes|on)$/i`) turns all four flags on and short-circuits any Conf read. Otherwise each flag reads its own Conf key (store `{ projectName: 'ygg-chat-r' }`), wrapped in try/catch so a bad/missing store keeps `chat` on and never breaks startup.

### Renderer flags (`src/helpers/serverLoopSettings.ts`)

Only the resumable-run setting remains. Authentication ownership is unconditional
in `server/auth/`; `gateway.tokenOwner`, `isServerTokenOwnerEnabled`,
`setServerTokenOwnerEnabled`, and their env/localStorage toggles have been removed.
See `agent_auth.md` for the canonical auth-session flow.
- `isResumableRunsEnabled()` / `setResumableRunsEnabled()` — DEFAULT ON in Electron; env `VITE_RESUMABLE_RUNS` or an explicit `localStorage['ygg.resumableRuns']` value overrides it. When on, the renderer resubscribes to a dropped run by `streamId`, routes Stop through `POST /api/streams/:id/abort`, and re-attaches to in-flight runs after a reload (`resumeInFlightStreams`). Coupled to the server `gateway.resumableRuns` flag — with the server flag off, the `/api/streams/*` routes `501` and resubscribe degrades to a harmless no-op. See `agent_chat_streaming_state.md`.

### Removed renderer flags

The former renderer loop-enable flags `isServerOwnedChatLoopEnabled()` and `isCloudServerLoopEnabled()` (and their env/localStorage overrides) were DELETED at the Phase 6 cutover. The 3 chat thunks in `src/features/chats/chatActions.ts` route through the server-owned loop in a local-server runtime (Electron or the existing standalone target; plain web throws); there is no renderer-side loop toggle.

## Gotchas and Constraints

- Do not call Electron/local APIs from pure web flows without runtime checks.
- Do not sync `storage_mode: 'local'` data to cloud.
- Keep shared type changes backward-compatible across renderer, Electron, and headless server.
- `general_project_context.md` references a root `server/`; verify it exists before editing server paths.

## Testing and Validation

- Runtime helper/API changes: `npm --prefix client/ygg-chat-r run build:electron`.
- Host-neutral server/config changes: `npm --prefix client/ygg-chat-r run test:server` and `npm --prefix client/ygg-chat-r run typecheck:server`.
- Headless changes (incl. gateway flags): `npm --prefix client/ygg-chat-r run test:headless`.
- Electron tool/server changes: `npm --prefix client/ygg-chat-r run test:tools` when relevant.

## Related Docs

- `agent_project_overview.md`
- `agent_electron_main_local_server.md`
- `agent_headless_server.md`
- `agent_global_persistent_agent.md` (RETIRED tombstone — the renderer-owned global agent loop no longer exists)
