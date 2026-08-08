import type { HeadlessStreamEvent } from '../../../../../shared/headlessApi.js'
import type { OpenAIContextUsage } from '../../../../../shared/contextUsage.js'
import { normalizeAuthorizationToken, syncOpenRouterTokenFromElectronSession } from './electronAppAuth.js'
import type { AppAuthTokenManager } from '../services/appAuthTokenManager.js'
import { buildToolNameMap, sanitizeToolResultContentForModel } from './toolResultSanitizer.js'
import { openStreamingWithPreFirstByteRetry } from './streamResilience.js'
import type { ProviderTokenStore } from './tokenStore.js'

export interface ProviderToolDefinition {
  name: string
  description?: string
  inputSchema?: Record<string, any>
}

export interface ProviderRailwayTurnInput {
  conversationId: string
  parentId?: string | null
  operation?: 'send' | 'repeat' | 'branch' | 'edit-branch'
  conversationContext?: string | null
  projectContext?: string | null
  think?: boolean
  temperature?: number
  attachmentsBase64?: Array<{ dataUrl: string; name?: string; type?: string; size?: number }> | null
  retrigger?: boolean
  executionMode?: 'server' | 'client'
  isBranch?: boolean
  storageMode?: 'local' | 'cloud'
  isElectron?: boolean
  imageConfig?: any
  reasoningConfig?: any
  serviceTier?: 'priority'
  openaiHostedTools?: any
  promptCacheRetention?: 'in_memory' | '24h'
  runId?: string | null
  previousResponseId?: string | null
  allowCommentaryFallbackText?: boolean
  /**
   * When true, Railway's free-tier meter frames are relayed up as SSE events
   * (free_generations_update / generation_limit_reached) instead of being dropped.
   * Set ONLY by the server-owned cloud chat path (ChatOrchestrator, gateway.chat +
   * openrouter route). Subagents/tests/flag-off leave it unset => drop parity.
   */
  relayFreeTierEvents?: boolean
}

export interface ProviderGenerateInput {
  modelName: string
  systemPrompt?: string | null
  history: any[]
  userContent: string
  userId?: string | null
  accessToken?: string | null
  accountId?: string | null
  tools?: ProviderToolDefinition[]
  think?: boolean
  temperature?: number
  railwayTurn?: ProviderRailwayTurnInput | null
  signal?: AbortSignal
}

export interface ProviderToolCall {
  id: string
  name: string
  arguments: any
  status?: 'pending' | 'executing' | 'complete'
  result?: string
}

export interface ProviderGenerateOutput {
  content: string
  reasoning?: string
  toolCalls?: ProviderToolCall[]
  contentBlocks?: any[]
  contextUsage?: OpenAIContextUsage
  raw?: any
}

export type ProviderStreamEventHandler = (event: HeadlessStreamEvent) => void

export interface HeadlessProvider {
  name: string
  generate(input: ProviderGenerateInput, emit?: ProviderStreamEventHandler): Promise<ProviderGenerateOutput>
}

interface OpenRouterProviderDeps {
  tokenStore?: ProviderTokenStore
  /** Shared app-session owner used by every Railway-backed server request. */
  appAuth?: AppAuthTokenManager
  remoteApiBase?: string
}

export class RailwayAppAuthError extends Error {
  readonly status = 401
  readonly errorType = 'reauth_required'

  constructor() {
    super('Your Yggdrasil session has expired. Please sign in again to continue using cloud models.')
    this.name = 'RailwayAppAuthError'
  }
}

function parseJson<T>(value: any, fallback: T): T {
  if (value == null) return fallback
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
  return value as T
}

function parseContentBlocks(value: any): any[] {
  const parsed = parseJson<any[]>(value, [])
  return Array.isArray(parsed) ? parsed : []
}

function parseToolCalls(value: any): any[] {
  const parsed = parseJson<any[]>(value, [])
  return Array.isArray(parsed) ? parsed : []
}

function parseArtifacts(value: any): any[] {
  const parsed = parseJson<any[]>(value, [])
  return Array.isArray(parsed) ? parsed : []
}

function parseChildrenIds(value: any): string[] {
  const parsed = parseJson<any[]>(value, [])
  return Array.isArray(parsed) ? parsed.map(item => String(item)) : []
}

