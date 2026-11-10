# Login Context

> **Historical — cloud parts removed.** Graviton is now fully local (2026-11): there is no Supabase/Railway
> account or sync, cloud storage mode, hosted OpenRouter provider, Stripe billing or web product. Sections that
> describe those are kept for history only. Current behaviour: `ygg-chat/docs/agent_context/AGENT.md`.

## Scope

This document explains how login/authentication works for:

1. the main Electron app,
2. the normal web flow, and
3. the embedded/local headless server pieces that depend on the Electron app session.

Primary entry point investigated:
- `ygg-chat/client/ygg-chat-r/src/containers/Login.tsx`

---

## Executive summary

There are **two conceptually different auth layers** in this app:

1. **App/session auth**
   - Backed by Supabase for cloud users.
   - Backed by a synthetic local user/token for community/local mode.
   - Managed centrally by `AuthContext` + an environment-specific auth provider.

2. **Headless/provider auth**
   - The local Electron server stores provider-related tokens in its own SQLite `provider_tokens` table.
   - For OpenRouter-related capabilities, the Electron renderer syncs the current **app access token** into the headless server token store.
   - The mobile/headless UI can also directly read the Electron app's persisted `auth_session`.

So the headless server does **not** really have a full independent login flow of its own. Instead, it mostly:
- consumes the Electron app's persisted session (`auth_session`), and/or
- consumes provider tokens pushed into local routes such as `/api/provider-auth/openrouter/token`.

---

## High-level architecture

### 1) Route entry and protection

- `src/App.tsx:39-44` chooses `HashRouter` for Electron and `BrowserRouter` for web.
- `src/App.tsx:180` exposes `/login` publicly.
- `src/App.tsx:200` redirects Electron `/` to `/login`.
- `src/components/ProtectedRoute.tsx:17-28` redirects unauthenticated users to `/login`.
- In pure `local` environment, `ProtectedRoute` bypasses auth entirely (`src/components/ProtectedRoute.tsx:11-15`).

### 2) Auth provider selection

`src/lib/auth/index.ts` picks the auth provider:
- `src/lib/auth/index.ts:28-31` returns a cached provider if already created.
- `src/lib/auth/index.ts:41-43` prefers `ElectronAuthProvider` whenever `window.electronAPI` exists.
- `src/lib/auth/index.ts:64-72` falls back to runtime env selection.
- `src/lib/auth/index.ts:80-83` initializes and caches the provider.

### 3) Runtime auth mode classification

`src/config/runtimeMode.ts` decides whether the runtime is in cloud or community/local mode:
- `src/config/runtimeMode.ts:6` defines the shared local synthetic user ID.
- `src/config/runtimeMode.ts:17-24` defines `isCloudSession()`: JWT-like access token + non-local token => cloud session.
- `src/config/runtimeMode.ts:56-59` derives `isCommunityMode` / `isElectronCommunityMode` from that.
- `src/config/runtimeMode.ts:69-77` updates those flags when auth state changes.

This classification is important because the UI and providers behave very differently depending on whether the current session is:
- a real Supabase JWT cloud session, or
- a local synthetic token (`electron-local-token` / `local-mode-token`).

---

## Main files and why they matter

### Core login/UI files
- `src/containers/Login.tsx`
  - Main login UI and flow orchestration.
- `src/contexts/AuthContext.tsx`
  - Initializes auth provider, exposes `signIn`, `signOut`, `reloadSession`, and syncs Redux/user profile.
- `src/lib/auth/index.ts`
  - Provider factory.
- `src/lib/auth/electron.ts`
  - Electron-specific auth/session persistence and refresh logic.
- `src/lib/auth/supabase.ts`
  - Web/Supabase auth provider.
- `src/config/runtimeMode.ts`
  - Distinguishes cloud vs local/community mode.

### Electron bridge / desktop runtime files
- `electron/preload.ts`
  - Exposes `electronAPI.auth.*` and `electronAPI.storage.*` to the renderer.
- `electron/main.ts`
  - Registers custom protocol handler (`yggchat://...`), receives OAuth callbacks, stores renderer state, starts local server.

### Headless/local server files
- `electron/headlessServer/index.ts`
  - Wires token store + provider auth routes into the local server.
