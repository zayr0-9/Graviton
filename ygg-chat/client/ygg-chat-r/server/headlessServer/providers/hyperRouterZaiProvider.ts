import { GLMProvider } from '@hyper-labs/hyper-router/providers/glm'
import type {
  HeadlessProvider,
  ProviderGenerateInput,
  ProviderGenerateOutput,
  ProviderStreamEventHandler,
} from './providerTypes.js'
import type { ProviderTokenStore } from './tokenStore.js'
import { generateWithHyperProvider, normalizeBearer } from './hyperRouterAdapter.js'

interface HyperRouterZaiProviderDeps {
  tokenStore?: ProviderTokenStore
}

export class HyperRouterZaiProvider implements HeadlessProvider {
  readonly name = 'zai'
  private readonly tokenStore?: ProviderTokenStore

  constructor(deps: HyperRouterZaiProviderDeps = {}) {
    this.tokenStore = deps.tokenStore
  }

  private resolveApiKey(input: ProviderGenerateInput): string | undefined {
    const direct = normalizeBearer(input.accessToken)
    if (direct) return direct

    const stored = input.userId ? this.tokenStore?.get('zai', input.userId) : this.tokenStore?.getLatest('zai')
    const storedToken = normalizeBearer(stored?.accessToken)
    if (storedToken) return storedToken

    return normalizeBearer(process.env.ZAI_API_KEY) || undefined
  }

  async generate(input: ProviderGenerateInput, _emit?: ProviderStreamEventHandler): Promise<ProviderGenerateOutput> {
    const apiKey = this.resolveApiKey(input)
    if (!apiKey) {
      throw new Error('Z.AI API key missing. Add a Z.AI BYOK token or set ZAI_API_KEY.')
    }

    const provider = new GLMProvider({
      apiKey,
      ...(process.env.ZAI_BASE_URL ? { baseURL: process.env.ZAI_BASE_URL } : {}),
      ...(input.think ? { thinking: { type: 'enabled' as const, clear_thinking: false } } : {}),
      ...(typeof input.temperature === 'number' ? { rawBody: { temperature: input.temperature } } : {}),
    })

    return generateWithHyperProvider(provider, input.modelName || process.env.ZAI_MODEL || 'glm-5.1', input)
  }
}
