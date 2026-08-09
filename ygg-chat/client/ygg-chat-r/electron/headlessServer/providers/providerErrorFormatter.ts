/**
 * The single classification authority for the headless server.
 *
 * Everything that fails anywhere in a run — provider call, tool, hook, compaction,
 * transport — funnels through `classifyChatError`, which ALWAYS returns a complete
 * `ChatErrorEnvelope`. There is no "unclassifiable" path and no provider gate: any
 * provider can produce a user-visible error.
 *
 * Iron rule from the shared vocabulary: `envelope.userMessage` is the only string
 * ever rendered to a user. Raw `Error.message` text goes in `envelope.detail`.
 */
import {
  CHAT_ERROR_DEFAULTS,
  buildChatErrorEnvelope,
  type ChatErrorCode,
  type ChatErrorEnvelope,
} from '../../../../../shared/chatErrors.js'

export interface FormattedProviderError {
  message: string
  provider: string
  status?: number
  errorType?: string
  resetAt?: number
  retryExhausted: boolean
  originalMessage: string
  /** The classified envelope for this same failure. Always populated. */
  envelope?: ChatErrorEnvelope
}

const MAX_DETAIL_LENGTH = 1200

function rawErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncate(value: string, maxLength = MAX_DETAIL_LENGTH): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value
}

// ──────────────────────────────────────────────────────────────────────────────
// Attached codes — the highest-precedence signal
// ──────────────────────────────────────────────────────────────────────────────

/**
 * `Symbol.for` (not a private symbol) so an error that crosses a duplicated module
 * instance — bundled main vs. ts-node test copy — still carries a readable code.
 */
const ATTACHED_CODE_KEY = Symbol.for('ygg.chat.errorCode')
const ATTACHED_OVERRIDES_KEY = Symbol.for('ygg.chat.errorOverrides')

export type ChatErrorPhase = 'provider' | 'tool' | 'hook' | 'compaction' | 'lifecycle' | 'transport'

export interface ChatErrorClassificationContext {
  provider?: string
  modelName?: string
  phase?: ChatErrorPhase
}

export function isChatErrorCode(value: unknown): value is ChatErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CHAT_ERROR_DEFAULTS, value)
}

/**
 * Tag a thrown error with the code its thrower already knows, so no downstream
 * heuristic has to re-derive it. Non-enumerable, so logging and JSON are unchanged.
 * Primitives are returned untouched (nothing to attach to).
 */
export function attachChatErrorCode<E>(error: E, code: ChatErrorCode, overrides?: Partial<ChatErrorEnvelope>): E {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return error
  try {
    Object.defineProperty(error as object, ATTACHED_CODE_KEY, {
      value: code,
      enumerable: false,
      configurable: true,
      writable: true,
    })
    if (overrides) {
      Object.defineProperty(error as object, ATTACHED_OVERRIDES_KEY, {
        value: overrides,
        enumerable: false,
        configurable: true,
        writable: true,
      })
    }
  } catch {
    // Frozen error object — classification simply falls through to the heuristics.
  }
  return error
}

export function getAttachedChatErrorCode(error: unknown): ChatErrorCode | undefined {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return undefined
  const code = (error as any)[ATTACHED_CODE_KEY]
  return isChatErrorCode(code) ? code : undefined
}

export function getAttachedChatErrorOverrides(error: unknown): Partial<ChatErrorEnvelope> | undefined {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return undefined
  const overrides = (error as any)[ATTACHED_OVERRIDES_KEY]
  return overrides && typeof overrides === 'object' ? (overrides as Partial<ChatErrorEnvelope>) : undefined
}

// ──────────────────────────────────────────────────────────────────────────────
// Fact extraction
// ──────────────────────────────────────────────────────────────────────────────

const MAX_CAUSE_DEPTH = 5

