import type { Express } from 'express'
import { normalizeAuthorizationToken, syncOpenRouterTokenFromElectronSession } from '../providers/electronAppAuth.js'
import { LmStudioProvider } from '../providers/lmStudioProvider.js'
import { HyperRouterBedrockProvider } from '../providers/hyperRouterBedrockProvider.js'
import { HyperRouterZaiProvider } from '../providers/hyperRouterZaiProvider.js'
import { OpenAiChatgptProvider, normalizeOpenAIChatGPTModel } from '../providers/openaiChatgptProvider.js'
import type { ProviderGenerateOutput, ProviderToolDefinition } from '../providers/openRouterProvider.js'
import type { ProviderTokenStore } from '../providers/tokenStore.js'
import { normalizeProviderRoute, type ProviderRoute } from '../services/providerRouter.js'

interface RegisterEphemeralGenerateRoutesDeps {
  tokenStore: ProviderTokenStore
}

type InferenceToolDefinition = ProviderToolDefinition

type EphemeralGenerateInput = {
  provider: ProviderRoute
  modelName: string
  content: string
  userId: string | null
  history: any[]
  systemPrompt: string | null
  tools?: InferenceToolDefinition[]
  accessToken: string | null
  accountId: string | null
  maxTokens?: number
  temperature?: number
  responseFormat?: any
  think?: boolean
  allowCommentaryFallbackText?: boolean
}

function normalizeTools(raw: any): InferenceToolDefinition[] | undefined {
  if (!Array.isArray(raw)) return undefined

  const tools = raw
    .map((tool: any): InferenceToolDefinition | null => {
      if (!tool || typeof tool !== 'object') return null
      const name = typeof tool.name === 'string' ? tool.name.trim() : ''
      if (!name) return null
      return {
        name,
        description: typeof tool.description === 'string' ? tool.description : undefined,
        inputSchema:
          tool.inputSchema && typeof tool.inputSchema === 'object'
            ? tool.inputSchema
            : { type: 'object', properties: {} },
      }
    })
    .filter((tool): tool is InferenceToolDefinition => Boolean(tool))

  return tools.length > 0 ? tools : undefined
}

function asText(value: any): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (typeof item === 'string') return item
        if (typeof item?.content === 'string') return item.content
        if (typeof item?.text === 'string') return item.text
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (value == null) return ''
  return String(value)
}

function inferEphemeralProvider(body: any): ProviderRoute {
  if (typeof body?.provider === 'string' && body.provider.trim()) {
    return normalizeProviderRoute(body.provider)
  }

  const rawModel =
    typeof body?.modelName === 'string' && body.modelName.trim()
      ? body.modelName.trim()
      : typeof body?.model === 'string' && body.model.trim()
        ? body.model.trim()
        : ''

  if (rawModel.includes('/')) {
    const prefix = rawModel.split('/')[0]?.trim().toLowerCase() || ''
    if (prefix === 'openai' || prefix === 'openaichatgpt') return 'openaichatgpt'
    if (prefix === 'lmstudio') return 'lmstudio'
    if (prefix === 'zai' || prefix === 'glm' || prefix === 'z.ai') return 'zai'
    if (prefix === 'bedrock' || prefix === 'aws' || prefix === 'aws-bedrock' || prefix === 'amazon-bedrock') return 'bedrock'
    return 'openrouter'
  }

  return 'openaichatgpt'
}