- `electron/headlessServer/routes/providerAuthRoutes.ts`
  - Stores/retrieves provider token records.
- `electron/headlessServer/providers/tokenStore.ts`
  - SQLite-backed token persistence.
- `src/lib/auth/headlessProviderTokenSync.ts`
  - Renderer -> local server sync of the app token into the provider token store.
- `electron/headlessServer/ui/mobile/src/api.ts`
  - Headless/mobile UI reads the app session from Electron storage and can also write provider token records.
- `src/utils/api.ts`
  - Resolves local server origin via Electron IPC.

### Callers that force cloud login
- `src/containers/Chat.tsx:4317`
- `src/containers/appStore.tsx:473`

Those navigate to `/login?required=cloud`.

---

## `Login.tsx` structure

## 1) Initial state and mode detection

Relevant lines:
- `src/containers/Login.tsx:16-44`

What happens:
- Reads auth state from `useAuth()` (`user`, `userId`, `accessToken`, `reloadSession`, `signIn`).
- Computes `requiresCloudLogin` from `?required=cloud` (`line 40`).
- Computes `hasCloudSession` using `isCloudSession(...)` (`lines 41-44`).
- Maintains UI state for:
  - OOB/manual code flow (`lines 28-31`)
  - deep-link waiting/fallback (`lines 33-36`)

## 2) Electron-only helper: merge local data into cloud account

Relevant lines:
- `src/containers/Login.tsx:46-64`

What it does:
- In Electron only, after successful cloud login, it POSTs to `/local/users/merge` via `localApi`.
- It migrates data from the synthetic local user (`LOCAL_AUTH_USER_ID`) into the authenticated cloud user.

## 3) Electron-only helper: persist cloud session for renderer + headless server

Relevant lines:
- `src/containers/Login.tsx:66-98`

What it does:
- Builds an `auth_session` object (`lines 74-84`).
- Writes it to Electron persistent storage (`line 86`).
- Calls `syncHeadlessOpenRouterToken(...)` (`lines 88-92`).
- Calls `reloadSession()` so `AuthContext` / `ElectronAuthProvider` reload from persisted state (`line 97`).

This is the key bridge from the login UI into the rest of the app.

## 4) Post-login redirect logic

Relevant lines:
- `src/containers/Login.tsx:106-147`

Behavior:
- If `?required=cloud` is present and there is no real cloud session, it stays on login (`lines 108-110`).
- Otherwise, once `user` exists and auth loading is done, it routes either:
  - to `/homepage`, or
  - to the latest recent conversation.

Important subtlety:
- `requiresCloudLogin` is stricter than just `user != null`.
- A synthetic local/community login is **not** sufficient when cloud-only functionality triggered the login route.

## 5) Non-Electron Supabase auth-state listener

Relevant lines:
- `src/containers/Login.tsx:149-179`

Behavior:
- In non-Electron mode only, the component subscribes to `supabase.auth.onAuthStateChange(...)`.
- In Electron, this listener is explicitly skipped to avoid conflicts with `ElectronAuthProvider`.

## 6) Electron OAuth callback handling

Relevant lines:
- `src/containers/Login.tsx:181-261`

Behavior:
- Registers `window.electronAPI.auth.onOAuthCallback(...)` (`lines 183-187`).
- Parses the callback URL hash for `access_token` and `refresh_token` (`lines 199-205`).
- Calls `supabase.auth.setSession(...)` (`lines 208-214`).
- On success in Electron mode:
  - syncs the user into local SQLite via `dualSync.syncUser(...)` (`lines 227-232`)
  - merges local synthetic-user data into the cloud user (`line 234`)
  - persists `auth_session` and reloads context (`lines 236-245`)

This is the main desktop cloud-login completion path.

## 7) Primary login button flow: GitHub / Google

Relevant lines:
- `src/containers/Login.tsx:263-326`

### Electron path
- `src/containers/Login.tsx:273-280`
  - Calls `supabase.auth.signInWithOAuth(...)` with:
    - `redirectTo: 'yggchat://auth/callback'`
    - `skipBrowserRedirect: true`
- `src/containers/Login.tsx:287`
  - Opens the returned URL in the user's external browser via Electron IPC.