function asText(value: any): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (typeof item === 'string') return item
        if (item?.type === 'text' && typeof item?.text === 'string') return item.text
        if (typeof item?.content === 'string') return item.content
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (value == null) return ''
  return String(value)
}

function sanitizeContentBlocksForModel(blocks: any, toolCalls?: any): any[] {
  const parsed = parseContentBlocks(blocks)
  if (parsed.length === 0) return parsed

  const toolNameById = new Map<string, string>()
  for (const tc of parseToolCalls(toolCalls)) {
    const id = typeof tc?.id === 'string' ? tc.id : ''
    const name = typeof tc?.name === 'string' ? tc.name : typeof tc?.function?.name === 'string' ? tc.function.name : ''
    if (id && name) {
      toolNameById.set(id, name)
    }
  }

  return parsed.map(block => {
    if (block?.type !== 'tool_result') return block
    const toolName = typeof block.tool_use_id === 'string' ? toolNameById.get(block.tool_use_id) : null
    const sanitizedContent = sanitizeToolResultContentForModel(block.content, toolName ?? null)
    if (sanitizedContent === block.content) return block
    return { ...block, content: sanitizedContent }
  })
}

function normalizeHistoryMessage(message: any, toolNameById: Map<string, string>): any {
  const contentBlocks = sanitizeContentBlocksForModel(message?.content_blocks, message?.tool_calls)
  const toolCalls = parseToolCalls(message?.tool_calls)
  const artifacts = parseArtifacts(message?.artifacts)

  const normalized: any = {
    id: message?.id ? String(message.id) : undefined,
    conversation_id:
      message?.conversation_id != null ? String(message.conversation_id) : message?.conversationId != null ? String(message.conversationId) : undefined,
    parent_id:
      message?.parent_id != null ? String(message.parent_id) : message?.parentId != null ? String(message.parentId) : null,
    children_ids: parseChildrenIds(message?.children_ids ?? message?.childrenIds),
    role: typeof message?.role === 'string' ? message.role : 'assistant',
    content: asText(message?.content),
    content_plain_text:
      typeof message?.content_plain_text === 'string'
        ? message.content_plain_text
        : typeof message?.plain_text_content === 'string'
          ? message.plain_text_content
          : asText(message?.content),
    thinking_block: typeof message?.thinking_block === 'string' ? message.thinking_block : '',
    tool_calls: toolCalls,
    tool_call_id:
      message?.tool_call_id != null ? String(message.tool_call_id) : message?.toolCallId != null ? String(message.toolCallId) : null,
    content_blocks: contentBlocks,
    created_at: typeof message?.created_at === 'string' ? message.created_at : new Date().toISOString(),
    model_name:
      typeof message?.model_name === 'string'
        ? message.model_name
        : typeof message?.modelName === 'string'
          ? message.modelName
          : '',
    partial: Boolean(message?.partial),
    artifacts,
  }

  const messageReasoningDetails = message?.reasoningDetails ?? message?.reasoning_details
  if (Array.isArray(messageReasoningDetails) && messageReasoningDetails.length > 0) {
    normalized.reasoningDetails = messageReasoningDetails
  }

  if (normalized.role === 'tool' && normalized.tool_call_id) {
    const sanitizedContent = sanitizeToolResultContentForModel(normalized.content, toolNameById.get(normalized.tool_call_id) || null)
    normalized.content = typeof sanitizedContent === 'string' ? sanitizedContent : JSON.stringify(sanitizedContent ?? null)
    normalized.content_plain_text = normalized.content
  }

  return normalized
}

function normalizeHistory(history: any[]): any[] {
  const toolNameById = buildToolNameMap(history || [])
  return (history || []).filter(Boolean).map(message => normalizeHistoryMessage(message, toolNameById))
}

function toServerToolFormat(tools?: ProviderToolDefinition[]): any[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined

  const mapped = tools
    .filter(tool => tool?.name)
    .map(tool => ({
      name: tool.name,
      enabled: true,
      description: tool.description || '',
      inputSchema: tool.inputSchema || { type: 'object', properties: {} },
    }))

  return mapped.length > 0 ? mapped : undefined
}

function extractReasoningFromBlocks(blocks: any[]): string {
  return blocks
    .filter(block => block?.type === 'thinking' && typeof block?.content === 'string')
    .map(block => block.content)
    .join('')
}

