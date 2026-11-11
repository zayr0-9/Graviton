import { describe, expect, it } from 'vitest'
import {
  claudeContextUsage,
  contextUsageBlock,
  contextUsageProviderFor,
  extractContextUsageFromBlocks,
  normalizeOpenAIContextUsage,
} from '../../../../../../shared/contextUsage.js'
import { calculateBranchContextUsage } from '../../../../src/features/chats/contextTokenEstimate.js'

const claude = (used: number, extra: Record<string, unknown> = {}) => claudeContextUsage({
  usage: { input_tokens: 10, cache_read_input_tokens: used - 30, cache_creation_input_tokens: 0, output_tokens: 20 },
  model: 'claude-sonnet-5-5', responseId: `msg-${used}`, recordedAt: '2026-11-10T00:00:00.000Z', ...extra,
})!
const openai = (used: number) => normalizeOpenAIContextUsage({ input_tokens: used - 10, output_tokens: 10 },
  { responseId: `resp-${used}`, recordedAt: '2026-11-10T00:00:00.000Z' })!
const assistant = (usage: any, type = 'context_usage') => ({ role: 'assistant', content: 'x', content_blocks: [{ type: 'text', content: 'x' }, { type, usage }] })

describe('claudeContextUsage', () => {
  it('counts cache reads and writes as prompt tokens', () => {
    expect(claudeContextUsage({ usage: { input_tokens: 3, cache_read_input_tokens: 500, cache_creation_input_tokens: 40, output_tokens: 7 } }))
      .toMatchObject({ provider: 'claude', inputTokens: 543, cachedInputTokens: 500, cacheCreationInputTokens: 40, outputTokens: 7, usedTokens: 550 })
  })

  it('finds the window by key, canonical id or a suffixed key, and omits it otherwise', () => {
    const window = (modelUsage: any) => claudeContextUsage({ usage: { input_tokens: 1, output_tokens: 1 }, model: 'claude-opus-5-5', modelUsage })?.contextWindow
    expect(window({ 'claude-opus-5-5': { contextWindow: 1_000_000 } })).toBe(1_000_000)
    expect(window({ 'us.anthropic.opus': { canonicalModel: 'claude-opus-5-5', contextWindow: 500_000 } })).toBe(500_000)
    expect(window({ 'claude-opus-5-5[1m]': { contextWindow: 1_000_000 } })).toBe(1_000_000)
    expect(window({ 'claude-haiku-5-5': { contextWindow: 200_000 } })).toBeUndefined()
  })

  it('rejects empty or missing usage', () => {
    expect(claudeContextUsage({ usage: undefined })).toBeNull()
    expect(claudeContextUsage({ usage: { input_tokens: 0, output_tokens: 0 } })).toBeNull()
  })

  it('round-trips through a stored block, and the legacy OpenAI block still reads', () => {
    const usage = claude(1000, { modelUsage: { 'claude-sonnet-5-5': { contextWindow: 1_000_000, costUSD: 0.2 } }, totalCostUsd: 0.25 })
    expect(extractContextUsageFromBlocks([contextUsageBlock(usage)])).toEqual(usage)
    expect(extractContextUsageFromBlocks(JSON.stringify([{ type: 'openai_context_usage', usage: openai(90) }]))?.usedTokens).toBe(90)
  })
})

describe('context meter with reported usage', () => {
  it('maps provider routes to their usage family', () => {
    expect(contextUsageProviderFor('Claude Code')).toBe('claude')
    expect(contextUsageProviderFor('OpenAI (ChatGPT)')).toBe('openai')
    expect(contextUsageProviderFor('lmstudio')).toBeNull()
  })

  it('uses the latest Claude snapshot for Claude chats and keeps its history', () => {
    const meter = calculateBranchContextUsage({ providerName: 'Claude Code', messages: [assistant(claude(1000)), assistant(claude(4000))] })
    expect(meter.source).toBe('reported')
    expect(meter.totalContextTokens).toBe(4000)
    expect(meter.usageHistory.map(point => point.usedTokens)).toEqual([1000, 4000])
  })

  it('never shows one provider family the other\'s usage', () => {
    const messages = [assistant(openai(9000), 'openai_context_usage'), assistant(claude(1000))]
    expect(calculateBranchContextUsage({ providerName: 'OpenAI (ChatGPT)', messages }).totalContextTokens).toBe(9000)
    expect(calculateBranchContextUsage({ providerName: 'Claude Code', messages }).usageHistory).toHaveLength(1)
    expect(calculateBranchContextUsage({ providerName: 'lmstudio', messages }).source).toBe('estimated')
  })

  it('drops Claude usage from before a committed compaction summary', () => {
    const summary = { role: 'assistant', content: 'summary', meta: { kind: 'compaction_summary', state: 'committed' } }
    const meter = calculateBranchContextUsage({ providerName: 'Claude Code', messages: [assistant(claude(900_000)), summary] })
    expect(meter.source).toBe('estimated')
  })
})
