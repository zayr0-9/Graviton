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
| 5 | Storage-aware CRUD/reads gateway + retire dualSync | ☐ not started | — |
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
