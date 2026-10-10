# Desktop build performance

`npm run build:mac` still produces the ZIP used to test on another Mac. The
release targets, signing settings, updater metadata and native rebuild remain
unchanged. Windows/Linux/CI packaging use the same dependency filter.

## Build scheduling and checks

`build:electron:parallel` runs the renderer and Electron/main build branches
concurrently. Both must succeed before packaging. Electron and mobile typechecks
remain sequential within the main branch; their independent incremental caches
live in `node_modules/.tmp/`. The five esbuild jobs run with a two-job limit.
No typecheck is skipped. A failing task stops further scheduling, waits for active
writers, and returns a failure so packaging cannot consume partial outputs.

## Runtime dependency packaging

`runtime-packaging.mjs` is an electron-builder `beforePack` hook. It retains:

- `better-sqlite3`, `keytar`, `node-pty`: native bundle externals.
- `sqlite-vec`: loaded dynamically, with the installed target extension package.
- `electron-updater`: conservatively retained with its resources/dependencies.
- Their installed dependency/peer/optional dependency closure, including nested
  versions and native build helpers.

Everything else is already represented in renderer/main/utility bundles and is
excluded from the packaged **node_modules**, not removed from the development
installation. Existing app asset filters and unpacking rules still apply. This
avoids staging another copy of the dependency tree or changing the source npm
manifest/lockfile. Builder still discovers the full tree and rebuilds natives;
the optimisation reduces copying, ASAR creation, signing and ZIP compression.

When adding an external or dynamically required package, update `runtimePackages`
and validate the packaged app, not just development resolution. Custom tools
must carry their own dependencies. Cross-architecture packaging requires the
matching sqlite-vec package to be installed, as well as correct native binaries.

## Validation

From this directory's parent:

```sh
node --test scripts/build.test.mjs
npm run test:server -- server/__tests__/localAnalyticsWorkerPackaging.test.ts
npm run build:mac
```

The regression tests use electron-builder's installed file matcher to verify
runtime inclusion, renderer exclusions, nested dependencies, and that `.env`,
source trees and old release archives are not accidentally included. They also
verify bounded concurrency and error gating.

After packaging, smoke-test database access, vector search, analytics, terminal,
credential storage, updater, mobile UI, REPL and custom tools on the destination
Mac. Do not treat an isolated packaging run using old compiled bundles as a
validated build of the latest source.
