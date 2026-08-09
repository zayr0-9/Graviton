import { describe, expect, it } from 'vitest'
import {
  attachChatErrorCode,
  classifyChatError,
  extractStatus,
  formatProviderErrorForAssistant,
  getAttachedChatErrorCode,
  isTransientProviderError,
} from '../providerErrorFormatter.js'
import { CHAT_ERROR_DEFAULTS } from '../../../../../../shared/chatErrors.js'

function httpError(status: number, message = 'boom'): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}

describe('attachChatErrorCode / getAttachedChatErrorCode', () => {
  it('round-trips a code without making it enumerable', () => {
    const error = attachChatErrorCode(new Error('tool blew up'), 'tool_failed')
    expect(getAttachedChatErrorCode(error)).toBe('tool_failed')
    expect(Object.keys(error)).toHaveLength(0)
    expect(JSON.stringify({ ...error })).toBe('{}')
  })

  it('returns the same error reference so it can be thrown inline', () => {
    const error = new Error('x')
    expect(attachChatErrorCode(error, 'cancelled')).toBe(error)
  })

  it('ignores primitives and unrecognised codes', () => {
    expect(attachChatErrorCode('nope' as any, 'internal_error')).toBe('nope')
    expect(getAttachedChatErrorCode('nope')).toBeUndefined()
    expect(getAttachedChatErrorCode(null)).toBeUndefined()
    const bogus = new Error('x')
    ;(bogus as any)[Symbol.for('ygg.chat.errorCode')] = 'not_a_real_code'
    expect(getAttachedChatErrorCode(bogus)).toBeUndefined()
  })
})

describe('extractStatus', () => {
  it('prefers .status on the error object over message text', () => {
    expect(extractStatus(httpError(429, 'request failed (500)'))).toBe(429)
  })

  it('reads .statusCode', () => {
    expect(extractStatus(Object.assign(new Error('nope'), { statusCode: 403 }))).toBe(403)
  })

  it('reads AWS $metadata.httpStatusCode, which never appears in the message', () => {
    const awsError = Object.assign(new Error('ThrottlingException'), {
      name: 'ThrottlingException',
      $metadata: { httpStatusCode: 429 },
    })
    expect(extractStatus(awsError)).toBe(429)
  })

  it('reads .response.status (rejected websocket upgrade)', () => {
    const upgrade = Object.assign(new Error('Unexpected server response'), { response: { status: 401 } })
    expect(extractStatus(upgrade)).toBe(401)
  })

  it('reads a status off the cause chain', () => {
    const inner = httpError(503, 'upstream down')
    expect(extractStatus(new Error('wrapped', { cause: inner }))).toBe(503)
  })

  it('still falls back to the message regex', () => {
    expect(extractStatus(new Error('ChatGPT backend request failed (429): {}'))).toBe(429)
    expect(extractStatus(new Error('HTTP 502 bad gateway'))).toBe(502)
    expect(extractStatus(new Error('no status here'))).toBeUndefined()
  })
})

