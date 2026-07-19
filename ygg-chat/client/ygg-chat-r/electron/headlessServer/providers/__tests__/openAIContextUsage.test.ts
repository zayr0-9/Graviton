import { describe, expect, it } from 'vitest'
import {
  effectiveOpenAIContextTokens,
  extractOpenAIContextUsageFromBlocks,
  normalizeOpenAIContextUsage,
  shouldCompactAtPercent,
} from '../../../../../../shared/contextUsage.js'

describe('OpenAI context usage', () => {
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

  it('keeps the local estimate as a conservative floor and retains the existing 85 percent gate', () => {
    const usage = normalizeOpenAIContextUsage({ input_tokens: 70, output_tokens: 10 })
    expect(effectiveOpenAIContextTokens(usage, 90)).toBe(90)
    expect(shouldCompactAtPercent(84_999, 100_000)).toBe(false)
    expect(shouldCompactAtPercent(85_000, 100_000)).toBe(true)
  })
})
