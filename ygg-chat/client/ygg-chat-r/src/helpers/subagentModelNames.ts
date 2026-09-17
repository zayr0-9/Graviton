const normalizeProviderSlug = (providerName: string | null | undefined): string =>
  (providerName || '').toLowerCase().replace(/[^a-z0-9]+/g, '')

export function isOpenAIChatGPTSubagentProvider(providerName: string | null | undefined): boolean {
  const slug = normalizeProviderSlug(providerName)
  return slug === 'openaichatgpt'
}

export function normalizeSubagentModelName(
  modelName: string | null | undefined,
  providerName: string | null | undefined
): string | null {
  const raw = typeof modelName === 'string' ? modelName.trim() : ''
  if (!raw) return null
  if (!isOpenAIChatGPTSubagentProvider(providerName)) return raw

  const stripped = raw.replace(/^(openai\s*\(chatgpt\)|openaichatgpt|openai)\s*\//i, '')
  const slug = stripped.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

  if (slug.includes('gpt-6-astra')) return 'gpt-6-astra'
  if (slug.includes('gpt-5-6-sol')) return 'gpt-5.6-sol'
  if (slug.includes('gpt-5-6-terra')) return 'gpt-5.6-terra'
  if (slug.includes('gpt-5-6-luna')) return 'gpt-5.6-luna'
  if (slug.includes('gpt-5-5-pro')) return 'gpt-5.5-pro'
  if (slug.includes('gpt-5-5')) return 'gpt-5.5'
  if (slug.includes('gpt-5-4')) return 'gpt-5.5'
  if (slug.includes('gpt-5-3-codex')) return 'gpt-5.3-codex'

  if (
    slug.includes('gpt-5-2') ||
    slug.includes('gpt-5-1') ||
    slug.includes('gpt-5-codex') ||
    slug.includes('codex-mini-latest')
  ) {
    return 'gpt-5.3-codex'
  }

  if (slug.includes('gpt-5')) return 'gpt-5.6-sol'
  if (slug.includes('gpt-4o')) return 'gpt-5.5'

  return stripped || null
}
