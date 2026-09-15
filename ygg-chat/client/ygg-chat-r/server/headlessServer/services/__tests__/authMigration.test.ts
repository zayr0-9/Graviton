import { describe, it, expect } from 'vitest'
import { SettingsCredentialStore } from '../../../auth/credentialStore.js'
import { migrateOAuthCredentials, importRendererLegacyCredentials, AUTH_MIGRATION_KEY, type LegacyOAuthRow } from '../../../auth/authMigration.js'
import type { KeyValueStore } from '../../../hostCapabilities.js'

function setup() {
  const values = new Map<string, unknown>()
  const settings: KeyValueStore = { get: key => values.get(key), set: (key, value) => { values.set(key, value) }, delete: key => { values.delete(key) } }
  const store = new SettingsCredentialStore(settings)
  const records: LegacyOAuthRow[] = []
  const rows = { list: () => [...records], remove: (provider: string, userId: string) => {
    const index = records.findIndex(row => row.provider === provider && row.userId === userId)
    if (index >= 0) records.splice(index, 1)
  } }
  const codex = { accessToken: 'access', refreshToken: 'refresh', accountId: 'account', expiresAt: 9_000_000_000_000 }
  return { values, settings, store, records, rows, codex }
}
describe('OAuth credential migration', () => {
  it('deduplicates legacy aliases, commits once and preserves unrelated keys/rows', () => {
    const { values, settings, store, records, rows, codex } = setup()
    values.set('openai_chatgpt_tokens', codex)
    values.set('preferences', { theme: 'dark' })
    records.push({ ...codex, provider: 'openaichatgpt', userId: 'alias', expiresAt: String(codex.expiresAt) })
    records.push({ provider: 'zai', userId: 'local', accessToken: 'api-key' })
    migrateOAuthCredentials(settings, store, rows)
    const migrated = store.read('codex')!
    expect(migrated.refreshToken).toBe('refresh')
    expect(values.has('openai_chatgpt_tokens')).toBe(false)
    expect(records.map(row => row.provider)).toEqual(['zai'])
    expect(values.get('preferences')).toEqual({ theme: 'dark' })
    migrateOAuthCredentials(settings, store, rows)
    expect(store.read('codex')?.sessionId).toBe(migrated.sessionId)
  })
  it('does not guess between divergent rotating tokens for one account', () => {
    const { values, settings, store, records, rows, codex } = setup()
    values.set('openai_chatgpt_tokens', codex)
    records.push({ ...codex, provider: 'openaichatgpt', userId: 'alias', accessToken: 'different', refreshToken: 'different', expiresAt: String(codex.expiresAt) })
    expect(migrateOAuthCredentials(settings, store, rows).needsReconnect).toEqual(['codex'])
    expect(store.read('codex')).toBeNull()
    importRendererLegacyCredentials(settings, store, { codex })
    expect(store.read('codex')).toBeNull()
  })
  it('imports renderer-only credentials once and never resurrects a signed-out session', () => {
    const { settings, store, rows, codex } = setup()
    migrateOAuthCredentials(settings, store, rows)
    store.write('codex', null)
    importRendererLegacyCredentials(settings, store, { codex })
    expect(store.read('codex')).toBeNull()
    expect(settings.get(AUTH_MIGRATION_KEY)).toMatchObject({ rendererCleaned: true })
  })
  it('accepts a one-time renderer-only handoff into an uninitialized slot', () => {
    const { settings, store, rows, codex } = setup()
    migrateOAuthCredentials(settings, store, rows)
    importRendererLegacyCredentials(settings, store, { codex })
    expect(store.read('codex')?.accessToken).toBe('access')
    importRendererLegacyCredentials(settings, store, { codex: { ...codex, accessToken: 'stale' } })
    expect(store.read('codex')?.accessToken).toBe('access')
  })
  it('keeps legacy credentials if canonical persistence fails', () => {
    const { values, settings, store, rows, codex } = setup()
    values.set('openai_chatgpt_tokens', codex)
    store.write = () => { throw new Error('disk full') }
    expect(() => migrateOAuthCredentials(settings, store, rows)).toThrow('disk full')
    expect(values.get('openai_chatgpt_tokens')).toEqual(codex)
    expect(values.has(AUTH_MIGRATION_KEY)).toBe(false)
  })
})
