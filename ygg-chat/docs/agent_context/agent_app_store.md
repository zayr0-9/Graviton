---
paths:
  - "client/ygg-chat-r/src/services/appStore.ts"
  - "client/ygg-chat-r/src/containers/appStore.tsx"
  - "client/ygg-chat-r/server/routes/appStoreRoutes.ts"
---

# Agent Context: App Store

Last reviewed: 2026-11-10

## Purpose

The app store lets users browse and install custom HTML/tool apps into their local custom-tools
directory. Graviton has no accounts, so browsing and installing are **anonymous**; publishing
(upload) is hidden until a new mechanism exists. This is one of the few features that reaches the
network (see `AGENT.md` → Supported Runtime Scope).

## When to Open This File

Use this when changing the App Store modal (Settings → App Store), catalog fetching, app
install/uninstall, or the community upload flow.

## Key Files

- `client/ygg-chat-r/src/services/appStore.ts`: renderer service.
  - `fetchAppStoreApps()` — first-party catalog. Reads `apps/manifest.json` and each app's
    description/zip from the public URL `APP_STORE_PUBLIC_BASE` (plain public object storage; no
    auth). `TODO(app-store-catalog)`: move this catalog to GitHub (fully-local plan Q10).
  - `fetchPublicAppStoreApps()` — community list via the local host (`GET /api/app-store/community`);
    host clients only.
  - `installAppFromStore` / `uninstallAppFromStore` / `fetchInstalledCustomTools` /
    `restartDesktopApp` — local host routes.
  - `validateCommunityAppUpload` / `uploadCommunityApp` — kept for the future publishing flow;
    `TODO(app-store-upload)`.
- `client/ygg-chat-r/src/containers/appStore.tsx`: `AppStoreModal`. The upload panel is behind
  `COMMUNITY_UPLOAD_ENABLED = false`.
- `client/ygg-chat-r/server/routes/appStoreRoutes.ts`:
  - `GET /api/app-store/community` — anonymous proxy of the community list from `REMOTE_API_BASE`.
  - `POST /api/app-store/community/upload` — **501** (publishing needed a Graviton account;
    `TODO(app-store-upload)`, plan Q11).
  - `POST /api/app-store/validate-upload` — local zip validation (kept for the future flow).
  - `POST /api/app-store/install` / `uninstall` — download a zip by URL and install/remove it
    under the managed custom-tools path.
  - `POST /api/app/restart` — host restart capability; standalone returns 501.

## Invariants

- No credentials are ever sent to catalog hosts. Do not add account or token headers.
- `APP_STORE_PUBLIC_BASE` and `REMOTE_API_BASE` are the only allowlisted hosted URLs in the
  codebase (grep guard in the Git-root `docs/fully-local-migration-plan.md`). Do not add others.
- Installed apps are local files; uninstall removes only the managed install directory.
- A catalog fetch failure must leave installed apps working.

## Testing and Validation

- `npm --prefix client/ygg-chat-r run test:server` (route tests) and `test:renderer` for the service.
- Manual: open Settings → App Store, browse both tabs, install and uninstall one app, and confirm
  the upload panel is not shown.

## Related Docs

- `agent_custom_tools.md`
- `agent_html_iframe_apps.md`
