# Full Headless Main-Agent-Loop Migration — Progress Log

Tracks the refactor that moves Graviton's main chat agent loop out of the React
renderer and into the server-owned headless engine (`electron/headlessServer/`),
turning the renderer into a thin client that talks only to `127.0.0.1:3002`.

- **Plan of record:** `~/.claude/plans/1-and-we-need-fancy-feather.md` (approved).
- **Branch:** `feat/headless-agent-loop` (local, not pushed).
- **Everything is behind flags that default OFF** — with all flags off the app is
  byte-for-byte the pre-refactor behavior, so each phase is safe to land and
  dual-run.

## Phase status

| Phase | Goal | Status | Commits |
|---|---|---|---|
| — | Retire Claude Code + GlobalAgentLoop | ✅ done | `b772062`, `5ddf07c` |
| 0 | Foundations + frozen SSE contract + DecisionBroker + abort wiring + cloud scaffolds | ✅ done | `6adc99e`, `9e4b86d` |
| 1 | Non-interactive thin-client slice (auto-approve local providers: LM Studio/Zai) — send/edit/branch | ✅ done | `41b9e05`, `6743a7a`, `c310dc2` |
| 2 | Pause/resume protocol (interactive tool-permission + `plan_md` clarify) | ✅ done | `15758d9`, `8052fe0` |
| 3 | 5 lifecycle chat hooks in the server loop | ✅ done | `919b207` |
| 4 | Cloud provider through the gateway (free-tier relay + Railway id adoption) | ◐ partial — see below | `1f68568`, `176fbb3` |
| 5 | Storage-aware CRUD gateway + retire dualSync | ◐ near-complete — writes + reads + models + system-prompts + Stripe cut over; only attachments/OAuth/search-fallbacks remain | `293ef8d`, `881c7e8`, `e2196bd`, `fb355ba`, `1d7aa51`, `4d2af8a` |
| 6 | Cutover + delete ~5,200 renderer loop lines; flags default-on | ☐ not started | — |

Feature flags in play today:
- `isServerOwnedChatLoopEnabled()` — renderer base flag (`localStorage['ygg.serverOwnedChatLoop']` / `VITE_SERVER_OWNED_CHAT_LOOP`). Routes LM Studio, Zai, **and ChatGPT** through the server loop.
- `isCloudServerLoopEnabled()` — renderer sub-flag (`localStorage['ygg.cloudServerLoop']` / `VITE_CLOUD_SERVER_LOOP`), nested under the base flag. Adds the **openrouter** route.
- `gateway.chat` — server flag (Conf key, or `YGG_GATEWAY_MODE` master env override). Enables the openrouter free-tier relay + CloudMirrorSink.
- `gateway.tokenOwner` — server flag, **resolved but not yet consumed** (reserved for the deferred token-owner slice).

---

## Phase 4 — Cloud provider through the gateway (partial)

**Goal (from the plan):** route cloud chat generation through the server-owned
loop — relay OpenRouter free-tier metering, adopt Railway-authoritative message
ids, repoint the renderer's cloud sends to `:3002`, and (deferred) make the server
the sole Supabase-token refresher.

**Delivered (`1f68568`, `176fbb3`), all gated OFF by default:**

### Slice 1 — OpenRouter free-tier SSE relay
`OpenRouterProvider` now emits the two frozen SSE events instead of dropping
Railway's meter frames / collapsing the 403:
- `free_generations_update { remaining, isFreeTier? }` — relayed from Railway's
  `free_generations_update` stream frame.
- `generation_limit_reached { message? }` — emitted on a `403 { error:
  'generation_limit_reached' }` before the provider re-throws (so the run still
  terminates, but the modal has already been flushed to SSE).