- `src/containers/Login.tsx:299-307`
  - Enters a waiting state and shows manual fallback after 5 seconds.

### Web path
- `src/containers/Login.tsx:311-320`
  - Calls `signInWithOAuth(...)` with redirect back to `${window.location.origin}/login`.

## 8) Community/local login

Relevant lines:
- `src/containers/Login.tsx:328-339`

Behavior:
- Calls `signIn({ email: '', password: '' })`.
- That blank-credential path is interpreted by `AuthContext` / `ElectronAuthProvider` as a local synthetic login.

## 9) OOB/manual code fallback flow

Relevant lines:
- Initiation: `src/containers/Login.tsx:341-375`
- Code exchange: `src/containers/Login.tsx:377-435`

Behavior:
- Uses a Railway-hosted callback (`redirectTo: ${RAILWAY_URL}/auth/callback`) rather than the custom protocol deep link.
- Opens browser externally.
- User pastes a displayed code.
- Component exchanges that code via `POST ${RAILWAY_URL}/api/auth/oob/exchange` (`lines 385-389`).
- Resulting tokens are passed to `supabase.auth.setSession(...)` (`lines 398-404`).
- Then it runs the same Electron post-login sync/persist path (`lines 408-425`).

## 10) UI rendering states

Relevant lines:
- OOB UI: `src/containers/Login.tsx:478-538`
- Waiting-for-callback UI: `src/containers/Login.tsx:540-566` (within the rendered section)
- Default buttons / cloud-vs-local options: `src/containers/Login.tsx:568+`
- `?required=cloud` disables the local-mode option (`src/containers/Login.tsx:464-467`, `lines 588-617` area)

---

## AuthContext data flow

Relevant lines:
- `src/contexts/AuthContext.tsx:52-68` — `updateAuthState(...)`
- `src/contexts/AuthContext.tsx:71-118` — `syncUserProfile(...)`
- `src/contexts/AuthContext.tsx:161-257` — provider initialization and subscription
- `src/contexts/AuthContext.tsx:275-339` — `signIn(...)`
- `src/contexts/AuthContext.tsx:371-405` — `reloadSession(...)`

### What AuthContext does

1. Calls `getAuthProvider()` on mount (`line 166`).
2. Reads the provider's initial session and updates context state (`lines 177-182`).
3. Syncs the profile into Redux / local SQLite (`lines 185`, `71-118`).
4. Subscribes to provider auth changes (`lines 188-202`).
5. If provider `requiresNetworkAuth()`, it installs periodic refresh + focus/visibility refresh (`lines 208-248`).

### Local blank-credential sign-in path

When `signIn({ email: '', password: '' })` is called:
- `src/contexts/AuthContext.tsx:281-312`
- It creates a synthetic local auth state.
- In Electron mode it persists that to `auth_session` (`line 299`).

This is how "Continue in Local Mode" works.

### `reloadSession()`

`src/contexts/AuthContext.tsx:371-405`
- Used by `Login.tsx` after Electron cloud session persistence.
- Delegates to provider-specific `reloadSession()` when supported.

---

## Electron auth provider behavior

Relevant lines:
- `src/lib/auth/electron.ts:58-137` — initialization
- `src/lib/auth/electron.ts:157-254` — login handling
- `src/lib/auth/electron.ts:261-299` — logout
- `src/lib/auth/electron.ts:303-359` — token refresh
- `src/lib/auth/electron.ts:377-379` — `requiresNetworkAuth()`
- `src/lib/auth/electron.ts:387-437` — `reloadSession()`

### Initialization path

During startup, `ElectronAuthProvider.initialize()`:
- clears storage and starts null-auth state if runtime is community mode (`src/lib/auth/electron.ts:66-79`)
- otherwise loads `auth_session` from Electron storage (`line 85`)
- refreshes expired cloud sessions if possible (`lines 93-121` area)
- syncs valid cloud sessions back into the Supabase client (`lines 126-133`)
- syncs the local headless token store too (`line 133`)

### Local/community login path

Relevant lines:
- `src/lib/auth/electron.ts:157-191`

Behavior:
- If `isCommunityMode` or credentials are blank, it creates a synthetic local auth session.
- Persists that to `auth_session` (`line 182`).
- Clears previously synced headless/provider token state (`line 188`).