function normalizeModelName(rawModelName: any, provider: ProviderRoute): string {
  const fallback = provider === 'lmstudio' ? 'local-model' : provider === 'openrouter' ? 'openai/gpt-4o-mini' : provider === 'zai' ? 'glm-5.1' : provider === 'bedrock' ? process.env.AWS_BEDROCK_MODEL || 'anthropic.claude-3-5-sonnet-20241022-v2:0' : 'gpt-5.6-sol'
  const raw = typeof rawModelName === 'string' && rawModelName.trim() ? rawModelName.trim() : fallback

  if (provider === 'openaichatgpt') {
    return normalizeOpenAIChatGPTModel(raw) || fallback
  }

  if (provider === 'lmstudio') {
    return raw.replace(/^lmstudio\//i, '') || fallback
  }

  if (provider === 'zai') {
    return raw.replace(/^(zai|glm|z\.ai)\//i, '') || fallback
  }

  if (provider === 'bedrock') {
    return raw.replace(/^(bedrock|aws|aws-bedrock|amazon-bedrock)\//i, '') || fallback
  }

  return raw
}

function buildEphemeralGenerateInput(body: any): EphemeralGenerateInput {
  const provider = inferEphemeralProvider(body)
  const content = typeof body?.content === 'string' ? body.content : typeof body?.prompt === 'string' ? body.prompt : ''
  const history = Array.isArray(body?.history) ? body.history : Array.isArray(body?.messages) ? body.messages : []

  return {
    provider,
    modelName: normalizeModelName(body?.modelName ?? body?.model, provider),
    content,
    userId: typeof body?.userId === 'string' && body.userId.trim() ? body.userId.trim() : null,
    history,
    systemPrompt: typeof body?.systemPrompt === 'string' ? body.systemPrompt : null,
    tools: normalizeTools(body?.tools),
    accessToken: typeof body?.accessToken === 'string' && body.accessToken.trim() ? body.accessToken.trim() : null,
    accountId: typeof body?.accountId === 'string' && body.accountId.trim() ? body.accountId.trim() : null,
    maxTokens: typeof body?.maxTokens === 'number' ? body.maxTokens : undefined,
    temperature: typeof body?.temperature === 'number' ? body.temperature : undefined,
    responseFormat: body?.response_format ?? body?.responseFormat,
    think: Boolean(body?.think),
    allowCommentaryFallbackText: body?.allowCommentaryFallbackText !== false,
  }
}

function buildSuccessPayload(provider: ProviderRoute, modelName: string, upstream: string, generated: ProviderGenerateOutput) {
  return {
    success: true,
    provider,
    upstream,
    modelName,
    message: { role: 'assistant', content: generated.content },
    reasoning: generated.reasoning || null,
    toolCalls: generated.toolCalls || [],
    contentBlocks: generated.contentBlocks || [],
    raw: generated.raw || null,
  }
}

async function runLocalProviderGenerate(
  providerName: 'openaichatgpt' | 'lmstudio' | 'zai' | 'bedrock',
  provider: OpenAiChatgptProvider | LmStudioProvider | HyperRouterZaiProvider | HyperRouterBedrockProvider,
  body: any
) {
  const parsed = buildEphemeralGenerateInput(body)
  const hasUsableHistory = Array.isArray(parsed.history)
    ? parsed.history.some(message => {
        if (!message || typeof message !== 'object') return false
        if (asText((message as any).content).trim()) return true
        if (typeof (message as any).tool_call_id === 'string' && (message as any).tool_call_id.trim()) return true
        return Array.isArray((message as any).tool_calls) && (message as any).tool_calls.length > 0
      })
    : false

  if (!parsed.content.trim() && !hasUsableHistory) {
    return { error: 'content or messages/history is required', status: 400 as const }
  }

  const generated = await provider.generate({
    modelName: parsed.modelName,
    userContent: parsed.content,
    history: parsed.history,
    userId: parsed.userId,
    accessToken: parsed.accessToken,
    accountId: parsed.accountId,
    systemPrompt: parsed.systemPrompt,
    tools: parsed.tools,
    think: parsed.think,
    temperature: parsed.temperature,
    railwayTurn:
      providerName === 'openaichatgpt'
        ? {
            conversationId:
              typeof body?.conversationId === 'string' && body.conversationId.trim()
                ? body.conversationId.trim()
                : `ephemeral:${Date.now()}`,
            allowCommentaryFallbackText: parsed.allowCommentaryFallbackText,
          }
        : undefined,
  })

  return {
    status: 200 as const,
    payload: buildSuccessPayload(providerName, parsed.modelName, providerName === 'lmstudio' || providerName === 'zai' || providerName === 'bedrock' ? 'chat_completions' : 'responses', generated),
  }
}

function getRemoteApiBase(): string {
  return (process.env.YGG_API_URL || process.env.VITE_API_URL || 'https://webdrasil-production.up.railway.app/api').replace(/\/+$/, '')
}

async function resolveRemoteAppAccessToken(
  tokenStore: ProviderTokenStore,
  userId?: string | null,
  accessToken?: string | null
): Promise<string> {
  const directToken = normalizeAuthorizationToken(accessToken)
  if (directToken) return directToken

  // MUST be awaited: this refreshes an expiring Electron session and upserts the
  // result into the token store, and the very next line reads that store. Left
  // unawaited it could not affect the read it precedes, so the refresh was dead
  // weight — and its rejection landed as an unhandled promise long after the
  // response, which under vitest surfaced inside whichever test was running next.
  //
  // Still best-effort: a sync failure must not fail the request, because the stored
  // and env-var fallbacks below can both still satisfy it.
  await syncOpenRouterTokenFromElectronSession(tokenStore).catch(() => {})
  const stored = userId ? tokenStore.get('openrouter', userId) : tokenStore.getLatest('openrouter')
  const storedToken = normalizeAuthorizationToken(stored?.accessToken)
  if (storedToken) return storedToken

  const envToken = normalizeAuthorizationToken(
    process.env.YGG_APP_ACCESS_TOKEN || process.env.YGG_ACCESS_TOKEN || process.env.SUPABASE_ACCESS_TOKEN || ''
  )
  if (envToken) return envToken

  throw new Error('Graviton app auth token missing for OpenRouter-backed ephemeral generation.')
}

function normalizeHistoryMessage(message: any): { role: string; content: string } | null {
  if (!message || typeof message !== 'object') return null
  const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : ''
  if (!role) return null
  const content = asText(message.content).trim()
  if (!content) return null
  if (!['system', 'user', 'assistant', 'tool'].includes(role)) return null
  return { role, content }
}

function buildRemoteEphemeralMessages(input: EphemeralGenerateInput): Array<{ role: string; content: string }> {
  const messages = (input.history || []).map(normalizeHistoryMessage).filter((message): message is { role: string; content: string } => Boolean(message))

  if (input.systemPrompt?.trim() && !messages.some(message => message.role === 'system')) {
    messages.unshift({ role: 'system', content: input.systemPrompt.trim() })
  }

  if (input.content.trim()) {
    messages.push({ role: 'user', content: input.content.trim() })
  }

  return messages
}

async function runRemoteOpenRouterEphemeralGenerate(tokenStore: ProviderTokenStore, body: any) {
  const parsed = buildEphemeralGenerateInput(body)
  const messages = buildRemoteEphemeralMessages(parsed)

  if (messages.length === 0) {
    return { error: 'content is required', status: 400 as const }
  }

  const accessToken = await resolveRemoteAppAccessToken(tokenStore, parsed.userId, parsed.accessToken)
  const res = await fetch(`${getRemoteApiBase()}/generate/ephemeral`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      provider: 'openrouter',
      model: parsed.modelName,
      messages,
      maxTokens: parsed.maxTokens,
      temperature: parsed.temperature,
      response_format: parsed.responseFormat,
    }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Remote OpenRouter ephemeral request failed (${res.status}): ${text}`)
  }

  const reader = res.body?.getReader()
  if (!reader) {
    const text = await res.text().catch(() => '')
    return {
      status: 200 as const,
      payload: buildSuccessPayload('openrouter', parsed.modelName, 'remote_ephemeral', {
        content: text,
        raw: text,
      }),
    }
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''
  let reasoning = ''
  const rawEvents: any[] = []

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (!data || data === '[DONE]') continue

      try {
        const parsedEvent = JSON.parse(data)
        rawEvents.push(parsedEvent)
        if (typeof parsedEvent?.error === 'string' && parsedEvent.error) {
          throw new Error(parsedEvent.error)
        }
        if (typeof parsedEvent?.text === 'string') fullText += parsedEvent.text
        if (typeof parsedEvent?.reasoning === 'string') reasoning += parsedEvent.reasoning
      } catch (error) {
        if (error instanceof Error && error.message !== data) throw error
        fullText += data
      }
    }
  }

  return {
    status: 200 as const,
    payload: buildSuccessPayload('openrouter', parsed.modelName, 'remote_ephemeral', {
      content: fullText,
      reasoning: reasoning || undefined,
      raw: rawEvents,
    }),
  }
}

function registerDirectOpenAiGenerateHandler(app: Express, endpoint: string, openAiProvider: OpenAiChatgptProvider): void {
  app.post(endpoint, async (req, res) => {
    try {
      const result = await runLocalProviderGenerate('openaichatgpt', openAiProvider, req.body ?? {})
      if ('error' in result) {
        res.status(result.status).json({ success: false, error: result.error })
        return
      }
      res.status(result.status).json(result.payload)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: message })
    }
  })
}

function registerEphemeralChatHandler(
  app: Express,
  tokenStore: ProviderTokenStore,
  openAiProvider: OpenAiChatgptProvider,
  lmStudioProvider: LmStudioProvider,
  zaiProvider: HyperRouterZaiProvider,
  bedrockProvider: HyperRouterBedrockProvider
): void {
  app.post('/api/headless/ephemeral/chat', async (req, res) => {
    try {
      const body = req.body ?? {}
      const provider = inferEphemeralProvider(body)

      const result =
        provider === 'openrouter'
          ? await runRemoteOpenRouterEphemeralGenerate(tokenStore, body)
          : provider === 'lmstudio'
            ? await runLocalProviderGenerate('lmstudio', lmStudioProvider, body)
            : provider === 'zai'
              ? await runLocalProviderGenerate('zai', zaiProvider, body)
              : provider === 'bedrock'
                ? await runLocalProviderGenerate('bedrock', bedrockProvider, body)
                : await runLocalProviderGenerate('openaichatgpt', openAiProvider, body)

      if ('error' in result) {
        res.status(result.status).json({ success: false, error: result.error })
        return
      }

      res.status(result.status).json(result.payload)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: message })
    }
  })
}

function registerYggHookGenerateRoute(app: Express, openAiProvider: OpenAiChatgptProvider): void {
  app.post('/api/headless/ygg-hooks/generate', async (req, res) => {
    const startedAt = Date.now()
    try {
      const body = req.body ?? {}
      const provider = typeof body.provider === 'string' ? body.provider.trim().toLowerCase() : 'openai'
      const shouldLogHookGenerate = /^(1|true|yes|on)$/i.test(process.env.YGG_HOOK_DEBUG_LOGS || '')
      if (shouldLogHookGenerate) {
        console.info('[YggHookGenerate] request', {
          provider,
          modelName: typeof body.modelName === 'string' ? body.modelName : typeof body.model === 'string' ? body.model : null,
          contentLength: typeof body.content === 'string' ? body.content.length : 0,
          promptLength: typeof body.prompt === 'string' ? body.prompt.length : 0,
          systemPromptLength: typeof body.systemPrompt === 'string' ? body.systemPrompt.length : 0,
          historyLength: Array.isArray(body.history) ? body.history.length : 0,
          hasAccessToken: typeof body.accessToken === 'string' && body.accessToken.length > 0,
          hasAccountId: typeof body.accountId === 'string' && body.accountId.length > 0,
        })
      }
      if (provider && provider !== 'openai' && provider !== 'openaichatgpt') {
        res.status(400).json({ success: false, error: 'Only openai/openaichatgpt is supported for ygg hook generation.' })
        return
      }

      const result = await runLocalProviderGenerate('openaichatgpt', openAiProvider, {
        modelName: body.modelName,
        content: body.content,
        systemPrompt: body.systemPrompt,
        history: Array.isArray(body.history) ? body.history : [],
        userId: typeof body.userId === 'string' ? body.userId : null,
        accessToken: typeof body.accessToken === 'string' ? body.accessToken : null,
        accountId: typeof body.accountId === 'string' ? body.accountId : null,
      })

      if ('error' in result) {
        console.warn('[YggHookGenerate] failed', {
          elapsedMs: Date.now() - startedAt,
          status: result.status,
          error: result.error,
        })
        res.status(result.status).json({ success: false, error: result.error })
        return
      }

      if (shouldLogHookGenerate) {
        console.info('[YggHookGenerate] succeeded', {
          elapsedMs: Date.now() - startedAt,
          modelName: result.payload.modelName,
          textLength: typeof result.payload.message?.content === 'string' ? result.payload.message.content.length : 0,
        })
      }

      res.status(200).json({
        success: true,
        provider: 'openaichatgpt',
        modelName: result.payload.modelName,
        text: result.payload.message?.content || '',
        message: result.payload.message,
        raw: result.payload.raw || null,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[YggHookGenerate] error', {
        elapsedMs: Date.now() - startedAt,
        error: message,
      })
      res.status(500).json({ success: false, error: message })
    }
  })
}

export function registerEphemeralGenerateRoutes(app: Express, deps: RegisterEphemeralGenerateRoutesDeps): void {
  const openAiProvider = new OpenAiChatgptProvider({ tokenStore: deps.tokenStore })
  const lmStudioProvider = new LmStudioProvider()
  const zaiProvider = new HyperRouterZaiProvider({ tokenStore: deps.tokenStore })
  const bedrockProvider = new HyperRouterBedrockProvider({ tokenStore: deps.tokenStore })

  registerDirectOpenAiGenerateHandler(app, '/api/headless/provider/openai/responses', openAiProvider)
  registerEphemeralChatHandler(app, deps.tokenStore, openAiProvider, lmStudioProvider, zaiProvider, bedrockProvider)
  registerYggHookGenerateRoute(app, openAiProvider)
}
