import { describe, expect, it } from 'vitest'
import {
  CELESTIAL_TEST_AUTHORIZATION_ENDPOINT,
  CELESTIAL_TEST_CLIENT_ID,
  CELESTIAL_TEST_ISSUER,
  CELESTIAL_TEST_TOKEN_ENDPOINT,
  validateOAuthPkceMetadata,
} from '../../mcp/oauthDiscovery.js'

const pinnedMetadata = Object.freeze({
  issuer: CELESTIAL_TEST_ISSUER,
  authorization_endpoint: CELESTIAL_TEST_AUTHORIZATION_ENDPOINT,
  token_endpoint: CELESTIAL_TEST_TOKEN_ENDPOINT,
})
const pkceError = 'OAuth discovery failed: authorization server does not advertise PKCE S256 support'

describe('Celestial test OAuth pins', () => {
  it('exports the exact issuer, endpoints, and client ID', () => {
    expect(CELESTIAL_TEST_ISSUER).toBe('https://cognito-idp.us-east-2.amazonaws.com/us-east-2_nSxSsgJuj')
    expect(CELESTIAL_TEST_AUTHORIZATION_ENDPOINT).toBe(
      'https://vega-celestial-test.auth.us-east-2.amazoncognito.com/oauth2/authorize'
    )
    expect(CELESTIAL_TEST_TOKEN_ENDPOINT).toBe(
      'https://vega-celestial-test.auth.us-east-2.amazoncognito.com/oauth2/token'
    )
    expect(CELESTIAL_TEST_CLIENT_ID).toBe('5391d6flv8jtvpgg0b6j9f50dv')
  })
})

