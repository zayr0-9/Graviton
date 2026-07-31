import { describe, expect, it } from 'vitest'
import { isCloudProxyPathAllowed, CLOUD_PROXY_ALLOWED_PREFIXES } from '../cloudProxyRoutes.js'

describe('cloud proxy allowlist', () => {
  it('allows exactly the Railway-authoritative resource prefixes and their subpaths', () => {
    const allowed = [
      '/models',
      '/models/openrouter',
      '/models/openrouter/zdr',
      '/users/u1',
      '/users',
      '/system-prompts',
      '/system-prompts/default',
      '/stripe/pricing-info',
      '/app-store/community',
      '/oauth/google-drive/status',
    ]
    for (const p of allowed) expect(isCloudProxyPathAllowed(p)).toBe(true)
  })

  it('rejects storage-owned + unknown paths (those belong to /api/gw or nowhere)', () => {
    const rejected = ['/', '/conversations', '/conversations/c1', '/messages/m1', '/modelsfoo', '/projects', '/sync/message']
    for (const p of rejected) expect(isCloudProxyPathAllowed(p)).toBe(false)
  })

  it('a prefix must match a full segment, not a substring (/modelsX is not /models)', () => {
    expect(isCloudProxyPathAllowed('/models-secret')).toBe(false)
    expect(isCloudProxyPathAllowed('/usersX')).toBe(false)
  })

  it('exposes the allowlist for auditing', () => {
    expect(CLOUD_PROXY_ALLOWED_PREFIXES).toContain('/stripe')
    expect(CLOUD_PROXY_ALLOWED_PREFIXES).toContain('/models')
  })
})
