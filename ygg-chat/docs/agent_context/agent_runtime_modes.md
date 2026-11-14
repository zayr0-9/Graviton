---
paths:
  - "docs/agent_context/agent_runtime_modes.md"
  - "client/ygg-chat-r/src/config/runtimeMode.ts"
  - "client/ygg-chat-r/src/platform/clientCapabilities.ts"
  - "client/ygg-chat-r/src/helpers/serverLoopSettings.ts"
---

# Agent Context: Runtime Modes

Last reviewed: 2026-11-10

## Purpose

Explains how the app behaves across its delivery surfaces (Electron, the shared browser
client, the standalone host) and the local headless server. Graviton is **fully local**:
there is no hosted backend, account, cloud storage mode or plain web product.

## When to Open This File

Use this when changing:
- API routing or base URL selection;
- Electron-only features;
- local/headless server endpoints;
- the server-owned chat loop or resumable runs;
- code gated by `__BUILD_TARGET__` or runtime detection.

## Key Files

- `client/ygg-chat-r/src/platform/clientCapabilities.ts`: delivery surface from the build
  target only (`__BUILD_TARGET__` = `electron` | `browser-client` | `standalone`, defined by
  `vite.config.ts` and the test/smoke configs). `isNativeShell`, `isBrowserClient`,
  `isStandaloneClient`, `isHostClient`. No `.env` is needed.
- `client/ygg-chat-r/src/config/runtimeMode.ts`: `isElectronMode` and `LOCAL_AUTH_USER_ID`
  (the single local identity from `shared/localUser.ts`).
- `client/ygg-chat-r/src/utils/api.ts`: the renderer targets the resolved local server origin
  (preferred `http://127.0.0.1:3002`, with fallback ports and foreign-instance checks);
  `gwApi` (`/api/gw/*`) is a thin wrapper over `localApi`.
- `client/ygg-chat-r/src/lib/auth/*`: public local-auth state (no sign-in); see `agent_auth.md`.
- `client/ygg-chat-r/src/helpers/serverLoopSettings.ts`: renderer resumable-run setting.
- `client/ygg-chat-r/electron/main.ts`: starts the Electron shell and shared server through `createYggServer`.
- `client/ygg-chat-r/electron/electronHostAdapter.ts`: desktop config and privileged host capabilities.
- `client/ygg-chat-r/server/createYggServer.ts`: host-neutral composition/lifecycle root.
- `client/ygg-chat-r/server/standaloneEntry.ts`: existing Node host with `YGG_*` environment configuration.
- `client/ygg-chat-r/server/localServer.ts`: local API surface.
- `client/ygg-chat-r/server/headlessServer/index.ts`: headless server composition.

## Runtime Context

### Electron (native shell)

- Renderer runs the React app; the main process owns window lifecycle and starts the local Express server.
- Electron-specific capabilities belong in `electron/`. Shared backend/tool code belongs in
  `server/` and must not import Electron; the host adapter supplies privileged capabilities.
- `npm run dev` runs the Electron app.

### Browser client and standalone host

- `build:browser-client` serves the same React tree from the Electron host for trusted-network
  devices (`isBrowserClient`). `npm run dev:standalone` runs the renderer against the standalone
  Node host (`isStandaloneClient`). Both are host clients of the same local server; neither is a
  hosted web product.

### Persistence

- All data lives in local SQLite behind the local server. There is no storage mode to resolve;
  new rows write `storage_mode = 'local'` (the legacy column/type remain for old databases).

### Headless server

- The local headless Express server (`127.0.0.1:3002`) runs inside the Electron main process and
  OWNS the main chat agent loop for every provider route (`openaichatgpt`, `openrouterbyok`,
  `lmstudio`, `zai`, `deepseek`, `bedrock`; Claude Code uses its own session backend). The renderer is a thin
  SSE client. See `agent_headless_server.md`.
- `/api/gw/*` is a local data facade over `/api/app/*`. There is no `/api/cloud/*` proxy.
- Mobile LAN UI is served from the headless server under `server/headlessServer/ui/mobile`.

## Resumable runs

- Server: detach/reattach is always on (`resumableRuns = true` in `headlessServer/index.ts`;
  the old `gateway.*` feature flags and `YGG_GATEWAY_MODE` were removed). A bare disconnect
  DETACHES; the client resubscribes by `streamId`; Stop uses `POST /api/streams/:id/abort`.
  App quit still kills every run (in-memory sessions).
- Renderer: `isResumableRunsEnabled()` is always true for host clients; otherwise an explicit
  `localStorage['ygg.resumableRuns']` value wins, defaulting to `isElectronMode`.
  See `agent_chat_streaming_state.md`.

### Removed flags

`isServerOwnedChatLoopEnabled()`, `isCloudServerLoopEnabled()`, `gateway.tokenOwner`,
`gateway.chat/crud/cloudProxy/resumableRuns`, `VITE_ENVIRONMENT`-based runtime detection and the
cloud storage mode are gone. The 3 chat thunks in `src/features/chats/chatActions.ts` always
route through the server-owned loop on a host client.

## Gotchas and Constraints

- Do not add web fallbacks, cloud legs or `.env`-driven runtime switches.
- Keep shared type changes backward-compatible across renderer, Electron, and headless server.
- Outbound network is limited to user-configured model providers, MCP servers, the app-store
  catalog (`agent_app_store.md`) and GitHub Releases for updates.

## Testing and Validation

- Runtime helper/API changes: `npm --prefix client/ygg-chat-r run build:electron`.
- Host-neutral server/config changes: `npm --prefix client/ygg-chat-r run test:server` and `npm --prefix client/ygg-chat-r run typecheck:server`.
- Headless changes: `npm --prefix client/ygg-chat-r run test:headless`.
- Electron tool/server changes: `npm --prefix client/ygg-chat-r run test:tools` when relevant.

## Related Docs

- `agent_project_overview.md`
- `agent_electron_main_local_server.md`
- `agent_headless_server.md`
- `agent_auth.md`
