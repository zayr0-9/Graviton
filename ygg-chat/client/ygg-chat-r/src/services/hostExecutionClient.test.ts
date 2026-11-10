import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { normalizeHostExecutionPreferences } from '../../../../shared/hostExecutionPreferences'
vi.mock('../platform/clientCapabilities', () => ({ isNativeShell: true }))
vi.mock('../utils/api', () => ({ buildLocalApiUrl: async (path: string) => path }))
const host = vi.hoisted(() => ({ snapshot: {} as any, save: vi.fn() }))
beforeEach(() => {
  vi.resetModules()
  host.snapshot = { hostId: 'host', epoch: 'epoch', revision: 10, revisions: { hookGeneration: 2 }, values: normalizeHostExecutionPreferences({}) }
  host.save.mockReset().mockImplementation(async () => host.snapshot)
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), electronAPI: { executionPreferences: { read: async () => host.snapshot, save: host.save } } })
  vi.stubGlobal('CustomEvent', class { constructor(public type: string, public detail: unknown) {} })
})
afterEach(() => vi.unstubAllGlobals())
it('forwards the hook form edit-base revision, not a newer snapshot domain revision', async () => {
  const client = await import('./hostExecutionClient')
  await client.refreshHostExecutionPreferences()
  const base = client.getHostExecutionRevision('hookGeneration')!
  host.snapshot = { ...host.snapshot, revision: 12, revisions: { hookGeneration: 3 } }
  await client.refreshHostExecutionPreferences()
  await client.saveHostExecutionPreference({ hookGeneration: { ...host.snapshot.values.hookGeneration, provider: 'claudecode' } }, base)
  expect(host.save).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 2, expectedRevisions: { hookGeneration: 2 } }))
})
it('retains unrelated domains while saving a hook choice', async () => {
  const client = await import('./hostExecutionClient')
  await client.refreshHostExecutionPreferences()
  await client.saveHostExecutionPreference({ hookGeneration: { ...host.snapshot.values.hookGeneration, claudeModel: 'haiku' } }, 2)
  expect(Object.keys(host.save.mock.calls[0][0].patch)).toEqual(['hookGeneration'])
})
