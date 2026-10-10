import { describe, expect, it, vi } from 'vitest'
import { CredentialVault, CREDENTIAL_SERVICE, CREDENTIAL_VAULT_ACCOUNT, type CredentialBackend } from '../credentialVault.js'

function fixture() {
  const entries = new Map<string, string>()
  const key = (service: string, account: string) => JSON.stringify([service, account])
  const backend: CredentialBackend = {
    getPassword: vi.fn(async (service, account) => entries.get(key(service, account)) ?? null),
    setPassword: vi.fn(async (service, account, value) => { entries.set(key(service, account), value) }),
    deletePassword: vi.fn(async (service, account) => entries.delete(key(service, account))),
    findCredentials: vi.fn(async service => Array.from(entries, ([entryKey, password]) => ({ identity: JSON.parse(entryKey) as string[], password }))
      .filter(entry => entry.identity[0] === service).map(entry => ({ account: entry.identity[1], password: entry.password }))),
  }
  const vault = new CredentialVault(async () => backend, async work => work())
  const snapshot = () => JSON.parse(entries.get(key(CREDENTIAL_SERVICE, CREDENTIAL_VAULT_ACCOUNT))!)
  const legacy = (service: string, account: string, value: string) => entries.set(key(service, account), value)
  return { entries, key, backend, vault, snapshot, legacy }
}