/** The error plus its `cause` chain — Node hides `ECONNREFUSED` under `fetch failed`. */
function errorChain(error: unknown): any[] {
  const chain: any[] = []
  let node: any = error
  let depth = 0
  while (node && depth < MAX_CAUSE_DEPTH) {
    chain.push(node)
    const next =
      (node && typeof node === 'object' && (node.cause ?? node.originalError ?? node.providerError)) || undefined
    if (!next || chain.includes(next)) break
    node = next
    depth += 1
  }
  return chain
}

function nodeMessage(node: any): string {
  if (!node) return ''
  if (typeof node === 'string') return node
  if (node instanceof Error) return node.message || ''
  if (typeof node === 'object') {
    const parts: string[] = []
    if (typeof node.message === 'string') parts.push(node.message)
    if (typeof node.code === 'string') parts.push(node.code)
    if (typeof node.errorType === 'string') parts.push(node.errorType)
    if (typeof node.name === 'string') parts.push(node.name)
    if (typeof node.originalMessage === 'string') parts.push(node.originalMessage)
    if (node.body != null) {
      try {
        parts.push(typeof node.body === 'string' ? node.body : JSON.stringify(node.body))
      } catch {
        /* circular body — skip */
      }
    }
    return parts.join(' ')
  }
  return String(node)
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 100 && value <= 599
}

function extractStatusFromText(message: string): number | undefined {
  const match = message.match(/request failed\s*\((\d{3})\)|\bHTTP\s+(\d{3})\b|\bstatus\s*[:=]\s*(\d{3})\b/i)
  const value = match?.[1] || match?.[2] || match?.[3]
  if (!value) return undefined
  const status = Number(value)
  return Number.isFinite(status) ? status : undefined
}

/**
 * Status off the ERROR OBJECT first. Recovering it by regexing message text loses
 * it for AWS SDK exception names (`ThrottlingException` carries only
 * `$metadata.httpStatusCode`) and for rejected websocket upgrades, whose message
 * is prose. Text is the last resort, not the first.
 */
export function extractStatus(error: unknown): number | undefined {
  for (const node of errorChain(error)) {
    if (!node || typeof node !== 'object') continue
    const candidates = [
      node.status,
      node.statusCode,
      node.$metadata?.httpStatusCode,
      node.response?.status,
      node.response?.statusCode,
      node.httpStatusCode,
    ]
    for (const candidate of candidates) {
      if (isHttpStatus(candidate)) return candidate
      if (typeof candidate === 'string' && isHttpStatus(Number(candidate))) return Number(candidate)
    }
  }
  return extractStatusFromText(rawErrorMessage(error))
}

function extractJsonObject(message: string): any | null {
  const firstBrace = message.indexOf('{')
  const lastBrace = message.lastIndexOf('}')
  if (firstBrace === -1 || lastBrace <= firstBrace) return null

  const candidate = message.slice(firstBrace, lastBrace + 1)
  try {
    return JSON.parse(candidate)
  } catch {
    return null
  }
}

/** `{"error":{...}}` bodies, whether embedded in the message text or hung off `.body`. */
function extractProviderErrorBody(error: unknown, message: string): any | null {
  const fromText = extractJsonObject(message)
  if (fromText?.error && typeof fromText.error === 'object') return fromText.error
  for (const node of errorChain(error)) {
    if (!node || typeof node !== 'object') continue
    const body = node.body ?? node.response?.body ?? node.responseBody
    const parsed = typeof body === 'string' ? extractJsonObject(body) : body
    if (parsed?.error && typeof parsed.error === 'object') return parsed.error
  }
  return null
}

function headerValue(carrier: any, name: string): string | undefined {
  if (!carrier) return undefined
  if (typeof carrier.get === 'function') {
    const value = carrier.get(name)
    return typeof value === 'string' ? value : undefined
  }
  if (typeof carrier === 'object') {
    for (const key of Object.keys(carrier)) {
      if (key.toLowerCase() === name) {
        const value = (carrier as any)[key]
        if (typeof value === 'string') return value
        if (typeof value === 'number') return String(value)
      }
    }
  }
  return undefined
}

