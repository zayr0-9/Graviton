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
| 2 | Pause/resume protocol (interactive tool-permission + `plan_md` clarify) | ✅ done (+ clarify hang fix `9a2bf81`) | `15758d9`, `8052fe0`, `9a2bf81` |
| 3 | 5 lifecycle chat hooks in the server loop | ✅ done | `919b207` |
| 4 | Cloud provider through the gateway (free-tier relay + Railway id adoption + token owner) | ◐ near-complete — Slices 1/3/4 + Slice 2 (sole token refresher) all landed; only the openrouter free-tier relay remains not-live-tested | `1f68568`, `176fbb3`, `8d0cb06` |
| 5 | Storage-aware CRUD gateway + retire dualSync | ● complete (pending build:mac dogfood) — writes + reads + models + system-prompts + Stripe + attachments + OAuth + search all cut over; renderer no longer calls Railway directly except the Phase-6 streaming loop | `293ef8d`, `881c7e8`, `e2196bd`, `fb355ba`, `1d7aa51`, `4d2af8a`, `e9fd983`, `a3b6638`, `32fc17e` |
| 6 | Cutover + delete ~5,200 renderer loop lines; flags default-on | ☐ not started | — |

Feature flags in play today:
- `isServerOwnedChatLoopEnabled()` — renderer base flag (`localStorage['ygg.serverOwnedChatLoop']` / `VITE_SERVER_OWNED_CHAT_LOOP`). Routes LM Studio, Zai, **and ChatGPT** through the server loop.
- `isCloudServerLoopEnabled()` — renderer sub-flag (`localStorage['ygg.cloudServerLoop']` / `VITE_CLOUD_SERVER_LOOP`), nested under the base flag. Adds the **openrouter** route.
- `gateway.chat` — server flag (Conf key, or `YGG_GATEWAY_MODE` master env override). Enables the openrouter free-tier relay + CloudMirrorSink.
- `gateway.tokenOwner` — server flag, **now consumed** (Slice 2): gates the `app-auth:get-fresh-token` IPC handler so the server becomes the sole Supabase-token refresher. Pairs with the renderer `isServerTokenOwnerEnabled()` flag (`localStorage['ygg.serverTokenOwner']` / `VITE_SERVER_TOKEN_OWNER`) — flip BOTH together; with only the renderer flag on, the IPC reports `ownerEnabled:false` and the renderer safely keeps self-refreshing.

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

### Slice 2 — server as sole token refresher (`8d0cb06`, landed)
Delivered as a delegation model rather than a push: the renderer's two refresh
paths (`refreshTokenIfNeeded`, `ElectronAuthProvider.refreshToken`) call an
`app-auth:get-fresh-token` IPC that drives the shared single-flight
`AppAuthTokenManager` (now a process-wide singleton — one lock for the gateway +
the IPC), then adopt the rotated Conf `auth_session` the server persisted. Gated
on `gateway.tokenOwner` (server) + `isServerTokenOwnerEnabled()` (renderer),
coupled via an `ownerEnabled` handshake so a half-rollout falls back to
self-refresh instead of starving auth. Still **unverifiable without a live
Electron/Supabase build** — validate on `build:mac` by flipping both flags.

### Deferred / not done in Phase 4
- **RailwayClient / `/api/cloud/*` / `/api/gw/*`** — landed in Phase 5 (they were
  skeletons here); Slice 2 now also shares Phase 5's `AppAuthTokenManager` singleton.

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

### Stragglers landed after the read-layer cutover
- **Attachments (`e9fd983`):** storage-aware `/api/gw/*` attachment routes
  (GET/POST/DELETE `messages/:id/attachments`, GET `attachments/:id`, POST
  `attachments`) that route by the message's parent-conversation storage_mode (+
  `?storageMode=` override): local legs read/write SQLite via the shared
  statements, cloud legs go through Railway + mirror. `railwayClient` now forwards
  binary/Buffer bodies verbatim (keeping the caller Content-Type), so the upload
  route streams the raw multipart body straight to Railway with its boundary
  intact, then mirrors + links the result locally. `localApi.post` is now
  FormData-aware; all 5 attachment thunks moved off the direct-Railway `apiCall`.
  Note: `uploadAttachment`/link/delete/fetchById were dead (unreferenced) — this
  cuts their transport over so Phase 6 finds no Railway-coupled attachment code;
  `fetchAttachmentsByMessage` (the one live thunk) now also hydrates local
  attachments on the flat-load path, not just the tree path.
- **Google-drive OAuth (`a3b6638`):** status/start/disconnect → `cloudApi`
  (`/api/cloud/oauth/*`). The "redirect origin" worry was moot: Railway mints the
  `authUrl` (with its own redirect_uri) into the response body, so the request
  transport is all that moved; the consent flow is unchanged.
- **Search + models stragglers (`32fc17e`):** the non-electron server fallbacks in
  `useSearchTopLevelUserMessages`/`useSearchConversations` → gateway search (gwApi,
  keyed by userId); the missed normal-OpenRouter-models fetch in
  `useToggleSecretMode` → `cloudApi`. `api` (direct-Railway client) is now unused
  in `useQueries.ts`.

### Deferred (still hit Railway directly — explicitly Phase 6, not a repoint)
- **Legacy renderer streaming loop** (~5,200 lines) + its 24 `localMirror` message
  sites — includes `abortStreaming` (`POST /messages/:id/abort`), the last live
  renderer→Railway chat-path call — explicitly **Phase 6**.
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
  - **Fix `9a2bf81` — `plan_md` clarify hang (client-owned loop).** Symptom: clarify
    never completed — the panel showed, the user submitted, and the loop halted at the
    tool call; permission + every other tool worked. Root cause: the CLIENT-loop
    `requestPlanClarification` dispatched `planClarificationRequested` **with**
    `streamId`/`toolCallId`, so `respondToPlanClarification` read that as the server-loop
    signal and POSTed the answers to `/api/resume` — where the client loop has no
    `DecisionBroker` pending → 409 (swallowed) — and never resolved the client-loop
    `pendingPlanClarificationResolve` promise → permanent hang. Permission worked only
    because its client-loop requester (`requestToolPermissionDecision`) omits those
    fields. Fix: omit `streamId`/`toolCallId` from the client-loop clarify dispatch,
    making it symmetric with permission (client loop → promise; server loop → `/resume`
    via `sseProjection`, unchanged). The SERVER pause/resume was proven correct by a new
    DB-free test (`chatOrchestrator.clarify.test.ts`: `createChatPausingExecutor` emits
    `clarify_required`, registers the broker pending under the emitted id, never runs
    base, resumes on `broker.resolve`) — the defect was purely client-loop routing.
    Confirmed fixed by the maintainer. NOTE: `chatOrchestrator.phase2.test.ts` is
    misnamed — it never covered clarify pause/resume, which is why this slipped through.
- **Phase 3 (`919b207`):** the 5 lifecycle chat hooks (UserPromptSubmit, Pre/Post/
  Failure, Stop) in the server loop with exact ordering, lineage from
  `conversationRepo`, `additionalContext`/Stop-continue threading — gated on
  `hooksEnabled` + a wired `decisionBroker`.