describe('shared credential vault', () => {
  it('coalesces overlapping reads without creating an empty item or probing legacy accounts', async () => {
    const { vault, backend } = fixture()
    expect(await Promise.all([vault.get('a'), vault.get('b'), vault.get('c')])).toEqual([null, null, null])
    expect(backend.getPassword).toHaveBeenCalledTimes(1)
    expect(backend.getPassword).toHaveBeenCalledWith(CREDENTIAL_SERVICE, CREDENTIAL_VAULT_ACCOUNT)
    expect(backend.setPassword).not.toHaveBeenCalled()
    expect(backend.findCredentials).not.toHaveBeenCalled()
  })

  it('serializes concurrent mutations and supports prototype-like account names', async () => {
    const { vault, snapshot } = fixture()
    await Promise.all([vault.set('api-key:brave-search', 'brave'), vault.set('mcp-oauth:a', 'a'), vault.set('__proto__', 'safe')])
    expect(await vault.get('__proto__')).toBe('safe')
    expect(await vault.delete('mcp-oauth:a')).toBe(true)
    expect(snapshot().secrets).toEqual({ 'api-key:brave-search': 'brave', ['__proto__']: 'safe' })
    expect(snapshot().resolved['mcp-oauth:a']).toBe(true)
  })

  it('rejects corrupt and unsupported vault data without overwriting it', async () => {
    const { vault, legacy, backend } = fixture()
    for (const value of ['not-json', '{"version":2}', '{"version":1,"secrets":[],"resolved":{},"consolidated":false}']) {
      legacy(CREDENTIAL_SERVICE, CREDENTIAL_VAULT_ACCOUNT, value)
      await expect(vault.set('a', 'value')).rejects.toThrow(/invalid|Unsupported/)
    }
    expect(backend.setPassword).not.toHaveBeenCalled()
  })

  it('does not automatically retry denied reads and permits explicit retry', async () => {
    const { vault, backend } = fixture()
    vi.mocked(backend.getPassword).mockRejectedValueOnce(new Error('denied'))
    await expect(vault.get('a')).rejects.toThrow('denied')
    expect(backend.getPassword).toHaveBeenCalledTimes(1)
    expect(await vault.get('a')).toBeNull()
  })

  it('requires explicit consolidation for unresolved existing OAuth configs', async () => {
    const { vault } = fixture()
    await expect(vault.get('mcp-oauth:a', true)).rejects.toThrow('Consolidate credentials')
    await vault.consolidate()
    expect(await vault.get('mcp-oauth:a', true)).toBeNull()
  })

  it('enumerates old services only explicitly, preserves precedence and excludes unrelated accounts', async () => {
    const { vault, legacy, entries, key, snapshot } = fixture()
    legacy('ygg-chat', 'mcp-oauth:a', 'primary')
    legacy('ygg-chat-r', 'mcp-oauth:a', 'older')
    legacy('com.yggdrasil.chat', 'mcp-oauth:orphan', 'orphan')
    legacy('ygg-chat-r', 'api-key:brave-search', 'brave')
    legacy('ygg-chat', 'other-product', 'untouched')
    expect(await vault.consolidate()).toMatchObject({ migrated: 3, removed: 4, complete: true })
    expect(snapshot().secrets).toEqual({ 'mcp-oauth:a': 'primary', 'mcp-oauth:orphan': 'orphan', 'api-key:brave-search': 'brave' })
    expect(entries.get(key('ygg-chat', 'other-product'))).toBe('untouched')
    expect(await vault.consolidate()).toMatchObject({ migrated: 0, removed: 0, complete: true })
  })

  it('does not resurrect intentionally removed credentials or overwrite refreshed values', async () => {
    const { vault, legacy } = fixture()
    await vault.set('mcp-oauth:a', 'refreshed')
    await vault.delete('mcp-oauth:b')
    legacy('ygg-chat', 'mcp-oauth:a', 'stale')
    legacy('ygg-chat', 'mcp-oauth:b', 'deleted')
    await vault.consolidate()
    expect(await vault.get('mcp-oauth:a')).toBe('refreshed')
    expect(await vault.get('mcp-oauth:b')).toBeNull()
  })

  it('retains all originals if enumeration or persistence verification fails', async () => {
    const { vault, legacy, backend } = fixture()
    legacy('ygg-chat', 'mcp-oauth:a', 'old')
    vi.mocked(backend.findCredentials).mockRejectedValueOnce(new Error('denied'))
    await expect(vault.consolidate()).rejects.toThrow('denied')
    expect(backend.setPassword).not.toHaveBeenCalled()
    vi.mocked(backend.setPassword).mockResolvedValueOnce(undefined)
    await expect(vault.consolidate()).rejects.toThrow('verified')
    expect(backend.deletePassword).not.toHaveBeenCalled()
  })

  it('reports cleanup failure and resumes without overwriting new credentials', async () => {
    const { vault, legacy, backend } = fixture()
    legacy('ygg-chat', 'mcp-oauth:a', 'old')
    vi.mocked(backend.deletePassword).mockRejectedValueOnce(new Error('denied'))
    expect(await vault.consolidate()).toMatchObject({ migrated: 1, removed: 0, complete: false })
    await vault.set('mcp-oauth:a', 'new')
    expect(await vault.consolidate()).toMatchObject({ migrated: 0, removed: 1, complete: true })
    expect(await vault.get('mcp-oauth:a')).toBe('new')
  })

  it('imports plaintext only once and never resurrects a tombstoned account', async () => {
    const { vault } = fixture()
    await vault.importLegacy('mcp-oauth:a', 'old')
    await vault.set('mcp-oauth:a', 'rotated')
    await vault.importLegacy('mcp-oauth:a', 'stale')
    expect(await vault.get('mcp-oauth:a')).toBe('rotated')
    await vault.delete('mcp-oauth:a')
    await vault.importLegacy('mcp-oauth:a', 'stale')
    expect(await vault.get('mcp-oauth:a')).toBeNull()
  })

  it('applies disjoint logical-account patches atomically', async () => {
    const { vault } = fixture()
    await vault.set('mcp-oauth:a', '{}')
    await Promise.all([
      vault.update('mcp-oauth:a', current => JSON.stringify({ ...JSON.parse(current!), accessToken: 'access' })),
      vault.update('mcp-oauth:a', current => JSON.stringify({ ...JSON.parse(current!), refreshToken: 'refresh' })),
    ])
    expect(JSON.parse((await vault.get('mcp-oauth:a'))!)).toEqual({ accessToken: 'access', refreshToken: 'refresh' })
  })

  it('does not serve a cached success after a failed write', async () => {
    const { vault, backend } = fixture()
    await vault.set('a', 'original')
    vi.mocked(backend.setPassword).mockRejectedValueOnce(new Error('denied'))
    await expect(vault.set('a', 'replacement')).rejects.toThrow('denied')
    expect(await vault.get('a')).toBe('original')
  })
})
