import { defineConfig } from 'vitest/config'

// Unit/integration tests for the runtime-neutral server graph
// (server/**). Runs under plain Node - no Electron.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/__tests__/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/dist-electron/**', '**/dist-server/**'],
  },
})