describe('classifyChatError precedence', () => {
  it('(a) an attached code beats every other signal', () => {
    const error = attachChatErrorCode(httpError(429, 'too many requests'), 'tool_denied')
    const envelope = classifyChatError(error, { provider: 'openaichatgpt' })
    expect(envelope.code).toBe('tool_denied')
    expect(envelope.status).toBe(429)
    expect(envelope.detail).toBe('too many requests')
  })

  it('(a) attached overrides are merged onto the envelope', () => {
    const error = attachChatErrorCode(new Error('raw'), 'rate_limited', { retryAfterMs: 5000, userMessage: 'Hold on.' })
    const envelope = classifyChatError(error)
    expect(envelope.code).toBe('rate_limited')
    expect(envelope.retryAfterMs).toBe(5000)
    expect(envelope.userMessage).toBe('Hold on.')
  })

  it('(b) a recognised typed error beats the status', () => {
    const aborted = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError', status: 500 })
    expect(classifyChatError(aborted).code).toBe('cancelled')

    const railway = Object.assign(new Error('Your Yggdrasil session has expired.'), {
      name: 'RailwayAppAuthError',
      status: 401,
      errorType: 'reauth_required',
    })
    expect(classifyChatError(railway, { provider: 'openrouter' }).code).toBe('session_expired')

    const empty = Object.assign(new Error('Provider returned an empty response after retry'), {
      name: 'ProviderEmptyResponseError',
    })
    expect(classifyChatError(empty).code).toBe('provider_empty_response')
  })

  it('(c) status beats provider errorType', () => {
    // errorType alone would say provider_unavailable; the 401 status wins.
    const error = Object.assign(new Error('nope'), { status: 401, errorType: 'service_unavailable' })
    expect(classifyChatError(error, { provider: 'openrouter' }).code).toBe('session_expired')
  })

  it('(d) errorType beats message heuristics when there is no status', () => {
    const error = Object.assign(new Error('something happened'), { errorType: 'context_length_exceeded' })
    expect(classifyChatError(error).code).toBe('context_length_exceeded')
  })

  it('(e) message heuristics are used when nothing else is known', () => {
    expect(classifyChatError(new Error('Provider turn 7/400 timed out after 180000ms')).code).toBe('provider_timeout')
  })

  it('(f) falls back to internal_error, or to the phase when that is more honest', () => {
    expect(classifyChatError(new Error('who knows')).code).toBe('internal_error')
    expect(classifyChatError(new Error('who knows'), { phase: 'tool' }).code).toBe('tool_failed')
    expect(classifyChatError(new Error('who knows'), { phase: 'hook' }).code).toBe('hook_failed')
    expect(classifyChatError(new Error('who knows'), { phase: 'compaction' }).code).toBe('compaction_failed')
  })

  it('never returns null and always carries complete prose', () => {
    for (const value of [undefined, null, 'plain string', 42, new Error(''), {}]) {
      const envelope = classifyChatError(value)
      expect(typeof envelope.code).toBe('string')
      expect(envelope.userMessage.length).toBeGreaterThan(0)
      expect(envelope.recoverability).toBeTruthy()
    }
  })

  it('has NO provider gate — every provider classifies', () => {
    for (const provider of ['openaichatgpt', 'openrouter', 'lmstudio', 'zai', 'bedrock']) {
      const envelope = classifyChatError(httpError(503, 'upstream down'), { provider })
      expect(envelope.code).toBe('provider_unavailable')
      expect(envelope.provider).toBe(provider)
    }
  })
})

