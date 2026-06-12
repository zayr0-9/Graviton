import type {
  ProviderGenerateInput,
  ProviderStreamEventHandler,
  ProviderToolCall,
  ProviderToolDefinition,
} from '../openRouterProvider.js'

export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
export const CODEX_ORIGINATOR = 'codex_cli_rs'

export type CodexMessage = {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  content?: string
  contentParts?: any[]
  toolCallId?: string
  name?: string
  toolCalls?: Array<{
    id: string
    toolName: string
    args: any
  }>
}

export type CodexRequestParts = {
  instructions?: string
  input: any[]
  tools: any[]
}

export type CodexAuthContext = {
  accessToken: string
  accountId: string
}

export type CodexResponsesTransport = 'http' | 'websocket' | 'auto'

export type CodexProviderOptions = {
  auth: CodexAuthContext
  baseURL?: string
  originator?: string
  userAgent?: string
  transport?: CodexResponsesTransport
  fetch?: typeof fetch
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
  reasoningSummary?: 'auto' | 'concise' | 'detailed' | null
}

export type CodexGenerateInput = {
  model: string
  providerInput: ProviderGenerateInput
  messages: CodexMessage[]
  tools: ProviderToolDefinition[]
  sessionId?: string
  runId?: string
  signal?: AbortSignal
  emit?: ProviderStreamEventHandler
}

export type CodexResponseUsage = {
  input_tokens?: number
  input_tokens_details?: { cached_tokens?: number } | null
  output_tokens?: number
  output_tokens_details?: { reasoning_tokens?: number } | null
  total_tokens?: number
}

export type CodexParseResult = {
  content: string
  reasoningContent?: string
  toolCalls: ProviderToolCall[]
  providerStopReason?: string
  generatedImages?: Array<{ url?: string; dataUrl?: string; mimeType?: string }>
  responseId?: string
  usage?: CodexResponseUsage
  outputItems?: any[]
  responseItemsAdded?: any[]
  debug?: {
    eventCounts: Record<string, number>
    outputItemCount: number
    addedItemCount: number
  }
}

export type CodexResponseParseOptions = {
  emit?: ProviderStreamEventHandler
  modelName?: string
  strictFinalAnswerText?: boolean
  onReasoningDelta?: (delta: string) => void
  onTextDelta?: (delta: string) => void
  reader?: ReadableStreamDefaultReader<Uint8Array> | null
  firstRead?: ReadableStreamReadResult<Uint8Array> | null
}

export type CodexRequestDiagnostics = {
  promptCacheKey: string
  requestId: string
  inputItems: number
  instructionsHash: string
  toolsHash: string
  firstItemsHash: string
  fullInputHash: string
  messageShape: string[]
}

export type CodexGenerateResult = CodexParseResult & {
  requestBody: Record<string, any>
  requestHeaders: Headers
  requestId: string
  promptCacheKey: string
  diagnostics: CodexRequestDiagnostics
}
