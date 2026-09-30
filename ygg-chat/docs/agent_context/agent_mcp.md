---
paths:
  - "client/ygg-chat-r/server/mcp/**"
  - "client/ygg-chat-r/src/components/SettingsPane/SettingsPane.tsx"
---

# Agent Context: MCP

Last reviewed: 2026-07-17

## Purpose

Documents local Electron MCP server configuration, transport behavior, remote OAuth, credential persistence, and management routes.

## Key Files

- `client/ygg-chat-r/server/mcp/mcpManager.ts`: stdio/Streamable HTTP clients, capability discovery, OAuth flow, persistence, and lifecycle.
- `client/ygg-chat-r/server/mcp/oauthDiscovery.ts`: Bearer challenge parsing and RFC 9728/RFC 8414 metadata URL candidates.
- `client/ygg-chat-r/server/mcp/mcpOAuthSecrets.ts`: per-server secure OAuth credential storage.
- `client/ygg-chat-r/server/mcp/mcpRoutes.ts`: local management/status routes and response redaction.
- `client/ygg-chat-r/src/components/SettingsPane/SettingsPane.tsx`: MCP settings UI.
- `client/ygg-chat-r/server/tools/__tests__/oauthDiscovery.test.ts`: focused discovery tests.
- `client/ygg-chat-r/server/__tests__/mcpOAuthRedirectUri.test.ts`: fixed callback validation and OAuth flow coverage.

## Configuration Source

- The supported source is `${app.getPath('userData')}/mcp-servers.json`.
- The repository root `.mcp.json` is not loaded automatically.
- `/api/mcp/config-path` exposes the active path.
- `servers` is the canonical object; `mcpServers` is accepted as an import-compatible shape.

Minimal remote server:

```json
{
  "settings": { "lazyStart": true },
  "servers": {
    "example": {
      "enabled": true,
      "transport": "http",
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

For providers that reject anonymous dynamic client registration, configure `oauth.clientId`, `oauth.tokenEndpointAuthMethod: "none"`, and any required scopes. Confidential client secrets are accepted only when the provider requires `client_secret_post`.

For pre-registered clients that accept only fixed callback URLs, configure `oauth.redirectUri`, for example `http://127.0.0.1:6274/oauth/callback`. Fixed callbacks must use `http`, a `localhost` or `127.0.0.1` host, and an explicit port; the MCP client binds its temporary callback listener to that exact host, port, and path. When omitted, the client continues to use an ephemeral loopback port and `/mcp/oauth/callback`.

## Celestial TEST Cognito compatibility

The HTTP MCP add/edit form has an explicit Celestial TEST checkbox (off by default). Enabling it fills the registered public client, `none` authentication, fixed callback, and GP scope. It persists `oauth.allowMissingPkceS256ForCelestialTest: true`; this option is never sourced from discovery or tool output.

The exception accepts only an **absent** `code_challenge_methods_supported` property from the exact Celestial TEST issuer and pinned authorize/token endpoints. Explicit empty, malformed, null, or plain-only declarations still fail. Issuer discovery for this opt-in refuses redirects. Every authorization still uses fresh S256 PKCE/state. Changes to the configured issuer or opt-in clear stored token/endpoint state and cancel pending authorization before saving.

Example entry inside `servers` in the active `mcp-servers.json` (or use Settings → MCP):

```json
"celestial-test": {
  "enabled": true,
  "transport": "http",
  "url": "http://127.0.0.1:8081/api/mcp-gp/rpc",
  "oauth": {
    "allowMissingPkceS256ForCelestialTest": true,
    "authorizationServer": "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_nSxSsgJuj",
    "clientId": "5391d6flv8jtvpgg0b6j9f50dv",
    "tokenEndpointAuthMethod": "none",
    "redirectUri": "http://localhost:6274/oauth/callback",
    "scopes": ["https://workbench.celestial.test.vega-alts.com/api/mcp-gp/rpc/invoke"]
  }
}
```

The local GP service must be running and callback port 6274 free. No client secret is needed. Browser login and product permissions remain the user's responsibility; discovery compatibility alone does not prove a live login works.

## Local Celestial resource-binding exception

A **separate, default-off** per-connection option, `oauth.omitResourceForLocalCelestialTest`, is exposed as “Local Celestial testing: omit OAuth resource binding”. It omits the `resource` parameter from authorization, code exchange, and refresh, removing explicit token audience binding for local development. It never enables itself after an error and does not grant the missing-PKCE-metadata exception.

