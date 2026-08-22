# headlessServer

Incremental extraction target for Electron local server backend logic.

## Status
- Phase 0:
  - Duplicate legacy `/api/app/*` blocks removed from `localServer.ts`.
  - Added route-level parity tests for conversation/message tree invariants (`routes/__tests__/appAutomationRoutes.test.ts`).
- Phase 1:
  - App automation CRUD routes extracted to `routes/appAutomationRoutes.ts`.
  - Added `routes/crudRoutes.ts` composition wrapper for future third-party CRUD APIs.
- Phase 2 (in progress):
  - Added SSE chat endpoints in `routes/chatRoutes.ts`.
  - Added `services/chatOrchestrator.ts` with DB persistence + provider dispatch.
  - Added continuation semantics for `send`, `repeat`, `branch`, and `edit-branch` in server orchestrator.
  - Extracted continuation resolution into `services/branchOrchestrator.ts` for parity hardening and easier testing.
  - Added persistence repos (`persistence/*`) and event schema scaffolding.
- Phase 3 (MVP-first):
  - OpenAI ChatGPT provider implemented for server-side generation (`providers/openaiChatgptProvider.ts`) using the same private ChatGPT backend contract as frontend (`openaiOAuth.ts` + `OpenAIChatGPT.ts`):
    - `https://chatgpt.com/backend-api/codex/responses`
    - OAuth token refresh via `https://auth.openai.com/oauth/token`
    - `chatgpt_account_id` handling from JWT/account header
  - Token bootstrap routes added (`/api/provider-auth/openai/token`).
  - OpenRouter and LM Studio providers are explicitly TODO and currently return "not implemented" errors.
- Phase 4 (in progress):
  - Added `services/toolLoopService.ts` to centralize assistant tool-call turn handling (pending -> execute -> tool_result -> continue).
  - `ChatOrchestrator` now delegates generation to `ToolLoopService` for `send/repeat/branch/edit-branch` flows.
  - Headless route request schema extended with tool execution context (`tools`, `rootPath`, `operationMode`, `streamId`, `toolTimeoutMs`).
  - Added server-side tool execution bridge in `headlessServer/index.ts` via `toolOrchestrator` (`/api/jobs` backend worker path).
  - Added server-side default inference tool catalog fallback (built-in + enabled custom + model-visible MCP tools) when clients omit `tools` in request payload.
  - Extended SSE event schema with lifecycle telemetry (`tool_loop`, `tool_execution`) for richer third-party UI orchestration.
  - Added regression tests covering multi-turn tool continuation + default tools fallback (`services/__tests__/chatOrchestrator.phase2.test.ts`).

## MVP testing focus
Use provider `openaichatgpt` with either:
- `Authorization: Bearer <OPENAI_TOKEN>` + `chatgpt-account-id` on chat calls, or
- POST token to `/api/provider-auth/openai/token` and send `userId` in chat payload.

### Ultra-basic browser harness (ephemeral)
Open: `http://localhost:<local-server-port>/headless/openai-test`

What it does:
- Starts OAuth via `/api/openai/auth/start`
- Polls `/api/openai/auth/complete`
- Stores tokens in server token store via `/api/provider-auth/openai/token`
- Sends chat to `/api/headless/ephemeral/chat` (no DB conversation persistence)
- Keeps UI state in memory only (no browser localStorage)
- Uses default model: `gpt-5.4`

## Mobile LAN interface (React)
- Entry URL: `http://<local-server-host>:<port>/mobile`
- Source lives under: `electron/headlessServer/ui/mobile/src`
- Built bundle output: `electron/headlessServer/ui/mobile/assets/mobile-app.js`
- Build command: `npm run build:electron:main` (now bundles mobile UI along with main/preload)

The mobile client is intentionally simpler than desktop chat, but preserves structured rendering for reasoning/tool blocks inspired by:
- `src/containers/Chat.tsx`
- `src/components/ChatMessage/ChatMessage.tsx`

### Mobile UI design system refresh (shadcn-style)
- Added local shadcn-style primitive components under `electron/headlessServer/ui/mobile/src/components/ui/*`
  - `Button`, `Input`, `Textarea`, `Select`, `Badge`, `Card`
- Added `components.json`, `tailwind.config.ts`, and `postcss.config.js` scaffolding in `electron/headlessServer/ui/mobile/`
- Migrated key mobile surfaces to primitives while preserving behavior:
  - Header auth/model controls
  - Profile picker
  - Composer and branch controls
  - Tool panel toggles
  - Project/conversation modal actions
  - Message action buttons
  - Tree drawer controls
- Theme token overhaul in `assets/mobile.css`:
  - Full light/dark semantic token palette
  - Removed hardcoded dark-only element backgrounds/borders from interactive controls and message list surfaces
  - Tree canvas and graph colors now tokenized for light/dark parity
