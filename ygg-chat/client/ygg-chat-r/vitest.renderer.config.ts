import path from 'path'
import { defineConfig } from 'vitest/config'

// Renderer-side unit tests. These are pure logic tests (reducers, SSE projection,
// chat clients) with no DOM rendering, so they run on the same `node` environment
// as the headless/tools suites. Files that need browser globals (localStorage,
// window) install their own in-file shims before their imports evaluate, so no
// global setup file is used here — adding one would fight the tests that
// deliberately delete `globalThis.localStorage` to assert graceful degradation.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['dist/**', 'dist-electron/**', 'node_modules/**'],
  },
  // The renderer sources use these aliases and compile-time constants; vite.config.ts
  // is not loaded when an explicit vitest config is supplied, so restate them.
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../../shared'),
    },
  },
  define: {
    __BUILD_TARGET__: JSON.stringify(process.env.BUILD_TARGET || 'local'),
    __IS_ELECTRON__: JSON.stringify(process.env.BUILD_TARGET === 'electron'),
    __IS_WEB__: JSON.stringify(process.env.BUILD_TARGET === 'web'),
    __IS_LOCAL__: JSON.stringify(!process.env.BUILD_TARGET || process.env.BUILD_TARGET === 'local'),
    __YGG_CODEX_DEV_LOGS__: JSON.stringify(/^(1|true|yes|on)$/i.test(process.env.YGG_CODEX_DEV_LOGS || '')),
  },
})
