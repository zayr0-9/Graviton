export interface WwwAuthenticateBearerChallenge {
  resourceMetadataUrl?: string
  scope?: string
  error?: string
  errorDescription?: string
}

export function parseWwwAuthenticateBearerChallenge(headerValue: string | null | undefined): WwwAuthenticateBearerChallenge {
  if (!headerValue) return {}

  const bearerMatch = headerValue.match(/\bbearer\b\s*(.*)$/i)
  if (!bearerMatch) return {}

  const paramsPart = bearerMatch[1] || ''
  const params: Record<string, string> = {}
  const regex = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g

  let match: RegExpExecArray | null
  while ((match = regex.exec(paramsPart)) !== null) {
    const key = match[1]?.toLowerCase()
    const value = match[2] ?? match[3] ?? ''
    if (key) {
      params[key] = value
    }
  }

  return {
    resourceMetadataUrl: params.resource_metadata,
    scope: params.scope,
    error: params.error,
    errorDescription: params.error_description,
  }
}

export function buildProtectedResourceMetadataCandidates(mcpEndpointUrl: URL): string[] {
  const path = normalizePathname(mcpEndpointUrl.pathname)
  const pathBased = `${mcpEndpointUrl.origin}/.well-known/oauth-protected-resource${path === '/' ? '' : path}`
  const rootBased = `${mcpEndpointUrl.origin}/.well-known/oauth-protected-resource`
  return dedupe([pathBased, rootBased])
}

export function buildAuthorizationServerMetadataCandidates(authorizationServer: string): string[] {
  const issuer = new URL(authorizationServer)
  const path = normalizePathname(issuer.pathname)

  if (path !== '/') {
    return dedupe([
      `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
      `${issuer.origin}/.well-known/openid-configuration${path}`,
      `${issuer.origin}${path}/.well-known/openid-configuration`,
    ])
  }

  return dedupe([
    `${issuer.origin}/.well-known/oauth-authorization-server`,
    `${issuer.origin}/.well-known/openid-configuration`,
  ])
}

function normalizePathname(pathname: string): string {
  if (!pathname || pathname === '/') return '/'
  const withLeadingSlash = pathname.startsWith('/') ? pathname : `/${pathname}`
  return withLeadingSlash.replace(/\/+$/, '')
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  return out
}

export const CELESTIAL_TEST_ISSUER = 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_nSxSsgJuj'
export const CELESTIAL_TEST_AUTHORIZATION_ENDPOINT = 'https://vega-celestial-test.auth.us-east-2.amazoncognito.com/oauth2/authorize'
export const CELESTIAL_TEST_TOKEN_ENDPOINT = 'https://vega-celestial-test.auth.us-east-2.amazoncognito.com/oauth2/token'
export const CELESTIAL_TEST_CLIENT_ID = '5391d6flv8jtvpgg0b6j9f50dv'

/** Returns whether the explicit metadata exception was used; never alters metadata. */
export function validateOAuthPkceMetadata(
  metadata: {
    issuer?: unknown
    authorization_endpoint?: unknown
    token_endpoint?: unknown
    code_challenge_methods_supported?: unknown
  },
  expectedIssuer: string,
  allowMissingPkceS256ForCelestialTest = false
): boolean {
  const methods = metadata.code_challenge_methods_supported
  if (Array.isArray(methods) && methods.every(method => typeof method === 'string') && methods.includes('S256')) {
    return false
  }
  if (
    !Object.prototype.hasOwnProperty.call(metadata, 'code_challenge_methods_supported') &&
    allowMissingPkceS256ForCelestialTest === true &&
    expectedIssuer === CELESTIAL_TEST_ISSUER &&
    metadata.issuer === expectedIssuer &&
    metadata.authorization_endpoint === CELESTIAL_TEST_AUTHORIZATION_ENDPOINT &&
    metadata.token_endpoint === CELESTIAL_TEST_TOKEN_ENDPOINT
  ) {
    return true
  }
  throw new Error('OAuth discovery failed: authorization server does not advertise PKCE S256 support')
}

export const LOCAL_CELESTIAL_MCP_URL = 'http://127.0.0.1:8081/api/mcp-gp/rpc'
export const LOCAL_CELESTIAL_SCOPES = [
  'openid', 'profile', 'email',
  'https://workbench.celestial.test.vega-alts.com/api/mcp-gp/rpc/invoke',
] as const

/** Trusted opt-in only. Missing endpoints are permitted only before discovery. */
export function shouldOmitLocalCelestialResource(
  mcpUrl: string | undefined,
  oauth: {
    omitResourceForLocalCelestialTest?: boolean
    authorizationServer?: string
    authorizationEndpoint?: string
    tokenEndpoint?: string
    clientId?: string
    scopes?: string[]
    tokenEndpointAuthMethod?: string
    clientSecret?: string
    clientMode?: string
  } | undefined,
  requireEndpoints = true
): boolean {
  if (oauth?.omitResourceForLocalCelestialTest !== true) return false
  const scopes = oauth.scopes
  const matchesEndpoint = (actual: string | undefined, expected: string) =>
    actual === expected || (!requireEndpoints && actual === undefined)
  if (
    mcpUrl !== LOCAL_CELESTIAL_MCP_URL ||
    oauth.authorizationServer !== CELESTIAL_TEST_ISSUER ||
    !matchesEndpoint(oauth.authorizationEndpoint, CELESTIAL_TEST_AUTHORIZATION_ENDPOINT) ||
    !matchesEndpoint(oauth.tokenEndpoint, CELESTIAL_TEST_TOKEN_ENDPOINT) ||
    oauth.clientId !== CELESTIAL_TEST_CLIENT_ID ||
    oauth.tokenEndpointAuthMethod !== 'none' || oauth.clientSecret || oauth.clientMode === 'dynamic' ||
    !Array.isArray(scopes) || scopes.length !== LOCAL_CELESTIAL_SCOPES.length ||
    !LOCAL_CELESTIAL_SCOPES.every(scope => scopes.includes(scope))
  ) {
    throw new Error('Local Celestial resource omission requires the exact local MCP URL, TEST issuer/endpoints, public client, and openid profile email GP scopes')
  }
  return true
}