function findHeader(error: unknown, name: string): string | undefined {
  for (const node of errorChain(error)) {
    if (!node || typeof node !== 'object') continue
    const value = headerValue(node.headers, name) ?? headerValue(node.response?.headers, name)
    if (value !== undefined) return value
  }
  return undefined
}

/** `Retry-After` is either delta-seconds or an HTTP-date. Both become wall-clock ms. */
function parseRetryAfterMs(value: string | undefined): number | undefined {
  if (!value) return undefined
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(value)
  if (Number.isFinite(at)) {
    const delta = at - Date.now()
    return delta > 0 ? delta : 0
  }
  return undefined
}

function retryAfterFromText(message: string): number | undefined {
  const match = message.match(/(?:retry|try)\s+(?:again\s+)?(?:after|in)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)?/i)
  if (!match) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount < 0) return undefined
  const unit = (match[2] || 's').toLowerCase()
  if (unit.startsWith('ms') || unit.startsWith('milli')) return Math.round(amount)
  if (unit.startsWith('m')) return Math.round(amount * 60_000)
  return Math.round(amount * 1000)
}

/** Provider reset stamps are epoch SECONDS; the envelope wants epoch MILLISECONDS. */
function epochSecondsToMs(value: unknown): number | undefined {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return Math.round(seconds * 1000)
}

interface ErrorFacts {
  raw: string
  /** Lowercased message + cause chain + serialized body. The heuristic haystack. */
  haystack: string
  status?: number
  errorType?: string
  /** `error.type` from a provider JSON body ONLY — what the legacy prose prints. */
  bodyErrorType?: string
  providerMessage?: string
  /** Epoch SECONDS, as providers report it (kept for `FormattedProviderError`). */
  resetAtSeconds?: number
  resetAtMs?: number
  retryAfterMs?: number
  name?: string
}

