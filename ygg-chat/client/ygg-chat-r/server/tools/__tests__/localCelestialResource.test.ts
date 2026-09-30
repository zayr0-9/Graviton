import { describe, expect, it } from 'vitest'
import {
  shouldOmitLocalCelestialResource, LOCAL_CELESTIAL_MCP_URL, LOCAL_CELESTIAL_SCOPES,
  CELESTIAL_TEST_ISSUER, CELESTIAL_TEST_AUTHORIZATION_ENDPOINT,
  CELESTIAL_TEST_TOKEN_ENDPOINT, CELESTIAL_TEST_CLIENT_ID,
} from '../../mcp/oauthDiscovery.js'

const approved = {
  omitResourceForLocalCelestialTest: true,
  authorizationServer: CELESTIAL_TEST_ISSUER,
  authorizationEndpoint: CELESTIAL_TEST_AUTHORIZATION_ENDPOINT,
  tokenEndpoint: CELESTIAL_TEST_TOKEN_ENDPOINT,
  clientId: CELESTIAL_TEST_CLIENT_ID,
  tokenEndpointAuthMethod: 'none',
  scopes: [...LOCAL_CELESTIAL_SCOPES],
}

describe('local Celestial resource omission pins', () => {
  it('defaults off, and accepts only explicit opt-in with the exact scope set', () => {
    expect(shouldOmitLocalCelestialResource('https://other.test', undefined)).toBe(false)
    expect(shouldOmitLocalCelestialResource(LOCAL_CELESTIAL_MCP_URL, { ...approved, omitResourceForLocalCelestialTest: false })).toBe(false)
    expect(shouldOmitLocalCelestialResource(LOCAL_CELESTIAL_MCP_URL, approved)).toBe(true)
    expect(shouldOmitLocalCelestialResource(LOCAL_CELESTIAL_MCP_URL, { ...approved, scopes: [...approved.scopes].reverse() })).toBe(true)
  })

  it.each([
    'http://localhost:8081/api/mcp-gp/rpc', 'http://127.1:8081/api/mcp-gp/rpc',
    'http://127.0.0.1:8082/api/mcp-gp/rpc', 'https://127.0.0.1:8081/api/mcp-gp/rpc',
    `${LOCAL_CELESTIAL_MCP_URL}/`, `${LOCAL_CELESTIAL_MCP_URL}?x=1`, `${LOCAL_CELESTIAL_MCP_URL}#x`,
    'http://user@127.0.0.1:8081/api/mcp-gp/rpc', 'https://deployed.example/mcp',
  ])('rejects MCP URL %s', url => {
    expect(() => shouldOmitLocalCelestialResource(url, approved)).toThrow(/exact local MCP/)
  })

  it.each([
    { authorizationServer: `${CELESTIAL_TEST_ISSUER}/` },
    { authorizationEndpoint: `${CELESTIAL_TEST_AUTHORIZATION_ENDPOINT}?x=1` },
    { tokenEndpoint: `${CELESTIAL_TEST_TOKEN_ENDPOINT}#x` },
    { tokenEndpoint: CELESTIAL_TEST_TOKEN_ENDPOINT.replace('https:', 'http:') },
    { clientId: 'other' }, { clientMode: 'dynamic' }, { clientSecret: 'secret' },
    { tokenEndpointAuthMethod: 'client_secret_post' },
    { scopes: undefined }, { scopes: [] }, { scopes: ['openid', 'profile', 'email', 'other'] },
    { scopes: [...approved.scopes, 'extra'] }, { scopes: [...approved.scopes, 'openid'] },
    { scopes: ['openid', 'openid', 'email', approved.scopes[3]!] },
  ])('rejects mismatched configuration %j', changes => {
    expect(() => shouldOmitLocalCelestialResource(LOCAL_CELESTIAL_MCP_URL, { ...approved, ...changes })).toThrow(/exact local MCP/)
  })

  it('allows unresolved endpoints only before discovery; never before refresh', () => {
    const pending = { ...approved, authorizationEndpoint: undefined, tokenEndpoint: undefined }
    expect(shouldOmitLocalCelestialResource(LOCAL_CELESTIAL_MCP_URL, pending, false)).toBe(true)
    expect(() => shouldOmitLocalCelestialResource(LOCAL_CELESTIAL_MCP_URL, pending)).toThrow()
    expect(() => shouldOmitLocalCelestialResource(LOCAL_CELESTIAL_MCP_URL, { ...pending, tokenEndpoint: 'https://evil.test/token' }, false)).toThrow()
  })
})
