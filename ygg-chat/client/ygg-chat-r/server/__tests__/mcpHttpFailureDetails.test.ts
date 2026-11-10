import { describe, expect, it } from 'vitest'
import { describeHttpFailure, sanitizeDiagnosticText } from '../mcp/httpFailureDetails.js'

const response = (status: number, headers: Record<string, string>, statusText = '') =>
  new Response(null, { status, statusText, headers })

describe('describeHttpFailure', () => {
  it('reports Cloudflare challenge headers and only the HTML title', () => {
    const body = '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body><script>secret()</script></body></html>'
    const detail = describeHttpFailure(
      response(403, { 'content-type': 'text/html; charset=UTF-8', 'cf-ray': 'a57d92e0596f2059-LHR', 'cf-mitigated': 'challenge' }),
      body,
      'oauth'
    )
    expect(detail).toBe(
      'HTTP 403 | content-type: text/html; charset=UTF-8 | cf-ray: a57d92e0596f2059-LHR | cf-mitigated: challenge | ' +
        'body: HTML page "Just a moment..." | Cloudflare applied a "challenge" mitigation before the request reached the server; ' +
        'MCP clients cannot complete browser challenges, so the zone\'s WAF/bot settings must allow this endpoint'
    )
    expect(detail).not.toContain('<script>')
  })

  it('exposes only standard OAuth error fields from JSON token responses', () => {
    const detail = describeHttpFailure(
      response(400, { 'content-type': 'application/json' }, 'Bad Request'),
      JSON.stringify({ error: 'invalid_grant', error_description: 'refresh_token expired', refresh_token: 'rt-should-not-leak' }),
      'oauth'
    )
    expect(detail).toBe('HTTP 400 Bad Request | content-type: application/json | body: error=invalid_grant, error_description=refresh_token expired')
    expect(detail).not.toContain('rt-should-not-leak')
  })

  it('names keys without values when an OAuth JSON body has no error fields', () => {
    const detail = describeHttpFailure(response(500, { 'content-type': 'application/json' }), '{"access_token":"at-secret","x":1}', 'oauth')
    expect(detail).toContain('body: JSON without OAuth error fields (keys: access_token, x)')
    expect(detail).not.toContain('at-secret')
  })

  it('keeps generic bodies but redacts credentials and truncates', () => {
    const detail = describeHttpFailure(
      response(401, {}),
      `denied for Bearer abc.def.ghi code=auth-code-123 token ${'x'.repeat(40)} ${'detail '.repeat(60)}`
    )
    expect(detail).toContain('content-type: none')
    expect(detail).toContain('Bearer [redacted]')
    expect(detail).toContain('code=[redacted]')
    expect(detail).not.toContain('auth-code-123')
    expect(detail).not.toContain('x'.repeat(40))
    expect(detail.endsWith('…')).toBe(true)
  })

  it('reports an empty body', () => {
    expect(describeHttpFailure(response(502, { 'content-type': 'text/plain' }), '  ')).toBe('HTTP 502 | content-type: text/plain | body: empty')
  })
})

describe('sanitizeDiagnosticText', () => {
  it('redacts JSON-style secrets and long token-like values while keeping URLs readable', () => {
    const text = sanitizeDiagnosticText(
      '{"client_secret":"s3cr3t","error":"redirect_uri mismatch for http://127.0.0.1:33418/mcp/oauth/callback"} eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop.payload.sig'
    )
    expect(text).toContain('"client_secret":"[redacted]"')
    expect(text).toContain('http://127.0.0.1:33418/mcp/oauth/callback')
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9')
  })
})