### Cloud login path in this provider

Relevant lines:
- `src/lib/auth/electron.ts:194-254`

This path exists, but the current `Login.tsx` cloud flow does **not** really use `electronAPI.auth.login(...)`.
Instead, cloud login is completed via external OAuth + callback + `supabase.auth.setSession(...)` + persisted `auth_session`.

### Refresh path

Relevant lines:
- `src/lib/auth/electron.ts:303-359`

Behavior:
- Local synthetic tokens never expire (`lines 304-307`).
- Real cloud sessions refresh through Supabase using the stored refresh token.
- Updated session is re-persisted to `auth_session` (`line 348`) and re-synced to the headless token store (`line 350`).

### Reload path

Relevant lines:
- `src/lib/auth/electron.ts:387-437`

Behavior:
- Re-reads `auth_session` from Electron storage (`line 394`).
- Refreshes if expired (`line 405`).
- Re-syncs Supabase and headless token store (`lines 428-432`).
- Notifies listeners so `AuthContext` updates.

---

## Web/Supabase flow

Relevant lines:
- `src/lib/auth/supabase.ts:29-56` — auth state listener and cache updates
- `src/lib/auth/supabase.ts:61-82` — `exchangeCodeForSession(...)`
- `src/lib/auth/supabase.ts:94-160` — session reads
- `src/lib/auth/supabase.ts:180-189` — password login
- `src/lib/auth/supabase.ts:228-237` — refresh

Web flow summary:
1. `Login.tsx` calls `supabase.auth.signInWithOAuth(...)` with redirect back to `/login`.
2. On return, `SupabaseAuthProvider.initialize()` checks the `code` query param and calls `exchangeCodeForSession(code)` (`line 69`).
3. The provider caches the resulting session and notifies listeners.
4. `AuthContext` consumes the provider state and redirects accordingly.

---

## Electron main/preload bridge

### Preload surface

Relevant lines:
- `electron/preload.ts:6-17`
- `electron/preload.ts:19-23`

Renderer gets:
- `electronAPI.auth.openExternal(...)`
- `electronAPI.auth.onOAuthCallback(...)`
- `electronAPI.storage.get(...)`
- `electronAPI.storage.set(...)`
- `electronAPI.storage.clear()`

### Custom protocol and callback delivery

Relevant lines:
- `electron/main.ts:596-608` — registers `yggchat` protocol handler
- `electron/main.ts:612-615` — macOS `open-url`
- `electron/main.ts:620-639` — Windows/Linux second-instance deep-link handling
- `electron/main.ts:645-652` — forwards callback URL to renderer via `oauth:callback`
- `electron/main.ts:920-927` — `auth:openExternal` IPC handler

Desktop cloud flow is therefore:
1. Renderer asks Supabase for an OAuth URL.
2. Renderer asks main process to open that URL in the external browser.
3. Browser redirects to `yggchat://auth/callback#...`.
4. Main process receives the deep link and forwards it to renderer over `oauth:callback`.
5. `Login.tsx` parses tokens and persists session.

### Storage implementation

Relevant lines:
- `electron/main.ts:168-170` — persistent storage uses `Conf`
- `electron/main.ts:783-817` — `storage:get` / `storage:set`
- `electron/main.ts:827-839` — `storage:clear`

---

## Headless/local server auth relationship

## Important distinction

The headless/local server does **not** appear to run a first-class user login flow itself.
Instead, it depends on token/state that the Electron app pushes or exposes.

There are **two** patterns here.

### A) Headless/mobile UI reads the Electron app session directly

Relevant lines:
- `electron/headlessServer/ui/mobile/src/api.ts:56-83` — `readRuntimeAppSession()`
- `electron/headlessServer/ui/mobile/src/api.ts:380-387` — `getRuntimeAppAuth()`

Behavior:
- The mobile/headless UI tries `window.electronAPI.storage.get('auth_session')` first (`line 59`).
- If that fails, it falls back to web `localStorage` (`lines 68-80`).
- It exposes this via `getRuntimeAppAuth()`.

So yes: **part of the headless/mobile experience really does just fetch the Electron app token/session from Electron storage.**

