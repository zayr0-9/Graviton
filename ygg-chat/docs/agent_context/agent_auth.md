---
paths:
  - "client/ygg-chat-r/server/auth/**"
  - "client/ygg-chat-r/server/routes/managedOAuthRoutes.ts"
  - "client/ygg-chat-r/src/lib/auth/**"
  - "shared/auth.ts"
---

# Managed authentication (Electron)

## Ownership

`client/ygg-chat-r/server/auth/runtime.ts` constructs one process-wide `AuthSessionManager` over the injected settings store. Electron injects its own store instance through `buildElectronHostCapabilities(configStore)`. `app` (Supabase/Railway) and `codex` (ChatGPT) are independent credential slots. Canonical records live under `managed_auth_v1`; renderer receives only `shared/auth.ts` snapshots.

Refresh adapters live in `server/auth/refreshAdapters.ts`. Refresh is single-flight per slot/session, commits before publication, uses adaptive expiry skew, bounded backoff and a 20-second timeout. Invalid grant becomes reconnect-required; temporary failure retains credentials. A persisted `refreshPending` marker makes interrupted rotations require reconnect after restart rather than blindly reusing an old rotating token. Settings persistence remains unencrypted, with existing file permissions; this is not a keychain implementation.

## Lifecycle and migration

`headlessServer/index.ts` initializes auth after the provider table exists. `authMigration.ts` imports legacy Electron and SQLite OAuth records, deduplicates aliases, and requires reconnect for divergent credentials. The trusted desktop renderer makes one legacy localStorage handoff, erases source keys after acknowledgement, and starts owner scheduling. No normal renderer session reads/writes remain. Generic storage IPC rejects auth keys. Server shutdown stops owner work; Electron resume and renderer online checks recheck freshness.

`server/auth/appLogin.ts` owns Google/GitHub deep-link/OOB flow state. Main validates callback tokens using Supabase's user endpoint and performs the existing local-user merge. `server/routes/managedOAuthRoutes.ts` owns Codex PKCE callback/manual exchange and completion polling; no OAuth credentials appear in completion JSON or callback HTML. `server/auth/codexUsage.ts` uses the same owner as inference.

Main-process public Supabase URL/anon-key configuration is bundled by `electron/esbuild.main.mjs` from the build environment. Never bundle service-role keys.

## Requests and recovery

Main chat retains session references, not access-token snapshots. Each provider attempt resolves fresh credentials. Compaction and child dispatch inherit references; a replaced account cannot satisfy an old reference. Codex HTTP/WS auth rejection has a single pre-output retry. Partial output fences retry/fallback. Railway gateway retries once; typed failures propagate instead of returning stale credentials as fresh.

`appAuthTokenManager.ts` is a Railway adapter, not another refresher. The `gateway.tokenOwner` and renderer token-owner flag are removed. Raw OAuth registration endpoints return 410; API-key providers still use `ProviderTokenStore`.

## Renderer

`src/lib/auth/managed.ts` is an identity/status projection. `publicState.ts` deliberately has no Redux/store dependency so model/settings helpers do not introduce circular imports. `ManagedLogin.tsx` issues commands only. `chatgptAccount.ts` supplies public account status, usage IPC and model metadata. Global auth warnings use the existing error notice UI; app errors offer Sign in, Codex errors offer Reconnect. Reconnecting does not replay a failed run or its tools.

## Validation and remaining release checks

Run `test:headless`, `test:renderer`, `test:server`, `typecheck:electron`, `typecheck:mobile`, `build:electron`, and `build:electron:main` from the client package. Migration/lifecycle tests use synthetic credentials only. Manually verify installed-app deep-link/OOB login, callback-port conflict/manual completion, sleep/wake, offline recovery, logout/account switch during a run, and cold restart. Never print tokens in diagnostics.
