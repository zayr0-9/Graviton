import { beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_HOST_PROVIDER_PREFERENCES } from '../../../../shared/hostProviderPreferences'
const host = vi.hoisted(() => ({ provider: {} as any, revision: 4, save: vi.fn() }))
vi.mock('../services/hostExecutionClient', () => ({ getHostExecutionPreferences: () => ({ provider: host.provider }), getHostExecutionRevision: () => host.revision, saveHostExecutionPreference: (...args: unknown[]) => host.save(...args) }))
vi.mock('../config/runtimeMode', () => ({ isCommunityMode: false }))
import { loadProviderSettings, saveProviderSettings } from './providerSettingsStorage'
beforeEach(() => {
  host.provider = { ...DEFAULT_HOST_PROVIDER_PREFERENCES }; host.revision = 4; host.save.mockReset()
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  vi.stubGlobal('window', { dispatchEvent: vi.fn() })
  vi.stubGlobal('CustomEvent', class { constructor(public type: string, public detail: unknown) {} })
})
it('does not write unchanged provider values with different property order', async () => {
  const base = loadProviderSettings()
  const reordered = { ...base }
  delete (reordered as any).compactionModel
  reordered.compactionModel = base.compactionModel
  await saveProviderSettings(reordered)
  expect(host.save).not.toHaveBeenCalled()
})
it('refuses a serialized form without a known edit base', async () => {
  const form = JSON.parse(JSON.stringify(loadProviderSettings()))
  form.compactionModel = 'new-model'
  await expect(saveProviderSettings(form)).rejects.toThrow('edit base is missing')
  expect(host.save).not.toHaveBeenCalled()
})
it('sends the captured revision even after a newer host snapshot arrives', async () => {
  const form = { ...loadProviderSettings(), compactionModel: 'chosen-model' }
  host.revision = 8
  await saveProviderSettings(form)
  expect(host.save).toHaveBeenCalledWith({ provider: expect.objectContaining({ compactionModel: 'chosen-model' }) }, 4)
})
