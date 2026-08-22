import { randomBytes, randomUUID } from 'crypto'
import { toCodexRequestParts, buildCodexRequestDiagnostics } from './codexRequestItems.js'
import { parseCodexSseResponse } from './codexSse.js'
import { openStreamingWithPreFirstByteRetry } from '../streamResilience.js'
import { parseCodexWebSocketResponse } from './codexWebsocket.js'
import { attachPartialOutput } from '../openRouterProvider.js'
import type { ProviderPartialOutput } from '../openRouterProvider.js'
import type { CodexGenerateInput, CodexGenerateResult, CodexProviderOptions, CodexResponsesTransport } from './types.js'
import { CODEX_BASE_URL, CODEX_ORIGINATOR } from './types.js'

function isCodexDevLoggingEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.YGG_CODEX_DEV_LOGS || '')
}

function previewForCodexLog(value: unknown, maxLength = 1200): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  if (!raw) return ''
  return raw.length > maxLength ? `${raw.slice(0, maxLength)}...<truncated:${raw.length}>` : raw
}

const RESPONSES_LITE_VERSION = '0.144.0'
const RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite'
const RESPONSES_LITE_WIRE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_RESPONSES_LITE_SESSIONS = 500
const liteWireSessionIds = new Map<string, string>()

function usesResponsesLite(model: string): boolean {
  return /^gpt-5\.6-(sol|terra|luna)$/i.test(model)
}

