# Agent Context: MCP

Last reviewed: 2026-07-17

## Purpose

Documents local Electron MCP server configuration, transport behavior, remote OAuth, credential persistence, and management routes.

## Key Files

- `client/ygg-chat-r/electron/mcp/mcpManager.ts`: stdio/Streamable HTTP clients, capability discovery, OAuth flow, persistence, and lifecycle.
- `client/ygg-chat-r/electron/mcp/oauthDiscovery.ts`: Bearer challenge parsing and RFC 9728/RFC 8414 metadata URL candidates.
- `client/ygg-chat-r/electron/mcp/mcpOAuthSecrets.ts`: per-server secure OAuth credential storage.
- `client/ygg-chat-r/electron/mcp/mcpRoutes.ts`: local management/status routes and response redaction.
- `client/ygg-chat-r/src/components/SettingsPane/SettingsPane.tsx`: MCP settings UI.
- `client/ygg-chat-r/electron/tools/__tests__/oauthDiscovery.test.ts`: focused discovery tests.

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

## Remote OAuth Flow

1. Streamable HTTP sends an unauthenticated request when no OAuth credential exists.
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
- All Streamable HTTP JSON-RPC requests and notifications use the centralized OAuth-aware headers and refresh path.
- A rejected access token is invalidated before refresh/retry; auth retries occur at most once.
- OAuth secrets and authorization codes must not appear in route responses or logs.
- Connection failures preserve `error` status instead of being overwritten by cleanup.
- A published registration endpoint does not imply anonymous DCR is permitted; `401/403` should direct users to configure a pre-registered client.

## Validation

- Focused discovery tests: `npm --prefix client/ygg-chat-r run test:tools -- --run electron/tools/__tests__/oauthDiscovery.test.ts`
- Tool tests: `npm --prefix client/ygg-chat-r run test:tools`
- Electron renderer/type build: `npm --prefix client/ygg-chat-r run build:electron`
- Electron main bundle: `npm --prefix client/ygg-chat-r run build:electron:main`
