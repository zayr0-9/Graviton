import { isClaudeProvider } from '../../../../../shared/claudeProvider.js'
import { HyperRouterBedrockProvider } from '../providers/hyperRouterBedrockProvider.js'
import { HyperRouterOpenRouterProvider } from '../providers/hyperRouterOpenRouterProvider.js'
import { HyperRouterZaiProvider } from '../providers/hyperRouterZaiProvider.js'
import { LmStudioProvider } from '../providers/lmStudioProvider.js'
import {
  OpenAiChatgptProvider,
  resolveOpenAIChatGPTContextLength,
} from '../providers/openaiChatgptProvider.js'
import type {
  HeadlessProvider,
  ProviderGenerateInput,
  ProviderGenerateOutput,
  ProviderStreamEventHandler,
} from '../providers/providerTypes.js'
import type { ProviderTokenStore } from '../providers/tokenStore.js'

export type ProviderRoute = 'openrouterbyok' | 'openaichatgpt' | 'lmstudio' | 'zai' | 'bedrock'

/**
 * Strict lookup: the route for a known provider name or alias, else null.
 * Unknown names are rejected at the API boundary (fully-local plan Q7).
 */
export function resolveProviderRoute(providerName: string): ProviderRoute | null {
  const normalized = String(providerName ?? '').trim().toLowerCase().replace(/\s+/g, '')
  if (normalized === 'openaichatgpt' || normalized === 'openai(chatgpt)' || normalized === 'openai') {
    return 'openaichatgpt'
  }
  if (normalized === 'lmstudio') return 'lmstudio'
  if (normalized === 'zai' || normalized === 'z.ai' || normalized === 'glm' || normalized === 'glmprovider' || normalized === 'z.ai/glm' || normalized === 'zai/glm') return 'zai'
  if (
    normalized === 'bedrock' ||
    normalized === 'awsbedrock' ||
    normalized === 'aws/bedrock' ||
    normalized === 'aws-bedrock' ||
    normalized === 'amazonbedrock' ||
    normalized === 'amazon-bedrock'
  ) {
    return 'bedrock'
  }
  // 'openrouter' was the retired Graviton-hosted (Railway) route; saved settings and old
  // conversations that still name it use the user's own OpenRouter key instead.
  if (
    normalized === 'openrouterbyok' ||
    normalized === 'openrouter-byok' ||
    normalized === 'openrouter(byok)' ||
    normalized === 'openrouter'
  ) {
    return 'openrouterbyok'
  }
  return null
}

/**
 * Lenient lookup for classification and defaults (unknown → 'openaichatgpt'). Generation
 * never relies on this fallback: ProviderRouter.generate and the HTTP guard reject unknown names.
 */
export function normalizeProviderRoute(providerName: string): ProviderRoute {
  return resolveProviderRoute(providerName) ?? 'openaichatgpt'
}

export class UnknownProviderError extends Error {
  readonly status = 400
  readonly code = 'unknown_provider'
  constructor(providerName: string) {
    super(`unknown provider "${providerName}"`)
    this.name = 'UnknownProviderError'
  }
}

/** True for every provider Graviton can run, including the Claude Code session backend. */
export function isKnownProviderName(providerName: string): boolean {
  return isClaudeProvider(providerName) || resolveProviderRoute(providerName) !== null
}

interface ProviderRouterDeps {
  tokenStore?: ProviderTokenStore
}

export class ProviderRouter {
  private readonly providers: Record<ProviderRoute, HeadlessProvider>

  constructor(deps: ProviderRouterDeps = {}) {
    this.providers = {
      openaichatgpt: new OpenAiChatgptProvider({ tokenStore: deps.tokenStore }),
      lmstudio: new LmStudioProvider(),
      zai: new HyperRouterZaiProvider({ tokenStore: deps.tokenStore }),
      bedrock: new HyperRouterBedrockProvider({ tokenStore: deps.tokenStore }),
      openrouterbyok: new HyperRouterOpenRouterProvider({ tokenStore: deps.tokenStore }),
    }
  }

  resolveContextLength(providerName: string, requestedContextLength: number | undefined): number | undefined {
    if (normalizeProviderRoute(providerName) === 'openaichatgpt') {
      return resolveOpenAIChatGPTContextLength(requestedContextLength)
    }
    return requestedContextLength
  }

  async generate(
    providerName: string,
    input: ProviderGenerateInput,
    emit?: ProviderStreamEventHandler
  ): Promise<ProviderGenerateOutput> {
    if (isClaudeProvider(providerName)) throw new Error('Claude Code uses the session backend and is unavailable in Graviton subagents or compaction.')
    const route = resolveProviderRoute(providerName)
    if (!route) throw new UnknownProviderError(providerName)
    const provider = this.providers[route]
    return provider.generate(input, emit)
  }
}