### B) Renderer syncs app/provider tokens into the headless token store

Relevant lines:
- `src/lib/auth/headlessProviderTokenSync.ts:19-27`
- `src/lib/auth/headlessProviderTokenSync.ts:31-37`
- `src/containers/Login.tsx:88-92`
- `src/lib/auth/electron.ts:39-48`
- `src/lib/auth/electron.ts:133`, `241`, `350`, `432`

Behavior:
- When Electron has a real cloud session, `syncHeadlessOpenRouterToken(...)` POSTs to `/provider-auth/openrouter/token`.
- The payload is `{ userId, accessToken }`.
- This is triggered after login, refresh, init restore, and reload.

### C) Local server persists provider tokens separately

Relevant lines:
- `electron/headlessServer/index.ts:169-173` — token store creation + route registration
- `electron/headlessServer/routes/providerAuthRoutes.ts:119-173` — POST/GET/DELETE token endpoints
- `electron/headlessServer/providers/tokenStore.ts:36-47` — SQLite schema
- `electron/headlessServer/providers/tokenStore.ts:92-179` — CRUD methods

The `provider_tokens` schema stores:
- provider
- user_id
- access_token
- refresh_token
- expires_at
- account_id

### D) Headless/mobile UI can also write provider token records

Relevant lines:
- `electron/headlessServer/ui/mobile/src/api.ts:478-489` — `storeOpenRouterToken(...)`
- `electron/headlessServer/ui/mobile/src/api.ts:430-474` — related OpenAI token methods

---

## Local server discovery / routing

Relevant lines:
- `src/utils/api.ts:10-14` — default local server origin is `http://127.0.0.1:3002`
- `src/utils/api.ts:168` — renderer asks Electron main process for sync status via `window.electronAPI.sync.status()`
- `src/utils/api.ts:191-193` — resolved local server origin
- `electron/main.ts:1612-1619` — `sync:status` IPC response

Local server startup in Electron main process:
- `electron/main.ts:672-696`

Potentially important deployment detail:
- `electron/main.ts:38-44` sets `LOCAL_SERVER_ALLOW_REMOTE` to `true` by default on Windows unless overridden, which means host may bind to `0.0.0.0`.

---

## Detailed data flow

## A. Electron local/community login flow

1. User clicks **Continue in Local Mode**.
   - `src/containers/Login.tsx:328-339`
2. `signIn({ email: '', password: '' })` is called.
   - `src/contexts/AuthContext.tsx:275-339`
3. Blank credentials are interpreted as local-mode login.
   - `src/contexts/AuthContext.tsx:281-312`
   - `src/lib/auth/electron.ts:157-191`
4. Synthetic session is persisted to `auth_session`.
   - `src/contexts/AuthContext.tsx:299`
   - `src/lib/auth/electron.ts:182`
5. Redux user profile is synthesized and local SQLite can be updated.
   - `src/contexts/AuthContext.tsx:79-88`
6. Login redirect logic sends user to homepage/latest chat.
   - `src/containers/Login.tsx:106-147`

## B. Electron cloud OAuth flow (deep-link primary path)

1. User clicks Google/GitHub.
   - `src/containers/Login.tsx:263-326`
2. Renderer requests OAuth URL from Supabase using custom deep-link redirect.
   - `src/containers/Login.tsx:275-280`
3. Renderer tells Electron main process to open browser.
   - `src/containers/Login.tsx:287`
   - `electron/preload.ts:6-13`
   - `electron/main.ts:920-927`
4. Browser returns to `yggchat://auth/callback`.
   - `electron/main.ts:596-652`
5. Renderer receives callback via `oauth:callback` IPC.
   - `src/containers/Login.tsx:183-187`
6. Renderer parses tokens from URL hash and sets Supabase session.
   - `src/containers/Login.tsx:199-214`
7. Renderer syncs cloud user into local DB and merges old local data.
   - `src/containers/Login.tsx:227-234`
8. Renderer persists `auth_session` and syncs headless token store.
   - `src/containers/Login.tsx:236-245`
   - `src/containers/Login.tsx:66-98`
