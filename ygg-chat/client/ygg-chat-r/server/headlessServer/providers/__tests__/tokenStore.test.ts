import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProviderTokenStore } from '../tokenStore.js'

const sqliteAvailable = (() => {
  try {
    const probe = new Database(':memory:')
    probe.close()
    return true
  } catch {
    return false
  }
})()

const sqliteIt = sqliteAvailable ? it : it.skip

describe('ProviderTokenStore', () => {
  it('falls back to in-memory storage when DB is not provided', () => {
    const store = new ProviderTokenStore()

    store.upsert({
      provider: 'openaichatgpt',
      userId: 'u-memory',
      accessToken: 'access-memory',
      refreshToken: 'refresh-memory',
      expiresAt: '2099-01-01T00:00:00.000Z',
      accountId: 'acct-memory',
    })

    expect(store.get('openaichatgpt', 'u-memory')?.accessToken).toBe('access-memory')

    store.delete('openaichatgpt', 'u-memory')
    expect(store.get('openaichatgpt', 'u-memory')).toBeNull()
  })

  sqliteIt('persists tokens in sqlite and survives store re-instantiation', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ygg-provider-token-store-'))
    const dbPath = path.join(tmpDir, 'provider_tokens.db')

    try {
      const db1 = new Database(dbPath)
      const store1 = new ProviderTokenStore(db1)

      store1.upsert({
        provider: 'openaichatgpt',
        userId: 'u-db',
        accessToken: 'access-db',
        refreshToken: 'refresh-db',
        expiresAt: '2099-01-01T00:00:00.000Z',
        accountId: 'acct-db',
      })

      expect(store1.get('openaichatgpt', 'u-db')?.accessToken).toBe('access-db')
      db1.close()

      const db2 = new Database(dbPath)
      const store2 = new ProviderTokenStore(db2)

      const restored = store2.get('openaichatgpt', 'u-db')
      expect(restored).toBeTruthy()
      expect(restored?.refreshToken).toBe('refresh-db')
      expect(restored?.accountId).toBe('acct-db')

      store2.delete('openaichatgpt', 'u-db')
      expect(store2.get('openaichatgpt', 'u-db')).toBeNull()

      db2.close()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