function collectErrorFacts(error: unknown): ErrorFacts {
  const raw = rawErrorMessage(error)
  const chain = errorChain(error)
  const haystack = chain.map(nodeMessage).join(' \n ').toLowerCase()
  const providerError = extractProviderErrorBody(error, raw)

  const bodyErrorType = typeof providerError?.type === 'string' ? providerError.type : undefined
  let errorType: string | undefined = bodyErrorType
  if (!errorType) {
    for (const node of chain) {
      if (node && typeof node === 'object' && typeof node.errorType === 'string') {
        errorType = node.errorType
        break
      }
    }
  }
  if (!errorType) {
    for (const node of chain) {
      if (node && typeof node === 'object' && typeof node.code === 'string') {
        errorType = node.code
        break
      }
    }
  }

  const resetAtSeconds =
    (typeof providerError?.resets_at === 'number' ? providerError.resets_at : undefined) ??
    (typeof providerError?.reset_at === 'number' ? providerError.reset_at : undefined)

  const headerReset = Number(findHeader(error, 'x-ratelimit-reset'))
  const resetAtMs =
    epochSecondsToMs(resetAtSeconds) ?? (Number.isFinite(headerReset) ? epochSecondsToMs(headerReset) : undefined)

  const retryAfterMs = parseRetryAfterMs(findHeader(error, 'retry-after')) ?? retryAfterFromText(raw)

  let name: string | undefined
  for (const node of chain) {
    if (node && typeof node === 'object' && typeof node.name === 'string' && node.name) {
      name = node.name
      break
    }
  }

  return {
    raw,
    haystack,
    status: extractStatus(error),
    errorType,
    bodyErrorType,
    providerMessage: typeof providerError?.message === 'string' ? providerError.message : undefined,
    resetAtSeconds,
    resetAtMs,
    retryAfterMs,
    name,
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Wording detectors
// ──────────────────────────────────────────────────────────────────────────────

const CONNECTIVITY_KEYWORDS = [
  'fetch failed',
  'econnrefused',
  'enotfound',
  'etimedout',
  'eai_again',
  'socket hang up',
  'network error',
  'certificate',
  'econnreset',
  'network request failed',
  'getaddrinfo',
  // Losing the network MID-BODY (switching Wi-Fi, sleep/wake, VPN flap) does not look
  // like a failed connect — the request already succeeded and the socket dies underneath
  // the response. These are the shapes that produces, and without them a Wi-Fi switch
  // fell through every branch to `internal_error` ("Something went wrong on my side").
  'terminated',
  'other side closed',
  'premature close',
  'und_err_socket',
  'err_network_changed',
  'network changed',
  'connection closed',
  'connection reset',
  'econnaborted',
  'epipe',
  'enetunreach',
  'enetdown',
  'ehostunreach',
]

function hasConnectivityKeyword(haystack: string): boolean {
  return CONNECTIVITY_KEYWORDS.some(keyword => haystack.includes(keyword))
}

function hasTimeoutWording(haystack: string): boolean {
  return (
    haystack.includes('timed out') ||
    haystack.includes('timeout') ||
    haystack.includes('etimedout') ||
    haystack.includes('deadline exceeded')
  )
}

function hasQuotaWording(haystack: string): boolean {
  return (
    haystack.includes('quota') ||
    haystack.includes('credit') ||
    haystack.includes('billing') ||
    haystack.includes('payment required') ||
    haystack.includes('usage limit') ||
    haystack.includes('usage_limit') ||
    haystack.includes('limit reached') ||
    haystack.includes('exceeded your current') ||
    haystack.includes('insufficient_quota') ||
    haystack.includes('insufficient funds')
  )
}

function hasFreeTierWording(haystack: string): boolean {
  return (
    haystack.includes('free tier') ||
    haystack.includes('free_tier') ||
    haystack.includes('free generation') ||
    haystack.includes('free_generation') ||
    haystack.includes('free message') ||
    haystack.includes('trial')
  )
}

function hasContextLengthWording(haystack: string): boolean {
  return (
    haystack.includes('context length') ||
    haystack.includes('context_length') ||
    haystack.includes('context window') ||
    haystack.includes('maximum context') ||
    haystack.includes('too many tokens') ||
    haystack.includes('prompt is too long') ||
    haystack.includes('reduce the length of the messages') ||
    haystack.includes('string too long') ||
    haystack.includes('input is too long')
  )
}

function hasModelWording(haystack: string): boolean {
  if (!haystack.includes('model')) return false
  return (
    haystack.includes('not found') ||
    haystack.includes('does not exist') ||
    haystack.includes('not exist') ||
    haystack.includes('unknown model') ||
    haystack.includes('invalid model') ||
    haystack.includes('unsupported model') ||
    haystack.includes('no such model') ||
    haystack.includes('model_not_found')
  )
}

function hasContentFilterWording(haystack: string): boolean {
  return (
    haystack.includes('content filter') ||
    haystack.includes('content_filter') ||
    haystack.includes('content policy') ||
    haystack.includes('content_policy') ||
    haystack.includes('safety') ||
    haystack.includes('moderation') ||
    haystack.includes('flagged') ||
    haystack.includes('responsible ai') ||
    haystack.includes('guardrail') ||
    haystack.includes('violates') ||
    haystack.includes('prohibited content')
  )
}

function hasAuthWording(haystack: string): boolean {
  return (
    haystack.includes('unauthorized') ||
    haystack.includes('invalid api key') ||
    haystack.includes('invalid token') ||
    haystack.includes('token expired') ||
    haystack.includes('session has expired') ||
    haystack.includes('session expired') ||
    haystack.includes('authentication') ||
    haystack.includes('not authenticated')
  )
}

function hasMissingCredentialWording(haystack: string): boolean {
  return (
    haystack.includes('no api key') ||
    haystack.includes('missing api key') ||
    haystack.includes('api key is missing') ||
    haystack.includes('api key not configured') ||
    haystack.includes('no credentials') ||
    haystack.includes('credentials missing') ||
    haystack.includes('missing credentials')
  )
}

// ──────────────────────────────────────────────────────────────────────────────
// Provider shape
// ──────────────────────────────────────────────────────────────────────────────

function normalizeProvider(provider: string | undefined): string {
  return (provider || '').trim().toLowerCase().replace(/[\s_()./-]+/g, '')
}

function isOpenAiProvider(provider: string): boolean {
  const normalized = normalizeProvider(provider)
  return normalized === 'openai' || normalized === 'openaichatgpt' || normalized === 'chatgpt'
}

/**
 * Providers whose credential is the USER'S own (OAuth token, API key, local server)
 * rather than the app's Railway session. A 401 on these means "reconnect this
 * provider", not "your app session expired".
 */
function isByokOrLocalProvider(provider: string | undefined): boolean {
  const normalized = normalizeProvider(provider)
  return (
    normalized === 'openai' ||
    normalized === 'openaichatgpt' ||
    normalized === 'chatgpt' ||
    normalized === 'lmstudio' ||
    normalized === 'zai' ||
    normalized === 'zaiglm' ||
    normalized === 'glm' ||
    normalized === 'bedrock' ||
    normalized === 'awsbedrock' ||
    normalized === 'amazonbedrock' ||
    normalized === 'anthropic'
  )
}

/** The transient-error status/keyword set, shared by the formatter and the retry classifier. */
function matchesTransientPattern(status: number | undefined, lowerMessage: string): boolean {
  return Boolean(
    status === 429 ||
      status === 408 ||
      (typeof status === 'number' && status >= 500) ||
      lowerMessage.includes('overloaded') ||
      lowerMessage.includes('usage_limit_reached') ||
      lowerMessage.includes('usage limit') ||
      lowerMessage.includes('too many requests') ||
      lowerMessage.includes('timed out') ||
      // Connectivity: without these an offline machine matched nothing at all and
      // the run died with no retry and no user-visible error.
      hasConnectivityKeyword(lowerMessage)
  )
}

/**
 * Provider-agnostic transient-error classifier for in-loop retry. Uses the SAME
 * status/keyword set the formatter uses for retryExhausted, but WITHOUT the
 * OpenAI-only gate — subagents also run on zai/bedrock/openrouter, and a 429/5xx/
 * overloaded/timeout/offline on any of them is worth one more attempt after a backoff.
 */
export function isTransientProviderError(error: unknown): boolean {
  const facts = collectErrorFacts(error)
  return matchesTransientPattern(facts.status, facts.haystack)
}

// ──────────────────────────────────────────────────────────────────────────────
// classifyChatError
// ──────────────────────────────────────────────────────────────────────────────

function authCode(provider: string | undefined, haystack: string): ChatErrorCode {
  if (hasMissingCredentialWording(haystack)) return 'credentials_missing'
  return isByokOrLocalProvider(provider) ? 'provider_signin_required' : 'session_expired'
}

function quotaCode(haystack: string): ChatErrorCode {
  return hasFreeTierWording(haystack) ? 'free_tier_exhausted' : 'provider_quota_exceeded'
}

/** (b) Recognised typed error classes. Matched by shape/name — importing the
 *  declaring modules here would make the dependency graph circular. */
function codeFromTypedError(error: unknown, facts: ErrorFacts, context: ChatErrorClassificationContext): ChatErrorCode | undefined {
  const name = facts.name
  if (name === 'AbortError') return 'cancelled'
  if (name === 'TimeoutError') return context.phase === 'tool' ? 'tool_timeout' : 'provider_timeout'
  if (name === 'RailwayAppAuthError') return 'session_expired'
  if (name === 'ProviderEmptyResponseError') return 'provider_empty_response'
  if (facts.errorType === 'reauth_required') return 'session_expired'
  if (error instanceof RangeError && hasContextLengthWording(facts.haystack)) return 'context_length_exceeded'
  return undefined
}

/** (c) HTTP status. Wording refines a status but never outranks it. */
function codeFromStatus(status: number | undefined, facts: ErrorFacts, context: ChatErrorClassificationContext): ChatErrorCode | undefined {
  if (typeof status !== 'number') return undefined
  const haystack = facts.haystack
  const provider = context.provider

  if (status === 400) {
    if (hasContextLengthWording(haystack)) return 'context_length_exceeded'
    if (hasContentFilterWording(haystack)) return 'content_filtered'
    if (hasModelWording(haystack)) return 'model_not_found'
    return 'bad_request'
  }
  if (status === 401) return authCode(provider, haystack)
  if (status === 402) return hasFreeTierWording(haystack) ? 'free_tier_exhausted' : 'subscription_inactive'
  if (status === 403) {
    if (hasQuotaWording(haystack) || hasFreeTierWording(haystack)) return quotaCode(haystack)
    if (hasContentFilterWording(haystack)) return 'content_filtered'
    return authCode(provider, haystack)
  }
  if (status === 404) return hasModelWording(haystack) || haystack.includes('model') ? 'model_not_found' : 'bad_request'
  if (status === 408) return context.phase === 'tool' ? 'tool_timeout' : 'provider_timeout'
  if (status === 413) return hasContextLengthWording(haystack) ? 'context_length_exceeded' : 'bad_request'
  if (status === 422) return hasContextLengthWording(haystack) ? 'context_length_exceeded' : 'bad_request'
  if (status === 429) {
    // Real billing exhaustion also arrives as 429; anything else is a rate limit
    // that will clear on its own (and carries Retry-After / resets_at).
    if (hasFreeTierWording(haystack)) return 'free_tier_exhausted'
    if (
      haystack.includes('insufficient_quota') ||
      haystack.includes('out of credit') ||
      haystack.includes('billing') ||
      haystack.includes('exceeded your current')
    ) {
      return 'provider_quota_exceeded'
    }
    return 'rate_limited'
  }
  if (status >= 500) {
    if (status === 504 || status === 524) return 'provider_timeout'
    return 'provider_unavailable'
  }
  if (status >= 400) return 'bad_request'
  return undefined
}

/** (d) Provider `errorType` strings, from the JSON body or an error class field. */
function codeFromErrorType(errorType: string | undefined, facts: ErrorFacts, context: ChatErrorClassificationContext): ChatErrorCode | undefined {
  if (!errorType) return undefined
  const type = errorType.trim().toLowerCase()
  switch (type) {
    case 'reauth_required':
    case 'session_expired':
      return 'session_expired'
    case 'invalid_api_key':
    case 'authentication_error':
    case 'unauthorized':
      return authCode(context.provider, facts.haystack)
    case 'insufficient_quota':
    case 'billing_error':
    case 'credit_exhausted':
      return 'provider_quota_exceeded'
    case 'free_tier_exhausted':
    case 'free_generations_exhausted':
      return 'free_tier_exhausted'
    case 'subscription_inactive':
    case 'payment_required':
      return 'subscription_inactive'
    case 'usage_limit_reached':
    case 'rate_limit_error':
    case 'rate_limit_exceeded':
    case 'too_many_requests':
    case 'throttlingexception':
      return 'rate_limited'
    case 'context_length_exceeded':
    case 'string_above_max_length':
      return 'context_length_exceeded'
    case 'model_not_found':
    case 'validationexception':
      return type === 'model_not_found' || hasModelWording(facts.haystack) ? 'model_not_found' : 'bad_request'
    case 'content_filter':
    case 'content_policy_violation':
    case 'invalid_prompt':
      return 'content_filtered'
    case 'overloaded_error':
    case 'service_unavailable':
    case 'serviceunavailableexception':
    case 'modelnotreadyexception':
      return 'provider_unavailable'
    case 'timeout':
    case 'timeout_error':
      return context.phase === 'tool' ? 'tool_timeout' : 'provider_timeout'
    case 'econnrefused':
    case 'enotfound':
    case 'eai_again':
    case 'econnreset':
      return 'provider_unavailable'
    case 'etimedout':
      return context.phase === 'tool' ? 'tool_timeout' : 'provider_timeout'
    case 'invalid_request_error':
      if (hasContextLengthWording(facts.haystack)) return 'context_length_exceeded'
      if (hasModelWording(facts.haystack)) return 'model_not_found'
      return 'bad_request'
    default:
      return undefined
  }
}

/** (e) Message-text heuristics — the last resort before the phase fallback. */
function codeFromMessage(facts: ErrorFacts, context: ChatErrorClassificationContext): ChatErrorCode | undefined {
  const haystack = facts.haystack
  if (!haystack.trim()) return undefined

  if (haystack.includes('aborted') || haystack.includes('cancelled') || haystack.includes('canceled')) return 'cancelled'

  // TRANSPORT EVIDENCE BEATS PROSE. This sits above the quota/auth/model checks on
  // purpose. Those match loose substrings — `hasQuotaWording` fires on a bare 'credit',
  // which appears in URLs (`/api/v1/credits`) and in relayed provider bodies. A dropped
  // connection carrying any such text was therefore reported as "This provider reports
  // that you're out of credit or quota", sending the user to check their billing after
  // switching Wi-Fi. An errno or a transport phrase is structural evidence about the
  // connection itself; a word inside a message is not. A genuine 429/402 quota error
  // arrives with a STATUS, which `codeFromStatus` already resolved before we get here.
  if (hasConnectivityKeyword(haystack) && !hasTimeoutWording(haystack)) return 'provider_unavailable'

  if (hasContextLengthWording(haystack)) return 'context_length_exceeded'
  if (hasContentFilterWording(haystack)) return 'content_filtered'
  if (hasMissingCredentialWording(haystack)) return 'credentials_missing'
  if (hasFreeTierWording(haystack) && hasQuotaWording(haystack)) return 'free_tier_exhausted'
  if (haystack.includes('too many requests') || haystack.includes('rate limit')) return 'rate_limited'
  if (hasQuotaWording(haystack)) return quotaCode(haystack)
  if (hasAuthWording(haystack)) return authCode(context.provider, haystack)
  if (hasModelWording(haystack)) return 'model_not_found'
  // `ETIMEDOUT` is a timeout first and a connectivity code second, so it is tested
  // before the connectivity list it also appears in.
  if (hasTimeoutWording(haystack)) return context.phase === 'tool' ? 'tool_timeout' : 'provider_timeout'
  if (hasConnectivityKeyword(haystack)) return 'provider_unavailable'
  if (haystack.includes('overloaded') || haystack.includes('service unavailable')) return 'provider_unavailable'
  if (haystack.includes('empty response')) return 'provider_empty_response'
  return undefined
}

/** (f) Fallback. `internal_error` unless the phase makes a more honest code obvious. */
function fallbackCode(phase: ChatErrorPhase | undefined): ChatErrorCode {
  switch (phase) {
    case 'tool':
      return 'tool_failed'
    case 'hook':
      return 'hook_failed'
    case 'compaction':
      return 'compaction_failed'
    default:
      return 'internal_error'
  }
}

/** `code` on an override object would fight the code being built; drop it. */
function withoutCode(overrides: Partial<ChatErrorEnvelope> | undefined): Partial<Omit<ChatErrorEnvelope, 'code'>> {
  if (!overrides) return {}
  const copy: Record<string, unknown> = { ...overrides }
  delete copy.code
  return copy as Partial<Omit<ChatErrorEnvelope, 'code'>>
}

/**
 * Classify ANY thrown value into a complete envelope. Never returns null and has
 * no provider gate — every provider can surface a user-visible error.
 *
 * Precedence: attached code -> typed error class -> HTTP status -> provider
 * errorType -> message heuristics -> phase fallback.
 */
export function classifyChatError(error: unknown, context: ChatErrorClassificationContext = {}): ChatErrorEnvelope {
  const facts = collectErrorFacts(error)
  const base: Partial<Omit<ChatErrorEnvelope, 'code'>> = {
    detail: truncate(facts.raw),
  }
  if (context.provider) base.provider = context.provider
  if (typeof facts.status === 'number') base.status = facts.status
  if (typeof facts.retryAfterMs === 'number') base.retryAfterMs = facts.retryAfterMs
  if (typeof facts.resetAtMs === 'number') base.resetAt = facts.resetAtMs

  const attached = getAttachedChatErrorCode(error)
  if (attached) {
    return buildChatErrorEnvelope(attached, { ...base, ...withoutCode(getAttachedChatErrorOverrides(error)) })
  }

  const code =
    codeFromTypedError(error, facts, context) ??
    codeFromStatus(facts.status, facts, context) ??
    codeFromErrorType(facts.errorType, facts, context) ??
    codeFromMessage(facts, context) ??
    fallbackCode(context.phase)

  return buildChatErrorEnvelope(code, base)
}

// ──────────────────────────────────────────────────────────────────────────────
// Legacy OpenAI prose
// ──────────────────────────────────────────────────────────────────────────────

function formatResetAt(resetAt: unknown): string | null {
  const epochSeconds = typeof resetAt === 'number' ? resetAt : typeof resetAt === 'string' ? Number(resetAt) : NaN
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return null

  try {
    return new Date(epochSeconds * 1000).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    })
  } catch {
    return new Date(epochSeconds * 1000).toISOString()
  }
}