9. `reloadSession()` causes `ElectronAuthProvider` to reload storage-backed auth state.
   - `src/containers/Login.tsx:97`
   - `src/contexts/AuthContext.tsx:371-405`
   - `src/lib/auth/electron.ts:387-437`
10. Redirect logic sends user onward.
    - `src/containers/Login.tsx:106-147`

## C. Electron cloud OAuth flow (OOB fallback)

1. Deep-link path fails or user chooses manual fallback.
   - `src/containers/Login.tsx:289-307`, `437-443`
2. Renderer requests OAuth URL with Railway callback.
   - `src/containers/Login.tsx:352-357`
3. User authenticates in browser and gets a manual code.
4. Renderer exchanges code at Railway.
   - `src/containers/Login.tsx:385-389`
5. Renderer sets Supabase session.
   - `src/containers/Login.tsx:398-404`
6. Same persist/sync/reload steps as deep-link flow.
   - `src/containers/Login.tsx:408-425`

## D. Web OAuth flow

1. User clicks Google/GitHub.
   - `src/containers/Login.tsx:311-320`
2. Supabase redirects browser back to `/login?code=...`.
3. `SupabaseAuthProvider.initialize()` calls `exchangeCodeForSession(code)`.
   - `src/lib/auth/supabase.ts:61-82`
4. `AuthContext` consumes updated provider session.
   - `src/contexts/AuthContext.tsx:161-202`
5. Redirect logic in `Login.tsx` completes routing.
   - `src/containers/Login.tsx:106-147`

## E. Headless/mobile auth consumption path

1. Electron persists `auth_session`.
   - `src/containers/Login.tsx:86`
   - `src/contexts/AuthContext.tsx:299`
   - `src/lib/auth/electron.ts:182`, `240`, `348`
2. Headless/mobile code reads `auth_session` directly via Electron storage.
   - `electron/headlessServer/ui/mobile/src/api.ts:56-83`
3. Renderer also syncs app token into local provider token store.
   - `src/lib/auth/headlessProviderTokenSync.ts:19-27`
4. Local server persists that in `provider_tokens`.
   - `electron/headlessServer/routes/providerAuthRoutes.ts:120-149`
   - `electron/headlessServer/providers/tokenStore.ts:36-47`, `150-170`

---

## Cloud-login enforcement points

Some features require a real cloud session and push users to login with `?required=cloud`:
- `src/containers/Chat.tsx:4317`
- `src/containers/appStore.tsx:473`

`Login.tsx` then blocks local-mode completion for those cases:
- `src/containers/Login.tsx:40-44`
- `src/containers/Login.tsx:108-110`
- `src/containers/Login.tsx:464-467`

---

## Possible issues / risks

## 1) `auth:login` IPC path is basically a stub / likely dead code

Relevant lines:
- `electron/main.ts:769-774`
- `src/lib/auth/electron.ts:194-254`

Observation:
- The main-process `auth:login` handler just returns `{ success: true, userId: 'electron-user-id' }`.
- It does not appear to perform real Supabase auth or return a full session.
- Fortunately, `Login.tsx`'s actual Electron cloud login path does not depend on this stub; it uses browser OAuth + callback instead.

Risk:
- If some future caller uses `provider.login(credentials)` for cloud auth in Electron, that path is incomplete / misleading.

## 2) Deep-link callback parser assumes tokens are in the URL hash

Relevant lines:
- `src/containers/Login.tsx:199-205`

Observation:
- The callback handler only extracts `access_token` and `refresh_token` from `url.hash`.
- It does not support a `?code=` callback style in Electron.

Risk:
- If Supabase/provider behavior changes to PKCE/code-based callback for the custom scheme, Electron login will fail with "No tokens found in callback URL".

## 3) Fallback timer is not cleared

Relevant lines:
- `src/containers/Login.tsx:304-307`
- callback cleanup path around `src/containers/Login.tsx:192-195`

Observation:
- A `setTimeout` flips `showFallbackLink` after 5 seconds.
- The timeout handle is not stored or cleared on callback, cancel, or unmount.

Risk:
- Minor stale-state race / UI flicker.
- Probably harmless because the page usually redirects quickly, but still sloppy lifecycle management.

## 4) Token naming is confusing: "OpenRouter token" sync is actually using the app cloud token