describe('classifyChatError status mapping', () => {
  it('401 -> session_expired for the app session, provider_signin_required for BYOK/local', () => {
    expect(classifyChatError(httpError(401), { provider: 'openrouter' }).code).toBe('session_expired')
    expect(classifyChatError(httpError(401)).code).toBe('session_expired')
    expect(classifyChatError(httpError(401), { provider: 'openaichatgpt' }).code).toBe('provider_signin_required')
    expect(classifyChatError(httpError(401), { provider: 'lmstudio' }).code).toBe('provider_signin_required')
    expect(classifyChatError(httpError(401), { provider: 'zai' }).code).toBe('provider_signin_required')
    expect(classifyChatError(httpError(401), { provider: 'bedrock' }).code).toBe('provider_signin_required')
  })

  it('401 with missing-key wording -> credentials_missing', () => {
    expect(classifyChatError(httpError(401, 'No API key configured for this provider'), { provider: 'zai' }).code).toBe(
      'credentials_missing'
    )
  })

  it('402 -> subscription_inactive', () => {
    expect(classifyChatError(httpError(402, 'Payment required')).code).toBe('subscription_inactive')
  })

  it('403 + quota wording -> free_tier_exhausted or provider_quota_exceeded', () => {
    expect(classifyChatError(httpError(403, 'You have used all of your free generations')).code).toBe(
      'free_tier_exhausted'
    )
    expect(classifyChatError(httpError(403, 'Your credit balance is too low')).code).toBe('provider_quota_exceeded')
  })

  it('404 + model wording -> model_not_found', () => {
    expect(classifyChatError(httpError(404, 'The model `gpt-9` does not exist')).code).toBe('model_not_found')
    expect(classifyChatError(httpError(404, 'Not Found')).code).toBe('bad_request')
  })

  it('408 and 504 -> provider_timeout', () => {
    expect(classifyChatError(httpError(408, 'Request Timeout')).code).toBe('provider_timeout')
    expect(classifyChatError(httpError(504, 'Gateway Timeout')).code).toBe('provider_timeout')
  })

  it('429 -> rate_limited, with Retry-After parsed into retryAfterMs', () => {
    const error = Object.assign(new Error('Too Many Requests'), {
      status: 429,
      headers: { 'Retry-After': '30' },
    })
    const envelope = classifyChatError(error, { provider: 'openaichatgpt' })
    expect(envelope.code).toBe('rate_limited')
    expect(envelope.retryAfterMs).toBe(30_000)
    expect(envelope.status).toBe(429)
  })

  it('429 -> rate_limited, with resets_at parsed into resetAt as epoch ms', () => {
    const error = new Error(
      'ChatGPT backend request failed (429): {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_at":1782168563}}'
    )
    const envelope = classifyChatError(error, { provider: 'openaichatgpt' })
    expect(envelope.code).toBe('rate_limited')
    expect(envelope.resetAt).toBe(1782168563 * 1000)
  })

  it('429 with billing wording -> provider_quota_exceeded', () => {
    expect(
      classifyChatError(httpError(429, 'You exceeded your current quota, please check your plan and billing details'))
        .code
    ).toBe('provider_quota_exceeded')
  })

  it('400 -> bad_request, but context-length wording -> context_length_exceeded', () => {
    expect(classifyChatError(httpError(400, 'Invalid value for parameter tools[0]')).code).toBe('bad_request')
    expect(
      classifyChatError(httpError(400, "This model's maximum context length is 128000 tokens, however you requested 200000"))
        .code
    ).toBe('context_length_exceeded')
  })

  it('5xx -> provider_unavailable', () => {
    for (const status of [500, 502, 503, 529]) {
      expect(classifyChatError(httpError(status, 'server error')).code).toBe('provider_unavailable')
    }
  })

  it('content filter wording -> content_filtered', () => {
    expect(classifyChatError(httpError(400, 'Your request was rejected by the content filter')).code).toBe(
      'content_filtered'
    )
    expect(classifyChatError(new Error('Response blocked by safety guardrail')).code).toBe('content_filtered')
  })
})

describe('classifyChatError connectivity', () => {
  const keywords = [
    'fetch failed',
    'connect ECONNREFUSED 127.0.0.1:1234',
    'getaddrinfo ENOTFOUND api.openai.com',
    'request to https://x failed, reason: EAI_AGAIN',
    'socket hang up',
    'network error',
    'unable to verify the first certificate',
  ]

  it.each(keywords)('%s -> provider_unavailable', keyword => {
    expect(classifyChatError(new Error(keyword), { provider: 'lmstudio' }).code).toBe('provider_unavailable')
  })

  it('ETIMEDOUT is a timeout first', () => {
    expect(classifyChatError(new Error('connect ETIMEDOUT 1.2.3.4:443')).code).toBe('provider_timeout')
  })

  it('finds connectivity codes hidden under `fetch failed` cause chains', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1234'), { code: 'ECONNREFUSED' })
    const error = new TypeError('fetch failed', { cause })
    expect(classifyChatError(error, { provider: 'lmstudio' }).code).toBe('provider_unavailable')
  })
})

