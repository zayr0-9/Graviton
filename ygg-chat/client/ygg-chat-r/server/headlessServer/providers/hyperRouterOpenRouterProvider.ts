import type { AnyToolDefinition } from '@hyper-labs/hyper-router'
import { OpenRouterProvider } from '@hyper-labs/hyper-router/providers/openrouter'
import { z } from 'zod'
import type { BaseModel } from '../../../../../shared/types.js'
import type {
  HeadlessProvider,
  ProviderGenerateInput,
  ProviderGenerateOutput,
  ProviderStreamEventHandler,
} from './openRouterProvider.js'
import type { ProviderTokenStore } from './tokenStore.js'
import { generateWithHyperProvider, normalizeBearer, toHyperTools } from './hyperRouterAdapter.js'

/** Token-store key and route for the user-key OpenRouter provider (distinct from the app-account `openrouter`). */
export const OPENROUTER_BYOK_PROVIDER_KEY = 'openrouterbyok'
export const DEFAULT_OPENROUTER_BYOK_MODEL = 'openai/gpt-5-mini'

interface HyperRouterOpenRouterProviderDeps {
  tokenStore?: ProviderTokenStore
}

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
const CATALOG_TTL_MS = 10 * 60 * 1000
let catalogCache: { models: BaseModel[]; fetchedAt: number } | null = null

const toNumber = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function toBaseModel(raw: any): BaseModel | null {
  if (!raw || typeof raw.id !== 'string' || !raw.id) return null
  const parameters: string[] = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : []
  const inputModalities: string[] = Array.isArray(raw.architecture?.input_modalities) ? raw.architecture.input_modalities : ['text']
  const outputModalities: string[] = Array.isArray(raw.architecture?.output_modalities) ? raw.architecture.output_modalities : ['text']
  const contextLength = toNumber(raw.context_length) || toNumber(raw.top_provider?.context_length) || 128_000
  const maxCompletionTokens = toNumber(raw.top_provider?.max_completion_tokens) || 8192
  return {
    id: raw.id,
    name: raw.id,
    displayName: typeof raw.name === 'string' && raw.name ? raw.name : raw.id,
    version: '',
    description: typeof raw.description === 'string' ? raw.description : '',
    contextLength,
    maxCompletionTokens,
    inputTokenLimit: contextLength,
    outputTokenLimit: maxCompletionTokens,
    promptCost: toNumber(raw.pricing?.prompt),
    completionCost: toNumber(raw.pricing?.completion),
    requestCost: toNumber(raw.pricing?.request),
    thinking: parameters.includes('reasoning') || parameters.includes('include_reasoning'),
    supportsImages: inputModalities.includes('image'),
    supportsWebSearch: parameters.includes('web_search_options'),
    supportsStructuredOutputs: parameters.includes('structured_outputs'),
    inputModalities,
    outputModalities,
    defaultTemperature: null,
    defaultTopP: null,
    defaultFrequencyPenalty: null,
    topProviderContextLength: toNumber(raw.top_provider?.context_length) || null,
  }
}

/** OpenRouter's public catalog, limited to text-output models that accept tool calls. */
export async function fetchOpenRouterByokModels(): Promise<BaseModel[]> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) return catalogCache.models
  const response = await fetch(OPENROUTER_MODELS_URL, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`OpenRouter model catalog request failed: HTTP ${response.status}`)
  const payload = (await response.json()) as { data?: unknown[] }
  const models = (Array.isArray(payload?.data) ? payload.data : [])
    .filter((raw: any) => Array.isArray(raw?.supported_parameters) && raw.supported_parameters.includes('tools'))
    .map(toBaseModel)
    .filter((model): model is BaseModel => Boolean(model) && model!.outputModalities.includes('text'))
    .sort((a, b) => a.id.localeCompare(b.id))
  catalogCache = { models, fetchedAt: Date.now() }
  return models
}

/** The OpenRouter adapter only accepts Zod tool schemas; Graviton tools carry JSON Schema. */
function toZodInputSchema(schema: unknown, toolName: string) {
  try {
    return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
  } catch (error) {
    console.warn(`[openrouter-byok] Tool "${toolName}" schema could not be converted; sending it without parameters.`, error)
    return z.object({}).passthrough()
  }
}

export function toOpenRouterTools(input: ProviderGenerateInput): AnyToolDefinition[] {
  return toHyperTools(input).map(tool => ({ ...tool, inputSchema: toZodInputSchema(tool.inputSchema, tool.name) }))
}

export class HyperRouterOpenRouterProvider implements HeadlessProvider {
  readonly name = OPENROUTER_BYOK_PROVIDER_KEY
  private readonly tokenStore?: ProviderTokenStore

  constructor(deps: HyperRouterOpenRouterProviderDeps = {}) {
    this.tokenStore = deps.tokenStore
  }

  private resolveApiKey(input: ProviderGenerateInput): string | undefined {
    const direct = normalizeBearer(input.accessToken)
    if (direct) return direct

    const stored = input.userId
      ? this.tokenStore?.get(OPENROUTER_BYOK_PROVIDER_KEY, input.userId)
      : this.tokenStore?.getLatest(OPENROUTER_BYOK_PROVIDER_KEY)
    const storedToken = normalizeBearer(stored?.accessToken)
    if (storedToken) return storedToken

    return normalizeBearer(process.env.OPENROUTER_API_KEY) || undefined
  }

  async generate(input: ProviderGenerateInput, _emit?: ProviderStreamEventHandler): Promise<ProviderGenerateOutput> {
    const apiKey = this.resolveApiKey(input)
    if (!apiKey) {
      throw new Error('OpenRouter API key missing. Add your key in Settings → Provider Settings or set OPENROUTER_API_KEY.')
    }

    const provider = new OpenRouterProvider({
      apiKey,
      ...(input.think ? { reasoning: { enabled: true } } : {}),
      ...(typeof input.temperature === 'number' ? { callOptions: { temperature: input.temperature } } : {}),
    })
    // Graviton history can mix models and providers; stored thinking text is not a
    // portable OpenRouter reasoning item, so it is not replayed.
    return generateWithHyperProvider(provider, input.modelName || DEFAULT_OPENROUTER_BYOK_MODEL, input, {
      tools: toOpenRouterTools(input),
      replayReasoning: false,
    })
  }
}