/**
 * The pre-envelope assistant-bubble text, kept verbatim for OpenAI ChatGPT because
 * it is the one error surface shipped today. The OpenAI + retry-exhausted gate stays
 * HERE, scoped to this prose only — `classifyChatError` has no such gate.
 */
export function formatProviderErrorForAssistant(error: unknown, context: { provider: string; modelName?: string }): FormattedProviderError | null {
  const provider = context.provider || 'provider'
  const facts = collectErrorFacts(error)
  const originalMessage = facts.raw
  const status = facts.status
  // Body-only: the legacy bubble prints this verbatim, so a syscall code like
  // ECONNREFUSED must not leak into an "Error type:" line it never carried before.
  const errorType = facts.bodyErrorType
  const providerMessage = facts.providerMessage
  const resetAt = facts.resetAtSeconds
  const lower = originalMessage.toLowerCase()
  const retryExhausted = matchesTransientPattern(status, facts.haystack)

  if (!retryExhausted || !isOpenAiProvider(provider)) {
    return null
  }

  const providerLabel = 'OpenAI ChatGPT'
  const modelSuffix = context.modelName ? ` (${context.modelName})` : ''
  const details = providerMessage || originalMessage
  const resetText = formatResetAt(resetAt)

  let reason = truncate(details)
  if (errorType === 'usage_limit_reached') {
    reason = providerMessage || 'The usage limit has been reached.'
  } else if (lower.includes('overloaded')) {
    reason = 'OpenAI servers are currently overloaded. Please try again later.'
  } else if (status === 429) {
    reason = providerMessage || 'The provider returned Too Many Requests.'
  }

  const lines = [
    `I could not complete the ${providerLabel}${modelSuffix} response after retrying the provider request.`,
    '',
    `Reason: ${reason}`,
  ]

  if (typeof status === 'number') lines.push(`HTTP status: ${status}`)
  if (errorType) lines.push(`Error type: ${errorType}`)
  if (resetText) lines.push(`Reset time: ${resetText}`)
  lines.push('', 'Please try again after the provider recovers or your usage limit resets.')

  return {
    message: lines.join('\n'),
    provider,
    status,
    errorType,
    resetAt,
    retryExhausted: true,
    originalMessage,
    envelope: classifyChatError(error, { provider, modelName: context.modelName, phase: 'provider' }),
  }
}
