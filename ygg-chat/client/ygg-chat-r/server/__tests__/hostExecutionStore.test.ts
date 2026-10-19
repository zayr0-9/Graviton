import { beforeEach, describe, expect, it, vi } from 'vitest'
const data = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../headlessServer/config/settingsStore.js', () => ({ getSettingsStore: () => ({ get: (key: string) => data.get(key), set: (key: string, value: unknown) => data.set(key, structuredClone(value)) }) }))
import { importHostExecutionPreferences, readHostExecutionPreferences, saveHostExecutionPreferences } from '../hostExecutionStore.js'
beforeEach(() => data.clear())
describe('host execution preferences', () => {
  it('imports only stored values once and never includes full access', () => {
    const first = importHostExecutionPreferences({ 'chat:defaultToolAutoApprove': 'true', fullAccess: 'true' })
    expect(first.values.toolAutoApprove).toBe(true)
    expect(first.values).not.toHaveProperty('fullAccess')
    expect(importHostExecutionPreferences({ 'chat:defaultToolAutoApprove': 'false' })).toEqual(first)
  })
  it('rejects stale, foreign and unknown settings patches', () => {
    const initial = readHostExecutionPreferences()
    const request = { ...initial, expectedRevision: initial.revision, patch: { toolAutoApprove: true } }
    const saved = saveHostExecutionPreferences(request)
    expect(saved.values.toolAutoApprove).toBe(true)
    expect(() => saveHostExecutionPreferences(request)).toThrow('changed')
    expect(() => saveHostExecutionPreferences({ ...request, hostId: 'other', expectedRevision: saved.revision })).toThrow('changed')
    expect(() => saveHostExecutionPreferences({ ...request, expectedRevision: saved.revision, patch: { fullAccess: true } as any })).toThrow('Unknown')
  })
})

it('imports valid provider fields despite obsolete or malformed legacy fields', () => {
  const imported = importHostExecutionPreferences({ ygg_provider_settings: JSON.stringify({
    showProviderSelector: false, oldDeprecatedField: true, compactionModel: 'kept-model', openRouterTemperature: 'bad',
  }) })
  expect(imported.values.provider.compactionModel).toBe('kept-model')
  expect(imported.values.provider.openRouterTemperature).toBeNull()
  expect(imported.values.provider).not.toHaveProperty('oldDeprecatedField')
  expect(importHostExecutionPreferences({ ygg_provider_settings: '{}' }).revision).toBe(imported.revision)
})

it('allows independent-domain saves and rejects same-domain stale updates', () => {
  const initial = readHostExecutionPreferences()
  const request = { ...initial, expectedRevision: initial.revision, expectedRevisions: initial.revisions }
  saveHostExecutionPreferences({ ...request, patch: { toolAutoApprove: true } })
  const result = saveHostExecutionPreferences({ ...request, patch: { planModeVerbosity: 'detailed' } })
  expect(result.values.toolAutoApprove).toBe(true)
  expect(result.values.planModeVerbosity).toBe('detailed')
  expect(() => saveHostExecutionPreferences({ ...request, patch: { toolAutoApprove: false } })).toThrow('changed')
})
it('merges acknowledged per-tool patches without removing unrelated tools', () => {
  const first = readHostExecutionPreferences()
  const next = saveHostExecutionPreferences({ ...first, expectedRevision: first.revision, patch: { tools: { read_file: true } } })
  const last = saveHostExecutionPreferences({ ...next, expectedRevision: next.revision, patch: { tools: { bash: false } } })
  expect(last.values.tools).toEqual({ read_file: true, bash: false })
})

it('preserves untouched domain bases while importing a newly added domain', () => {
  const initial = readHostExecutionPreferences()
  const saved = saveHostExecutionPreferences({ ...initial, expectedRevision: initial.revision, patch: { toolAutoApprove: true } })
  const imported = importHostExecutionPreferences({ ygg_subagent_tool_settings: JSON.stringify({ maxTurns: 42 }) })
  expect(imported.revisions?.toolAutoApprove).toBe(saved.revisions?.toolAutoApprove)
  expect(imported.revisions?.subagent).toBe((saved.revisions?.subagent ?? 0) + 1)
  expect(imported.values.subagent.maxTurns).toBe(42)
})
