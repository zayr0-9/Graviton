# General Project Context (Agent Overview)

> **Historical — cloud parts removed.** Graviton is now fully local (2026-11): there is no Supabase/Railway
> account or sync, cloud storage mode, hosted OpenRouter provider, Stripe billing or web product. Sections that
> describe those are kept for history only. Current behaviour: `ygg-chat/docs/agent_context/AGENT.md`.

This file is a high-level architecture map of `ygg-chat` for agents and developers. It explains runtime modes, where core logic lives, and which files to open first for common tasks.

## 1) What this project is

`ygg-chat` is a full-stack AI chat product with:
- Web runtime (React frontend + Express backend + Supabase).
- Electron desktop runtime (same React UI, plus Electron main process and embedded local Express + SQLite server).
- Agentic tooling (built-in tools, custom tools, MCP tools, skill system, background job orchestration).
- A persistent global background agent in Electron local mode.

It is organized as an npm workspace:
- `client/ygg-chat-r` (frontend + Electron code)
- `server` (cloud/server API)
- `shared` (shared types and provider metadata)

## 2) Runtime modes and request flow

### Web mode
- Frontend uses `API_BASE` (default `http://localhost:3001/api` or deployed API URL).
- Server mounts Supabase-backed routes (`supaChat`, `supaStore`, `supaAgents`, OAuth/provider routes).
- Storage source of truth is cloud (Supabase/Postgres).

### Electron mode
- Electron main process starts local server on port `3002` from `client/ygg-chat-r/electron/localServer.ts`.
- Frontend can call:
  - Cloud API (`server` on `3001`) for cloud-mode data.
  - Local API (`http://127.0.0.1:3002/api`) for local-mode data and local tools.
- Dual-sync path mirrors cloud records into local SQLite cache when applicable.

### Local storage mode
- Entities can be marked `storage_mode: 'local'` and stay local-only in SQLite.
- Persistent background/global agent is designed to run in this local-only mode.

## 3) Top-level layout

- `client/ygg-chat-r/`: React app, Redux state, Electron shell/local server, tooling runtime.
- `server/`: Express API for web/cloud flows, Supabase and provider integrations.
- `shared/types.ts`: Cross-runtime shared contracts (`MessageId`, `ConversationId`, `StorageMode`, tool definitions, etc.).
- `supabase-migrations/` and SQL docs: migration/reference scripts.
- `PERSISTENT_AGENT_CONTEXT.md`: deep design context for persistent background agent.
- `html_frame_context.md`: deep design context for HTML custom-app iframe system.

## 4) Frontend architecture (`client/ygg-chat-r/src`)

### Entry and app shell
- `client/ygg-chat-r/src/main.tsx`: bootstraps Redux + React Query + auth + app rendering.
- `client/ygg-chat-r/src/App.tsx`: route shell, Electron-vs-web router selection, global bootstraps.
- `client/ygg-chat-r/src/GlobalAgentBootstrap.tsx`: initializes global agent loop in Electron.

### State management
- `client/ygg-chat-r/src/store/store.ts`: root Redux store + startup tool fetching.
- Feature slices in `client/ygg-chat-r/src/features/*`:
  - `chats/`: chat flow, streaming, tools, provider dispatching.
  - `conversations/`, `projects/`, `users/`, `search/`, `ui/`, `ideContext/`, `voiceSettings/`.

### Chat/streaming core
- `client/ygg-chat-r/src/features/chats/chatActions.ts`: primary orchestration thunk(s):
  - sends messages,
  - starts typed streams (`primary`, `branch`, `subagent`, `tool`),
  - attaches `conversationId` and branch lineage metadata,
  - updates stream lineage after branch/user nodes are materialized,
  - handles SSE stream events,
  - executes tool calls with permission checks,
  - supports subagent/orchestrator behavior.
