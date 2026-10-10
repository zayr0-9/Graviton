import { describe, expect, it } from 'vitest'
import { normalizeSubagentModelName } from '../../../../src/helpers/subagentModelNames'

describe('normalizeSubagentModelName', () => {
  it.each([
    ['GPT-6-Astra', 'gpt-6-astra'],
    ['GPT-6-Sol', 'gpt-6-sol'],
    ['GPT-6.1-Sol', 'gpt-6.1-sol'],
    ['GPT-6.1 Sol', 'gpt-6.1-sol'],
    ['openaichatgpt/gpt-6.1-sol', 'gpt-6.1-sol'],
    ['GPT-6-Luna', 'gpt-6-luna'],
    ['GPT-5.6 Sol', 'gpt-6-sol'],
    ['GPT-5.6 Terra', 'gpt-5.6-terra'],
    ['GPT-5.6 Luna', 'gpt-6-luna'],
    ['openai/GPT-5.6 Sol', 'gpt-6-sol'],
    ['openaichatgpt/gpt-5.6-terra', 'gpt-5.6-terra'],
  ])('normalizes ChatGPT subagent model %s to %s', (input, expected) => {
    expect(normalizeSubagentModelName(input, 'OpenAI (ChatGPT)')).toBe(expected)
  })

  it('keeps non-ChatGPT provider model names unchanged', () => {
    expect(normalizeSubagentModelName('openai/gpt-5.6-sol', 'OpenRouter')).toBe('openai/gpt-5.6-sol')
  })

  it('uses GPT-5.6 Sol for stale generic GPT-5 ChatGPT names', () => {
    expect(normalizeSubagentModelName('GPT-5', 'openaichatgpt')).toBe('gpt-5.6-sol')
  })
})
