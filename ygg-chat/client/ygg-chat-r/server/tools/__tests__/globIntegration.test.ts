import { fileURLToPath } from 'url'
import { expect, it } from 'vitest'
import { globSearch } from '../glob.js'

const cwd = fileURLToPath(new URL('.', import.meta.url))
it('uses the real glob iterator with native cwd and file-type results', async () => {
  const result = await globSearch('glob*.test.ts', { cwd, nodir: true, withFileTypes: true })
  expect(result.success).toBe(true)
  expect(result.matches).toContain(fileURLToPath(new URL('./globIntegration.test.ts', import.meta.url)))
})
it('stops the real iterator early when the match cap is reached', async () => {
  const result = await globSearch('*.test.ts', { cwd, maxMatches: 1 })
  expect(result).toMatchObject({ success: false, matches: [], error: expect.stringContaining('Too many matches') })
})