- `client/ygg-chat-r/src/features/chats/chatSlice.ts`: Redux chat state including the multi-stream container (`streaming.activeIds`, `streaming.byId`, `primaryStreamId`, `lastCompletedId`) plus per-stream buffers/events/tool calls keyed by `streamId`.
- `client/ygg-chat-r/src/features/chats/chatSelectors.ts`: branch-aware and conversation-aware stream selection, especially `selectCurrentViewStream`.
- `client/ygg-chat-r/src/containers/Chat.tsx`: consumes the branch-aware stream selector, keeps a short-lived pending stream fallback, and drives visible loading/stream UI from the current branch stream instead of a purely global streaming flag.
- `client/ygg-chat-r/src/features/chats/toolDefinitions.ts`: merged built-in + custom + MCP tool registry used by model/tool runtime.

### API and sync utilities
- `client/ygg-chat-r/src/utils/api.ts`: cloud/local API clients, auth token refresh behavior, endpoint selection.
- `client/ygg-chat-r/src/lib/sync/dualSyncManager.ts`: cloud-to-local sync queue for Electron (skip local-only rows).

### HTML tool UI bridge (custom app iframes)
- `client/ygg-chat-r/src/components/HtmlIframeRegistry/HtmlIframeRegistry.tsx`:
  - iframe lifecycle, caching, hibernate/evict behavior.
  - tracks `toolName` for permission checks.
- `client/ygg-chat-r/src/components/ChatMessage/*`: inline HTML tool rendering path.
- `client/ygg-chat-r/src/utils/iframeBridge.ts`:
  - postMessage IPC bridge for iframe apps.
  - enforces custom app permissions (including agent read/write gates).

## 5) Electron architecture (`client/ygg-chat-r/electron`)

### Main process
- `client/ygg-chat-r/electron/main.ts`:
  - creates BrowserWindow(s),
  - starts/stops embedded local server,
  - exposes preload APIs and app lifecycle behavior.

### Embedded local server (port 3002)
- `client/ygg-chat-r/electron/localServer.ts`:
  - local SQLite-backed API surface,
  - sync endpoints (`/api/sync/*`, `/api/local/*`),
  - local tool execution endpoints,
  - persistent agent endpoints (`/api/agent/*`),
  - OpenAI auth callback/exchange helpers for local runtime.

### Local tooling and orchestration
- `client/ygg-chat-r/electron/tools/*`:
  - built-in tool implementations (`read_file`, `edit_file`, `bash`, `ripgrep`, etc.),
  - custom tool runtime (`customToolLoader.ts`, `customToolManager.ts`),
  - MCP bridge tool,
  - Claude Code tool integration.
- `client/ygg-chat-r/electron/tools/orchestrator/*`:
  - background job queue and execution lifecycle.
- `client/ygg-chat-r/electron/localToolsRoutes.ts`:
  - `html_tools` SQLite table and CRUD routes for iframe app persistence.

### Skills and MCP
- `client/ygg-chat-r/electron/skills/*`: skill loader/installer/route plumbing.
- `client/ygg-chat-r/electron/mcp/*`: MCP manager and API routes.

## 6) Cloud/server architecture (`server/src`)

### Entry and route mounting
- `server/src/index.ts`:
  - env setup, middleware, health endpoints, websocket channel (`/ide-context`),
  - mode-aware route mounting:
    - web mode: supabase-centric route sets (`supa*` routes),
    - local/electron mode: `chat` routes.

### Route modules
- `server/src/routes/chat.ts`: core chat endpoints for non-web mode.
- `server/src/routes/supaChat.ts`, `supaStore.ts`, `supaAgents.ts`: cloud/Supabase-oriented APIs.
- `server/src/routes/oauthProviders.ts`, `oobAuth.ts`: OAuth provider and OOB auth flow.
- `server/src/routes/stripe.ts`, `user.ts`, `settings.ts`, `search.ts`: billing/user/settings/search.

