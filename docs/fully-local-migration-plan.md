# Graviton fully-local migration plan (v1)

**Date:** 2026-11-09 · **Status:** not started · open questions answered 2026-11-10 (see [Decision log](#decision-log-open-questions)) · **Scope:** 858 locations in 347 files. The per-location checklist, grouped by phase, follows the Progress log.

| Phase | Locations |
|---|---|
| P0-build-env | 44 |
| P1-updater-packaging-ci | 25 |
| P2-server-cloud-layer | 121 |
| P3-auth-removal | 109 |
| P4-renderer-runtime-mode | 117 |
| P5-storage-mode-data-api | 113 |
| P6-web-marketing-payments | 92 |
| P7-app-store-keep | 32 |
| P8-deps-tests-docs-cleanup | 205 |

All 9 scout areas were verified. 37 items were confirmed, 39 corrected and about 235 added. No scout area failed.

> **Precondition.** Work currently sits on `feat/shared-ui-multiclient` with uncommitted changes. Several of those files are also in this plan: `chatOrchestrator.ts`, `claudeSessionService.ts`, `mcpManager.ts`, `chatSlice.ts`, `chatTypes.ts`, `chatActions.ts`, `Chat.tsx`, `Settings.tsx` and their tests. Commit or merge that work first. Then start this migration from the result on its own branch, e.g. `chore/fully-local`.
>
> Line numbers in the checklist are a snapshot of that working tree and will drift. Re-locate each item by its **symbol**, not its line number.
>
> Keep this plan **outside** `ygg-chat/docs/`. That folder is symlinked into `ygg-chat/.claude/rules/docs`, so Claude Code auto-loads everything in it as agent rules. Suggested location: `docs/fully-local-migration-plan.md` at the repo root.

---

## Goal and definition of done

Graviton becomes a local desktop app. It builds and runs without a Graviton account, without a `.env`, and without the hosted web product.

**Done means all of these pass:**

1. **Clean-clone build.** A fresh clone has no `.env` anywhere and no `VITE_*`, `SUPABASE_*` or `YGG_API_URL` in the shell. In it, `npm ci`, the root `npm run build:electron` and `electron-builder --dir --publish never` all succeed (see Acceptance checks).
2. **No account.** On first launch with an empty userData dir, the app opens at `#/homepage`. There is no login screen. The identity is the fixed local user `a7c485cb-99e7-4cf2-82a9-6e23b55cdfc3`, and the `users` row is seeded at server start. From there you can:
   - create a project and a conversation;
   - stream a reply from each kept provider that has its credential set;
   - branch, delete, undo, compact, run subagents and Heimdall;
   - open the logging dashboard;
   - install an app-store app.
3. **No cloud network calls.** Apart from the allowed endpoints below, there are no requests to:
   - Supabase (`*.supabase.co`, `auth.yggchat.com/auth|rest|storage` except the app-store catalog until the Q10 TODO moves it to GitHub);
   - Railway (`webdrasil-production.up.railway.app` except `/app-store/community*` from `server/routes/appStoreRoutes.ts`);
   - Stripe (`*.stripe.com`, `js.stripe.com`);
   - Vercel (`vitals.vercel-insights.com`, `/_vercel/*`).

   Allowed endpoints:
   - the user-configured provider hosts: `auth.openai.com`, `chatgpt.com`, `openrouter.ai`, Z.AI, AWS Bedrock, LM Studio and the Claude Code CLI;
   - user-configured MCP servers;
   - GitHub Releases for the updater: `api.github.com`, `github.com`, `objects.githubusercontent.com`;
   - the app store endpoints above.
4. **Grep guard is clean.** The guard in Acceptance checks returns zero hits in tracked source outside the explicit allowlist.
5. **Tests and builds are green.** All four vitest suites (run under Electron's Node ABI), `tsc -b`, the three typechecks, the `build:*` targets, `node --test scripts/build.test.mjs` and the `scripts/test-*.cjs` smokes all pass.
6. **Updater.** The packaged app contains `resources/app-update.yml` with `provider: github`, and `checkForUpdates` queries GitHub Releases. `electron/main.ts` no longer calls `setFeedURL`.

**Kept surfaces. Do not break these:**
- Providers:
  - `openaichatgpt`, the Codex/ChatGPT OAuth slot: `server/auth/*` codex path, `managedOAuthRoutes`, `codexUsage`, `openai:chatgpt:*` IPC and the powerMonitor resume check;
  - `zai`, `bedrock`, `lmstudio`;
  - `openrouterbyok` (`hyperRouterOpenRouterProvider.ts`, which talks to openrouter.ai directly);
  - the Claude Code session backend.
- MCP (including MCP App iframes), custom tools and HTML tools, skills, hooks, subagents, Heimdall, lineage, stream undo, compaction, resumable runs, the local logging dashboard and the client error log.
- The shared-UI hosts `BUILD_TARGET=browser-client` and `BUILD_TARGET=standalone`, which give LAN access to the local host, and the mobile LAN UI (`server/headlessServer/ui/mobile`).
- `electron-updater`, with the feed moved to GitHub Releases.
- The community app store (`/api/app-store/*`): browse and install work anonymously.

---

## Binding decisions

**User decisions (binding):**

1. **Auto-update stays, on GitHub Releases.**
   - `electron-builder.json` `publish` becomes `{provider:"github", owner, repo, releaseType:"release"}`.
   - `electron/main.ts` drops `UPDATE_FEED_BASE_URL` and `setFeedURL({provider:'generic'})`, so electron-updater reads the embedded `app-update.yml`.
   - CI packages with `--publish never` and keeps `softprops/action-gh-release` as the only uploader.
   - Releases live in **`zayr0-9/Graviton`** (Q1).
   - **No bridge release** (Q2). The Supabase update upload and changelog upload steps are deleted in P1 directly. Existing installs keep polling the Supabase feed and must reinstall manually once.
   - **No code signing** (Q3). macOS shows "update available, download from GitHub" instead of auto-installing. Windows is added to CI (Q4).
2. **The community app store stays** as an optional online feature.
   - Browse and install must work anonymously. Everything in the store that depends on Supabase auth, the app session or env vars is decoupled in P7.
   - Upload needs a Supabase JWT. **The upload UI is hidden for now** and the upload route is disabled; migrating upload to a new mechanism is a follow-up TODO (Q11).
   - The first-party catalog stays on the public Supabase bucket for now; moving it to GitHub is a follow-up TODO (Q10).
3. **Old cloud data is irrelevant.** There is no data migration and no compatibility layer for cloud rows, `storage_mode='cloud'` rows or old `openrouter` conversations.
   - DB columns stay in place, unused. No schema migration is planned.
   - If a column is ever dropped, it needs a versioned idempotent entry in `SCHEMA_MIGRATIONS` (`server/localServer.ts`) plus a `MIGRATIONS.md` row.
   - Exception: local rows owned by a former Supabase user ID are re-parented once at startup into `LOCAL_USER_ID` (Q5a), so previously signed-in users keep seeing their local chats.
4. **Definition of "fully local"** (Q16): no connection to Graviton's own Supabase or Railway (or Stripe/Vercel). Third-party services are fine: Google Fonts and the QR-code service stay.

**Design decisions derived from the findings (binding for implementers; they override conflicting checklist rows):**

| # | Decision |
|---|---|
| D1 | **Mode detection.** `src/platform/clientCapabilities.ts` derives everything from `__BUILD_TARGET__` (`isNativeShell`, `isBrowserClient`, new `isStandaloneClient`, `isHostClient`), with `typeof` guards for bundles that lack the define. **In P0, as a bridge**, `vite.config.ts` defines `import.meta.env.VITE_ENVIRONMENT` from `BUILD_TARGET` for *every* target, and `src/utils/api.ts` `environment` is derived from the capabilities. Together these make all ~40 direct reads and the ~12 `environment` importers correct without `.env` at once. P4 then rewrites each read (default `isNativeShell`, which keeps today's Electron-only behaviour) and deletes the shim and the `environment` export last. |
| D2 | **Build targets.** `web` is removed. `npm run dev` becomes `BUILD_TARGET=electron vite` and `build` becomes `build:electron`. The `predev`/`scripts/check-env.js` hook and `.env.example` are deleted. `local` is kept only as the vitest and smoke default until Q13 is decided. The tracked `vite.config.js` and `vite.config.d.ts` are deleted; they shadow `vite.config.ts` in Vite's resolution. `tsconfig.node.json` stops emitting next to the source. |
| D3 | **`/api/gw/*` stays as a local-only facade.** The URL namespace is kept, so ~60 `gwApi` calls and `lineageRoutes.ts` (separately mounted under `/api/gw`) keep working. `gatewayRoutes.ts` loses the Railway, mirror and auth deps and every cloud leg and merge helper. `?storageMode=` hints are ignored. `/paginated` passes through to `/api/app` offset paging (Q28). `POST /api/gw/attachments` is deleted. `/api/cloud/*` (`cloudProxyRoutes.ts`) is deleted only after the last renderer `cloudApi`/`apiCall` caller is gone, at the end of P5. |
| D4 | **Fixed local identity.** New shared constant `ygg-chat/shared/localUser.ts` with `LOCAL_USER_ID = 'a7c485cb-99e7-4cf2-82a9-6e23b55cdfc3'`. It is used by `server/auth/runtime.ts`, `headlessServer/index.ts`, `src/config/runtimeMode.ts`, `electron/main.ts` and the `scripts/test-browser-*.cjs` fixtures. The server runs `INSERT OR IGNORE` for the users row at startup, because FKs are on. `publicAuthState()` and `/api/host/auth/status` always return `{id: LOCAL_USER_ID}`, with no `local_login_enabled` gate. The Redux `users.currentUser` slice stays, seeded with a constant local profile, so routing and quick-chat gates keep working. Previously signed-in users' local rows are re-parented per Q5 (plan default: one-time startup re-parent). |
| D5 | **Auth slots.** Only the `codex` slot survives. `shared/auth.ts` `AuthSlot` narrows to `'codex'` last, after every `resolve('app')`/`snapshot('app')` consumer is gone. `auth:migrate` IPC stays, codex-only, for the legacy `openai_chatgpt_tokens` import. `initializeAuth` calls `owner.start()` unconditionally. `appLogin.ts`, `appAuthTokenManager.ts`, Supabase `refreshAdapters` config, the `yggchat://` protocol and the `auth:start/code/cancel/login/logout/openOAuthWindow` IPC are deleted. |
| D6 | **Rename `auth:openExternal` to `shell:openExternal`** (`electronAPI.shell.openExternal`) in one commit across `main.ts`, `preload.ts`, `vite-env.d.ts`, `transport.ts` and every caller (MarkdownLink, TitleBar, Chat, Settings ×4 including Codex OAuth, HtmlIframeRegistry, McpAppIframe, `MarkdownLink.test`). This happens in P3, after P6 deletes LandingPage, PaymentPage and downloadApp. `authHandle` keeps its name, so `Settings.credentials.test.ts` stays valid. |
| D7 | **The cloud `openrouter` provider is removed.** That covers `openRouterProvider.ts`, the `'openrouter'` member of `ProviderRoute`, the `providers.json` entry, the `/api/provider-auth/openrouter/token` and remote-models code, and mobile/QuickInput/Chat references. `normalizeProviderRoute` aliases the legacy string `'openrouter'` to `'openrouterbyok'`; this is the only alias. Other unknown names are rejected with a 400 (Q7). The fresh-install default provider is **OpenAI (ChatGPT)** (Q6); all kept providers stay selectable. Custom-tool `REQUEST_GENERATION` uses the user's current provider and model (Q8). The mobile LAN UI uses OpenRouter BYOK instead of cloud OpenRouter (Q9). Slash-style models with no provider infer `openrouterbyok` (ephemeral routes, `iframeBridge`). |
| D8 | **Provider type hub.** Before `openRouterProvider.ts` is deleted, its shared types and the runtime `attachPartialOutput` move to `server/headlessServer/providers/providerTypes.ts`, and all ~20 importers are re-pointed in the same commit. Do **not** touch the unrelated `OpenRouterProvider` class from `@hyper-labs/hyper-router` in `hyperRouterOpenRouterProvider.ts`; it is the BYOK transport. |
| D9 | **`railwayTurn` becomes `turnContext`** (type `ProviderTurnContext`) and **`railwaySessionId` becomes `providerSessionId`**. The rename is atomic across `toolLoopService`, `subagentRunService`, `openaiChatgptProvider`, `codex/codexRequestItems.ts`, `codex/codexResponsesProvider.ts`, `ephemeralGenerateRoutes`, `electron/main.ts:~2528` and all tests. v1 is a rename only, with no field pruning (Q26). `storageMode` and `relayFreeTierEvents` are dropped from the input. The checklist also suggests `turnSessionId` and `providerSessionKey`; use `providerSessionId`. |
| D10 | **SSE and error contracts.** Remove `free_generations_update`, `generation_limit_reached` and `reauth_required` from `shared/headlessApi.ts`, together with `sseProjection.ts`, `mainChatClient.ts`, `chatTypes.ts`, `chatSlice` `freeTier` and `toolLoopService` `relayFreeTierEvents`. In `shared/chatErrors.ts`, remove the `sign_in` and `upgrade` action kinds. Keep `session_expired`, `free_tier_exhausted` and `subscription_inactive` as legacy union members with action `open_settings`; they cost nothing and existing rows still render. `providerErrorFormatter` maps 401 and reauth to `provider_signin_required`, and 402 to `subscription_inactive` with `open_settings` (Q29). Renderer 401/403 from the local host maps to `server_rejected_request`. |
| D11 | **`/` renders `<Navigate to="/homepage" replace/>` for every target.** `/login`, ProtectedRoute's redirect, the landing, marketing, legal, blog and payment routes, and `@vercel/analytics` are removed. HashRouter is used everywhere. |
| D12 | **Updater repo.** `owner: "zayr0-9", repo: "Graviton"` (the `upstream` remote, the personal account). **Confirmed (Q1).** The repo must be public and must be the one `v*` tags are pushed to. |
| D13 | **Smaller decisions.** `config/gatewayFlags.ts` is deleted and `resumableRuns` is inlined as `true`. `/api/sync/*` is deleted, except `/api/local/attachments/*` (in the same file) and `/api/sync/stats` (`analyticsRoutes.ts`). `localMirror.ts` is deleted. Recent models, Secret Mode/ZDR and Google Drive OAuth are deleted. Research notes get a local source. Sidebar "Copy conversation" gets a **new local clone route** (Q12). `server/envLoader.ts` is deleted (Q14, confirmed). `BUILD_TARGET=local` is dropped (Q13). `proxyGateway.ts` is deleted entirely (Q22). `/paginated` uses real offset paging (Q25). The `VITE_LMSTUDIO_BASE` default becomes `http://localhost:1234`. The `VITE_RESUMABLE_RUNS` override is deleted. |
| D14 | **Storage mode.** Renderer `storageMode` plumbing and the request fields go. `storage_mode` columns stay; read-side projections may stay. Every surviving insert must write `'local'` explicitly, because the column default is `'cloud'` and list statements filter `storage_mode='local'`. TS types keep optional `storage_mode?` on `Project`/`ConversationRecord` only. |
| D15 | **App store.** Browse goes through `localApi '/app-store/community'` for all host clients (the local server proxies anonymously to the hardcoded Railway `REMOTE_API_BASE`, which P2 must not touch). The first-party catalog drops supabase-js and fetches from a constant `APP_STORE_PUBLIC_BASE` by plain URL (Q10 decides its host). Install, uninstall and restart are gated on `isNativeShell`. Upload is **hidden, not deleted** (Q11): hide the upload UI, and make `POST /api/app-store/community/upload` return 501 without touching the `app` slot, before P3 removes that slot. `uploadCommunityApp` and `assertCloudAppStoreWriteEnabled` lose their auth dependency. Upload is migrated later (follow-up TODO). |
| D16 | **Test fixtures.** `server/tools/__tests__/dummyfile.ts.test` and `dummyFilechatAction.ts.test` are verbatim `editFile.test.ts` fixtures. **Never edit them.** They stay byte-identical and are excluded from the grep guard. This overrides the checklist row that marks one of them `delete-file`. |

**Other checklist conflicts, resolved:**
- `Homepage.tsx` is unrouted: delete the file rather than editing it, and update `chatSelectionBoundary.test.ts` in the same change.
- QuickInput: delete the component entirely, with its `LowBar` mounts and `quick_chat_project_id` (Q23). This supersedes the Secret Mode and provider-rewiring rows for QuickInput.
- App store browse is gated on `isHostClient`; install is gated on `isNativeShell`.

---

## Target architecture after migration (short)

- **Renderer** (`src/`): one shared UI built for `electron`, `browser-client` and `standalone`. It routes on `HashRouter` with `/` going to `/homepage`.
  - Mode flags come only from `clientCapabilities` (`__BUILD_TARGET__`). There are no `import.meta.env.VITE_*` reads.
  - Data flows through `localApi` and `gwApi` to the local host.
  - Auth is a codex-status facade plus the constant local user.
  - The only network-facing extras are the app store (via the host) and the updater (via main).
- **Electron main**:
  - starts the local server;
  - runs the IPC for codex status/check/subscribe/migrate, `shell:openExternal`, secrets and the updater;
  - uses electron-updater with the embedded GitHub feed;
  - keeps the single-instance lock;
  - has no `yggchat://` protocol, no Supabase defines and no envLoader.
- **Local server** (`server/`, `server/headlessServer/`):
  - SQLite and `/api/app`, with `/api/gw` as a local facade alongside `lineageRoutes`;
  - the chat orchestrator using `TreeMessageSink` only;
  - `ProviderRouter` over openaichatgpt, zai, bedrock, openrouterbyok, lmstudio and claude, with shared types in `providerTypes.ts`;
  - codex-only `AuthSessionManager`;
  - a host runtime that always projects the local user;
  - `appStoreRoutes` as the sole Railway caller, anonymous only;
  - no `railwayClient`, `cloudProxyRoutes`, `cloudMirrorService`, `appAuthTokenManager`, `gatewayFlags`, `/api/sync/*` or Supabase vault in `proxyGateway`.
- **CI**: builds Linux and macOS with `--publish never` and injects release notes into `latest-*.yml`. One GitHub Release carries the dmg, zip, deb, blockmaps and `latest*.yml`. There are no Supabase secrets.

---

## Phase order and dependencies

The phase labels in the checklist group work by **area**. Some items must ship in the same PR as items from another phase; these are listed in "Must ship together" below.

**Execution order:** P0 → P1 → P2 → P7 → P6 → P3 → P5 → P4 → P8.

**Common commands.** Run from `ygg-chat/client/ygg-chat-r`. Electron is hoisted to `ygg-chat/node_modules/.bin/electron`, and vitest lives in the client's `node_modules`. Do **not** rebuild native dependencies. SQLite suites skip or fail under system node.

```bash
cd /path/to/Graviton/ygg-chat/client/ygg-chat-r
VT="../../node_modules/.bin/electron ./node_modules/vitest/vitest.mjs run --config"
ELECTRON_RUN_AS_NODE=1 $VT vitest.server.config.ts
ELECTRON_RUN_AS_NODE=1 $VT vitest.headless.config.ts
ELECTRON_RUN_AS_NODE=1 $VT vitest.renderer.config.ts
ELECTRON_RUN_AS_NODE=1 $VT vitest.tools.config.ts
npm run typecheck:electron && npm run typecheck:server && npm run typecheck:mobile
npx tsc -b                                   # renderer; noUnusedLocals/Parameters are on
npm run build:electron:parallel && npm run build:server && npm run build:browser-client
node --test scripts/build.test.mjs
# smokes (need built dist-*/electron output; each self-relaunches under Electron)
for s in test-browser-client test-browser-workspace test-chat-selection-electron \
         test-agents-grid-electron test-browser-app-bridge test-native-host-bootstrap; do
  node scripts/$s.cjs || break; done
```

"Full gate" below means all of the above.

### P0-build-env — no `.env` required to build or run
- **Goal:**
  - Electron dev and build work without `.env`.
  - The web target scripts, `predev`/`check-env.js`, `.env.example`, the esbuild `VITE_SUPABASE_*` injection (after its reader is gone, see P3), `envLoader` (D13) and the tracked `vite.config.js`/`.d.ts` are gone.
  - The D1 bridge shim and capabilities rewrite are in.
  - The `VITE_LMSTUDIO_BASE` and `VITE_RESUMABLE_RUNS` overrides are gone.
- **Why first:** every later phase deletes code that is today reached only through `.env` values. Without D1, removing anything risks silently flipping Electron into `'local'`/`'cloud'` mode: project creation defaults to `'cloud'`, `sync:status` port discovery is skipped, and Heimdall, hooks and stream undo turn off.
- **Must ship together:**
  - `package.json` `dev` becomes `BUILD_TARGET=electron` together with the clientCapabilities/shim change.
  - Delete `vite.config.js`/`.d.ts` before or with any `vite.config.ts` edit.
  - Delete `check-env.js` together with `.env.example`.
- **Entry:** branch created from committed work. Full gate is green on the baseline; record pre-existing failures in the Progress log.
- **Exit:**
  - `npm run dev` + `npm run electron` and a packaged `--dir` build work with `.env` renamed away.
  - Settings provider sections, Heimdall, MCP app load, hooks and stream undo all render.
  - Full gate is green.
  - CI env step lines 73-81 are **not** touched yet.

### P1-updater-packaging-ci — feed moves to GitHub Releases
- **Goal:**
  - `electron-builder.json` publishes to github (D12).
  - `main.ts` drops `UPDATE_FEED_BASE_URL` and `setFeedURL`.
  - CI uses `--publish never`, narrows the upload-artifact and release globs to `*.dmg *.zip *.deb *.blockmap latest*.yml`, and keeps the "Inject release notes" step.
  - `BUILDING.md` and `scripts/build.test.mjs` are updated.
- **Why here:** it is independent of the cloud code.
- **No bridge release (Q2).** Delete the "Upload update artifacts to Supabase" and changelog upload steps in this phase. Existing installs keep polling `auth.yggchat.com` and never see the GitHub feed; their users reinstall once from GitHub Releases.
- **Windows (Q4):** add a `windows-latest` matrix entry building NSIS, so the release also carries the `.exe`, its blockmap and `latest.yml`. Extend the release/upload-artifact globs to `*.exe`.
- **macOS, unsigned (Q3):** no Developer ID or notarization. Squirrel.Mac rejects unsigned updates, so on macOS the updater only checks and then shows "update available, download from GitHub" with a link to the release page (no `downloadUpdate`/`quitAndInstall`). Linux and Windows keep auto-install.
- **Secrets:** once the env step is gone (P8), delete the repo secrets `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_STRIPE_PUBLISHABLE_KEY`, `SUPABASE_UPDATE_FEED_BASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET`.
- The user sets `package.json` `version`. Do not bump it.
- **Entry:** P0 exit. Q1–Q4 answered.
- **Exit:**
  - `electron-builder --dir --publish never` output contains `app-update.yml` with `provider: github`.
  - A dry-run tag in a fork produces a GitHub Release with `latest.yml`, `latest-mac.yml`, `latest-linux.yml`, exe, zip, dmg, deb and blockmaps.
  - `node --test scripts/build.test.mjs` passes.

### P2-server-cloud-layer — remove Railway, cloud gateway and cloud OpenRouter on the server
Land it as sub-steps, each its own PR with the full gate:

- **P2a — pure refactor (no behaviour change).**
  - Create `providerTypes.ts` and re-point every importer (D8).
  - Rename `railwayTurn`/`railwaySessionId` atomically (D9), including the `electron/main.ts` IPC stream and all tests.
- **P2b — cloud openrouter out.** Delete:
  - `openRouterProvider.ts` and `RailwayAppAuthError`;
  - the `'openrouter'` route and the D7 alias;
  - the `providerAuthRoutes` openrouter slug, remote models and app snapshot;
  - the ephemeral remote path;
  - the `capabilityRoutes` entry and the `subagentRoutes` guard;
  - the `chatOrchestrator` reauth override and queued-attachment allowlist entry;
  - `toolLoopService` `relayFreeTierEvents`, `providerMessageId` and the app slot in `authSessions`;
  - the `index.ts` OAuth-guard `'openrouter'` arm.

  Ships with:
  - the renderer `providers.json`, `chatSlice` and `providerSettingsStorage` allowed lists;
  - D10 SSE/error contract changes (`sseProjection`, `chatTypes`, `chatSlice` `freeTier`, `chatErrors`, `localChatErrors`, `mainChatClient`, `GlobalNotifications`/`Chat.tsx` action cases);
  - mobile UI (`ui/mobile/src/{api.ts,App.tsx,types.ts,MobileHeader.tsx}`): identity via `/api/host/auth/status`, BYOK instead of `openrouter`;
  - QuickInput provider rewiring;
  - useQueries `useModels` cloud fallback, `useRecentModels`, `useZdrModels`/`useToggleSecretMode`, `useRefreshModels`, and ModelSelectControl `userIsFreeTier`;
  - `iframeBridge` local-only generation (Q8 default).
- **P2c — gateway collapse.**
  - `gatewayRoutes.ts` becomes local-only (D3).
  - Delete `cloudMirrorService`, `CloudMirrorSink` (keep `TreeMessageSink`), `shared/runStatisticsMetadata.ts`, `railwayClient`, `appAuthTokenManager`, `gatewayFlags` (inline `resumableRuns`), `chatOrchestrator` `isCloudRoute`/`cloudChatEnabled`, and the `proxyGateway` Supabase vault.
  - Keep `lineageRoutes` mounted.
  - Re-route the renderer `uploadAttachment` thunk first (delete it; it has no dispatchers).
  - **`cloudProxyRoutes.ts` stays mounted** until the end of P5.
- **Why here:** the renderer cleanups depend on a server that no longer needs the app slot or Railway, and P3 cannot narrow `AuthSlot` until these consumers are gone.
- **Entry:** P0 done.
- **Exit:**
  - Full gate is green.
  - Chat streams on every kept provider, including Codex images, reasoning effort and fast tier, and subagent Codex runs with `subagent:<runId>` session keys.
  - The mobile LAN UI sends a message.
  - The guard has no hits in `server/headlessServer/**` for `railway|cloudMirror|appAuthTokenManager|free_generations|gatewayFlags`.

### P7-app-store-keep — decouple the store before auth goes
- **Goal:** D15.
  - `services/appStore.ts`: no supabase import; plain-URL catalog; `localApi` community browse; `isNativeShell`/`isHostClient` gates.
  - `containers/appStore.tsx`: no upload panel, no `/login?required=cloud`, no `isCommunityMode`.
  - Hide the upload panel (Q11). The upload route in `appStoreRoutes.ts` returns 501 and drops the `getAuthManager` import. Keep `validate-upload`. Leave a `TODO(app-store-upload)` marker at each hidden/disabled site.
  - Delete `publicApiCall`/`PUBLIC_API_ENDPOINT_PREFIXES` in `utils/api.ts`.
- **Why before P3:** P3 deletes `src/lib/supabase.ts`, the `/login` route and the server `app` slot. All three are imported by the store today.
- **Entry:** P2 done (P2 must not have touched `REMOTE_API_BASE`).
- **Exit:**
  - In a no-`.env` Electron build, first-party and community lists load anonymously, and install, uninstall and restart work.
  - The browser-client host can browse.
  - Full gate is green.

### P6-web-marketing-payments — delete the web product
- **Goal:** delete:
  - Landing, FAQ, Blog, Terms, Privacy, Refund, PaymentPlans, PaymentPage, downloadApp, `components/landing/*`, `public/blogs/*`, `public/landingtest.html`;
  - `lib/payments/*`, `pricingData.ts`, `useSubscriptionStatus`, FreeGenerationsModal;
  - Stripe API helpers in `utils/api.ts`;
  - `@vercel/analytics` usage, `vercel.json`, the `stripe` manualChunk.

  Also:
  - Collapse the `isWeb`/`isWebMode`/`VITE_ENVIRONMENT==='web'` branches (rightBar, sideBar, SettingsPane, ToolsSettings, useToolJobs, ToolJobManager, useIdeContext, TextArea/InputTextArea, useQueries).
  - Remove the Subscribe/credits footers and the sidebar and Homepage Profile item (Q29), and the credits budget math in Chat.
  - Delete all legal/website content with no replacement links (Q28).
  - Change `/` per D11, without removing `/login` yet.
  - Drop `__IS_WEB__` from `vite.config.ts`, `vitest.renderer.config.ts` and the `scripts/test-*.cjs` defines.
- **Why before P3:** it removes 3 of the `auth.openExternal` callers and the `upgrade` action targets, so D6 has less churn.
- **Entry:** P7 done.
- **Exit:**
  - No route reaches a payment, marketing or legal page.
  - `chatSelectionBoundary.test.ts` is updated.
  - Full gate is green, and the browser-client smoke expects `#/homepage` (or still `#/login` until P3 lands).

### P3-auth-removal — no account, codex-only credentials
- **Goal:** D4, D5, D6.
  - **Server:** `publicAuthState` always returns the local user; the users row is seeded at startup; delete `appLogin.ts`, `enableLocalLogin`, `/api/host/auth/local|logout`, the `refreshAdapters` Supabase branch and the app branch in `authSessionManager`. `authMigration` and `credentialStore` become codex-only, and `AuthSlot` narrows to codex. Run the one-time re-parent (Q5). Fix the `/api/local/users/merge` safety rule and the `note_search_docs` update.
  - **Electron:** remove the protocol and deep links (keep the single-instance lock and focus), all app-login IPC and `cancelAppLogin` sites (687, 689, 1233, 1343), and `esbuild.main.mjs` `authDefines`. Do the `shell:openExternal` rename.
  - **Renderer:** delete `lib/supabase.ts`, `lib/auth/allowlist.ts` and `lib/auth/local.ts`. Trim ManagedLogin and `managed.ts`/`transport.ts`/`types.ts`/`publicState.ts`. Rewrite AuthContext and `useAuth` to `{user,userId,loading}`, dropping `accessToken`, `signOut` and `signIn` from all consumers. Rewrite ProtectedRoute (retry instead of redirect). Delete usersActions login/credits, usersTypes credit fields and `thunkExtra` `accessToken`. Remove `/login` from `titleBarHistory`.
- **Must ship in one PR:**
  - server `publicAuthState` fixed user;
  - the renderer collapse of `isCloudSession`/`syncRuntimeAuthMode` (P4 rows in `runtimeMode.ts`);
  - removal of the login route and IPC.
- **Entry:** P2, P7 and P6 done, and Q5 answered.
- **Exit:**
  - A fresh profile and an old profile (with Conf `managed_auth_v1.app` and `local_login_enabled`) both open straight to `/homepage` with their data visible.
  - ChatGPT sign-in and refresh still work: `managedAuthRecovery.test` and `authSessionManager.test` (now on the codex slot) pass.
  - Links open in the OS browser.
  - Full gate and both browser smokes are green.

### P5-storage-mode-data-api — local-only data layer
- **Goal:**
  - Remove `storageMode` from thunks, hooks, Chat, Heimdall, sideBar, ConversationPage, EditProject, QuickInput, HomepageRedirect, `conversationMessagesApi`, the snapshot coordinator, `buildServerLoopRequest`, `shared/headlessApi.ts` and `chatRoutes.ts`.
  - Delete `getStorageModeFromCache`, `syncConversationToLocal`, `localMirror.ts` and `/api/sync/*` (keep `/api/local/attachments/*`).
  - Collapse system prompts to the local host prompt store.
  - Move research notes to a local source.
  - Make `useMoveConversationToProject` always use `localApi`.
  - Implement a local conversation clone route on the host and point the sidebar Copy action at it (Q12). It copies the conversation row and its full message tree with new IDs, inside one transaction.
  - Drop `remoteOrigin` from `attachmentUrl`.
  - Remove the cloud LoggingDashboard source and Billing panel, and rename "Credits" to "cost" (Q27).
  - Delete `apiCall`/`api`/`createStreamingRequest`/`cloudApi`/`assertCloudBackendAllowed`/`shouldUseLocalApi`/`API_BASE`/`FORCE_LOGOUT_EVENT`, then **delete `cloudProxyRoutes.ts` and its test**.
- **Why here:** it needs P3's constant `userId` (React Query is gated on `!!userId`) and a local-only `/api/gw` from P2c.
- **Entry:** P3 done.
- **Exit:**
  - The grep for `cloudApi|apiCall\(|/api/cloud|storageModeQs|getStorageModeFromCache` is empty in `src/`.
  - New projects and chats are stored with `storage_mode='local'`; verify with `sqlite3` on the app DB.
  - Full gate is green.

### P4-renderer-runtime-mode — finish the mode collapse
- **Goal:**
  - Replace every remaining `import.meta.env.VITE_ENVIRONMENT` read and `environment` import with capabilities (default `isNativeShell`; Q13).
  - Collapse all `isCommunityMode`/`isElectronCommunityMode`/`isCloudSessionEnabled` consumers to the local branch, including the Settings sections, Google Drive and Local Ownership defaults (Q5).
  - Reduce `runtimeMode.ts` to `isElectronMode` and `LOCAL_AUTH_USER_ID` (re-exported from shared).
  - Remove the D1 shim from `vite.config.ts`, the `environment` export, and `VITE_*` from `vite-env.d.ts` `ImportMetaEnv`, so stragglers fail `tsc`.
  - Remove `VITE_ENVIRONMENT=... VITE_API_URL=/api` from the browser-client and standalone scripts.
- **Why late:** `runtimeMode` exports have ~20 importers, which P2, P3, P5, P6 and P7 have mostly removed by now. Deleting the exports earlier breaks the build.
- **Entry:** P5 done.
- **Exit:**
  - `git grep -n 'import.meta.env.VITE_' -- 'ygg-chat/client/ygg-chat-r/src'` returns only the optional `VITE_YGG_SERVER_ORIGIN` dev override (Q15).
  - Electron, browser-client and standalone builds all work without env.
  - Full gate is green.

### P8-deps-tests-docs-cleanup
- **Goal:**
  - Remove `@supabase/supabase-js`, `@stripe/stripe-js`, `@vercel/analytics`, `dexie` and `gsap`, and delete `reproduce_issue.sh` (Q32). Regenerate **both** `ygg-chat/package-lock.json` and `ygg-chat/client/ygg-chat-r/package-lock.json` with `npm install` in `ygg-chat/`. Keep `@vercel/oidc`, which is pulled in by `ai`.
  - Delete the CI "Configure environment variables" step (lines 73-81), now safe because every consumer is gone.
  - Remove the Supabase MCP entries (`.mcp.json`, `ygg-chat/.mcp.json`, `.claude/settings.local.json`).
  - Delete `start_yggdrasil.bat` and `update_start_yggdrasil.bat`.
  - Fix the remaining test mocks.
  - Docs:
    - rewrite `AGENT.md`, `agent_runtime_modes.md`, `agent_headless_server.md` and `agent_auth.md` first (they are auto-loaded agent rules);
    - fix frontmatter `paths` that point at deleted files;
    - add a "historical — cloud parts removed" banner to the historical docs and `general_project_context.md` rather than deleting them (Q20), and add `agent_app_store.md`;
    - update `readme.md` and the client `README.md`;
    - add a `CHANGELOG.md` entry using the `## [x.y.z]` header that CI parses.
  - Branding (Q17): keep the YggChat name and `homepage https://yggchat.com`; switch the support email, deb maintainer and CLA contacts to GitHub/project contacts.
  - **Last step, separately confirmed:** scrub the Supabase anon key and Stripe `pk_live` key from git history (Q21). See the decision log for what this involves.
- **Entry:** P4 done.
- **Exit:** every Acceptance check passes.

---

## Cross-cutting risks

1. **Silent mode flips without `.env`.** `utils/api.ts:11` `environment` defaults to `'local'`. As a result:
   - `isElectronRuntimeWithSyncIpc` (181) skips port discovery;
   - `projectActions.ts:44` and `conversationActions.ts:99-110` create `'cloud'` rows;
   - Heimdall, `streamUndoApi`, `ChatMessage` MCP load, `clientTelemetry`, `providerSettingsStorage:135` and the app store all turn off.

   Mitigation: the D1 shim in P0. Do not remove CI line 78 or the shim before P4.
2. **Optional-field renames compile silently.** `railwayTurn`/`turnContext` and `railwaySessionId` are optional, and most test fixtures use `as any`. A partial rename drops Codex images, reasoning effort, `serviceTier`, the prompt-cache key and the subagent session isolation without any error. Mitigation: grep for `railway` must be zero after P2a; assert these fields in `openaiChatgptProvider.test.ts`, `subagentRunService.test.ts:253` and `imageHistory.test.ts`.
3. **`openRouterProvider.ts` is a runtime import hub.** `attachPartialOutput` is used by `codexSse`, `codexWebsocket`, `codexResponsesProvider` and `openaiChatgptProvider`. Deleting the file before D8 breaks the kept ChatGPT provider. A symbol-based delete of `OpenRouterProvider` would break BYOK (`hyperRouterOpenRouterProvider.ts:2`).
4. **Identity and data visibility.** `electron/main.ts:1025-1042` `syncAuthenticatedProfile` re-parented local rows to the Supabase UUID. With D4, those rows disappear unless Q5 is handled. The existing merge route (`userProjectRoutes.ts:152-164`) always refuses, and it cascade-deletes `note_search_docs`.
5. **Auth bootstrap shape.** `managed.ts:18` reads `value.app.version`, and `hostRuntimeRoutes.ts:43` reads `.app.userId`. Dropping `app` from `publicAuthState` without both changes throws, and the app shows no user. If `auth:migrate` is removed, `getAuthManager().start()` never runs, and Codex refresh becomes lazy-only.
6. **Users row and FK.** `foreign_keys=ON` (`localServer.ts:599`). The users row is created today only by `/api/host/auth/local`. Without the startup seed, project inserts fail on fresh profiles.
7. **`toolLoopService.ts:1266`** calls `snapshot('app')` on every run. Narrowing `AuthSlot` first makes every chat throw. Remove the call in P2b.
8. **External links.** `auth:openExternal` is the app-wide "open in OS browser" bridge, used by about 9 kept callers including Codex OAuth at `Settings.tsx:~2426`. If a caller is missed, `window.open` falls back to opening a new Electron `BrowserWindow`.
9. **Updater stranding.** Installed clients hard-code the Supabase generic feed through `setFeedURL` (`main.ts:2355`). If the Supabase upload step is removed before a GitHub-feed build reaches that bucket, users must reinstall. There are also two smaller gaps:
   - macOS builds are unsigned, so Squirrel.Mac rejects the update (Q3);
   - there is no Windows job, so there is no `latest.yml` (Q4).

   Adding a github publish config without `--publish never` makes tag builds fail on the read-only token.
10. **Gateway semantic drift.** Today, missing rows resolve to `cloud`. After the collapse they resolve to local and return 404. `/paginated` changes from capping at 50 to real offsets, so check infinite-scroll dedupe. `messages/tree` must stay in-process (it is hot at every stream end). `lineageRoutes.ts` must stay under `/api/gw` (`index.ts:31,347`).
11. **Storage default.** The column `DEFAULT 'cloud'` plus local-only list filters means any new insert that omits `storage_mode` creates invisible rows. This applies to `syncStorageRoutes` until P5 and to any new route. Changing the default needs a migration, which this plan does not do.
12. **Provider defaults.** Removing `OpenRouter` from `providers.json` changes the fresh-install default (`Chat.tsx:4980-5010` uses `allowedProviders[0]`). QuickInput hard-codes `'OpenRouter'`. `useModels` is gated on `!!userId` (P3 must provide it). Stale `'openrouter'` strings in localStorage, subagent and compaction defaults, or mobile now route through the D7 alias.
13. **Strict TS.** `tsconfig.app.json` has `noUnusedLocals` and `noUnusedParameters`, and `tsc -b` runs before vite build. Every deletion must also remove the imports and params it leaves unused.
14. **Shadow config.** The tracked `vite.config.js` is resolved before `vite.config.ts`, so dev edits to the `.ts` file are ignored until it is deleted.
15. **Uncommitted overlap.** `chatOrchestrator.ts` and `chatOrchestrator.phase2.test.ts` (which asserts `railwayTurn.conversationContext`) are in-flight on `feat/shared-ui-multiclient`. Land that work first.
16. **The Electron vitest path differs from the task text.** The electron binary is at `ygg-chat/node_modules/.bin/electron`, not `client/ygg-chat-r/node_modules/.bin/electron`.

---

## Acceptance checks

**1. Clean clone, no `.env`, build and package**

```bash
TMP=$(mktemp -d) && git clone --branch chore/fully-local /Users/karansingh/Projects/Graviton "$TMP/Graviton"
cd "$TMP/Graviton" && test -z "$(git ls-files '*.env' '.env*')" && ! ls ygg-chat/client/ygg-chat-r/.env* 2>/dev/null
cd ygg-chat
env -i HOME="$HOME" PATH="$PATH" npm ci --include=optional
env -i HOME="$HOME" PATH="$PATH" NODE_OPTIONS=--max-old-space-size=6144 npm run build:electron
cd client/ygg-chat-r
env -i HOME="$HOME" PATH="$PATH" npx electron-builder --dir --publish never
find release -name app-update.yml -exec grep -H 'provider: github' {} \;      # must print
grep -rIlE 'supabase|webdrasil|stripe|vercel-insights|auth\.yggchat\.com/auth' \
  dist-electron dist-browser electron/main.mjs electron/preload.mjs || echo "bundle clean"
# allowed bundle hits: app-store catalog base / Railway community base only (see allowlist)
```

**2. Run with no account.**
1. Launch the packaged app with a fresh profile:
   ```bash
   ELECTRON_USER_DATA_DIR=$(mktemp -d)
   ```
   (or the `--user-data-dir` equivalent), then `release/*/Graviton* --log-net-log=/tmp/graviton-net.json`.
2. Confirm it lands on `#/homepage`, and that you can create a chat and stream with LM Studio or another configured provider.
3. Then run:
   ```bash
   grep -oE '"(https?://[^/"]+)' /tmp/graviton-net.json | sort -u
   ```
   Only allowed hosts may appear. The netlog covers Chromium traffic only. For main-process and server traffic, use `lsof -i -nP | grep -i graviton` or a firewall log during the same session.

**3. Test and build gate.** Run all the commands in "Common commands". All must pass under `ELECTRON_RUN_AS_NODE=1`.

**4. Grep guard.** Run from the repo root after every phase. The allowlist is explicit:

```bash
cd /Users/karansingh/Projects/Graviton
git grep -n -I -i -E \
 'supabase|railway|webdrasil|auth\.yggchat\.com|stripe|@vercel/analytics|vercel\.json|VITE_(SUPABASE|API_URL|ENVIRONMENT|STRIPE|LMSTUDIO_BASE|RESUMABLE_RUNS)|BUILD_TARGET=web|__IS_WEB__|cloudApi|cloudProxy|cloudMirror|isCommunityMode|isCloudSession|free_generations|generation_limit_reached|freeTier|appAuthTokenManager|appLogin|setFeedURL|yggchat://|localMirror|storageModeQs|PaymentPage|LandingPage' \
 -- . \
 ':(exclude)paper_figures' ':(exclude)ygg-chat/docs/design-previews' \
 ':(exclude)ygg-chat/client/ygg-chat-r/server/tools/__tests__/dummyfile.ts.test' \
 ':(exclude)ygg-chat/client/ygg-chat-r/server/tools/__tests__/dummyFilechatAction.ts.test' \
 ':(exclude)ygg-chat/client/ygg-chat-r/CHANGELOG.md' \
 ':(exclude)ygg-chat/client/ygg-chat-r/server/MIGRATIONS.md' \
 ':(exclude)ygg-chat/docs/shared-ui-implementation-status.md' \
 ':(exclude)docs/fully-local-migration-plan.md'
# Expected: only these allowlisted lines remain (verify by eye, then they are the baseline):
#   server/routes/appStoreRoutes.ts   REMOTE_API_BASE (Railway, anonymous community listing)
#   src/services/appStore.ts          APP_STORE_PUBLIC_BASE (only if Q10 keeps the Supabase public bucket)
```

Second guard, for the bare cloud provider string. It must return only the D7 alias and its test:

```bash
git grep -n -E "[\"']openrouter[\"']" -- 'ygg-chat/client/ygg-chat-r/src' 'ygg-chat/client/ygg-chat-r/server' 'ygg-chat/client/ygg-chat-r/electron' 'ygg-chat/shared' \
 ':(exclude)ygg-chat/client/ygg-chat-r/server/tools/__tests__/*.test'
# allowed: services/providerRouter.ts (normalizeProviderRoute alias), services/__tests__/providerRouter.test.ts
```

Baseline at plan time: the first guard hits 163 files.

---

## Decision log (open questions)

Answers recorded 2026-11-10. **Status** is one of:
- `decided`;
- `TODO`: a follow-up after this migration (also listed under "Follow-up TODOs");
- `needs answer`: none remain as of 2026-11-10.

Where an answer contradicts a checklist row, the answer wins. Tick the row and add `(resolved by Q#)`.

| # | Question | Answer | Status |
|---|---|---|---|
| 1 | Release repo | `zayr0-9/Graviton` (D12) | decided |
| 2 | Bridge release to the Supabase bucket | No. Existing installs reinstall once from GitHub Releases | decided |
| 3 | macOS signing / notarization | No signing. macOS shows "update available, download from GitHub" instead of auto-installing | decided |
| 4 | More platforms in CI | Add `windows-latest` (NSIS, `latest.yml`). macOS stays **Apple Silicon (arm64) only** for now; Intel Macs are unsupported | decided |
| 5 | Local data owned by a former Supabase UUID | (a) One-time startup re-parent into `LOCAL_USER_ID` with plain UPDATEs, including `note_search_docs`, then clear the Conf `app` slot. The profile list stays, read-only | decided |
| 6 | Fresh-install default provider | OpenAI (ChatGPT). All kept providers stay selectable | decided |
| 7 | Unknown provider names | **Reject** with `400 unknown provider "x"`. Every known alias and the D7 `openrouter` → `openrouterbyok` alias are still accepted. Consolidating the many spellings is a follow-up | decided + TODO |
| 8 | Custom-tool `REQUEST_GENERATION` default model | The user's current provider and model (fallback `openaichatgpt`) | decided |
| 9 | Mobile LAN UI provider | Replace cloud OpenRouter with OpenRouter BYOK | decided |
| 10 | First-party app-store catalog host | Keep the public Supabase bucket for now; move to GitHub later | TODO |
| 11 | App store upload | Hide the UI and disable the route (501); keep `validate-upload`; migrate later. Browse also works in browser-client; install stays native-only | decided + TODO |
| 12 | Sidebar "Copy conversation" | Implement a local clone route. Research notes get a local endpoint; Recent models and Secret Mode are dropped | decided |
| 13 | `BUILD_TARGET=local` | Drop it. Vitest and the smokes default to `electron`; Electron-only gates use `isNativeShell` | decided |
| 14 | `server/envLoader.ts` | Delete; it isn't needed (see note) | decided |
| 15 | `VITE_YGG_SERVER_ORIGIN` | **Keep as an optional dev-only override.** Nothing requires it; it stays in `vite-env.d.ts` and is the only allowed `import.meta.env.VITE_*` read | decided |
| 16 | Offline assets | Keep Google Fonts and the QR service. "Fully local" means no connection to our Supabase/Railway | decided |
| 17 | Branding | Keep the YggChat name and the yggchat.com homepage. Switch the support email, deb maintainer and CLA contacts to GitHub/project contacts | decided (interpretation, confirm) |
| 18 | Purge stale Conf keys / unregister `yggchat://` | No. Nothing is purged beyond the Q5 `app`-slot clear, and the protocol is not unregistered | decided (see note) |
| 19 | Legacy Codex token import (`auth:migrate`) | **Keep it (codex-only) for this release; delete it in the next one** | decided + TODO |
| 20 | Historical docs | Keep, with a "historical, cloud parts removed" banner (including `general_project_context.md`). Add `agent_app_store.md` | decided |
| 21 | Scrub the public keys from git history | Yes, as the very last step, after a separate go-ahead (see note) | decided, gated |
| 22 | `proxyGateway.ts` | Delete entirely | decided |
| 23 | Account surface | Quick chat and Homepage are defunct: **delete `Homepage.tsx`, `QuickInput` and `quick_chat_project_id`**. Keep the Redux `users` slice filled with one constant local profile (`App.tsx` and `ChatSelectionProvider` still need `currentUser`). No account or logout UI. Keep the `/homepage` route; it renders `HomepageRedirect`, the D11 landing | decided |
| 24 | Prune Railway-only turn-context fields | Rename only now; prune in a follow-up | TODO |
| 25 | `/paginated` | Real offset paging | decided |
| 26 | HTTP 402 from a user's own provider | Show "Your <provider> account needs billing or credits" with an "Open Settings" button. Users no longer pay through Graviton, so there is no upgrade/subscribe action | decided |
| 27 | Logging dashboard | Remove the Cloud source and Billing panel; rename "Credits" to "cost" | decided |
| 28 | Legal / website links | None wanted; delete everything | decided |
| 29 | Profile item (sidebar, Homepage) | Remove | decided |
| 30 | Recent-projects cap | Keep | decided |
| 31 | `storage_mode` in TS types | Keep as an optional legacy field now; remove later | TODO |
| 32 | `dexie`, `gsap`, `reproduce_issue.sh` | Remove (P8) | decided |
| 33 | Supabase MCP dev-tool entries | Delete (P8) | decided |

### Notes on answered items

- **Q5 and Q18 together.** Q5(a) clears the Conf `app` slot after the re-parent. That slot holds the old Supabase refresh token, and clearing it also marks the re-parent as done. Q18 "no" is read as: nothing else is purged (`auth_session` and `local_login_enabled` stay), and `yggchat://` is not unregistered. Once the handler is removed, the app ignores the old registration.
- **Q14.** `envLoader.ts` only copies a `.env` file from the working directory or its parents into `process.env`. A packaged app never has one, and every setting it feeds (`YGG_TOOLS_RUNTIME`, `DISABLE_TOOL_RUNTIME_FALLBACK`, `YGG_LOCAL_SERVER_*`, …) can still be set as a normal environment variable. Users see no change. In dev, your current `.env` sets `YGG_TOOLS_RUNTIME=utility` and `DISABLE_TOOL_RUNTIME_FALLBACK=true`. Export those in your shell to keep dev on the same tool runtime.
- **Q17** is an interpretation of "keep yggchat but switch rest". Confirm or correct it.
- **Q21, what scrubbing involves.**
  - Rewrite every commit that contains `.env.example` (`git filter-repo`), then force-push all branches and tags to `zayr0-9/Graviton` and the `ksingh-max` fork.
  - Every existing clone, fork and open PR goes stale and has to be re-cloned or rebased. GitHub can keep serving the old commits through cached PR refs until GitHub Support purges them.
  - Scrubbing does not revoke the keys; anyone who already has them keeps them. To invalidate them, rotate the Supabase anon key and roll the Stripe publishable key. Both are public client keys, designed to ship inside apps.
  - This step runs only after a separate go-ahead, because it rewrites history.

### Background on Q4, Q7, Q15, Q19, Q23 and Q26 (answered 2026-11-10)

- **Q4.** CI keeps building macOS on `macos-latest` (Apple Silicon), so the Mac build is arm64-only and Intel Macs are unsupported for now. Windows (`windows-latest`, NSIS) is still added. If Intel support is wanted later, `electron-builder --mac --x64 --arm64` can produce separate per-arch builds, with the x64 `sqlite-vec` platform package installed before packaging.
- **Q7, reject unknown providers.** `normalizeProviderRoute` (`server/headlessServer/services/providerRouter.ts:22`) stops falling back to `openaichatgpt` for unrecognised names and throws a typed error that routes map to `400 unknown provider "x"`. Every current alias keeps working, plus the D7 `openrouter` → `openrouterbyok` alias. Before this ships, any saved value that is not an alias must be normalized on load so existing settings don't start failing: localStorage provider settings, host execution preferences, subagent defaults, mobile defaults. Custom-tool `REQUEST_GENERATION` gets the 400 as a visible error instead of silently using ChatGPT.
- **Q15.** `VITE_YGG_SERVER_ORIGIN` (`src/utils/api.ts:14`) stays as an optional dev override for running the browser UI from the Vite dev server against a different Graviton server. The P4 exit check allows this one read.
- **Q19.** The codex-only `auth:migrate` import stays for this release. It is deleted in the next release, after D5's unconditional auth-manager start has shipped.
- **Q23.** `Homepage.tsx` has no importers, so it is deleted. `QuickInput` is only rendered through `LowBar` on `ConversationPage` (`LowBar.tsx:218`), and `ConversationPage` is reached only via old `/conversationPage?projectId=` markdown links (`MarkdownLink.tsx:14`). Delete `QuickInput`, its `LowBar` mounts and `quick_chat_project_id` (`usersTypes.ts:15`). Whether `ConversationPage` itself is still wanted is a follow-up. The `users` slice stays, seeded with the constant local profile: `App.tsx` (`if (!currentUser) return null`, registry bootstrap) and `ChatSelectionProvider` need `currentUser`. `Chat.tsx`'s `cached_current_credits` read goes with the credits removal (P6).
- **Q26.** `providerErrorFormatter.ts:590` maps 402 to a provider-billing error (for example `provider_billing_required`, or the existing `provider_quota_exceeded`) with the `open_settings` action and the message "Your <provider> account needs billing or credits". `free_tier_exhausted` and `subscription_inactive` are no longer emitted; they stay only as legacy union members so old rows still render (D10).

### Follow-up TODOs (after this migration)

- [ ] Move the first-party app-store catalog from the Supabase bucket to GitHub (Q10). This is the last Supabase dependency.
- [ ] Migrate app-store upload to a new mechanism and un-hide the UI (Q11); search for `TODO(app-store-upload)`.
- [ ] Prune Railway-only turn-context fields (Q24).
- [ ] Optional: separate Intel (x64) Mac build if Intel support is wanted (Q4).
- [ ] Consolidate provider name spellings into one canonical id list shared by renderer, server, mobile and custom-tool docs, and drop the extra aliases once saved settings are migrated (Q7).
- [ ] Next release: delete the codex-only legacy token import (`auth:migrate`, `importLegacyRenderer`, `authMigration` renderer import) (Q19).
- [ ] Decide whether `ConversationPage` (`/conversationPage`, reached only through old markdown project links) is still wanted, or delete it and its `LowBar` mount (Q23).
- [ ] Remove the optional `storage_mode` from the TS types, and decide whether to drop the DB columns, which needs a versioned migration and a `MIGRATIONS.md` row (Q31).

---

## How to track progress

- Tick the checklist boxes below (`- [x]`) as each location lands.
- When a row is resolved by a binding decision that contradicts it (for example D16 or the conflict notes), tick it and add `(resolved by D#)`.
- Each phase is one or more PRs on `chore/fully-local` (or stacked branches off it). Run the full gate before each merge.
- After every phase, re-run both grep guards and record the count. It must not go up. Once a phase's area is done, its directories must show zero non-allowlisted hits.
- Append a dated entry to the Progress log for every merged PR, open-question answer and test-baseline change:

  `YYYY-MM-DD · phase · PR/commit · what changed · guard hit count · notes/blockers`
- Record answers to the open questions in the Progress log, and update the matching Binding decision row in place.

## Progress log

- 2026-11-09 · plan · — · Plan v1 written (858 locations / 347 files). Guard baseline: 163 files. Status: not started. Blocked on committing `feat/shared-ui-multiclient`.

- 2026-11-10 · plan · — · Recorded answers to Q1–Q33 in the Decision log and updated the affected decisions and phases. Still open: Q4 (Intel Mac), Q7, Q15, Q19, Q23, Q26; Q17 interpretation to confirm.
- 2026-11-10 · plan · — · Answered Q4 (separate x64 and arm64 mac builds), Q7 (reject unknown providers, TODO to consolidate), Q15 (keep optional), Q19 (delete next release), Q23 (delete Homepage, QuickInput and quick_chat_project_id), Q26 (provider-billing message). No open questions remain; Q17 interpretation still to confirm.
- 2026-11-10 · plan · — · Q4 revised: Mac stays Apple Silicon only (no Intel build for now); Windows still added.
<!-- Per-location checklist follows (grouped by phase). -->

## Location checklist

_858 locations across 347 files. Generated from scout + verify + gap passes; tick as you go. Risk ⚠ notes flag shared-with-local code._

### P0 — Build & env: zero-config clean-clone build (44)

- [ ] `ygg-chat/client/ygg-chat-r/.env.example`
  - [ ] L1-9 `VITE_SUPABASE_URL/ANON_KEY, VITE_ENVIRONMENT, VITE_API_URL (Railway), VITE_STRIPE_PUBLISHABLE_KEY, SUPABASE_URL` — **delete-file** _(medium)_: Delete, or reduce to commented optional local-only vars (e.g. YGG_* server overrides). It ships the live Supabase anon JWT, the Stripe pk_live key and the Railway URL. scripts/check-env.js (predev) copies it to .env, so update or remove that hook too. — ⚠ check-env.js exits 1 if .env.example is missing. Remove or adjust predev in the same change.
  - [ ] L1-10 `VITE_SUPABASE_*/VITE_ENVIRONMENT/VITE_API_URL/VITE_STRIPE_PUBLISHABLE_KEY/SUPABASE_URL` — **delete-file** _(low)_: Delete the file, or reduce it to optional dev-only keys (VITE_YGG_SERVER_ORIGIN, YGG_CODEX_DEV_LOGS). It ships a live Supabase anon key and a Stripe live publishable key.
- [ ] `ygg-chat/client/ygg-chat-r/electron/esbuild.main.mjs`
  - [ ] L3,10-12,21 `publicEnv / authDefines (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)` — **delete-code** _(medium)_: Delete the loadEnv('VITE_SUPABASE_') call, the authDefines map and `define: authDefines` on the main.ts bundle (and the vite import if unused). The main bundle should embed no Supabase config. — ⚠ server/auth/refreshAdapters.ts supabaseConfig reads these. Remove that reader (P3) in the same or an earlier change, or it hits configuration_error paths.
- [ ] `ygg-chat/client/ygg-chat-r/electron/main.ts`
  - [ ] L20 `import '../server/envLoader.js'` — **delete-code** _(low)_: Remove the envLoader side-effect import (or gate to !app.isPackaged if envLoader is kept).
  - [ ] L20 `import '../server/envLoader.js'` — **keep-but-decouple** _(low)_: Keep only as an optional dev convenience for YGG_* and LMSTUDIO overrides. Once Supabase/Railway readers are gone, nothing should require it. Optionally skip it when app.isPackaged so a stray cwd .env cannot alter a packaged app.
- [ ] `ygg-chat/client/ygg-chat-r/package.json`
  - [ ] L15,21,22 `scripts.dev / scripts.build / scripts.build:web` — **config-change** _(high)_: Set "dev" to `cross-env BUILD_TARGET=electron vite` (same as dev:electron). Make "build" run build:electron:parallel or alias build:electron. Delete "build:web" and "dev:local". Delete "predev" (check-env.js). Point "preview" at dist-browser or drop it. — ⚠ Must land together with the clientCapabilities rewrite. If predev and check-env.js are deleted while code still reads VITE_ENVIRONMENT, Electron dev silently becomes 'local' mode. ygg-chat/package.json scripts delegate here. [verified-changed: Right direction, but it leaves out three linked things. (1) predev (line 50) runs scripts/check-env.js, which copies .env.example (Supabase/Stripe/Railway keys plus VITE_ENVIRONMENT=electron) into .en]
  - [ ] L18-20 `scripts.dev:browser-client / build:browser-client / dev:standalone` — **config-change** _(medium)_: Drop `VITE_ENVIRONMENT=... VITE_API_URL=/api` from cross-env; BUILD_TARGET alone selects the target once clientCapabilities reads __BUILD_TARGET__. — ⚠ Must land together with clientCapabilities/api.ts rewrite, otherwise standalone/browser-client lose their mode detection.
  - [ ] L47 `scripts.predev` — **delete-code** _(low)_: Delete "predev": "node scripts/check-env.js" (copies .env.example with Supabase/Railway/Stripe values into .env).
- [ ] `ygg-chat/client/ygg-chat-r/scripts/check-env.js`
  - [ ] `predev .env bootstrap` — **delete-file** _(medium)_: Delete check-env.js and the "predev" script in package.json (line 50). It copies .env.example (Supabase/Stripe/Railway values) into .env on every `npm run dev`, which defeats the no-.env goal. — ⚠ Today Electron dev gets VITE_ENVIRONMENT=electron from this copy. Delete it only after the capability rewrite.
- [ ] `ygg-chat/client/ygg-chat-r/server/envLoader.ts`
  - [ ] `loadEnv (.env from cwd/parents)` — **delete-file** _(medium)_: Delete; packaged app should not read arbitrary .env files from cwd/parents. Remaining YGG_* knobs (LOCAL_SERVER_*, LMSTUDIO_BASE_URL, OPENAI_CHATGPT_MAX_CONTEXT_TOKENS) stay readable from the real process env. — ⚠ Developers who set YGG_* dev knobs via .env lose that convenience; alternative is keep it dev-only (see open question).
- [ ] `ygg-chat/client/ygg-chat-r/server/standaloneEntry.ts`
  - [ ] L25-26 `import './envLoader.js'` — **delete-code** _(low)_: Remove envLoader import; the documented YGG_* env contract (lines 5-23) is read from process env directly.
- [ ] `ygg-chat/client/ygg-chat-r/src/config/runtimeMode.ts`
  - [ ] L11-12 `isElectronMode` — **rewrite** _(medium)_: `export const isElectronMode = isNativeShell` (drop VITE_ENVIRONMENT fallback). Rest of runtimeMode (isCommunityMode/isCloudSession...) handled by P4. — ⚠ Shared by ~20 consumers.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/Chat.tsx`
  - [ ] L1612-1617,1686 `isElectronEnv (bench export)` — **rewrite** _(low)_: Replace import.meta.env.VITE_ENVIRONMENT==='electron' || window.__IS_ELECTRON__ with isNativeShell. __IS_ELECTRON__ is a compile-time define, never a window property. Report mode as isNativeShell?'electron':VITE_ENVIRONMENT.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/streamUndoApi.ts`
  - [ ] L1-4 `isElectron (environment==='electron')` — **rewrite** _(high)_: Replace environment==='electron' with isNativeShell from platform/clientCapabilities, or isHostClient if undo should also work over LAN. Without .env, undo summaries and restore are silently disabled in Electron. — ⚠ Local stream undo/restore is a kept feature and breaks in clean-clone builds.
- [ ] `ygg-chat/client/ygg-chat-r/src/helpers/providerSettingsStorage.ts`
  - [ ] L17 `DEFAULT_LMSTUDIO_BASE_URL (VITE_LMSTUDIO_BASE)` — **rewrite** _(medium)_: Drop VITE_LMSTUDIO_BASE; use a constant default (suggest http://localhost:1234 instead of WSL IP 172.31.32.1; see open question). — ⚠ LM Studio is a kept provider; default only applies when user hasn't set a base URL.
  - [ ] L135 `syncProviderSettingsToElectronStore` — **rewrite** _(medium)_: Replace import.meta.env.VITE_ENVIRONMENT!=='electron' with !isNativeShell. Without .env, provider settings never reach Electron storage. — ⚠ The main process reads these settings.
- [ ] `ygg-chat/client/ygg-chat-r/src/helpers/serverLoopSettings.ts`
  - [ ] L32-40 `readResumableRunsEnvOverride (VITE_RESUMABLE_RUNS)` — **delete-code** _(low)_: Delete the VITE_RESUMABLE_RUNS override; keep the ygg.resumableRuns localStorage flag and isHostClient short-circuit.
- [ ] `ygg-chat/client/ygg-chat-r/src/platform/clientCapabilities.ts`
  - [ ] L2-6 `isNativeShell/isBrowserClient/isHostClient` — **rewrite** _(high)_: Derive from __BUILD_TARGET__ only: isNativeShell = target==='electron'; isBrowserClient = target==='browser-client'; add isStandaloneClient = target==='standalone'; isHostClient = any of the three. Use typeof guards so esbuild/vitest bundles without the define don't throw. — ⚠ Root of mode detection for host/browser-client shared UI; wrong value disables local server routing. Tests mock this module so unit tests are insulated. [verified]
- [ ] `ygg-chat/client/ygg-chat-r/src/services/clientTelemetry.ts`
  - [ ] L24-26 `isElectronRuntime` — **config-change** _(low)_: Telemetry only writes locally through electronAPI.logs.appendClientError (no remote sink). Replace import.meta.env.VITE_ENVIRONMENT === 'electron' with isNativeShell so the client error log works without .env.
- [ ] `ygg-chat/client/ygg-chat-r/src/utils/api.ts`
  - [ ] L10-11,181-185,205-208,685-689 `API_BASE, environment, isElectronRuntimeWithSyncIpc, resolveBrowserFallbackOrigin` — **rewrite** _(high)_: Derive `environment` from clientCapabilities (isNativeShell?'electron':isBrowserClient?'browser-client':isHostClient?'standalone':'local'). This fixes all ~25 importers at once; inline them later. Fix 368/752/905. Delete API_BASE only after app store uses localApi and remoteOrigin (chatActions:507) is gone. — ⚠ Core local transport (IPC origin discovery) and the kept app store/install flow both depend on this value. Changing the definition in one place avoids missing any of the ~25 importers. [verified-changed: The diagnosis is right. vite.config.ts:90 only defines VITE_ENVIRONMENT for browser-client, so in Electron without a .env `environment` is 'local'. That skips sync:status IPC discovery and the startup]
  - [ ] L11 `environment (VITE_ENVIRONMENT || 'local')` — **delete-code** _(high)_: Delete the exported `environment`; rewrite every consumer to isNativeShell/isHostClient/isStandaloneClient (listed individually). In an Electron build without .env it is 'local', breaking local-server discovery and shouldUseLocalApi. — ⚠ Imported by ~12 modules (Heimdall, ChatMessage, useQueries, streamUndoApi, appStore, McpAppIframe, HtmlIframeRegistry...). Must rewrite all in same change. [verified]
  - [ ] L13-18 `CONFIGURED_LOCAL_SERVER_ORIGIN (VITE_YGG_SERVER_ORIGIN)` — **keep-but-decouple** _(low)_: Optional dev-only override for standalone; not required. Either keep (documented, optional) or replace with a localStorage/devtools override so no VITE_* remains.
  - [ ] L181-182 `isElectronRuntimeWithSyncIpc` — **rewrite** _(high)_: Replace `environment !== 'electron'` with `!isNativeShell`. — ⚠ Without .env this returns false in Electron, so the renderer never discovers the real local-server port via sync:status IPC and falls back to 127.0.0.1:3002 (breaks when a fallback port is used). [verified]
  - [ ] L205 `resolveBrowserFallbackOrigin` — **rewrite** _(medium)_: Replace `environment === 'standalone'` with `isStandaloneClient`. — ⚠ Standalone same-origin routing.
  - [ ] L205,685-689 `resolveBrowserFallbackOrigin standalone check / startup refreshLocalServerStatus` — **rewrite** _(high)_: Line 205: replace environment==='standalone' with isStandaloneClient. Line 685: replace environment==='electron' with isNativeShell so startup local-server port discovery runs in no-.env Electron builds. — ⚠ Without this, Electron builds without .env never run eager port discovery. Shared with the kept local server, browser-client and standalone hosts.
  - [ ] L367-372 `shouldUseLocalApi` — **rewrite** _(high)_: Replace env-string check with isHostClient (drop the `env` param); P5 later collapses to always-local. — ⚠ With environment='local' (no .env) localServerCapable is false and callers route away from the local server. [verified]
  - [ ] L685 `startup refreshLocalServerStatus` — **rewrite** _(medium)_: Replace `environment === 'electron'` with isNativeShell. — ⚠ Eager port discovery skipped in Electron without .env.
- [ ] `ygg-chat/client/ygg-chat-r/src/vite-env.d.ts`
  - [ ] L4,6,7 `__BUILD_TARGET__/__IS_WEB__/__IS_LOCAL__ declarations` — **rewrite** _(low)_: Drop 'web' from the __BUILD_TARGET__ union; delete __IS_WEB__ (and __IS_LOCAL__ if 'local' target dropped).
  - [ ] L4,6-7,11-16 `__BUILD_TARGET__ 'web' / __IS_WEB__ / __IS_LOCAL__ / ImportMetaEnv VITE_*` — **config-change** _(low)_: Drop 'web' (and 'local' if dev:local is removed) from __BUILD_TARGET__. Remove __IS_WEB__/__IS_LOCAL__ and VITE_API_URL/VITE_ENVIRONMENT/VITE_SUPABASE_*/VITE_STRIPE_* typings once their consumers are gone, so the compiler flags stragglers.
  - [ ] L4,6,12,14-16 `__BUILD_TARGET__ 'web', __IS_WEB__, VITE_ENVIRONMENT 'web', VITE_STRIPE_PUBLISHABLE_KEY (+VITE_SUPABASE_*)` — **config-change** _(low)_: Remove 'web' from the __BUILD_TARGET__ and VITE_ENVIRONMENT unions. Delete `declare const __IS_WEB__` and VITE_STRIPE_PUBLISHABLE_KEY. The VITE_SUPABASE_* lines go with P3.
  - [ ] L10-17 `ImportMetaEnv` — **delete-code** _(low)_: Delete VITE_API_URL, VITE_ENVIRONMENT, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_STRIPE_PUBLISHABLE_KEY (and VITE_YGG_SERVER_ORIGIN if dev override is dropped). Removing them makes stragglers fail tsc.
- [ ] `ygg-chat/client/ygg-chat-r/tsconfig.node.json`
  - [ ] `compilerOptions (composite, noEmit:false)` — **config-change** _(low)_: Add outDir under node_modules/.tmp (or emitDeclarationOnly + declarationDir there) so tsc -b no longer writes vite.config.js/.d.ts next to vite.config.ts; add those names to .gitignore.
  - [ ] L10 `noEmit false (composite)` — **config-change** _(low)_: Add outDir under node_modules/.tmp (or emitDeclarationOnly) so `tsc -b` stops writing vite.config.js beside vite.config.ts.
- [ ] `ygg-chat/client/ygg-chat-r/vite.config.d.ts`
  - [ ] `compiled vite config typings (tracked)` — **delete-file** _(low)_: Delete together with vite.config.js.
- [ ] `ygg-chat/client/ygg-chat-r/vite.config.js`
  - [ ] `compiled vite config (tracked)` — **delete-file** _(medium)_: Tracked tsc output of vite.config.ts (tsconfig.node.json is composite+emit). Vite resolves vite.config.js BEFORE .ts, so `vite` dev without tsc -b runs this stale copy (still has isWeb/VITE_ENVIRONMENT define). Delete with vite.config.d.ts and stop emitting. — ⚠ If left, edits to vite.config.ts are ignored in dev until tsc -b regenerates it.
  - [ ] L49,99,116-117,128-130 `tracked tsc -b output of vite.config.ts` — **config-change** _(low)_: Stale tracked compile output (tsconfig.node.json composite emit) still holds isWeb/__IS_WEB__/stripe. Regenerate it after editing vite.config.ts, or untrack and gitignore it together with vite.config.d.ts.
- [ ] `ygg-chat/client/ygg-chat-r/vite.config.ts`
  - [ ] L36-40 `buildTarget/isWeb` — **config-change** _(medium)_: Remove isWeb; default BUILD_TARGET to 'electron' (or keep 'local' only for tests, see open question); allowed targets electron|browser-client|standalone(|local). — ⚠ Default target changes outDir/base for any script that relied on implicit 'local'.
  - [ ] L38,95,116-120 `isWeb, __IS_WEB__ define, stripe manualChunks rule` — **config-change** _(low)_: Delete `const isWeb` and the __IS_WEB__ define. Delete the `id.includes('stripe')` manualChunks rule; it also matches src/lib/payments/stripe.ts. Update the Supabase vendor comment (130-132) when Supabase goes.
  - [ ] L38,95 `isWeb / __IS_WEB__ define` — **delete-code** _(low)_: Delete `const isWeb = buildTarget === 'web'` and the __IS_WEB__ define once lib/payments (its only consumer) is deleted.
  - [ ] L88-98 `define` — **rewrite** _(medium)_: Delete the browser-client 'import.meta.env.VITE_ENVIRONMENT'/'VITE_API_URL' defines and __IS_WEB__ (and __IS_LOCAL__ once payments are gone); keep __BUILD_TARGET__, __IS_ELECTRON__, __YGG_CODEX_DEV_LOGS__. — ⚠ Removing the VITE_ENVIRONMENT define before clientCapabilities reads __BUILD_TARGET__ breaks browser-client detection.
- [ ] `ygg-chat/package.json`
  - [ ] L20-25 `scripts.dev / dev:client / build / build:client / build:web` — **config-change** _(low)_: Delete build:web; make build:client run client build:electron (or delete and make "build" = build:electron); dev/dev:client point at client dev (electron vite).
  - [ ] L20-27 `scripts.dev/build/build:client/build:web` — **config-change** _(low)_: Delete "build:web" (cross-env BUILD_TARGET=web). Make "build" = build:electron only (drop build:client, which runs the client web 'build'). Keep dev/dev:electron delegating to the client.
  - [ ] L23-25 `scripts build / build:client / build:web (BUILD_TARGET=web)` — **config-change** _(medium)_: Make "build" run only build:electron (which already runs build:electron:all). Delete build:web, and either delete build:client or repoint it, since it calls client "build", which is BUILD_TARGET=web. — ⚠ CI uses build:electron, so it is unaffected. Developers or scripts that call the root "build" currently also produce the web bundle.
  - [ ] L24-25 `build:client / build:web` — **config-change** _(medium)_: Delete build:web (BUILD_TARGET=web). Drop build:client too, or repoint it if 'build' no longer means the web bundle. The 'build' script (23) chains build:client. — ⚠ Root 'build' depends on build:client. Keep the chain consistent with P0 decisions.

### P1 — Updater → GitHub Releases, packaging & CI (25)

- [ ] `.github/workflows/desktop-release.yml`
  - [ ] L17-20 `build matrix os: [ubuntu-latest, macos-latest]` — **keep-but-decouple** _(low)_: No Windows or macOS-x64 job, so the github feed has no latest.yml (win) and arm64-only latest-mac.yml. main.ts still maps win32 to the 'windows' feed dir. Decide whether to add windows-latest (nsis) or document that Windows updates are unsupported.
  - [ ] L139-151 `Build step (npm run package:electron)` — **config-change** _(medium)_: Pass `-- --linux --publish never` / `-- --mac --publish never`. With a github publish config on a tag build, electron-builder otherwise tries to publish and fails for lack of GH_TOKEN (job has contents: read). The publish_release job remains the single release creator. — ⚠ Omitting this makes tag builds fail (no token) or race two matrix jobs creating the same release (if a token is added).
  - [ ] L139-150 `Build step: npm run package:electron -- --linux/--mac` — **config-change** _(medium)_: Append '--publish never' to both package:electron invocations. With a github publish provider, electron-builder auto-publishes on tag CI and fails without GH_TOKEN; the build job only has contents: read. The softprops step remains the single GitHub Release uploader. — ⚠ The generic provider was never publishable, so this did not matter before. Switching to github without the flag breaks or duplicates the release upload on every tag build.
  - [ ] L153-187 `Inject release notes into update manifest` — **keep-but-decouple** _(low)_: Keep. It writes markdown releaseNotes into latest-mac.yml/latest-linux.yml, which electron-updater prefers over the GitHub HTML body, so UpdateModal shows plain lines. It must run before upload-artifact, which it already does.
  - [ ] L153-186 `step 'Inject release notes into update manifest'` — **keep-but-decouple** _(low)_: Keep. It rewrites only latest*.yml (not hashed), so it still works with the github provider. It also fails the build when no latest-mac.yml/latest-linux.yml exists, which is a useful guard. No Supabase dependency.
  - [ ] L186-270,370-400 `Supabase storage upload steps (SUPABASE_URL/SERVICE_ROLE_KEY/BUCKET)` — **delete-code** _(medium)_: Delete Supabase artifact/latest*.yml upload steps; GitHub Release upload of release/* remains the feed. — ⚠ Ensure latest*.yml and blockmaps are attached to the GitHub Release.
  - [ ] L188-287 `step 'Upload update artifacts to Supabase'` — **delete-code** _(high)_: Keep this step unchanged for one bridge release (version N, the first with main.ts/electron-builder.json on the github provider) so old Supabase-polling clients get N. Delete the whole step in N+1. Keep lines 153-186 (releaseNotes injection) and 289-293 (upload-artifact). — ⚠ Installed clients hardcode the Supabase generic feed (main.ts:342, setFeedURL at 2355). If the step is removed before a GitHub-feed build has been published to Supabase, every existing install stops receiving updates and the user has to reinstall by hand. [verified-changed: Lines and symbol are accurate, and the riskNote is right. electron/main.ts:2344-2358 calls autoUpdater.setFeedURL({provider:'generic', url: <auth.yggchat.com>/{mac,linux}}), which overrides app-update]
  - [ ] L289-293 `step 'Upload release artifacts' (actions/upload-artifact path)` — **config-change** _(medium)_: Narrow path from the whole release/ dir to the updater-required files: *.dmg, *.zip, *.deb, *.blockmap, latest*.yml. This excludes mac-arm64/ and linux-unpacked/ dirs and builder-debug.yml/builder-effective-config.yaml, which collide in merge-multiple. — ⚠ Dropping *.blockmap or latest-*.yml breaks differential or any update via the github provider. Verify the asset list after the first tagged run.
  - [ ] L372-404 `Upload changelog to Supabase` — **delete-code** _(low)_: Delete the step that PUTs release notes to updates/changelog/{tag,latest}.md in the Supabase bucket. Nothing in src/electron/server reads it (Settings uses bundled CHANGELOG.md?raw; UpdateModal uses the manifest releaseNotes). It exits 1 when secrets are missing.
  - [ ] L406-413 `Create GitHub Release` — **config-change** _(medium)_: Keep as the update feed. Ensure files include latest-mac.yml, latest-linux.yml, *.zip (Squirrel.Mac needs the zip), *.dmg, *.deb and *.blockmap. Narrow the glob to those extensions to skip unpacked dirs and builder-debug.yml. Keep prerelease:false (the github provider ignores prereleases). Consider softprops/action-gh-release@v2. — ⚠ A missing latest-*.yml or zip in the release makes clients report 404/'no files' errors. A Windows latest.yml never exists because CI has no windows matrix.
- [ ] `ygg-chat/client/ygg-chat-r/electron-builder.json`
  - [ ] L69 `linux.maintainer` — **config-change** _(low)_: Maintainer 'YggChat <support@yggchat.com>' points at the hosted product domain. .deb needs a maintainer email, so swap in a project/GitHub contact if yggchat.com is being retired. Not a runtime dependency.
  - [ ] L74-79 `publish` — **config-change** _(high)_: Replace generic Supabase publish entry with [{"provider":"github","owner":"zayr0-9","repo":"Graviton","releaseType":"release"}]. This is what electron-builder bakes into resources/app-update.yml, so runtime setFeedURL is no longer needed. No token/private flag (repo must be public). — ⚠ Already-installed clients poll the Supabase feed via setFeedURL and will never see GitHub releases unless one bridge build is still uploaded to Supabase. Wrong owner/repo silently breaks updates for every future install. [verified]
- [ ] `ygg-chat/client/ygg-chat-r/electron/main.ts`
  - [ ] L339-343 `PROTOCOL, UPDATE_FEED_BASE_URL` — **delete-code** _(low)_: Delete UPDATE_FEED_BASE_URL (SUPABASE_UPDATE_FEED_BASE_URL env + https://auth.yggchat.com/... default). Delete PROTOCOL='yggchat' with the deep-link removal (P3). Keep `let autoUpdaterConfigured`.
  - [ ] L339-342,2344-2364 `UPDATE_FEED_BASE_URL / configureAutoUpdater setFeedURL` — **rewrite** _(high)_: Delete the UPDATE_FEED_BASE_URL const (SUPABASE_UPDATE_FEED_BASE_URL || auth.yggchat.com bucket), the missing-URL guard, the platformDir computation and the autoUpdater.setFeedURL({provider:'generic'}) call. Let electron-updater read the github app-update.yml. Keep the isPackaged guard, event forwarding and the 3s checkForUpdatesAndNotify. — ⚠ setFeedURL overrides app-update.yml, so this change must ship in the same (bridge) build as the electron-builder github publish change. Otherwise updates stay on Supabase.
  - [ ] L340-343,2344-2361 `UPDATE_FEED_BASE_URL / setupAutoUpdater setFeedURL({provider:'generic'})` — **rewrite** _(high)_: Delete the UPDATE_FEED_BASE_URL const (auth.yggchat.com default) and the 'SUPABASE_UPDATE_FEED_BASE_URL missing' guard. Either drop setFeedURL so app-update.yml (github) is used, or call setFeedURL({provider:'github', owner, repo}). Keep the autoUpdater event wiring. — ⚠ This is the kept auto-updater. The runtime override currently wins over electron-builder.json, so leaving it in place means the GitHub move never takes effect. Removing the event handlers by mistake would break the update UI.
  - [ ] L341-342 `UPDATE_FEED_BASE_URL (SUPABASE_UPDATE_FEED_BASE_URL)` — **delete-code** _(medium)_: Delete constant; updater uses electron-builder's embedded app-update.yml (provider github) instead of a Supabase generic feed. — ⚠ Must change together with electron-builder.json publish.
  - [ ] L1425-1449,1183-1187,8-9,38-39 `autoUpdater:check / autoUpdater:installNow / nativeAutoUpdater before-quit-for-update` — **keep-but-decouple** _(low)_: No change needed. These are provider-agnostic. Keep the electron-updater import, the IPC handlers and the before-quit-for-update isQuitting bypass.
  - [ ] L2334-2364 `configureAutoUpdater (feed setup)` — **rewrite** _(medium)_: Remove the UPDATE_FEED_BASE_URL guard, the platformDir computation and autoUpdater.setFeedURL({provider:'generic'}). Keep the !app.isPackaged skip. electron-updater then reads the github config from app-update.yml. For testing, use dev-app-update.yml + autoUpdater.forceDevUpdateConfig instead of an env URL. — ⚠ If app-update.yml is missing (publish misconfigured or --publish never misused), checkForUpdates throws and the error goes to the renderer, which silently closes the modal. Verify the packaged resources contain app-update.yml.
  - [ ] L2344-2361 `configureAutoUpdater setFeedURL generic` — **rewrite** _(medium)_: Remove missing-env warning and setFeedURL({provider:'generic', url}); rely on default github feed (or setFeedURL({provider:'github', owner, repo})). — ⚠ Existing installs read the old Supabase feed; final Supabase-fed release must point at GitHub.
  - [ ] L2366-2409 `configureAutoUpdater (event wiring + checkForUpdatesAndNotify)` — **keep-but-decouple** _(medium)_: Keep the event forwarding and the delayed checkForUpdatesAndNotify. Optionally gate install on macOS when the app is unsigned (see open question): emit update-available with a GitHub release URL instead of downloading, because Squirrel.Mac rejects unsigned updates. — ⚠ CI builds macOS without CSC_LINK/notarization, and Squirrel.Mac refuses unsigned bundles ('code signature did not pass validation'). Mac auto-install stays broken until signing is added or mac install is gated.
- [ ] `ygg-chat/client/ygg-chat-r/electron/preload.ts`
  - [ ] L212-245 `electronAPI.autoUpdater` — **keep-but-decouple** _(low)_: Keep as is. Feed-agnostic IPC bridge for UpdateModal.
- [ ] `ygg-chat/client/ygg-chat-r/package.json`
  - [ ] L6-10 `homepage / author.email` — **config-change** _(low)_: homepage https://yggchat.com and support@yggchat.com feed electron-builder metadata (deb maintainer fallback). Point homepage at https://github.com/zayr0-9/Graviton and optionally add a "repository" field. Do not touch "version" (user-owned).
- [ ] `ygg-chat/client/ygg-chat-r/scripts/BUILDING.md`
  - [ ] L3-5,22,53-55 `updater metadata / electron-updater retention / smoke checklist` — **update-docs** _(low)_: Document that the update feed is GitHub Releases (publish provider github, CI --publish never + softprops upload) and that latest-*.yml and blockmaps must be release assets. Keep electron-updater in runtimePackages.
- [ ] `ygg-chat/client/ygg-chat-r/scripts/build.test.mjs`
  - [ ] L61,85 `packaging test asserts electron-updater runtime pkg and build:mac regex /&& electron-builder --mac zip$/` — **update-test** _(low)_: Keep the electron-updater assertion. If P1 changes the build:mac script (for example adds --publish never for the GitHub provider), update the line 85 regex to match.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/UpdateModal/UpdateModal.tsx`
  - [ ] L4-7,88-106 `UpdateInfo.releaseNotes / normalizedReleaseNotes` — **keep-but-decouple** _(low)_: No Supabase usage. With the github provider, releaseNotes comes from latest*.yml when CI injects it, otherwise from the GitHub release body as HTML. Keep the CI injection step, or strip HTML tags (/<[^>]+>/g) before the newline split so raw markup never renders.

### P2 — Server cloud layer (Railway, gateway, mirror, cloud OpenRouter provider, free tier) (121)

- [ ] `ygg-chat/client/ygg-chat-r/electron/main.ts`
  - [ ] L2528-2540 `OpenAiChatgptProvider.generate railwayTurn` — **rename** _(high)_: Rename railwayTurn to turnContext (all fields: conversationId, parentId, think, attachmentsBase64, imageConfig, reasoningConfig, serviceTier, promptCacheRetention, openaiHostedTools, runId, isElectron). Do it in lockstep with ProviderRailwayTurnInput, moved from openRouterProvider.ts into providers/types.ts before that file is deleted. — ⚠ The Electron openaichatgpt stream bridge and all local providers read this object. A partial rename drops reasoning, attachments, image config, service tier and cache retention without any error (optional field). [verified-changed: Lines are accurate. The field list omits imageConfig and isElectron. The interface ProviderRailwayTurnInput (and ProviderGenerateInput, used by every local provider: codex, bedrock, zai, lmstudio, hyp]
  - [ ] L2528-2541 `IPC openai stream provider.generate({ railwayTurn: {...} })` — **rename** _(medium)_: Rename railwayTurn to turnContext in the Electron IPC ChatGPT stream. Drop isElectron and parentId; keep conversationId, attachmentsBase64, imageConfig, reasoningConfig, serviceTier, promptCacheRetention and runId. — ⚠ This is a kept direct-ChatGPT path. runId is read as the Codex requestId.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/config/gatewayFlags.ts`
  - [ ] `resolveGatewayFlags/GatewayFlags` — **delete-file** _(medium)_: Delete: chat/crud/cloudProxy are cloud-only and resumableRuns is hard-coded true. Drop YGG_GATEWAY_MODE and gateway.* Conf keys. Keep config/settingsStore.ts (used by electron app auth/others). — ⚠ index.ts must inline resumableRuns=true in same change.
  - [ ] `resolveGatewayFlags chat/crud/cloudProxy/YGG_GATEWAY_MODE` — **rewrite** _(medium)_: Drop the chat, crud and cloudProxy flags, the tokenOwner docs and the cloud docblock. resumableRuns is hard-wired to true on every path, so either delete the module and inline const resumableRuns = true at index.ts 282/333/394/451/477, or keep a one-field module. — ⚠ resumableRuns gates the run reaper, subagent live streams, watcher continuation and chat-route detach. These are kept features; they must stay on.
  - [ ] L1-77 `GatewayFlags chat/crud/cloudProxy, YGG_GATEWAY_MODE` — **rewrite** _(high)_: Delete the chat/crud/cloudProxy flags and their doc comments; crud and cloudProxy are already vestigial. Keep resumableRuns (always true), or inline it at its consumers. — ⚠ resumableRuns is a kept local feature: a run survives an SSE disconnect, which shared/browser clients need.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/index.ts`
  - [ ] L30-35,49,282-287 `registerCloudProxyRoutes/createAppAuthTokenManager/createRailwayClient/createCloudMirrorService imports; appAuth, railway, ProviderRouter({appAuth})` — **delete-code** _(low)_: Delete the imports at lines 32-35 and the appAuth/railway constants at 283-286. Construct the router as new ProviderRouter({ tokenStore }). Keep the gatewayFlags import only if the slimmed module survives (see the gatewayFlags.ts item).
  - [ ] L32-35,49,281-287 `registerHeadlessServerRoutes: imports + appAuth/railway/gatewayFlags construction` — **delete-code** _(medium)_: Delete imports of registerCloudProxyRoutes, createAppAuthTokenManager, createRailwayClient, createCloudMirrorService, resolveGatewayFlags. Remove `appAuth`/`railway` consts; construct `new ProviderRouter({ tokenStore })` without appAuth. — ⚠ ProviderRouter ctor signature changes in lockstep with OpenRouterProvider removal; must land in the same change or compile breaks.
  - [ ] L33,268-270,285-287,359 `OAuth-override middleware 'openrouter'; createAppAuthTokenManager; new ProviderRouter({ tokenStore, appAuth })` — **delete-code** _(medium)_: Drop `|| provider === 'openrouter'` at line 269. Change line 287 to new ProviderRouter({ tokenStore }). Remove appAuth (285) and the createAppAuthTokenManager import (33) once the railway, gateway and cloud users at 286 and 359 are also removed. — ⚠ The middleware guards the local /api/conversations routes against injected Codex tokens. Keep the openaichatgpt check.
  - [ ] L33,282-286,338-341 `createAppAuthTokenManager/appAuth/railway wiring, registerHostRuntimeRoutes ensureLocalUser` — **rewrite** _(medium)_: Remove the appAuth import and instance, and drop appAuth from new ProviderRouter({tokenStore}). Replace the ensureLocalUser callback with an unconditional startup 'INSERT OR IGNORE INTO users (id,username) VALUES (LOCAL_USER_ID,...)' after initializeAuth(deps.db) on line 277, which stays for Codex. — ⚠ initializeAuth must stay because it starts the Codex refresh owner and runs the Codex legacy migration. A missing users row can break FK-dependent project/conversation inserts, so seed it at startup.
  - [ ] L266-275 `OAuth credential override guard middleware` — **rewrite** _(low)_: Drop the `provider === 'openrouter'` clause; guard only openaichatgpt (Codex OAuth stays server-owned). Keep rejecting body tokens/chatgpt-account-id for openaichatgpt.
  - [ ] L266-273 `OAuth override guard provider === 'openrouter'` — **rewrite** _(low)_: Keep the guard but compare only provider === 'openaichatgpt'. The 'openrouter' arm becomes a TS2367 compile error once the ProviderRoute member is removed.
  - [ ] L268-273,283-287 `OAuth-override middleware; createAppAuthTokenManager / new ProviderRouter({ tokenStore, appAuth })` — **rewrite** _(medium)_: At line 269, drop the `|| provider === 'openrouter'` check. At 287, construct ProviderRouter({ tokenStore }) without appAuth. Delete appAuth/railway at 285-286 once cloud routes are gone (P2 cloud-layer owner). — ⚠ appAuth also feeds gatewayRoutes, railwayClient and the cloud mirror. Remove it only after those are deleted.
  - [ ] L282,295-298,333,394,451,477 `gatewayFlags.resumableRuns` — **collapse-to-local** _(medium)_: resolveGatewayFlags() already hard-codes resumableRuns=true. Replace with `const resumableRuns = true` (or drop the conditionals: always start reaper, always pass runSessions, always configure watch continuation, pass resumableRuns:true to chat routes). Update comments mentioning gateway.resumableRuns. — ⚠ Run detach/reattach, watcher continuation and subagent live streaming all hang off this flag; must remain effectively true.
  - [ ] L349-365 `gateway mount block (registerGatewayRoutes + registerCloudProxyRoutes)` — **rewrite** _(high)_: Replace with `registerGatewayRoutes(app, { db: deps.db, statements: deps.statements })` (local-only adapter, no railway/mirror/auth/enabled). Delete registerCloudProxyRoutes call. Rewrite the Phase-5 comment to describe /api/gw as the local data facade. — ⚠ Every renderer CRUD/read (gwApi, ~60 call sites incl. browser-client host) goes through /api/gw; it must stay mounted and behave exactly like today's no-cloud-session path. [verified]
  - [ ] L443-447 `ChatOrchestrator deps cloudChatEnabled` — **delete-code** _(low)_: Remove `cloudChatEnabled: gatewayFlags.chat` and its 'Phase 4 cloud free-tier relay' comment.
  - [ ] L445-446 `cloudChatEnabled: gatewayFlags.chat` — **delete-code** _(low)_: Remove the cloudChatEnabled dep and the 'Phase 4: cloud (openrouter) free-tier relay' comment from the ChatOrchestrator construction.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/__tests__/imageHistory.test.ts`
  - [ ] L3,15,36-43 `'relays per-row artifacts to OpenRouter' test; railwayTurn fixture` — **update-test** _(low)_: Remove the OpenRouterProvider import (line 3) and delete the 'relays per-row artifacts to OpenRouter' case (lines 36-43). Rename railwayTurn to turnContext in the input fixture (line 15). Keep the Codex, LM Studio and hyper cases.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/__tests__/openRouterProvider.freeTier.test.ts`
  - [ ] `OpenRouterProvider free-tier relay / shared app auth tests` — **delete-file** _(low)_: Delete. It only tests the deleted Railway provider: free-tier SSE relay, the 403 limit and the RailwayAppAuthError refresh.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/__tests__/providerErrorFormatter.test.ts`
  - [ ] L90-112,138-150,163-172 `RailwayAppAuthError / 401 session_expired / 402 subscription_inactive / free_tier cases` — **update-test** _(low)_: Delete the RailwayAppAuthError case. Change the 401 and default-provider expectations to provider_signin_required. Update the 402 and 403 free-tier expectations to the new codes. In the provider loops, replace 'openrouter' with 'openrouterbyok'.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/codex/codexRequestItems.ts`
  - [ ] L3,80 `import ProviderGenerateInput/ProviderToolDefinition; input.railwayTurn?.attachmentsBase64` — **rename** _(high)_: Import the types from '../providerTypes.js'. Change line 80 to input.turnContext?.attachmentsBase64. — ⚠ Image attachments for Codex depend on this field. A missed rename silently drops the images. [verified]
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/codex/codexResponseEvents.ts`
  - [ ] L1 `ProviderPartialOutput import` — **rename** _(high)_: Re-point the import to '../providerTypes.js'. — ⚠ Kept Codex provider. The build breaks if openRouterProvider.ts is deleted first.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/codex/codexResponsesProvider.ts`
  - [ ] L6-7,99 `attachPartialOutput/ProviderPartialOutput import; providerInput.railwayTurn?.serviceTier` — **rename** _(high)_: Import attachPartialOutput and ProviderPartialOutput from '../providerTypes.js'. At line 99, read input.providerInput.turnContext?.serviceTier. — ⚠ Codex fast/priority mode depends on this read. If the rename is missed, service_tier:'priority' is no longer sent.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/codex/codexSse.ts`
  - [ ] L1 `attachPartialOutput import` — **rename** _(high)_: Re-point the import to '../providerTypes.js'. — ⚠ Kept Codex SSE transport. attachPartialOutput preserves partial text when a stream fails (R1a).
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/codex/codexWebsocket.ts`
  - [ ] L2 `attachPartialOutput import` — **rename** _(high)_: Re-point the import to '../providerTypes.js'. — ⚠ Kept Codex websocket transport.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/codex/types.ts`
  - [ ] L2-7 `ProviderGenerateInput/ProviderStreamEventHandler/ProviderToolCall/ProviderToolDefinition import` — **rename** _(high)_: Re-point the import to '../providerTypes.js'. — ⚠ Kept Codex provider. The build breaks if this is not re-pointed before openRouterProvider.ts is deleted.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/hyperRouterAdapter.ts`
  - [ ] L11 `ProviderGenerateInput/ProviderGenerateOutput/ProviderToolCall import` — **rename** _(high)_: Re-point the import to './providerTypes.js'. — ⚠ Shared by the kept Z.AI, Bedrock and BYOK providers.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/hyperRouterBedrockProvider.ts`
  - [ ] L2-7 `provider types import` — **rename** _(high)_: Re-point the import to './providerTypes.js'. — ⚠ Kept Bedrock provider. The build breaks otherwise.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/hyperRouterOpenRouterProvider.ts`
  - [ ] L5-10,14 `import type HeadlessProvider etc.; OPENROUTER_BYOK_PROVIDER_KEY comment` — **keep-but-decouple** _(low)_: KEEP: this is the BYOK provider, which calls openrouter.ai directly. Change the import path to './providerTypes.js'. Update the line 14 comment, which says 'distinct from the app-account openrouter'.
  - [ ] L5-10 `HeadlessProvider/... import from ./openRouterProvider.js` — **rename** _(high)_: Re-point only the lines 5-10 import to './providerTypes.js'. Leave line 2 (`OpenRouterProvider` from '@hyper-labs/hyper-router/providers/openrouter') unchanged. That class is the BYOK transport, not the cloud provider. — ⚠ Same class name as the deleted cloud provider. A symbol-based search-and-delete would break BYOK.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/hyperRouterZaiProvider.ts`
  - [ ] L2-7 `provider types import` — **rename** _(high)_: Re-point the import to './providerTypes.js'. — ⚠ Kept Z.AI provider. The build breaks otherwise.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/lmStudioProvider.ts`
  - [ ] L1-7 `provider types import` — **rename** _(high)_: Re-point the import to './providerTypes.js'. — ⚠ Kept LM Studio provider. The build breaks otherwise.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/openRouterProvider.ts`
  - [ ] L1-849 `OpenRouterProvider, RailwayAppAuthError, RailwayProviderTokenError, RailwayOpenRouterRequestError, RailwayOpenRouterStreamError, getRemoteApiBase` — **delete-file** _(high)_: Delete the Railway-backed cloud OpenRouter provider. It calls webdrasil /conversations/:id/messages with the app token and relays free-tier frames. Delete it only after the shared types move to providerTypes.ts. — ⚠ About 20 kept files import types from this file. They must be re-pointed in the same change. [verified]
  - [ ] L12-170 `ProviderToolDefinition, ProviderRailwayTurnInput, ProviderGenerateInput, ProviderToolCall, ProviderGenerateOutput, ProviderPartialOutput, attachPartialOutput, ProviderStreamEventHandler, HeadlessProvider` — **rewrite** _(high)_: Move the shared types and the runtime attachPartialOutput into providers/providerTypes.ts, renaming ProviderRailwayTurnInput to ProviderTurnContext. Repoint the 16 importers (codex/*, hyperRouterAdapter, openaiChatgptProvider, messageSink, multiCallExecutor, subagent*, ephemeralGenerateRoutes). Then delete the Railway errors and the OpenRouterProvider class. — ⚠ codexSse, codexWebsocket, codexResponsesProvider and openaiChatgptProvider import attachPartialOutput at runtime. Deleting the file without extracting it first breaks the kept ChatGPT provider.
  - [ ] L454 `remote base (YGG_API_URL/VITE_API_URL)` — **delete-file** _(medium)_: Railway-backed cloud 'openrouter' provider; delete (openrouterbyok stays). — ⚠ Check shared helpers imported by openrouterbyok/hyperRouterAdapter before deleting.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/openaiChatgptProvider.ts`
  - [ ] L11-20,659,952,2071,2083-2091,2109 `imports from ./openRouterProvider.js; input.railwayTurn reads` — **rename** _(high)_: Import attachPartialOutput and the types from ./providerTypes.js. Rename input.railwayTurn to input.turnContext at 659 (imageConfig), 952/2071/2083 (conversationId), 2084 (runId, drop the 'as any' cast), 2091 (reasoningConfig) and 2109 (allowCommentaryFallbackText). Update the comment at 2087-2090. — ⚠ Codex/ChatGPT is a kept provider. The session id, prompt-cache key, reasoning effort and image config all come from this field, so a missed rename silently drops them. [verified]
  - [ ] L659,952,2071,2083-2091,2109 `input.railwayTurn reads` — **rename** _(high)_: Rename input.railwayTurn to input.turnContext, covering imageConfig, conversationId (cache key and session), runId, reasoningConfig.effort and allowCommentaryFallbackText. Do the same in codex/codexRequestItems.ts:80 (attachmentsBase64) and codex/codexResponsesProvider.ts:99 (serviceTier). — ⚠ Optional chaining hides a missed rename: images, reasoning effort, priority tier and the prompt-cache key degrade silently.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/providerErrorFormatter.ts`
  - [ ] L500-521,555-558,567-575,586-606,625-643,704 `isByokOrLocalProvider, authCode, codeFromTypedError (RailwayAppAuthError), codeFromStatus 402/403/429, codeFromErrorType reauth_required/free_tier` — **rewrite** _(medium)_: authCode: make the default 'provider_signin_required' (every provider is now BYOK or local) and drop the Railway comment. Delete the RailwayAppAuthError and reauth_required to session_expired mappings at 570-572 and 627-629. Map free-tier/402 wording to provider_quota_exceeded, not free_tier_exhausted or subscription_inactive. — ⚠ This is the shared classifier for every kept provider. The 401 default changes from session_expired to provider_signin_required. Coordinate with shared/chatErrors.ts actions ('sign_in', 'upgrade').
  - [ ] L555-558,570,572 `authCode default session_expired, RailwayAppAuthError, errorType reauth_required` — **rewrite** _(medium)_: With no app session, a 401 or reauth from any provider should map to provider_signin_required (or credentials_missing), not session_expired, whose action is 'Sign in' to a Login page that no longer exists. Drop the RailwayAppAuthError branch. — ⚠ Shared with all local providers' error UX. Update providerErrorFormatter.test.ts:99,110,148-150.
  - [ ] L570 `RailwayAppAuthError -> session_expired` — **delete-code** _(low)_: Delete the RailwayAppAuthError name mapping and the matching case at providers/__tests__/providerErrorFormatter.test.ts:95.
  - [ ] L570,572 `codeFromTypedError RailwayAppAuthError / reauth_required` — **delete-code** _(low)_: Delete the `name === 'RailwayAppAuthError'` arm at line 570. Line 572 (errorType 'reauth_required') is produced only by the 'app' auth slot (authSessionManager.ts:29), so remove it in P3 once that slot is gone.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/providerTypes.ts`
  - [ ] `(new file) ProviderToolDefinition, ProviderTurnContext, ProviderGenerateInput, ProviderToolCall, ProviderGenerateOutput, ProviderPartialOutput, attachPartialOutput, ProviderStreamEventHandler, HeadlessProvider` — **rewrite** _(high)_: Create providerTypes.ts with openRouterProvider.ts lines 12-141 plus the type imports of HeadlessStreamEvent (line 1) and OpenAIContextUsage (line 3). Rename ProviderRailwayTurnInput to ProviderTurnContext and railwayTurn to turnContext. Drop storageMode and relayFreeTierEvents (lines 30 and 40-46). — ⚠ 14 kept provider and service files plus tests import from openRouterProvider.ts. Do not touch the unrelated `OpenRouterProvider` from '@hyper-labs/hyper-router/providers/openrouter' (hyperRouterOpenRouterProvider.ts:2, BYOK). A blind rename by symbol would break BYOK. [verified-changed: The action is correct. The 'unchanged' wording leaves out two things. Lines 12-141 need the type imports from lines 1 and 3 (HeadlessStreamEvent from shared/headlessApi.js, OpenAIContextUsage from sha]
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/__tests__/cloudProxyRoutes.test.ts`
  - [ ] L14-15,32 `allowlist assertions incl. /stripe and /app-store` — **delete-file** _(low)_: Delete with cloudProxyRoutes.ts (P2). It asserts the /stripe/pricing-info and /app-store/community prefixes.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/__tests__/ephemeralGenerateRoutes.test.ts`
  - [ ] L167-287 `openrouter routing / inference / managed-account / electron-session-sync tests` — **update-test** _(low)_: Delete the remote-openrouter cases (167-201, 202-243, 244-287). Add cases that check that explicit 'openrouterbyok' and unprefixed slash models infer 'openrouterbyok' and use the hyper BYOK provider. Keep the bedrock, openai and zai cases.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/__tests__/lineageRoutes.test.ts`
  - [ ] L34-58 `lineage route tests fetching /api/gw/...` — **update-test** _(low)_: Change the fetch URLs if the /api/gw prefix is renamed during the gateway collapse. Keep the assertions (owner scoping, 404s, limit clamp).
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/__tests__/providerAuthRoutes.test.ts`
  - [ ] L56-60,87-128,130-140 `'rejects raw app OAuth credential registration', 'fetches live openrouter model listing from remote', 'returns provider model listing'` — **update-test** _(low)_: Delete the app-OAuth 410 case (56-60) and the remote webdrasil model-listing case (87-128). At 138, expect 'openrouterbyok' rather than 'openrouter' in the provider names.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/__tests__/subagentRoutes.test.ts`
  - [ ] L145-153 `'rejects openrouter provider with 400'` — **update-test** _(low)_: Delete this case, or retarget it to the chosen unknown-provider behavior.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/capabilityRoutes.ts`
  - [ ] L57-61 `providers: { name: 'openrouter', auth: 'app_bearer' }` — **rewrite** _(low)_: Replace the 'openrouter'/'app_bearer' entry with { name: 'openrouterbyok', auth: 'api_key' }. Optionally add zai and bedrock as api_key and claude as session.
  - [ ] L59 `capabilities providers { name: 'openrouter', auth: 'app_bearer' }` — **delete-code** _(low)_: Remove the openrouter/app_bearer entry. Optionally add { name: 'openrouterbyok', auth: 'api_key' } and the zai and bedrock entries.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/cloudProxyRoutes.ts`
  - [ ] `/api/cloud/* proxy` — **delete-file** _(medium)_: Delete after renderer cloudApi callers are removed (system-prompts, models, users, research-notes, oauth/google-drive, stripe, analytics, generate/ephemeral, search, user/account). — ⚠ Removing first makes remaining callers 404 (some show errors in UI).
  - [ ] L31 `CLOUD_PROXY_ALLOWED_PREFIXES '/app-store'` — **delete-code** _(low)_: Removed with the whole cloud proxy in P2. The renderer never calls /api/cloud/app-store; the app store uses /api/app-store/* in appStoreRoutes.ts, so nothing app-store-related is lost.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/ephemeralGenerateRoutes.ts`
  - [ ] L3,9,75-97,99-100,189-198,207-329,347-372,414 `inferEphemeralProvider, normalizeModelName, runRemoteOpenRouterEphemeralGenerate, getRemoteApiBase, resolveRemoteAppAccessToken, buildRemoteEphemeralMessages, registerEphemeralChatHandler` — **collapse-to-local** _(medium)_: Delete lines 207-329 and the getAuthManager import (line 3). At line 93, return 'openrouterbyok'. Drop the openrouter fallback at line 100. In the dispatch at 361-372, drop the openrouter arm and the tokenStore parameter (349, 414). At line 189, rename railwayTurn to turnContext. Import the types from ../providers/providerTypes.js. — ⚠ Only Zai.ts (explicit provider) and external /api/headless/ephemeral/chat callers use this route. Slash models without a provider now need a BYOK key. ephemeralGenerateRoutes.test.ts lines 167-286 assert the openrouter behaviour. [verified-changed: The code action is right and the lines are accurate. getAuthManager is used only at line 216, and the tokenStore parameter of registerEphemeralChatHandler is used only at line 363. The riskNote is wro]
  - [ ] L3,207-217 `getRemoteApiBase, resolveRemoteAppAccessToken` — **delete-code** _(medium)_: Delete the Railway remote path helpers that resolve the Supabase app token. The local-provider ephemeral path stays (the inferEphemeralProvider default is owned by the cloud-openrouter area). — ⚠ Ephemeral generation is used by local features such as titles. Keep the local providers path intact.
  - [ ] L189-198 `railwayTurn for local openaichatgpt ephemeral` — **rename** _(medium)_: Rename railwayTurn to turnContext in the local openaichatgpt ephemeral call. The remote and Railway ephemeral paths are handled by a separate item. — ⚠ The local ephemeral path (titles, summaries) relies on the conversationId and allowCommentaryFallbackText fields.
  - [ ] L207-209 `getRemoteApiBase` — **delete-code** _(high)_: Delete lines 207-329 and the provider==='openrouter' dispatch arm (362-363). Make the slash-model default at line 93 return 'openrouterbyok'. Map an explicit 'openrouter' to 'openrouterbyok' or reject it. Drop the 'openrouter' fallback at line 100 and the getAuthManager import at line 3. Update ephemeralGenerateRoutes.test.ts. — ⚠ The same route serves local ephemeral generation for openaichatgpt/zai/bedrock/lmstudio/openrouterbyok. Only the 'openrouter' arm and the inference default should change. [verified-changed: The remote path is much wider than 207-209: resolveRemoteAppAccessToken 211-217 (uses getAuthManager().resolve('app')), normalizeHistoryMessage/buildRemoteEphemeralMessages 219-241 (used only by the r]
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/gatewayRoutes.ts`
  - [ ] L1-60,238-322 `RegisterGatewayRoutesDeps, cloudLeg, hasCloudSession, localRowStorageMode, resolveWriteMode, mirrorBestEffort` — **collapse-to-local** _(high)_: Recommendation: KEEP /api/gw/* URLs as a local-only facade. Drop railway/mirror/auth/enabled deps and their imports; delete cloudLeg, hasCloudSession, mirrorBestEffort, resolveWriteMode/localRowStorageMode (always local). Keep localLeg loopback, fetchImpl/localOrigin seams. — ⚠ Must equal today's no-session path. Note resolveWriteMode currently defaults missing rows to cloud; after collapse missing rows go to /api/app and 404 (correct). [verified]
  - [ ] L21-30 `imports: deleteMessages lock helpers, mergeLocal*, RailwayClient, CloudMirrorService, AppAuthTokenManager, toSafeHookRunRecord, HookRunRepo` — **delete-code** _(low)_: After the collapse, keep only express, getServerInternalOrigin, the type-only Express/Request import and buildConversationMessagesTreePayload. Every other import is used only on cloud paths.
  - [ ] L57-232 `dedupById, mergeConversationLists, mergeProjects, mergeRecent, mergeConversationsPaginated, mergeByProjectPaginated, toCloudConversationCreate, toCloudProjectCreate, toCloudProjectUpdate, CONVERSATION_SUBFIELDS.cloudPath` — **delete-code** _(low)_: Delete the merge helpers and the toCloud* normalizers, plus the cloudPath field in CONVERSATION_SUBFIELDS. Keep ts(), sortByUpdatedDesc (used by /recent), toLocalConversationCreate, toLocalProjectCreate, pick and GW_PAGE_SIZE.
  - [ ] L61-237 `mergeConversationLists, mergeProjects, mergeRecent, mergeConversationsPaginated, mergeByProjectPaginated, dedupById, toCloudConversationCreate, toCloudProjectCreate, toCloudProjectUpdate, CONVERSATION_SUBFIELDS.cloudPath` — **delete-code** _(medium)_: Delete merge helpers and toCloud* mappers and cloudPath field. Keep ts()/sortByUpdatedDesc, GW_PAGE_SIZE, pick, toLocalConversationCreate/toLocalProjectCreate (still force storage_mode 'local'), CONVERSATION_SUBFIELDS key/column. — ⚠ toLocal*Create camel→snake mapping and storage_mode:'local' must survive; local rows created without storage_mode would default to 'cloud' (schema DEFAULT) and be hidden by local-only statements.
  - [ ] L296-307,697-710,766-782,851-862 `resolveWriteMode, messageStorageMode, attachmentMessageMode, GET /api/gw/attachments/:id ?storageMode= hints` — **collapse-to-local** _(high)_: Send every /api/gw route to the local leg. Delete localRowStorageMode, resolveWriteMode, messageStorageMode, attachmentMessageMode, hasCloudSession, cloudLeg, mirrorBestEffort, merge*/toCloud* helpers, the cloud tree enrichment (642-671) and POST /api/gw/attachments. Keep sortByUpdatedDesc, GW_PAGE_SIZE and the paths. Drop the railway/mirror/auth deps. — ⚠ All renderer CRUD goes through /api/gw. Today absent rows default to 'cloud'; after the collapse they hit local and 404 (fine). The local-only /paginated branch caps results at 50 with nextCursor null; delegate to /api/app pagination. Update index.ts 356-364 and the gateway tests. [verified-changed: The line numbers are off. localRowStorageMode is 281-292, resolveWriteMode 300-305, messageStorageMode 701-710, attachmentMessageMode 771-794 (not 766-782), and GET /api/gw/attachments/:id 851-866. Co]
  - [ ] L323-598 `/api/gw/projects*, /api/gw/conversations* (list/paginated/by-project/recent/favorites/search/single/POST/PATCH/DELETE/subfields)` — **collapse-to-local** _(high)_: Keep only the localLeg branches; drop the hasCloudSession checks, cloud legs and mirror calls. For /paginated, pass through to /api/app/conversations?userId&limit&cursor (offset cursor) instead of the 50-row emulation. Keep by-project passthrough, additional-cwds, and subfield PATCH as {column}. Drop the toCloud* calls. — ⚠ Sidebar, search and favorites depend on these exact shapes. Switching /paginated to real offset paging changes page 2+ behaviour; new conversations prepended client-side can shift offsets (duplicate or skipped rows). Verify the infinite-scroll dedupe. [verified-changed: The real range is 321-599 (the '// ---- Projects' header is at 321 and the subfield loop closes at 599). The better action for /paginated is to pass the request through, not to keep the emulation. The]
  - [ ] L600-683 `GET system-prompt/context, GET messages/tree, GET messages, POST messages/bulk` — **collapse-to-local** _(high)_: Lines 600-699. Keep the {systemPrompt}/{context} reshapes, the in-process buildConversationMessagesTreePayload call (unconditional) and the local messages + bulk legs. Delete the cloud tree enrichment block (HookRunRepo, toSafeHookRunRecord, runMetadata merge) and its imports (lines 24, 29, 30), plus the cloud fallbacks and mirror calls. — ⚠ messages/tree is the hot read, refetched at every stream end. It must stay in-process (no loopback) with includeTree=false honoured. system-prompt/context must keep r.ok ? 200 : status semantics. [verified-changed: POST messages/bulk runs from 685 to 699, so the given range 600-683 leaves it out. After the collapse, an unknown id on the in-process tree returns 200 {messages:[],tree:null,meta}, not a 404. That is]
  - [ ] L697-765 `messageStorageMode, updateMessage, DELETE /api/gw/messages/:id, POST /api/gw/messages/deleteMany` — **collapse-to-local** _(medium)_: Delete messageStorageMode; always forward to /api/app/messages/* (PUT/PATCH/DELETE/deleteMany). Remove cloud-only withMessageDeletionLock/assertMessagesNotInActiveRun/deleteMessagesWithLineageRepair imports. — ⚠ Local /api/app deleteMany already asserts active-run fencing; verify single DELETE /api/app/messages/:id parity (it does not assert active run) so behavior is unchanged from today's local path.
  - [ ] L701-767 `messageStorageMode, updateMessage, DELETE /api/gw/messages/:id, POST /api/gw/messages/deleteMany` — **collapse-to-local** _(high)_: Delete messageStorageMode. PUT/PATCH/DELETE/deleteMany always call localLeg to /api/app/messages/*. Delete the cloud branches, which used withMessageDeletionLock, assertMessagesNotInActiveRun and deleteMessagesWithLineageRepair. — ⚠ Message edit and delete are core local CRUD. The local /api/app deleteMany already calls assertMessagesNotInActiveRun (appAutomationRoutes 1338), so the active-run protection is kept. Today a conversation with storage_mode 'cloud' is misrouted to Railway.
  - [ ] L767-904 `attachmentMessageMode, /api/gw/messages/:id/attachments, /api/gw/attachments/:id, POST /api/gw/attachments` — **collapse-to-local** _(medium)_: Delete attachmentMessageMode; keep local SQLite read/link/delete and local GET attachments/:id (return 404 when no row). Delete POST /api/gw/attachments (cloud-only multipart → Railway) or return 410. — ⚠ Renderer uploadAttachment thunk (chatActions.ts ~2462-2490) posts multipart here; must be removed/re-routed to /api/local/attachments/save-base64 first.
  - [ ] L769-870 `attachmentMessageMode, GET/POST/DELETE /api/gw/messages/:id/attachments, GET /api/gw/attachments/:id` — **collapse-to-local** _(high)_: Delete attachmentMessageMode and the ?storageMode hint. Always use the statements path (getAttachmentsByMessageId, linkAttachment, deleteLocalAttachmentLinks). GET attachments/:id returns the local row, or 404 when it is missing, instead of calling the cloud leg. — ⚠ Attachment fetch and link are used by the kept image-attachment flows. Today any message whose conversation row has storage_mode 'cloud' (the DB default) is sent to Railway.
  - [ ] L872-905 `POST /api/gw/attachments (multipart Railway upload)` — **delete-code** _(low)_: Delete the cloud-only multipart upload route (railway.passthrough plus mirror). Local attachments use the base64 prepare/save path. Also drop the express default import if nothing else uses it.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/lineageRoutes.ts`
  - [ ] L29-62 `registerLineageRoutes (/api/gw/conversations/:id/lineages, /lineages/:lineageId, /api/gw/projects/:id/recent-lineages)` — **keep-but-decouple** _(high)_: Local lineage reads are mounted under the /api/gw prefix outside gatewayRoutes.ts. If the gateway collapses to local-only or is renamed, move these three paths with it (or keep /api/gw as the local prefix). Also update the line 29 comment that mentions cloud routing. — ⚠ Branch/lineage views (useQueries useRecentLineages and lineage fetches) call these paths. A gateway prefix rename that skips this file breaks lineage navigation with 404s. Must stay registered before any /api/gw catch-all.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/providerAuthRoutes.ts`
  - [ ] L1,163,175,202-215 `openai/openrouter slot mapping in token routes, /api/provider-auth/models remote fetch` — **rewrite** _(high)_: At 163/175, special-case only 'openai'→codex. Remove registerTokenRoutes('openrouter') (186). Delete lines 11, 26-29, 49-66 and 202-215. Drop or rename the 'openrouter' provider entry. Change the mobile api.ts identity to /api/host/auth/status user.id at the same time. — ⚠ Mobile LAN UI identity and the provider status poll go through the openrouter token route. Removing it without changing mobile api.ts breaks mobile user resolution. Keep the openai, zai, bedrock and openrouter-byok routes unchanged. [verified-changed: The mobile UI uses GET /api/provider-auth/openrouter/token (no userId) as its identity source: readRuntimeAppSession at api.ts:58-61, called by getRuntimeAppAuth at 365-372. If the route goes to token]
  - [ ] L11,26-29 `DEFAULT_REMOTE_API_BASE / getRemoteApiBase` — **delete-code** _(medium)_: Delete remote /models/openrouter fetch and base resolution. — ⚠ File also serves kept provider auth (Codex/bedrock lists).
  - [ ] L11-17,26-33,35-66,128-130,163,175,188,201-238 `DEFAULT_REMOTE_API_BASE, DEFAULT_OPENROUTER_MODELS, getRemoteApiBase, fetchOpenRouterModelsFromRemote, registerTokenRoutes('openrouter'), GET /api/provider-auth/models` — **rewrite** _(medium)_: Delete the remote base, the cloud model defaults and fetchOpenRouterModelsFromRemote. Remove the 'openrouter' slug from the union, the 'app' snapshot/disconnect branches and registerTokenRoutes('openrouter'). In /models, drop the app-token fetch and the 'openrouter' entry; add an 'openrouterbyok' entry (e.g. DEFAULT_OPENROUTER_BYOK_MODEL). — ⚠ The mobile LAN UI calls /api/provider-auth/models and /api/provider-auth/openrouter/token. Update it in the same change. Keep the openai (codex) slot branches.
  - [ ] L26-67,128-188,215-240 `getRemoteApiBase, fetchOpenRouterModelsFromRemote, registerTokenRoutes('openrouter'), /api/provider-auth/models openrouter entry` — **delete-code** _(high)_: Delete the remote /models/openrouter fetch (26-67), the 'openrouter' slug and its app-slot branches in registerTokenRoutes (128-175, line 188), and the resolve('app') remote merge plus the openrouter provider entry in /api/provider-auth/models. Keep the openai, zai, bedrock and openrouter-byok routes. — ⚠ The same function registers the kept Codex, Z.AI, Bedrock and BYOK token routes, and the mobile UI reads /api/provider-auth/models. Remove only the openrouter slug.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/subagentRoutes.ts`
  - [ ] L103-106 `OpenRouter subagent rejection` — **delete-code** _(low)_: Delete the `normalizeProviderRoute(request.provider) === 'openrouter'` guard, because the route no longer exists. If the user chooses strict rejection of unknown providers, replace it with an unknown-provider 400.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/__tests__/normalTurnCompaction.test.ts`
  - [ ] L69,83 `summaryRequest.railwayTurn; it.each([... 'openrouter'])` — **update-test** _(low)_: Rename railwayTurn to turnContext. In the it.each, replace 'openrouter' with 'openrouterbyok'; otherwise it would normalize to openaichatgpt and use the ChatGPT context length.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/__tests__/providerRouter.test.ts`
  - [ ] L33,37-49 `resolveContextLength('openrouter'); 'routes openrouter and lmstudio' test` — **update-test** _(low)_: Use 'openrouterbyok' or 'lmstudio' in the line 33 context-length case. Delete the openrouter half of the routing test (lines 42-49, which expects 'Sign in again to continue.'). Keep the lmstudio half.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/__tests__/subagentToolExecutor.test.ts`
  - [ ] L30,118-127 `service-tier it.each openrouter row; openrouter->openaichatgpt redirect test` — **update-test** _(low)_: Remove the ['openrouter','priority','priority'] row and the 'cloud-model' redirect case, or retarget them to an unknown provider.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/__tests__/toolLoopService.test.ts`
  - [ ] L408,1489 `railwayTurn?.previousResponseId; run({ provider: 'openrouter' })` — **update-test** _(low)_: Rename railwayTurn to turnContext at 408. At 1489, use 'openrouterbyok' or 'lmstudio' as the non-Codex provider.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/appAuthTokenManager.ts`
  - [ ] `createAppAuthTokenManager, AppAuthTokenManager, AppToken` — **delete-file** _(low)_: Delete the file. It is the Railway adapter that resolves the Supabase 'app' slot. Its only consumers are railwayClient.ts, gatewayRoutes.ts (deps.auth, line 273), providerRouter.ts (appAuth, line 47), openRouterProvider.ts (lines 7, 146, 470-485) and headlessServer/index.ts (lines 33, 285).
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/chatOrchestrator.ts`
  - [ ] L21,84-87,854,873,1698-1717 `ChatOrchestratorDeps.cloudChatEnabled, isCloudRoute, sink selection` — **collapse-to-local** _(high)_: Remove cloudChatEnabled dep/field/ctor assignment and isCloudRoute; always `const sink: MessageSink = new TreeMessageSink(sinkDeps)`; drop CloudMirrorSink import. — ⚠ runMessage is the main loop for all kept providers; sink/runSink wiring (fork materialization, D1 error rows) must be preserved exactly. [verified]
  - [ ] L27,2276-2292,2330-2334 `RailwayAppAuthError / requiresReauthentication / reauth_required emit` — **delete-code** _(medium)_: Delete RailwayAppAuthError import, the session_expired+sign_in envelope override and the `reauth_required` safeEmit (only triggered by Railway app-session errors). Keep classifyRunError path for Codex AuthFailure. — ⚠ Error-envelope path is shared by all providers; only remove the Railway-specific branch. Pairs with removing reauth_required from HeadlessStreamEvent and renderer handlers.
  - [ ] L27,2118-2120,2276-2290 `RailwayAppAuthError import, relayFreeTierEvents: isCloudRoute, session_expired sign_in envelope` — **delete-code** _(medium)_: Delete the RailwayAppAuthError import, the relayFreeTierEvents arg, and the requiresReauthentication / session_expired 'Sign in' override. Keep the classifyRunError envelope path as it is. — ⚠ The outer catch builds the error bubbles for every provider. Remove only the Railway reauth branch.
  - [ ] L27,776-779,1698-1703,2276-2293 `RailwayAppAuthError import/requiresReauthentication; queued-image provider allowlist; isCloudRoute` — **delete-code** _(medium)_: Delete the RailwayAppAuthError import and the requiresReauthentication override at 2280-2293; use the classifier envelope as-is. At 777, the allowlist becomes ['openaichatgpt'] and the error text drops 'OpenRouter'. isCloudRoute (1703) becomes false and is removed with the cloud-mirror work. — ⚠ chatOrchestrator is shared with every local run. Lines 1703 and 2120 (relayFreeTierEvents) overlap the cloud-mirror/free-tier areas, so do them in the same change.
  - [ ] L27,2276-2293 `RailwayAppAuthError import; requiresReauthentication session_expired override` — **delete-code** _(medium)_: Delete the RailwayAppAuthError import at line 27, the `requiresReauthentication` const at 2280, and the `if (requiresReauthentication ...)` envelope override at 2286-2293. Keep classifyRunError and the rest of the shared catch path. — ⚠ This catch block handles failures for every provider. Remove only the Railway override; the D1 error-row persistence after it must stay.
  - [ ] L776-779 `queued attachment provider allowlist ['openaichatgpt','openrouter']` — **rewrite** _(low)_: Drop 'openrouter' from the allowlist so it reads normalizeProviderRoute(...) === 'openaichatgpt', and update the error text (it currently mentions OpenRouter).
  - [ ] L776-778,1698-1703,2117-2120 `queued-attachment provider check; isCloudRoute; relayFreeTierEvents: isCloudRoute` — **delete-code** _(medium)_: Drop 'openrouter' from the queued-attachment allowlist (777) and from its error text (778). Delete the isCloudRoute computation (1703; sink selection becomes always TreeMessageSink) and the relayFreeTierEvents field (2119-2120). — ⚠ The sink selection is shared by every local run. Always choosing TreeMessageSink matches the current flag-off behaviour.
  - [ ] L2118-2120 `toolLoop input relayFreeTierEvents` — **delete-code** _(low)_: Delete `relayFreeTierEvents: isCloudRoute` and its comment.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/cloudMirrorService.ts`
  - [ ] `createCloudMirrorService, CloudEntityKind` — **delete-file** _(low)_: Delete the file. Its only consumers are index.ts and the gatewayRoutes type import.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/messageSink.ts`
  - [ ] L4,29-34,128-226 `CloudMirrorSink, AssistantMessageDraft.providerMessageId` — **delete-code** _(medium)_: Delete CloudMirrorSink class and providerMessageId draft field. Change ProviderToolCall import to the extracted provider types module. — ⚠ TreeMessageSink (shared by all local providers + Claude backend) must be untouched; only the duplicate cloud class goes.
  - [ ] L4 `ProviderToolCall import` — **rename** _(high)_: Re-point the import to '../providers/providerTypes.js'. TreeMessageSink is kept. — ⚠ TreeMessageSink persists every local run.
  - [ ] L29-34,143-226 `AssistantMessageDraft.providerMessageId, CloudMirrorSink` — **delete-code** _(medium)_: Delete the CloudMirrorSink class and its docblock (143-226), and the providerMessageId draft field (29-34). TreeMessageSink and the transcript sinks are unchanged. — ⚠ TreeMessageSink is in the same file and is the sink for every kept provider. Delete only the cloud class.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/multiCallExecutor.ts`
  - [ ] L2 `ProviderToolCall import` — **rewrite** _(low)_: Point type import at extracted providers/providerTypes.ts instead of openRouterProvider.ts.
  - [ ] L2 `ProviderToolCall import` — **rename** _(medium)_: Re-point the import to '../providers/providerTypes.js'. — ⚠ Kept tool executor. Type-only import.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/providerRouter.ts`
  - [ ] L10-18,20,38-39,45-48,52-60 `ProviderRoute 'openrouter', OpenRouterProvider, appAuth dep, normalizeProviderRoute` — **rewrite** _(high)_: Remove 'openrouter' from ProviderRoute and from the providers map. Drop the OpenRouterProvider and AppAuthTokenManager imports and the appAuth dep; import the types from providers/providerTypes.ts. Normalize the legacy 'openrouter' string to 'openrouterbyok' (same slug namespace). Update providerRouter.test.ts 33 and 38-50. — ⚠ normalizeProviderRoute decides routing for chat, subagents, compaction and admission. If 'openrouter' is aliased to byok, users without a BYOK key get a missing-key error rather than a Railway call. Every '=== openrouter' comparison becomes a TS2367 compile error and must be removed. [verified-changed: The lines are correct. The scout left the legacy normalization undecided; this sets it. Several places still emit the bare 'openrouter' string: the mobile UI (App.tsx 94/1482, types.ts 126), ephemeral]
  - [ ] L10-20,39,45-61 `ProviderRoute, normalizeProviderRoute, ProviderRouterDeps.appAuth, ProviderRouter.providers.openrouter` — **rewrite** _(high)_: Remove 'openrouter' from the ProviderRoute union and delete line 39. Remove the OpenRouterProvider import and the providers.openrouter entry. Remove the appAuth dep and the AppAuthTokenManager import. Import the types from ../providers/providerTypes.js. Unknown names keep the openaichatgpt fallback (see open question). — ⚠ normalizeProviderRoute is called by chatOrchestrator, toolLoopService, subagents, ephemeral routes and the index.ts middleware. A stale 'openrouter' string will now silently route to ChatGPT. [verified]
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/railwayClient.ts`
  - [ ] `RailwayClient/createRailwayClient/RailwayHttpError` — **delete-file** _(low)_: Delete file (Bearer-injecting Railway passthrough/request/stream; YGG_API_URL/VITE_API_URL/webdrasil base). Only consumers: gatewayRoutes, cloudProxyRoutes, index.ts.
  - [ ] L7,64-68 `DEFAULT_REMOTE_API_BASE (YGG_API_URL/VITE_API_URL)` — **delete-file** _(medium)_: Delete railwayClient.ts and railwayClient.test.ts. — ⚠ Many cloud modules import it; delete last in P2.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/subagentRunService.ts`
  - [ ] L15,851 `ProviderToolCall/ProviderToolDefinition import; railwaySessionId: `subagent:${runId}`` — **rename** _(high)_: Import the types from ../providers/providerTypes.js. Rename railwaySessionId to providerSessionId at line 851 to match toolLoopService. — ⚠ This value is the Codex prompt-cache and session key for subagents. If the rename is missed on one side, subagents share the parent conversation's session key.
  - [ ] L851 `railwaySessionId: `subagent:${runId}`` — **rename** _(high)_: Rename to turnSessionId (or another name chosen alongside toolLoopService). The value keys the Codex prompt cache for each subagent run. — ⚠ If this is missed, subagent Codex runs share the parent conversation's cache/session key, which silently changes caching and session behaviour.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/subagentToolExecutor.ts`
  - [ ] L6,136,143,192,223 `openrouter→openaichatgpt fallback, authSessionId slot` — **rewrite** _(medium)_: Drop `inheritedProvider === 'openrouter'` remaps (route no longer exists); authSessionId: context.authSessions?.codex when provider==='openaichatgpt'. Update import path. — ⚠ If normalizeProviderRoute maps legacy 'openrouter' to default, saved subagent defaultProvider='openrouter' must still resolve to a working provider.
  - [ ] L6,136,143-144,192,223 `ProviderToolCall import; inheritedProvider==='openrouter' remaps; authSessions app slot` — **collapse-to-local** _(medium)_: Import ProviderToolCall from providerTypes.js. Delete the 'openrouter'→openaichatgpt remaps (136, 223) and the DEFAULT_SUBAGENT_MODEL special case (143). At line 192, use authSessions?.codex only when provider === 'openaichatgpt'. — ⚠ The subagent provider and model resolution is kept for every provider. After 'openrouter' leaves ProviderRoute these comparisons are TS no-overlap errors.
  - [ ] L135-145,192,222-223 `buildSubagentRequest / buildResumeRequest openrouter->openaichatgpt redirect; authSessions app slot` — **delete-code** _(medium)_: Drop the `inheritedProvider === 'openrouter' ? 'openaichatgpt'` redirects (136, 143, 223). At line 192, use authSessions?.codex only when provider==='openaichatgpt', otherwise undefined; drop the 'app' slot. — ⚠ Subagents are a kept feature. The authSessionId slot selection is tied to the P3 removal of the auth 'app' slot.
  - [ ] L136,143,192,223 `inheritedProvider === 'openrouter' remaps and app auth slot` — **rewrite** _(medium)_: Delete the openrouter-to-openaichatgpt remaps (136, 223) and the DEFAULT_SUBAGENT_MODEL override (143). Line 192 becomes authSessionId: context.authSessions?.codex when the provider is openaichatgpt. — ⚠ This code resolves the subagent provider and model for every kept provider; keep providerDefault as it is.
  - [ ] L192 `authSessionId: context.authSessions?.[provider==='openrouter'?'app':'codex']` — **rewrite** _(medium)_: Set authSessionId to context.authSessions?.codex when provider==='openaichatgpt' and undefined otherwise. Today every non-openrouter provider gets the codex session id. — ⚠ Child Codex runs depend on inheriting the parent session reference.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/toolLoopService.ts`
  - [ ] L7-14,15,262-272,941-965,1265 `provider type import; railwaySessionId; relayFreeTierEvents; providerInput.railwayTurn build; auth slot select` — **rename** _(high)_: Import from ../providers/providerTypes.js. Rename railwaySessionId to providerSessionId and railwayTurn to turnContext. Build it only for 'openaichatgpt'. Drop storageMode and relayFreeTierEvents (269-272, 955-956). At line 1265, drop the 'openrouter' to 'app' slot. — ⚠ This is the main loop for every kept provider. turnContext still carries conversationId, attachments, reasoning, serviceTier and imageConfig for Codex. Rename it everywhere; do not delete it. [verified]
  - [ ] L8-15,941-966 `providerInput.railwayTurn` — **rename** _(high)_: Rename railwayTurn to turnContext and railwaySessionId to turnSessionId, and import the types and attachPartialOutput from a new providers/providerTypes.ts. Build turnContext only when route==='openaichatgpt'. Keep conversationId, attachmentsBase64, imageConfig, reasoningConfig, serviceTier, promptCacheRetention and allowCommentaryFallbackText. Drop the OpenRouter-only fields and relayFreeTierEvents. — ⚠ The Codex prompt-cache/session key (conversationId, or subagent:<runId> through railwaySessionId), images, reasoning effort and priority tier all flow through this object. Missing one of these silently degrades the kept ChatGPT provider; there is no compile error if the field is optional. [verified-changed: The import block from openRouterProvider is lines 7-14; line 15 is the providerRouter import. I checked which fields are actually read. openaiChatgptProvider/codex read conversationId, runId, attachme]
  - [ ] L70,247,1264-1267 `authSessions {app,codex}, slot resolution in run()` — **rewrite** _(high)_: Drop the 'app' key from authSessions (type becomes {codex}). The slot is 'codex' only when route==='openaichatgpt'. Remove getAuthManager().snapshot('app'). The relayFreeTierEvents changes belong to the cloud-openrouter area. — ⚠ authSessionId threading pins Codex credentials across compaction and subagents, so keep the codex path exactly. The file is shared with all local providers. [verified]
  - [ ] L262-263 `ToolLoopRunInput.railwaySessionId` — **rename** _(medium)_: Rename to providerSessionKey (codex session/prompt-cache key override); update use at line 944. — ⚠ Subagents rely on it to isolate their Codex prompt-cache key (`subagent:<runId>`).
  - [ ] L262-272,1243,1458-1460,1265 `railwaySessionId, relayFreeTierEvents input, providerMessageId, auth slot route==='openrouter'` — **rewrite** _(medium)_: Rename railwaySessionId to turnSessionId. Delete the relayFreeTierEvents field (267-272) and the providerMessageId fields at 1243 and 1460. Change line 1265 to const slot = route === 'openaichatgpt' ? 'codex' : null. — ⚠ The slot assignment drives authSessionId for Codex; the codex mapping must be kept.
  - [ ] L266-272 `ToolLoopRunInput.relayFreeTierEvents` — **delete-code** _(low)_: Delete field + doc comment.
  - [ ] L955 `turn storageMode:'local'` — **delete-code** _(low)_: Remove storageMode from provider turn input together with openRouterProvider (its only consumer, line 30/517).
  - [ ] L1242-1243,1457-1460 `providerMessageId adoption (Railway id)` — **delete-code** _(low)_: Delete the providerMessageId fields and their Phase 4 comments at both persist sites. Only CloudMirrorSink (messageSink.ts:177) uses them; TreeMessageSink ignores them. Remove the providerMessageId?: field from messageSink.ts:34 together with CloudMirrorSink.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/ui/mobile/src/App.tsx`
  - [ ] L388,458,657-663,1108,1401,1505 `openRouterConnected state/refreshOpenRouterStatus` — **delete-code** _(medium)_: Remove the cloud 'openrouter' connected state, poll and gate. Keep the zai, openai and bedrock status polls. — ⚠ Shares the provider-status flow with the kept providers in the mobile UI.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/ui/mobile/src/api.ts`
  - [ ] L58-61,353-355,365-372,467-478 `readRuntimeAppSession, getOpenRouterTokenStatus, getRuntimeAppAuth, storeOpenRouterToken` — **rewrite** _(high)_: Read the runtime identity from /api/host/auth/status user.id instead of /api/provider-auth/openrouter/token. Delete the openrouter token status/store/clear helpers and drop 'openrouter' from the clearProviderToken union. — ⚠ Mobile LAN UI identity breaks if the openrouter token route is removed first.
- [ ] `ygg-chat/client/ygg-chat-r/server/proxyGateway.ts`
  - [ ] L7-15,68,257-285,562-577,1266-1268,1364-1385 `SupabaseCredentialVault, CredentialSource 'supabase', hasSupabaseConfig, ProviderCredentialRecord, mapRecordToCredentials` — **delete-code** _(low)_: Delete SupabaseCredentialVault (already a memory-fallback stub), the 'supabase' CredentialSource value and its createCredentialVault branch (SUPABASE_URL/SERVICE_ROLE_KEY env), and the dead ProviderCredentialRecord/mapRecordToCredentials. Keep the file/memory vaults and registerProxyRoutes.
  - [ ] L564,1266-1268 `hasSupabaseConfig (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY)` — **delete-file** _(medium)_: proxyGateway.ts is server-side Supabase/Redis cloud gateway; delete with its registration. — ⚠ Confirm no local route depends on it.
- [ ] `ygg-chat/client/ygg-chat-r/server/routes/syncStorageRoutes.ts`
  - [ ] L31-72,246-720,976-1100 `/api/sync/user|project|conversation|message|attachment|provider-cost|batch, ensure*Exists stubs` — **delete-code** _(medium)_: Delete ensure*Exists (31-73), generated-image helpers (75-244), /api/sync/* routes 246-720 and 976-1129. Keep /api/local/attachments/* (722-975). Delete src/lib/localMirror.ts and its callers first. Delete server/__tests__/syncStorageRoutes.test.ts (it only tests /api/sync/message). — ⚠ chatActions deleteMessage:1392 calls DELETE /sync/message after the gw delete. That call is redundant because /api/app/messages/:id already deletes with lineage repair, and it is fire-and-forget, so a 404 is harmless. /api/sync/stats lives in analyticsRoutes.ts and is unaffected. [verified-changed: The line ranges are incomplete. The ensure* helpers run to 73. The generated-image helpers (75-244: getGeneratedImageExtension, the short-id helpers, extractGeneratedImageFilePathsFromContentBlocks, s]
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/chatActions.ts`
  - [ ] L104-105 `getRemoteApiBase` — **delete-code** _(medium)_: Delete getRemoteApiBase (VITE_API_URL || Railway) and its cloud-sync callers. — ⚠ Check callers in chatActions are cloud-only paths.
- [ ] `ygg-chat/client/ygg-chat-r/src/utils/api.ts`
  - [ ] L10 `API_BASE (VITE_API_URL || localhost:3001)` — **delete-code** _(medium)_: Delete API_BASE; its consumers are cloud apiCall, publicApiCall (browser app-store fallback) and chatActions remoteOrigin. Without .env it silently points at nonexistent http://localhost:3001. — ⚠ publicApiCall and attachment resolution consume it; rewrite those first (see chatActions 507, appStore.ts 274).
  - [ ] L880-952 `createStreamingRequest` — **delete-code** _(low)_: Only live caller is iframeBridge streamCloudEphemeral -> /api/cloud/generate/ephemeral (Railway). Delete once iframeBridge always uses local headless generation.
- [ ] `ygg-chat/client/ygg-chat-r/src/utils/iframeBridge.ts`
  - [ ] L9,29-65,350-351,392-460,590,600-660 `streamCloudEphemeral, resolveGenerationProvider 'openrouter' default, legacy REQUEST_GENERATION comment` — **collapse-to-local** _(medium)_: Custom-tool REQUEST_GENERATION: always streamLocalHeadless (POST /api/app/conversations + /api/conversations/:id/messages); delete streamCloudEphemeral (/api/cloud/generate/ephemeral) and commented legacy block; slash-model/default provider -> 'openrouterbyok'; default model reconsidered. — ⚠ Custom tool UIs relying on implicit 'openrouter' get BYOK (needs user key) instead of free cloud.
- [ ] `ygg-chat/shared/headlessApi.ts`
  - [ ] L402-405 `HeadlessStreamEvent free_generations_update | generation_limit_reached | reauth_required` — **delete-code** _(medium)_: Remove the three union members (+ 'Relayed from Railway' comment). runSnapshotProjector/runSessionRegistry/childRunSnapshot/stream/* have no special handling, so no server change beyond the type. — ⚠ Renderer sseProjection.ts, mainChatClient.ts, chatTypes.ts, Chat.tsx, api.ts, lib/auth/managed.ts switch on these; must change in the same PR or TS breaks.
- [ ] `ygg-chat/shared/runStatisticsMetadata.ts`
  - [ ] `mergeLocalRunMetadata, mergeLocalUsageBlocks` — **delete-file** _(low)_: These helpers are used only by the gatewayRoutes cloud tree enrichment and by cloudMirrorService, so they are dead once both go. Delete the file and src/features/chats/runStatisticsMetadata.test.ts.

### P3 — Supabase app session & login removal (server + Electron) (109)

- [ ] `ygg-chat/client/ygg-chat-r/electron/esbuild.main.mjs`
  - [ ] L10-12,21 `publicEnv loadEnv('VITE_SUPABASE_') / authDefines` — **delete-code** _(medium)_: Delete loadEnv('VITE_SUPABASE_'), authDefines and `define: authDefines` (and the vite loadEnv import if it becomes unused). Do this in the same change that removes the Supabase refresh adapter in server/auth/refreshAdapters.ts:17-18. — ⚠ If the define goes while refreshAdapters still reads process.env.VITE_SUPABASE_URL, it resolves to undefined at runtime. Codex credential refresh in the same module has to keep working.
- [ ] `ygg-chat/client/ygg-chat-r/electron/main.ts`
  - [ ] L5-6 `imports from server/auth/runtime.js and server/auth/appLogin.js` — **delete-code** _(high)_: Delete the line-6 appLogin import together with the cancelAppLogin calls at 687-689, 1233 and 1343. Trim line 5 to getAuthManager, publicAuthState, disconnectAuth, importLegacyRenderer. Drop enableLocalLogin only together with auth:login (1223-1229). importLegacyRenderer stays for Codex legacy-token import. — ⚠ runtime.ts owns Codex credentials. Keep getAuthManager (1106 resume check, 1274, 2485, 2513), publicAuthState, disconnectAuth('codex') and importLegacyRenderer (codex legacy migration). Missing any cancelAppLogin call site breaks tsc for main. [verified-changed: The appLogin import also feeds cancelAppLogin call sites the scout did not list: 687, 689 (did-start-navigation/render-process-gone), 1233 (auth:logout) and 1343 (storage:clear). Deleting the import a]
  - [ ] L5-6 `imports from server/auth/runtime.js and appLogin.js` — **rewrite** _(low)_: Remove the appLogin.js import entirely. From runtime.js keep getAuthManager, publicAuthState and disconnectAuth (codex). Drop importLegacyRenderer and enableLocalLogin.
  - [ ] L5-6,340,681-689,982-996,1012-1018,1024-1042 `appLogin imports, PROTOCOL yggchat, cancelAppLogin listeners, open-url, syncAuthenticatedProfile, handleOAuthCallback` — **delete-code** _(medium)_: Delete the appLogin import and enableLocalLogin. Delete setAsDefaultProtocolClient(yggchat), the open-url handler, the yggchat:// lookup in second-instance (1012-1018), syncAuthenticatedProfile, handleOAuthCallback and the cancelAppLogin listeners (686-689). KEEP requestSingleInstanceLock and the window-focus part of second-instance. — ⚠ yggchat:// is used only for the Supabase callback (appLogin.ts:24/44). The single-instance lock and focus logic share this block and must stay.
  - [ ] L339-340 `PROTOCOL = 'yggchat'` — **delete-code** _(low)_: Delete the PROTOCOL constant and its 'Custom protocol for OAuth callbacks' comment. It is used only for the Supabase login callback (lines 985, 988, 1015, 2229). Lines 341-343 (UPDATE_FEED_BASE_URL) belong to the P1 updater work.
  - [ ] L683-689 `createWindow did-start-navigation / render-process-gone → cancelAppLogin` — **delete-code** _(low)_: Delete the two listeners that only call cancelAppLogin(). Keep installNativeHostSession(window.webContents.session) at line 683.
  - [ ] L685-689 `did-start-navigation / render-process-gone cancelAppLogin` — **delete-code** _(low)_: Delete both mainWindow listeners whose only purpose is to cancel the pending app login reservation.
  - [ ] L982-995 `setAsDefaultProtocolClient / app.on('open-url')` — **delete-code** _(low)_: Delete the yggchat:// registration and the macOS open-url handler (only used for the Supabase app-login callback; Codex uses the 127.0.0.1:1455 loopback, MCP uses a loopback redirectUri). Optionally call app.removeAsDefaultProtocolClient('yggchat') once to clean old OS registrations.
  - [ ] L982-994,1013-1018 `setAsDefaultProtocolClient(PROTOCOL) / open-url / second-instance deep link` — **delete-code** _(medium)_: Delete yggchat:// registration (982-989), the macOS open-url handler (991-994), the second-instance URL lookup that calls handleOAuthCallback (1013-1018), and the PROTOCOL const (339-340) once 2229 is gone. Keep the single-instance lock and window restore/focus. — ⚠ yggchat:// is used only by appLogin.ts:24 (Supabase redirect). The single-instance lock and focus logic in the same block must stay.
  - [ ] L997-1023 `second-instance handler` — **collapse-to-local** _(medium)_: Keep requestSingleInstanceLock and the restore/show/focus of mainWindow. Delete the commandLine.find(`${PROTOCOL}://`) + handleOAuthCallback part. — ⚠ The single-instance lock also protects the local server port and DB. Only the URL parsing may go.
  - [ ] L1013-1018 `second-instance deep-link URL parsing` — **keep-but-decouple** _(medium)_: In the second-instance handler, keep the single-instance lock and the window focus/restore. Delete only the commandLine.find(yggchat://) and handleOAuthCallback call. — ⚠ The single-instance lock protects the local server port and DB, so it must not be removed with the deep-link code.
  - [ ] L1025-1042 `syncAuthenticatedProfile / handleOAuthCallback` — **delete-code** _(high)_: Delete both. syncAuthenticatedProfile POSTs /api/local/users/merge to move default local user a7c485cb-… into the Supabase user id. handleOAuthCallback calls completeAppCallback and sends auth:changed/auth:login-error. — ⚠ Users who ever signed in had their LOCAL SQLite data re-parented to their Supabase user id. Without the app slot the renderer identity falls back to a7c485cb-…, hiding their local chats unless P3/P5 pins the identity or reverse-merges. [verified]
  - [ ] L1100-1106 `managed_auth Conf guard / powerMonitor resume auth check` — **keep-but-decouple** _(medium)_: Keep. The managed_auth_v1 durability guard and the resume getAuthManager().check() now serve only the codex slot. Make sure the auth manager no longer tries to refresh the app slot via supabaseConfig (server/auth/refreshAdapters, P3). — ⚠ If the app-slot refresh adapter remains while Supabase env is gone, check() could set configuration_error and raise UI notices.
  - [ ] L1222-1235 `auth:login / auth:logout IPC` — **delete-code** _(medium)_: Delete auth:login (enableLocalLogin) and auth:logout (cancelAppLogin plus disconnectAuth('app')), and the stale Phase-4 Supabase comment at 1236-1242. Remove login/logout from preload.ts:27-28 and vite-env.d.ts:43-44 together with the AuthProvider login/logout. — ⚠ AuthContext.tsx:241 calls provider.login through managed.ts:51. Remove the renderer call first or in the same change.
  - [ ] L1222-1243 `auth:login / auth:logout IPC + Supabase token-refresher comment` — **delete-code** _(medium)_: Delete auth:login (enableLocalLogin gate, 'Use Google or GitHub sign-in') and auth:logout (cancelAppLogin + disconnectAuth('app')) along with the stale Phase-4 Supabase-refresher comment. Keep the authHandle helper (1244-1249), which still guards status/check/subscribe/openExternal. — ⚠ managed.ts:51-52 and the browser-client transport call login/logout. Remove those (and the /login gate in App.tsx) in the same change, or local users get stuck at a login screen.
  - [ ] L1222-1242 `auth:login, auth:logout IPC + Phase 4 token-owner comment` — **delete-code** _(medium)_: Delete the auth:login handler (enableLocalLogin), the auth:logout handler (cancelAppLogin plus disconnectAuth('app')) and the stale 'server as sole Supabase-token refresher' comment above authHandle. Keep the authHandle() helper (lines 1243-1248), because Codex and secrets IPC use it. — ⚠ Renderer callers in src/lib/auth/managed.ts (login/logout via hostAuthTransport) must be removed in the same change, or ManagedAuthProvider.login/logout reject.
  - [ ] L1237-1248 `authHandle + stale Supabase token-refresher comment` — **rewrite** _(medium)_: Replace the 'server as sole Supabase-token refresher / AppAuthTokenManager / gateway.tokenOwner' comment with an accurate one. Optionally rename authHandle→trustedMainFrameHandle, since it now guards secrets/openExternal, not auth. — ⚠ Renaming breaks src/containers/Settings.credentials.test.ts, which greps for `authHandle('secrets:…`. The main-frame trust check must be preserved.
  - [ ] L1268-1285 `auth:status/start/code/cancel/migrate/check/subscribe IPC` — **keep-but-decouple** _(high)_: Delete auth:start, auth:code, auth:cancel and loginOwner (Supabase Google/GitHub + railway OOB). Keep auth:status/check/subscribe for the Codex snapshot, with publicAuthState returning a fixed local user. Limit auth:migrate to the codex legacy key, or delete it. — ⚠ ManagedAuthProvider.initialize and the Codex settings UI depend on status/subscribe/check for the codex slot. Removing them wholesale breaks ChatGPT sign-in status. [verified]
  - [ ] L1268-1285 `auth:status/start/code/cancel/migrate/check/subscribe IPC` — **rewrite** _(high)_: Delete auth:start, auth:code, auth:cancel and loginOwner (1269-1272). Keep auth:status, auth:check and auth:subscribe. Keep auth:migrate but pass only {codex}. Alternatively, delete it and make initializeAuth call owner.start() unconditionally. Update preload.ts:16-19 and vite-env.d.ts:38-41 in lockstep. — ⚠ managed.ts:37 calls auth.migrate on every Electron boot. If the IPC goes, that call throws and the app has no user. Without start(), Codex tokens refresh only lazily. [verified-changed: auth:migrate is not app-only. It also hands off the legacy renderer Codex tokens (openai_chatgpt_tokens) through importLegacyRenderer. It is also the only call to getAuthManager().start() on installs ]
  - [ ] L1287 `isAuthStorageKey` — **keep-but-decouple** _(low)_: Keep the guard for managed_auth_v1/managed_auth_migration_v1/openai_chatgpt_tokens. 'auth_session' (legacy Supabase session) may stay as a harmless deny entry or be removed.
  - [ ] L1341-1345 `storage:clear handler` — **rewrite** _(low)_: Drop cancelAppLogin() and disconnectAuth('app'). Keep disconnectAuth('codex') + clearStore. No renderer caller of electronAPI.storage.clear was found, so the handler (and the preload/vite-env entries) could be deleted.
  - [ ] L1342-1345 `storage:clear cancelAppLogin/disconnectAuth('app')` — **delete-code** _(low)_: Remove cancelAppLogin() and disconnectAuth('app') from storage:clear. Keep disconnectAuth('codex') and clearStore().
  - [ ] L1342-1345 `storage:clear handler` — **rewrite** _(low)_: Remove cancelAppLogin() and disconnectAuth('app'). Keep disconnectAuth('codex') if 'clear all storage' should still sign out of ChatGPT.
  - [ ] L1342-1344 `storage:clear cancelAppLogin/disconnectAuth('app')` — **delete-code** _(low)_: Remove cancelAppLogin() and disconnectAuth('app'). Keep disconnectAuth('codex').
  - [ ] L1451-1461 `auth:openExternal IPC` — **rename** _(high)_: Rename to 'shell:openExternal' (keep the authHandle-style mainWindow/main-frame check; allow only http:/https:). Expose it as electronAPI.shell.openExternal. Update MarkdownLink:88-92, TitleBar:179-180, Chat:5078-5080, Settings:996-998/1413-1414/2425-2426/4027, HtmlIframeRegistry:761-762, McpAppIframe:378-379, vite-env.d.ts and MarkdownLink.test. — ⚠ Shared with kept features: Codex OAuth (Settings 2426), MCP app iframes, HTML iframes, markdown links, TitleBar, remote/shared-browser URL buttons. A missed caller silently falls back to window.open, which opens an Electron BrowserWindow, or does nothing. [verified-changed: Lines and the rename action are correct, but the caller list is incomplete. Missed callers: HtmlIframeRegistry.tsx:761-762 and McpAppIframe.tsx:378-379 (local MCP app/HTML iframe link opening), Settin]
  - [ ] L1451-1461 `auth:openExternal IPC` — **keep-but-decouple** _(high)_: Keep the handler. It is a generic shell.openExternal used by about 12 renderer sites (MarkdownLink, TitleBar, Settings Codex authUrl, McpAppIframe, HtmlIframeRegistry, Chat, etc.). Optionally rename it to shell:openExternal, changing preload.ts and vite-env.d.ts in lockstep. — ⚠ Deleting it as 'auth' code would break link opening, the Codex OAuth browser launch and the LAN URL buttons. [verified]
  - [ ] L2200-2270 `auth:openOAuthWindow IPC` — **delete-code** _(low)_: Delete the auth:openOAuthWindow handler (it only intercepts yggchat:// and calls handleOAuthCallback). It has no renderer callers. Also remove openOAuthWindow/onOAuthCallback from preload.ts:31-38 and vite-env.d.ts:47-48. The 'oauth:callback' channel is never sent.
  - [ ] L2201-2271 `auth:openOAuthWindow IPC` — **delete-code** _(low)_: Delete the modal OAuth BrowserWindow handler. It only intercepts yggchat:// redirects and calls handleOAuthCallback. No renderer caller exists besides the preload/vite-env declarations.
- [ ] `ygg-chat/client/ygg-chat-r/electron/preload.ts`
  - [ ] L9-39 `electronAPI.auth` — **rewrite** _(high)_: Remove onLoginError, start, code, cancel, login, logout, openOAuthWindow and onOAuthCallback (no main sender exists for 'oauth:callback'). Keep status/check/onChanged (codex), and migrate if retained. Move openExternal to the shell namespace (line 94) as shell:openExternal. — ⚠ src/lib/auth/transport.ts returns window.electronAPI.auth verbatim as the transport, so the renderer types/consumers must change at the same time. [verified]
  - [ ] L9-38 `electronAPI.auth bridge` — **rewrite** _(medium)_: Remove onLoginError, start, code, cancel, login, logout, openOAuthWindow and onOAuthCallback. Keep status, check, onChanged/subscribe, openExternal and migrate (codex-only, if kept). Mirror the change in src/vite-env.d.ts:35-48 and transport.ts:30-33. — ⚠ openExternal and status/onChanged are used by kept features (links, Codex OAuth, identity).
- [ ] `ygg-chat/client/ygg-chat-r/server/__tests__/appLoginOwnership.test.ts`
  - [ ] `appLogin ownership tests` — **delete-file** _(low)_: Delete. It tests startAppLogin/completeAppCallback/cancelAppLogin from server/auth/appLogin.ts, which is removed with the Supabase/Railway login.
- [ ] `ygg-chat/client/ygg-chat-r/server/auth/appLogin.ts`
  - [ ] `startAppLogin/cancelAppLogin/completeAppCallback/completeAppCode/railway()` — **delete-file** _(medium)_: Delete the whole file. It holds the Supabase /auth/v1/authorize Google/GitHub flow, the yggchat:// deep-link callback and the Railway OOB /api/auth/oob/exchange (webdrasil default). Codex login does not use it. — ⚠ Imported by electron/main.ts (lines 6, 687, 689, 1035, 1233, 1270-1272, 1343) and server/localServer.ts (lines 17, 2149). All of those imports must be removed in the same change or the build breaks.
  - [ ] L3,8 `railway() (process.env.VITE_API_URL/YGG_API_URL)` — **delete-file** _(medium)_: Delete appLogin.ts (Supabase/Railway login + yggchat:// callback). — ⚠ Wired into localServer/electron deep-link handlers; remove registrations in P3.
- [ ] `ygg-chat/client/ygg-chat-r/server/auth/authMigration.ts`
  - [ ] L22-35,48-57,75-84 `candidate/migrateOAuthCredentials/importRendererLegacyCredentials app slot` — **rewrite** _(medium)_: Restrict the slot loops to codex. Drop the auth_session and 'openrouter' legacy-row app import and the app candidate branches. Keep the legacy row cleanup (64-66) and the Codex logic unchanged. — ⚠ Codex legacy migration shares these functions. authMigration.test.ts covers only Codex, so the tests should stay green.
  - [ ] L23,26-27,31,35,45,48-52,75 `candidate, migrateOAuthCredentials, importRendererLegacyCredentials` — **rewrite** _(medium)_: Drop the 'app' slot: no auth_session or session.access_token candidate, and legacyRows filter keeps only 'openaichatgpt'. Loops over ['codex'] only. The electron-local-token/local-mode-token guard (line 24) can go. Alternative: delete the file if the user accepts that old installs reconnect ChatGPT (see open question). — ⚠ The legacy Codex import path (openai_chatgpt_tokens and provider_tokens rows) is still used by very old installs. The marker key managed_auth_migration_v1 must keep its semantics or migrated users get re-imported.
- [ ] `ygg-chat/client/ygg-chat-r/server/auth/authSessionManager.ts`
  - [ ] L29,184,191 `AuthFailure.errorType, check(), stop()` — **rewrite** _(high)_: Remove the app-slot branch in errorType (always 'provider_signin_required' for reauth). Change the ['app','codex'] iteration in check() and stop() to ['codex'] or derive it from the slot list. Keep the single-flight refresh logic unchanged. — ⚠ This is the shared Codex credential owner. Keep the logic change minimal: only the slot lists and errorType. managedAuthRecovery.test and authSessionManager.test exercise this file. [verified]
- [ ] `ygg-chat/client/ygg-chat-r/server/auth/credentialStore.ts`
  - [ ] L6,32 `PersistedAuth, SettingsCredentialStore.write` — **rewrite** _(medium)_: Remove 'app' from PersistedAuth. write() stops carrying current?.app forward, which drops the leftover Supabase refresh token from Conf managed_auth_v1 on the next codex write. Optional: delete legacy keys 'auth_session' and 'local_login_enabled' once at init. — ⚠ Changing the persisted shape must not throw on old records. read() validates only the requested slot, so an old 'app' field is harmless. Keep version:1.
- [ ] `ygg-chat/client/ygg-chat-r/server/auth/refreshAdapters.ts`
  - [ ] L16-21,24-29 `supabaseConfig (process.env.VITE_SUPABASE_*/SUPABASE_*) + app refresh` — **delete-code** _(high)_: Delete supabaseConfig and the slot==='app' branch. Make refreshCredential Codex-only, using metadata chatgpt_account_id for userId at line 47. Keep jwtMetadata/expiryMs. Remove the 'app' consumers in runtime.ts/appLogin.ts and update refreshAdapters.test.ts:31-32 in the same change. — ⚠ This file owns Codex (openaichatgpt) token refresh, a kept provider. Also, runtime.ts loops over ['app','codex'] and must stop passing 'app'. [verified-changed: Line 47 also has an app branch (userId = payload.user?.id when slot==='app'). supabaseConfig is imported by server/auth/runtime.ts:7,44 (app sign-in validation) and server/auth/appLogin.ts:3, and mock]
  - [ ] L16-21,24-30,47,50 `supabaseConfig, refreshCredential app branch` — **rewrite** _(high)_: Delete supabaseConfig(). refreshCredential keeps only the OpenAI path (auth.openai.com/oauth/token, client_id app_EMoam...). userId always comes from the chatgpt_account_id claim. Drop the payload.user?.id and payload.user?.email app branches. Keep jwtMetadata/expiryMs. — ⚠ This file is shared with Codex token refresh. Removing the wrong branch breaks ChatGPT/Codex inference renewal. Keep the error classification (lines 37-44) unchanged. [verified]
- [ ] `ygg-chat/client/ygg-chat-r/server/auth/runtime.ts`
  - [ ] L7,14,24-25,40-52,57-70 `acceptAppSession, enableLocalLogin, publicAuthState, disconnectAuth, initializeAuth, getAuthManager` — **rewrite** _(high)_: Delete acceptAppSession, enableLocalLogin, local_login_enabled (25,59,63,68) and the supabaseConfig import. Loop at 14 becomes ['codex']. publicAuthState returns {app: signed_out stub or remove in lockstep, codex, user:{id:LOCAL_USER_ID,email:'local@localhost'}}. initializeAuth always calls owner.start(). Keep importLegacyRenderer for codex only. — ⚠ Shared Codex owner. If owner.start() is not made unconditional, the periodic Codex refresh silently stops. If `app` is dropped from the projection without changing managed.ts:18 and hostRuntimeRoutes.ts:43 in lockstep, auth bootstrap throws and the app shows no user. Also run INSERT OR IGNORE for the LOCAL user row at server start. [verified-changed: The proposed publicAuthState shape {codex,user} drops `app`. Three places read value.app: managed.ts:18 (value.app.version, which throws on undefined), hostRuntimeRoutes.ts:43 and the PublicAuthState ]
  - [ ] L57-71 `publicAuthState/enableLocalLogin/disconnectAuth` — **collapse-to-local** _(high)_: publicAuthState: always return user {id:'a7c485cb-99e7-4cf2-82a9-6e23b55cdfc3'} (drop the local_login_enabled gate and the app slot). Delete enableLocalLogin and disconnectAuth('app'). Keep the codex snapshot. — ⚠ Browser clients and managed.ts read the user from here. Today it is null until local login is enabled, which bounces them to /login.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/index.ts`
  - [ ] L338-341 `registerHostRuntimeRoutes community-user seed` — **keep-but-decouple** _(medium)_: Keep: seeding user a7c485cb-...'community-user' becomes the sole local identity. Coordinate with auth area if it renames 'community' or changes hostRuntimeRoutes' cloud sign-in/local-mode switching (hostRuntimeRoutes.ts:42-44). — ⚠ Renderer userId for all /api/gw queries comes from this identity; changing the id orphans existing local rows.
  - [ ] L338-341 `registerHostRuntimeRoutes ensureLocalUser callback` — **rewrite** _(high)_: Move INSERT OR IGNORE INTO users (LOCAL_USER_ID,'local-user') to unconditional server startup, before routes and initializeAuth, using the shared constant. Today the row exists only after a browser-client /api/host/auth/local call. — ⚠ foreign_keys=ON (localServer.ts:599). With a fixed user projected and no login step, inserting a project or conversation fails the FK if the row is missing.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/toolLoopService.ts`
  - [ ] L70,247,1266,1789 `authSessions { app; codex } type and default snapshot('app')` — **rewrite** _(high)_: Change the authSessions type to { codex: string } at lines 70 and 247. Drop `app: getAuthManager().snapshot('app')...` at 1266. Line 1789 passes the object through unchanged. — ⚠ The main loop for all providers calls snapshot('app') on every run. If P3 removes the 'app' slot first, every run throws.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/ui/mobile/src/api.ts`
  - [ ] L58-61,365-372 `readRuntimeAppSession, getRuntimeAppAuth` — **delete-code** _(low)_: Delete readRuntimeAppSession and the unused getRuntimeAppAuth. They read the Supabase app snapshot via /api/provider-auth/openrouter/token. Mobile picks its user from /api/local/users, which is kept.
- [ ] `ygg-chat/client/ygg-chat-r/server/localServer.ts`
  - [ ] L17,2147-2150 `cancelAppLogin import + shutdown call` — **delete-code** _(low)_: Remove the appLogin import and the cancelAppLogin() call on shutdown. Keep stopAuth() (line 2148, Codex owner) and stopOpenAiOAuth().
- [ ] `ygg-chat/client/ygg-chat-r/server/routes/hostRuntimeRoutes.ts`
  - [ ] L9,14,20,41-50,55 `registerHostRuntimeRoutes: /api/host/auth/local, /api/host/auth/logout` — **delete-code** _(medium)_: Delete POST /api/host/auth/local and /api/host/auth/logout, the ensureLocalUser param, and the enableLocalLogin/disconnectAuth('app') imports. Keep /runtime, /auth/status, /auth/check, /auth/events, /auth/codex/disconnect and /auth/codex/usage. They project the Codex state and the fixed local user to browser clients. — ⚠ The browser-client and mobile LAN UIs read /api/host/runtime and /api/host/auth/status|events for identity. Keep those working and always return the fixed user.
  - [ ] L9,41-50,55 `/api/host/auth/local, /api/host/auth/logout, enableLocalLogin import` — **rewrite** _(high)_: The /local handler reads publicAuthState().app.userId (43) and calls enableLocalLogin (48). /logout calls disconnectAuth('app'). Make /local and /logout return status() as no-ops, or remove them together with transport.ts login/logout. Drop enableLocalLogin from the import. Keep status, check, events and codex routes. — ⚠ Browser-client/LAN host auth depends on these routes. transport.ts:21-22 posts to 'local' and 'logout'. Removing them without a transport change breaks browser-client bootstrap.
- [ ] `ygg-chat/client/ygg-chat-r/server/routes/userProjectRoutes.ts`
  - [ ] L108-212 `/api/local/users, /api/local/users/merge` — **keep-but-decouple** _(high)_: Keep /api/local/users. In merge, delete the safety rule (152-164) and also UPDATE note_search_docs (or rebuild the index) before deleting fromUser. Add a one-shot startup adopt in initializeAuth: read credentials.read('app')?.userId and merge it into LOCAL_USER_ID, then clear the app slot. — ⚠ Without re-parenting, signed-in users' local SQLite data is invisible under the fixed id. Without the note_search_docs update, merge cascade-deletes search docs. No schema change is needed. [verified-changed: The diagnosis is correct. The safety rule at 152-164 counts any user other than fromUserId, so with the default local row present it always refuses. That blocks the existing Settings manual merge UI (]
- [ ] `ygg-chat/client/ygg-chat-r/src/App.tsx`
  - [ ] L26,231,251,314 `AnimatedRoutes '/' and '/login'` — **rewrite** _(medium)_: Remove the Login import and the '/login' route. Replace '/' (isHostClient ? Navigate '/login' : LandingPage) with <Navigate to='/homepage' replace/>. Keep '*' to '/', which now lands on /homepage. — ⚠ HashRouter deep links and the titleBar history assume '/' and '/login' are excluded pages.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/ChatMessage/HtmlIframe.tsx`
  - [ ] L4,16 `useAuth().userId` — **keep-but-decouple** _(low)_: Only reads userId. Keep a slim useAuth shim returning {userId: LOCAL_AUTH_USER_ID, accessToken:null, loading:false} (or import LOCAL_AUTH_USER_ID directly); no other change.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/GlobalNotifications/GlobalNotifications.tsx`
  - [ ] L90-100 `handleAction sign_in/upgrade` — **delete-code** _(low)_: Remove the 'sign_in' (navigate /login) and 'upgrade' (navigate /paymentplan) cases. Keep reconnect_provider and open_settings, which go to /settings for Codex.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/HtmlIframeRegistry/HtmlIframeRegistry.tsx`
  - [ ] L761-762 `electronApi.auth.openExternal` — **rename** _(high)_: Switch to electronApi.shell.openExternal with the shell:openExternal rename. — ⚠ Local HTML iframe link opening. The scout's caller list missed it.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/LowBar/LowBar.tsx`
  - [ ] L9,35 `useAuth().userId` — **keep-but-decouple** _(low)_: Same as HtmlIframe: depends only on userId; works unchanged if useAuth shim is kept, else replace with LOCAL_AUTH_USER_ID.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/LowBar/ResearchNotesList.tsx`
  - [ ] L8,27 `useAuth().userId` — **keep-but-decouple** _(low)_: Same as LowBar: userId-only consumer (research-notes query key). Keep via shim or LOCAL_AUTH_USER_ID.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/MarkdownLink/MarkdownLink.test.tsx`
  - [ ] L87-122 `stubGlobal electronAPI.auth.openExternal` — **update-test** _(low)_: Change the mocks to { electronAPI: { shell: { openExternal } } } so they match the renamed API.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/MarkdownLink/MarkdownLink.tsx`
  - [ ] L88-92 `window.electronAPI.auth.openExternal` — **keep-but-decouple** _(high)_: External links open via electronAPI.auth.openExternal. When removing the preload 'auth' namespace/auth IPC, keep openExternal (move to electronAPI.shell.openExternal or retain 'auth:openExternal' channel) and update this call site. — ⚠ Fallback is window.open which Chromium turns into a new Electron BrowserWindow (per code comment); deleting the auth namespace breaks link handling in all chats.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/McpAppIframe/McpAppIframe.tsx`
  - [ ] L378-379 `electronApi.auth.openExternal` — **rename** _(high)_: Switch to electronApi.shell.openExternal with the shell:openExternal rename. — ⚠ MCP app ui/open-link (a kept MCP feature). The scout's caller list missed it.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/ProtectedRoute.tsx`
  - [ ] L9-25 `ProtectedRoute` — **rewrite** _(medium)_: Remove the <Navigate to='/login'>. Show Loading only while auth/host bootstrap is pending; if bootstrap failed (browser-client host unreachable), show an error with retry instead of redirecting. — ⚠ Browser-client relies on this to wait for /api/host/runtime and to surface host-unavailable errors.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/TitleBar/TitleBar.tsx`
  - [ ] L179-185 `openRemoteUi -> electronAPI.auth.openExternal` — **keep-but-decouple** _(high)_: Remote/LAN UI launcher uses electronAPI.auth.openExternal. Repoint to the relocated openExternal bridge (same change as MarkdownLink, HtmlIframeRegistry L761, McpAppIframe L378, Chat L5078, Settings L996/1413/4027). — ⚠ Kept LAN/shared-UI launch path; removing electronAPI.auth wholesale breaks it.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/TitleBar/titleBarHistory.ts`
  - [ ] L5 `EXCLUDED_PATHS` — **delete-code** _(low)_: Remove '/login' from EXCLUDED_PATHS. Also update titleBarHistory.test.ts lines 16 and 30, which push '/login' visits.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/Chat.tsx`
  - [ ] L5602-5612 `handleChatErrorAction sign_in/upgrade` — **delete-code** _(low)_: Remove the 'sign_in' (navigate '/login?required=cloud') and 'upgrade' (navigate '/payment') cases. Coordinate with the shared/chatErrors action kinds.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/Homepage.tsx`
  - [ ] L181-184 `signOut/handleLogout` — **delete-code** _(low)_: Remove useAuth().signOut and handleLogout, plus any logout button that uses them.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/ManagedLogin.tsx`
  - [ ] `ManagedLogin` — **delete-file** _(medium)_: Delete the Google/GitHub cloud sign-in, OOB code and 'Continue locally' screen. The host client no longer has a login step. — ⚠ Today 'Continue locally' sets the server local_login_enabled flag. The server must return the local user unconditionally first, or users get stuck.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/Settings.tsx`
  - [ ] L305,517-519,2512-2520 `handleLogout / Logout header button` — **delete-code** _(low)_: Remove signOut/accessToken from useAuth, handleLogout and the LogOut icon button in the header. Remove LogOut from the lucide import at line 5.
  - [ ] L305,516-518 `useAuth signOut/accessToken, handleLogout` — **delete-code** _(low)_: Destructure only userId from useAuth. Delete handleLogout and its button.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/index.ts`
  - [ ] L4,7 `Login/Homepage exports` — **delete-code** _(low)_: Remove the 'Login' (ManagedLogin) and 'Homepage' exports. Marketing/payment exports are handled in P6.
- [ ] `ygg-chat/client/ygg-chat-r/src/contexts/AuthContext.tsx`
  - [ ] L1-360 `AuthProvider/AuthContextType` — **rewrite** _(high)_: Expose {user:{id:LOCAL_AUTH_USER_ID,username:'local-user'} (lib/auth/types User, not supabase), userId, loading}. Still await getAuthProvider(), then always setUser(local profile)+dualSync.syncUser. Ignore provider user. Drop cloudApi, FORCE_LOGOUT, syncRuntimeAuthMode, signIn/signOut/reloadSession/getClaims/isTokenValid. — ⚠ accessToken is destructured in useQueries (about 15 sites), sideBar:783, HomepageRedirect:64, useUserSystemPrompts:65, useLoggingAnalytics:211 and useConversationSnapshotCoordinator:21. signOut is used in Homepage:181 and Settings:305/518. Either keep accessToken:null for now or update those call sites in the same change. [verified-changed: The direction is right and the lines are accurate, but the plan misses three things. (1) server/auth/runtime.ts:57-61 publicAuthState() returns user=null unless local_login_enabled is set, so AuthCont]
  - [ ] L3,9,108-130 `cloudApi.get('/users/:id'), dualSync.syncUser` — **delete-code** _(medium)_: Remove cloud profile fetch (/api/cloud/users/:id) and localMirror.syncUser (/api/sync/user); local user is LOCAL_AUTH_USER_ID ensured server-side (ensureAppUserExists / index.ts community-user insert). — ⚠ Owned by auth area; listed because it is a /api/cloud and /api/sync caller.
  - [ ] L56-63 `updateAuthState graviton:host-account-changed` — **delete-code** _(low)_: Identity is now fixed, so remove the account-change detection that dispatches 'graviton:host-account-changed' and clearUser.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/localChatErrors.ts`
  - [ ] L141-149,180-183 `codeForStatus / classifyLocalChatError 401|403 -> session_expired` — **rewrite** _(medium)_: 401/403 from the local host map to 'session_expired' whose action is sign_in -> navigate('/login'). With no app session, map 401/403 to 'server_rejected_request' (or a new host-access code with open_settings) so no Sign-in bubble/route is offered. — ⚠ Browser-client/LAN hosts can legitimately return 401/403 (origin/fence policy); mapping must stay informative for that kept path.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/mainChatClient.ts`
  - [ ] L191,210,398-420 `requiresReauthentication / 'reauth_required' SSE branch` — **delete-code** _(low)_: reauth_required frames are only emitted for the app slot (RailwayAppAuthError / AuthFailure slot 'app'). Remove the branch, the requiresReauthentication accumulator field and the AuthContext/ProtectedRoute comment (L399-403).
- [ ] `ygg-chat/client/ygg-chat-r/src/features/initialStates/index.ts`
  - [ ] L1 `export userInitialState` — **delete-code** _(low)_: Remove the userInitialState re-export if userInitialState.ts is deleted. Keep the conversations initial state export.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/initialStates/userInitialState.ts`
  - [ ] L1-5 `defaultState (userInitialState)` — **delete-file** _(low)_: Delete with the users slice, or seed currentUser with the local user ({id: LOCAL_AUTH_USER_ID, username:'local'}) if the slice stays as a local constant.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/users/index.ts`
  - [ ] L16 `users barrel exports` — **delete-code** _(low)_: Remove loginUser and refreshUserCredits from the re-export list.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/users/usersActions.ts`
  - [ ] L7-50 `loginUser/refreshUserCredits/deleteUser` — **delete-code** _(low)_: Delete loginUser (POST /api/users plus saveUserToStorage), refreshUserCredits (cloud /users/:id credits) and deleteUser. Keep re-exporting setUser/clearUser.
  - [ ] L8-50 `loginUser (/api/users), refreshUserCredits (api.get /users/:id -> /api/cloud), deleteUser` — **delete-code** _(low)_: Delete refreshUserCredits (cloud credits) and the never-dispatched loginUser/deleteUser (relative /api/users, web backend); update usersSlice extraReducers and users/index.ts export. Credit fields in usersTypes.User go with P6.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/users/usersSelectors.ts`
  - [ ] `selectCurrentUser/selectIsAuthenticated/selectUserId/selectUsername/selectUserStatus` — **rewrite** _(high)_: Only AuthContext setUser (Supabase/app profile) and the credits refresh feed currentUser. Replace selectCurrentUser with a constant local user ({id: LOCAL_AUTH_USER_ID}) or delete it and switch consumers (App.tsx 103/160/357, QuickInput, Chat 1126, Homepage 29) to the local id. Drop selectIsAuthenticated/selectUserStatus. — ⚠ App/Chat/Homepage/QuickInput read currentUser.id for routing and for project/quick-chat ids. If it becomes null with no fallback, the local UI shows the signed-out state.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/users/usersSlice.ts`
  - [ ] L36-69 `usersSlice extraReducers` — **delete-code** _(low)_: Remove the loginUser, deleteUser and refreshUserCredits cases. Keep the setUser/clearUser reducers, since currentUser gates the sidebar and tool shell.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/users/usersTypes.ts`
  - [ ] L3-33 `User/LoginUserPayload` — **rewrite** _(low)_: Drop max_credits, cached_current_credits, total_spent, credits_enabled, last_reset_at, reset_period, stripe_customer_id, active_subscription_id and free_generations_remaining. Decide on quick_chat_project_id (never set locally). Remove LoginUserPayload and UserSettings if unused.
- [ ] `ygg-chat/client/ygg-chat-r/src/hooks/useAuth.ts`
  - [ ] L1-12 `useAuth` — **keep-but-decouple** _(low)_: Keep this hook. Its return shape shrinks to {user,userId,loading}. Consumers that destructure accessToken, signOut or signIn (Settings, sideBar, HomepageRedirect, useQueries, useLoggingAnalytics, useUserSystemPrompts, useConversationSnapshotCoordinator) must be updated.
- [ ] `ygg-chat/client/ygg-chat-r/src/lib/auth/allowlist.ts`
  - [ ] `isUserAllowlisted` — **delete-file** _(low)_: A Supabase allowlist check with no importers in src. Delete it along with lib/supabase.ts.
- [ ] `ygg-chat/client/ygg-chat-r/src/lib/auth/index.ts`
  - [ ] L1-19 `getAuthProvider/resetAuthProvider` — **keep-but-decouple** _(low)_: Keep the bootstrapHostRuntime() then managed-provider init, since browser-client and codex need it. resetAuthProvider has no external callers; delete it.
- [ ] `ygg-chat/client/ygg-chat-r/src/lib/auth/local.ts`
  - [ ] `LocalAuthProvider` — **delete-file** _(low)_: Dead code: nothing imports LocalAuthProvider (index.ts always uses ManagedAuthProvider). Delete it, or move its LOCAL_USER_ID constant into runtimeMode LOCAL_AUTH_USER_ID.
- [ ] `ygg-chat/client/ygg-chat-r/src/lib/auth/managed.ts`
  - [ ] L13-56 `ManagedAuthProvider.adopt/initialize/login/logout` — **rewrite** _(high)_: adopt: drop the app-slot notice (provider 'openrouter'). Keep codex notices. Guard the line-18 version compare for a missing app slot. initialize: migrate({codex}) only. Keep the removeItem calls as one-off cleanup. Remove login/logout (and from types.ts). getSession/onAuthStateChange return LOCAL_AUTH_USER_ID. — ⚠ getPublicAuth().codex (chatgptAccount.ts, Settings) and the browser-client SSE /api/host/auth/events depend on adopt and publicState. Removing app-slot handling must not stop codex snapshots from being adopted. [verified-changed: The codex path is preserved correctly, but three gaps remain. (1) Line 18 compares value.app.version, so it will throw if the server drops the app slot. (2) login/logout are required members of the Au]
  - [ ] L18,21-28,34-40,51-54 `ManagedAuthProvider.adopt/initialize/login/logout` — **rewrite** _(high)_: Lines 35-38: drop supabase-auth-token and send migrate({codex: read('openai_chatgpt_tokens')}), or drop migrate entirely only if the server starts the owner itself. Lines 18 and 21: compare and loop codex only. Line 25: always provider_signin_required/openaichatgpt. login/logout become status reloads. Update managed.test.ts. — ⚠ Every Electron and browser client gets its userId here. A shape mismatch with publicAuthState (missing `app`) throws in adopt and leaves an empty app. If migrate is removed, coordinate with runtime.ts initializeAuth start(). [verified-changed: Lines 34-40 also carry the Codex handoff (read('openai_chatgpt_tokens') and removeItem). Deleting the whole block either drops legacy Codex tokens or leaves auth.migrate uncalled, and the server timer]
  - [ ] L25 `app slot reauth -> session_expired provider 'openrouter'` — **delete-code** _(low)_: Remove the 'app' slot branch, which raises session_expired for provider 'openrouter'. Only codex should raise provider_signin_required.
  - [ ] L35-41,51-52 `ManagedAuthProvider.initialize migrate / login / logout` — **rewrite** _(medium)_: Pass only {codex: read('openai_chatgpt_tokens')} to auth.migrate. Delete the 'supabase-auth-token' read (keep removing the key). Remove login()/logout() or make them no-ops once the login gate is gone. — ⚠ Removing migrate wholesale would drop legacy Codex tokens of old installs.
- [ ] `ygg-chat/client/ygg-chat-r/src/lib/auth/publicState.ts`
  - [ ] L1-5 `PublicAuthState.app` — **keep-but-decouple** _(medium)_: Keep this module for codex state. Once the server stops emitting the 'app' slot, drop it from PublicAuthState and make user non-null (local). — ⚠ Mirrors shared/hostRuntime.ts HostAuthState and shared/auth.ts AuthSlot, so the server and renderer must change together.
- [ ] `ygg-chat/client/ygg-chat-r/src/lib/auth/transport.ts`
  - [ ] L16-33 `hostAuthTransport` — **rewrite** _(medium)_: Once preload auth shrinks, delete the start/code/cancel/onLoginError/openExternal shims (the browser shim says 'Complete cloud sign-in on the Electron host'). Keep status/check/onChanged for both hosts. — ⚠ Shared by Electron and the kept browser-client LAN host. The browser path (/api/host/auth/*) must keep working for the codex status.
  - [ ] L16-35 `hostAuthTransport` — **rewrite** _(high)_: Shrink both branches to status/check/onChanged (plus Codex helpers). Remove the login/logout/onLoginError/start/code/cancel/openExternal members from the browser-client shim so both shapes match the trimmed electronAPI.auth. — ⚠ The browser-client (LAN shared UI) path is kept. status/check/events (/api/host/auth/*) feed the Codex state there.
  - [ ] L16-36 `hostAuthTransport` — **rewrite** _(medium)_: Reduce the transport to status, check, onChanged and openExternal. Delete the browser login->'local', logout, start, code, cancel and onLoginError stubs. Keep disconnectHostCodex and readHostCodexUsage. — ⚠ This is the shared transport for the Electron and browser-client/mobile hosts. Browser clients must still get identity over /api/host/auth/status and events.
  - [ ] L16-36 `hostAuthTransport` — **delete-code** _(medium)_: Remove login ('local'), logout, onLoginError, start, code and cancel (cloud sign-in stubs). Keep status, check, onChanged, disconnectHostCodex and readHostCodexUsage for the browser-client codex state. — ⚠ The Electron branch returns window.electronAPI.auth. Trim the preload/vite-env typings to match. openExternal must survive somewhere.
  - [ ] L21-22,30-34 `hostAuthTransport login/logout/onLoginError/start/code/cancel` — **delete-code** _(medium)_: Remove the browser-client login('local')/logout and the cloud sign-in stubs (start/code/cancel/onLoginError). Keep status/check/onChanged and the codex disconnect/usage helpers. Update vite-env.d.ts:36 and transport.browser.test.ts. — ⚠ onChanged/status carry codex state to browser clients. Keep those.
- [ ] `ygg-chat/client/ygg-chat-r/src/lib/auth/types.ts`
  - [ ] L1-78 `AuthProvider/Credentials/Session` — **rewrite** _(low)_: Remove Credentials, Session, login/logout/refreshToken/requiresNetworkAuth and the session/accessToken fields. Keep a minimal provider: initialize, dispose, getSession (identity), onAuthStateChange.
  - [ ] L26-29,52-60 `Credentials/AuthProvider.login/logout` — **delete-code** _(low)_: Remove Credentials and the login/logout members of AuthProvider once managed.ts drops them. Update comment line 37, which mentions Supabase.
- [ ] `ygg-chat/client/ygg-chat-r/src/lib/supabase.ts`
  - [ ] `supabase client` — **delete-file** _(medium)_: Delete the Supabase client and its VITE_SUPABASE_URL/ANON_KEY reads. The only importers are lib/auth/allowlist.ts (dead) and services/appStore.ts (first-party catalog, see P7). — ⚠ services/appStore.ts fetchAppStoreApps uses supabase.storage.getPublicUrl. Replace that before deleting this file.
  - [ ] L1-20 `supabase client (VITE_SUPABASE_URL/ANON_KEY)` — **delete-file** _(medium)_: Delete after AuthContext and appStore.fetchAppStoreApps stop importing it. — ⚠ appStore first-party listing depends on it (P7).
- [ ] `ygg-chat/client/ygg-chat-r/src/main.tsx`
  - [ ] L229-233 `clearAccountCache listener for graviton:host-account-changed` — **delete-code** _(low)_: Remove the 'graviton:host-account-changed' listener and its HMR dispose. Keep clearAccountCache for 'graviton:foreign-host'.
- [ ] `ygg-chat/client/ygg-chat-r/src/services/hostRuntimeBootstrap.ts`
  - [ ] L1-40 `bootstrapHostRuntime/verifyBrowserHost` — **keep-but-decouple** _(low)_: No cloud dependency. Keep as is. HostRuntimeInfo.auth (shared/hostRuntime.ts) carries the app slot, which becomes vestigial once the server drops it.
- [ ] `ygg-chat/client/ygg-chat-r/src/store/store.ts`
  - [ ] L11,24 `rootReducer.users (usersReducer)` — **rewrite** _(medium)_: If the users slice is deleted, remove the usersReducer import and the 'users' key. Otherwise keep it as a static local-user reducer. RootState shape changes, so update ChatSelectionProvider (state.users.currentUser?.id) and the smoke stores in the same change. — ⚠ RootState type changes ripple into every useAppSelector that reads state.users.
- [ ] `ygg-chat/client/ygg-chat-r/src/utils/api.ts`
  - [ ] L752,905 `Authorization header when environment === 'web' || 'electron'` — **delete-code** _(medium)_: Drop the web/electron Bearer-JWT header spread. The local server needs no app JWT once auth is removed. If any local auth stays, use isHostClient rather than VITE_ENVIRONMENT. — ⚠ Owned with P3 auth removal. Check that no local route still requires this header.
- [ ] `ygg-chat/client/ygg-chat-r/src/vite-env.d.ts`
  - [ ] L6,11,14-16,35-49 `__IS_WEB__/VITE_API_URL/VITE_SUPABASE_*/VITE_STRIPE_*/ElectronAPI.auth` — **rewrite** _(medium)_: Remove the VITE_SUPABASE_URL/ANON_KEY, VITE_STRIPE_PUBLISHABLE_KEY and VITE_API_URL typings and __IS_WEB__. Trim ElectronAPI.auth to status/check/onChanged/migrate (codex)/openExternal; drop start/code/cancel/login/logout/onLoginError/openOAuthWindow/onOAuthCallback. — ⚠ auth.openExternal is used by MarkdownLink, TitleBar, Settings (Codex OAuth, LAN URL) and Chat, so it must remain or move.
  - [ ] L35-48 `ElectronAPI.auth type` — **rewrite** _(medium)_: Mirror the preload changes: drop onLoginError/start/code/cancel/login/logout/openOAuthWindow/onOAuthCallback. Move openExternal under shell. Keep status/check/onChanged (and migrate if kept). — ⚠ TypeScript build (tsc -b) breaks if the types and preload diverge from the call sites.
  - [ ] L35-49,94 `ElectronAPI.auth type / shell type` — **rewrite** _(medium)_: Drop onLoginError, start, code, cancel, login, logout, openOAuthWindow, onOAuthCallback and openExternal from auth. Add openExternal(url) to the shell type at 94. Keep status/check/onChanged/migrate. — ⚠ Must match the preload rewrite exactly, or tsc -b fails for the renderer build.
  - [ ] L35-49 `ElectronAPI.auth type` — **rewrite** _(low)_: Mirror the preload changes: drop onLoginError, start, code, cancel, migrate, login, logout, openOAuthWindow and onOAuthCallback.
- [ ] `ygg-chat/docs/agent_context/agent_auth.md`
  - [ ] L1-37 `Managed authentication: app (Supabase/Railway) + codex slots; appLogin.ts; appAuthTokenManager; frontmatter src/lib/auth/**` — **rewrite** _(medium)_: Rewrite as a Codex/ChatGPT-only credential doc. Remove the 'app' slot, appLogin.ts deep-link/OOB flow, Supabase anon config in esbuild.main.mjs (l.23), the Railway adapter (l.27,29) and app 'Sign in' errors (l.33). Update frontmatter paths if src/lib/auth/** is deleted. — ⚠ server/auth/runtime.ts stays for Codex. The doc must still describe AuthSessionManager/refresh for the codex slot.
- [ ] `ygg-chat/shared/auth.ts`
  - [ ] L2 `AuthSlot = 'app' | 'codex'` — **rewrite** _(medium)_: Narrow to 'codex' after the app consumers are removed, so tsc finds leftovers (appStoreRoutes:287, openRouterProvider:485/627, ephemeralGenerateRoutes:216, appAuthTokenManager:12-13). Leave the credentialStore 'app' field to be read once for the adopt step. — ⚠ Shared contract between Electron main, host routes and renderer publicState.ts.
- [ ] `ygg-chat/shared/hostRuntime.ts`
  - [ ] L4-9 `HostAuthState` — **rewrite** _(medium)_: Remove the 'app: AuthSnapshot' field. user becomes non-null {id,email?}. Bump HOST_CLIENT_PROTOCOL if old browser clients matter (they are served by the same host, so a bump is probably unnecessary). — ⚠ Wire contract read by src/lib/auth/managed.ts (lines 18 and 21-28: app.version, the slot loop), ManagedLogin.tsx and the scripts/test-browser-*.cjs fixtures. Update them in lockstep.

### P4 — Renderer runtime-mode & auth collapse (117)

- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/ui/mobile/src/App.tsx`
  - [ ] L93-95,453-460,1401-1404,1482 `normalizeProviderName, selectedProviderRequiresAuth/Authenticated, openRouterConnected guard, fallback providerOptions` — **rewrite** _(high)_: Replace the cloud 'openrouter' handling (connected through the app token) with 'openrouterbyok' gated on BYOK key status, or remove it. Update the fallback providerOptions list at line 1482. — ⚠ Mobile LAN chat send path. A stale 'openrouter' selection would silently go to ChatGPT.
  - [ ] L94,388,453-458,657-662,1088,1108,1401-1402,1482,1505 `normalizeProviderName, openRouterConnected, refreshOpenRouterStatus, provider options` — **rewrite** _(medium)_: Replace 'openrouter' (cloud app-session provider) with 'openrouterbyok' (or remove) in normalization, auth gating, status refresh, default provider options list. — ⚠ Sending provider 'openrouter' after server removal routes to the default/legacy mapping instead of failing clearly.
  - [ ] L94,388,453-461,480,657-663,1088,1108,1401-1402,1482 `normalizeProviderName, openRouterConnected state, auth gating, default provider options` — **rewrite** _(low)_: Replace 'openrouter' with 'openrouterbyok' in normalizeProviderName, the auth gating, the status refresh and the fallback providerOptions list (1482). Label it 'OpenRouter BYOK'.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/ui/mobile/src/api.ts`
  - [ ] L58-61,296,341-385,467-478 `readRuntimeAppSession, getRuntimeAppAuth, openrouter token status/store/clear` — **rewrite** _(medium)_: Delete readRuntimeAppSession/getRuntimeAppAuth (unused, reads Supabase app snapshot via /api/provider-auth/openrouter/token). Replace 'openrouter' provider token calls with 'openrouter-byok' endpoints or drop OpenRouter from mobile. — ⚠ Mobile LAN UI is kept; /api/provider-auth/openrouter/token changes when app slot is removed.
  - [ ] L58-61,290-300,341-386,365-372,467-478 `readRuntimeAppSession, getProviderModels filter, getProviderTokenStatus/clearProviderToken 'openrouter', getOpenRouterTokenStatus, getRuntimeAppAuth, storeOpenRouterToken` — **rewrite** _(medium)_: Delete readRuntimeAppSession, getRuntimeAppAuth (unused) and storeOpenRouterToken; they hit /api/provider-auth/openrouter/token, the app slot. Change the 'openrouter' slug to 'openrouter-byok' in the token status/clear helpers and 'openrouterbyok' in the getProviderModels filter. — ⚠ The mobile LAN UI is kept. The server providerAuthRoutes change removes /api/provider-auth/openrouter/token, so this must ship with it.
  - [ ] L290-300,341-386 `provider filter 'openrouter'; getOpenRouterTokenStatus/clearOpenRouterToken; getRuntimeAppAuth` — **rewrite** _(high)_: Filter on 'openrouterbyok'. Point the OpenRouter token status and clear calls at /api/provider-auth/openrouter-byok/token, or delete them. Delete getRuntimeAppAuth (reads the app session) in P3. — ⚠ The mobile UI's provider list and token status calls share this module with the kept openai, zai and bedrock calls.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/ui/mobile/src/components/MobileHeader.tsx`
  - [ ] L72,160-170,375 `OpenRouter auth pill/label` — **rewrite** _(low)_: Rename provider key to openrouterbyok (label 'OpenRouter (BYOK)') or remove the openrouter branch.
  - [ ] L72,162-166,375-376 `PROVIDER_LABELS.openrouter; authStatus; 'OpenRouter uses your stored app token.'` — **rewrite** _(low)_: Rename the key to openrouterbyok with the label 'OpenRouter BYOK'. Replace the app-token hint with 'Set your OpenRouter API key in desktop Settings.'
  - [ ] L162-166,375-376 `openrouter connected badge; 'OpenRouter uses your stored app token.'` — **rewrite** _(low)_: Change the openrouter badge and hint to openrouterbyok with BYOK-key wording, or remove them.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/ui/mobile/src/types.ts`
  - [ ] L64,126 `MessageTreeMeta.storage_mode, MobileProviderName` — **rewrite** _(low)_: MobileProviderName: replace 'openrouter' with 'openrouterbyok'. meta.storage_mode may stay (server still returns it) or be removed.
  - [ ] L126 `MobileProviderName 'openrouter'` — **rewrite** _(high)_: Replace 'openrouter' with 'openrouterbyok' (or drop it). The mobile UI's 'openrouter' is the cloud app-token provider. — ⚠ Mobile LAN UI is kept. The provider union drives App.tsx, api.ts and MobileHeader, and typecheck:mobile is part of build:electron:main.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/ChatMessage/ChatMessage.tsx`
  - [ ] L32,559 `handleLoadMcpApp environment !== 'electron'` — **rewrite** _(high)_: Replace with !isNativeShell and drop the environment import. — ⚠ MCP app loading is silently disabled in an Electron build without .env. MCP is a kept feature.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/Heimdall/Heimdall.tsx`
  - [ ] L53,622,696,701 `environment !== 'electron' guards` — **rewrite** _(high)_: Replace with isNativeShell (preserves current semantics; consider isHostClient). — ⚠ Heimdall tree view never loads in an Electron build without .env. [verified]
- [ ] `ygg-chat/client/ygg-chat-r/src/components/HtmlIframeRegistry/HtmlIframeRegistry.tsx`
  - [ ] L22,238 `isElectronEnv` — **rewrite** _(medium)_: `const isElectronEnv = isNativeShell`; drop `environment` import. — ⚠ HTML tools runtime.
  - [ ] L22,238,282 `isElectronEnv / platform desktop|web` — **rewrite** _(medium)_: Line 238: use isNativeShell. Line 282: platform: isNativeShell ? 'desktop' : 'web'. Drop the environment import. — ⚠ Without .env, line 282 reports platform 'web' to custom-tool iframes in Electron.
  - [ ] L282 `platform: environment === 'electron' ? 'desktop' : 'web'` — **rewrite** _(medium)_: Use `isNativeShell ? 'desktop' : 'web'` (clientCapabilities) instead of the VITE_ENVIRONMENT-derived environment. — ⚠ With no .env, Electron reports platform 'web' to HTML/MCP apps, which may disable desktop-only app behavior.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/InputTextArea/InputTextArea.tsx`
  - [ ] L192 `shouldUseLocalFileFallback` — **delete-code** _(low)_: Remove `import.meta.env.VITE_ENVIRONMENT !== 'web' &&` (always true).
- [ ] `ygg-chat/client/ygg-chat-r/src/components/McpAppIframe/McpAppIframe.tsx`
  - [ ] L4,78 `platform: environment==='electron' ? 'desktop':'web'` — **rewrite** _(medium)_: Use isNativeShell for platform and drop the environment import. — ⚠ MCP Apps get the wrong host platform without .env.
  - [ ] L78 `platform: environment === 'electron' ? 'desktop' : 'web'` — **rewrite** _(medium)_: Use `isNativeShell ? 'desktop' : 'web'` instead of environment. — ⚠ Kept MCP apps feature. A no-.env Electron build would otherwise advertise 'web' to MCP UI apps.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/ModelSelectControl/ModelSelectControl.tsx`
  - [ ] L41-54 `userIsFreeTier disabledModelOptions / free-first sort` — **delete-code** _(medium)_: Delete the userIsFreeTier memo branches. disabledModelOptions becomes [] and sortedFilteredModels becomes filteredModels. Do this in the same change as removing userIsFreeTier from useModels. — ⚠ Every model selector uses this component. A TS error results if useModels stops returning the field first.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/QuickInput/QuickInput.tsx`
  - [ ] L12-13,24-31,37,39,44-66,165-173 `currentProvider 'OpenRouter', useToggleSecretMode, secret-mode footer, useSubscriptionStatus/credits` — **rewrite** _(medium)_: Delete the Secret Mode state, toggle and footer, plus the isFreeUser/credits gating (useSubscriptionStatus, cached_current_credits). Replace the hard-coded 'OpenRouter' provider with the store's current provider (selectCurrentProvider) or providerSettings.defaultProvider. — ⚠ QuickInput is rendered by LowBar. With 'OpenRouter' gone, the hard-coded provider would load no models, so quick chat would break unless it is rewired.
  - [ ] L12,24-66,160-173 `currentProvider 'OpenRouter'; secret mode (ZDR); free/credits gating` — **rewrite** _(high)_: Replace the hardcoded useState('OpenRouter') with the user's selected provider (chat state currentProvider). Delete the secret-mode toggle, useToggleSecretMode, isSecretMode sync, useSubscriptionStatus/credits gating and the '/payment' subscribe footer. — ⚠ QuickInput (LowBar quick chat) is kept UI. With useModels collapsed, 'OpenRouter' throws and quick chat has no models.
  - [ ] L13,21-31,44-73 `useSubscriptionStatus/hasCredits/secret mode/subscribe footer` — **delete-code** _(low)_: Remove useSubscriptionStatus, cached_current_credits, the Secret Mode (cloud ZDR via useToggleSecretMode) and the 'Subscribe now' /payment button. Set modelSelectFooter to null. quick_chat_project_id is never set locally, so drop it or keep null.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/SettingsPane/SettingsPane.tsx`
  - [ ] L270,656,659,2645 `isWebMode` — **delete-code** _(low)_: Delete isWebMode const; drop `!isWebMode` guards (hooks fetch effect + deps, JSX at 2645 always rendered).
- [ ] `ygg-chat/client/ygg-chat-r/src/components/SettingsPane/ToolsSettings.tsx`
  - [ ] L33,42,54,145,158 `isWebMode` — **delete-code** _(low)_: Delete isWebMode and its guards (effect body/deps, JSX sections always shown).
  - [ ] L33 `isWebMode = VITE_ENVIRONMENT === 'web'` — **delete-code** _(low)_: Delete isWebMode and the web-only branches it gates. The web target is removed.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/TextArea/TextArea.tsx`
  - [ ] L143 `shouldUseLocalFileFallback` — **delete-code** _(low)_: Remove `import.meta.env.VITE_ENVIRONMENT !== 'web' &&`.
- [ ] `ygg-chat/client/ygg-chat-r/src/config/runtimeMode.ts`
  - [ ] L1-60 `isCloudSession/isCommunityMode/isElectronCommunityMode/isCloudBackendAllowed/syncRuntimeAuthMode/isCloudSessionEnabled` — **rewrite** _(medium)_: Do this last. Delete isLikelyJwt, LOCAL_AUTH_TOKENS, isCloudSession, runtimeIdentity, cloudSessionEnabled, the isCommunityMode/isElectronCommunityMode/isCloudBackendAllowed lets, applyRuntimeAuthMode, syncRuntimeAuthMode and isCloudSessionEnabled. Keep isElectronMode (or re-export isNativeShell) and LOCAL_AUTH_USER_ID. — ⚠ About 20 importers plus 4 test mocks. Deleting the exports before every consumer is collapsed breaks the build. isCloudBackendAllowed has no consumers.
  - [ ] L8-9,19-28 `LOCAL_AUTH_USER_ID, LOCAL_AUTH_TOKENS, isCloudSession` — **collapse-to-local** _(medium)_: Import LOCAL_AUTH_USER_ID from a shared constant (ygg-chat/shared/localUser.ts). Delete LOCAL_AUTH_TOKENS, isLikelyJwt and isCloudSession. Set isCommunityMode=true and isCloudBackendAllowed=false as consts. syncRuntimeAuthMode only records userId. isCloudSessionEnabled returns false. Fix useLoggingAnalytics.ts:213. — ⚠ Land together with the fixed publicAuthState user. A stale Supabase id in the projection would otherwise flip community gating in about 20 consumers. [verified-changed: isCloudSession is also used inside the file: line 33 (cloudSessionEnabled init) and line 55 (syncRuntimeAuthMode). It is also used by useLoggingAnalytics.ts:213. Deleting only lines 19-28 does not com]
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/Chat.tsx`
  - [ ] L101,4980-5023 `default-provider effect isCommunityMode branches` — **collapse-to-local** _(high)_: Keep one path. If there is no currentProvider or it is unavailable, use settings.defaultProvider when present and valid, else 'LM Studio' or the first allowed. Drop the 'OpenRouter' preference. Remove the isCommunityMode early return in the visibility effect at 5021. — ⚠ Decides the initial provider for every chat. The community path today ignores the user's defaultProvider setting, so the merged logic must respect it. [verified]
  - [ ] L1574-1575,4980-5010,5094-5098,5160-5164,6101-6108,8359-8390 `openRouterLoginRequiredModalOpen modal; default-provider effect; handleProviderSelect / shortcut OpenRouter guards` — **delete-code** _(medium)_: Delete the 'Sign in required for Yggdrasil models' modal, its state and handlers (navigate('/login?required=cloud')). Delete the OpenRouter+isCommunityMode guards. Collapse the default-provider effect: drop the community branch and the 'OpenRouter' preference, falling back to the configured default and then the first provider. — ⚠ The default-provider effect decides the provider for a fresh install. It is coupled with the providers.json order and isCommunityMode removal (P4).
  - [ ] L1575,5095-5098,5160-5164,6101-6108,8359-8392 `openRouterLoginRequiredModal` — **delete-code** _(low)_: Remove the 'Sign in required for Yggdrasil models' modal, its state and handlers, and the OpenRouter+isCommunityMode guards in handleProviderSelect and the model-shortcut handler. Cloud OpenRouter will not be offered at all.
  - [ ] L1612-1617 `isElectronEnv` — **rewrite** _(low)_: Replace VITE_ENVIRONMENT check and nonexistent `window.__IS_ELECTRON__` with isNativeShell (no useMemo needed).
  - [ ] L1686 `bench export environment.mode` — **rewrite** _(low)_: Replace `mode: import.meta.env.VITE_ENVIRONMENT` with `mode: __BUILD_TARGET__`.
  - [ ] L5095-5098,5160-5164 `OpenRouter login-required modal (handleProviderSelect/model shortcut)` — **delete-code** _(low)_: Delete the providerName==='OpenRouter' && isCommunityMode branches, plus the openRouterLoginRequiredModal state and modal. 'OpenRouter' is no longer in the provider list.
  - [ ] L6523-6581,7749-7752 `current_credits/tokenLimits credit budget/Credits row` — **delete-code** _(high)_: Remove current_credits and the creditInputLimit/creditOutputLimit math; set totalBudget to totalContextLimit. Delete the 'Credits:' row in the context-usage popover. — ⚠ Shared context-usage bar for all local providers. Credits are 0 locally, so any model with promptCost>0 (OpenRouter BYOK) gets a 0 budget today. Keep totalContextLimit intact. [verified]
  - [ ] L7934 `fast service tier tooltip` — **rewrite** _(low)_: Change the tooltip text to 'Fast service tier is only sent for OpenAI ChatGPT'.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/ConversationPage.tsx`
  - [ ] L51-53 `isElectronMode` — **rewrite** _(medium)_: Replace with imported isElectronMode/isNativeShell.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/Homepage.tsx`
  - [ ] L35-37 `isElectronMode` — **rewrite** _(medium)_: Replace with imported isElectronMode/isNativeShell. — ⚠ Gates JSX at 299.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/LoggingDashboard.tsx`
  - [ ] L9,56-61,104-108,252,401,411-427 `source cloud/local, Billing, provider reconciliation` — **collapse-to-local** _(low)_: Fix source='local', remove the Source filter, Cloud badge and useCloudLoggingAnalytics. Delete the Billing component (plan, credits, top-ups) and its local disclaimer at 252. Make the !local reconciliation panel at 401 unconditional-false.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/Settings.tsx`
  - [ ] L23,174,278-282,332-334,536-555,2403-2466,4436-4503 `Google Drive (cloud OAuth via Railway) status/connect/disconnect + dead Services block` — **delete-code** _(low)_: Delete the GoogleDriveStatus interface and state, fetchGoogleDriveStatus and its effect (keyed on accessToken), handleGoogleDriveConnect/Disconnect (cloudApi /oauth/google-drive/*) and the dead {false && (...)} Services section. Drop isCommunityMode and the cloudApi import.
  - [ ] L356 `zaiApiKeyLoading initial state` — **rewrite** _(medium)_: useState(isNativeShell) instead of VITE_ENVIRONMENT==='electron'. — ⚠ Without .env these provider-credential sections never load in Electron (zai is a kept provider).
  - [ ] L360 `openRouterByokApiKeyLoading initial state` — **rewrite** _(medium)_: useState(isNativeShell). — ⚠ openrouterbyok is a kept provider.
  - [ ] L367 `bedrockCredentialsLoading initial state` — **rewrite** _(medium)_: useState(isNativeShell). — ⚠ bedrock is a kept provider.
  - [ ] L492,1146-1148,3034-3036 `subagentProviderForModels fallback 'OpenRouter'; post-ChatGPT-signout providerSelected('OpenRouter'); OpenRouter Temperature label` — **rewrite** _(low)_: 492: fall back to 'OpenAI (ChatGPT)' (or the first provider) instead of 'OpenRouter'. 1147: after ChatGPT sign-out, select 'LM Studio' or the first provider. 3034-3036: relabel to 'OpenRouter (BYOK) Temperature'.
  - [ ] L537-555,2403-2475 `fetchGoogleDriveStatus/handleGoogleDriveConnect/handleGoogleDriveDisconnect` — **delete-code** _(medium)_: Google Drive OAuth goes through cloudApi (/api/cloud -> Railway) and is gated on isCommunityMode. Delete the handlers, the googleDrive state and its Settings section. — ⚠ Check that no local tool reads the Google Drive status before deleting.
  - [ ] L558 `useEffect electron guard` — **rewrite** _(medium)_: `if (!isNativeShell) return`.
  - [ ] L579 `useEffect electron guard` — **rewrite** _(medium)_: `if (!isNativeShell) return`.
  - [ ] L719 `zai key load effect` — **rewrite** _(medium)_: `if (!isNativeShell) { setZaiApiKeyLoading(false); return }`.
  - [ ] L750 `openrouterbyok key load effect` — **rewrite** _(medium)_: `if (!isNativeShell)` guard.
  - [ ] L783 `bedrock credentials load effect` — **rewrite** _(medium)_: `if (!isNativeShell)` guard.
  - [ ] L1538 `handleMemoryBackfill` — **rewrite** _(low)_: `if (!isNativeShell)` guard.
  - [ ] L1743-1830,4069-4135 `Local Ownership Migration (fromUserId/toUserId, /local/users/merge)` — **keep-but-decouple** _(high)_: Lines 341-345,1744-1836,4069-4135: replace the VITE_ENVIRONMENT checks (1752,1834,4069) with isNativeShell. Default fromUserId to the first user whose id !== LOCAL_AUTH_USER_ID and toUserId to LOCAL_AUTH_USER_ID. Keep the /local/users and /local/users/merge server routes. — ⚠ Without this, former signed-in users' local projects and conversations stay owned by their cloud uuid and disappear under the fixed local identity. [verified-changed: The claim is verified: electron/main.ts:1027-1029 merged local rows into the cloud user id at login, so a manual re-home is needed. But the range misses the state declarations (341-345) and the fetch ]
  - [ ] L1752 `fetchLocalUsers` — **rewrite** _(low)_: `if (!isNativeShell) return` (or delete with Local Ownership Migration if P5 removes it).
  - [ ] L1834 `fetchLocalUsers effect` — **rewrite** _(low)_: `if (!isNativeShell) return`.
  - [ ] L2715 `Agent Mode Prompt section` — **rewrite** _(medium)_: `{isNativeShell && (` (or isHostClient, see open question). — ⚠ Hidden in Electron without .env.
  - [ ] L2838 `Provider Settings section` — **rewrite** _(medium)_: `{isNativeShell && (`. — ⚠ Provider config UI for kept providers.
  - [ ] L3246 `Memory section` — **rewrite** _(medium)_: `{isNativeShell && (`.
  - [ ] L3293 `Subagent section` — **rewrite** _(medium)_: `{isNativeShell && (`.
  - [ ] L3444 `Context files section` — **rewrite** _(medium)_: `{isNativeShell && (`.
  - [ ] L3584 `Tools Configuration section` — **rewrite** _(medium)_: `{isNativeShell && (`.
  - [ ] L3873 `API Keys section` — **rewrite** _(medium)_: `{isNativeShell && (`. — ⚠ Brave/MCP OAuth credential vault UI.
  - [ ] L3940 `Built-in Browser section` — **rewrite** _(low)_: `{isNativeShell && (`.
  - [ ] L3974 `Remote UI Access section` — **rewrite** _(medium)_: `{isNativeShell && (`. — ⚠ Controls kept LAN browser-client feature.
  - [ ] L4069 `Local Ownership Migration section` — **rewrite** _(low)_: `{isNativeShell && (` (P5 may delete the section entirely since it exists to move cloud-user ownership).
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/rightBar.tsx`
  - [ ] L220,358,404,660,1026,1066,1178,1250,1287,1316,1320,1375,1409,1427,1440,1569,1573,1589,1602,1608,1613,1619,1788,1827,1834,1849,1852,1867,2240,2249,2322,2523,2635,2672,2694,2741,3048,3143,3322,3333 `isWeb` — **delete-code** _(medium)_: Delete `const isWeb = VITE_ENVIRONMENT==='web'`; treat as false everywhere: drop `isWeb ||` early-returns, `!isWeb &&` JSX guards, `disabled={isWeb}`, isWeb from hook deps, and the h-[100vh] web class branch. — ⚠ Large shared file (terminal/git/LSP/browser dock). Behavior-preserving (isWeb is already false in Electron and browser-client) but many edits.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/sideBar.tsx`
  - [ ] L789,826,834,2013 `isWeb` — **delete-code** _(low)_: Delete isWeb and its branches (projectData passthrough at 826, deps at 834, h-[100vh] class at 2013).
  - [ ] L790-792 `isElectronMode` — **rewrite** _(medium)_: Replace VITE_ENVIRONMENT/process.env.VITE_ENVIRONMENT check with imported isElectronMode/isNativeShell. — ⚠ Gates Electron-only sidebar actions; false without .env today.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/buildServerLoopRequest.test.ts`
  - [ ] L174-182 `'forwards openrouter temperature + serviceTier'` — **update-test** _(low)_: Use provider 'openrouterbyok' for the temperature case, and keep the serviceTier assertion generic or Codex-only.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/chatActions.ts`
  - [ ] L20,103-105,2015-2100 `getRemoteApiBase/syncConversationToLocal` — **delete-code** _(medium)_: Delete getRemoteApiBase (VITE_API_URL / webdrasil fallback) and the syncConversationToLocal thunk, which pulls cloud conversations into local SQLite and is a no-op in community mode. Remove its dispatchers. — ⚠ Check the syncConversationToLocal callers in Chat.tsx and the chats barrel before deleting.
  - [ ] L526-530,1165-1170,1664-1669,1923-1928 `resolveOpenRouterTemperature; serviceTier forwarding for providerSlug==='openrouter'` — **delete-code** _(low)_: In resolveOpenRouterTemperature, keep only the 'openrouterbyok' check. In the three sendMessage/repeat/edit request builders, drop the `providerSlug === 'openrouter' ? serviceTier` arm so serviceTier is only for ChatGPT. Update the 'Codex and OpenRouter' comments.
  - [ ] L530-534,1170,1669,1928 `resolveOpenRouterTemperature, serviceTier for providerSlug==='openrouter'` — **rewrite** _(medium)_: Drop 'openrouter' (cloud) slug: temperature only for 'openrouterbyok'; serviceTier forwarding `providerSlug === 'openrouter'` should target 'openrouterbyok' or be removed (coordinate with provider owner). — ⚠ openrouterbyok is kept; ensure its temperature/serviceTier behavior is not regressed.
  - [ ] L531,1170,1669,1928 `resolveOpenRouterTemperature 'openrouter'; serviceTier for providerSlug==='openrouter'` — **delete-code** _(medium)_: At line 531, keep only the 'openrouterbyok' check. At lines 1170, 1669 and 1928, drop the `providerSlug === 'openrouter' ? serviceTier` arm so non-ChatGPT providers get undefined. — ⚠ These are the send, repeat and branch request builders used by every provider. Remove only the openrouter arms.
  - [ ] L2349-2385 `initializeUserAndConversation` — **collapse-to-local** _(medium)_: Keep only the local branch (gwApi or localApi POST /conversations with storageMode 'local'). Delete the cloudApi.post('/users', test-user) path. — ⚠ Chat.tsx:5029 dispatches this when there is no conversation id. The local path must not depend on isCommunityMode.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/chatHookClient.ts`
  - [ ] L71-84 `runChatHook isElectronMode + debug log` — **rewrite** _(medium)_: Use imported isNativeShell; replace viteEnvironment/isElectronGlobal log fields with buildTarget: __BUILD_TARGET__. — ⚠ Hooks silently skip in Electron without .env.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/chatSlice.ts`
  - [ ] L9,298-302,2022-2032 `freeTier state/freeGenerationsUpdated/freeTierLimitModalShown/Hidden` — **delete-code** _(low)_: Delete the freeTier initial state and the three reducers, and drop the isCommunityMode import.
  - [ ] L95-115 `webHiddenProviders/communityAllowedProviders/getAvailableProviders` — **collapse-to-local** _(high)_: Remove the webHiddenProviders branch and the isCommunityMode check. Return all providers except cloud 'OpenRouter'. Today the community list hides 'Amazon Bedrock'. — ⚠ This controls which kept providers appear. Bedrock is currently hidden in community mode. Coordinate with removing 'openrouter' from providers.json. [verified]
  - [ ] L96-114 `webHiddenProviders, communityAllowedProviders, getAvailableProviders` — **collapse-to-local** _(medium)_: Remove 'OpenRouter' from communityAllowedProviders. Collapse getAvailableProviders to return all providers: there is no web target and no community/cloud split. Delete webHiddenProviders. — ⚠ The browser-client (LAN) target currently takes the non-Electron branch and hides local providers. After collapsing, it must show local providers, because it talks to the local host.
  - [ ] L96-115 `webHiddenProviders, communityAllowedProviders, getAvailableProviders` — **collapse-to-local** _(high)_: Delete webHiddenProviders and the isCommunityMode and web branches. getAvailableProviders returns all providers.json entries (with 'OpenRouter' removed). Drop the isCommunityMode import. — ⚠ The provider picker for every kept provider runs through this function. The web branch hides all local providers if isHostClient is ever false.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/chatTypes.ts`
  - [ ] L171,559-563 `'free_generations_update' event type / ChatState.freeTier` — **delete-code** _(low)_: Remove 'free_generations_update' from the stream event type union and remove the freeTier block from ChatState.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/sseProjection.ts`
  - [ ] L16,538-562 `projectServerEvent free_generations_update/generation_limit_reached/reauth_required` — **delete-code** _(medium)_: Delete the free_generations_update and generation_limit_reached cases. Delete the reauth_required case too: the server only emits it for the app slot, while codex uses provider_signin_required. — ⚠ Must match the removal of these SSE variants in shared/headlessApi.ts, or the switch exhaustiveness check fails.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/streamRunTracking.ts`
  - [ ] L9-12 `isLocalRuntime` — **rewrite** _(medium)_: Replace with isNativeShell (or isHostClient; 'local' target branch only matters if that target is kept). — ⚠ Streaming-run tracking for kept local chat.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/streamUndoApi.ts`
  - [ ] L1,4 `isElectron = environment==='electron'` — **rewrite** _(high)_: Use isNativeShell (or isHostClient) instead of utils/api environment. — ⚠ Stream undo silently disabled in Electron without .env. [verified]
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/subagentClient.test.ts`
  - [ ] L116,205-212 `'OpenRouter' service-tier row; OpenRouter->openaichatgpt redirect test` — **update-test** _(low)_: Drop the ['OpenRouter','priority','priority'] row. Retarget the redirect test to an unknown provider name, which should still resolve to openaichatgpt/gpt-5.6-sol.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/subagentClient.ts`
  - [ ] L24,31,63-86 `SubagentInheritedProvider 'openrouter'; resolveSubagentDefaults OpenRouter redirect` — **delete-code** _(low)_: Remove 'openrouter' from the union and line 31. resolveSubagentDefaults: when the provider is unresolved, return { provider: 'openaichatgpt', model: DEFAULT_SUBAGENT_MODEL }. Drop the openrouter special case and update the comment.
  - [ ] L24,31,80-85 `SubagentInheritedProvider 'openrouter'; openrouter→openaichatgpt fallback` — **collapse-to-local** _(medium)_: Remove 'openrouter' from the union and from resolveInheritedSubagentProvider. In the fallback at 83-84, keep only the `!resolvedProvider` → openaichatgpt arm. — ⚠ Kept subagent launch path. This must stay consistent with server subagentToolExecutor.
- [ ] `ygg-chat/client/ygg-chat-r/src/helpers/providerSettingsStorage.ts`
  - [ ] L6,58-59,155-178 `isCommunityMode, COMMUNITY_ALLOWED_PROVIDERS, COMMUNITY_FALLBACK_PROVIDER` — **collapse-to-local** _(medium)_: Remove the community-mode provider forcing: use resolvedDefaultProvider and the stored showProviderSelector, and use DEFAULT_SETTINGS in the catch branch. Keep openRouterTemperature, which BYOK uses through resolveOpenRouterTemperature. — ⚠ Line 135 also checks VITE_ENVIRONMENT==='electron' for the Electron store mirror. Switch it to __IS_ELECTRON__/runtimeMode in P0/P4, or the mirror silently stops without .env.
  - [ ] L6,58-59,155-177 `COMMUNITY_ALLOWED_PROVIDERS/COMMUNITY_FALLBACK_PROVIDER/isCommunityMode branches` — **collapse-to-local** _(high)_: Force showProviderSelector=true. Validate defaultProvider against providers.json names excluding 'OpenRouter' (share a helper with chatSlice getAvailableProviders) instead of a hardcoded set. Fall back to 'LM Studio'. Drop the isCommunityMode import and the mock in providerSettingsHost.test.ts:5. — ⚠ Host-persisted provider preferences are shared with browser clients. Today a Claude Code or Bedrock default is silently replaced with LM Studio. [verified-changed: The lines are accurate and keeping the community semantics matches what local users see today. However, a second hardcoded allowed list will drift from chatSlice again. Derive it from the same source.]
- [ ] `ygg-chat/client/ygg-chat-r/src/helpers/serverLoopSettings.browser.test.ts`
  - [ ] L3 `vi.mock('../config/runtimeMode', () => ({ isElectronMode: false }))` — **update-test** _(low)_: Same as serverLoopSettings.test.ts: repoint the mock to wherever isElectronMode lives after the runtimeMode collapse.
- [ ] `ygg-chat/client/ygg-chat-r/src/helpers/serverLoopSettings.test.ts`
  - [ ] L3 `vi.mock('../config/runtimeMode', () => ({ isElectronMode: true }))` — **update-test** _(low)_: Update the mock target when runtimeMode.ts is collapsed or isElectronMode moves (for example to clientCapabilities/__IS_ELECTRON__). serverLoopSettings.ts:13,56 imports isElectronMode.
- [ ] `ygg-chat/client/ygg-chat-r/src/helpers/serverLoopSettings.ts`
  - [ ] L13 `isElectronMode import` — **keep-but-decouple** _(low)_: If runtimeMode.ts is reduced or removed, import isNativeShell from platform/clientCapabilities instead. Update the mocks in serverLoopSettings.test.ts:3 and serverLoopSettings.browser.test.ts:3.
- [ ] `ygg-chat/client/ygg-chat-r/src/hooks/useIdeContext.ts`
  - [ ] L131-133 `requestFileContent warn guard` — **delete-code** _(low)_: Remove `VITE_ENVIRONMENT !== 'web'` wrapper; always warn.
  - [ ] L157-160 `connect web early-return` — **delete-code** _(low)_: Delete the 'Disable IDE context in web environment' block.
- [ ] `ygg-chat/client/ygg-chat-r/src/hooks/useLoggingAnalytics.ts`
  - [ ] L4,213 `isCloudSession consumer` — **collapse-to-local** _(low)_: Remove the isCloudSession import and treat cloudSession as false (local-only path).
  - [ ] L4,174-190,210-228,230-242 `useCloudLoggingAnalytics/useLocalLoggingAnalytics/payments type` — **collapse-to-local** _(medium)_: Delete useCloudLoggingAnalytics (api.get /analytics/dashboard with accessToken, isCloudSession). Change the useLocalLoggingAnalytics gate from environment==='electron' to isHostClient. Drop the payments block from LoggingDashboardResponse if the server stops sending it. — ⚠ Without .env, environment!=='electron' and the local dashboard never loads.
  - [ ] L5,237 `enabled && environment === 'electron'` — **rewrite** _(low)_: Use isNativeShell and drop the environment import (the `api` cloud import is handled in P5).
  - [ ] L210-241 `useCloudLoggingAnalytics, useLocalLoggingAnalytics enabled gate` — **rewrite** _(medium)_: Delete useCloudLoggingAnalytics (api.get('/analytics/dashboard') -> /api/cloud) and its callers. Change the useLocalLoggingAnalytics gate from `environment === 'electron'` to isHostClient. — ⚠ The local logging dashboard is silently disabled in builds without a .env.
- [ ] `ygg-chat/client/ygg-chat-r/src/hooks/useQueries.ts`
  - [ ] L31,39,43,659-873 `useModels (cloud fallback branch, community guard, openrouter gpt-5-mini default)` — **collapse-to-local** _(high)_: In useModels (659-871), delete the isElectronCommunityMode guard and the cloudApi /models/* fallback (802-863) and throw `Unknown provider`. Drop userIsFreeTier from all branches together with the ModelSelectControl.tsx 41-54 free-tier logic. Remove the imports at 31, 39 and 43 once the other callers are gone. — ⚠ Every model selector uses useModels. `enabled: !!provider && !!userId` (line 865) needs P3 to supply a local userId. QuickInput hardcodes 'OpenRouter' and breaks unless it is re-pointed at the same time. [verified-changed: The collapse is correct, but useModels ends at line 871. Removing userIsFreeTier from every return branch makes ModelSelectControl.tsx:41 (`modelsData?.userIsFreeTier`) a TS error, so that file must c]
  - [ ] L39 `import environment` — **rewrite** _(low)_: Drop `environment` (and cloudApi, per P5) from the utils/api import.
  - [ ] L39,367,2007,2051,2092 `environment gates in queries` — **rewrite** _(high)_: Lines 367 and 2007: replace environment!=='electron' with !isNativeShell (or !isHostClient). Lines 2051 and 2092: drop `environment !== 'web'` (always true). Remove the environment import. — ⚠ Shared query hooks for local data. They return [] in Electron without .env.
  - [ ] L357-380,2001-2010,2041-2095 `useFavoritedConversations / useHtmlToolsCache / useDirectoryFiles env gates` — **rewrite** _(medium)_: Replace `environment !== 'electron'` / `!== 'web'` with isHostClient; without VITE_ENVIRONMENT favorites and html-tools return [] in Electron. — ⚠ Local features silently empty in a no-.env build until fixed.
  - [ ] L367 `favorites query guard` — **rewrite** _(medium)_: `if (!isHostClient) return []` (or isNativeShell to preserve). — ⚠ Favorites empty in Electron without .env.
  - [ ] L801-866 `useModels cloud fallback (/models, /models/openrouter via cloudApi)` — **delete-code** _(medium)_: Replace the isElectronCommunityMode throw and the cloudApi /models/* switch with an unconditional throw for unknown providers. Drop userIsFreeTier from every return value. — ⚠ Local provider branches above (claude, lmstudio, openrouterbyok, zai, bedrock, openaichatgpt) must stay untouched.
  - [ ] L873-928 `useRecentModels` — **delete-code** _(low)_: Delete it. It calls cloudApi /models/recent, and its only callers are commented out (Chat.tsx:3486) or comments (chatActions.ts:880, conversationSelectors/Slice/Types).
  - [ ] L873-929,931-1076,1117-1171 `useRecentModels, ZdrModel/useZdrModels, useToggleSecretMode, useRefreshModels` — **delete-code** _(medium)_: Delete these hooks. They call cloudApi /models/recent, /models/openrouter/zdr and /models/openrouter. useRecentModels and useRefreshModels are only referenced in comments. useToggleSecretMode is used by QuickInput, which must be updated at the same time. — ⚠ QuickInput imports useToggleSecretMode, so the build breaks if both are not changed together.
  - [ ] L879-1080 `useRecentModels/useZdrModels/useToggleSecretMode` — **delete-code** _(low)_: Delete these cloud-only hooks (cloudApi /models/recent, /models/openrouter/zdr, /models/openrouter) and the ZdrModel type. Remove the QuickInput consumer of useToggleSecretMode.
  - [ ] L930-1081 `ZdrModel, useZdrModels, useToggleSecretMode` — **delete-code** _(low)_: Delete the ZDR/Secret Mode hooks. They call cloudApi /models/openrouter/zdr and /models/openrouter and rewrite the ['models','OpenRouter'] cache. The only consumer is QuickInput.
  - [ ] L1117-1175 `useRefreshModels` — **delete-code** _(low)_: Delete it. It calls cloudApi /models/* and its only consumers are commented out (QuickInput:165, Chat.tsx:3487). Alternatively, reduce it to queryClient.invalidateQueries(['models', provider]).
  - [ ] L2007 `useHtmlToolsCache guard` — **rewrite** _(medium)_: Drop `environment !== 'electron'` (query already enabled only when isHostClient).
  - [ ] L2051,2092 `directory/file search enabled` — **delete-code** _(low)_: Remove `&& environment !== 'web'`.
- [ ] `ygg-chat/client/ygg-chat-r/src/hooks/useToolJobs.ts`
  - [ ] L25,107,251,257 `isWebMode` — **delete-code** _(low)_: Delete isWebMode and its early returns.
- [ ] `ygg-chat/client/ygg-chat-r/src/services/ToolJobManager.ts`
  - [ ] L544-545 `auto-initialize guard` — **delete-code** _(low)_: Drop `&& import.meta.env.VITE_ENVIRONMENT !== 'web'`; keep `typeof window !== 'undefined'`.
- [ ] `ygg-chat/client/ygg-chat-r/src/services/appStore.ts`
  - [ ] L274-276,304,330,378,390,398,407 `environment === 'electron' / environment !== 'electron' gates` — **rewrite** _(high)_: Replace `environment` (api.ts:11 = import.meta.env.VITE_ENVIRONMENT) with __IS_ELECTRON__ or the runtimeMode helper. Non-electron branches call publicApiCall to API_BASE (Railway, from VITE_API_URL). Route them to the local /api/app-store/* or keep them only for browser-client (/api). — ⚠ Without VITE_ENVIRONMENT these gates take the non-electron path in Electron, which sends install/upload to API_BASE. That base is localhost:3001 once VITE_API_URL is gone, so app store install breaks.
- [ ] `ygg-chat/client/ygg-chat-r/src/services/clientTelemetry.ts`
  - [ ] L24-26 `isElectronRuntime` — **rewrite** _(medium)_: `return typeof window !== 'undefined' && isNativeShell`. — ⚠ Client error log (debug location) silently off in Electron without .env.
- [ ] `ygg-chat/client/ygg-chat-r/src/utils/iframeBridge.ts`
  - [ ] L29,36-38,56-66,350,392-447,590 `GenerationProvider, normalizeGenerationProvider, resolveGenerationProvider (slash->'openrouter'), streamCloudEphemeral, default model 'anthropic/claude-sonnet-4'` — **collapse-to-local** _(high)_: Remove 'openrouter' from the union and the normalizer (lines 29, 38). Route slash models to 'openrouterbyok' and the final fallback (line 65) to 'openaichatgpt'. Change the default at line 350 to a ChatGPT model (for example gpt-5.6-sol). Delete 392-457 and 598-719. Line 590 always calls streamLocalHeadless. Drop createStreamingRequest and isHostClient from the imports. — ⚠ Custom-tool REQUEST_GENERATION is a kept feature. Without a new default model every generation without an explicit model fails or needs a BYOK key. Also update the HEADLESS_API_GUIDE.md:49 note that tells tool authors to use provider 'openrouter'. [verified-changed: streamCloudEphemeral spans lines 392-457, not 392-447. The commented REQUEST_GENERATION_LEGACY block (598-719) also calls the cloud /generate/ephemeral and should be deleted. After line 590 collapses,]
- [ ] `ygg-chat/shared/chatErrors.ts`
  - [ ] L29,33,36,74,76,169-173,185-189,200-204 `session_expired/free_tier_exhausted/subscription_inactive & 'sign_in'/'upgrade' action kinds` — **rewrite** _(medium)_: Remove session_expired and free_tier_exhausted, and the 'sign_in' and 'upgrade' action kinds. Keep subscription_inactive but change its action to open_settings or retry, since it may come from ChatGPT/provider responses. — ⚠ Shared with the server envelope builders and managed.ts. Check that the server no longer emits these codes before narrowing the union.
- [ ] `ygg-chat/shared/providers.json`
  - [ ] L3-7 `providers.openrouter ('OpenRouter')` — **delete-code** _(medium)_: Delete the cloud 'openrouter' entry, which removes 'OpenRouter' from every renderer provider selector. Keep 'openrouterbyok'. Consider reordering so the first entry is the intended fresh-install default. — ⚠ Chat.tsx falls back to allowedProviders[0] when no provider is stored, so the order decides the default for a new install (currently it would be OpenRouter BYOK, which needs a key).

### P5 — Storage mode & renderer data API (113)

- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/persistence/lineageRepo.ts`
  - [ ] L170,184 `listRecent c.storage_mode -> storageMode` — **delete-code** _(low)_: Remove c.storage_mode from the SELECT and storageMode from the returned row, together with RecentLineage.storageMode in useQueries.ts L294.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/appAutomationRoutes.ts`
  - [ ] L104-108,150,157,310,341,381,411,440 `messages/tree meta.storage_mode; TopLevelMessageSearchCandidate.storage_mode` — **collapse-to-local** _(low)_: Return meta:{storage_mode:'local'} without the conversation lookup (or drop meta once useQueries L563-569 stops reading it); remove storage_mode from search candidate SELECT/mapping. Keep writes of 'local' on upserts.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/chatRoutes.ts`
  - [ ] L130 `normalize body storageMode` — **delete-code** _(low)_: Delete `storageMode: body.storageMode ?? body.storage_mode ?? 'local'` mapping.
- [ ] `ygg-chat/client/ygg-chat-r/server/localServer.ts`
  - [ ] L627,646,968,1170-1212 `projects/conversations storage_mode column DEFAULT 'cloud' + local-only statements` — **keep-but-decouple** _(medium)_: Leave columns/CHECK/index unchanged (no migration). Keep `storage_mode='local'` filters (they hide legacy cloud-mirror rows). Ensure every insert path passes 'local' explicitly since DEFAULT is 'cloud'. — ⚠ Changing DEFAULT needs a table rebuild migration + MIGRATIONS.md row; any new insert omitting storage_mode would create hidden rows.
  - [ ] L627,646 `projects/conversations storage_mode DEFAULT 'cloud'` — **keep-but-decouple** _(medium)_: Leave the column in place (user decision 3: no migration). Once the gateway is collapsed, no server route may branch on storage_mode. Inserts that omit it (e.g. syncStorageRoutes 53/69) store 'cloud', which renderer storageMode checks must ignore. — ⚠ Any surviving storage_mode==='cloud' check in the renderer or lineageRepo would misclassify rows created without the field. Changing the default needs a versioned migration plus a MIGRATIONS.md row.
- [ ] `ygg-chat/client/ygg-chat-r/server/routes/conversationRoutes.ts`
  - [ ] L180,389-393 `POST conversation 'local' storage_mode; GET messages meta.storage_mode` — **collapse-to-local** _(low)_: Keep the 'local' insert at L180 (column remains NOT NULL default). At L389-393 drop the getConversationById lookup and return meta:{storage_mode:'local'} or omit meta after renderer cleanup.
- [ ] `ygg-chat/client/ygg-chat-r/server/routes/syncStorageRoutes.ts`
  - [ ] L259-290,321-400,1010-1131 `/api/sync/project, /api/sync/conversation, /api/sync/batch storage_mode default` — **rewrite** _(medium)_: These exist to mirror cloud entities; change `storage_mode || 'cloud'` defaults (280, 374, 1041, 1064) to 'local', or delete project/conversation/batch/provider-cost/attachment sync routes once renderer localMirror callers are gone. Keep /api/local/attachments/* and /api/sync/message if still used. — ⚠ Defaulting to 'cloud' makes any mirrored row invisible to local-only statements. /api/local/attachments/* (local attachment storage) is in the same file and must stay.
- [ ] `ygg-chat/client/ygg-chat-r/server/tools/fetchChats.ts`
  - [ ] L97,111,540,584,632 `MessageSearchItem/NoteSearchItem.storage_mode` — **delete-code** _(low)_: Drop storage_mode ('cloud'|'local') from fetch_chats tool output types and the three mapping sites; field is meaningless to the model once local-only. fetchChats.test.ts does not assert it.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/ChatSelection/ChatSelectionProvider.tsx`
  - [ ] L31-34,49,58,68 `storageMode nav state; gwApi lineage loader` — **delete-code** _(low)_: Drop storageMode from navigate state and parseChatSelectionHref calls. Keep gwApi.get('/conversations/:id/lineages/:lineageId') (lineageRoutes.ts, local-only, separately registered).
- [ ] `ygg-chat/client/ygg-chat-r/src/components/Heimdall/Heimdall.tsx`
  - [ ] L269,284,2335,2341,2346,2501-2521,2558-2596,2648,4545-4549 `storageMode prop, targetStorageMode/modeOf, conversation storage badge` — **collapse-to-local** _(medium)_: Remove storageMode prop and all storageMode args to deleteSelectedNodes/fetchMessageTree/insertBulkMessages/previewMessageDeletion/createConversation/updateCwd/deleteConversation and nav state; delete storage_mode pill in conversation selector. — ⚠ Message move/copy transfer flow; verify transfer tests (TransferScopeChooser) still pass.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/QuickInput/QuickInput.tsx`
  - [ ] L12,24-31,39-56,82-101,165-173,205-220,300 `useSubscriptionStatus/credits/showSecretMode, useToggleSecretMode, local/cloud project sort, storageMode` — **collapse-to-local** _(low)_: Delete secret-mode toggle, subscription/credits gating, local-vs-cloud project partitioning (sort all by updated_at) and storageMode passed to fetchProjectById/createConversation; drop isLocalProject styling.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/SettingsPane/SettingsPane.tsx`
  - [ ] L472-482,1544,1630-1666 `prompt Local/Cloud badge and storage toggle` — **delete-code** _(low)_: Remove Local/Cloud pill selector, canSaveToCloud/savePromptStorage destructure, per-prompt 'Local'/'Cloud' badge and 'Cloud prompts sync' hint.
  - [ ] L480-482,1630-1665 `Local/Cloud prompt storage toggle` — **delete-code** _(low)_: Remove the ['local','cloud'] toggle and the 'Cloud prompts sync with your account' hint. Always show 'Local prompts stay on this device.'
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/Chat.tsx`
  - [ ] L113,140,1115-1118,3644-3672,3685,3780,3819-3830,4438,4502,6068,8259,8315 `storageModeFromNav, useConversationStorageMode, conversationStorageMode, syncConversationToLocal dispatch` — **delete-code** _(medium)_: Delete conversationStorageMode computation and all storageMode args/props (rename, deleteMessage, Heimdall props, updateCwd storageMode:'local'); delete VITE_ENVIRONMENT-gated syncConversationToLocal block (3819-3830) and its import. — ⚠ Large file; snapshot coordinator call and attachment hydration effect share the 3800s block - remove only the sync dispatch.
  - [ ] L3818-3830 `syncConversationToLocal dispatch (VITE_ENVIRONMENT==='electron')` — **delete-code** _(low)_: Delete the VITE_ENVIRONMENT-gated dispatch of syncConversationToLocal and its import (line 140). Keep the attachment processing that follows.
  - [ ] L3820-3830 `syncConversationToLocal on fetch` — **delete-code** _(medium)_: Delete the cloud-to-local SQLite sync dispatch gated on VITE_ENVIRONMENT==='electron' (fetched data already comes from the local server). — ⚠ Confirm syncConversationToLocal is a no-op for storageMode 'local' before deleting; otherwise rewrite gate to isNativeShell.
  - [ ] L3822-3830 `syncConversationToLocal dispatch` — **delete-code** _(medium)_: Delete the VITE_ENVIRONMENT==='electron' block that mirrors cloud-fetched messages into SQLite, and the syncConversationToLocal thunk (chatActions.ts:2016+). It fetches from getRemoteApiBase. — ⚠ The same effect hydrates attachments afterwards. Keep that part.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/ConversationPage.tsx`
  - [ ] L9,188,383,392,396,403,797-813 `isCommunityMode storage-mode branches` — **collapse-to-local** _(medium)_: Replace each isCommunityMode ternary with 'local'. Delete the {!isCommunityMode && Cloud radio}. Drop the storage chooser modal (the only option is local) and create directly. — ⚠ Routed page (/conversationPage). isElectronMode here is VITE_ENVIRONMENT-based (lines 51-53), so it needs the P0 fix.
  - [ ] L9,188,379-404,456,673-683,790-830,906-932 `storageMode modal, Local/Cloud badges, move-to-project storage filter` — **collapse-to-local** _(low)_: handleNewConversation creates directly (no storage modal); delete Storage Location radio block and storageMode state; remove Local/Cloud badges; move dialog lists all other projects (drop convMode===projMode filter and '(Local/Cloud projects only)' text).
  - [ ] L34,83,1002 `useResearchNotes` — **keep-but-decouple** _(low)_: Keep LowBar notes; depends on useResearchNotes being rewritten to a local source.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/EditProject.tsx`
  - [ ] L4,10,118,134-136,160,176,201,248,371,450-496,564-602 `storageMode state, Storage location section, prompt Local/Cloud toggle` — **delete-code** _(low)_: Delete storageMode state + 'Storage location' Cloud/Local cards (564-602), Cloud icon import, storageMode/storage_mode in create/update payloads, prompt storage pills/badge, isCommunityMode import.
  - [ ] L10,118,160,176,201,248,564-585 `isCommunityMode storage-mode branches / Cloud card` — **collapse-to-local** _(medium)_: Set storageMode to always 'local'. Remove the {!isCommunityMode && Cloud button} and the Storage location section (single option). Send storage_mode:'local'. — ⚠ Project create/edit path. A wrong default would hit the gateway cloud leg.
  - [ ] L134-136,450-495 `prompt save Local/Cloud toggle` — **delete-code** _(low)_: Remove the canSaveToCloud and savePromptStorage toggle UI and keep local-only prompt saving.
  - [ ] L171-177 `CreateProjectPayload.storageMode (isCommunityMode ? 'local' : storageMode)` — **collapse-to-local** _(low)_: Remove the storageMode field and the isCommunityMode/storage selector from the create-project form once CreateProjectPayload drops storageMode.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/Homepage.tsx`
  - [ ] L60,81,305-340,416-426 `storageFilter All/Cloud/Local, project Local/Cloud badges` — **delete-code** _(low)_: Delete storageFilter state and filter buttons; render allProjects directly; remove Local/Cloud badges. (Homepage is also marketing-adjacent: downloadApp modal is P6.)
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/HomepageRedirect.tsx`
  - [ ] L64,101,126,161,172 `HomepageRedirect` — **collapse-to-local** _(medium)_: Drop accessToken from useAuth and the deps. Change targetProject.storage_mode || 'cloud' to 'local', or drop storageMode. Navigation state storageMode is always 'local'. — ⚠ This is the startup path after '/' redirect. A wrong storageMode default would create cloud rows via the gateway.
  - [ ] L100-134 `targetStorageMode default 'cloud', navigate state storageMode` — **collapse-to-local** _(medium)_: Drop `targetProject.storage_mode || 'cloud'` and the storageMode passed to createConversation, plus the navigate state { storageMode }. The bootstrap creates the default project and chat locally. — ⚠ This is the first-run bootstrap. Every no-account launch depends on it.
  - [ ] L101,126-134,161 `targetStorageMode / navigate state.storageMode` — **collapse-to-local** _(medium)_: Drop targetStorageMode ('cloud' default) from createConversation and navigation state. — ⚠ Startup bootstrap path; createProject/createConversation must already default local.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/LoggingDashboard.tsx`
  - [ ] L2,9-10,56-63,91,106-108,150,230-252,395-427 `source cloud/local selector, Billing panel, provider reconciliation` — **collapse-to-local** _(low)_: Always local: remove source state/Filter, Cloud badge/icon, isCommunityMode, Billing component (subscription/credits/top-ups) and !local provider-reconciliation panel; reword 'Credits' labels to cost.
  - [ ] L56,91,107,236-252,389-411,411-430 `cloud analytics source + Billing panel (plan/subscription/top-ups)` — **collapse-to-local** _(medium)_: Force source='local': remove the Cloud option and isCommunityMode gating. Delete the Billing component and the provider-reconciliation and cloud rows in Quality. Simplify the `local ?` ternaries to their local branch. — ⚠ Logging dashboard is kept and local analytics must keep working. LoggingDashboard.test.tsx may assert the cloud/billing rows.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/Settings.tsx`
  - [ ] L174,278-282,334,536-555,2403-2465,4436-4500 `Google Drive OAuth (cloudApi /oauth/google-drive/status|start|disconnect)` — **delete-code** _(low)_: Delete GoogleDriveStatus state, fetchGoogleDriveStatus effect (runs on mount when signed in), connect/disconnect handlers and the `{false && ...}` Services section; drop cloudApi import.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/sideBar.tsx`
  - [ ] L56,1305-1330 `cloneConversation (Copy conversation)` — **rewrite** _(medium)_: cloneConversation -> /api/gw/conversations/:id/clone has no server route (Railway-only feature). Either add a local clone route (e.g. POST /api/app/conversations/:id/clone) or remove the Copy action. — ⚠ Feature is visible in UI and already fails locally; decision needed.
  - [ ] L56,1310-1325,2380-2450 `confirmCopyConversation / cloneConversation` — **rewrite** _(medium)_: 'Copy conversation' calls cloneConversation() -> legacy api.post('/conversations/:id/clone') on API_BASE (Railway). No local /clone route exists in server/. Either add a local clone route in conversationRoutes and call localApi, or remove the Copy action UI. — ⚠ User-visible sidebar action that will always fail after Railway removal unless reimplemented locally.
  - [ ] L672-678,762-764,826-834,1102,1113,1136,1152,1192,1231,1274-1276,1324,1397,1501-1505,1946,2399-2425 `cloud project icons, storage_mode filters, storageMode nav state/args` — **collapse-to-local** _(medium)_: Remove 'Cloud project' icons, storageMode in navigate state and in deleteProject/deleteConversation/createConversation/updateCwd args; hover preview no longer gated on storage_mode==='local'; move dialog drops storage match filter. — ⚠ visibleProjects (826-834) currently always shows non-local projects and caps local ones; after collapse the LOCAL_MODE_RECENT_PROJECTS_LIMIT applies to all projects.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/attachmentUrl.ts`
  - [ ] L1-71 `resolveAttachmentUrlFromOrigins` — **rewrite** _(medium)_: Remove remoteOrigin from AttachmentUrlInput; lines 57,62-65,69-70 (cloud /uploads + relative paths) return null instead of prefixing the Railway origin. — ⚠ Local attachment URL resolution (lines 37-56,66-68) must be preserved.
  - [ ] L7,35,57,64,69-70 `remoteOrigin branches` — **rewrite** _(medium)_: Remove cloud `data/uploads/` -> remoteOrigin/uploads branch; resolve server-relative paths against localOrigin. — ⚠ Used for every rendered attachment; keep local /api/local/attachments behavior intact.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/buildServerLoopRequest.ts`
  - [ ] L10,64,190 `ServerLoopParams.storageMode` — **delete-code** _(low)_: Remove storageMode param and `storageMode: params.storageMode ?? 'local'` body field; update doc comment listing 'openrouter' provider.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/chatActions.ts`
  - [ ] L20-35,103-105 `imports (isCommunityMode, localMirror, API_BASE, cloudApi, shouldUseLocalApi), getRemoteApiBase` — **delete-code** _(low)_: Delete getRemoteApiBase (VITE_API_URL || webdrasil-production.up.railway.app) and imports of isCommunityMode, localMirror, API_BASE, cloudApi, shouldUseLocalApi.
  - [ ] L25,507 `resolveAttachmentUrl remoteOrigin: API_BASE` — **rewrite** _(medium)_: Pass the local origin (getCachedLocalServerOrigin()) as remoteOrigin or drop remoteOrigin from resolveAttachmentUrlFromOrigins; update attachmentUrl.ts/attachmentUrl.test.ts. — ⚠ Attachment URL resolution is shared with local attachments; relative/uploads paths currently resolve against a Railway/localhost:3001 origin.
  - [ ] L103-105,2015-2101 `getRemoteApiBase, syncConversationToLocal` — **delete-code** _(low)_: Delete getRemoteApiBase (hardcoded webdrasil Railway URL) and the syncConversationToLocal thunk, which mirrors cloud conversations through localMirror /sync/*. Also remove its export in features/chats/index.ts:38.
  - [ ] L134-158 `getStorageModeFromCache` — **delete-code** _(low)_: Delete helper (defaults to 'cloud'); remove all call sites in sendMessage/edit/branch/deleteMessage/deleteSelectedNodes/previewMessageDeletion.
  - [ ] L139-158,1103,1376,1392,1616,1875,2397,2426 `getStorageModeFromCache, dualSync.syncMessage delete, storageMode in send/delete thunks` — **collapse-to-local** _(medium)_: Delete getStorageModeFromCache (it defaults to 'cloud'). Drop the storageMode values sent in the send/deleteMany/preview bodies and the dualSync.syncMessage delete at 1392. Remove the storageMode args from deleteMessage, deleteSelectedNodes, previewMessageDeletion and updateConversationTitle (2441-2457). — ⚠ Send thunks (1103/1616/1875) forward storageMode to the server chat route. First confirm the server collapse ignores the field, so local chat send keeps working.
  - [ ] L495-508 `resolveAttachmentUrl remoteOrigin` — **collapse-to-local** _(medium)_: Stop passing remoteOrigin: API_BASE (cloud /uploads host). Update resolveAttachmentUrlFromOrigins to drop remoteOrigin and return null for '/uploads', 'data/uploads/' and other non-local relative paths. — ⚠ Shared with every local attachment render; keep /api/local/attachments/:id/file and localhost rewrite behavior intact.
  - [ ] L496-508 `resolveAttachmentUrl remoteOrigin: API_BASE` — **rewrite** _(medium)_: Drop the remoteOrigin (API_BASE/VITE_API_URL) argument. Resolve attachment URLs from localOrigin/localApiBase only, and update features/chats/attachmentUrl.ts and attachmentUrl.test.ts to match. — ⚠ Local attachment image display depends on this resolver. Keep the /api/local/attachments rewriting and its tests.
  - [ ] L1101-1103,1150,1614-1616,1649,1873-1875,1909 `sendMessage/editMessageWithBranching/branch storageMode` — **delete-code** _(low)_: Remove `const storageMode = conversationMeta?.storage_mode || getStorageModeFromCache(...)` and `storageMode` in buildServerLoopRequest params (3 send paths). Server only uses it for the cloud openrouter provider.
  - [ ] L1368-1397 `deleteMessage` — **collapse-to-local** _(medium)_: Remove storageMode arg, getStorageModeFromCache, shouldUseLocalApi/isLocalMode and dualSync.syncMessage(...,'delete') (/api/sync mirror). Keep gwApi.delete('/messages/:id?conversationId=') -> local-only /api/gw (or /api/app/messages/:id). — ⚠ Claude delete-refusal handling (raiseClaudeDeleteRefusal) must remain.
  - [ ] L2014-2101 `syncConversationToLocal` — **delete-code** _(low)_: Delete thunk (mirrors cloud conversations/projects/messages into SQLite via /api/sync/*). Remove export in features/chats/index.ts:38 and dispatch in Chat.tsx:3819-3830.
  - [ ] L2105-2147 `fetchMessageTree storageMode payload` — **collapse-to-local** _(medium)_: Accept only ConversationId (drop {conversationId, storageMode} form and 'cloud' default); keep gwApi.get('/conversations/:id/messages/tree?includeTree=false') -> local /api/gw tree (in-process builder). — ⚠ Heimdall callers pass the object form; update them in the same change.
  - [ ] L2348-2386 `initializeUserAndConversation` — **collapse-to-local** _(medium)_: Keep only the local branch (gwApi.post('/conversations',{userId, title})) unconditionally; delete isCommunityMode gate and the cloudApi.post('/users') test-user path + storageMode:'local' body field. — ⚠ Dispatched by Chat.tsx:5029 when no conversation id; must still work with local auth.userId.
  - [ ] L2373-2381,3374-3389 `initializeUserAndConversation test-user fallback, fetchUserSystemPrompts` — **delete-code** _(low)_: Delete the cloudApi.post('/users') test-user fallback; with no auth, use LOCAL_AUTH_USER_ID. Rewrite fetchUserSystemPrompts to load from loadLocalUserSystemPrompts, or delete it if nothing dispatches it.
  - [ ] L2389-2440 `deleteSelectedNodes, previewMessageDeletion` — **collapse-to-local** _(medium)_: Drop storageMode arg and body field; keep gwApi.post('/messages/deleteMany',{ids,conversationId,dryRun?}) -> local /api/gw (-> /api/app/messages/deleteMany). — ⚠ Used by Heimdall move/transfer; lineage repair + Claude refusals happen in the local leg.
  - [ ] L2442-2460 `updateConversationTitle` — **collapse-to-local** _(low)_: Remove storageMode arg and `?storageMode=` query; call gwApi.patch(`/conversations/${id}`,{title}) (local).
  - [ ] L2461-2495 `uploadAttachment thunk` — **delete-code** _(low)_: Delete the uploadAttachment createAsyncThunk, which posts multipart to /api/gw/attachments and is forwarded to Railway. git grep finds no dispatchers.
  - [ ] L2462-2494 `uploadAttachment` — **delete-code** _(low)_: Delete thunk: multipart POST /api/gw/attachments is a Railway-only upload (server comment: cloud-only). No callers; local attachments use /api/local/attachments/prepare-base64|save-base64|link.
  - [ ] L2497-2580 `linkAttachmentsToMessage, fetchAttachmentsByMessage, deleteAttachmentsByMessage, fetchAttachmentById` — **delete-code** _(medium)_: Keep fetchAttachmentsByMessage on gwApi GET /messages/:id/attachments (local leg reads statements.getAttachmentsByMessageId). Delete the dead uploadAttachment (2462-2494), linkAttachmentsToMessage, deleteAttachmentsByMessage and fetchAttachmentById, plus their index.ts exports. — ⚠ Local attachment display needs GET /api/gw/messages/:id/attachments to stay. Once these thunks are gone, the server can drop POST /api/gw/attachments and the POST/DELETE link routes. [verified-changed: Only fetchAttachmentsByMessage is live; it is dispatched at 1343 and 2226. linkAttachmentsToMessage, deleteAttachmentsByMessage and fetchAttachmentById have no references in src. So does uploadAttachm]
  - [ ] L2976-2988 `insertBulkMessages` — **collapse-to-local** _(low)_: Drop storageMode arg/body; keep gwApi.post('/conversations/:id/messages/bulk',{messages}) -> local.
  - [ ] L3371-3392 `fetchUserSystemPrompts` — **delete-code** _(low)_: Delete thunk (cloudApi.get('/system-prompts')); never dispatched. Prompts come from useUserSystemPromptsQuery (local host prompt store).
  - [ ] L3374-3392 `fetchUserSystemPrompts (cloudApi /system-prompts)` — **delete-code** _(low)_: This thunk is cloud-only with no local fallback, and it 404s once /api/cloud is unmounted. Delete it if nothing dispatches it (git grep shows only its definition); otherwise return loadLocalUserSystemPrompts().
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/chatSelection.ts`
  - [ ] L9,70-76 `ChatSelectionTarget.storageMode, parseChatSelectionHref(href, storageMode)` — **delete-code** _(low)_: Remove storageMode field and second param.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/conversationMessagesApi.ts`
  - [ ] L1-81 `fetchConversationMessagesTree, ConversationMessagesTreeData.meta, FetchConversationMessagesTreeOptions.storageMode` — **collapse-to-local** _(high)_: Remove isCommunityMode/isElectronCommunityMode, storageMode cache lookup (42-63), cloud fallback; single call to local tree: localApi /app/conversations/:id/messages/tree (or gwApi local). Drop storageMode/accessToken options; meta optional/unused. — ⚠ Hot path for every chat open; browser-client must still resolve host origin. Keep includeTree/signal behavior. [verified]
  - [ ] L5,24-81 `isElectronCommunityMode/fetchConversationMessagesTree` — **collapse-to-local** _(high)_: Always call localApi /app/conversations/:id/messages/tree. Delete the storage-mode cache probing, the accessToken option and the gwApi/cloud fallback. — ⚠ isHostClient includes browser-client, so the local path must still use localApi's host-origin resolution for LAN clients. [verified]
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/conversationSnapshotCoordinator.ts`
  - [ ] L94,113,132 `storageMode option` — **delete-code** _(low)_: Drop storageMode param passthrough to fetchConversationMessagesTree.
  - [ ] L95-135 `coordinateConversationSnapshot storageMode/accessToken options` — **collapse-to-local** _(low)_: Remove the storageMode/accessToken pass-through to fetchSnapshot. Keep includeTree:false, the signal and the generation gating. Adjust src/hooks/useConversationSnapshotCoordinator.ts and its test mocks if their call signatures change.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/index.ts`
  - [ ] L38,100 `syncConversationToLocal / initializeUserAndConversation re-exports` — **delete-code** _(low)_: Remove syncConversationToLocal re-export; keep initializeUserAndConversation (local-only).
- [ ] `ygg-chat/client/ygg-chat-r/src/features/conversations/conversationActions.ts`
  - [ ] L5,99-111 `createConversation isCommunity` — **collapse-to-local** _(high)_: Lines 5-6,99-123: delete isCommunity and the isCommunityMode/environment imports (keep gwApi). Set effectiveStorageMode='local'. Delete the storage-mismatch validation (113-123). Keep the cwd and projectId logic. — ⚠ Every new chat goes through this. A wrong default sends creates to the removed cloud leg. [verified-changed: The action is correct and the VITE_ENVIRONMENT trap is real: environment defaults to 'local', so Electron without .env creates cloud conversations. The range misses `environment` in the line-6 import ]
  - [ ] L5-6,10-28 `isCommunityMode/environment imports, storageModeQs, phase-5 comment` — **delete-code** _(low)_: Delete storageModeQs helper and isCommunityMode/environment imports; rewrite header comment (gw is local-only).
  - [ ] L6,99-104 `isCommunity = environment==='electron' && isCommunityMode` — **collapse-to-local** _(medium)_: Delete the isCommunity, requestedStorageMode, project.storage_mode fallback and mismatch validation (99-122). Send storageMode:'local' (or omit it once the gateway is local-only) at line 135. Drop the environment and isCommunityMode imports (5-6). — ⚠ Local conversation creation goes through gwApi /gw/conversations. The local gateway leg must accept 'local' or a missing storageMode before the cloud leg is removed. [verified-changed: The range is too narrow. The 'cloud' defaults are at 107-110 and the storage-mode mismatch validation is at 112-122. The isCommunityMode import at line 5 also goes. With isCommunity removed, the 'clou]
  - [ ] L10-23,144-256 `storageModeQs, updateConversation/deleteConversation/updateSystemPrompt/updateContext/updateResearchNote/updateCwd storageMode` — **collapse-to-local** _(medium)_: Delete storageModeQs and the ?storageMode= query strings. Remove the storageMode arg from every thunk and from its callers (e.g. Heimdall.tsx:2572-2574 modeOf, SettingsPane). Keep the gwApi paths. — ⚠ These thunks back local conversation edits, so only the hint should go. Paths must stay.
  - [ ] L31-75,282-298 `fetchConversations, fetchRecentConversations, fetchConversationsByProjectId, searchConversations` — **keep-but-decouple** _(low)_: Keep gwApi /conversations, /conversations/recent, /conversations/search (server local-only). Update comments mentioning local+cloud merge.
  - [ ] L77-142 `createConversation` — **collapse-to-local** _(high)_: Remove storageMode arg, isCommunity (environment==='electron' && isCommunityMode), project storage-mode inference and mismatch validation; POST gwApi '/conversations' {userId,title,projectId,systemPrompt,conversationContext,cwd} (local). — ⚠ Without VITE_ENVIRONMENT this currently sends storageMode 'cloud' and relies on server fallback; every new chat flows here (QuickInput, ConversationPage, HomepageRedirect, Heimdall, sideBar). [verified]
  - [ ] L144-256 `updateConversation, deleteConversation, updateSystemPrompt, updateContext, updateResearchNote, updateCwd` — **collapse-to-local** _(medium)_: Drop storageMode args and storageModeQs suffix; keep gwApi paths /conversations/:id, /system-prompt, /context, /research-note, /cwd (local leg PATCHes /api/app/conversations/:id). — ⚠ Many callers pass storageMode (sideBar, Chat.tsx, Heimdall); TS errors will guide updates.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/projects/projectActions.ts`
  - [ ] L1-91 `fetchProjectById, createProject, updateProject, deleteProject` — **collapse-to-local** _(high)_: Remove StorageMode/isCommunityMode/environment; drop storageMode/storage_mode from payload types and the 'cloud' default in createProject; POST/PATCH/DELETE gwApi /projects (local -> /api/app/projects). — ⚠ createProject defaults to 'cloud' when VITE_ENVIRONMENT unset; HomepageRedirect bootstrap creates the default project through it. [verified]
  - [ ] L3,44-45 `createProject isCommunity` — **collapse-to-local** _(high)_: Lines 3-4,44-45: drop the isCommunityMode import and `environment` from the api import. Set storageMode:'local' in the POST body. Ignore payload.storageMode. — ⚠ Without .env this creates projects in the cloud today. [verified-changed: Correct, but the `environment` import is on line 4, not line 3.]
  - [ ] L4,44-45 `isCommunity / effectiveStorageMode default 'cloud'` — **collapse-to-local** _(high)_: Remove isCommunity; create projects as local unconditionally. — ⚠ Without .env, project creation defaults to storageMode 'cloud'. [verified]
- [ ] `ygg-chat/client/ygg-chat-r/src/features/search/searchActions.ts`
  - [ ] L1-59 `performSearch (/search), performProjectSearch (/search/project) via apiCall -> /api/cloud` — **delete-file** _(low)_: Delete thunks (proxy 403s /search; never dispatched - sideBar import commented). Remove extraReducers in searchSlice.ts:34-85 or replace with /app/conversations/search/top-level-users if search slice is wanted.
  - [ ] L7-60 `performSearch, performProjectSearch` — **rewrite** _(low)_: apiCall('/search') goes to /api/cloud/search, which is not in CLOUD_PROXY_ALLOWED_PREFIXES, so it returns 403. Rewrite to localApi /app/conversations/search (or gwApi /conversations/search). Delete it if nothing dispatches it beyond searchSlice.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/search/searchSlice.ts`
  - [ ] L3,34-85 `performSearch/performProjectSearch reducers` — **delete-code** _(low)_: Remove extraReducers and searchActions spread for deleted thunks.
- [ ] `ygg-chat/client/ygg-chat-r/src/helpers/userSystemPromptStorage.ts`
  - [ ] L6 `UserSystemPromptStorageMode` — **delete-code** _(low)_: Delete 'cloud'|'local' type once hook/useQueries stop importing it. Keep HostPrompt storage_mode:'local' normalization (schema validated server-side).
- [ ] `ygg-chat/client/ygg-chat-r/src/hooks/useConversationSnapshotCoordinator.ts`
  - [ ] L8,21,95,134 `accessToken passthrough` — **delete-code** _(medium)_: Stop reading accessToken from useAuth and passing it to the snapshot coordinator/fetchConversationMessagesTree. Remove it from conversationSnapshotCoordinator.ts:95,114,133 and the test mock at useConversationSnapshotCoordinator.test.ts:70. — ⚠ This is the hot path for loading every conversation. The change is mechanical, but the coordinator tests must still pass.
  - [ ] L16,94,134 `useConversationSnapshotCoordinator(conversationId, storageMode)` — **delete-code** _(low)_: Remove storageMode param + dependency; update Chat.tsx:3685 call.
- [ ] `ygg-chat/client/ygg-chat-r/src/hooks/useLoggingAnalytics.ts`
  - [ ] L4-5,44,174-190,211-232,234-246 `useCloudLoggingAnalytics (/api/cloud/analytics/dashboard), payments type, local env gate` — **delete-code** _(medium)_: Delete useCloudLoggingAnalytics + api/isCloudSession imports; local hook enabled via isHostClient (not environment==='electron'); drop source?:'cloud' and payments/providerRuns billing fields if server stub is removed too. — ⚠ Without VITE_ENVIRONMENT local analytics never load in Electron.
- [ ] `ygg-chat/client/ygg-chat-r/src/hooks/useQueries.ts`
  - [ ] L31,43,434-464 `isElectronCommunityMode/useConversationStorageMode` — **collapse-to-local** _(medium)_: Delete the local isElectronCommunityMode helper. useConversationStorageMode returns 'local' (or remove the hook and its Chat.tsx:3644 consumer). — ⚠ Chat.tsx uses this to route message fetches.
  - [ ] L31,35,39,43 `isCloudSessionEnabled/isCommunityMode/cloudApi/environment imports, isElectronCommunityMode` — **delete-code** _(low)_: Remove cloudApi, isCommunityMode, isCloudSessionEnabled imports and isElectronCommunityMode helper after branches below are collapsed.
  - [ ] L96-112 `useProject(projectId, storageMode)` — **collapse-to-local** _(low)_: Drop storageMode param and `?storageMode=` qs; gwApi.get('/projects/:id') local.
  - [ ] L417-468 `useConversationStorageMode` — **delete-code** _(low)_: Delete hook (cache scan + /app/conversations/:id + 'cloud' default). Remove Chat.tsx:254,3644 usage.
  - [ ] L536-575 `useConversationMessages storageMode + meta.storage_mode cache sync` — **delete-code** _(low)_: Remove storageMode param/accessToken passthrough and the useEffect that writes meta.storage_mode into ['conversations'] cache.
  - [ ] L536-573 `useConversationMessages storageMode param + meta.storage_mode cache sync` — **collapse-to-local** _(medium)_: Remove the storageMode param and the accessToken/queryClient options passed to fetchConversationMessagesTree. Delete the useEffect that writes meta.storage_mode into the ['conversations'] cache. Also revisit `enabled: !!userId`, since auth is being removed. — ⚠ This is the hot chat-open path. The gate on userId must still resolve once auth is gone.
  - [ ] L659-871 `useModels cloud fallback (/models, /models/gemini|anthropic|openai|openrouter) + userIsFreeTier` — **delete-code** _(medium)_: Delete isElectronCommunityMode block and cloudApi remote model list (802-863); unknown providers throw 'Provider not available'. Remove userIsFreeTier from all returns. Keep claude/lmstudio/openrouterbyok(/provider-auth/openrouter-byok/models)/zai/bedrock/openaichatgpt. — ⚠ Any stored provider 'openrouter'/'ollama' now errors; default provider selection must point at a kept provider (provider owner).
  - [ ] L873-926 `useRecentModels (/api/cloud/models/recent)` — **delete-code** _(low)_: Delete hook (Railway message history). Only commented-out usage in Chat.tsx:3486.
  - [ ] L928-1078 `ZdrModel, useZdrModels, useToggleSecretMode (/api/cloud/models/openrouter[/zdr])` — **delete-code** _(low)_: Delete ZDR/secret-mode hooks (cloud OpenRouter models). Remove QuickInput secret-mode UI. Optional later: reimplement ZDR against user's BYOK key.
  - [ ] L1080-1115 `ResearchNoteItem, useResearchNotes (/api/cloud/users/:id/research-notes)` — **rewrite** _(medium)_: Railway-only today (no local route). Derive locally: gwApi.get('/conversations?userId=') (SELECT * includes research_note) filtered to non-empty research_note mapped to ResearchNoteItem, or add GET /api/app/research-notes. — ⚠ Used by App.tsx (105,188), Homepage, ConversationPage LowBar; currently fails in no-account mode.
  - [ ] L1098-1112 `useResearchNotes (cloudApi /users/:id/research-notes)` — **rewrite** _(medium)_: This hook is cloud-only and has no local equivalent; App.tsx and ConversationPage use it. Add a local endpoint, e.g. GET /api/gw/research-notes?userId (SELECT id,title,research_note,updated_at,project_id FROM conversations WHERE research_note non-empty), and point the hook at gwApi. — ⚠ research_note is stored locally and the per-conversation PATCH is local. Without this, the notes list breaks (it 404s instead of today's unauthenticated Railway error).
  - [ ] L1117-1179 `useRefreshModels` — **delete-code** _(low)_: Delete (cloudApi /models/*; only commented-out usages).
  - [ ] L1181-1222 `useMoveConversationToProject mutationFn` — **collapse-to-local** _(low)_: Delete storage-mode cache scan and dynamic import of patchConversationProject (/api/gw via apiCall); always localApi.patch(`/conversations/${id}/project`,{projectId}) -> /api/conversations/:id/project (userProjectRoutes).
  - [ ] L1181-1220 `useMoveConversationToProject.mutationFn` — **collapse-to-local** _(high)_: storageMode defaults to 'cloud' and only uses localApi when storage_mode==='local' && isHostClient; otherwise calls patchConversationProject (legacy api -> API_BASE/VITE_API_URL or localhost:3001). Replace with unconditional localApi.patch(`/conversations/:id/project`) and drop cache scan. — ⚠ Moving chats between projects is a kept local feature; on a cache miss (or if isHostClient misresolves without VITE_ENVIRONMENT) it silently goes to the dead cloud endpoint today.
  - [ ] L1572-1576,1626-1662,1800-1823 `TopLevelUserMessageSearchHit.storage_mode, non-host gw search fallbacks` — **delete-code** _(low)_: Delete 'Non-electron fallback' gwApi /conversations/search branches (web product); host path /app/conversations/search[/top-level-users] stays. Drop storage_mode from hit type (server noteSearch still returns it; harmless).
  - [ ] L1893-1971 `UserSystemPromptCached.storage_mode, useUserSystemPromptsQuery, getUserSystemPromptsFromCache` — **collapse-to-local** _(medium)_: queryFn returns loadLocalUserSystemPrompts() only (delete cloudApi.get('/system-prompts') + isCloudSessionEnabled gate). getUserSystemPromptsFromCache returns local prompts only (drop cloud filter). — ⚠ Default system prompt auto-attach in send flow reads getDefaultUserSystemPromptFromCache.
  - [ ] L1913-1928 `useUserSystemPromptsQuery cloud merge` — **collapse-to-local** _(low)_: Always return loadLocalUserSystemPrompts(), and drop the cloudApi /system-prompts merge and the isCloudSessionEnabled check.
- [ ] `ygg-chat/client/ygg-chat-r/src/hooks/useUserSystemPrompts.ts`
  - [ ] L4,36,65-94,160-313,323 `canSaveToCloud/cloud default+save branches` — **collapse-to-local** _(medium)_: Remove canSaveToCloud, the savePromptStorage 'cloud' option, setDefaultUserSystemPrompt/clearDefaultUserSystemPrompt(accessToken) and the cloud save branch. Always save locally. — ⚠ SettingsPane and EditProject destructure canSaveToCloud and savePromptStorage, so update them in the same change.
  - [ ] L4-11,35-36,57-58,66,75-94,152-197,208-240,266-293,323 `canSaveToCloud, savePromptStorage, cloud create/setDefault/clearDefault` — **collapse-to-local** _(medium)_: Always use create/setDefault/clearDefaultLocalUserSystemPrompt; delete cloud branches, isCloudSessionEnabled, canSaveToCloud, savePromptStorage state + setter and their return fields. — ⚠ Shared by SettingsPane and EditProject prompt pickers; update both UIs in same change.
- [ ] `ygg-chat/client/ygg-chat-r/src/lib/localMirror.ts`
  - [ ] `localMirror (dualSync)` — **delete-file** _(low)_: Delete this fire-and-forget writer to /api/sync/*. Remove its callers: chatActions.ts:21 import, 1392 and 2035-2097; AuthContext.tsx:9, 108 and 128 (P3 auth removal).
- [ ] `ygg-chat/client/ygg-chat-r/src/utils/api.ts`
  - [ ] L2-3 `StorageMode/isCommunityMode imports` — **delete-code** _(low)_: Drop StorageMode and isCommunityMode imports after shouldUseLocalApi/assertCloudBackendAllowed are removed.
  - [ ] L3,170-173,367-372 `assertCloudBackendAllowed/shouldUseLocalApi` — **collapse-to-local** _(medium)_: Delete assertCloudBackendAllowed together with cloudApi (P5). Make shouldUseLocalApi return true for host clients regardless of storageMode, and drop the isCommunityMode import. — ⚠ The runtimeEnv list depends on VITE_ENVIRONMENT. Switch it to isHostClient so a missing .env still resolves local.
  - [ ] L154-172,365-372 `PUBLIC_API_ENDPOINT_PREFIXES, assertPublicEndpointAllowed, assertCloudBackendAllowed, shouldUseLocalApi` — **delete-code** _(low)_: Delete assertCloudBackendAllowed (isCommunityMode gate) and shouldUseLocalApi(storageMode) (only callers: chatActions deleteMessage dead var, a comment in conversationActions). Keep assertPublicEndpointAllowed only if publicApiCall survives for app store.
  - [ ] L154-171,731-797,801-878,883-952 `assertPublicEndpointAllowed, assertCloudBackendAllowed, apiCall, publicApiCall, api, createStreamingRequest` — **delete-code** _(medium)_: apiCall/createStreamingRequest send non-CRUD endpoints to /api/cloud and throw in community mode. Delete them after their consumers go: PaymentPage, searchActions, usersActions:39, useCloudLoggingAnalytics, iframeBridge streamCloudEphemeral. Delete publicApiCall once appStore uses localApi. — ⚠ publicApiCall currently serves the kept app store's non-electron browse path. Re-route that before deleting.
  - [ ] L364-371 `shouldUseLocalApi` — **delete-code** _(low)_: Delete shouldUseLocalApi (it reads storageMode, isCommunityMode and the env string). The only consumer is chatActions.ts:1376 deleteMessage, where the result is discarded (`void isLocalMode`).
  - [ ] L662-683 `makeLocalGateway, gwApi, cloudApi` — **rewrite** _(high)_: Keep gwApi (/gw) and fix the doc comment. Delete cloudApi only after its consumers are gone: system-prompts 1031-1056, stripe 1107-1146, Settings Drive 546/2419/2456, AuthContext 118, chatActions 2375/3383, useQueries 827/892/960/988/1032/1107/1155/1927, and the '/cloud' fallback in apiCall/createStreamingRequest. — ⚠ gwApi carries all local CRUD plus lineage reads. Removing cloudApi before its consumers fails the build. Settings Google Drive OAuth exists only through /api/cloud and goes away with it. [verified-changed: Keeping gwApi is correct. lineageRoutes.ts also mounts local-only /api/gw/* routes that ChatSelectionProvider uses. Deleting cloudApi is not a single edit, though. It still has about 25 live consumers]
  - [ ] L954-1003 `getConversationSystemPrompt, getConversationContext, patchConversation*, cloneConversation` — **delete-code** _(medium)_: All unused except patchConversationProject (useQueries move) and cloneConversation (sideBar). Replace move with localApi.patch('/conversations/:id/project'); cloneConversation hits /api/gw/conversations/:id/clone which no server route implements (see open question). Delete the rest. — ⚠ Copy-conversation is already broken locally (no clone route); removal must not leave sideBar calling a missing helper.
  - [ ] L954-1002 `getConversationSystemPrompt, getConversationContext, patchConversation*, cloneConversation` — **delete-code** _(low)_: Delete these unreferenced helpers built on `api`/apiCall. They throw in community mode, and /gw has no /clone route. conversationActions thunks already cover these operations through gwApi.
  - [ ] L1005-1056 `UserSystemPrompt API (get/create/update/setDefault/delete/clearDefault)` — **delete-code** _(low)_: All hit /api/cloud/system-prompts (Railway). Delete; local prompts live in host prompt store (/api/host/prompts via helpers/userSystemPromptStorage). Move UserSystemPrompt type to userSystemPromptStorage/HostPrompt if still needed.
  - [ ] L1027-1056 `getUserSystemPrompts..clearDefaultUserSystemPrompt (cloudApi /system-prompts)` — **delete-code** _(low)_: Delete the Railway-backed user system-prompt CRUD and its payload types. User prompts are already stored locally (helpers/userSystemPromptStorage.ts, useQueries loadLocalUserSystemPrompts).
- [ ] `ygg-chat/client/ygg-chat-r/src/utils/iframeBridge.ts`
  - [ ] L392-420,590 `streamCloudEphemeral` — **collapse-to-local** _(medium)_: Delete streamCloudEphemeral (createStreamingRequest '/generate/ephemeral' -> /api/cloud). Line 590 should always call streamLocalHeadless. — ⚠ App iframes (kept app store/custom apps) use this generation bridge. The local headless path must cover every host client.
- [ ] `ygg-chat/shared/headlessApi.ts`
  - [ ] L53 `HeadlessChatRequest.storageMode` — **delete-code** _(low)_: Remove storageMode field after openRouterProvider/chatRoutes stop reading it.

### P6 — Web target, marketing pages, payments, analytics (92)

- [ ] `ygg-chat/client/ygg-chat-r/public/blogs/000-seed-planted.html`
  - [ ] `blog post` — **delete-file** _(low)_: Only BlogPage loads it; delete it.
- [ ] `ygg-chat/client/ygg-chat-r/public/blogs/001-recursive-loop.html`
  - [ ] `blog post` — **delete-file** _(low)_: Only BlogPage loads it; delete it.
- [ ] `ygg-chat/client/ygg-chat-r/public/blogs/index.json`
  - [ ] `marketing blog index` — **delete-file** _(low)_: Delete public/blogs/ (index.json, 000-seed-planted.html, 001-recursive-loop.html) with BlogPage.tsx; Vite copies public/ into dist-electron so they currently ship in the app.
- [ ] `ygg-chat/client/ygg-chat-r/public/landingtest.html`
  - [ ] `landing prototype` — **delete-file** _(low)_: Unreferenced marketing prototype (Tailwind CDN plus Google Fonts) shipped in public/; delete it.
- [ ] `ygg-chat/client/ygg-chat-r/server/routes/managedOAuthRoutes.ts`
  - [ ] L98 `isFreeTier: false (Codex model list)` — **delete-code** _(low)_: Remove isFreeTier from the Codex model descriptor. Codex OAuth routes are otherwise kept unchanged (codex slot only).
- [ ] `ygg-chat/client/ygg-chat-r/src/App.tsx`
  - [ ] L2,401 `Analytics (@vercel/analytics/react)` — **delete-code** _(low)_: Delete `import { Analytics } from '@vercel/analytics/react'` and the `{!isHostClient && <Analytics />}` render. Nothing else in src uses Vercel analytics.
  - [ ] L18-34,53-79 `containers import; TOOL_VIEWER_HIDDEN_ROUTES; RIGHTBAR_HIDDEN_ROUTES` — **delete-code** _(low)_: Drop BlogPage, FAQPage, LandingPage, PaymentPage, PaymentPlans, PrivacyPolicy, RefundPolicy, TermsOfService from the import. Remove '/landingpage','/faq','/paymentplan','/payment','/terms','/refund-policy','/privacy','/blog' from both hidden-route Sets ('/login' goes with P3).
  - [ ] L51,53-79 `Router/TOOL_VIEWER_HIDDEN_ROUTES/RIGHTBAR_HIDDEN_ROUTES` — **delete-code** _(low)_: Remove '/login', '/landingpage', '/faq', '/paymentplan', '/payment', '/terms', '/refund-policy', '/privacy' and '/blog' from the hidden-route sets. Once the web target is gone isHostClient is always true, so use HashRouter only.
  - [ ] L226-241,296-303 `AnimatedRoutes public marketing routes + /payment route` — **delete-code** _(medium)_: Delete the Route elements for /landingpage, /faq, /paymentplan, /terms, /refund-policy, /privacy, /blog and the ProtectedRoute /payment. The '*' fallback already sends stale links to '/'. — ⚠ sideBar/Homepage 'Profile', Chat/QuickInput 'Subscribe' buttons, the 'upgrade' error actions and FreeGenerationsModal navigate here. Remove them in the same change, or they fall through to '/'.
  - [ ] L251 `Route path='/'` — **rewrite** _(medium)_: Replace `isHostClient ? <Navigate to='/login'/> : <LandingPage/>` with `<Navigate to='/homepage' replace />` for every target. Coordinate with P3, which removes /login. — ⚠ Non-host builds (BUILD_TARGET=local without VITE_ENVIRONMENT) render LandingPage today. scripts/test-browser-client.cjs expects the #/login route.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/ExpandedModelView/ExpandedModelView.tsx`
  - [ ] L124-140,284,318-320 `BASE_PROMPT_COST / formatPricing credits multipliers; lock icon` — **rewrite** _(low)_: Pricing shown as multipliers of a credits base cost (1.25 credits/1M). Replace with USD per 1M tokens (promptCost*1e6) or drop the column; lock icon only fires via free-tier disabledOptions which becomes always empty.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/FreeGenerationsModal/FreeGenerationsModal.tsx`
  - [ ] `FreeGenerationsModal` — **delete-file** _(low)_: Delete the unused free-generations modal (its upgrade button navigates to /payment) and its export at src/components/index.ts:10.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/FreeGenerationsModal/index.ts`
  - [ ] `FreeGenerationsModal barrel` — **delete-file** _(low)_: Delete with FreeGenerationsModal.tsx (no consumers).
- [ ] `ygg-chat/client/ygg-chat-r/src/components/GlobalNotifications/GlobalNotifications.tsx`
  - [ ] L48,98-100 `isActionable 'upgrade' + navigate('/paymentplan')` — **rewrite** _(low)_: Remove the 'upgrade' kind from the actionable set and its case (navigate('/paymentplan')), in step with removing the 'upgrade' kind from shared/chatErrors.ts.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/InputTextArea/InputTextArea.tsx`
  - [ ] L190-194 `shouldUseLocalFileFallback` — **collapse-to-local** _(low)_: Drop the `import.meta.env.VITE_ENVIRONMENT !== 'web' &&` term.
  - [ ] L192 `shouldUseLocalFileFallback VITE_ENVIRONMENT !== 'web'` — **collapse-to-local** _(low)_: Drop the `import.meta.env.VITE_ENVIRONMENT !== 'web' &&` term.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/ModelInfoModal/ModelInfoModal.tsx`
  - [ ] L79-90 `'Pricing (per 1M tokens) in credits'` — **rewrite** _(low)_: Retitle to 'Pricing (USD per 1M tokens)' and compute promptCost/completionCost * 1e6 instead of * 1e8 (credit scaling).
- [ ] `ygg-chat/client/ygg-chat-r/src/components/ModelSelectControl/ModelSelectControl.tsx`
  - [ ] L40-54 `userIsFreeTier / disabledModelOptions / free-first sorting` — **delete-code** _(low)_: Remove the userIsFreeTier logic. disabledModelOptions becomes [] and sortedFilteredModels becomes filteredModels.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/QuickInput/QuickInput.tsx`
  - [ ] L13,24-31,45-73,167-173,369 `useSubscriptionStatus/isFreeUser/hasCredits/showSecretMode; Secret Mode (ZDR) footer; Subscribe button` — **rewrite** _(medium)_: Remove useSubscriptionStatus, the cached_current_credits gate and the 'Subscribe now' navigate('/payment') branch. Secret Mode calls cloudApi /models/openrouter/zdr (useToggleSecretMode), so delete it too. footerContent becomes undefined. — ⚠ QuickInput renders in LowBar on the local homepage. Keep model select and send working. Coupled with the cloud-openrouter area removing useToggleSecretMode.
  - [ ] L24-31,54 `isFreeUser/cached_current_credits/showSecretMode` — **collapse-to-local** _(low)_: Remove useSubscriptionStatus and the credits check. Set showSecretMode=true. Also review currentProvider default 'OpenRouter' (line 37).
- [ ] `ygg-chat/client/ygg-chat-r/src/components/Select/Select.tsx`
  - [ ] L404-407 `title 'Upgrade to access this model' + LockKeyhole` — **rewrite** _(low)_: Disabled-option tooltip hardcodes free-tier upsell. Replace with a caller-supplied disabledReason prop (or generic 'Unavailable'). Chat.tsx L7685 disables 'Claude Code' with this same wrong tooltip.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/SettingsPane/SettingsPane.tsx`
  - [ ] L270,655-659,2645 `isWebMode (managed hooks fetch + Hooks section)` — **collapse-to-local** _(medium)_: Delete `const isWebMode`. The effect becomes `if (hooksExpanded) fetchManagedHooks()`, with isWebMode dropped from deps. Unwrap the `{!isWebMode && (...)}` at 2645 so the Hooks section always renders. — ⚠ The Hooks settings section is a kept local feature. Unwrap it carefully.
  - [ ] L270,656,659,2645 `isWebMode` — **collapse-to-local** _(low)_: Delete `const isWebMode`. Drop `&& !isWebMode` at 656 and the dep at 659. Unwrap `{!isWebMode && (...)}` at 2645 (managed hooks section always shown).
- [ ] `ygg-chat/client/ygg-chat-r/src/components/SettingsPane/ToolsSettings.test.tsx`
  - [ ] L30 `vi.stubEnv('VITE_ENVIRONMENT','electron')` — **update-test** _(low)_: Remove the VITE_ENVIRONMENT stub (and unstubAllEnvs if unused) once ToolsSettings no longer reads it. Keep the source-group assertions.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/SettingsPane/ToolsSettings.tsx`
  - [ ] L33,39-54,145-155,158 `isWebMode` — **collapse-to-local** _(medium)_: Delete `const isWebMode`. Fetch /custom-tools/directory unconditionally (deps []). Unwrap `{!isWebMode && (` at 158 and delete the commented WSL block at 145-155. — ⚠ The custom tools list is a kept feature. If unwrapping goes wrong, the tool list disappears.
  - [ ] L33,42,54,145,158 `isWebMode` — **collapse-to-local** _(low)_: Delete `const isWebMode`. Fetch /custom-tools/directory unconditionally (42). Empty the deps (54). Unwrap the `!isWebMode &&` blocks at 145 and 158.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/TextArea/TextArea.tsx`
  - [ ] L142-145 `shouldUseLocalFileFallback` — **collapse-to-local** _(low)_: Drop the `import.meta.env.VITE_ENVIRONMENT !== 'web' &&` term.
  - [ ] L143 `shouldUseLocalFileFallback VITE_ENVIRONMENT !== 'web'` — **collapse-to-local** _(low)_: Drop the `import.meta.env.VITE_ENVIRONMENT !== 'web' &&` term.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/index.ts`
  - [ ] L10 `export { FreeGenerationsModal }` — **delete-code** _(low)_: Remove the FreeGenerationsModal re-export.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/landing/AsciiBackground.tsx`
  - [ ] `AsciiBackground` — **delete-file** _(low)_: Landing-only component; delete it with LandingPage.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/landing/ChatDemo.tsx`
  - [ ] `ChatDemo` — **delete-file** _(low)_: Landing-only component; delete it.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/landing/Comparison.tsx`
  - [ ] `Comparison` — **delete-file** _(low)_: Landing-only component; delete it.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/landing/Economics.tsx`
  - [ ] `Economics` — **delete-file** _(low)_: Landing-only pricing/economics section; delete it.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/landing/Features.tsx`
  - [ ] `Features` — **delete-file** _(low)_: Landing-only component; delete it.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/landing/Footer.tsx`
  - [ ] `Footer` — **delete-file** _(low)_: Landing footer (links /terms, /refund-policy, /privacy, x.com and a Discord invite); delete it.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/landing/Hero.tsx`
  - [ ] `Hero` — **delete-file** _(low)_: Landing-only component; delete it.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/landing/Logo.tsx`
  - [ ] `Logo` — **delete-file** _(low)_: Landing-only inline SVG logo (used by Navbar and Footer); delete it.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/landing/Navbar.tsx`
  - [ ] `Navbar` — **delete-file** _(low)_: Landing navbar (links /faq, /paymentplan, /blog); delete it.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/landing/ScrollReveal.tsx`
  - [ ] `ScrollReveal` — **delete-file** _(low)_: Landing-only helper; delete it.
- [ ] `ygg-chat/client/ygg-chat-r/src/constants/pricingData.ts`
  - [ ] `PLANS/PRICING_FEATURES/TIER_INFOS/getFeaturesForPlan` — **delete-file** _(low)_: Delete the pricing constants. Consumers: PaymentPage, PaymentPlans, payments/none and stripe, all deleted.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/BlogPage.tsx`
  - [ ] `BlogPage` — **delete-file** _(low)_: Delete the blog page that fetches /blogs/index.json and /blogs/<slug>.html.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/Chat.tsx`
  - [ ] L259,1060-1075 `useSubscriptionStatus/modelSelectFooter` — **delete-code** _(low)_: Remove the useSubscriptionStatus import and call, plus the 'Subscribe now for access to all 400+ models' footer that navigates to /payment. Set footerContent at 7701 to undefined.
  - [ ] L259,1060-1074,7701 `useSubscriptionStatus import; modelSelectFooter 'Subscribe now for access to all 400+ models'` — **delete-code** _(medium)_: Remove the import, the isFreeUser hook call and the modelSelectFooter JSX (navigate('/payment')). Drop the footerContent={modelSelectFooter} prop at 7701, or pass undefined. — ⚠ Chat.tsx is the core local chat container. Change only the footer and leave the model selector intact.
  - [ ] L5607-5612 `handleChatErrorAction case 'upgrade'` — **rewrite** _(medium)_: Remove the 'upgrade' case that does navigate('/payment'), or map it to navigate('/settings'), together with removal of the 'upgrade' kind in shared/chatErrors.ts. — ⚠ A 402 from a user's own provider (e.g. openrouterbyok) currently classifies as subscription_inactive and gets the 'upgrade' action. That action must still lead somewhere useful.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/ConversationPage.tsx`
  - [ ] L39,190,510,524-539,1005 `DownloadAppModal import/state/web-only Download button` — **delete-code** _(low)_: Delete the DownloadAppModal import, the showDownloadModal state, the stale comment at 510, the `VITE_ENVIRONMENT==='web'` Download button block and the <DownloadAppModal/> render.
  - [ ] L39,190,510,525-540,1005 `Download App button + DownloadAppModal` — **delete-code** _(low)_: Delete the DownloadAppModal import, the showDownloadModal state, the stale comment at 510, the `{VITE_ENVIRONMENT === 'web' && <Button ...download>}` block 525-540, and the modal render at 1005.
  - [ ] L39,190,525-540,1005 `DownloadAppModal (VITE_ENVIRONMENT==='web' button)` — **delete-code** _(low)_: Remove import, showDownloadModal state, the VITE_ENVIRONMENT==='web' Download App button and modal render.
  - [ ] L510,525-540 `web Download App button` — **delete-code** _(low)_: Delete the `VITE_ENVIRONMENT === 'web'` Download App button, its comment, showDownloadModal state and DownloadApp modal usage.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/FAQPage.tsx`
  - [ ] `FAQPage` — **delete-file** _(low)_: Delete the marketing FAQ page (/faq).
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/Homepage.tsx`
  - [ ] `Homepage (unrouted)` — **delete-file** _(low)_: Dead code: /homepage renders HomepageRedirect, and nothing routes Homepage. It holds web download button (247-268), /payment Profile item (546-556), DownloadAppModal, cloud/local storage filter, and VITE_ENVIRONMENT electron check (53-55). Delete the file.
  - [ ] L20,69,231,247-265,567 `Download App button/tooltip + DownloadAppModal` — **delete-code** _(low)_: Delete the DownloadAppModal import, the showDownloadModal state, the stale comment at 231, the `{VITE_ENVIRONMENT === 'web' && (...)}` download block from 247, and the modal render at 567 (downloadApp.tsx is being deleted).
  - [ ] L20,69,250-262,567 `DownloadAppModal / showDownloadModal / 'Download our desktop app!' button` — **delete-code** _(low)_: Remove the web-only download-the-app button/tooltip, state and modal (fetches from auth.yggchat.com updates bucket via downloadApp.tsx).
  - [ ] L231,247-270 `web 'Download our desktop app!' block` — **delete-code** _(low)_: Delete the `VITE_ENVIRONMENT === 'web'` download CTA, comment and download modal wiring.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/LandingPage.tsx`
  - [ ] `LandingPage (incl. Supabase updates-bucket MANIFEST_URLS download popup)` — **delete-file** _(low)_: Delete the marketing landing page. It also fetches latest*.yml from the auth.yggchat.com Supabase updates bucket (lines 20-25, 112-170) for its download popup.
  - [ ] L20,113,307 `web-only download popup / BASE_URL Supabase updates` — **delete-file** _(low)_: Delete landing page (VITE_ENVIRONMENT==='web' checks and Supabase updates BASE_URL).
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/PaymentPage.tsx`
  - [ ] `PaymentPage (subscription/credits/account delete; opens https://yggchat.com/payment)` — **delete-file** _(medium)_: Delete it: getPaymentProvider, Stripe checkout, cancelSubscription, the cloud DELETE /user/account, and the external yggchat.com/payment link. There is no local functionality to keep. — ⚠ Doubles as the 'Profile' page: sideBar profile item and the Homepage mobile menu navigate('/payment'). Repoint or remove those first.
  - [ ] L44-47 `isLocalOrElectron (__IS_ELECTRON__/__IS_LOCAL__/VITE_ENVIRONMENT)` — **delete-file** _(low)_: Delete page (also hardcodes https://yggchat.com/payment at 127).
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/PaymentPlans.tsx`
  - [ ] `PaymentPlans` — **delete-file** _(low)_: Delete the public pricing page (uses PLANS/PRICING_FEATURES from pricingData).
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/PrivacyPolicy.tsx`
  - [ ] `PrivacyPolicy` — **delete-file** _(low)_: Delete the hosted-service privacy policy page (Stripe/analytics processors).
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/RefundPolicy.tsx`
  - [ ] `RefundPolicy` — **delete-file** _(low)_: Delete the Stripe refund policy page.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/TermsOfService.tsx`
  - [ ] `TermsOfService` — **delete-file** _(low)_: Delete the hosted-service ToS page (Stripe/subscription terms; links /refund-policy and /privacy).
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/downloadApp.tsx`
  - [ ] `DownloadAppModal` — **delete-file** _(low)_: Delete the web-only 'download desktop app' modal. It reads latest*.yml from the Supabase updates bucket (BASE_URL line 4) and renders only when VITE_ENVIRONMENT==='web'.
  - [ ] L4,45-50,94 `DownloadApp isWebMode / Supabase BASE_URL` — **delete-file** _(low)_: Delete component and its usages in Homepage/ConversationPage.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/index.ts`
  - [ ] L1,4,6,9,10,11,13,16,17,19 `barrel exports BlogPage/Homepage/LandingPage/PaymentPage/PaymentPlans/PrivacyPolicy/RefundPolicy/TermsOfService/DownloadAppModal/FAQPage` — **delete-code** _(low)_: Remove re-exports of deleted containers. Keep AppStoreModal (line 18). The Login export (line 7) belongs to P3.
  - [ ] L17 `export { DownloadAppModal }` — **delete-code** _(low)_: Remove barrel export when downloadApp.tsx is deleted.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/rightBar.tsx`
  - [ ] L220,358,404,660,1026,1066,1178,1250,1287,1316,1320,1375,1409,1427,1440,1569,1573,1589,1602,1608,1613,1619,1788,1827,1834,1849,1852,1867,2240,2249,2322,2523,2635,2672,2694,2741,3048,3143,3322,3333 `isWeb` — **collapse-to-local** _(high)_: Delete `const isWeb` and treat it as false: drop the `isWeb ||` guards, the `!isWeb &&` wrappers, `disabled={isWeb}` and isWeb in dep arrays. Use 'h-full' at 2249. Git tab is always available (660). — ⚠ Shared with the kept local workspace (terminal, LSP, git, file editor, browser dock). Invert each guard carefully, or local tabs will break. [verified]
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/sideBar.tsx`
  - [ ] L789,825-834,2013 `isWeb / visibleProjects web bypass / h-[100vh] rail` — **collapse-to-local** _(medium)_: Delete `const isWeb`. visibleProjects always applies the LOCAL_MODE_RECENT_PROJECTS_LIMIT filter (drop the isWeb dep). Use 'h-full' unconditionally at 2013. — ⚠ visibleProjects also branches on storage_mode !== 'local'. Simplify it together with the P5 storage-mode cleanup so the local project cap stays correct.
  - [ ] L789,826,834,2013 `isWeb` — **collapse-to-local** _(low)_: Delete `const isWeb`. Remove `if (isWeb) return projectData` (826) and isWeb from the deps (834). Use 'h-full' at 2013.
  - [ ] L1640-1647 `sidebar action 'profile' -> navigate('/payment')` — **delete-code** _(low)_: Remove the 'Profile' rail item (User icon), since its target is the deleted PaymentPage. Alternatively repoint it to /settings (open question). Drop the User import if it becomes unused.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/LMStudio.ts`
  - [ ] L63 `isFreeTier: true` — **delete-code** _(low)_: Drop isFreeTier when Model.isFreeTier (shared/types.ts L154) is removed; ModelSelectControl free/paid sorting only applies when userIsFreeTier which becomes always false.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/chatSelectionBoundary.test.ts`
  - [ ] L8 `callers list 'containers/Homepage.tsx'` — **update-test** _(low)_: Remove 'containers/Homepage.tsx' from the callers array once Homepage.tsx is deleted. Otherwise readFileSync throws ENOENT.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/chatSlice.ts`
  - [ ] L298-302,2023-2032,310-314,2105-2129 `freeTier state + freeGenerationsUpdated/freeTierLimitModal*; userSystemPrompts slice` — **delete-code** _(low)_: Delete freeTier state and reducers (Chat.tsx notes flag is dead). Delete userSystemPrompts Redux slice + reducers (only producer was fetchUserSystemPrompts; UI reads React Query).
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/chatTypes.ts`
  - [ ] L171,559-565,737-755 `'free_generations_update' event type, freeTier, UserSystemPrompt(s)State` — **delete-code** _(low)_: Remove free_generations_update from event union, freeTier field and userSystemPrompts state types matching slice removal.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/chatgptAccount.ts`
  - [ ] L43 `isFreeTier: false (ChatGPT model descriptor)` — **delete-code** _(low)_: Remove isFreeTier field from the descriptor with the Model type change. Rest of file (Codex account) kept.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/sseProjection.ts`
  - [ ] L538-547 `projectServerEvent free_generations_update / generation_limit_reached` — **delete-code** _(low)_: Delete both cases (Railway free-tier relay). Remove 'free_tier_exhausted' envelope use if chatErrors owner removes the code.
- [ ] `ygg-chat/client/ygg-chat-r/src/hooks/useIdeContext.ts`
  - [ ] L131-133,157-160 `VITE_ENVIRONMENT web checks in requestFileContent/connect` — **collapse-to-local** _(low)_: Always console.warn when the WebSocket is not connected, and delete the `if (VITE_ENVIRONMENT==='web') return` early exit in connect().
  - [ ] L131,158-160 `VITE_ENVIRONMENT web checks` — **collapse-to-local** _(low)_: Make the console.warn at 131 unconditional and delete the `if (VITE_ENVIRONMENT === 'web') return` at 158-160 in connect().
- [ ] `ygg-chat/client/ygg-chat-r/src/hooks/useQueries.ts`
  - [ ] L2051,2092 `local file listing/search enabled: environment !== 'web'` — **collapse-to-local** _(low)_: Remove `&& environment !== 'web'` from both `enabled` expressions.
- [ ] `ygg-chat/client/ygg-chat-r/src/hooks/useSubscriptionStatus.ts`
  - [ ] `useSubscriptionStatus/isFreeUser` — **delete-file** _(medium)_: Delete it. With NoOp provider it always reports isFreeUser=true, so Electron shows 'Subscribe now' footers. Remove its call sites in Chat.tsx and QuickInput.tsx. — ⚠ Two live UI consumers must be edited in the same change.
- [ ] `ygg-chat/client/ygg-chat-r/src/hooks/useToolJobs.ts`
  - [ ] L24-25,105-108,249-258 `isWebMode` — **collapse-to-local** _(medium)_: Delete the isWebMode const and its three `if (isWebMode) return` guards. Initial refresh and onJobsChange subscription run unconditionally. Update the comments. — ⚠ Tool job monitoring is a kept local feature; behavior is unchanged in Electron today.
  - [ ] L25,107,251,257 `isWebMode` — **collapse-to-local** _(low)_: Delete the module-level isWebMode and the three `if (isWebMode) return` early exits.
- [ ] `ygg-chat/client/ygg-chat-r/src/lib/payments/index.ts`
  - [ ] `getPaymentProvider/resetPaymentProvider (__IS_WEB__ branch)` — **delete-file** _(low)_: Delete the payment provider factory. Its only consumers are PaymentPage and useSubscriptionStatus, both deleted.
  - [ ] L19-26,37-39,45-63 `payment provider factory (__IS_WEB__/__IS_LOCAL__/__BUILD_TARGET__/VITE_ENVIRONMENT)` — **delete-file** _(low)_: Delete src/lib/payments/* (index, stripe, none, types); last consumers of __IS_WEB__.
- [ ] `ygg-chat/client/ygg-chat-r/src/lib/payments/none.ts`
  - [ ] `NoOpPaymentProvider` — **delete-file** _(low)_: Delete it. Its tier:null result is what makes isFreeUser=true in Electron, which shows the 'Subscribe' buttons.
- [ ] `ygg-chat/client/ygg-chat-r/src/lib/payments/stripe.ts`
  - [ ] `StripePaymentProvider` — **delete-file** _(low)_: Delete it. It only used isCommunityMode to throw, plus /cloud/stripe/* via the local proxy. Delete lib/payments/* along with PaymentPage and useSubscriptionStatus.
- [ ] `ygg-chat/client/ygg-chat-r/src/lib/payments/types.ts`
  - [ ] `SubscriptionStatus/TierInfo/CreditHistoryEntry/PaymentProvider` — **delete-file** _(low)_: Delete payment types. pricingData.ts imports TierInfo from here and is deleted too.
- [ ] `ygg-chat/client/ygg-chat-r/src/services/ToolJobManager.ts`
  - [ ] L544-545 `auto-initialize guard VITE_ENVIRONMENT !== 'web'` — **collapse-to-local** _(low)_: Change the condition to `typeof window !== 'undefined'` only, and update the comment.
- [ ] `ygg-chat/client/ygg-chat-r/src/utils/api.ts`
  - [ ] L1058-1147 `SubscriptionStatus, TierInfo, PricingInfo, CreditTransaction, createCheckoutSession, getSubscriptionStatus, cancelSubscription, getCreditHistory, getPricingInfo` — **delete-code** _(low)_: Stripe helpers via /api/cloud/stripe/*; grep shows no importers (PaymentPage uses lib/payments provider). Delete block.
- [ ] `ygg-chat/client/ygg-chat-r/vite.config.ts`
  - [ ] L116-133 `manualChunks (stripe chunk, Supabase comment)` — **delete-code** _(low)_: Delete the `stripe` manualChunk branch (it also catches any id containing 'stripe', e.g. strip-markdown? no, but stripe substring) and the Supabase comments; keep vendor/static-reach logic.
- [ ] `ygg-chat/shared/chatErrors.ts`
  - [ ] L29,33,36,169-173,185-203 `session_expired (sign_in), free_tier_exhausted / subscription_inactive (upgrade)` — **keep-but-decouple** _(medium)_: Once providerErrorFormatter stops emitting them, either remove these codes and the 'sign_in'/'upgrade' action kinds, or repoint their actions to open_settings. Keep the union members if persisted error rows reference them. — ⚠ Renderer consumers (localChatErrors 144/183, sseProjection 547/555, mainChatClient 409, api.ts 728) also map 401 to session_expired. The P3/P6 owners must change them together.
  - [ ] L76,184-189,200-204 `ChatErrorActionKind 'upgrade'; free_tier_exhausted / subscription_inactive defaults` — **rewrite** _(medium)_: Remove the 'upgrade' kind. subscription_inactive (HTTP 402 from the user's own provider) becomes action open_settings with a provider-billing message. free_tier_exhausted is removed by the free-tier area. — ⚠ Shared by the server providerErrorFormatter and renderer sseProjection. Update providerErrorFormatter.test.ts and sseProjection.test.ts:489 expectations.
- [ ] `ygg-chat/vercel.json`
  - [ ] `Vercel deployment config` — **delete-file** _(low)_: Delete the Vercel config. It deploys client/ygg-chat-r/dist via build:client with SPA rewrites for the web product.

### P7 — Community app store (keep; decouple from auth/env) (32)

- [ ] `ygg-chat/client/ygg-chat-r/server/localServer.ts`
  - [ ] L1714 `CORS allowedHeaders 'x-app-store-filename'` — **keep-but-decouple** _(low)_: Remove the header only if both upload and validate-upload are deleted. Otherwise keep it.
- [ ] `ygg-chat/client/ygg-chat-r/server/routes/appStoreRoutes.ts`
  - [ ] L1-7,24-32,264-274,495-620,622+ `REMOTE_API_BASE (Railway) + GET community proxy + install/uninstall/restart` — **keep-but-decouple** _(medium)_: Keep the anonymous GET /api/app-store/community proxy to the hardcoded Railway base. It must not depend on railwayClient or gatewayFlags. Keep install/uninstall/restart. Update the header comment to drop 'upload'. — ⚠ It is the only remaining Railway call. P2 must not delete REMOTE_API_BASE when it removes railwayClient.
  - [ ] L1-7,315-493 `POST /api/app-store/validate-upload + header comment` — **delete-code** _(medium)_: Delete the validate-upload route (only consumer is validateCommunityAppUpload, which is being removed). Keep the zip helpers that install (496+) still uses, e.g. sanitizeZipEntryName/extract. Update the header comment to drop 'zip upload validation' and 'community proxy upload'. — ⚠ Helpers in lines 18-255 are shared with /install. Delete only the ones validate-upload uses exclusively, and confirm with tsc noUnusedLocals.
  - [ ] L9,276-311 `POST /api/app-store/community/upload (Bearer from getAuthManager().resolve('app'))` — **keep-but-decouple** _(medium)_: Flag: the upload proxy needs a Supabase app-session JWT for Railway. Once the app slot is gone it always fails (resolve throws, which becomes a 500). Return 501 'Upload requires a Graviton account (unavailable in local build)', or remove the upload UI. Browse/install (REMOTE_API_BASE, line 25) stay anonymous. — ⚠ The app store is kept by user decision. Browse/install must not touch getAuthManager. Verify the other routes in this file are anonymous (only line 287 uses the app slot).
  - [ ] L9,276-313 `getAuthManager import; POST /api/app-store/community/upload (Bearer from resolve('app'))` — **delete-code** _(high)_: Delete the upload proxy route and the getAuthManager import. It forwards the Supabase app-session JWT to Railway. Note the `if (!authHeader)` guard is dead code: the template string is always truthy. — ⚠ Must be removed before P3 removes the 'app' AuthSlot from server/auth, or the server fails to compile. [verified]
  - [ ] L25,264-313 `REMOTE_API_BASE / community upload proxy` — **keep-but-decouple** _(medium)_: Keep hardcoded Railway REMOTE_API_BASE for anonymous GET /app-store/community. Upload (276-313) resolves the Supabase 'app' credential; remove or return 501 once auth slot 'app' is gone. — ⚠ getAuthManager().resolve('app') will throw after P3; ensure browse/install paths don't touch it.
  - [ ] L276-312 `POST /api/app-store/community/upload` — **delete-code** _(medium)_: Upload forwards getAuthManager().resolve('app').accessToken (the Supabase session) to Railway. Delete the route, or return 501, once app auth is gone. Browse (265-274) and install (496+) are anonymous and stay. — ⚠ Per decision 2, flagged as an auth-requiring app-store part.
  - [ ] L287 `app-store upload Bearer from getAuthManager().resolve('app')` — **keep-but-decouple** _(medium)_: Upload needs a Supabase app session, which goes away. Return 401/410 'Uploading requires an account (unavailable in local mode)' without calling resolve('app'). Browse and install must stay anonymous. — ⚠ The app store is kept. Only the upload path depends on the removed auth. Line 288's !authHeader check is dead because the string is always truthy.
  - [ ] L315-493 `POST /api/app-store/validate-upload` — **keep-but-decouple** _(low)_: Purely local zip validation. Delete it with upload, or keep it as an offline 'validate my app package' tool (open question).
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/appStore.tsx`
  - [ ] L3,129,133,475-477,522-529,921,935-943 `uploadRequiresCloudLogin/handleUploadLoginRequired` — **rewrite** _(medium)_: Remove navigate('/login?required=cloud') and the 'you need to sign in' link. Hide the Upload panel, or show it disabled with 'Publishing is unavailable in local mode'. Change isElectron to isNativeShell. — ⚠ The /login route is deleted, so the link would loop to home.
  - [ ] L3,19,129,133,475-477,523-529,921,935-941 `isElectron/uploadRequiresCloudLogin/handleUploadLoginRequired` — **rewrite** _(high)_: isElectron = isNativeShell, not environment==='electron'. Hide the upload UI or show 'upload unavailable' instead of navigating to /login?required=cloud. Drop the isCommunityMode import. — ⚠ Without .env, isElectron is false today, which disables install and upload in Electron builds. /login is being removed.
  - [ ] L3,19,129 `isCommunityMode import; environment import; isElectron = environment === 'electron'` — **keep-but-decouple** _(medium)_: Remove the isCommunityMode/environment imports. Replace isElectron (129) with `const canInstall = isNativeShell` and use it at 236,259,365,413,421,455,803,995,1331,1362,1400. Delete uploadRequiresCloudLogin (133). The upload sites 490,519,860-862,921 are removed with the upload UI. — ⚠ With isHostClient, browser-client would get install buttons for host-side code. The upload UI must be removed in the same change, or tsc fails on the removed service exports. [verified-changed: isCommunityMode is used at 133 (uploadRequiresCloudLogin), and that drives the whole upload flow: the 'sign in' button navigates to /login?required=cloud (475-477), and P3 deletes that route. You cann]
  - [ ] L9,15,17,40-43,132,154-157,467-562,826-979 `community upload UI (handleUploadLoginRequired, handleUploadFileChange, handleUploadSubmit, upload panel)` — **delete-code** _(medium)_: Delete the CommunityAppUploadValidation/uploadCommunityApp/validateCommunityAppUpload imports, the UploadStatus type, upload state, resetUploadState, handleUploadLoginRequired (navigate('/login?required=cloud')), the handlers, the reset effect and the 'Upload a community app' panel JSX 826-979. Drop useNavigate if unused. — ⚠ Upload needs the Supabase app session (being removed), and its /login target is deleted in P3. Keep the community-warning banner at 809-824 and the browse/install UI.
  - [ ] L19,129 `isElectron = environment === 'electron'` — **rewrite** _(medium)_: Use isNativeShell from platform/clientCapabilities and drop the utils/api environment import. — ⚠ Kept app store UI. Install buttons are hidden when false.
  - [ ] L132-133,475-477,522-553,822-987 `uploadRequiresCloudLogin / handleUploadLoginRequired (navigate('/login?required=cloud')) / handleUploadSubmit / upload panel` — **delete-code** _(medium)_: Remove the community upload panel, the upload state/handlers and the sign-in redirect. Keep only the community-unreviewed warning (807-820). Drop the useNavigate import if it becomes unused. Browse and install stay anonymous. — ⚠ After P4, isCommunityMode is always true, so the panel would always redirect to the deleted /login. Remove it (or keep validate-only per open question).
- [ ] `ygg-chat/client/ygg-chat-r/src/services/appStore.ts`
  - [ ] L1-2,168-176,186 `fetchAppStoreApps supabase.storage.from('updates').getPublicUrl('apps/manifest.json')` — **keep-but-decouple** _(high)_: Replace the supabase client with a fixed public base constant (e.g. https://auth.yggchat.com/storage/v1/object/public/updates/apps), or fetch through the server's /api/app-store/community Railway proxy. Then drop the lib/supabase import and the 'Supabase client not configured' throw so browse works without VITE_SUPABASE_*. — ⚠ Decision 2 keeps the app store. Today browse only works because CI injects VITE_SUPABASE_URL/ANON_KEY (desktop-release.yml:75-76). Removing env/auth first breaks browse/install, and that has to be avoided.
  - [ ] L1-12,327-331 `assertCloudAppStoreWriteEnabled/uploadCommunityApp` — **keep-but-decouple** _(medium)_: Upload needs a Supabase-authenticated Railway call through the local server, which can no longer succeed. Replace the isCommunityMode check with an unconditional 'uploads unavailable' error, or remove uploadCommunityApp. Keep browse and install. — ⚠ The community store is kept and browse/install must work anonymously. Only upload needs auth.
  - [ ] L1-12,328 `imports isCommunityMode + supabase; assertCloudAppStoreWriteEnabled` — **delete-code** _(medium)_: Delete the supabase and isCommunityMode imports, assertCloudAppStoreWriteEnabled (8-12), uploadCommunityApp (327-370) and validateCommunityAppUpload (303-325, upload-only). Trim line 3 to buildLocalApiUrl-free {localApi} once items 4/5 land. Drop APP_STORE_BUCKET (5). — ⚠ Must land with the appStore.tsx upload-UI removal (it imports both functions) and before P3/P4, or the build breaks. Browse/install paths are untouched. [verified-changed: Today isCommunityMode is true for every account-less user, so the assert at 328 blocks upload. Deleting only the assert enables uploadCommunityApp, which posts to /api/app-store/community/upload. Item]
  - [ ] L2,168-175 `fetchAppStoreApps (Supabase storage bucket 'updates/apps')` — **keep-but-decouple** _(medium)_: Remove the supabase import and the storage.getPublicUrl calls (174, 210, 245). Build the URLs from a constant APP_STORE_PUBLIC_BASE (`<public-base>/apps/...`) with plain fetch, or proxy via local server /app-store/first-party to Railway. No env and no supabase-js. — ⚠ If @supabase/supabase-js is removed first, the first-party app listing breaks. The manifest path and bucket layout must stay reachable anonymously. [verified-changed: supabase.storage.getPublicUrl is used all through fetchAppStoreApps, not just at 168-175: the manifest at 174, description.json at 210, and the zip at 245. All of these must be replaced. Hardcoding th]
  - [ ] L2,168-175,217,248 `fetchAppStoreApps (first-party catalog via supabase.storage.getPublicUrl)` — **rewrite** _(high)_: Replace supabase.storage/getPublicUrl (2,168-176,217,251) with a FIRST_PARTY_CATALOG_BASE constant (GitHub raw/Releases or a Railway endpoint, not the Supabase bucket). Replace environment==='electron' (274,304,330,378,390,398,407) with isHostClient/isNativeShell. Disable upload (1,8-12). — ⚠ Must land before lib/supabase.ts is deleted. Without .env, first-party browse, install and community browse all break today. Install fetches any zipUrl, so a new catalog host needs no server change. [verified-changed: Line 248 is wrong; the zip getPublicUrl is at 251. Two larger gaps: (1) the 'updates' bucket lives on Supabase (auth.yggchat.com), which is being retired along with the updater feed, so hardcoding its]
  - [ ] L3,272-279 `fetchPublicAppStoreApps` — **keep-but-decouple** _(medium)_: Always use localApi.get('/app-store/community') when isHostClient (local server proxies Railway with hardcoded base, anonymous); drop publicApiCall branch. — ⚠ In Electron without .env environment!=='electron' so it calls publicApiCall at localhost:3001 and fails.
  - [ ] L3,272-277,303-305,328-333,378,390,398,407 `environment==='electron' gates + assertCloudAppStoreWriteEnabled` — **keep-but-decouple** _(high)_: Replace the environment checks with isNativeShell. In uploadCommunityApp, assertCloudAppStoreWriteEnabled (8-12, 328) throws whenever isCommunityMode, which is always true once auth is gone. Flag upload as auth-requiring: hide or disable it. Browse/install stay anonymous. — ⚠ Without .env, browse/install/uninstall/custom-tools listing are all disabled in Electron today. Kept app store feature.
  - [ ] L8-12,304,327-333,378,390,398,407 `assertCloudAppStoreWriteEnabled + environment guards` — **keep-but-decouple** _(medium)_: Replace environment!=='electron' with !isNativeShell. Upload requires isCommunityMode false + server getAuthManager().resolve('app') (Supabase JWT): becomes impossible after auth removal; hide/disable upload UI. — ⚠ Install/uninstall/restart are local and must keep working; only upload is auth-bound.
  - [ ] L168-270 `fetchAppStoreApps (first-party catalog via supabase.storage.from('updates').getPublicUrl)` — **keep-but-decouple** _(high)_: Replace the Supabase SDK with a constant APP_STORE_PUBLIC_BASE (e.g. https://auth.yggchat.com/storage/v1/object/public/updates/apps) and plain fetch. Drop the 'Set VITE_SUPABASE_URL' throw. — ⚠ Without a configured Supabase client this throws today, so the first-party tab is empty in a no-.env build. The catalog stays on a Supabase-hosted public bucket (see open question). [verified]
  - [ ] L271-277,303-412 `fetchPublicAppStoreApps, validate/upload/install/uninstall/fetchInstalledCustomTools/restartDesktopApp environment gates` — **keep-but-decouple** _(high)_: Replace `environment === 'electron'` with isNativeShell/isHostClient. Route community browsing through localApi '/app-store/community' for every host client, not publicApiCall to API_BASE (localhost:3001 without .env). The upload flow needs auth: assertCloudAppStoreWriteEnabled. — ⚠ Without .env, Electron gets environment 'local'. Browsing then hits localhost:3001, and install throws 'only available in desktop app', which breaks the kept app store and custom tools.
  - [ ] L272-301 `fetchPublicAppStoreApps (environment==='electron' ? localApi : publicApiCall)` — **keep-but-decouple** _(high)_: Always call localApi.get('/app-store/community'). The local server proxies anonymously to Railway. Drop the publicApiCall branch, which depends on VITE_API_URL/API_BASE. — ⚠ environment comes from VITE_ENVIRONMENT. With no .env, Electron takes the publicApiCall path to http://localhost:3001/api, the wrong port, so the community list fails. [verified]
  - [ ] L274-279,333-335 `fetchPublicAppStoreApps/upload environment gates` — **config-change** _(medium)_: Change environment === 'electron' to isHostClient so community browse goes through localApi /app-store/community, and drop the publicApiCall web path. — ⚠ Without .env, Electron takes the publicApiCall path, which needs VITE_API_URL.
  - [ ] L303-370 `validateCommunityAppUpload / uploadCommunityApp` — **delete-code** _(medium)_: Delete uploadCommunityApp, since upload needs a Railway app session (Supabase JWT). Keep validateCommunityAppUpload only if local zip validation stays useful (open question), and gate it on isHostClient, not environment. — ⚠ Upload is the only auth-requiring app-store feature. Removing it is user-visible.
  - [ ] L378,390,398,407 `installAppFromStore/uninstallAppFromStore/fetchInstalledCustomTools/restartDesktopApp environment !== 'electron'` — **keep-but-decouple** _(medium)_: Replace each `environment !== 'electron'` (378,390,398,407) with `!isNativeShell` imported from ../platform/clientCapabilities. Drop `environment` from the line-3 import (304/330 go away with the upload removal). — ⚠ Using isHostClient instead would expose install/uninstall/restart to LAN browser clients. Keep it Electron-only unless a deliberate decision widens it. [verified-changed: isHostClient (clientCapabilities.ts:6) includes browser-client and standalone. Those targets are blocked today, because environment is 'browser-client'/'standalone'. Switching to isHostClient would ne]
- [ ] `ygg-chat/client/ygg-chat-r/src/utils/api.ts`
  - [ ] L154-168,799-840 `PUBLIC_API_ENDPOINT_PREFIXES / assertPublicEndpointAllowed / publicApiCall` — **delete-code** _(low)_: Once fetchPublicAppStoreApps always uses localApi, delete publicApiCall and its allowlist. They exist only for app-store/community and depend on API_BASE (VITE_API_URL).
  - [ ] L799-840 `publicApiCall` — **delete-code** _(medium)_: Delete publicApiCall/PUBLIC_API_ENDPOINT_PREFIXES (154-160); browser clients should use localApi '/app-store/community' (local server proxies Railway with a hardcoded base). — ⚠ Only consumer is services/appStore.ts fetchPublicAppStoreApps non-electron branch.
  - [ ] L799-844 `publicApiCall` — **keep-but-decouple** _(medium)_: Only caller is appStore.fetchPublicAppStoreApps non-electron branch; it fetches `${API_BASE}` = VITE_API_URL||localhost:3001. Route browser targets through local GET /api/app-store/community (host proxy) instead and delete publicApiCall + API_BASE. — ⚠ App store browse is kept; with no .env API_BASE is localhost:3001 so browser-client/standalone browse breaks unless rerouted via host.

### P8 — Dependencies, tests, docs, final cleanup (205)

- [ ] `.claude/settings.local.json`
  - [ ] L20-23 `enabledMcpjsonServers: ["supabase"]` — **config-change** _(low)_: Remove 'supabase' from enabledMcpjsonServers when the .mcp.json entries go. The file is tracked even though it is named local.
- [ ] `.github/workflows/desktop-release.yml`
  - [ ] L73-81 `step 'Configure environment variables'` — **delete-code** _(high)_: Remove in stages: delete line 80 now (dead); line 77 after P6; line 79 after P2/P4 remove API_BASE cloud consumers; lines 75-76 after P7 switches appStore.ts manifest fetch off the supabase client and P3 drops esbuild authDefines; line 78 last, after the __IS_ELECTRON__ swap. Then delete the step. — ⚠ Lines 75-76 feed the kept app store browse through the Supabase public bucket (appStore.ts:168-176), and line 78 feeds about 40 renderer checks plus appStore's environment==='electron' gates. Deleting the step in one go ships builds with a broken app store and a broken Electron renderer. [verified-changed: Lines are correct, but deleting the whole step at once is wrong because the lines must go at different times. (1) Line 80, SUPABASE_UPDATE_FEED_BASE_URL, already does nothing. electron/main.ts:341-342]
- [ ] `.mcp.json`
  - [ ] L1-8 `mcpServers.supabase (project_ref=awvlmkkdnwmpgomsuneb)` — **config-change** _(low)_: Remove the supabase MCP server entry (dev-agent tooling pointing at the cloud project). Delete the file if it ends up empty.
  - [ ] L3-6 `mcpServers.supabase (project_ref=awvlmkkdnwmpgomsuneb)` — **delete-file** _(low)_: Remove the supabase MCP server entry (or the whole file) from repo meta. It points dev agents at the deprecated Supabase project.
- [ ] `readme.md`
  - [ ] L1,141-169 `Getting Started / Build / 'npm run dev' + 'Web UI: http://localhost:5173'` — **update-docs** _(low)_: Remove the stray 'hello world' (line 1). Replace 'npm run dev'/'Web UI' with dev:electron + 'npm run electron' (or build:mac etc.). State that no .env or account is needed, all data is local, updates come from GitHub Releases, and optional LAN browser access uses dev/build:browser-client.
  - [ ] L155-168 `Getting Started dev instructions` — **update-docs** _(low)_: Replace `npm run dev` / 'Web UI: http://localhost:5173' with `npm run dev:electron` + `npm run electron`; state no .env/account needed.
- [ ] `start_yggdrasil.bat`
  - [ ] L1-6 `web-mode launcher (npm run migrate; npm run dev; open localhost:5173)` — **delete-file** _(low)_: Delete. It starts the BUILD_TARGET=web Vite dev server and calls a nonexistent 'migrate' script. Not a desktop launcher.
- [ ] `update_start_yggdrasil.bat`
  - [ ] L1-10 `web-mode updater/launcher (build:server, build:client, migrate, dev)` — **delete-file** _(low)_: Delete. It builds the web client and a nonexistent root server and runs the web dev server. update-ygg.bat (build:win installer) stays.
- [ ] `ygg-chat/.mcp.json`
  - [ ] L1-8 `supabase MCP server (project awvlmkkdnwmpgomsuneb)` — **delete-file** _(low)_: Delete (dev tooling pointing at the Graviton Supabase project).
  - [ ] L1-8 `mcpServers.supabase` — **config-change** _(low)_: Same as the root .mcp.json: remove the supabase MCP entry or delete the file.
  - [ ] L3-6 `mcpServers.supabase` — **delete-file** _(low)_: Remove the supabase MCP server entry (or the whole file).
- [ ] `ygg-chat/PERSISTENT_AGENT_CONTEXT.md`
  - [ ] L34-51,65,83,130,419-449,1244-1249 `Railway/Supabase/dual-sync/storage_mode design for the retired global agent` — **delete-file** _(low)_: Delete. It is a Jan-2026 design for the retired global agent (agent_global_persistent_agent.md is already a tombstone), built on Railway/Supabase dual-sync and storage_mode. Alternatively, strip the cloud sections.
- [ ] `ygg-chat/client/ygg-chat-r/CHANGELOG.md`
  - [ ] L1-20 `new version section` — **update-docs** _(low)_: Add an entry for the release that goes fully local: sign-in, cloud storage, free tier/credits, the hosted OpenRouter provider and the web build are removed, and updates now come from GitHub Releases. Keep older entries (e.g. 18, 219, 257) as history. CI extracts release notes from this file.
- [ ] `ygg-chat/client/ygg-chat-r/README.md`
  - [ ] L1-54 `Vite React template boilerplate` — **rewrite** _(low)_: Replace the Vite template text with a short package guide: build targets (electron, browser-client, standalone), test commands (test:renderer/headless/server/tools via ELECTRON_RUN_AS_NODE), and no env required.
- [ ] `ygg-chat/client/ygg-chat-r/custom-tools/CUSTOM_TOOLS_GUIDE.md`
  - [ ] L365 `REQUEST_GENERATION bridge handler` — **update-docs** _(low)_: If P2/P4 changes REQUEST_GENERATION to drop remote ephemeral generation or the slash-model default to cloud 'openrouter', document the local provider/model it now uses. Same for CUSTOM_TOOLS_LEGACY_GUIDE.md:136 and html_frame_context.md:154.
- [ ] `ygg-chat/client/ygg-chat-r/docs/SUBAGENT_IMPLEMENTATION_PLAN.md`
  - [ ] L183,224-232,320,352 `/generate/ephemeral on cloud server (server/src/routes/supaChat.ts)` — **delete-file** _(low)_: Delete. It is an obsolete plan built on the remote /generate/ephemeral endpoint and the cloud supaChat.ts. The subagent tool is now server-local.
- [ ] `ygg-chat/client/ygg-chat-r/electron/electronHostAdapter.ts`
  - [ ] L73-77 `buildSecretStore comment` — **update-docs** _(low)_: Remove the stale 'electronAppAuth reads its legacy keys' wording.
- [ ] `ygg-chat/client/ygg-chat-r/index.html`
  - [x] ~~L12-18 `Google Fonts links`~~ — **skip (resolved by Q16: keep fonts)**. Original note: Optional: Jaini/Baumans/Germania One classes have no TSX consumers and Space Grotesk none; drop those links (or self-host fonts for offline). No analytics/CSP present otherwise.
  - [x] ~~L18 `Google Fonts link Inter/Space Grotesk/JetBrains Mono`~~ — **skip (resolved by Q16: keep fonts)**. Original note: This link was added for the landing and blog fonts (font-inter, font-display). Remove Space Grotesk. JetBrains Mono is also loaded from src/index.css:2, so the link can go once landing/blog are deleted.
- [ ] `ygg-chat/client/ygg-chat-r/login_context.md`
  - [ ] `login context doc` — **delete-file** _(low)_: Describes the Supabase OAuth, yggchat://auth/callback and oauth:callback IPC flow being removed. Delete it, or reduce it to a note about Codex loopback OAuth.
  - [ ] `login flow notes` — **update-docs** _(low)_: Documents isCloudSession/isCommunityMode, the Supabase login and the synthetic local session (lines 58-59, 122, 300). Delete it or rewrite it for the fixed local identity.
  - [ ] L106,561 `appStore.tsx:473 login reference` — **update-docs** _(low)_: Remove the appStore.tsx upload-login references (the upload flow and /login are removed). Consider deleting this login-context doc entirely along with auth removal.
- [ ] `ygg-chat/client/ygg-chat-r/migration_full_headless.md`
  - [ ] `headless migration progress log (Phase 4 cloud provider via gateway, Phase 5 storage-aware CRUD gateway)` — **delete-file** _(low)_: Delete. It is a completed migration log dominated by the cloud gateway, Railway and dualSync, and its content is superseded by agent_headless_server.md. Alternatively, add a 'historical; cloud parts removed' banner.
  - [ ] L56-64,112 `OpenRouterProvider free-tier relay notes` — **update-docs** _(low)_: Mark the free-tier relay and the openRouterProvider.freeTier test as removed, or delete those sections.
  - [ ] L168,353 `gatewayRoutes /api/gw storage-aware merge docs` — **update-docs** _(low)_: Describe /api/gw as the local-only data facade. Remove the cloud merge, Railway, mirror and /api/cloud references.
- [ ] `ygg-chat/client/ygg-chat-r/package-lock.json`
  - [ ] L4413-4500,5938-5975 `@stripe/stripe-js, @supabase/* (auth/functions/postgrest/realtime/storage/supabase-js), @vercel/analytics` — **remove-dependency** _(low)_: Regenerate lockfile after removing the three deps from package.json (L62,63,70). Keep @vercel/oidc (L5976): transitive dep of 'ai' SDK, unrelated to Vercel hosting.
- [ ] `ygg-chat/client/ygg-chat-r/package.json`
  - [ ] L62,63,70 `dependencies @stripe/stripe-js, @supabase/supabase-js, @vercel/analytics` — **remove-dependency** _(medium)_: Remove the three deps (@stripe/stripe-js has no importers at all). Regenerate ygg-chat/client/ygg-chat-r/package-lock.json and ygg-chat/package-lock.json. — ⚠ supabase-js is still imported by lib/supabase.ts, AuthContext.tsx and (via lib/supabase) services/appStore.ts first-party listing; remove only after P3/P7 rewrites.
  - [ ] L62,70 `@stripe/stripe-js, @vercel/analytics dependencies` — **remove-dependency** _(low)_: Remove @stripe/stripe-js (no import in tracked src) and @vercel/analytics after the App.tsx change. Update package-lock.json accordingly.
  - [ ] L85,91 `dependencies dexie, gsap` — **remove-dependency** _(low)_: Optional: no importers in src/electron/server; remove alongside the cloud deps (leave conf-transitive pins like debounce-fn/json-schema-typed/uint8array-extras).
- [ ] `ygg-chat/client/ygg-chat-r/scripts/chat-selection-browser-smoke.tsx`
  - [ ] L30 `configureStore reducer users: () => ({ currentUser: { id: 'smoke-user' } })` — **update-test** _(low)_: The smoke store stubs state.users for ChatSelectionProvider. Update or remove the stub when ChatSelectionProvider stops reading state.users.currentUser (local user id). It also imports useConversationSnapshotCoordinator, which uses useAuth.
- [ ] `ygg-chat/client/ygg-chat-r/scripts/test-agents-grid-electron.cjs`
  - [ ] L27 `esbuild define` — **update-test** _(low)_: Drop __IS_WEB__ (and __IS_LOCAL__) from define; keep __BUILD_TARGET__.
- [ ] `ygg-chat/client/ygg-chat-r/scripts/test-browser-app-bridge.cjs`
  - [ ] L31 `esbuild define without __BUILD_TARGET__` — **update-test** _(low)_: Add __BUILD_TARGET__ to the define list (and drop __IS_WEB__/__IS_LOCAL__), matching test-agents-grid-electron.cjs, test-chat-selection-electron.cjs and test-matrix-wallpaper.cjs.
- [ ] `ygg-chat/client/ygg-chat-r/scripts/test-browser-client.cjs`
  - [ ] L24-29 `auth fixture {app, codex, user:null}` — **update-test** _(low)_: Drop app: snapshot('app'). Set user to {id: LOCAL_USER_ID}, since user:null (signed-out) can no longer occur.
  - [ ] L24 `auth fixture {app, codex, user:null}` — **update-test** _(low)_: Make the fixture project the fixed local user, matching the new publicAuthState shape. With user:null the smoke test exercises a login state that no longer exists. Make the same shape change in test-browser-workspace.cjs:18.
  - [ ] L39-47 `expects #/login with 'Continue locally'` — **update-test** _(medium)_: After P3 removes Login and App.tsx '/'->'/login' redirect, assert the shared UI mounts at '#/' (e.g. homepage marker) instead of the login page. — ⚠ Packaged browser-client smoke test; will fail once Login is removed.
- [ ] `ygg-chat/client/ygg-chat-r/scripts/test-browser-workspace.cjs`
  - [ ] L16-18 `auth fixture with app slot + hardcoded uid` — **update-test** _(low)_: Drop app: slot('app') from the fixture. Optionally import the shared LOCAL_USER_ID instead of the literal a7c485cb....
  - [ ] L19-45 `/api/gw fixture routes` — **update-test** _(low)_: No change if /api/gw paths are kept local-only; update route list if renderer migrates to /api/app/*. storage_mode fixtures may be dropped.
  - [ ] L40-52 `/api/gw/* and /api/cloud/users/:uid/research-notes fixtures` — **update-test** _(medium)_: Re-point fixture routes from /api/gw/* and /api/cloud/* to whatever local routes the renderer uses after P2/P5. — ⚠ Fixture must track renderer endpoint changes.
- [ ] `ygg-chat/client/ygg-chat-r/scripts/test-chat-selection-electron.cjs`
  - [ ] L27 `esbuild define __IS_WEB__` — **update-test** _(low)_: Remove `__IS_WEB__: 'false'` from the define map.
  - [ ] L29 `useAuth esbuild stub` — **update-test** _(low)_: Change the stub 'export const useAuth = () => ({ accessToken: null })' to the new shape (userId: LOCAL_AUTH_USER_ID, loading: false).
  - [ ] L31 `utils/api.ts esbuild stub exporting gwApi` — **update-test** _(low)_: Update stub if gwApi is renamed (e.g. dataApi).
- [ ] `ygg-chat/client/ygg-chat-r/scripts/test-matrix-wallpaper.cjs`
  - [ ] L47 `esbuild define` — **update-test** _(low)_: Drop __IS_WEB__/__IS_LOCAL__; keep __BUILD_TARGET__ '"electron"'.
- [ ] `ygg-chat/client/ygg-chat-r/server/MIGRATIONS.md`
  - [ ] L11-24,56,61 `schema-migration rules + v4 notes ('/api/gw ... cloud chats included', 'external cloud database')` — **update-docs** _(low)_: Keep rules 11-24, the canonical migration log (runner: SCHEMA_MIGRATIONS at server/localServer.ts:427). Only reword l.56/61 to drop cloud. If any column is dropped (not recommended), append the next version (13+) idempotently plus a log row.
- [ ] `ygg-chat/client/ygg-chat-r/server/__tests__/hostRuntimeRoutes.test.ts`
  - [ ] L9-16,35-41,51 `host public identity tests` — **update-test** _(low)_: Remove the app snapshot from the fixture and the enableLocalLogin mock. Replace the /api/host/auth/local and /logout policy probes with kept POST routes (/api/host/auth/check or /auth/codex/disconnect). Assert that auth.user is the fixed local id.
- [ ] `ygg-chat/client/ygg-chat-r/server/__tests__/syncStorageRoutes.test.ts`
  - [ ] `/api/sync/message tests` — **delete-file** _(low)_: Delete (or retarget to /api/local/attachments) when /api/sync/* routes are removed.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/HEADLESS_API_GUIDE.md`
  - [ ] L19,49,64,75,297-301,369-371 `openrouter provider + /api/provider-auth/openrouter/token + Supabase app sessions` — **update-docs** _(low)_: Replace the 'openrouter' provider and openrouter streaming note with openrouterbyok. Remove the openrouter token endpoints if P2 deletes them and 'Supabase app sessions' (l.369). Update the provider list to openaichatgpt/zai/bedrock/openrouterbyok/lmstudio/claude.
  - [ ] L49,64,75,299-300,369 `provider openrouter / Supabase app session docs` — **update-docs** _(low)_: Replace provider 'openrouter' references with openrouterbyok; remove Supabase app-session and /api/provider-auth/openrouter/token text.
  - [ ] L49,64,299-305,369 `OpenRouter streaming note; provider-auth/openrouter routes; models listing` — **update-docs** _(low)_: Remove the cloud provider 'openrouter' notes and the /api/provider-auth/openrouter/token docs. Document openrouter-byok and the local-only /api/provider-auth/models.
  - [ ] L49 `note recommending provider 'openrouter' for custom-tool REQUEST_GENERATION` — **update-docs** _(low)_: Replace this with: use provider 'openrouterbyok' (own key) or 'openaichatgpt' via /api/conversations/:id/messages.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/__parity__/__fixtures__/README.md`
  - [ ] L4,9-25 `openrouter.send.json example with Railway SSE frames + free_generations_update` — **update-test** _(low)_: Change the example to a local provider (e.g. openrouterbyok or lmstudio). Remove 'Railway' wording and the free_generations_update frame. Check chatLoop.parity.test.ts for matching openrouter/free-tier usage.
  - [ ] L4,14,22,25 `fixture format doc` — **update-docs** _(low)_: Drop Railway frames/free_generations_update example; use a local provider in the sample.
  - [ ] L14,25 `openrouter fixture example; free_generations_update` — **update-docs** _(low)_: Change the example provider to openrouterbyok and remove the free_generations_update example frame.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/__parity__/chatLoop.parity.test.ts`
  - [ ] L1-35 `parity todo skeleton` — **update-test** _(low)_: Remove 'openrouter' from PROVIDERS (or use openrouterbyok) and delete the two free_generations_update/generation_limit_reached todos and Railway wording.
  - [ ] L22,30-31 `PROVIDERS list; free_generations_update / 403 todos` — **update-test** _(low)_: Replace 'openrouter' with 'openrouterbyok' in PROVIDERS. Delete the Railway free_generations_update and 403 generation_limit_reached it.todo entries.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/config/__tests__/gatewayFlags.test.ts`
  - [ ] `gateway flag tests` — **delete-file** _(low)_: Delete with gatewayFlags.ts.
  - [ ] `gatewayFlags tests` — **update-test** _(low)_: Delete the cases for chat, crud, cloudProxy and YGG_GATEWAY_MODE. Keep or delete the resumableRuns-only case to match the gatewayFlags.ts rewrite.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/config/gatewayFlags.ts`
  - [ ] L24-30 `doc comment referencing electronAppAuth.ts:79-84` — **update-docs** _(low)_: Drop the stale electronAppAuth.ts reference, or delete it along with gatewayFlags if the cloud-layer area removes the file.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/config/settingsStore.ts`
  - [ ] L1-12 `header comment (electronAppAuth.ts, auth_session)` — **update-docs** _(low)_: Remove the stale references to the deleted electronAppAuth.ts and the 'auth_session' key format. Mention managed_auth_v1 (Codex) instead.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/headless.md`
  - [ ] L73,77,107 `providers/openRouterProvider.ts in historical plan` — **update-docs** _(low)_: Drop the openRouterProvider.ts and 'OpenRouter' cloud provider references, or mark the file as a historical plan.
  - [ ] L77 `providers/openRouterProvider.ts listing` — **update-docs** _(low)_: Replace the entry with providers/providerTypes.ts.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/persistence/__tests__/deleteMessages.test.ts`
  - [ ] L75-87 `'blocks admission throughout an awaited cloud deletion...' / Error('Cloud failed')` — **update-test** _(low)_: Reword the test name and the error text from cloud deletion to async deletion. Keep the withMessageDeletionLock behavior: gatewayRoutes still wraps local deletes (734,758). Update the matching comment at deleteMessages.ts:19.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/persistence/__tests__/messageRepo.idAdoption.test.ts`
  - [ ] L1-40 `id adoption tests` — **update-test** _(low)_: Rename 'railway-1' fixtures/description to neutral wording, or delete if the id option is removed.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/persistence/deleteMessages.ts`
  - [ ] L20 `withMessageDeletionLock` — **delete-code** _(low)_: Its only caller was the gatewayRoutes cloud delete path, so it is now unused. Delete it and the cases in persistence/__tests__/deleteMessages.test.ts 80-87. Keep assertMessagesNotInActiveRun and deleteMessagesWithLineageRepair.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/persistence/messageRepo.ts`
  - [ ] L11-17 `createMessage id option (Railway id adoption)` — **keep-but-decouple** _(low)_: Keep optional caller-supplied `id` (harmless, generic upsert) but rewrite the comment to drop Railway wording; or remove if no other caller passes id.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/__tests__/imageHistory.test.ts`
  - [ ] L3,15 `OpenRouterProvider image projection case; railwayTurn fixture` — **update-test** _(low)_: Remove the OpenRouterProvider import and its test case. Rename railwayTurn to turnContext in the shared fixture. Keep the Codex and LM Studio image-history cases.
  - [ ] L3,15,36-45 `OpenRouterProvider import; railwayTurn fixture; 'relays per-row artifacts to OpenRouter' case` — **update-test** _(medium)_: Remove the OpenRouterProvider import and the OpenRouter case (36-45). Rename railwayTurn to turnContext in the shared fixture at line 15. Keep the Codex, LM Studio and text-only cases. — ⚠ The fixture is typed `any`, so a missed rename silently stops testing Codex image attachments.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/__tests__/openAIContextUsage.test.ts`
  - [ ] L42 `providerName: 'OpenRouter' fixture` — **update-test** _(low)_: Optional: use 'OpenRouter BYOK'.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/__tests__/openaiChatgptProvider.test.ts`
  - [ ] L50,176,265,586 `railwayTurn fixtures (serviceTier, conversationId, allowCommentaryFallbackText)` — **update-test** _(medium)_: Rename railwayTurn to turnContext in all four fixtures. — ⚠ These use `as any`. If the rename is missed, the tests pass vacuously or fail on Codex session, serviceTier and commentary-fallback behaviour.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/__tests__/providerErrorFormatter.test.ts`
  - [ ] L94-99 `RailwayAppAuthError classification case` — **update-test** _(low)_: Remove the RailwayAppAuthError and provider 'openrouter' assertion. Keep the AbortError and ProviderEmptyResponseError assertions in the same `it`.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/__tests__/appAutomationRoutes.messagesTree.test.ts`
  - [ ] L14,125-145,227-234,257-263 `gateway tree parity tests` — **update-test** _(low)_: Register gateway with {db,statements} only; drop railway mock and `railway.passthrough` assertions; replace 'routes unknown conversation to cloud leg' with local empty/404 expectation.
  - [ ] L14,223 `registerGatewayRoutes usage, meta.storage_mode` — **update-test** _(low)_: Update the registerGatewayRoutes call to the new deps (no railway/mirror/auth). The meta.storage_mode assertion can stay as long as the payload keeps meta.
  - [ ] L129-148,257-262 `railway mock deps; 'gateway still routes an unknown conversation to the cloud leg'` — **update-test** _(low)_: Drop the railway, mirror, auth and enabled deps. Replace the unknown-conversation cloud-leg test with one expecting the in-process empty payload {messages:[],tree:null,meta}.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/__tests__/cloudProxyRoutes.test.ts`
  - [ ] `cloudProxyRoutes tests` — **delete-file** _(low)_: Delete this file along with cloudProxyRoutes.ts.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/__tests__/ephemeralGenerateRoutes.test.ts`
  - [ ] L53-55,72-74 `YGG_APP_ACCESS_TOKEN/YGG_ACCESS_TOKEN/SUPABASE_ACCESS_TOKEN cleanup` — **update-test** _(low)_: Remove cloud token env cleanup and any remote-path cases.
  - [ ] L165-290 `provider 'openrouter' remote ephemeral cases` — **update-test** _(low)_: Delete the remote 'openrouter' cases (around 172, 232, 247, 274, 284). Add a case asserting that slash-prefixed models infer 'openrouterbyok'.
  - [ ] L167-286 `openrouter ephemeral routing / managed-account cases` — **update-test** _(low)_: Delete the explicit-openrouter, managed-account and Railway-token cases. Change 'infers openrouter from non-openai prefixed model names' to expect openrouterbyok (it fails with 'OpenRouter API key missing' when no key is set). Drop the getAuthManager mock if it is unused.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/__tests__/gatewayRoutes.attachments.test.ts`
  - [ ] `gateway attachment route tests` — **update-test** _(low)_: Remove the railway/mirror/auth stubs and the cases covering cloud legs, ?storageMode=cloud and POST /api/gw/attachments. Keep the local GET /messages/:id/attachments read cases.
  - [ ] L1-160 `gateway attachment tests` — **update-test** _(low)_: Remove railway mock/deps (63,80-87) and cloud cases (112-124 cloud routing/override, 135-145 Railway fallback, 146-end multipart Railway upload). Keep local read/link/delete; add 404 for unknown attachment id.
  - [ ] L5,30-31,73-74,120-121 `storageMode override tests` — **update-test** _(low)_: Remove cloud-leg and ?storageMode=cloud override cases; assert local-only behavior.
  - [ ] L63-165 `railway/auth deps; cloud-routing + ?storageMode=cloud + multipart upload cases` — **update-test** _(low)_: Register the routes with { db, statements } only. Delete the Railway-routing, storageMode=cloud override and POST multipart cases. Change the GET attachments/:id fallback to expect a 404. Keep the local read, link and delete cases.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/__tests__/gatewayRoutes.merge.test.ts`
  - [ ] `merge helper / toCloud* tests` — **update-test** _(low)_: Delete merge*/dedupById/toCloud* cases; keep sortByUpdatedDesc and toLocalConversationCreate/toLocalProjectCreate cases (storage_mode 'local' forcing). Delete file if nothing remains.
  - [ ] `merge helper tests` — **delete-file** _(low)_: Delete this file: it imports mergeConversationLists, mergeProjects, mergeRecent, merge*Paginated and the toCloud* helpers, all removed. Move any sortByUpdatedDesc coverage into a local test.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/__tests__/providerAuthRoutes.test.ts`
  - [ ] L56-60,85-128 `openrouter token 410 test, remote OpenRouter models test` — **update-test** _(low)_: Delete the openrouter/token case and the remote ?userId model-fetch case. Keep the openai 410 test and the default model listing (adjusted for the removed 'openrouter' entry).
  - [ ] L96 `mock of webdrasil /models/openrouter` — **update-test** _(low)_: Remove the remote OpenRouter model-list mock and its assertions, and the openrouter token-route cases. Keep the BYOK, zai and bedrock cases.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/__tests__/subagentRoutes.test.ts`
  - [ ] L145-155 `'rejects openrouter provider with 400'` — **update-test** _(low)_: Delete or rewrite to match the chosen legacy-'openrouter' normalization.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/__tests__/authMigration.test.ts`
  - [ ] `OAuth credential migration tests` — **update-test** _(low)_: These cases are already codex-only. Re-run after the authMigration rewrite. Delete the file if authMigration.ts is deleted (open question).
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/__tests__/authSessionManager.test.ts`
  - [ ] L1-109 `AuthSessionManager tests using slot 'app'` — **update-test** _(low)_: Change every 'app' slot use (replace/resolve/snapshot/AuthFailure, lines 12-61+) to 'codex' so single-flight, rotation and reauth coverage survive narrowing AuthSlot.
  - [ ] L18-102 `manager.resolve('app') cases` — **update-test** _(low)_: Switch every 'app' slot to 'codex' so the single-flight, rejection and epoch coverage stays once AuthSlot is narrowed.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/__tests__/chatOrchestrator.phase2.test.ts`
  - [ ] L1350,1801-1802 `railwayTurn.attachmentsBase64 / conversationContext / projectContext assertions` — **update-test** _(low)_: Rename to turnContext. If conversationContext and projectContext are pruned from the turn (only the Railway provider read them), assert them on the composed system prompt or the input fields instead.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/__tests__/claudeSessionRepo.test.ts`
  - [ ] L30,33 `SUPABASE_SERVICE_ROLE_KEY sample secret` — **keep-but-decouple** _(low)_: Optional: swap the sample secret name for a neutral one (e.g. YGG_APP_SECRET); test still validates env scrubbing.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/__tests__/claudeSessionService.test.ts`
  - [ ] L334,341 `assertClaudeBranchSelection provider: 'openrouter'` — **update-test** _(low)_: Optional: replace the arbitrary non-Claude 'openrouter' with 'openrouterbyok' so the fixture does not name a deleted provider.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/__tests__/cloudMirrorService.test.ts`
  - [ ] `cloudMirrorService tests` — **delete-file** _(low)_: Delete this file along with cloudMirrorService.ts.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/__tests__/cloudMirrorSink.test.ts`
  - [ ] `CloudMirrorSink tests` — **delete-file** _(low)_: Delete; the TreeMessageSink-ignores-providerMessageId regression becomes moot once the field is removed.
  - [ ] L20-45,47,60,71 `CloudMirrorSink tests + it.each([TreeMessageSink, CloudMirrorSink])` — **update-test** _(low)_: Delete the CloudMirrorSink describe block (20-45). In the it.each cases at 47, 60 and 71, keep only TreeMessageSink, which still covers response stamping and metadata. Consider renaming the file to treeMessageSink.test.ts.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/__tests__/normalTurnCompaction.test.ts`
  - [ ] L69 `summaryRequest.railwayTurn.conversationId` — **update-test** _(low)_: Rename railwayTurn to turnContext. The same rename applies in subagentRunService.test.ts:253, toolLoopService.test.ts:408 and openaiChatgptProvider.test.ts 50/176/265/586.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/__tests__/providerRouter.test.ts`
  - [ ] L27-65 `openrouter routing tests` — **update-test** _(low)_: Replace openrouter routing/context-length cases (33, 38-65 incl. railwayTurn) with openrouterbyok/lmstudio; assert chosen legacy 'openrouter' normalization.
  - [ ] L32,38-50 `resolveContextLength('openrouter'); 'routes openrouter and lmstudio' case` — **update-test** _(low)_: Line 32 now normalizes to openaichatgpt and clamps, so change it to 'openrouterbyok'. Delete the openrouter generate assertion (40-48, which expects 'Sign in again') and keep the LM Studio half.
  - [ ] L33,38-50 `openrouter routing test` — **update-test** _(low)_: Replace the 'openrouter' generate case ('Sign in again') with a check that legacy 'openrouter' normalizes to openrouterbyok. Keep the lmstudio and context-length cases.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/__tests__/railwayClient.test.ts`
  - [ ] `railwayClient tests` — **delete-file** _(low)_: Delete this file along with railwayClient.ts.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/__tests__/refreshAdapters.test.ts`
  - [ ] L30-33 `missing Supabase config test` — **update-test** _(low)_: Delete the 'reports missing main-process Supabase config' case (stubs VITE_SUPABASE_*/SUPABASE_*).
  - [ ] L31-32 `app-slot Supabase config_error case` — **update-test** _(low)_: Delete the VITE_SUPABASE stubEnv / refreshCredential('app') configuration_error case. Keep the Codex refresh and expiryMs cases.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/__tests__/subagentModelNames.test.ts`
  - [ ] L22 `normalizeSubagentModelName(..., 'OpenRouter')` — **update-test** _(low)_: Optional: use 'OpenRouter BYOK'. Slash models must still pass through unchanged.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/__tests__/subagentRunService.test.ts`
  - [ ] L253 `call.input.railwayTurn?.serviceTier` — **update-test** _(low)_: Rename to call.input.turnContext?.serviceTier.
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/__tests__/subagentToolExecutor.test.ts`
  - [ ] L30,116-125 `OpenRouter parent fallback cases` — **update-test** _(low)_: Remove ['openrouter',...] tier case and 'falls OpenRouter parents back to the local subagent provider' test (or rewrite for legacy normalization).
- [ ] `ygg-chat/client/ygg-chat-r/server/headlessServer/services/__tests__/toolLoopService.test.ts`
  - [ ] L408 `providerRouter.calls[1].input.railwayTurn?.previousResponseId` — **update-test** _(low)_: Rename to turnContext?.previousResponseId.
- [ ] `ygg-chat/client/ygg-chat-r/server/hostCapabilities.ts`
  - [ ] L12-17 `KeyValueStore doc comment` — **update-docs** _(low)_: Replace the 'auth_session' example key with managed_auth_v1.
- [ ] `ygg-chat/client/ygg-chat-r/server/localAnalyticsDashboard.ts`
  - [ ] L9,15,192-194,543-544,612 `storage_mode projections, payments stub` — **keep-but-decouple** _(low)_: Optional: stop selecting/returning storage_mode and drop payments stub once renderer types drop them. Column stays.
- [ ] `ygg-chat/client/ygg-chat-r/server/localServer.ts`
  - [ ] L627,646,968,1157-1212 `storage_mode column DEFAULT 'cloud', getLocal* statements filtering storage_mode='local'` — **keep-but-decouple** _(medium)_: Keep columns/indexes (no migration). All kept insert paths (/api/app, /api/local conversations, userProjectRoutes) write 'local' explicitly; never insert relying on DEFAULT 'cloud'. — ⚠ Any new insert without storage_mode becomes 'cloud' and is hidden by storage_mode='local' list statements and /api/local/projects/:id 404s (userProjectRoutes 271,298).
- [ ] `ygg-chat/client/ygg-chat-r/server/routes/noteSearchRoutes.ts`
  - [ ] L45,295-342,653,787-1015,1137,1194-1324 `storage_mode in note search docs/results` — **keep-but-decouple** _(low)_: Read-only projection of retained column (also searchIndexSchema.ts triggers, fetchChats.ts 97-632, lineageRepo.ts 170-184, appAutomationRoutes meta.storage_mode, conversationRoutes 389-393). Leave; optional cosmetic removal later.
- [ ] `ygg-chat/client/ygg-chat-r/server/routes/userProjectRoutes.ts`
  - [ ] L271-276,298-302 `/api/local/projects/:id storage_mode!=='local' guards` — **keep-but-decouple** _(low)_: Keep (old cloud rows irrelevant) or delete guards for simplicity; no renderer path depends on rejecting cloud rows.
- [ ] `ygg-chat/client/ygg-chat-r/server/tools/__tests__/dummyFilechatAction.ts.test`
  - [ ] `legacy dummy copies using /sync/message and storage_mode` — **delete-file** _(low)_: Stale non-runnable snapshot of old chatActions (70 storage refs, /sync/message posts); delete with dummyfile.ts.test (old /api/sync server copy).
  - [ ] L60,139,2031,3818,4883,5796,6143,6504,6579 `fixture text with VITE_* / webdrasil` — **keep-but-decouple** _(low)_: Do NOT edit: verbatim fixture read by editFile.test.ts (line 1346); exclude from cloud-removal grep audits.
- [ ] `ygg-chat/client/ygg-chat-r/server/tools/__tests__/dummyfile.ts.test`
  - [ ] L98-100,3119,3148 `fixture text with REMOTE_API_BASE webdrasil` — **keep-but-decouple** _(low)_: Do NOT edit: editFile.test.ts fixture (lines 373,1006); exclude from audits.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/ChatMessage/SummarisedMessage.test.tsx`
  - [ ] L26 `vi.mock utils/api { environment: 'local' }` — **update-test** _(low)_: Remove `environment` from the utils/api mock. Mock platform/clientCapabilities instead if the component under test now reads isNativeShell.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/Heimdall/conversationProjectGroups.test.ts`
  - [ ] L32-40 `local and cloud chats grouping case` — **update-test** _(low)_: Drop storage_mode fixtures/wording (grouping logic itself is storage-agnostic).
- [ ] `ygg-chat/client/ygg-chat-r/src/components/SettingsPane/ToolsSettings.test.tsx`
  - [ ] L30,34-35 `vi.stubEnv('VITE_ENVIRONMENT','electron')` — **update-test** _(low)_: Remove stubEnv/unstubAllEnvs once ToolsSettings no longer reads VITE_ENVIRONMENT.
  - [ ] L30,34 `vi.stubEnv('VITE_ENVIRONMENT','electron')` — **update-test** _(low)_: Remove the VITE_ENVIRONMENT stubEnv/unstubAllEnvs. Mock clientCapabilities if any branch depends on native shell.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/SubagentTranscript/SubagentTranscript.test.tsx`
  - [ ] L7 `vi.mock utils/api { environment: 'electron' }` — **update-test** _(low)_: Drop `environment: 'electron'` from the mock and mock clientCapabilities isNativeShell:true where needed.
- [ ] `ygg-chat/client/ygg-chat-r/src/components/TitleBar/titleBarHistory.test.ts`
  - [ ] L16,30 `visits with '/login'` — **update-test** _(low)_: Replace the '/login' entries with another excluded or removed path, or drop them.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/LoggingDashboard.test.tsx`
  - [ ] L15,18-22,38-60 `runtimeMode mock / cloud analytics tests` — **update-test** _(low)_: Drop the vi.mock of runtimeMode and useCloudLoggingAnalytics. Delete the 'suppresses stale cloud account data while signed out' test and the payments fixture, and mock only local analytics.
  - [ ] L19-59 `useCloudLoggingAnalytics mock, 'Sign in to load cloud analytics' case` — **update-test** _(low)_: Remove cloud hook mock and signed-out cloud test; mock only local hook; drop payments fixture if type removed.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/Settings.credentials.test.ts`
  - [ ] L6-7,25-33 `credential native boundary test` — **update-test** _(low)_: If authHandle is renamed (or openExternal moves), update the `authHandle('secrets:${channel}'` string assertions to the new helper name. Keep the assertion that secrets IPC is main-frame-only.
- [ ] `ygg-chat/client/ygg-chat-r/src/containers/sideBar.tsx`
  - [ ] L783,1316,1333 `useAuth accessToken / cloneConversation(id, accessToken)` — **delete-code** _(low)_: Stop destructuring accessToken and call cloneConversation(id) after the utils/api signature drops its accessToken param.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/agentRunPreviewReconnect.test.ts`
  - [ ] L7 `vi.mock('../../utils/api') FORCE_LOGOUT_EVENT` — **update-test** _(low)_: Remove FORCE_LOGOUT_EVENT: 'force-logout' from the mock once api.ts drops the export (only consumer is AuthContext).
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/attachmentUrl.test.ts`
  - [ ] L7 `remoteOrigin fixture` — **update-test** _(low)_: Drop remoteOrigin fixture and cloud/uploads expectations; assert relative/upload paths resolve to null.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/branchModelSelection.test.ts`
  - [ ] L6,9,41-42 `'OpenRouter' fixture` — **update-test** _(low)_: Optional: rename to 'OpenRouter BYOK'.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/branchToolApproval.test.ts`
  - [ ] L106,109 `'OpenRouter' fixture` — **update-test** _(low)_: Optional: rename to 'OpenRouter BYOK'.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/buildServerLoopRequest.ts`
  - [ ] L10,95-102,223 `doc comments referencing openrouter cloud route` — **update-docs** _(low)_: Update the comments: the provider list becomes lmstudio|zai|openrouterbyok|bedrock|openaichatgpt|claude, the temperature note applies to openrouterbyok, and the serviceTier note is Codex-only. There is no logic change.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/changeOperationMode.test.ts`
  - [ ] L16,60 `thunk extra { auth: { accessToken: null, userId: null }, queryClient }` — **update-test** _(low)_: If ThunkExtraArgument.auth (store/thunkExtra.ts) is removed or reduced to userId with the app session gone, update the hand-built extra args here.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/chatActions.ts`
  - [ ] L132 `commented API_BASE` — **delete-code** _(low)_: Delete dead comment referencing VITE_API_URL (also line 470 commented fetch).
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/chatSelection.test.ts`
  - [ ] L17,23 `storageMode expectations` — **update-test** _(low)_: Remove storageMode from expected targets and the 'local' arg.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/compactionCancellation.test.ts`
  - [ ] L28,42,86 `thunk extra { auth: { accessToken, userId } }` — **update-test** _(low)_: Update the thunk extra-arg literals to match the new ThunkExtraArgument shape after accessToken removal.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/editMessageWithBranching.test.ts`
  - [ ] L339-346,388-395,421,430 `'OpenRouter'/'openrouter' as non-Claude provider fixture` — **update-test** _(low)_: Optional: replace 'OpenRouter'/'openrouter' with 'OpenRouter BYOK'/'openrouterbyok' so the fixtures do not name the deleted provider.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/enqueueUserMessage.test.ts`
  - [ ] L17 `thunk extra { auth: { accessToken, userId } }` — **update-test** _(low)_: Update the thunk extra-arg literal to match the new ThunkExtraArgument shape after accessToken removal.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/localChatErrors.test.ts`
  - [ ] L123,133,165,252-253,275 `session_expired expectations` — **update-test** _(low)_: Update expectations for 401/403 to the new local code; drop the {kind:'sign_in',label:'Sign in'} action assertion and session_expired from the code list at L275 if the code is removed from shared/chatErrors.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/mainChatClient.test.ts`
  - [ ] L20-25,303-330 `FORCE_LOGOUT_EVENT mock / 'runServerChatLoop reauthentication' suite` — **update-test** _(low)_: Drop FORCE_LOGOUT_EVENT from the utils/api mock and delete the reauthentication describe block once the reauth_required branch is removed.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/runStatistics.test.ts`
  - [ ] L127 `provider: 'openrouter' metric fixture` — **update-test** _(low)_: Optional: use 'openrouterbyok'.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/runStatisticsMetadata.test.ts`
  - [ ] `mergeLocalRunMetadata tests` — **delete-file** _(low)_: Delete this file along with shared/runStatisticsMetadata.ts.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/sseProjection.test.ts`
  - [ ] L476-490,592 `free_generations_update / generation_limit_reached tests` — **update-test** _(low)_: Delete the free-tier projection tests and remove generation_limit_reached from the terminal-event fixture at line 592. Delete any reauth_required tests as well.
  - [ ] L476-486,592 `free-tier projection tests` — **update-test** _(low)_: Remove free_generations_update / generation_limit_reached cases and fixture entry.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/updateConversationTitle.test.ts`
  - [ ] L6,14,22,39-61 `gwApi.patch '?storageMode=' assertions` — **update-test** _(low)_: Expect gwApi.patch('/conversations/c',{title}) with no storageMode variants.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/chats/watchContinuationSelection.test.ts`
  - [ ] L227 `thunk extra { auth: { accessToken, userId } }` — **update-test** _(low)_: Update the thunk extra-arg literal to match the new ThunkExtraArgument shape after accessToken removal.
- [ ] `ygg-chat/client/ygg-chat-r/src/features/conversations/conversationTypes.ts`
  - [ ] L1,13 `Conversation.storage_mode` — **keep-but-decouple** _(low)_: Keep as optional legacy field (DB column remains) or delete once all UI reads are removed.
- [ ] `ygg-chat/client/ygg-chat-r/src/helpers/chatKeyboardShortcuts.test.ts`
  - [ ] L28-29,38 `'OpenRouter' shortcut slot fixture` — **update-test** _(low)_: Optional: rename to 'OpenRouter BYOK'.
- [ ] `ygg-chat/client/ygg-chat-r/src/helpers/providerSettingsHost.test.ts`
  - [ ] L5 `vi.mock runtimeMode isCommunityMode:false` — **update-test** _(low)_: Remove the runtimeMode mock and update expectations to the local-only behaviour (selector always shown, community default fallback).
- [ ] `ygg-chat/client/ygg-chat-r/src/helpers/providerSettingsStorage.test.ts`
  - [ ] L45 `resolveProviderContextLength('OpenRouter')` — **update-test** _(low)_: Optional: use 'OpenRouter BYOK'.
- [ ] `ygg-chat/client/ygg-chat-r/src/helpers/storageHandler.ts`
  - [ ] `saveUserToStorage/loadUserFromStorage` — **delete-file** _(low)_: Its only consumer is usersActions.loginUser, which is being deleted. Delete the file.
- [ ] `ygg-chat/client/ygg-chat-r/src/hooks/useConversationSnapshotCoordinator.test.ts`
  - [ ] L70 `vi.mock useAuth accessToken:null` — **update-test** _(low)_: Update the mock to the new useAuth shape ({ userId }).
  - [ ] L90-92 `render(conversationId, storageMode)` — **update-test** _(low)_: Drop storageMode arg from render helper.
- [ ] `ygg-chat/client/ygg-chat-r/src/hooks/useConversationSnapshotCoordinator.ts`
  - [ ] L21,95,134 `useAuth accessToken passthrough` — **delete-code** _(low)_: Stop reading accessToken from useAuth and stop passing it to the coordinator. Remove accessToken from conversationSnapshotCoordinator.ts (95,114,133) and the FetchConversationMessagesTreeOptions.
- [ ] `ygg-chat/client/ygg-chat-r/src/hooks/useIdeContext.ts`
  - [ ] L290,343 `commented VITE_ENVIRONMENT checks` — **delete-code** _(low)_: Delete commented-out `if (import.meta.env.VITE_ENVIRONMENT === 'electron')` lines.
- [ ] `ygg-chat/client/ygg-chat-r/src/hooks/useModelSwitchConfirmation.test.ts`
  - [ ] L24-25 `'OpenRouter' fixture` — **update-test** _(low)_: Optional: rename to 'OpenRouter BYOK'.
- [ ] `ygg-chat/client/ygg-chat-r/src/hooks/useQueries.ts`
  - [ ] L61-63,97-99,213-215,257-259,388-390,537-539,660-662,880-882,953-955,1099-1101,1183-1185,1913-1915 `const { accessToken, userId } = useAuth(); void accessToken` — **delete-code** _(low)_: Remove the dead accessToken destructuring and the void statements in each hook.
- [ ] `ygg-chat/client/ygg-chat-r/src/lib/auth/managed.test.ts`
  - [ ] L1-19 `token-free renderer auth facade` — **update-test** _(low)_: Drop the 'app' snapshot from the fixture. Assert that the codex-only adopt still yields the local userId and no longer reads or removes 'supabase-auth-token'.
  - [ ] L5-11 `token-free renderer auth facade test` — **update-test** _(low)_: Remove app: snapshot('app') and the electronAPI.auth.migrate stub from the fixture. Assert that the fixed local userId is projected.
  - [ ] L5-18 `token-free renderer auth facade test` — **update-test** _(low)_: Update the snapshot state (drop the app slot, user => LOCAL_AUTH_USER_ID). Assert that getSession returns the fixed local userId and that the codex slot is still adopted.
- [ ] `ygg-chat/client/ygg-chat-r/src/lib/auth/transport.browser.test.ts`
  - [ ] `browser host auth transport test` — **update-test** _(low)_: Re-check against the reduced transport (no login/logout/start). Keep the status and events assertions.
  - [ ] L6-24 `browser identity transport` — **update-test** _(low)_: Fixture state includes app:{}, so update it to codex-only. Add an assertion that the transport has no login/start/code.
- [ ] `ygg-chat/client/ygg-chat-r/src/store/thunkExtra.ts`
  - [ ] L4-25 `ThunkExtraArgument.auth.accessToken/updateThunkExtraAuth` — **rewrite** _(medium)_: Remove auth.accessToken, which is always null with the managed facade, and set userId once to LOCAL_AUTH_USER_ID. Update searchActions.ts (17,44), which passes auth.accessToken. — ⚠ Many thunks read extra.auth.userId, so keep userId populated before the first dispatch.
- [ ] `ygg-chat/client/ygg-chat-r/src/utils/api.ts`
  - [ ] L698-878 `FORCE_LOGOUT_EVENT, sessionExpiredError, apiCall, api` — **delete-code** _(medium)_: apiCall routes non-CRUD endpoints to /api/cloud/*. Delete apiCall/api/sessionExpiredError/FORCE_LOGOUT_EVENT after callers are gone (PaymentPage, searchActions, usersActions.refreshUserCredits, useLoggingAnalytics cloud hook, patchConversationProject, cloneConversation). Update test mocks exporting FORCE_LOGOUT_EVENT. — ⚠ FORCE_LOGOUT_EVENT is imported by AuthContext and mocked in mainChatClient.test.ts/agentRunPreviewReconnect.test.ts; remove together with P3.
- [ ] `ygg-chat/client/ygg-chat-r/src/utils/executeToolAndWait.test.ts`
  - [ ] L4 `vi.mock ./api { environment:'electron' }` — **update-test** _(low)_: Drop `environment` from the mock.
- [ ] `ygg-chat/client/ygg-chat-r/src/utils/helpers.ts`
  - [ ] L5-8 `parseId doc comment 'Web mode (Supabase)'` — **update-docs** _(low)_: Rewrite comment: all ids are strings (UUID) in local SQLite; drop Web/Supabase wording.
- [ ] `ygg-chat/client/ygg-chat-r/src/vite-env.d.ts`
  - [ ] L4,6,12 `__BUILD_TARGET__/'web', __IS_WEB__, VITE_ENVIRONMENT 'web'` — **delete-code** _(low)_: After all 'web' checks are gone, remove 'web' from the __BUILD_TARGET__ and VITE_ENVIRONMENT unions and delete `declare const __IS_WEB__`.
- [ ] `ygg-chat/client/ygg-chat-r/tailwind.config.js`
  - [ ] L14-15 `fontFamily.display (Blog page fonts)` — **delete-code** _(low)_: Remove the 'Blog page fonts' display entry. font-display is not used outside landing/blog.
- [ ] `ygg-chat/client/ygg-chat-r/vitest.renderer.config.ts`
  - [ ] L24-30 `define __IS_WEB__/__IS_LOCAL__/__BUILD_TARGET__` — **update-test** _(low)_: Delete __IS_WEB__ (and __IS_LOCAL__ if target dropped); keep __BUILD_TARGET__/__IS_ELECTRON__ consistent with new clientCapabilities.
  - [ ] L25-28 `define __IS_WEB__/__IS_LOCAL__/__BUILD_TARGET__ default 'local'` — **config-change** _(low)_: Drop __IS_WEB__/__IS_LOCAL__. Pick a kept default for __BUILD_TARGET__ (e.g. 'electron') or keep 'local' only if that target survives.
  - [ ] L27 `__IS_WEB__ define` — **config-change** _(low)_: Delete the __IS_WEB__ define line once no source references it.
- [ ] `ygg-chat/docs/agent_context/AGENT.md`
  - [ ] L12-19,50,55,57 `Supported Runtime Scope + index entries for headless/auth/electron docs` — **update-docs** _(low)_: Rewrite the scope: fully local Electron plus LAN browser-client/standalone hosts, no web mode/cloud/Supabase/Railway/payments, no VITE_ENVIRONMENT branching (use __IS_ELECTRON__). Drop 'cloud gateway (/api/gw, /api/cloud)' from line 50/57 and 'Supabase' from line 55. Keep the lines 82-86 schema-migration rule.
  - [ ] L16 `VITE_ENVIRONMENT==='web' rule` — **update-docs** _(low)_: Replace with: mode detection via platform/clientCapabilities (__BUILD_TARGET__); never read import.meta.env.VITE_*.
- [ ] `ygg-chat/docs/agent_context/agent_auth.md`
  - [ ] L1-37 `Managed authentication doc` — **update-docs** _(low)_: Rewrite it as Codex-only credential ownership. Remove the app (Supabase/Railway) slot, appLogin deep-link/OOB, the esbuild Supabase anon-key bundling note, appAuthTokenManager and the login manual checks. Document the fixed local user id.
  - [ ] L21 `appLogin deep-link/OOB description` — **update-docs** _(low)_: Remove the Google/GitHub deep-link/OOB + Supabase user-endpoint validation + local-user merge paragraph. Keep the Codex PKCE/managedOAuthRoutes and codexUsage description.
- [ ] `ygg-chat/docs/agent_context/agent_branch.md`
  - [ ] L230 `local/cloud/legacy ID comparison note` — **update-docs** _(low)_: Reword to 'legacy numeric vs UUID ids' and drop 'cloud'.
- [ ] `ygg-chat/docs/agent_context/agent_chat_container.md`
  - [ ] L48,70-82,86,213,243,308 `conversationStorageMode / storageModeFromNav / useConversationStorageMode` — **update-docs** _(low)_: Remove the storage-mode inference section and the storageMode props/args once P5 drops them from Chat.tsx, updateCwd and the snapshot coordinator. Remove 'local and cloud conversations' from the validation list.
- [ ] `ygg-chat/docs/agent_context/agent_chat_pipeline.md`
  - [ ] L83,98,103-113,150-151,248-275,292-293,336-339,364 `cloudChatEnabled, CloudMirrorSink, cloud gateway/token layer, gwApi/cloudApi, free-tier SSE mapping` — **update-docs** _(low)_: Delete the 'Cloud gateway / token layer' and 'Provider routing, message sinks, cloud gateway' cloud parts, the isCloudRoute steps, the free_generations_update/generation_limit_reached rows, and the /stripe and /app-store allowlist. Describe TreeMessageSink as the only sink. Rename railwayTurn references to match P2.
  - [ ] L255 `relayFreeTierEvents / openRouterProvider note` — **update-docs** _(low)_: Delete the relayFreeTierEvents/openRouterProvider sentence.
- [ ] `ygg-chat/docs/agent_context/agent_chat_streaming_state.md`
  - [ ] L144,163 `'web mode is not a target'; 'Cloud tree reads enrich messages'` — **update-docs** _(low)_: Drop the web-mode aside and the cloud-tree enrichment sentence.
- [ ] `ygg-chat/docs/agent_context/agent_electron_main_local_server.md`
  - [ ] L18,31,45,52-55,61,69,73-75,81,86,94-96,113 `gateway/cloudProxy routes, railwayClient/cloudMirror/appAuthTokenManager services, envLoader, login deep links` — **update-docs** _(low)_: Remove /api/cloud, Railway, Stripe and free-tier, gateway-flag vestigial notes, and login/OAuth deep links (keep the Codex 1455 callback). Update the envLoader line once .env loading is removed. Add the GitHub-provider autoUpdater note for main.ts.
  - [ ] L37,53-55,73-75,86 `Electron main / server agent doc` — **update-docs** _(low)_: Remove login/OAuth deep-link, cloudProxy/railway/token-layer and 'Railway stays AUTHORITATIVE' statements. Document: auth IPC = codex status only, external links via shell:openExternal, updater feed = GitHub Releases (app-update.yml, no setFeedURL).
  - [ ] L42,53 `appStoreRoutes / cloudProxyRoutes app-store description` — **update-docs** _(low)_: Describe appStoreRoutes as community list proxy (anonymous) + install/uninstall + restart, with no upload/validate-upload. Drop /app-store from the cloudProxyRoutes allowlist text.
  - [ ] L45,69,74-76 `envLoader / VITE_ENVIRONMENT=standalone / cloud gateway notes` — **update-docs** _(low)_: Remove envLoader mention, VITE_ENVIRONMENT=standalone (BUILD_TARGET now), and Railway-authoritative/cloud gateway lines.
- [ ] `ygg-chat/docs/agent_context/agent_global_persistent_agent.md`
  - [ ] L53 `cloudMirrorService + CloudMirrorSink reference` — **update-docs** _(low)_: Drop the reference to the deleted cloud mirror.
- [ ] `ygg-chat/docs/agent_context/agent_headless_server.md`
  - [ ] `Cloud gateway/mirror/Railway/free-tier/gateway flags sections` — **update-docs** _(low)_: Remove cloud pass-through, Railway client, CloudMirrorSink, isCloudRoute, free-tier events, gatewayFlags sections; describe /api/gw as local-only facade, 4+byok providers, turnContext rename.
  - [ ] L13-15,24-25,40-52,81-89,104-105,168-199,222-227,237-238,245-246,254-255,265 `cloud gateway, railwayClient, cloudMirrorService, CloudMirrorSink, appAuthTokenManager, gatewayFlags, isCloudRoute, free_generations_update/generation_limit_reached` — **update-docs** _(low)_: Remove the cloud gateway/pass-through sections, Railway client/token layer, CloudMirrorSink/Railway-id adoption, free-tier SSE events 16-17, the 'Railway stays authoritative' invariants and the openrouter provider from the 5-provider list. Rewrite the feature flags to resumableRuns only. Keep /api/gw only if it is renamed to a local CRUD surface.
  - [ ] L25,51,178-180 `appAuthTokenManager / Supabase credential manager mentions` — **update-docs** _(low)_: Remove the appAuthTokenManager lines and change 'owns the process-wide Supabase/Codex credential manager' to Codex-only. Similar edits apply to agent_chat_pipeline.md:111, agent_electron_main_local_server.md:55,74 and migration_full_headless.md:125-194,352.
  - [ ] L171,227 `CloudMirrorSink/relayFreeTierEvents/openRouterProvider free-tier docs` — **update-docs** _(low)_: Remove the cloud-route, free-tier and openRouterProvider references. Document providerTypes.ts and the turnContext rename. Apply the same to agent_chat_pipeline.md:255 and server/headlessServer/headless.md:77.
- [ ] `ygg-chat/docs/agent_context/agent_heimdall.md`
  - [ ] L41,145,234 `conversationStorageMode arg; local/cloud ID notes; gateway-local routes` — **update-docs** _(low)_: Remove conversationStorageMode from the coordinator call and 'local/cloud' wording. Rename 'gateway-local routes' if /api/gw is renamed.
- [ ] `ygg-chat/docs/agent_context/agent_local_tools_runtime.md`
  - [ ] `Data Flow step 6 (TreeMessageSink/CloudMirrorSink)` — **update-docs** _(low)_: Drop CloudMirrorSink mention.
- [ ] `ygg-chat/docs/agent_context/agent_message_storage_shape.md`
  - [ ] L8,19-56,146,197,219-226,257,284-302,318-319 `frontmatter cloudMirrorService.ts path, StorageMode 'cloud'|'local', CloudMirrorSink id adoption, community mode, mixed local/cloud` — **update-docs** _(low)_: Drop the cloudMirrorService.ts frontmatter path (file deleted) and all local⊕cloud/Railway-id adoption text. State that storage is SQLite-only and that the storage_mode column is unused but kept (no migration).
- [ ] `ygg-chat/docs/agent_context/agent_project_overview.md`
  - [ ] L31,43-47,53,58,67,94,106-108 `Cloud gateway / gateway flags / Local storage mode / Web mode bullets; legacy dev/build:web note` — **update-docs** _(low)_: Remove the cloud gateway, storage-mode and web-mode bullets and the 'Legacy dev/build:web scripts' note (scripts are being removed). Fix references to general_project_context.md and PERSISTENT_AGENT_CONTEXT.md if those are deleted.
  - [ ] L34,43 `Railway cloud backend / Cloud gateway description` — **update-docs** _(low)_: Rewrite the Railway/cloud-gateway/cloud-mirror/free-tier paragraphs to describe a fully local app. Mention Railway only as the optional community app store backend.
  - [ ] L43,94 `cloud proxy Stripe/app-store note; legacy dev/build:web note` — **update-docs** _(low)_: Drop the Stripe and web-build mentions. State that the app store talks to Railway directly from server/routes/appStoreRoutes.ts (anonymous browse/install), not via /api/cloud.
  - [ ] L94 `legacy dev/build:web note` — **update-docs** _(low)_: Delete note once dev/build:web are removed.
- [ ] `ygg-chat/docs/agent_context/agent_runtime_modes.md`
  - [ ] L11,18,26-39,43-48,57-60,64-65,68-78,92-97 `Legacy Web Mode, Local Storage Mode, src/lib/auth/*, api.ts local/cloud, gatewayFlags chat/crud/cloudProxy, StorageMode` — **rewrite** _(low)_: Rewrite around Electron plus browser-client/standalone LAN hosts only. Remove web mode, storage_mode and cloud flags, and say gatewayFlags is resumableRuns only (or whatever P2 keeps). Note that runtime detection uses __IS_ELECTRON__/BUILD_TARGET defines, not VITE_ENVIRONMENT. Drop the general_project_context.md gotcha.
- [ ] `ygg-chat/docs/agent_context/agent_subagents_orchestration.md`
  - [ ] L27,35,54-55,61 `CloudMirrorSink, relayFreeTierEvents, railwaySessionId` — **update-docs** _(low)_: Remove CloudMirrorSink/relayFreeTierEvents mentions and rename railwaySessionId to the P2 replacement name.
- [ ] `ygg-chat/docs/graviton_context.md`
  - [ ] L144,285 `messageSink 'cloud mirroring'; legacy web-mode note` — **update-docs** _(low)_: Describe messageSink as local persistence only. Replace the legacy web-mode caveat with a fully local statement. Linked from readme.md.
- [ ] `ygg-chat/docs/shared-ui-implementation-status.md`
  - [ ] L11,67,94-95 `'Cloud sign-in directs users to Electron host'; 'cloud attachment/ID-adoption acceptance'; app login reservation; cloud prompt creation` — **update-docs** _(low)_: Add a note that app login, cloud prompts and cloud attachment/ID adoption were removed with the local-only change and are no longer acceptance items. Leave the historical validation logs as-is.
- [ ] `ygg-chat/docs/stateContext.md`
  - [ ] L62,265,282,419-421,584-600 `cloud APIs, storage_mode resolution, storageMode route state, 'local and cloud-backed data' section` — **update-docs** _(low)_: Remove the storage-mode-awareness section (584-600), the storageMode route-state notes and cloud API mentions, so the doc says TanStack Query reads only the local server. Linked from readme.md.
- [ ] `ygg-chat/general_project_context.md`
  - [ ] L1-213 `Web runtime + Supabase, root server/ (supaChat/stripe/openrouter worker), dual-sync, storage_mode, supabase-migrations` — **rewrite** _(low)_: Rewrite to a short local-only map, or delete and point to docs/agent_context/agent_project_overview.md. It describes a nonexistent root server/, Supabase web mode, Stripe and dual-sync throughout (l.8-41,73-74,116-146,204).
- [ ] `ygg-chat/package-lock.json`
  - [ ] L38-46,1262-1335,1981 `workspace entries client/ygg-chat-r/node_modules/@stripe|@supabase|@vercel/analytics` — **remove-dependency** _(low)_: Root workspace lockfile also pins the client's cloud deps; regenerate alongside the client lockfile. Keep node_modules/@vercel/oidc (L11431, from 'ai').
- [ ] `ygg-chat/paymentplan.md`
  - [ ] `Stripe subscriptions/credits ledger design doc` — **delete-file** _(low)_: Delete the Stripe/credits design doc. Payments are being removed.
- [ ] `ygg-chat/shared/hostPrompts.ts`
  - [ ] L10,33 `HostPrompt.storage_mode:'local'` — **keep-but-decouple** _(low)_: Keep: persisted host prompt schema (hostPromptStore + validateHostPrompts) emits it; dropping changes stored JSON. Optional later cleanup with hostPromptStore.test.ts.
- [ ] `ygg-chat/shared/types.ts`
  - [ ] L10,108,164,187 `StorageMode, SendMessage.storageMode, Project.storage_mode, ConversationRecord.storage_mode` — **keep-but-decouple** _(low)_: Delete line 108 request field. Keep storage_mode?: optional on Project/ConversationRecord (DB column stays) or narrow StorageMode to 'local'; no renderer logic may branch on it.
- [ ] `ygg-chat/stream_block_context.md`
  - [ ] L131 `useConversationMessages fetches from local/cloud APIs` — **update-docs** _(low)_: Change 'local/cloud APIs' to the local server.
- [ ] `ygg-chat/summary_system_context.md`
  - [ ] L108 `'derived from current user credits and prompt/completion pricing'` — **update-docs** _(low)_: Remove the credits-based derivation note. Compaction uses context limits only.
- [ ] `ygg-chat/summary_test_subagent.md`
  - [ ] `subagent-generated summary of general_project_context (web/Supabase/dual-sync)` — **delete-file** _(low)_: Delete. It is a stale test artifact describing web mode, cloud API on 3001 and dual-sync.

## Reviewed and intentionally unchanged

- `CLA.md` — karan@yggchat.com is a legal/contact email in the contributor agreement, not a runtime dependency. Optional brand edit only.
- `ygg-chat/client/ygg-chat-r/custom-tools/RPC_TOOL_GUIDE.md` — 'subscription' means event subscription; auth.context RPC returns the local userId tenant and stays.
- `ygg-chat/client/ygg-chat-r/docs/RIGHTBAR_BROWSER_PANE_SPEC.md` — Uses 'allowlist' for browser-pane URLs. Unrelated.
- `ygg-chat/client/ygg-chat-r/docs/hookInstruction.md` — Refers to the OpenAI/ChatGPT subscription used for hook generation. That is a kept provider.
- `ygg-chat/client/ygg-chat-r/migration_subagent_manager.md` — Uses 'subscription' in a UI/event sense.
- `ygg-chat/client/ygg-chat-r/public/wallpapers/matrix/js/config.js` — stripeColors is a matrix wallpaper parameter.
- `ygg-chat/client/ygg-chat-r/public/wallpapers/matrix/shaders/glsl/stripePass.frag.glsl` — Shader stripe pass, not Stripe.
- `ygg-chat/client/ygg-chat-r/scripts/build.test.mjs` — Asserts that electron-updater is packaged. electron-updater stays (feed moves to GitHub).
- `ygg-chat/client/ygg-chat-r/scripts/runtime-packaging.mjs` — The runtime package allowlist (L9) includes electron-updater, which stays. It has no Supabase/Stripe entries.
- `ygg-chat/client/ygg-chat-r/scripts/test-packaged-browser.cjs` — Checks localAnalyticsWorker packaging (local analytics). Env passthrough only.
- `ygg-chat/client/ygg-chat-r/server/TYPECHECK-DEAD-CODE.md` — Mentions localAnalyticsDashboard, which is local.
- `ygg-chat/client/ygg-chat-r/server/__tests__/corsPolicy.test.ts` — Tests the CORS allowlist for the LAN/browser host. Kept.
- `ygg-chat/client/ygg-chat-r/server/__tests__/hostPromptStore.test.ts` — The fixture's storage_mode:'local' matches shared/hostPrompts.ts, which is already local-only.
- `ygg-chat/client/ygg-chat-r/server/__tests__/localAnalyticsDashboard.test.ts` — Local analytics. Its netCreditsConsumed/topByCredits are recorded API cost fields, not Graviton credits. The dashboard's payments stub (L612) is covered by the scouts.
- `ygg-chat/client/ygg-chat-r/server/__tests__/localAnalyticsWorkerPackaging.test.ts` — Local analytics worker packaging.
- `ygg-chat/client/ygg-chat-r/server/__tests__/searchIndexSchema.test.ts` — Schema fixture for the storage_mode column, which stays per decision 3.
- `ygg-chat/client/ygg-chat-r/server/__tests__/serverConfig.test.ts` — CORS allowlist config.
- `ygg-chat/client/ygg-chat-r/server/__tests__/topLevelUserMessages.test.ts` — Schema fixture column only. The column stays.
- `ygg-chat/client/ygg-chat-r/server/auth/codexUsage.ts` — Reports ChatGPT/Codex account usage credits from the user's own OpenAI account. Kept.
- `ygg-chat/client/ygg-chat-r/server/corsPolicy.ts` — CORS allowlist for the LAN host.
- `ygg-chat/client/ygg-chat-r/server/localAnalyticsWorker.ts` — Local analytics.
- `ygg-chat/client/ygg-chat-r/server/localAnalyticsWorkerClient.ts` — Local analytics.
- `ygg-chat/client/ygg-chat-r/server/routes/analyticsRoutes.ts` — Local analytics routes.
- `ygg-chat/client/ygg-chat-r/server/searchIndexSchema.ts` — The FTS table has a storage_mode column with CHECK('cloud','local') DEFAULT 'local', plus triggers (L36-324). Leave it as is: dropping it needs a versioned migration and MIGRATIONS.md row, and every row is 'local' anyway.
- `ygg-chat/client/ygg-chat-r/server/serverConfig.ts` — CORS allowlist.
- `ygg-chat/client/ygg-chat-r/server/routes/hostAppBridgeRoutes.ts` — The AppSession type/appSession metadata (L14,23,79) are HTML-app bridge sessions, not the app login session.
- `ygg-chat/client/ygg-chat-r/server/tools/claudeBridge.ts` — 'Credits' refers to Claude usage.
- `ygg-chat/client/ygg-chat-r/server/tools/claudeBridge.test.ts` — 'Credits' refers to Claude usage.
- `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/__tests__/managedAuthRecovery.test.ts` — Codex-slot recovery test. reauth_required here is the codex AuthFailure category. Keep, and re-run after the app slot is removed from AuthSlot.
- `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/__tests__/managedOAuthRoutes.test.ts` — Mocks only getAuthManager().snapshot('codex') and acceptCodexSession. No app-slot dependency.
- `ygg-chat/client/ygg-chat-r/server/headlessServer/services/hookGenerationService.ts` — Uses only getAuthManager().snapshot('codex').status. Keep, provided runtime.ts keeps getAuthManager for codex.
- `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/__tests__/appAutomationRoutes.test.ts` — Schema fixtures plus a persisted storage_mode==='local' assertion (L244). Still valid if 'local' writes are kept.
- `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/lineageRoutes.ts` — Already local-only ('Cloud routing deliberately does not participate'). The /api/gw prefix is shared with the gateway collapse; rename is optional and must be coordinated with the renderer gwApi.
- `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/__tests__/lineageRoutes.test.ts` — Uses /api/gw URLs. Only needs changing if the prefix is renamed.
- `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/__tests__/noteSearchTriggers.test.ts` — Schema fixtures with the storage_mode column, which stays.
- `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/testHarnessClientScript.ts` — The harness creates a conversation with storage_mode:'local' (L222). Still valid. The server may ignore the field.
- `ygg-chat/client/ygg-chat-r/server/headlessServer/services/__tests__/chatOrchestrator.hooks.test.ts` — Schema fixture only.
- `ygg-chat/client/ygg-chat-r/server/headlessServer/services/__tests__/claudeHookGeneration.test.ts` — Mentions a Claude/OpenAI subscription.
- `ygg-chat/client/ygg-chat-r/server/headlessServer/services/__tests__/contextLoading.test.ts` — The 'web' match is an apps/web path fixture.
- `ygg-chat/client/ygg-chat-r/server/headlessServer/services/__tests__/replExecutor.test.ts` — REPL allowlist.
- `ygg-chat/client/ygg-chat-r/server/headlessServer/services/compactionToolPolicy.ts` — Tool allowlist.
- `ygg-chat/client/ygg-chat-r/server/headlessServer/services/watchService.ts` — Event subscription.
- `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/__tests__/hyperRouterAdapter.test.ts` — Imports OpenRouterProvider from @hyper-labs/hyper-router (BYOK direct to openrouter.ai), not the Railway openRouterProvider.ts. Keep.
- `ygg-chat/client/ygg-chat-r/server/headlessServer/services/subagentTranscriptSink.ts` — Imports only the kept MessageSink/AssistantMessageDraft types. No CloudMirrorSink use.
- `ygg-chat/client/ygg-chat-r/src/utils/loggingAnalytics.ts` — Local analytics helpers. No cloud-only credit fields.
- `ygg-chat/client/ygg-chat-r/src/utils/loggingAnalytics.test.ts` — Local analytics.
- `ygg-chat/client/ygg-chat-r/src/features/chats/OpenAIChatGPT.ts` — Mentions a ChatGPT Plus subscription (kept provider).
- `ygg-chat/client/ygg-chat-r/src/features/chats/prompts/default_subagent_mode.md` — Tool allowlist wording.
- `ygg-chat/client/ygg-chat-r/src/helpers/matrixBackgroundStorage.test.ts` — Allowlist wording.
- `ygg-chat/client/ygg-chat-r/src/helpers/serverLoopSettings.test.ts` — Mocks runtimeMode with only isElectronMode, which stays.
- `ygg-chat/client/ygg-chat-r/src/helpers/serverLoopSettings.browser.test.ts` — Mocks runtimeMode with only isElectronMode, which stays.
- `ygg-chat/client/ygg-chat-r/src/components/RunningAgentsFloatingButton/agentForkPreview.test.ts` — Store subscription.
- `ygg-chat/client/ygg-chat-r/src/components/RunningAgentsFloatingButton/useVisibleAgentGridRows.ts` — Store subscription.
- `ygg-chat/client/ygg-chat-r/src/components/ParallelChatPane/ParallelChatPane.tsx` — 'Upgrade' is the operation-mode upgrade (plan to agent), not billing.
- `ygg-chat/client/ygg-chat-r/src/components/ToolPermissionDialog/ToolPermissionDialog.tsx` — 'operation-mode-upgrade' and Plan Mode refer to Claude plan mode, not payment plans.
- `ygg-chat/client/ygg-chat-r/src/store/store.ts` — Store subscription. usersReducer stays until usersSlice is trimmed; the User credit fields are covered in usersTypes.
- `ygg-chat/client/ygg-chat-r/src/utils/mcpAppToolResult.test.ts` — Subscription wording.
- `ygg-chat/client/ygg-chat-r/src/containers/RecentLineages.tsx` — Does not read storageMode. Only the RecentLineage type in useQueries (covered) carries it.
- `ygg-chat/client/ygg-chat-r/server/headlessServer/ui/mobile/assets/mobile.css` — .mobile-auth-pill/.mobile-settings-auth-row style the provider-connection badge in MobileHeader L350-351 (covered). Remove the CSS only if that badge is deleted.
- `ygg-chat/client/ygg-chat-r/server/headlessServer/ui/mobile/src/customToolIframeBridge.ts` — The AUTH_CONTEXT to auth.context RPC passes the local userId tenant. Kept custom-tools feature.
- `ygg-chat/docs/agent_context/agent_context_compaction_memory.md` — Wording only.
- `ygg-chat/docs/agent_context/agent_hooks_system.md` — Wording only.
- `ygg-chat/docs/agent_context/agent_html_iframe_apps.md` — Allowlist wording.
- `ygg-chat/docs/agent_context/agent_tool_registry.md` — Wording only.
- `ygg-chat/docs/claude-bridge-tool.md` — Claude usage wording.
- `ygg-chat/docs/repl-tool.md` — Allowlist wording.
- `ygg-chat/docs/watcher-tool.md` — Wording only.
- `ygg-chat/shared/builtinToolDefinitions.ts` — Claude usage credits. No storage_mode or cloud references.
- `ygg-chat/shared/replGuide.ts` — Pricing wording unrelated to payments.
- `CLA.md` — Contact email karan@yggchat.com in a legal doc. Not a runtime dependency. Update only if the domain is dropped.
- `reproduce_issue.sh` — 'webbdrasil' is a local filesystem path, not the Railway host.
- `ygg-chat/test_wsl.js` — WSL path containing 'webbdrasil' folder name. Not a cloud dependency.
- `ygg-chat/test_wsl2.js` — Same WSL path false positive.
- `ygg-chat/client/ygg-chat-r/public/wallpapers/matrix/shaders/glsl/stripePass.frag.glsl` — Shader stripe pass. Unrelated to Stripe payments.
- `ygg-chat/client/ygg-chat-r/src/components/ActionPopover/actionPopoverTheme.ts` — --cloud-* is a CSS palette/class prefix (action-cloud), not cloud storage. Same for ActionPopover.tsx, ActionPopoverControls.tsx, actionPopover.css, Select.test.ts, select.css, searchList.css.
- `ygg-chat/client/ygg-chat-r/server/searchIndexSchema.ts` — storage_mode column/CHECK and FTS triggers copy a DB column. Per decision 3, DB columns stay in place unused. No migration needed.
- `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/__tests__/noteSearchTriggers.test.ts` — Fixture schemas include storage_mode columns that mirror the retained DB schema. Same for appAutomationRoutes.test.ts, chatOrchestrator.hooks.test.ts, topLevelUserMessages.test.ts, searchIndexSchema.test.ts, localAnalyticsDashboard.test.ts.
- `ygg-chat/client/ygg-chat-r/server/__tests__/localAnalyticsDashboard.test.ts` — netCreditsConsumed/topByCredits come from the local provider_cost.api_credit_cost metric (provider-reported cost), not Graviton credits.
- `ygg-chat/client/ygg-chat-r/server/__tests__/hostPromptStore.test.ts` — storage_mode:'local' fixture matches the shared/hostPrompts.ts type. Update only if that covered type drops the field.
- `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/testHarnessClientScript.ts` — Creates local conversations with storage_mode:'local'. Its OAuth flow is Codex (/api/openai/auth), which is kept.
- `ygg-chat/client/ygg-chat-r/server/auth/codexUsage.ts` — credits are OpenAI/Codex usage credits (kept provider).
- `ygg-chat/client/ygg-chat-r/server/tools/claudeBridge.ts` — 'usage credits' refers to Claude CLI billing. Kept Claude Code backend.
- `ygg-chat/client/ygg-chat-r/server/tools/braveSearch.ts` — X-Subscription-Token is the Brave API header.
- `ygg-chat/client/ygg-chat-r/server/routes/hostAppBridgeRoutes.ts` — AppSession is the local HTML-app bridge session, not the Supabase app session.
- `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/customToolRpcRoutes.ts` — auth.context returns tenantId from x-user-id. That works with the local user id. Also covers mobile customToolIframeBridge AUTH_CONTEXT.
- `ygg-chat/client/ygg-chat-r/server/headlessServer/routes/__tests__/managedOAuthRoutes.test.ts` — Mocks auth/runtime for Codex OAuth only (kept).
- `ygg-chat/client/ygg-chat-r/server/headlessServer/providers/__tests__/managedAuthRecovery.test.ts` — Codex slot reauth_required. Kept.
- `ygg-chat/client/ygg-chat-r/server/headlessServer/services/compactionService.ts` — accessToken/authSessionId inputs are also consumed by LM Studio and Codex providers (lmStudioProvider.ts:222).
- `ygg-chat/client/ygg-chat-r/server/messageRevisionSchema.ts` — Only a doc comment mentions cloud mirrors. Optional wording cleanup, no behavior change.
- `ygg-chat/client/ygg-chat-r/src/features/chats/messageTransfer.ts` — Comment about cloud/legacy rows. The fallback ordering also serves legacy local rows.
- `ygg-chat/client/ygg-chat-r/src/features/chats/OpenAIChatGPT.ts` — 'subscription' refers to the ChatGPT Plus/Pro plan (kept Codex provider).
- `ygg-chat/client/ygg-chat-r/server/__tests__/mcpCelestialOAuth.test.ts` — 'Cloudflare' challenge in an MCP OAuth test.
- `ygg-chat/client/ygg-chat-r/src/utils/loggingAnalytics.test.ts` — Local variable named 'cloud'. Asserts local batching behavior.
- `ygg-chat/client/ygg-chat-r/server/headlessServer/persistence/__tests__/deleteMessages.test.ts` — (listed above only for wording) The lock itself is local behavior and must be kept.
- `ygg-chat/client/ygg-chat-r/src/helpers/remoteServerSettingsStorage.ts` — Remote base URL for the mobile LAN UI (kept), not the Railway backend.
