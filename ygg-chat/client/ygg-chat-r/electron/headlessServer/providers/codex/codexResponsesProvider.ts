import { randomUUID } from 'crypto'
import { toCodexRequestParts, buildCodexRequestDiagnostics } from './codexRequestItems.js'
import { parseCodexSseResponse } from './codexSse.js'
import { openStreamingWithPreFirstByteRetry } from '../streamResilience.js'
import { parseCodexWebSocketResponse } from './codexWebsocket.js'
import type { CodexGenerateInput, CodexGenerateResult, CodexProviderOptions, CodexResponsesTransport } from './types.js'
import { CODEX_BASE_URL, CODEX_ORIGINATOR } from './types.js'

function isCodexDevLoggingEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.YGG_CODEX_DEV_LOGS || '')
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
    const promptCacheKey = input.sessionId || requestId
    const body: Record<string, any> = {
      model: input.model,
      ...(parts.instructions ? { instructions: parts.instructions } : {}),
      input: parts.input,
      ...(parts.tools.length ? { tools: parts.tools, tool_choice: 'auto', parallel_tool_calls: true } : {}),
      reasoning: {
        effort: this.options.reasoningEffort || 'medium',
        ...(this.options.reasoningSummary === null ? {} : { summary: this.options.reasoningSummary || 'auto' }),
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
    if (input.sessionId) {
      headers.set('session-id', input.sessionId)
      headers.set('thread-id', input.sessionId)
    }
    headers.set('x-client-request-id', requestId)

    const diagnostics = buildCodexRequestDiagnostics({
      promptCacheKey,
      requestId,
      instructions: parts.instructions,
      input: parts.input,
      tools: parts.tools,
    })
    if (isCodexDevLoggingEnabled()) console.info('[Codex Request Shape]', diagnostics)

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
    } catch {
      input.signal?.throwIfAborted()
      return await this.generateHttp(input, headers, body)
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
    return await parseCodexSseResponse(streamOpen.response, {
      emit: input.emit,
      modelName: input.model,
      reader: streamOpen.reader,
      firstRead: streamOpen.firstRead,
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
    })
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
