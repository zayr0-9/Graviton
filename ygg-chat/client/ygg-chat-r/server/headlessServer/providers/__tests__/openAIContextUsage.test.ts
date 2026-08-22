import { describe, expect, it } from 'vitest'
import {
  effectiveOpenAIContextTokens,
  extractOpenAIContextUsageFromBlocks,
  normalizeOpenAIContextUsage,
  resolveOpenAIContinuationCompaction,
  shouldCompactAtPercent,
} from '../../../../../../shared/contextUsage.js'

describe('OpenAI context usage', () => {
  it('compacts OpenAI continuations at 85% of the 258k subscription window', () => {
    const below = resolveOpenAIContinuationCompaction({
      providerName: 'OpenAI (ChatGPT)',
      projectedTokens: 219_299,
      contextLength: 258_000,
    })
    const atThreshold = resolveOpenAIContinuationCompaction({
      providerName: 'OpenAI (ChatGPT)',
      projectedTokens: 219_300,
      contextLength: 258_000,
    })

    expect(below.shouldCompact).toBe(false)
    expect(atThreshold.shouldCompact).toBe(true)
  })

  it('uses the greater of reported usage and the projected post-tool replay', () => {
    const decision = resolveOpenAIContinuationCompaction({
      providerName: 'openai',
      reportedUsage: normalizeOpenAIContextUsage({ total_tokens: 200_000 }),
      projectedTokens: 225_000,
      contextLength: 258_000,
    })

    expect(decision.effectiveTokens).toBe(225_000)
    expect(decision.shouldCompact).toBe(true)
  })

  it('does not activate mid-run compaction for other providers', () => {
    expect(
      resolveOpenAIContinuationCompaction({
        providerName: 'OpenRouter',
        projectedTokens: 250_000,
        contextLength: 258_000,
      }).shouldCompact
    ).toBe(false)
  })
  it('normalizes OpenAI usage without subtracting cached input tokens', () => {
    const usage = normalizeOpenAIContextUsage(
      {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 40 },
        output_tokens: 25,
        output_tokens_details: { reasoning_tokens: 5 },
        total_tokens: 125,
      },
      { model: 'gpt-5.4', responseId: 'resp-1', recordedAt: '2026-01-01T00:00:00.000Z' }
    )

    expect(usage).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.4',
      responseId: 'resp-1',
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 25,
      reasoningTokens: 5,
      totalTokens: 125,
      usedTokens: 125,
    })
  })

  it('uses total tokens as a fallback and supports persisted usage blocks', () => {
    const usage = normalizeOpenAIContextUsage({ totalTokens: 90 }, { recordedAt: '2026-01-01T00:00:00.000Z' })
    expect(usage?.usedTokens).toBe(90)
    expect(extractOpenAIContextUsageFromBlocks([{ type: 'openai_context_usage', usage }])?.usedTokens).toBe(90)
  })

  it('prefers provider-reported usage and falls back to the local estimate when it is unavailable', () => {
    const usage = normalizeOpenAIContextUsage({ input_tokens: 70, output_tokens: 10 })
    expect(effectiveOpenAIContextTokens(usage, 90)).toBe(80)
    expect(effectiveOpenAIContextTokens(null, 90)).toBe(90)
    expect(shouldCompactAtPercent(84_999, 100_000)).toBe(false)
    expect(shouldCompactAtPercent(85_000, 100_000)).toBe(true)
  })
})
