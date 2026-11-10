# ygg-chat-r

The Graviton desktop app: React renderer (`src/`), Electron shell (`electron/`) and the local
Express + headless agent server (`server/`). Graviton is fully local: there is no account, cloud
backend or `.env` file. All data is stored in local SQLite.

## Develop

Install once from the workspace root (`ygg-chat/`) with `npm ci --include=optional`, then:

```bash
npm run dev              # Electron app with Vite hot reload
npm run dev:standalone   # renderer against the standalone Node server (npm run build:server first)
```

The runtime mode comes from the build target (`BUILD_TARGET` → `__BUILD_TARGET__`:
`electron`, `browser-client` or `standalone`). See `src/platform/clientCapabilities.ts`.

## Build

```bash
npm run build:electron   # renderer + Electron main/preload
npm run build:mac        # or build:win / build:linux (packages with electron-builder)
npm run build:server     # standalone server bundle in dist-server/
```

Updates are published to and read from GitHub Releases (`electron-builder.json` → `publish`).

## Test

Native modules are built for Electron, so run the suites under Electron's Node:

```bash
ELECTRON_RUN_AS_NODE=1 ../../node_modules/.bin/electron ./node_modules/vitest/vitest.mjs run --config vitest.server.config.ts
# also: vitest.headless.config.ts, vitest.renderer.config.ts, vitest.tools.config.ts
npx tsc -b && npm run typecheck:electron && npm run typecheck:server && npm run typecheck:mobile
```

Agent-facing architecture docs live in `../../docs/agent_context/` (start with `AGENT.md`).