function extractTextFromBlocks(blocks: any[]): string {
  return blocks
    .filter(block => block?.type === 'text' && typeof block?.content === 'string')
    .map(block => block.content)
    .join('')
}

function extractToolCallsFromBlocks(blocks: any[]): ProviderToolCall[] {
  return blocks
    .filter(block => block?.type === 'tool_use' && typeof block?.id === 'string' && typeof block?.name === 'string')
    .map(block => ({
      id: block.id,
      name: block.name,
      arguments: block.input ?? {},
      status: 'pending' as const,
    }))
}

function parseResponseToolCalls(message: any): ProviderToolCall[] {
  const toolCalls = parseToolCalls(message?.tool_calls)
  const normalized: ProviderToolCall[] = []

  for (const call of toolCalls) {
    const id = typeof call?.id === 'string' ? call.id : ''
    const name = typeof call?.name === 'string' ? call.name : typeof call?.function?.name === 'string' ? call.function.name : ''
    const argsRaw = call?.arguments ?? call?.function?.arguments
    if (!id || !name) continue

    let args: any = argsRaw ?? {}
    if (typeof argsRaw === 'string') {
      try {
        args = JSON.parse(argsRaw)
      } catch {
        args = argsRaw
      }
    }

    normalized.push({
      id,
      name,
      arguments: args,
      status: 'pending',
    })
  }

  return normalized
}

function buildOutputFromMessage(message: any, fallback?: { content?: string; reasoning?: string; contentBlocks?: any[]; toolCalls?: ProviderToolCall[] }): ProviderGenerateOutput {
  const contentBlocks = parseContentBlocks(message?.content_blocks)
  const content = asText(message?.content) || extractTextFromBlocks(contentBlocks) || fallback?.content || ''
  const reasoning = extractReasoningFromBlocks(contentBlocks) || (typeof message?.thinking_block === 'string' ? message.thinking_block : '') || fallback?.reasoning || ''
  const toolCalls = parseResponseToolCalls(message)
  const effectiveToolCalls = toolCalls.length > 0 ? toolCalls : (contentBlocks.length > 0 ? extractToolCallsFromBlocks(contentBlocks) : fallback?.toolCalls || [])
  const effectiveContentBlocks = contentBlocks.length > 0 ? contentBlocks : (fallback?.contentBlocks || [])

  return {
    content,
    reasoning: reasoning || undefined,
    toolCalls: effectiveToolCalls,
    contentBlocks: effectiveContentBlocks,
    raw: message,
  }
}

function getRemoteApiBase(explicit?: string): string {
  const raw = explicit || process.env.YGG_API_URL || process.env.VITE_API_URL || 'https://webdrasil-production.up.railway.app/api'
  return raw.replace(/\/+$/, '')
}

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('The operation was aborted.', 'AbortError')
  }
  const error = new Error('The operation was aborted.')
  ;(error as any).name = 'AbortError'
  return error
}

export class OpenRouterProvider implements HeadlessProvider {
  readonly name = 'openrouter'
  private readonly tokenStore?: ProviderTokenStore
  private readonly appAuth?: AppAuthTokenManager
  private readonly remoteApiBase?: string

  constructor(deps: OpenRouterProviderDeps = {}) {
    this.tokenStore = deps.tokenStore
    this.appAuth = deps.appAuth
    this.remoteApiBase = deps.remoteApiBase
  }

