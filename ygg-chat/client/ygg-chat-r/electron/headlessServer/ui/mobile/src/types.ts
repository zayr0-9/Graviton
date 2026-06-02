import type { LocalFileEntry, LocalFileListingResponse, LocalFileSearchResponse } from '../../../../../shared/localFileBrowser'

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

export interface LocalUserProfile {
  id: string
  username: string
  created_at?: string
  project_count?: number
  conversation_count?: number
}

export interface MobileProject {
  id: string
  user_id: string
  name: string
  cwd?: string | null
  context?: string | null
  system_prompt?: string | null
  updated_at?: string
  created_at?: string
}

export interface MobileConversation {
  id: string
  user_id: string
  project_id?: string | null
  cwd?: string | null
  title: string
  system_prompt?: string | null
  conversation_context?: string | null
  updated_at?: string
  created_at?: string
}

export interface MobileMessage {
  id: string
  role: MessageRole
  content: string
  conversation_id?: string
  parent_id?: string | null
  children_ids?: string[] | string | null
  created_at?: string
  tool_calls?: unknown
  content_blocks?: unknown
}

export interface MobileMessageTreeNode {
  id: string
  message: string
  sender: 'user' | 'assistant' | 'ex_agent' | 'tool' | 'system'
  children: MobileMessageTreeNode[]
}

export interface MobileMessageTreePayload {
  messages: MobileMessage[]
  tree: MobileMessageTreeNode | null
  meta?: { storage_mode?: 'local' | 'cloud' }
}

export interface ToolCallLike {
  id: string
  name: string
  arguments?: unknown
  result?: unknown
  status?: string
}

export interface ToolResultLike {
  tool_use_id: string
  content: unknown
  is_error?: boolean
}

export interface ToolGroup {
  id: string
  name: string
  args?: Record<string, unknown>
  results: ToolResultLike[]
}

export type ParsedRenderItem =
  | { type: 'text'; key: string; text: string }
  | { type: 'reasoning'; key: string; text: string }
  | { type: 'tool'; key: string; group: ToolGroup }

export type HeadlessSseEvent =
  | { type: 'chunk'; part: 'text' | 'reasoning'; delta: string }
  | { type: 'chunk'; part: 'tool_call'; toolCall: ToolCallLike }
  | { type: 'chunk'; part: 'tool_result'; toolResult: ToolResultLike }
  | { type: 'tool_execution'; status: 'started' | 'completed' | 'failed'; toolCallId: string; toolName: string }
  | {
      type: 'tool_loop'
      status: 'turn_started' | 'turn_completed' | 'max_turns_reached'
      turn: number
      maxTurns: number
      continued?: boolean
    }
  | { type: 'complete'; message?: MobileMessage }
  | { type: 'error'; error: string }
  | Record<string, unknown>

export interface MobileCustomTool {
  name: string
  description: string
  enabled: boolean
  loaded: boolean
  directoryName?: string
}

export interface MobileInferenceTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export type MobileLocalFileEntry = LocalFileEntry
export type MobileLocalFileListingResponse = LocalFileListingResponse
export type MobileLocalFileSearchResponse = LocalFileSearchResponse

export type MobileProviderName = 'openaichatgpt' | 'openrouter' | 'lmstudio' | 'zai' | 'bedrock'

export interface MobileProviderModelInfo {
  name: MobileProviderName
  models: string[]
}
