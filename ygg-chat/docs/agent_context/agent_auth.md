---
paths:
  - "client/ygg-chat-r/server/auth/**"
  - "client/ygg-chat-r/server/routes/managedOAuthRoutes.ts"
  - "client/ygg-chat-r/src/lib/auth/**"
  - "shared/auth.ts"
  - "shared/localUser.ts"
---

# Identity and managed authentication (Electron)

## No accounts

Graviton is fully local: there is no Graviton account, sign-in, logout, Supabase or Railway session. Identity is always the single local user `LOCAL_USER_ID` from `shared/localUser.ts`. `server/auth/localIdentity.ts` seeds its `users` row at server start (`ensureLocalUser`; foreign keys are on), and `publicAuthState()` always projects `{ codex, user: { id: LOCAL_USER_ID } }` (`shared/hostRuntime.ts` `HostAuthState`). There is no `/login` route; `ProtectedRoute` waits for the host projection and offers Retry if the host is unreachable.

Legacy data: older builds re-assigned local rows to a signed-in Supabase user id. On startup `initializeAuth` reads that id from the retired `managed_auth_v1.app` record, moves `projects`, `conversations`, `provider_cost` and `note_search_docs` rows back to the local user (`reassignLegacyAccountData`: plain UPDATEs, old users row kept so nothing cascades), then clears the record, so it runs once.

## ChatGPT (Codex) credentials

`server/auth/runtime.ts` constructs one process-wide `AuthSessionManager` over the injected settings store. The only credential slot is `codex` (`shared/auth.ts` `AuthSlot`). Canonical records live under `managed_auth_v1`; the renderer receives only token-free snapshots.

`server/auth/refreshAdapters.ts` refreshes against `auth.openai.com`. Refresh is single-flight per slot/session, commits before publication, uses adaptive expiry skew, bounded backoff and a 20-second timeout. Invalid grant becomes reconnect-required; temporary failure retains credentials. A persisted `refreshPending` marker makes interrupted rotations require reconnect after restart. Settings persistence is unencrypted, with existing file permissions; this is not a keychain implementation.

`server/routes/managedOAuthRoutes.ts` owns Codex PKCE callback/manual exchange and completion polling; no OAuth credentials appear in completion JSON or callback HTML. `server/auth/codexUsage.ts` uses the same owner as inference.

## Lifecycle and migration

`headlessServer/index.ts` initializes auth after the provider table exists; owner scheduling starts unconditionally. `authMigration.ts` imports legacy Electron and SQLite ChatGPT records, deduplicates aliases, and requires reconnect for divergent credentials. The trusted desktop renderer makes a one-time codex-only localStorage handoff (`auth:migrate`); delete it in the next release. Generic storage IPC rejects auth keys. Server shutdown stops owner work; Electron resume and renderer online checks recheck freshness.

## Requests and recovery

Main chat retains session references, not access-token snapshots. Each provider attempt resolves fresh credentials. Compaction and child dispatch inherit references; a replaced account cannot satisfy an old reference. Codex HTTP/WS auth rejection has a single pre-output retry. Partial output fences retry/fallback. Raw OAuth registration endpoints return 410; API-key providers use `ProviderTokenStore`.

## Renderer

`src/lib/auth/managed.ts` projects identity and the Codex status. `publicState.ts` has no Redux/store dependency to avoid circular imports. `AuthContext` exposes `{ user, userId, loading, reloadSession }` and seeds Redux `users.currentUser` with the constant local profile. Codex `reauth_required` raises a `provider_signin_required` notice (Reconnect → Settings). External links open through `electronAPI.shell.openExternal` (main window only).

## Validation

Run `test:headless`, `test:renderer`, `test:server`, `typecheck:electron`, `typecheck:mobile`, `build:electron` and `build:electron:main` from the client package. Migration/lifecycle tests use synthetic credentials only. Manually verify ChatGPT sign-in/refresh, callback-port conflict/manual completion, sleep/wake, offline recovery and cold restart. Never print tokens in diagnostics.