describe('classifyChatError envelope hygiene', () => {
  it('puts raw text in detail and never in userMessage', () => {
    const raw = 'Provider turn 7/400 timed out after 180000ms (lineage 8b3f-...)'
    const envelope = classifyChatError(new Error(raw), { provider: 'zai' })
    expect(envelope.detail).toBe(raw)
    expect(envelope.userMessage).toBe(CHAT_ERROR_DEFAULTS.provider_timeout.userMessage)
    expect(envelope.userMessage).not.toContain('Provider turn')
    expect(envelope.userMessage).not.toContain('180000')
  })

  it('truncates a very long detail', () => {
    const envelope = classifyChatError(new Error('x'.repeat(5000)))
    expect(envelope.detail!.length).toBeLessThanOrEqual(1201)
    expect(envelope.detail!.endsWith('…')).toBe(true)
  })

  it('records provider and status when known', () => {
    const envelope = classifyChatError(httpError(503, 'down'), { provider: 'bedrock' })
    expect(envelope.provider).toBe('bedrock')
    expect(envelope.status).toBe(503)
  })
})

describe('isTransientProviderError', () => {
  it('keeps matching the original status/keyword set', () => {
    expect(isTransientProviderError(new Error('ChatGPT backend request failed (429): {}'))).toBe(true)
    expect(isTransientProviderError(httpError(503, 'down'))).toBe(true)
    expect(isTransientProviderError(new Error('Model is overloaded'))).toBe(true)
    expect(isTransientProviderError(new Error('Provider turn 1/3 timed out after 1000ms'))).toBe(true)
    expect(isTransientProviderError(new Error('Invalid tool schema'))).toBe(false)
  })

  it('now matches connectivity failures, which previously matched nothing', () => {
    expect(isTransientProviderError(new Error('fetch failed'))).toBe(true)
    expect(isTransientProviderError(new Error('connect ECONNREFUSED 127.0.0.1:1234'))).toBe(true)
    expect(isTransientProviderError(new Error('socket hang up'))).toBe(true)
  })

  it('sees a status carried only on the error object', () => {
    expect(isTransientProviderError(Object.assign(new Error('ThrottlingException'), { $metadata: { httpStatusCode: 429 } }))).toBe(
      true
    )
  })
})

describe('formatProviderErrorForAssistant (unchanged legacy bubble)', () => {
  const usageLimitError = new Error(
    'ChatGPT backend request failed (429): {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_at":1782168563}}'
  )

  it('still produces the OpenAI prose it produces today', () => {
    const formatted = formatProviderErrorForAssistant(usageLimitError, {
      provider: 'openaichatgpt',
      modelName: 'gpt-5.4-mini',
    })
    expect(formatted).not.toBeNull()
    expect(formatted!.message).toContain(
      'I could not complete the OpenAI ChatGPT (gpt-5.4-mini) response after retrying'
    )
    expect(formatted!.message).toContain('The usage limit has been reached')
    expect(formatted!.message).toContain('HTTP status: 429')
    expect(formatted!.message).toContain('Error type: usage_limit_reached')
    expect(formatted!.status).toBe(429)
    expect(formatted!.errorType).toBe('usage_limit_reached')
    expect(formatted!.resetAt).toBe(1782168563)
    expect(formatted!.retryExhausted).toBe(true)
    expect(formatted!.originalMessage).toBe(usageLimitError.message)
  })

  it('now also carries the classified envelope', () => {
    const formatted = formatProviderErrorForAssistant(usageLimitError, { provider: 'openaichatgpt' })
    expect(formatted!.envelope?.code).toBe('rate_limited')
    expect(formatted!.envelope?.detail).toBe(usageLimitError.message)
  })

  it('keeps its OpenAI-only + retry-exhausted gate', () => {
    expect(formatProviderErrorForAssistant(usageLimitError, { provider: 'openrouter' })).toBeNull()
    expect(formatProviderErrorForAssistant(new Error('Invalid tool schema'), { provider: 'openaichatgpt' })).toBeNull()
  })

  it('does not leak a syscall code into the "Error type:" line', () => {
    const formatted = formatProviderErrorForAssistant(
      Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }),
      { provider: 'openai' }
    )
    expect(formatted).not.toBeNull()
    expect(formatted!.message).not.toContain('Error type:')
    expect(formatted!.envelope?.code).toBe('provider_unavailable')
  })
})

