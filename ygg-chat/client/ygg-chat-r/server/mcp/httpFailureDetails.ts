/**
 * Builds a diagnostic summary for a failed MCP/OAuth HTTP response without
 * leaking credentials: status, content type, Cloudflare ray/mitigation headers
 * and a sanitized body summary.
 */

type FailedResponse = Pick<Response, 'status' | 'statusText' | 'headers'>

export type HttpFailureBodyFormat =
  /** OAuth endpoints: JSON bodies expose only the standard error fields. */
  | 'oauth'
  /** Other endpoints: sanitized, truncated body text. */
  | 'generic'

const MAX_BODY_SNIPPET = 300
const OAUTH_ERROR_FIELDS = ['error', 'error_description', 'error_uri'] as const
const SENSITIVE_PARAMETER =
  /\b(access_token|refresh_token|id_token|code|code_verifier|client_secret|assertion|password)(["']?\s*[:=]\s*["']?)[^"'&\s,}]+/gi
const BEARER_VALUE = /\bBearer\s+[^\s"',}]+/gi
const TOKEN_LIKE = /[A-Za-z0-9_-]{32,}(?:\.[A-Za-z0-9_-]+)*/g

export function sanitizeDiagnosticText(text: string): string {
  return text
    .replace(SENSITIVE_PARAMETER, '$1$2[redacted]')
    .replace(BEARER_VALUE, 'Bearer [redacted]')
    .replace(TOKEN_LIKE, '[redacted]')
}

function truncate(text: string, limit = MAX_BODY_SNIPPET): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function summarizeBody(body: string, contentType: string, format: HttpFailureBodyFormat): string | undefined {
  const trimmed = body.trim()
  if (!trimmed) return undefined

  if (/html/i.test(contentType) || /^<(!doctype|html)/i.test(trimmed)) {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(trimmed)?.[1]?.replace(/\s+/g, ' ').trim()
    return title ? `HTML page "${truncate(sanitizeDiagnosticText(title), 120)}"` : 'HTML page'
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    parsed = undefined
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && format === 'oauth') {
    const record = parsed as Record<string, unknown>
    const fields = OAUTH_ERROR_FIELDS.filter(field => typeof record[field] === 'string').map(
      field => `${field}=${truncate(sanitizeDiagnosticText(record[field] as string), 200)}`
    )
    if (fields.length > 0) return fields.join(', ')
    return `JSON without OAuth error fields (keys: ${truncate(Object.keys(record).join(', '), 120)})`
  }

  const text = parsed === undefined ? trimmed.replace(/\s+/g, ' ') : JSON.stringify(parsed)
  return truncate(sanitizeDiagnosticText(text))
}

/**
 * Example: `HTTP 403 | content-type: text/html; charset=UTF-8 | cf-ray: abc-LHR |
 * cf-mitigated: challenge | body: HTML page "Just a moment..." | Cloudflare ...`
 */
export function describeHttpFailure(
  response: FailedResponse,
  body: string,
  format: HttpFailureBodyFormat = 'generic'
): string {
  const parts = [`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`]
  const contentType = response.headers.get('content-type') || ''
  const cfRay = response.headers.get('cf-ray')
  const cfMitigated = response.headers.get('cf-mitigated')

  parts.push(`content-type: ${contentType || 'none'}`)
  if (cfRay) parts.push(`cf-ray: ${cfRay}`)
  if (cfMitigated) parts.push(`cf-mitigated: ${cfMitigated}`)

  const summary = summarizeBody(body, contentType, format)
  parts.push(`body: ${summary ?? 'empty'}`)

  if (cfMitigated) {
    parts.push(
      `Cloudflare applied a "${cfMitigated}" mitigation before the request reached the server; MCP clients cannot complete browser challenges, so the zone's WAF/bot settings must allow this endpoint`
    )
  }

  return parts.join(' | ')
}
