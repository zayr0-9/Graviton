/** Claude sessions are a separate execution backend, not an API tool-loop provider. */
export const CLAUDE_PROVIDER = 'Claude Code'
export const CLAUDE_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'] as const
export function isClaudeProvider(provider: unknown): boolean {
  return typeof provider === 'string' && ['claude', 'claudecode', 'anthropic(claudecli)'].includes(provider.toLowerCase().replace(/\s+/g, ''))
}
export function claudeMessageMetadata(meta: unknown): any {
  try {
    const parsed = typeof meta === 'string' ? JSON.parse(meta) : meta
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

export function isClaudeTranscriptMessage(message: { meta?: unknown } | null | undefined): boolean {
  const meta = claudeMessageMetadata(message?.meta)
  return Boolean(meta.claude || isClaudeProvider(meta.modelSelection?.provider))
}

export function isClaudeCheckpoint(message: { meta?: unknown } | null | undefined): boolean {
  return claudeMessageMetadata(message?.meta).claude?.checkpoint === true
}