Relevant lines:
- `src/lib/auth/headlessProviderTokenSync.ts:19-27`
- `src/containers/Login.tsx:88-92`
- `electron/headlessServer/routes/providerAuthRoutes.ts:178-188`

Observation:
- `syncHeadlessOpenRouterToken(...)` sends the current app access token to `/provider-auth/openrouter/token`.
- `providerAuthRoutes` then uses that token to call the remote API's `/models/openrouter` endpoint.

Risk:
- The code reads like it is storing a real OpenRouter credential, but it is really storing an app bearer token for model lookup.
- This can confuse maintainers and lead to bad assumptions.

## 5) Sensitive tokens are persisted locally in plaintext-ish app storage / SQLite

Relevant lines:
- `src/containers/Login.tsx:74-86`
- `electron/main.ts:168-170`
- `electron/headlessServer/providers/tokenStore.ts:36-47`

Observation:
- `auth_session` includes access and refresh tokens and is written through `Conf` storage.
- Provider token records are stored in SQLite `provider_tokens`.
- I do not see encryption-at-rest here.

Risk:
- Desktop compromise or local filesystem access exposes cloud tokens.
- `configFileMode: 0o600` helps on Unix-like systems, but it is not encryption.

## 6) Local token-store routes appear unauthenticated, while local server may be remotely reachable on Windows

Relevant lines:
- `electron/headlessServer/routes/providerAuthRoutes.ts:120-173`
- `electron/main.ts:38-44`
- `electron/main.ts:672-696`

Observation:
- `/api/provider-auth/{provider}/token` POST/GET/DELETE routes do not perform auth checks.
- The local server may bind to `0.0.0.0` by default on Windows (`LOCAL_SERVER_ALLOW_REMOTE` defaults to `process.platform === 'win32'`).

Risk:
- If the local server is reachable from the LAN and no other protection exists, token endpoints become a serious exposure point.
- This is the biggest security concern found in this review.

## 7) Headless/mobile UI can read persisted `auth_session` directly, bypassing AuthContext abstraction

Relevant lines:
- `electron/headlessServer/ui/mobile/src/api.ts:56-83`
- `electron/headlessServer/ui/mobile/src/api.ts:380-387`

Observation:
- Headless/mobile code reads `auth_session` directly from Electron storage.
- It does not go through `AuthContext` or provider refresh logic.

Risk:
- It may observe stale tokens or partially refreshed state.
- It increases coupling to the exact serialized shape of `auth_session`.

## 8) Community-mode init clears persisted auth session eagerly

Relevant lines:
- `src/lib/auth/electron.ts:66-79`

Observation:
- On initialize, if runtime is classified as community mode, ElectronAuthProvider clears `auth_session` and returns null auth state.

Risk:
- If runtime-mode detection is wrong or lags startup state, a valid saved cloud session could be cleared unexpectedly.
- I did not prove this bug exists, but the coupling between `runtimeMode.ts` snapshot detection and provider initialization deserves careful testing.

---

## Suggested follow-up checks

1. Verify whether local server token routes are protected anywhere else when remote/LAN access is enabled.
2. Decide whether `auth_session` and `provider_tokens` need encryption-at-rest.
3. Rename or document `syncHeadlessOpenRouterToken()` so it is clear it syncs an app/cloud bearer token, not a native OpenRouter API key.
4. Add timeout cleanup for the deep-link fallback timer.
5. Decide whether Electron deep-link flow should also support `?code=` callbacks for future compatibility.
6. Either implement or remove the `auth:login` IPC stub to avoid accidental misuse.

---

## Short answer to the original "headless server just fetches the token from electron server?" question

**Mostly yes, but with nuance:**

- The headless/mobile UI can directly read the Electron app's persisted `auth_session` from Electron storage (`electron/headlessServer/ui/mobile/src/api.ts:56-83`, `380-387`).
- Separately, the renderer also pushes the current cloud app token into the local headless token store through `/api/provider-auth/openrouter/token` (`src/lib/auth/headlessProviderTokenSync.ts:19-27`).
- The local server persists those token records in SQLite (`electron/headlessServer/providers/tokenStore.ts:36-47`).

So the headless side is not independently logging the user in; it is **borrowing and persisting token material from the main Electron app session**.
