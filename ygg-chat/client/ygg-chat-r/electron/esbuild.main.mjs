import * as esbuild from 'esbuild'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Bundle main.ts with all dependencies
await esbuild.build({
  entryPoints: [path.join(__dirname, 'main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: path.join(__dirname, 'main.mjs'),
  format: 'esm',
  external: [
    'electron',
    'better-sqlite3',  // Native module - must be external
    'keytar',
    'node-pty',
  ],
  banner: {
    // Required for ESM to use require() for native modules
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
  },
  sourcemap: true,
  // Resolve .ts files when importing .js extensions
  resolveExtensions: ['.ts', '.js', '.mjs', '.json'],
})

console.log('✅ main.ts bundled to main.mjs')

// Compile preload.ts (simple, no bundling needed - only uses electron)
await esbuild.build({
  entryPoints: [path.join(__dirname, 'preload.ts')],
  bundle: false,  // Don't bundle, just transpile
  platform: 'node',
  target: 'node20',
  outfile: path.join(__dirname, 'preload.mjs'),
  format: 'esm',
  sourcemap: true,
})

console.log('✅ preload.ts compiled to preload.mjs')

// Bundle utility process runtime entry
await esbuild.build({
  entryPoints: [path.join(__dirname, '..', 'server', 'toolRuntimeUtility.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: path.join(__dirname, 'toolRuntimeUtility.mjs'),
  format: 'esm',
  external: [
    'electron',
    'better-sqlite3',
  ],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
  },
  sourcemap: true,
  resolveExtensions: ['.ts', '.js', '.mjs', '.json'],
})

console.log('✅ toolRuntimeUtility.ts bundled to toolRuntimeUtility.mjs')

// Bundle local analytics worker so expensive SQLite dashboard queries run off the main thread
await esbuild.build({
  entryPoints: [path.join(__dirname, '..', 'server', 'localAnalyticsWorker.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: path.join(__dirname, 'localAnalyticsWorker.mjs'),
  format: 'esm',
  external: [
    'better-sqlite3',
  ],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
  },
  sourcemap: true,
  resolveExtensions: ['.ts', '.js', '.mjs', '.json'],
})

console.log('✅ localAnalyticsWorker.ts bundled to localAnalyticsWorker.mjs')

// Bundle mobile headless UI (React) for LAN access
await esbuild.build({
  entryPoints: [path.join(__dirname, '..', 'server', 'headlessServer', 'ui', 'mobile', 'src', 'main.tsx')],
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  outfile: path.join(__dirname, '..', 'server', 'headlessServer', 'ui', 'mobile', 'assets', 'mobile-app.js'),
  format: 'esm',
  sourcemap: true,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  resolveExtensions: ['.tsx', '.ts', '.js', '.mjs', '.json'],
  logLevel: 'info',
})

console.log('✅ mobile React UI bundled to server/headlessServer/ui/mobile/assets/mobile-app.js')
