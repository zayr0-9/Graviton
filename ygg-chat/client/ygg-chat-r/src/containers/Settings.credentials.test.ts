import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

// Guard the native boundary without mounting unrelated provider/theme settings.
const settings = fs.readFileSync(new URL('./Settings.tsx', import.meta.url), 'utf8')
const main = fs.readFileSync(new URL('../../electron/main.ts', import.meta.url), 'utf8')
const preload = fs.readFileSync(new URL('../../electron/preload.ts', import.meta.url), 'utf8')

describe('credential Settings native boundary', () => {
  it('loads Brave credentials only through an explicit action with no automatic retries', () => {
    expect(settings).toContain('onClick={handleLoadBraveApiKey}')
    expect(settings).toContain("useState(false)\n  const [braveApiKeyChecked")
    const handler = settings.slice(settings.indexOf('const handleLoadBraveApiKey'), settings.indexOf('const handleConsolidateCredentials'))
    expect(handler.match(/readBraveApiKeyFromSecureStore\(\)/g)).toHaveLength(1)
    expect(handler).not.toMatch(/maxAttempts|setTimeout|useEffect/)
  })

  it('offers explicit consolidation and warns about old-item approvals', () => {
    expect(settings).toContain('onClick={handleConsolidateCredentials}')
    expect(settings).toContain('macOS may ask permission for each old item')
    expect(settings).toContain("result.complete ? 'success' : 'error'")
    expect(preload).toContain("consolidate: () => ipcRenderer.invoke('secrets:consolidate')")
  })

  it('restricts all credential IPC operations to the trusted app frame', () => {
    for (const channel of ['consolidate', 'braveSearch:get', 'braveSearch:has', 'braveSearch:set', 'braveSearch:delete']) {
      expect(main).toContain(`authHandle('secrets:${channel}'`)
      expect(main).not.toContain(`ipcMain.handle('secrets:${channel}'`)
    }
    const handler = main.slice(main.indexOf("authHandle('secrets:consolidate'"), main.indexOf("authHandle('secrets:braveSearch:get'"))
    expect(handler).not.toMatch(/[,{]\s*(?:password|secrets|vault)\s*:/)
    expect(handler).toContain('return { success: true, ...result }')
  })
})