  private async resolveAuth(input: ProviderGenerateInput, forceRefresh = false): Promise<string> {
    const directToken = normalizeAuthorizationToken(input.accessToken)
    if (directToken) return directToken

    // OpenRouter is Railway-backed app auth, not an independent provider OAuth flow.
    // Use the process-wide single-flight owner so proactive refresh and 401 recovery
    // cannot race the CRUD/cloud-proxy paths.
    if (this.appAuth) {
      const { accessToken } = await this.appAuth.getFreshAppToken(forceRefresh ? { forceRefresh: true } : undefined)
      const appToken = normalizeAuthorizationToken(accessToken)
      if (appToken) return appToken
      // Once the shared app-token owner is wired, do not fall back to a stale
      // provider-token mirror or env secret. Railway app auth is authoritative.
      throw new RailwayAppAuthError()
    }

    // Compatibility path for isolated providers/tests that predate the shared
    // headless-server auth graph.
    if (this.tokenStore) {
      await syncOpenRouterTokenFromElectronSession(this.tokenStore)
      const stored = input.userId ? this.tokenStore.get('openrouter', input.userId) : this.tokenStore.getLatest('openrouter')
      const storedToken = normalizeAuthorizationToken(stored?.accessToken)
      if (storedToken) return storedToken
    }

    const envToken = normalizeAuthorizationToken(
      process.env.YGG_APP_ACCESS_TOKEN || process.env.YGG_ACCESS_TOKEN || process.env.SUPABASE_ACCESS_TOKEN || ''
    )
    if (envToken) return envToken

    throw new Error('Graviton app auth token missing for Railway-backed OpenRouter provider.')
  }