function createUuidV7(): string {
  const bytes = randomBytes(16)
  const timestamp = BigInt(Date.now())
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number((timestamp >> BigInt((5 - index) * 8)) & 0xffn)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export class CodexResponsesProvider {
  private readonly options: CodexProviderOptions
  private readonly fetchImpl: typeof fetch

  constructor(options: CodexProviderOptions) {
    this.options = options
    this.fetchImpl = options.fetch || fetch
  }

  async generate(input: CodexGenerateInput): Promise<CodexGenerateResult> {
    input.signal?.throwIfAborted()
    const parts = toCodexRequestParts(input.messages, input.tools)
    const requestId = input.runId || input.sessionId || `ygg-codex-${Date.now()}`
    const responsesLite = usesResponsesLite(input.model)
    const wireSessionId = responsesLite ? this.resolveLiteWireSessionId(input.sessionId || requestId) : input.sessionId
    const promptCacheKey = wireSessionId || requestId
    const instructions = parts.instructions?.trim() || 'You are ChatGPT.'
    const liteInput = responsesLite
      ? [
          { type: 'additional_tools', role: 'developer', tools: parts.tools },
          { type: 'message', role: 'developer', content: [{ type: 'input_text', text: instructions }] },
          ...parts.input,
        ]
      : parts.input
    const body: Record<string, any> = {
      model: input.model,
      ...(responsesLite ? {} : { instructions }),
      input: liteInput,
      ...(responsesLite
        ? { tool_choice: 'auto', parallel_tool_calls: false }
        : parts.tools.length
          ? { tools: parts.tools, tool_choice: 'auto', parallel_tool_calls: true }
          : {}),
      reasoning: {
        effort: this.options.reasoningEffort || 'medium',
        ...(this.options.reasoningSummary === null ? {} : { summary: this.options.reasoningSummary || 'auto' }),
        ...(responsesLite ? { context: 'all_turns' } : {}),
      },
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content', 'web_search_call.action.sources'],
      prompt_cache_key: promptCacheKey,
      client_metadata: {
        'x-codex-installation-id': promptCacheKey,
      },
    }
    const headers = new Headers({
      accept: 'text/event-stream',
      'content-type': 'application/json',
      authorization: `Bearer ${this.options.auth.accessToken}`,
      originator: this.options.originator || CODEX_ORIGINATOR,
      'user-agent': this.options.userAgent || 'Qubit/0.1 Codex',
    })
    if (this.options.auth.accountId) headers.set('ChatGPT-Account-ID', this.options.auth.accountId)
    if (responsesLite) {
      headers.set(RESPONSES_LITE_HEADER, 'true')
      headers.set('version', RESPONSES_LITE_VERSION)
      headers.set('x-session-affinity', promptCacheKey)
    }
    if (wireSessionId) {
      headers.set('session-id', wireSessionId)
      headers.set('thread-id', wireSessionId)
    }
    headers.set('x-client-request-id', requestId)

    const diagnostics = buildCodexRequestDiagnostics({
      promptCacheKey,
      requestId,
      instructions,
      input: parts.input,
      tools: parts.tools,
    })
    if (isCodexDevLoggingEnabled()) {
      console.info('[Codex Request Shape]', {
        ...diagnostics,
        model: input.model,
        transport: this.resolveTransport(),
        instructionsLength: instructions.length,
        usedFallbackInstructions: !parts.instructions?.trim(),
        responsesLite,
        responsesLiteVersion: responsesLite ? RESPONSES_LITE_VERSION : null,
        hasInstructionsInBody: typeof body.instructions === 'string' && body.instructions.length > 0,
        inputItems: parts.input.length,
        tools: parts.tools.length,
      })
    }

    const transport = this.resolveTransport()
    const parsed =
      transport === 'websocket'
        ? await this.generateWebSocket(input, headers, body)
        : transport === 'auto'
          ? await this.generateAuto(input, headers, body)
          : await this.generateHttp(input, headers, body)

    return { ...parsed, requestBody: body, requestHeaders: headers, requestId, promptCacheKey, diagnostics }
  }

  private async generateAuto(input: CodexGenerateInput, headers: Headers, body: Record<string, any>) {
    try {
      return await this.generateWebSocket(input, headers, body)
    } catch (error) {
      if (isCodexDevLoggingEnabled()) {
        console.warn('[Codex Transport] websocket failed; falling back to http', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
      // R1(a): the websocket attempt may already have streamed text to the user
      // before it failed. If the fallback never gets going — an abort here, or an
      // HTTP failure that produced nothing of its own — that text is the only
      // output this turn has, so carry it onto whatever error we end up throwing.
      // `attachPartialOutput` never overwrites, so a fallback that DID stream keeps
      // its own, fresher partial.
      const websocketPartial = (error as any)?.partialOutput as ProviderPartialOutput | undefined
      try {
        input.signal?.throwIfAborted()
        return await this.generateHttp(input, headers, body)
      } catch (fallbackError) {
        throw attachPartialOutput(fallbackError, websocketPartial)
      }
    }
  }

  private async generateHttp(input: CodexGenerateInput, headers: Headers, body: Record<string, any>) {
    input.signal?.throwIfAborted()
    const url = this.responsesUrl()
    const streamOpen = await openStreamingWithPreFirstByteRetry({
      endpoint: new URL(url).pathname,
      streamId: input.runId || input.sessionId || null,
      parentSignal: input.signal,
      policy: { maxRetries: 3 },
      openAttempt: signal =>
        this.fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        }),
    })
    if (!streamOpen.response.ok) {
      let errorBody = ''
      try {
        errorBody = await streamOpen.response.text()
      } catch (error) {
        errorBody = `Failed to read error body: ${error instanceof Error ? error.message : String(error)}`
      }
      console.warn('[Codex HTTP] non-OK response', {
        status: streamOpen.response.status,
        statusText: streamOpen.response.statusText,
        requestId: input.runId || input.sessionId || null,
        model: input.model,
        instructionsLength: typeof body.instructions === 'string' ? body.instructions.length : 0,
        inputItems: Array.isArray(body.input) ? body.input.length : 0,
        bodyPreview: previewForCodexLog(errorBody),
      })
      throw new Error(`ChatGPT backend request failed (${streamOpen.response.status}): ${errorBody || streamOpen.response.statusText}`)
    }
    return await parseCodexSseResponse(streamOpen.response, {
      emit: input.emit,
      modelName: input.model,
      reader: streamOpen.reader,
      firstRead: streamOpen.firstRead,
      allowCommentaryFallbackText: input.allowCommentaryFallbackText,
    })
  }

  private async generateWebSocket(input: CodexGenerateInput, headers: Headers, body: Record<string, any>) {
    return await parseCodexWebSocketResponse({
      baseURL: this.baseURL(),
      headers,
      body,
      ...(input.signal ? { signal: input.signal } : {}),
      emit: input.emit,
      modelName: input.model,
      allowCommentaryFallbackText: input.allowCommentaryFallbackText,
    })
  }

  private resolveLiteWireSessionId(sourceSessionId: string): string {
    if (RESPONSES_LITE_WIRE_SESSION_ID.test(sourceSessionId)) return sourceSessionId
    const existing = liteWireSessionIds.get(sourceSessionId)
    if (existing) return existing
    if (liteWireSessionIds.size >= MAX_RESPONSES_LITE_SESSIONS) {
      const oldestSessionId = liteWireSessionIds.keys().next().value
      if (oldestSessionId) liteWireSessionIds.delete(oldestSessionId)
    }
    const wireSessionId = createUuidV7()
    liteWireSessionIds.set(sourceSessionId, wireSessionId)
    return wireSessionId
  }

  private resolveTransport(): CodexResponsesTransport {
    const value = (this.options.transport || process.env.YGG_CODEX_TRANSPORT || 'http').toLowerCase()
    return value === 'http' || value === 'websocket' || value === 'auto' ? value : 'http'
  }

  private baseURL(): string {
    return (this.options.baseURL || CODEX_BASE_URL).replace(/\/$/, '')
  }

  private responsesUrl(): string {
    return `${this.baseURL()}/responses`
  }
}

export function codexRunId(input: CodexGenerateInput): string {
  return input.runId || input.sessionId || randomUUID()
}