/**
 * REGRESSION: switching Wi-Fi mid-stream was reported to the user as
 * "This provider reports that you're out of credit or quota."
 *
 * Two independent causes, both fixed here:
 *  1. `hasQuotaWording` matches the bare substring 'credit', which appears in URLs
 *     (`/api/v1/credits`) and relayed provider bodies — and it was tested BEFORE the
 *     connectivity keywords. Transport evidence now wins.
 *  2. A network loss MID-BODY does not look like a failed connect. `terminated`,
 *     `other side closed`, `ERR_NETWORK_CHANGED` and friends matched nothing at all
 *     and fell through to `internal_error`.
 */
describe('classifyChatError: network loss mid-stream', () => {
  const netError = (message: string, code?: string, causeMessage?: string) => {
    const error = new Error(message) as Error & { code?: string; cause?: unknown }
    if (causeMessage) {
      const cause = new Error(causeMessage) as Error & { code?: string }
      if (code) cause.code = code
      error.cause = cause
    } else if (code) {
      error.code = code
    }
    return error
  }

  const connectivityCases: Array<[string, Error]> = [
    ['undici mid-body close', netError('terminated', 'UND_ERR_SOCKET', 'other side closed')],
    ['chromium network change', netError('net::ERR_NETWORK_CHANGED')],
    ['premature close', netError('Premature close', 'ERR_STREAM_PREMATURE_CLOSE')],
    ['socket hang up', netError('socket hang up', 'ECONNRESET')],
    ['dns re-resolve after switch', netError('fetch failed', 'EAI_AGAIN', 'getaddrinfo EAI_AGAIN api.example.com')],
    ['network unreachable', netError('connect ENETUNREACH 1.2.3.4:443', 'ENETUNREACH')],
  ]

  for (const [label, error] of connectivityCases) {
    it(`${label} is a connectivity failure, not an internal one`, () => {
      expect(classifyChatError(error, { provider: 'openrouter', phase: 'provider' }).code).toBe('provider_unavailable')
    })
  }

  it('a dropped connection whose text mentions credit is NOT reported as a quota problem', () => {
    const envelope = classifyChatError(new Error('socket hang up while checking credit balance'), {
      provider: 'openrouter',
      phase: 'provider',
    })
    expect(envelope.code).toBe('provider_unavailable')
    expect(envelope.userMessage).not.toMatch(/credit|quota/i)
  })

  it('a dropped request to a /credits URL is NOT reported as a quota problem', () => {
    expect(
      classifyChatError(new Error('fetch failed: https://openrouter.ai/api/v1/credits'), { phase: 'provider' }).code
    ).toBe('provider_unavailable')
  })

  it('a REAL quota error still classifies as quota (status is authoritative)', () => {
    const quota = Object.assign(new Error('You exceeded your current quota'), { status: 429 })
    expect(classifyChatError(quota, { provider: 'openrouter', phase: 'provider' }).code).toBe('provider_quota_exceeded')
  })

  it('a real quota error with no status still classifies from wording when transport is fine', () => {
    expect(classifyChatError(new Error('insufficient_quota: add credits to continue'), { phase: 'provider' }).code).toBe(
      'provider_quota_exceeded'
    )
  })

  it('a timeout stays a timeout even though ETIMEDOUT is also a connectivity keyword', () => {
    expect(classifyChatError(new Error('connect ETIMEDOUT'), { phase: 'provider' }).code).toBe('provider_timeout')
  })

  it('every connectivity case is transient, so the loop will retry it', () => {
    for (const [, error] of connectivityCases) expect(isTransientProviderError(error)).toBe(true)
  })
})
