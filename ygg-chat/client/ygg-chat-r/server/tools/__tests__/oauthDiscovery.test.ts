import { describe, expect, it } from 'vitest'
import {
  buildAuthorizationServerMetadataCandidates,
  buildProtectedResourceMetadataCandidates,
  parseWwwAuthenticateBearerChallenge,
} from '../../mcp/oauthDiscovery.js'

describe('oauthDiscovery helpers', () => {
  it('parses bearer challenge fields', () => {
    const challenge = parseWwwAuthenticateBearerChallenge(
      'Bearer error="invalid_request", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/mcp", scope="repo read:user"'
    )

    expect(challenge.resourceMetadataUrl).toBe(
      'https://api.example.com/.well-known/oauth-protected-resource/mcp'
    )
    expect(challenge.scope).toBe('repo read:user')
    expect(challenge.error).toBe('invalid_request')
  })

  it('builds protected resource metadata candidates in spec order', () => {
    const candidates = buildProtectedResourceMetadataCandidates(new URL('https://mcp.example.com/public/mcp?x=1'))

    expect(candidates).toEqual([
      'https://mcp.example.com/.well-known/oauth-protected-resource/public/mcp',
      'https://mcp.example.com/.well-known/oauth-protected-resource',
    ])
  })

  it('builds authorization server metadata candidates for issuers with paths', () => {
    const candidates = buildAuthorizationServerMetadataCandidates('https://github.com/login/oauth')

    expect(candidates).toEqual([
      'https://github.com/.well-known/oauth-authorization-server/login/oauth',
      'https://github.com/.well-known/openid-configuration/login/oauth',
      'https://github.com/login/oauth/.well-known/openid-configuration',
    ])
  })

  it('builds authorization server metadata candidates for root issuers', () => {
    const candidates = buildAuthorizationServerMetadataCandidates('https://auth.example.com')

    expect(candidates).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server',
      'https://auth.example.com/.well-known/openid-configuration',
    ])
  })
})