Only `http://127.0.0.1:8081/api/mcp-gp/rpc`, the TEST issuer/authorize/token endpoints pinned in `oauthDiscovery.ts`, public client `5391d6flv8jtvpgg0b6j9f50dv` with `none` authentication, and the exact scope set `openid profile email https://workbench.celestial.test.vega-alts.com/api/mcp-gp/rpc/invoke` are accepted. Scope order is immaterial. The opt-in uses the configured full scope set; a challenge may request a subset but cannot add scopes. Discovered issuer/endpoints are checked even when S256 is advertised. Cached configurations are checked before token reuse/refresh.

The checkbox fills the public-client fields and scopes, but does not change the MCP URL or the PKCE checkbox. Connection URL and persisted OAuth resource remain localhost, not the deployed resource. Toggling the option cancels pending authorization/refresh and clears only that connection's cached tokens and discovered endpoints. Secure-store credentials survive normal reloads. S256, callbacks/state, credential storage, and server-side validation remain unchanged.

Validation: `npm run test:tools -- --run server/tools/__tests__/localCelestialResource.test.ts` and `npm run test:server -- --run server/__tests__/mcpCelestialOAuth.test.ts` from the client package. Live Cognito login still requires manual verification.

## Remote OAuth Flow

1. Startup loads configuration and securely stored credentials without connecting. The first explicit/model MCP use starts the target server, and Streamable HTTP sends an unauthenticated request when no OAuth credential exists.
2. A `401` Bearer challenge supplies optional `resource_metadata` and `scope` hints.
3. The client discovers protected-resource and authorization-server metadata.
4. It uses a configured client or dynamically registers one, creates PKCE/state, starts a loopback callback, and opens the system browser from Electron main.
5. Registration metadata is persisted before browser authorization; token metadata and credentials are persisted immediately after exchange/refresh.
6. Requests and notifications share the same header builder, expiry/refresh preparation, Bearer injection, and one-time `401` retry behavior.

Dynamic callback ports are ephemeral. Dynamic client registrations record their redirect URI and are re-registered for subsequent interactive flows rather than reused with a different redirect. Configured client IDs are treated as pre-registered clients.

## Credential Persistence

- Non-secret OAuth metadata stays in `mcp-servers.json`.
- Access tokens, refresh tokens, and client secrets are stored through keytar under `mcp-oauth:<serverName>`.
- Existing plaintext OAuth secrets are migrated to keytar and removed from JSON on load.
- Secure-storage failure is fail-closed for OAuth configurations; credentials are not silently written back to plaintext.
- Ordinary stop/restart preserves credentials. Removing a server clears its secure credential entry.
- Bearer tokens are constructed per request and must not be copied into generic static headers.

## Important Invariants

- Local Electron is the only supported runtime surface in this repository.
- MCP servers never connect or launch OAuth during Graviton startup; connection and authentication begin only on explicit/model MCP use.
- Successful capability discovery emits `toolsChanged`; the local server immediately registers the new handlers, the active tool loop refreshes its provider schemas before the next turn, and the renderer receives `tools_updated` over the chat stream.
- `settings.lazyStart` and per-server `autoStart` remain config-compatible legacy fields, but startup is always lazy.
- All Streamable HTTP JSON-RPC requests and notifications use the centralized OAuth-aware headers and refresh path.
- A rejected access token is invalidated before refresh/retry; auth retries occur at most once.
- OAuth secrets and authorization codes must not appear in route responses or logs.
- Connection failures preserve `error` status instead of being overwritten by cleanup.
- A published registration endpoint does not imply anonymous DCR is permitted; `401/403` should direct users to configure a pre-registered client.

## Validation

- Focused discovery tests: `npm --prefix client/ygg-chat-r run test:tools -- --run server/tools/__tests__/oauthDiscovery.test.ts`
- Fixed callback tests: `npm --prefix client/ygg-chat-r run test:server -- --run server/__tests__/mcpOAuthRedirectUri.test.ts`
- Tool tests: `npm --prefix client/ygg-chat-r run test:tools`
- Electron renderer/type build: `npm --prefix client/ygg-chat-r run build:electron`
- Electron main bundle: `npm --prefix client/ygg-chat-r run build:electron:main`