  async generate(input: ProviderGenerateInput, emit?: ProviderStreamEventHandler): Promise<ProviderGenerateOutput> {
    const turn = input.railwayTurn
    if (!turn?.conversationId) {
      throw new Error('Railway chat context missing for OpenRouter provider (conversationId required).')
    }

    let accessToken = await this.resolveAuth(input)
    const history = normalizeHistory(input.history || [])
    const tools = toServerToolFormat(input.tools)
    const remoteApiBase = getRemoteApiBase(this.remoteApiBase)
    const endpointPath = `/conversations/${encodeURIComponent(turn.conversationId)}/messages`
    const endpoint = `${remoteApiBase}${endpointPath}`

    const hasHistory = history.length > 0
    const body: Record<string, any> = {
      content: hasHistory ? '' : input.userContent,
      messages: history,
      modelName: input.modelName,
      parentId: turn.parentId ?? null,
      provider: 'openrouter',
      systemPrompt: input.systemPrompt ?? null,
      conversationContext: turn.conversationContext ?? null,
      projectContext: turn.projectContext ?? null,
      think: turn.think ?? false,
      executionMode: turn.executionMode ?? 'client',
      isBranch: turn.isBranch ?? false,
      storageMode: turn.storageMode ?? 'local',
      isElectron: turn.isElectron ?? true,
    }

    if (typeof turn.temperature === 'number') {
      body.temperature = turn.temperature
    }
    if (Array.isArray(turn.attachmentsBase64) && turn.attachmentsBase64.length > 0) {
      body.attachmentsBase64 = turn.attachmentsBase64
    }
    if (typeof turn.retrigger === 'boolean') {
      body.retrigger = turn.retrigger
    }
    if (turn.imageConfig !== undefined) {
      body.imageConfig = turn.imageConfig
    }
    if (turn.reasoningConfig !== undefined) {
      body.reasoningConfig = turn.reasoningConfig
    }
    if (tools?.length) {
      body.tools = tools
    }

    const openStream = (token: string) =>
      openStreamingWithPreFirstByteRetry({
        endpoint: endpointPath,
        openAttempt: signal =>
          fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
              Accept: 'text/event-stream',
            },
            body: JSON.stringify(body),
            signal,
          }),
      })

    let streamOpen = await openStream(accessToken)
    // Match RailwayClient's 401 policy: force one single-flight refresh and retry
    // once. Explicit request tokens remain caller-owned and are never refreshed here.
    if (streamOpen.response.status === 401 && this.appAuth && !input.accessToken && !input.signal?.aborted) {
      accessToken = await this.resolveAuth(input, true)
      streamOpen = await openStream(accessToken)
    }

    if (!streamOpen.response.ok) {
      const text = await streamOpen.response.text().catch(() => '')
      // Free-tier exhaustion: Railway answers the OpenRouter send with HTTP 403 and a
      // JSON body { error: 'generation_limit_reached', message?: string }. The renderer
      // parsed this to show the upgrade modal (chatActions.ts:4612-4617); relay it as an
      // SSE event so the server-owned loop drives the same modal. Gated by the cloud
      // relay flag — otherwise collapsed into the generic throw exactly as before. The
      // event is flushed to SSE before the throw unwinds the run.
      if (streamOpen.response.status === 403 && turn.relayFreeTierEvents) {
        let body: any = null
        try {
          body = JSON.parse(text)
        } catch {
          body = null
        }
        if (body?.error === 'generation_limit_reached') {
          emit?.({
            type: 'generation_limit_reached',
            message: typeof body.message === 'string' ? body.message : undefined,
          })
        }
      }
      if (streamOpen.response.status === 401 && this.appAuth && !input.accessToken) {
        throw new RailwayAppAuthError()
      }
      throw new Error(`Railway OpenRouter request failed (${streamOpen.response.status}): ${text}`)
    }

    if (!streamOpen.reader) {
      throw new Error('Railway OpenRouter request returned no readable stream body')
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let pendingRead = streamOpen.firstRead
    let streamedText = ''
    let streamedReasoning = ''
    const streamedContentBlocks: any[] = []
    const streamedToolCalls: ProviderToolCall[] = []
    let completeMessage: any = null

    while (true) {
      const readResult = pendingRead ?? (await streamOpen.reader.read())
      pendingRead = null

      const { done, value } = readResult
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue

        const payload = trimmed.slice(5).trim()
        if (!payload || payload === '[DONE]') continue

        let parsed: any = null
        try {
          parsed = JSON.parse(payload)
        } catch {
          if (payload) {
            streamedText += payload
            streamedContentBlocks.push({ type: 'text', content: payload })
            emit?.({ type: 'chunk', part: 'text', delta: payload })
          }
          continue
        }

        if (!parsed) continue
        if (parsed.type === 'error') {
          throw new Error(typeof parsed.error === 'string' ? parsed.error : 'Railway stream error')
        }
        if (parsed.type === 'aborted') {
          throw createAbortError()
        }
        if (parsed.type === 'complete' && parsed.message) {
          completeMessage = parsed.message
          continue
        }
        if (parsed.type === 'free_generations_update') {
          // Free-tier meter update streamed by Railway. Relay it (gated) so the renderer
          // decrements free_generations_remaining, matching chatActions.ts:4823-4830.
          if (turn.relayFreeTierEvents) {
            emit?.({
              type: 'free_generations_update',
              remaining: Number(parsed.remaining),
              isFreeTier: parsed.isFreeTier ?? true,
            })
          }
          continue
        }
        if (parsed.type !== 'chunk') continue

        const part = parsed.part
        if (part === 'text' && typeof parsed.delta === 'string') {
          streamedText += parsed.delta
          streamedContentBlocks.push({ type: 'text', content: parsed.delta })
          emit?.({ type: 'chunk', part: 'text', delta: parsed.delta })
          continue
        }
        if (part === 'reasoning' && typeof parsed.delta === 'string') {
          streamedReasoning += parsed.delta
          streamedContentBlocks.push({ type: 'thinking', content: parsed.delta })
          emit?.({ type: 'chunk', part: 'reasoning', delta: parsed.delta })
          continue
        }
        if (part === 'tool_call' && parsed.toolCall) {
          const toolCall = parsed.toolCall
          if (typeof toolCall?.id === 'string' && typeof toolCall?.name === 'string') {
            streamedToolCalls.push({
              id: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.arguments ?? {},
              status: 'pending',
            })
            streamedContentBlocks.push({
              type: 'tool_use',
              id: toolCall.id,
              name: toolCall.name,
              input: toolCall.arguments ?? {},
            })
          }
          continue
        }
        if (part === 'tool_result' && parsed.toolResult) {
          streamedContentBlocks.push({
            type: 'tool_result',
            tool_use_id: parsed.toolResult.tool_use_id,
            content: parsed.toolResult.content,
            is_error: Boolean(parsed.toolResult.is_error),
          })
          continue
        }
        if (part === 'image' && parsed.url) {
          streamedContentBlocks.push({
            type: 'image',
            url: parsed.url,
            mimeType: parsed.mimeType || 'image/png',
          })
          continue
        }
      }
    }

    if (completeMessage) {
      return buildOutputFromMessage(completeMessage, {
        content: streamedText,
        reasoning: streamedReasoning,
        contentBlocks: streamedContentBlocks,
        toolCalls: streamedToolCalls,
      })
    }

    return {
      content: streamedText,
      reasoning: streamedReasoning || undefined,
      toolCalls: streamedToolCalls,
      contentBlocks: streamedContentBlocks,
      raw: {
        streamed: true,
      },
    }
  }
}
