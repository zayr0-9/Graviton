# Summary of General Project Context

> **Historical — cloud parts removed.** Graviton is now fully local (2026-11): there is no Supabase/Railway
> account or sync, cloud storage mode, hosted OpenRouter provider, Stripe billing or web product. Sections that
> describe those are kept for history only. Current behaviour: `ygg-chat/docs/agent_context/AGENT.md`.

`ygg-chat` is a full-stack AI chat product with web (React + Express + Supabase) and Electron runtimes, featuring agentic tooling and a persistent global background agent. It is organized as an npm workspace with three main parts:
- `client/ygg-chat-r`: Frontend (React) and Electron code
- `server`: Cloud/server API (Express)
- `shared`: Shared types and provider metadata

## Runtime Modes
- **Web mode**: Frontend connects to cloud API (`http://localhost:3001/api`), storage source of truth is Supabase/Postgres.
- **Electron mode**: Embedded local server runs on port 3002 (SQLite-backed), frontend can call both cloud API (port 3001) and local API (port 3002). Dual-sync mirrors cloud records to local SQLite when applicable.
- **Local storage mode**: Entities with `storage_mode: 'local'` stay local-only in SQLite; persistent background agent runs in this mode.

## Key Architectural Components
- **Frontend** (`client/ygg-chat-r/src`):
  - Entry: `main.tsx`, `App.tsx`, `GlobalAgentBootstrap.tsx`
  - State: Redux store with feature slices (chats, conversations, projects, etc.)
  - Chat/streaming: Orchestrated via `chatActions.ts`, state managed in `chatSlice.ts`
  - API/sync: `utils/api.ts` (cloud/local clients), `dualSyncManager.ts` (cloud-to-local sync)
  - HTML tool UI: `HtmlIframeRegistry.tsx`, `iframeBridge.ts` for iframe apps with permission-gated agent access

- **Electron** (`client/ygg-chat-r/electron`):
  - Main process: `main.ts` (creates windows, starts/stops local server)
  - Embedded local server (port 3002): `localServer.ts` (SQLite API, sync endpoints, local tool execution, persistent agent endpoints)
  - Local tooling: `tools/` (built-in tools like `read_file`, `edit_file`, `bash`, `ripgrep`), custom tool runtime, MCP bridge, orchestrator
  - Skills/MCP: `skills/` and `mcp/` directories

- **Cloud/Server** (`server/src`):
  - Entry: `index.ts` (middleware, health endpoints, websocket, route mounting)
  - Routes: `chat.ts` (non-web), `supaChat.ts`, `supaStore.ts`, `supaAgents.ts` (cloud/Supabase), OAuth, billing, user, settings, search
  - Data: `database/` (schema, models, migrations), `utils/` (provider adapters), `workers/` (openrouter-reconciliation)

## Data Model & Storage
- Core entities: Project, Conversation, Message (tree-structured via `parent_id` and `children_ids`)
- Storage mode: `storage_mode: 'cloud' | 'local'` determines persistence (Supabase vs SQLite)
- Shared types: `shared/types.ts`

## Persistent Global Agent
- Runs in Electron/local mode using a dedicated local `system` project/conversation
- Implemented via:
  - Service: `src/services/GlobalAgentLoop.ts` (start/pause/stop/tick, queue polling)
  - Bootstrap: `src/GlobalAgentBootstrap.tsx`
  - Endpoints: `localServer.ts` (`/api/agent/*`)

## HTML Frame/Custom App Context
- Custom tools can return HTML rendered in iframes (inline or registry modal)
- Registry persists iframe entries in SQLite `html_tools` table
- IPC bridge: `utils/iframeBridge.ts` (postMessage)
- Agent access from iframes is permission-gated via `appPermissions.agent` (read/write/subscribe)

## Quick Reference: Where to Edit
- Chat send/stream/tool loop: `src/features/chats/chatActions.ts`, `chatSlice.ts`
- Tool registry: `src/features/chats/toolDefinitions.ts`
- Local tool implementation: `electron/tools/*`
- Local API/storage: `electron/localServer.ts`, `electron/localToolsRoutes.ts`
- Global agent: `src/services/GlobalAgentLoop.ts`, `src/GlobalAgentBootstrap.tsx`
- Iframe bridge/permissions: `src/utils/iframeBridge.ts`, `src/components/HtmlIframeRegistry/HtmlIframeRegistry.tsx`
- Cloud API/routes: `server/src/index.ts`, `server/src/routes/*`, `server/src/utils/*`

## Related Context Docs
- `PERSISTENT_AGENT_CONTEXT.md`: Persistent background agent design
- `html_frame_context.md`: HTML custom-app iframe architecture, caching, bridge, permissions