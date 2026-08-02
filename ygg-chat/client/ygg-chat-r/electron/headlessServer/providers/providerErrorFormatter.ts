export interface FormattedProviderError {
  message: string
  provider: string
  status?: number
  errorType?: string
  resetAt?: number
  retryExhausted: boolean
  originalMessage: string
}

const MAX_DETAIL_LENGTH = 1200

function rawErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncate(value: string, maxLength = MAX_DETAIL_LENGTH): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value
}

function extractStatus(message: string): number | undefined {
  const match = message.match(/request failed\s*\((\d{3})\)|\bHTTP\s+(\d{3})\b|\bstatus\s*[:=]\s*(\d{3})\b/i)
  const value = match?.[1] || match?.[2] || match?.[3]
  if (!value) return undefined
  const status = Number(value)
  return Number.isFinite(status) ? status : undefined
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

function isOpenAiProvider(provider: string): boolean {
  const normalized = provider.trim().toLowerCase().replace(/\s+/g, '')
  return normalized === 'openai' || normalized === 'openaichatgpt' || normalized === 'chatgpt'
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
      lowerMessage.includes('timed out')
  )
}

/**
 * Provider-agnostic transient-error classifier for in-loop retry. Uses the SAME
 * status/keyword set the formatter uses for retryExhausted, but WITHOUT the
 * OpenAI-only gate — subagents also run on zai/bedrock/openrouter, and a 429/5xx/
 * overloaded/timeout on any of them is worth one more attempt after a backoff.
 */
export function isTransientProviderError(error: unknown): boolean {
  const message = rawErrorMessage(error)
  return matchesTransientPattern(extractStatus(message), message.toLowerCase())
}

export function formatProviderErrorForAssistant(error: unknown, context: { provider: string; modelName?: string }): FormattedProviderError | null {
  const provider = context.provider || 'provider'
  const originalMessage = rawErrorMessage(error)
  const status = extractStatus(originalMessage)
  const parsedBody = extractJsonObject(originalMessage)
  const providerError = parsedBody?.error && typeof parsedBody.error === 'object' ? parsedBody.error : null
  const errorType = typeof providerError?.type === 'string' ? providerError.type : undefined
  const providerMessage = typeof providerError?.message === 'string' ? providerError.message : undefined
  const resetAt = typeof providerError?.resets_at === 'number' ? providerError.resets_at : undefined
  const lower = originalMessage.toLowerCase()
  const retryExhausted = matchesTransientPattern(status, lower)

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
  }
}
