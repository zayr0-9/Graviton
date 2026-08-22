import type { LocalFileEntry, LocalFileListingResponse, LocalFileSearchResponse } from '../../../../../shared/localFileBrowser'
import type { HeadlessStreamFrame } from '../../../../../../../shared/headlessApi'

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
  model_name?: string | null
  note?: string | null
  content_plain_text?: string | null
  plain_text_content?: string | null
  tool_calls?: unknown
  tool_call_id?: string | null
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

/**
 * One SSE frame from the headless server.
 *
 * IMPORTED from the shared wire contract, not restated here. The previous local
 * copy declared 6 of the server's 18 event types and had drifted on two enums
 * (`tool_execution.status` was missing 'aborted'; `tool_loop.status` was missing
 * 'empty_turn_retry', 'finalization_turn' and 'provider_retry'). It also ended in
 * `| Record<string, unknown>`, which made the union absorb any object and disabled
 * narrowing for every member — so neither drift was visible to tsc.
 *
 * Handling a subset of the union is still fine: App.applyStreamEvent tests
 * `event.type` and ignores what it does not render.
 */
export type HeadlessSseEvent = HeadlessStreamFrame

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
export type MobileOperationMode = 'plan' | 'execute'
export type MobileReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

export interface MobileProviderModelInfo {
  name: MobileProviderName
  models: string[]
}
