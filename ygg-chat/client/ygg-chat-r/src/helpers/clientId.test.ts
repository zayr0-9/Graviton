import { describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { generateStreamId } from '../features/chats/streamHelpers'
import { getClientId, newClientId } from './clientId'

describe('HTTP LAN client identities', () => {
  it('works without secure-context randomUUID and retains one document identity', () => {
    vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) })
    try {
      expect(newClientId()).toMatch(/^[0-9a-f-]{36}$/)
      expect(generateStreamId('primary')).toMatch(/^[0-9a-f-]{36}$/)
      expect(getClientId()).toBe(getClientId())
      expect(newClientId()).not.toBe(newClientId())
    } finally { vi.unstubAllGlobals() }
  })
})
