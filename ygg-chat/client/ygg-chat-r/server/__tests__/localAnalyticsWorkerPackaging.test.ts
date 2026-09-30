import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveLocalAnalyticsWorkerPath } from '../localAnalyticsWorkerClient.js'

const appRoot = fileURLToPath(new URL('../../', import.meta.url))
const workerEntry = 'electron/localAnalyticsWorker.mjs'

describe('local analytics worker packaging', () => {
  it('ships the worker as a real file outside ASAR', () => {
    const config = JSON.parse(readFileSync(path.join(appRoot, 'electron-builder.json'), 'utf8'))
    expect(config.files).toContain(workerEntry)
    expect(config.asarUnpack).toContain(workerEntry)
  })

  it('resolves the unpacked sibling in a packaged app', () => {
    const resources = path.resolve('fixture app', 'Contents', 'Resources')
    const main = path.join(resources, 'app.asar', 'electron', 'main.mjs')
    expect(resolveLocalAnalyticsWorkerPath(pathToFileURL(main).href)).toBe(
      path.join(resources, 'app.asar.unpacked', 'electron', 'localAnalyticsWorker.mjs')
    )
  })

  it('keeps the sibling path in development', () => {
    const main = path.join(appRoot, 'electron', 'main.mjs')
    expect(resolveLocalAnalyticsWorkerPath(pathToFileURL(main).href)).toBe(
      path.join(appRoot, 'electron', 'localAnalyticsWorker.mjs')
    )
  })

  it('does not rewrite an already-unpacked path', () => {
    const main = path.resolve('app.asar.unpacked', 'electron', 'main.mjs')
    expect(resolveLocalAnalyticsWorkerPath(pathToFileURL(main).href)).toBe(
      path.join(path.dirname(main), 'localAnalyticsWorker.mjs')
    )
  })
})
