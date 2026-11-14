import { DeepSeekProvider } from '@hyper-labs/hyper-router/providers/deepseek'
import type {
  HeadlessProvider,
  ProviderGenerateInput,
  ProviderGenerateOutput,
  ProviderStreamEventHandler,
} from './providerTypes.js'
import type { ProviderTokenStore } from './tokenStore.js'
import { generateWithHyperProvider, normalizeBearer } from './hyperRouterAdapter.js'

export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash'
export const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro']

interface HyperRouterDeepSeekProviderDeps {
  tokenStore?: ProviderTokenStore
}

export class HyperRouterDeepSeekProvider implements HeadlessProvider {
  readonly name = 'deepseek'
  private readonly tokenStore?: ProviderTokenStore

  constructor(deps: HyperRouterDeepSeekProviderDeps = {}) {
    this.tokenStore = deps.tokenStore
  }

  private resolveApiKey(input: ProviderGenerateInput): string | undefined {
    const direct = normalizeBearer(input.accessToken)
    if (direct) return direct

    const stored = input.userId ? this.tokenStore?.get('deepseek', input.userId) : this.tokenStore?.getLatest('deepseek')
    const storedToken = normalizeBearer(stored?.accessToken)
    if (storedToken) return storedToken

    return normalizeBearer(process.env.DEEPSEEK_API_KEY) || undefined
  }

  async generate(input: ProviderGenerateInput, _emit?: ProviderStreamEventHandler): Promise<ProviderGenerateOutput> {
    const apiKey = this.resolveApiKey(input)
    if (!apiKey) {
      throw new Error('DeepSeek API key missing. Add a DeepSeek API key in Settings or set DEEPSEEK_API_KEY.')
    }

    // DeepSeek defaults thinking on, so the toggle is sent explicitly both ways. With thinking on,
    // the adapter replays stored reasoning, which DeepSeek requires on tool-call turns.
    const provider = new DeepSeekProvider({
      apiKey,
      ...(process.env.DEEPSEEK_BASE_URL ? { baseURL: process.env.DEEPSEEK_BASE_URL } : {}),
      thinking: { type: input.think ? 'enabled' : 'disabled' },
      ...(typeof input.temperature === 'number' ? { rawBody: { temperature: input.temperature } } : {}),
    })

    return generateWithHyperProvider(
      provider,
      input.modelName || process.env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL,
      input
    )
  }
}
