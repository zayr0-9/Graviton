import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/headlessServer/**/*.test.ts'],
    exclude: ['dist/**', 'dist-electron/**', 'node_modules/**'],
  },
})
