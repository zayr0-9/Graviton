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