describe('validateOAuthPkceMetadata', () => {
  describe.each([undefined, false, true])('with the exception option set to %s', allowException => {
    it.each([
      { name: 'S256 alone', methods: ['S256'] },
      { name: 'S256 among other string methods', methods: ['plain', 'S256', 'other'] },
    ])('accepts $name without using the exception for a standard issuer', ({ methods }) => {
      const metadata = {
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        code_challenge_methods_supported: methods,
      }

      expect(validateOAuthPkceMetadata(metadata, metadata.issuer, allowException)).toBe(false)
    })

    it('does not use the exception when the pinned issuer advertises S256', () => {
      const metadata = { ...pinnedMetadata, code_challenge_methods_supported: ['S256'] }

      expect(validateOAuthPkceMetadata(metadata, CELESTIAL_TEST_ISSUER, allowException)).toBe(false)
    })

    it.each([
      { name: 'explicit undefined', methods: undefined },
      { name: 'null', methods: null },
      { name: 'an empty array', methods: [] },
      { name: 'plain only', methods: ['plain'] },
      { name: 'lowercase s256', methods: ['s256'] },
      { name: 'a string instead of an array', methods: 'S256' },
      { name: 'a number', methods: 256 },
      { name: 'a boolean', methods: true },
      { name: 'an object', methods: {} },
      { name: 'an array-like object', methods: { 0: 'S256', length: 1 } },
      { name: 'S256 mixed with a number', methods: ['S256', 256] },
      { name: 'S256 mixed with null', methods: ['S256', null] },
    ])('rejects $name even for the pinned issuer', ({ methods }) => {
      const metadata = { ...pinnedMetadata, code_challenge_methods_supported: methods }

      expect(() => validateOAuthPkceMetadata(metadata, CELESTIAL_TEST_ISSUER, allowException)).toThrow(pkceError)
    })
  })

  it('rejects an absent methods property by default even for the pinned issuer', () => {
    expect(() => validateOAuthPkceMetadata(pinnedMetadata, CELESTIAL_TEST_ISSUER)).toThrow(pkceError)
  })

  it('rejects an absent methods property when the exception is disabled', () => {
    expect(() => validateOAuthPkceMetadata(pinnedMetadata, CELESTIAL_TEST_ISSUER, false)).toThrow(pkceError)
  })

  it('returns true only for the opted-in pinned metadata without adding or mutating properties', () => {
    const metadata = Object.freeze({ ...pinnedMetadata })
    const before = { ...metadata }

    expect(validateOAuthPkceMetadata(metadata, CELESTIAL_TEST_ISSUER, true)).toBe(true)
    expect(metadata).toStrictEqual(before)
    expect(Object.prototype.hasOwnProperty.call(metadata, 'code_challenge_methods_supported')).toBe(false)
  })

  describe.each([
    { name: 'an unrelated issuer', issuer: 'https://auth.example.com' },
    { name: 'a hostname suffix lookalike', issuer: CELESTIAL_TEST_ISSUER.replace('.amazonaws.com/', '.amazonaws.com.evil.example/') },
    { name: 'another user pool', issuer: `${CELESTIAL_TEST_ISSUER}-other` },
    { name: 'HTTP', issuer: CELESTIAL_TEST_ISSUER.replace('https:', 'http:') },
    { name: 'an explicit HTTPS port', issuer: CELESTIAL_TEST_ISSUER.replace('.com/', '.com:443/') },
    { name: 'a query', issuer: `${CELESTIAL_TEST_ISSUER}?tenant=other` },
    { name: 'a fragment', issuer: `${CELESTIAL_TEST_ISSUER}#other` },
    { name: 'credentials', issuer: CELESTIAL_TEST_ISSUER.replace('https://', 'https://user:pass@') },
    { name: 'a trailing slash', issuer: `${CELESTIAL_TEST_ISSUER}/` },
  ])('rejects $name with the exception enabled', ({ issuer }) => {
    it('when only the expected issuer differs', () => {
      expect(() => validateOAuthPkceMetadata(pinnedMetadata, issuer, true)).toThrow(pkceError)
    })

    it('when only the metadata issuer differs', () => {
      const metadata = { ...pinnedMetadata, issuer }

      expect(() => validateOAuthPkceMetadata(metadata, CELESTIAL_TEST_ISSUER, true)).toThrow(pkceError)
    })

    it('even when the expected and metadata issuers match each other', () => {
      const metadata = { ...pinnedMetadata, issuer }

      expect(() => validateOAuthPkceMetadata(metadata, issuer, true)).toThrow(pkceError)
    })
  })

  it('rejects missing issuer metadata even with the exception enabled', () => {
    const metadata = {
      authorization_endpoint: CELESTIAL_TEST_AUTHORIZATION_ENDPOINT,
      token_endpoint: CELESTIAL_TEST_TOKEN_ENDPOINT,
    }

    expect(() => validateOAuthPkceMetadata(metadata, CELESTIAL_TEST_ISSUER, true)).toThrow(pkceError)
  })

  describe.each([
    { field: 'authorization_endpoint', endpoint: CELESTIAL_TEST_AUTHORIZATION_ENDPOINT },
    { field: 'token_endpoint', endpoint: CELESTIAL_TEST_TOKEN_ENDPOINT },
  ] as const)('pins $field when the exception is enabled', ({ field, endpoint }) => {
    it('rejects an absent endpoint', () => {
      const metadata = { ...pinnedMetadata }
      Reflect.deleteProperty(metadata, field)

      expect(() => validateOAuthPkceMetadata(metadata, CELESTIAL_TEST_ISSUER, true)).toThrow(pkceError)
    })

    it.each([
      { name: 'explicit undefined', value: undefined },
      { name: 'null', value: null },
      { name: 'a non-string value', value: 123 },
      { name: 'an empty string', value: '' },
      { name: 'another host', value: endpoint.replace('vega-celestial-test.', 'other.') },
      { name: 'a hostname suffix lookalike', value: endpoint.replace('.amazoncognito.com/', '.amazoncognito.com.evil.example/') },
      { name: 'HTTP', value: endpoint.replace('https:', 'http:') },
      { name: 'an explicit HTTPS port', value: endpoint.replace('.com/', '.com:443/') },
      { name: 'a non-default port', value: endpoint.replace('.com/', '.com:8443/') },
      { name: 'a query', value: `${endpoint}?redirect_uri=https://evil.example` },
      { name: 'a fragment', value: `${endpoint}#other` },
      { name: 'credentials', value: endpoint.replace('https://', 'https://user:pass@') },
      { name: 'a trailing slash', value: `${endpoint}/` },
      { name: 'another path', value: endpoint.replace('/oauth2/', '/other/') },
      {
        name: 'the other pinned endpoint',
        value: field === 'authorization_endpoint' ? CELESTIAL_TEST_TOKEN_ENDPOINT : CELESTIAL_TEST_AUTHORIZATION_ENDPOINT,
      },
    ])('rejects $name', ({ value }) => {
      const metadata = { ...pinnedMetadata, [field]: value }

      expect(() => validateOAuthPkceMetadata(metadata, CELESTIAL_TEST_ISSUER, true)).toThrow(pkceError)
    })
  })
})