Both are gated by a threaded `railwayTurn.relayFreeTierEvents`, set true only when
`ChatOrchestrator` computes `isCloudRoute = cloudChatEnabled &&
normalizeProviderRoute(provider) === 'openrouter'`. The loop already forwards
provider events to SSE verbatim, and the renderer projection (`sseProjection.ts`,
wired in Phase 0) already maps both events → `freeGenerationsUpdated` /
`freeTierLimitModalShown`. New `electron/headlessServer/config/gatewayFlags.ts`
resolves the server flags (Conf-backed, `YGG_GATEWAY_MODE` master override,
try/catch so a corrupt store can't break startup).

### Slice 3 — Railway message-id adoption
- `MessageRepo.createMessage` gained an optional `id` (upsert `ON CONFLICT(id)`);
  absent → mint a uuid (unchanged default).
- New `CloudMirrorSink` (`messageSink.ts`) adopts the Railway-authoritative id
  (`AssistantMessageDraft.providerMessageId`, sourced from `output.raw.id` at both
  `ToolLoopService` persist sites). `TreeMessageSink` ignores the field.
- Selected in `ChatOrchestrator` only on `isCloudRoute`; every other run keeps
  `TreeMessageSink` + self-minted uuids.

### Slice 4 — renderer repoint (openrouter) + ChatGPT routing
- The 3 chat thunks (send/edit/branch) widen their server-loop gate to
  `isLmStudio || isZai || isOpenAIChatGPT || (isCloudServerLoopEnabled() &&
  providerSlug === 'openrouter')`. `openrouter` is nested under the new
  `isCloudServerLoopEnabled()` sub-flag; **ChatGPT sits under the base flag** (it's
  an OAuth provider like LM Studio/Zai, not Graviton's metered free-tier).
- `buildServerLoopRequest` forwards `temperature` + `serviceTier` (serviceTier
  openrouter-only) and ChatGPT `accessToken`/`accountId` — all only-when-set, so
  every other provider's request body is unchanged.
- ChatGPT auth is resolved fresh in each thunk via `getValidTokens()`
  (auto-refreshing) and forwarded, so the server uses it directly rather than
  depending on its token-store row. The server engine already fully supports
  `openaichatgpt` (it's what subagents run in production); the route parser already
  reads `accessToken`/`accountId` from body or the `Authorization` /
  `ChatGPT-Account-Id` headers.

### Live validation ✅
First live confirmation of the stacked thin-client path (Phases 1–4 together): with
the base flag on, **ChatGPT chat through the server-owned loop works well**
(confirmed by the maintainer). Prior to this, no phase had been dual-run live — this
discharges the standing "never live-tested" caveat for the ChatGPT route.

**To dogfood:** authenticate ChatGPT, set `localStorage['ygg.serverOwnedChatLoop']
= 'true'`, reload, and send with the ChatGPT provider selected. Confirm via a
request to `127.0.0.1:3002/conversations/<id>/messages`. Remove the key + reload to
revert to the legacy client loop.

### Automated validation
`tsc -b` clean · esbuild main OK · `test:headless` **180 passed** / 37 skipped
(sqlite-gated in this env) / 24 todo · renderer chats-feature suite **42 passed**.
New DB-free tests: `openRouterProvider.freeTier`, `gatewayFlags`,
`messageRepo.idAdoption`, `cloudMirrorSink`, plus `buildServerLoopRequest` /
`sseProjection` extensions.

### Adversarial review
4-lens review + per-finding verification → **13 findings, 0 confirmed** (all refuted
as flag-gated footguns, pre-existing/out-of-scope behavior, or coverage gaps).
Strengthened `gatewayFlags` coverage (Conf-enable branch + catch-safety guard).

### Deferred / not done in Phase 4
- **Slice 2 — server as sole token refresher** (`AppAuthTokenManager` single-flight
  + server→renderer IPC token push + renderer refresh disable). Touches Electron-main
  + renderer auth, is unverifiable without a live Electron/Supabase build, and is a
  hardening step rather than a functional prerequisite (the server already resolves
  provider tokens today). Awaiting explicit sign-off; both `gateway.tokenOwner` and a
  matching renderer flag must roll out together or the two-refresher race worsens.
- **RailwayClient / `/api/cloud/*` / `/api/gw/*`** stay skeletons — they belong to
  Phase 5 (cloud chat gen flows through `OpenRouterProvider`'s own fetch, not
  RailwayClient).

### Known caveats & follow-ups
- **Flag coupling (openrouter only):** for correct cloud-through-gateway on the
  openrouter route, both `gateway.chat` (server) and `isCloudServerLoopEnabled()`
  (renderer) must be on together — otherwise the server runs openrouter with
  `TreeMessageSink` (local ids, no free-tier relay). Documented; only checkable live.
- **Not live-tested:** the openrouter free-tier relay end-to-end, the 403→modal
  mapping, and Railway id adoption across a multi-turn cloud loop (no live
  Railway/OpenRouter here). ChatGPT is the only cloud-ish route confirmed live.
- **Pre-existing (not introduced here):** the server Codex path doesn't honor
  `reasoningConfig` (defaults medium/auto) and doesn't send
  `serviceTier`/`promptCacheRetention` in the Codex body — the subagent path already
  behaves this way. Small follow-up if reasoning-effort parity matters.

---

## Phase 5 — Storage-aware CRUD gateway + retire dualSync (partial)

**Decision on record:** the maintainer chose a **blind full cutover** (no flag
fallback; git is the safety net) after being told the cloud/Railway path is not
live-testable from this environment. So — unlike Phases 1–4 — the Phase 5 gateway
is mounted **unconditionally** (`index.ts`) and the renderer talks to it directly:
with these commits the write path is no longer flag-gated OFF.

### Server foundation (`293ef8d`) — all DB-free tested
The five Phase-0 skeletons are now real:
- **`appAuthTokenManager`** — single-flight Supabase refresher (sole process-wide
  refresher; concurrent callers coalesce; optional `forceRefresh` for 401).
- **`railwayClient`** — Bearer-injected Railway pass-through: `passthrough()`
  (verbatim status/body, never throws), `request<T>()` (throws `RailwayHttpError`),
  SSE `stream()`, and 401→forced-refresh→retry-once.
- **`cloudMirrorService`** — in-process SQLite dual-write reusing the shared
  `/api/sync/*` upsert statements + `ensure*Exists` FK stubs (owner_id→user_id).
- **`gatewayRoutes` (`/api/gw/*`)** — storage-aware conversations/projects/messages:
  local leg delegates to `/api/app/*` over loopback (byte-identical local CRUD),
  cloud leg via `railwayClient`; reads merge (updated_at desc, **id-dedup**,
  dual-cursor drains local-first; cloud leg skipped when no session = community);
  writes route by storage_mode + mirror; canonical→leg **write normalizers** own the
  local(snake)/cloud(camel) divergence; conversation sub-field GET/PATCH routes.
- **`cloudProxyRoutes` (`/api/cloud/*`)** — allowlisted authenticated pass-through
  (models/users/system-prompts/stripe/app-store/oauth).
- New flags `gateway.crud`/`gateway.cloudProxy` (resolved; routes mount uncond.).

### Renderer cutover (`881c7e8`)
- `api.ts`: `gwApi` (`/api/gw/*`) + `cloudApi` (`/api/cloud/*`) thin clients (both
  hit :3002; server owns cloud auth, callers pass no token).
- `conversationActions` / `projectActions`: every CRUD/read thunk → one gateway
  call; dropped `shouldUseLocalApi` branching + all `dualSync` calls.
- `chatActions`: message CRUD (update/delete/tree/bulk/deleteMany/messages),
  `initialize*` / `refreshCurrentPathAfterDelete` / `syncConversationToLocal`, and
  the `/system-prompts` + `/users` helpers → `gwApi`/`cloudApi`.
- **`dualSyncManager` (502-line class) DELETED** → `src/lib/localMirror.ts` (thin
  fire-and-forget `/api/sync/*` writer, same surface) keeps the legacy streaming
  loop's local mirror alive until Phase 6 removes that loop. Dead `lib/sync/*` gone.

### Validation
`tsc -p tsconfig.app.json` clean · `test:headless` **226 passed** / 37 skipped /
24 todo · renderer chats suite **42 passed**. New DB-free tests: gateway merge +
dedup + write-normalizers, `railwayClient`, `cloudMirrorService`,
`appAuthTokenManager`, `cloudProxyRoutes` allowlist, extended `gatewayFlags`.

### Follow-ups landed after the initial cutover
- **Rename fix (`e2196bd`):** the rewrite dropped the `storageMode` param, so cloud
  conversations (notably inside cloud projects) could be misrouted to the local leg
  and never reach Railway. Added an authoritative `?storageMode=` hint
  (`resolveWriteMode`) across conversation/project write routes + threaded it through
  the write thunks, and made `mirrorConversation/mirrorProject` reuse the existing
  row's `user_id` so cloud updates refresh the local mirror instead of skipping.
- **System prompts (`fb355ba`):** the 8 system-prompt helpers now go through
  `cloudApi` (/api/cloud/system-prompts) instead of Railway directly.
- **Read-layer (`1d7aa51`):** the `useQueries` list hooks (projects + conversations
  flat/paginated/by-project/recent) now call the gateway (server-side merge + dedup)
  instead of merging client-side; `useConversationData` (messages/tree/system-prompt/
  context) → gwApi; models/ZDR/recent-models/research-notes/cached-system-prompts →
  cloudApi. GET /projects/:id and /conversations/:id honor the `?storageMode=` hint.
  (One consumer, sideBar, needed an explicit tuple annotation — a union-of-arrays map
  inference quirk the repoint perturbed; runtime unchanged.)
- **Stripe (`4d2af8a`):** the 5 Stripe helpers → `cloudApi` (community guard kept).

### Deferred (still hit Railway directly — each needs NEW work, not a plain repoint)
- **Attachments** (`uploadAttachment`/link/fetch/delete/fetchById) — need a
  multipart-aware gateway route (railwayClient FormData passthrough) + storage
  routing; still use the cloud `apiCall`.
- **Settings google-drive OAuth** (status/start/disconnect) — the start/disconnect
  redirect needs the real Railway origin, so a blind :3002 repoint risks breaking the
  consent flow.
- **2 cloud search fallbacks** (`useSearchTopLevelUserMessages`) — need userId + the
  `/api/gw/conversations/search` endpoint shape; low-traffic fallbacks.
- **Legacy renderer streaming loop** (~5,200 lines) + its 24 `localMirror` message
  sites — explicitly **Phase 6**.
- `lib/payments/stripe.ts` is dead (no importers); leave for a cleanup pass.

### Not live-verified
No live Railway/Supabase here, so the whole cloud leg (gateway cloud reads/writes,
mirror, `railwayClient` Bearer/401, cloud-proxy) is unit-tested but **needs a
`build:mac` dogfood** before it can be trusted. Community/local-only paths are the
most exercised by the DB-free tests.

---

## Prior phases (context)

- **Retirement:** Claude Code (`b772062`) and GlobalAgentLoop (`5ddf07c`) deleted
  entirely (dead thunks / background agent), children-first DB drops.
- **Phase 0 (`6adc99e`, `9e4b86d`):** froze the unified SSE contract (5 new event
  types), abort wiring on the chat route, `DecisionBroker` + cloud-plumbing skeletons
  (`appAuthTokenManager`, `railwayClient`, `cloudMirrorService`, `cloudProxyRoutes`,
  `gatewayRoutes`), renderer `serverLoopSettings`/`mainChatClient`/`sseProjection`.
- **Phase 1 (`41b9e05`, `6743a7a`, `c310dc2`):** routed auto-approve LM Studio/Zai
  send/edit/branch through the server engine; full SSE→Redux projection; path/anchors
  driven from `*_persisted` server ids.
- **Phase 2 (`15758d9`, `8052fe0`):** `DecisionBroker` + `POST /resume`; per-run
  pausing executor (PreToolUse→permission pause); `plan_md` clarify + `multi_call`
  via the bridge; rebound the 4 renderer resolvers.
- **Phase 3 (`919b207`):** the 5 lifecycle chat hooks (UserPromptSubmit, Pre/Post/
  Failure, Stop) in the server loop with exact ordering, lineage from
  `conversationRepo`, `additionalContext`/Stop-continue threading — gated on
  `hooksEnabled` + a wired `decisionBroker`.
