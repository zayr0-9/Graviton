export type OpenAIHostedWebSearchMode = 'disabled' | 'cached' | 'live'

export interface OpenAIHostedWebSearchConfig {
  mode?: OpenAIHostedWebSearchMode
  contextSize?: 'low' | 'medium' | 'high'
  allowedDomains?: string[]
  userLocation?: {
    type?: 'approximate'
    country?: string
    region?: string
    city?: string
    timezone?: string
  }
  searchContentTypes?: Array<'text' | 'image'>
}

export interface OpenAIHostedImageGenerationConfig {
  enabled?: boolean
  outputFormat?: 'png' | 'jpeg' | 'webp'
}

export interface OpenAIHostedToolsConfig {
  webSearch?: OpenAIHostedWebSearchConfig | OpenAIHostedWebSearchMode | boolean
  imageGeneration?: OpenAIHostedImageGenerationConfig | boolean
}

function normalizeWebSearchConfig(raw: OpenAIHostedToolsConfig['webSearch']): OpenAIHostedWebSearchConfig | null {
  if (raw === false || raw === 'disabled') return null
  if (raw === true || raw == null) return { mode: 'live' }
  if (typeof raw === 'string') return { mode: raw }
  return raw
}

export function createOpenAIHostedWebSearchTool(raw?: OpenAIHostedToolsConfig['webSearch']): any | null {
  const config = normalizeWebSearchConfig(raw)
  if (!config) return null

  const mode = config.mode || 'live'
  if (mode === 'disabled') return null

  const tool: any = {
    type: 'web_search',
    external_web_access: mode === 'live',
  }

  if (config.contextSize) tool.search_context_size = config.contextSize

  const allowedDomains = Array.isArray(config.allowedDomains)
    ? config.allowedDomains.map(domain => String(domain).trim()).filter(Boolean)
    : []
  if (allowedDomains.length > 0) {
    tool.filters = { allowed_domains: allowedDomains }
  }

  if (config.userLocation) {
    const location: any = { type: config.userLocation.type || 'approximate' }
    for (const key of ['country', 'region', 'city', 'timezone'] as const) {
      const value = config.userLocation[key]
      if (typeof value === 'string' && value.trim()) location[key] = value.trim()
    }
    tool.user_location = location
  }

  if (Array.isArray(config.searchContentTypes) && config.searchContentTypes.length > 0) {
    tool.search_content_types = Array.from(new Set(config.searchContentTypes.filter(Boolean)))
  }

  return tool
}

export function createOpenAIHostedImageGenerationTool(
  raw?: OpenAIHostedToolsConfig['imageGeneration']
): any | null {
  if (raw === false) return null
  const config = raw === true || raw == null ? {} : raw
  if (config.enabled === false) return null

  return {
    type: 'image_generation',
    output_format: config.outputFormat || 'png',
  }
}

function readEnvFlag(name: string): boolean | undefined {
  const value = process.env[name]
  if (value == null || value === '') return undefined
  if (/^(1|true|yes|on)$/i.test(value)) return true
  if (/^(0|false|no|off)$/i.test(value)) return false
  return undefined
}

function readEnvWebSearchMode(): OpenAIHostedWebSearchMode | undefined {
  const value = (process.env.YGG_OPENAI_WEB_SEARCH || '').toLowerCase().trim()
  if (value === 'disabled' || value === 'cached' || value === 'live') return value
  const flag = readEnvFlag('YGG_OPENAI_WEB_SEARCH')
  if (flag === true) return 'live'
  if (flag === false) return 'disabled'
  return undefined
}

export function createOpenAIHostedTools(options: {
  config?: OpenAIHostedToolsConfig | null
  enableImageGeneration?: boolean
} = {}): any[] {
  const configuredWebSearch = options.config?.webSearch ?? readEnvWebSearchMode() ?? 'live'
  const configuredImageGeneration =
    options.config?.imageGeneration ?? readEnvFlag('YGG_OPENAI_IMAGE_GENERATION') ?? options.enableImageGeneration

  const tools: any[] = []
  const webSearchTool = createOpenAIHostedWebSearchTool(configuredWebSearch)
  if (webSearchTool) tools.push(webSearchTool)

  const imageGenerationTool = configuredImageGeneration
    ? createOpenAIHostedImageGenerationTool(configuredImageGeneration === true ? true : configuredImageGeneration)
    : null
  if (imageGenerationTool) tools.push(imageGenerationTool)

  return tools
}
