import type { Express } from 'express'
import { HookGenerationService, HookGenerationError } from '../services/hookGenerationService.js'
import { LmStudioProvider } from '../providers/lmStudioProvider.js'
import { HyperRouterBedrockProvider } from '../providers/hyperRouterBedrockProvider.js'
import { HyperRouterZaiProvider } from '../providers/hyperRouterZaiProvider.js'
import { DEFAULT_DEEPSEEK_MODEL, HyperRouterDeepSeekProvider } from '../providers/hyperRouterDeepSeekProvider.js'
import { DEFAULT_OPENROUTER_BYOK_MODEL, HyperRouterOpenRouterProvider } from '../providers/hyperRouterOpenRouterProvider.js'
import { OpenAiChatgptProvider, normalizeOpenAIChatGPTModel } from '../providers/openaiChatgptProvider.js'
import type { ProviderGenerateOutput, ProviderToolDefinition } from '../providers/providerTypes.js'
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
    // Any other vendor/model slug is an OpenRouter model, served with the user's own key.
    return 'openrouterbyok'
  }

  return 'openaichatgpt'
}

function normalizeModelName(rawModelName: any, provider: ProviderRoute): string {
  const fallback = provider === 'lmstudio' ? 'local-model' : provider === 'openrouterbyok' ? DEFAULT_OPENROUTER_BYOK_MODEL : provider === 'zai' ? 'glm-5.1' : provider === 'deepseek' ? process.env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL : provider === 'bedrock' ? process.env.AWS_BEDROCK_MODEL || 'anthropic.claude-3-5-sonnet-20241022-v2:0' : 'gpt-5.6-sol'
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
  providerName: 'openaichatgpt' | 'lmstudio' | 'zai' | 'deepseek' | 'bedrock' | 'openrouterbyok',
  provider: OpenAiChatgptProvider | LmStudioProvider | HyperRouterZaiProvider | HyperRouterDeepSeekProvider | HyperRouterBedrockProvider | HyperRouterOpenRouterProvider,
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
    turnContext:
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
    payload: buildSuccessPayload(providerName, parsed.modelName, providerName === 'lmstudio' || providerName === 'zai' || providerName === 'deepseek' || providerName === 'bedrock' ? 'chat_completions' : 'responses', generated),
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
  openAiProvider: OpenAiChatgptProvider,
  lmStudioProvider: LmStudioProvider,
  zaiProvider: HyperRouterZaiProvider,
  deepSeekProvider: HyperRouterDeepSeekProvider,
  bedrockProvider: HyperRouterBedrockProvider,
  openRouterByokProvider: HyperRouterOpenRouterProvider
): void {
  app.post('/api/headless/ephemeral/chat', async (req, res) => {
    try {
      const body = req.body ?? {}
      const provider = inferEphemeralProvider(body)

      const result =
        provider === 'lmstudio'
          ? await runLocalProviderGenerate('lmstudio', lmStudioProvider, body)
          : provider === 'zai'
            ? await runLocalProviderGenerate('zai', zaiProvider, body)
            : provider === 'deepseek'
              ? await runLocalProviderGenerate('deepseek', deepSeekProvider, body)
            : provider === 'bedrock'
              ? await runLocalProviderGenerate('bedrock', bedrockProvider, body)
              : provider === 'openrouterbyok'
                ? await runLocalProviderGenerate('openrouterbyok', openRouterByokProvider, body)
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

export function registerYggHookGenerateRoute(app: Express, service: HookGenerationService): void {
  app.get('/api/headless/ygg-hooks/status', async (_req, res) => {
    try { res.json(await service.availability()) }
    catch { res.status(503).json({ error: 'Hook generation settings are unavailable.' }) }
  })
  app.post('/api/headless/ygg-hooks/generate', async (req, res) => {
    const controller = new AbortController()
    const disconnect = () => { if (!res.writableEnded) controller.abort() }
    res.on('close', disconnect)
    try {
      // Saved host policy wins over legacy script provider/model hints.
      res.json(await service.generate(req.body, controller.signal))
    } catch (error) {
      const safe = error instanceof HookGenerationError ? error : new HookGenerationError('Hook generation failed.')
      if (!res.destroyed) res.status(safe.status).json({ success: false, error: safe.message })
    } finally { res.off('close', disconnect) }
  })
}

export function registerEphemeralGenerateRoutes(app: Express, deps: RegisterEphemeralGenerateRoutesDeps): void {
  const openAiProvider = new OpenAiChatgptProvider({ tokenStore: deps.tokenStore })
  const lmStudioProvider = new LmStudioProvider()
  const zaiProvider = new HyperRouterZaiProvider({ tokenStore: deps.tokenStore })
  const deepSeekProvider = new HyperRouterDeepSeekProvider({ tokenStore: deps.tokenStore })
  const bedrockProvider = new HyperRouterBedrockProvider({ tokenStore: deps.tokenStore })
  const openRouterByokProvider = new HyperRouterOpenRouterProvider({ tokenStore: deps.tokenStore })

  registerDirectOpenAiGenerateHandler(app, '/api/headless/provider/openai/responses', openAiProvider)
  registerEphemeralChatHandler(app, openAiProvider, lmStudioProvider, zaiProvider, deepSeekProvider, bedrockProvider, openRouterByokProvider)
  registerYggHookGenerateRoute(app, new HookGenerationService({ openAi: async input => {
    const result = await openAiProvider.generate({ modelName: input.modelName, userContent: input.content,
      systemPrompt: input.systemPrompt, history: [], tools: [], signal: input.signal })
    return { text: result.content, modelName: input.modelName }
  } }))
}