### Data, providers, workers
- `server/src/database/*`: schema/models/migrations/SQLite helpers.
- `server/src/utils/*`: provider adapters and shared backend utilities.
- `server/src/workers/openrouter-reconciliation.ts`: periodic reconciliation worker (web mode).

## 7) Data model and storage conventions

### Core entities
- Project, Conversation, Message are the main graph.
- Messages are tree-structured via `parent_id` and `children_ids`.
- Shared type contracts live in `shared/types.ts`.

### Storage mode convention
- `storage_mode: 'cloud' | 'local'` is central to routing and persistence behavior.
- Local mode implies SQLite via local server.
- Cloud mode implies Supabase-backed flows, optionally mirrored locally in Electron.

## 8) Persistent global agent context

Core implementation files:
- `client/ygg-chat-r/src/services/GlobalAgentLoop.ts`:
  - singleton loop service with start/pause/stop/tick lifecycle,
  - system project/session bootstrap,
  - queue polling and task execution,
  - stream + message cache updates.
- `client/ygg-chat-r/src/GlobalAgentBootstrap.tsx`: wires QueryClient + Redux context and initializes loop.
- `client/ygg-chat-r/electron/localServer.ts`: source of truth endpoints for:
  - `/api/agent/state`,
  - `/api/agent/tasks`,
  - `/api/agent/session/start`,
  - `/api/agent/session/end`,
  - `/api/agent-settings`.

Behavioral intent from design context:
- Agent runs in Electron/local mode.
- Uses a dedicated local `system` project + conversation/session.
- Operates through regular chat/tool stack with controlled loop semantics.

## 9) HTML frame/custom app context

Core implementation files:
- `client/ygg-chat-r/src/components/HtmlIframeRegistry/HtmlIframeRegistry.tsx`
- `client/ygg-chat-r/src/utils/iframeBridge.ts`
- `client/ygg-chat-r/electron/tools/customToolLoader.ts`
- `client/ygg-chat-r/electron/localToolsRoutes.ts`

Important mechanics:
- Custom tools can return HTML, rendered in iframe (inline in chat or registry modal).
- Registry persists iframe entries in SQLite `html_tools`.
- Iframe requests host capabilities through postMessage IPC bridge only.
- Agent access from iframe apps is permission-gated via custom tool `appPermissions.agent`:
  - read (`AGENT_CONTEXT`, `AGENT_MESSAGES`, `AGENT_TASKS`)
  - write (`AGENT_ENQUEUE_TASK`)
  - subscription (`AGENT_SUBSCRIBE`/`AGENT_UNSUBSCRIBE`)

## 10) Quick “where to edit” index

- Main chat send/stream/tool loop:
  - `client/ygg-chat-r/src/features/chats/chatActions.ts`
  - `client/ygg-chat-r/src/features/chats/chatSlice.ts`
- Tool registry/visibility:
  - `client/ygg-chat-r/src/features/chats/toolDefinitions.ts`
- Local tool implementation:
  - `client/ygg-chat-r/electron/tools/*`
- Local API behavior/storage:
  - `client/ygg-chat-r/electron/localServer.ts`
  - `client/ygg-chat-r/electron/localToolsRoutes.ts`
- Global background agent behavior:
  - `client/ygg-chat-r/src/services/GlobalAgentLoop.ts`
  - `client/ygg-chat-r/src/GlobalAgentBootstrap.tsx`
- Iframe custom app bridge/permissions:
  - `client/ygg-chat-r/src/utils/iframeBridge.ts`
  - `client/ygg-chat-r/src/components/HtmlIframeRegistry/HtmlIframeRegistry.tsx`
- Cloud API routing/provider integration:
  - `server/src/index.ts`
  - `server/src/routes/*`
  - `server/src/utils/*`

## 11) Related context docs

- `PERSISTENT_AGENT_CONTEXT.md`: persistent background agent architecture and phased design.
- `html_frame_context.md`: custom app HTML iframe architecture, caching, bridge, and permissions.

