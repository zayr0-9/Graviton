import type { OpenAIContextUsage } from './contextUsage'

// This file contains types shared between client and server

// UUID-based ID types for Supabase compatibility
export type MessageId = string
export type ConversationId = string
export type ProjectId = string

export type StorageMode = 'cloud' | 'local'

export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, any>
  required?: string[]
}

export interface ToolDefinition {
  name: string
  enabled: boolean
  description: string
  inputSchema: ToolInputSchema
  isMcp?: boolean
  mcpServerName?: string
  mcpToolName?: string
  mcpUi?: {
    resourceUri?: string
    visibility?: Array<'model' | 'app'>
  }
}

export interface SelectedFileContent {
  path: string
  relativePath: string
  name?: string
  contents: string
  contentLength: number
  requestId?: number
}

export interface BaseMessage {
  id: MessageId
  conversation_id: ConversationId
  role: 'user' | 'assistant' | 'system' | 'ex_agent' | 'tool'
  thinking_block?: string
  // tool_calls can be string (SQLite) or parsed object/array (Supabase)
  // Frontend handles both formats transparently
  tool_calls?: string | any
  // tool_call_id links tool messages back to the assistant's tool_use block
  tool_call_id?: string | null
  // content_blocks can be string (SQLite) or parsed object/array (Supabase)
  // Structured content with thinking, tool_use, tool_result, text blocks
  content_blocks?: string | any
  /** Latest OpenAI/Codex provider-reported context snapshot for this assistant turn. */
  context_usage?: OpenAIContextUsage | string | null
  content: string
  content_plain_text: string
  parent_id?: MessageId | null
  children_ids: MessageId[]
  created_at: string // ISO timestamp, consistent naming
  updated_at?: string
  model_name: string
  partial: boolean
  // Optional metadata for optimized attachment fetching
  has_attachments?: boolean
  attachments_count?: number
  note?: string
  note_color?: string | null
  // External agent fields (for Claude Code, etc.)
  ex_agent_session_id?: string | null
  ex_agent_type?: string | null
}

export interface ImageConfig {
  aspectRatio?: '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9' | '21:9'
  imageSize?: '1K' | '2K' | '4K'
}

export type OpenAIServiceTier = 'priority'

export interface ReasoningConfig {
  effort: 'low' | 'medium' | 'high' | 'xhigh'
}

export interface SendMessageRequest {
  content: string
  messages?: any[]
  modelName?: string
  parentId?: string
  provider?: string
  systemPrompt?: string
  conversationContext?: string | null
  projectContext?: string | null
  think?: boolean
  temperature?: number
  selectedFiles?: any[]
  retrigger?: boolean
  executionMode?: 'server' | 'client'
  isBranch?: boolean
  attachmentsBase64?: any[]
  storageMode?: StorageMode
  isElectron?: boolean
  imageConfig?: ImageConfig
  reasoningConfig?: ReasoningConfig
  serviceTier?: OpenAIServiceTier
  tools?: ToolDefinition[]
}

export interface BaseModel {
  // Basic identification
  id: string
  name: string
  displayName: string
  version: string
  description: string

  // Context and limits
  contextLength: number
  maxCompletionTokens: number
  inputTokenLimit: number
  outputTokenLimit: number

  // Pricing
  promptCost: number
  completionCost: number
  requestCost: number

  // Capabilities
  thinking: boolean
  supportsImages: boolean
  supportsWebSearch: boolean
  supportsStructuredOutputs: boolean

  // Modality support - arrays to handle multiple modalities
  inputModalities: string[] // e.g., ['text', 'image'] or ['text']
  outputModalities: string[] // e.g., ['text'] or ['text', 'image']

  // Key parameters with defaults
  defaultTemperature: number | null
  defaultTopP: number | null
  defaultFrequencyPenalty: number | null

  // Provider info
  topProviderContextLength: number | null

  // Free tier eligibility (for UI to disable selection for free users)
  isFreeTier?: boolean
}

export interface Project {
  id: ProjectId
  name: string
  created_at: string
  updated_at: string
  context: string
  system_prompt: string
  storage_mode?: StorageMode
  cwd?: string | null
}

export interface ProjectWithLatestConversation extends Project {
  latest_conversation_updated_at: string | null
}

export interface ConversationRecord {
  id: ConversationId
  user_id: string
  project_id?: ProjectId | null
  title: string | null
  model_name: string
  system_prompt: string | null
  conversation_context: string | null
  research_note: string | null
  cwd?: string | null
  favorite?: number
  created_at: string
  updated_at: string
  storage_mode?: StorageMode
}

export interface ChatSession {
  id: string
  title: string
  createdAt: Date
  updatedAt: Date
  messageCount: number
}

export interface ChatRequest {
  message: string
  chatId?: string
  model?: string
}

export interface ChatResponse {
  message: BaseMessage
  chatId: string
}

export interface ErrorResponse {
  error: boolean
  message?: string
}

// Linked file content metadata saved per message
export interface MessageFileContent {
  id: MessageId
  message_id: MessageId
  file_name: string
  file_path?: string | null
  relative_path?: string | null
  created_at: string
}
