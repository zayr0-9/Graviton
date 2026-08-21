import { defineConfig } from 'vitest/config'

// Unit/integration tests for the runtime-neutral server graph
// (electron/server/**). Runs under plain Node - no Electron.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['electron/server/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/dist-electron/**', '**/dist-server/**'],
  },
})
