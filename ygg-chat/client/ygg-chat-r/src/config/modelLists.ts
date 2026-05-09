/**
 * Hardcoded model lists for the Expanded Model View
 * Edit these arrays to customize which models appear in Top/New sections
 */

// Models to show in the "Top Models" tab
// Add model IDs (e.g., 'anthropic/claude-3.5-sonnet')
export const TOP_MODELS: string[] = [
  // Anthropic
  'anthropic/claude-sonnet-4.5',
  'anthropic/claude-opus-4.5',
  'anthropic/claude-3.5-haiku',
  // OpenAI
  'openai/gpt-5.5',
  'openai/gpt-4o-mini',
  'openai/gpt-5-mini',
  'openai/o1-mini',
  // Google
  'google/gemini-3-flash-preview',
  'google/gemini-3-pro-preview',
  // Meta
  // 'meta-llama/llama-3.3-70b-instruct',
  // Mistral
  'mistralai/small-creative',
  'mistralai/devstral-2512',
  'mistralai/ministral-14b-2512',
  //Z-AI
  'z-ai/glm-4.7',
  'z-ai/glm-4.6v',
  'z-ai/glm-4.6:exacto',
  'z-ai/glm-4.5:air',
]

// Models to show in the "New" tab
// Add recently released models here
export const NEW_MODELS: string[] = [
  // Add new models as they're released
]

// Models optimized for coding tasks
export const CODING_MODELS: string[] = [
  'openai/gpt-5.5',
  'anthropic/claude-opus-4.5',
  'anthropic/claude-sonnet-4.5',
  'openai/gpt-5.3-codex',
  'google/gemini-3-flash-preview',
  'google/gemini-3-pro-preview',
]

// Models optimized for research tasks
export const RESEARCH_MODELS: string[] = [
  'openai/gpt-5.5-pro',
  'openai/gpt-5.5',
  'google/gemini-3-flash-preview',
  'google/gemini-3-pro-preview',
]

// Company prefixes for grouping models by provider
// Key: Display name, Value: Model ID prefix
export const COMPANY_PREFIXES: Record<string, string> = {
  OpenAI: 'openai/',
  Anthropic: 'anthropic/',
  Google: 'google/',
  Meta: 'meta-llama/',
  Mistral: 'mistralai/',
  Cohere: 'cohere/',
  DeepSeek: 'deepseek/',
  Qwen: 'qwen/',
  'Z-AI': 'z-ai/',
}

// Order of company tabs in the expanded view
export const COMPANY_TAB_ORDER: string[] = ['OpenAI', 'Anthropic', 'Google', 'Mistral', 'DeepSeek', 'Z-AI']
