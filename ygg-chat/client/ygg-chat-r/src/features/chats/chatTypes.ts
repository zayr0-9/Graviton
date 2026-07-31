import { BaseMessage, BaseModel, ConversationId, ImageConfig, MessageId, OpenAIServiceTier, ReasoningConfig } from '../../../../../shared/types'
import type { PlanClarificationRequest } from './planToolTypes'

// Message types (shared with conversations)
export interface Message extends BaseMessage {
  //media: Blob or path to file
  pastedContext: string[]
  artifacts: string[]
  //should write a function which extracts text content
  //when user drags and drops it on the input component
  // Content blocks for ex_agent messages (Claude Code responses stored chronologically)
  content_blocks?: (ThinkingBlock | ToolUseBlock | TextBlock | ToolResultBlock | ImageBlock | ReasoningDetailsBlock)[]
}

export interface miniMessage {
  content: string
  media: Blob | null
}

// Content Block types for ex_agent messages with sequential rendering
export interface ThinkingBlock {
  type: 'thinking'
  index: number
  content: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  index: number
  id: string
  name: string
  input: any
}

export interface TextBlock {
  type: 'text'
  index: number
  content: string
}

export interface ToolResultBlock {
  type: 'tool_result'
  index: number
  tool_use_id: string
  content: any
  is_error: boolean
}

export interface ImageBlock {
  type: 'image'
  index: number
  url: string
  mimeType: string
}

export interface ReasoningDetailsBlock {
  type: 'reasoning_details'
  index?: number
  reasoningDetails: Array<{
    text?: string
    type?: string
    index?: number
    format?: string
  }>
}

export type ContentBlock =
  | ThinkingBlock
  | ToolUseBlock
  | TextBlock
  | ToolResultBlock
  | ImageBlock
  | ReasoningDetailsBlock

// Tool call types
export interface ToolCall {
  id: string
  name: string
  arguments: any
  status: 'pending' | 'executing' | 'complete'
  result?: string
}

// Stream-specific types
export interface StreamChunk {
  type:
    | 'chunk'
    | 'complete'
    | 'error'
    | 'user_message'
    | 'reset'
    | 'generation_started'
    | 'tool_call'
    | 'free_generations_update'
    | 'permission_request'
  content?: string
  // delta is used for token-level updates from the server
  delta?: string
  // part distinguishes normal text from reasoning tokens from tool calls
  part?: 'text' | 'reasoning' | 'tool_call' | 'tool_result' | 'image'
  // image data for generated images
  url?: string
  mimeType?: string
  message?: Message
  error?: string
  // optional iteration index for multi-reply endpoints
  iteration?: number
  messageId?: MessageId
  // structured tool call data
  toolCall?: ToolCall
  // structured tool result data
  toolResult?: {
    tool_use_id: string
    content: any
    is_error: boolean
  }
  // free tier update data
  remaining?: number
  // tool permission request correlation id
  requestId?: string
}

// Sequential event for streaming to preserve order
export interface StreamEvent {
  type: 'text' | 'reasoning' | 'tool_call' | 'tool_result' | 'image'
  content?: string
  delta?: string
  toolCall?: ToolCall
  // Tool result from streaming (matches server ToolResultBlock)
  toolResult?: {
    tool_use_id: string
    content: any
    is_error: boolean
  }
  // Image data for generated images
  url?: string
  mimeType?: string
  // Indicates if this is a complete block (not a delta)
  complete?: boolean
}

// Stream type classification for multi-stream support
export type StreamType = 'primary' | 'subagent' | 'tool' | 'branch'

export type StreamLifecycleStatus =
  | 'idle'
  | 'active'
  | 'waiting_for_tool'
  | 'aborting'
  | 'completed'
  | 'error'

// Lineage metadata for tracking stream hierarchy (subagents, tool-spawned streams)
export interface StreamLineage {
  parentStreamId?: string        // If spawned from another stream
  rootMessageId?: MessageId      // The message whose branch this stream belongs to
  originMessageId?: MessageId    // The message that triggered this subagent/tool-run
  branchId?: string              // Optional disambiguator for branches sharing a root
}

export interface StreamState {
  active: boolean
  // Explicit lifecycle status. `waiting_for_tool` is still an in-flight stream
  // and should stay visible/interruptible in branch-local UIs.
  status: StreamLifecycleStatus
  buffer: string
  // separate buffer for reasoning/thinking tokens while streaming
  thinkingBuffer: string
  // separate array for tool calls while streaming
  toolCalls: ToolCall[]
  // sequential events log to preserve order of chunks as received
  events: StreamEvent[]
  // Legacy/latest completed message id. Kept as a branch-selection anchor.
  messageId: MessageId | null
  // Stable user message that started this stream/run. Unlike branch anchors, this
  // must not move when assistant/tool-loop turns complete.
  triggerUserMessageId: MessageId | null
  // Best current branch-row anchor for diagnostics/view matching. This can move
  // from the triggering user message to live/completed assistant messages.
  currentBranchAnchorMessageId: MessageId | null
  // Explicit message tracking for multi-turn/tool streams.
  branchAnchorMessageId: MessageId | null
  liveMessageId: MessageId | null
  lastCompletedMessageId: MessageId | null
  finalMessageId: MessageId | null
  // Incremented when stale chunks are ignored after abort/completion.
  suppressedEventCount: number
  error: string | null
  finished: boolean
  // Legacy alias for liveMessageId, preserved for existing abort/UI paths.
  streamingMessageId: MessageId | null
  // Conversation this stream belongs to (used to avoid cross-conversation UI bleed)
  conversationId: ConversationId | null
  // Lineage metadata for subagent/parallel stream support
  lineage: StreamLineage
  // Stream metadata
  createdAt: string
  streamType: StreamType
}

// Map of stream states keyed by streamId
export interface StreamStateById {
  [streamId: string]: StreamState
}

// Root state container for multi-stream support
export interface StreamingRootState {
  // Active stream IDs (in-flight)
  activeIds: string[]
  // All stream states keyed by ID
  byId: StreamStateById
  // Tracks the "primary" stream for the current view
  primaryStreamId: string | null
  // Last completed stream for bookkeeping
  lastCompletedId: string | null
}

// Action payloads for streaming actions
export interface SendingStartedPayload {
  streamId: string
  streamType?: StreamType
  conversationId?: ConversationId | null
  lineage?: StreamLineage
}

export interface StreamChunkPayload {
  streamId: string
  chunk: StreamChunk
}

export interface StreamCompletedPayload {
  streamId: string
  messageId: MessageId
  updatePath?: boolean  // Controls whether to update currentPath
}

export interface StreamingAbortedPayload {
  streamId: string
  error?: string
}

export type StreamUndoStatus = 'available' | 'restoring' | 'restored' | 'invalidated' | 'failed'

export interface StreamUndoSummary {
  streamId: string
  conversationId: string | null
  parentMessageId: string | null
  assistantMessageId?: string | null
  status: StreamUndoStatus
  createdAt: string
  updatedAt: string
  restoredAt?: string | null
  fileCount: number
  files: Array<{ path: string; absolutePath: string; sizeBytes: number; operationCount: number }>
}

export interface StreamUndoState {
  byStreamId: Record<string, StreamUndoSummary>
  streamIdsByParentMessageId: Record<string, string[]>
  streamIdsByAssistantMessageId: Record<string, string[]>
  loadingByConversationId: Record<string, boolean>
  restoringByStreamId: Record<string, boolean>
  errorByStreamId: Record<string, string | null>
}

export interface Model extends BaseModel {}

export interface Provider {
  name: string
  url: string
  description: string
}

export interface ProviderState {
  providers: Provider[]
  currentProvider: string | null
  loading: boolean
  error: string | null
}

// Message composition types
export interface ImageDraft {
  dataUrl: string
  name: string
  type: string
  size: number
  /** Durable Electron-local attachment metadata, populated before a message is sent. */
  filePath?: string
  attachmentId?: string
  sha256?: string
}

export type ImageDraftTarget =
  | { kind: 'composer' }
  | { kind: 'branch'; messageId: MessageId }

export interface MessageInput {
  content: string
  modelOverride?: string
}

export interface CompositionState {
  input: MessageInput
  sending: boolean
  compacting: boolean
  compactingConversationId: ConversationId | null
  validationError: string | null
  draftMessage: String | null
  multiReplyCount: number
  imageDrafts: ImageDraft[] // base64-encoded images + metadata from drag/drop
  imageDraftTarget: ImageDraftTarget | null // explicit owner for imageDrafts; never infer from focused message
  editingBranch: boolean // true when user is editing a branch; controls UI like hiding image drafts
  optimisticMessage: Message | null // temp message for instant UI feedback in web mode only
  optimisticBranchMessage: Message | null // temp branched message for instant UI feedback in web mode only
}

export interface ConversationState {
  currentConversationId: ConversationId | null
  focusedChatMessageId: MessageId | null
  currentPath: MessageId[] // Array of message IDs forming current branch
  messages: Message[] // Linear messages in current path order
  bookmarked: MessageId[] //each index contains id of a message selected
  excludedMessages: MessageId[] //id of each message which are NOT to be sent for chat,
  context: string
  ccCwd: string
}

// Core chat state - ONLY chat concerns
export interface ChatNode {
  id: string
  message: string
  sender: 'user' | 'assistant' | 'ex_agent'
  children: ChatNode[]
}

export interface HeimdallState {
  treeData: ChatNode | null
  subagentMap: Record<string, ChatNode[]>
  loading: boolean
  error: string | null
  compactMode: boolean
  lastFetchedAt: number | null
  lastConversationId: ConversationId | null
}

export interface InitializationState {
  loading: boolean
  error: string | null
  userId: string | null
}

export interface ToolCallPermissionRequest {
  toolCall: ToolCall
  // Set when the request originates from the server-owned loop (Phase 2): the
  // resolver thunk POSTs the decision to /api/resume keyed by these, instead of
  // resolving the in-process client-loop promise.
  streamId?: string
  toolCallId?: string
}

export type OperationMode = 'plan' | 'execute'

export interface ChatState {
  providerState: ProviderState
  composition: CompositionState
  streaming: StreamingRootState
  streamUndo: StreamUndoState
  ui: {
    modelSelectorOpen: boolean
  }
  conversation: ConversationState
  heimdall: HeimdallState
  initialization: InitializationState
  selectedNodes: MessageId[]
  attachments: AttachmentsState
  tools: tools[]
  toolCallPermissionRequest: ToolCallPermissionRequest | null
  planClarificationRequest: PlanClarificationRequest | null
  toolAutoApprove: boolean
  operationMode: OperationMode
  freeTier: {
    freeGenerationsRemaining: number | null
    showLimitModal: boolean
    isFreeTierUser: boolean
  }
  userSystemPrompts: UserSystemPromptsState
}

// Action payloads
export interface SendMessagePayload {
  conversationId: ConversationId
  input: MessageInput
  parent: MessageId
  repeatNum: number
  think: boolean
  retrigger?: boolean
  imageConfig?: ImageConfig
  reasoningConfig?: ReasoningConfig
  serviceTier?: OpenAIServiceTier
  cwd?: string | null
  // Captured at send time: 'plan' = Chat Mode, 'execute' = Agent Mode.
  operationMode?: OperationMode
}

export interface EditMessagePayload {
  conversationId: ConversationId
  originalMessageId: MessageId
  newContent: string
  modelOverride?: string
  systemPrompt?: string
  think: boolean
  serviceTier?: OpenAIServiceTier
  cwd?: string | null
  // Captured at send time: 'plan' = Chat Mode, 'execute' = Agent Mode.
  operationMode?: OperationMode
}

export interface BranchMessagePayload {
  conversationId: ConversationId
  parentId: MessageId
  content: string
  modelOverride?: string
  systemPrompt?: string
  think: boolean
  serviceTier?: OpenAIServiceTier
  cwd?: string | null
  // Captured at send time: 'plan' = Chat Mode, 'execute' = Agent Mode.
  operationMode?: OperationMode
}

export interface ModelSelectionPayload {
  model: Model
  persist?: boolean
}

// Server response types
export interface ModelsResponse {
  models: Model[]
  default: Model
}

// Re-export for backward compatibility if needed
// export type Model = string

// Attachment types (mirror server `Attachment` interface)
export interface Attachment {
  id: MessageId
  message_id: MessageId | null
  kind: 'image'
  mime_type: string
  storage: 'file' | 'url'
  url?: string | null
  file_path?: string | null
  width?: number | null
  height?: number | null
  size_bytes?: number | null
  sha256?: string | null
  created_at: string
}

export interface AttachmentsState {
  byMessage: Record<string, Attachment[]>
  // Backup of deleted image artifacts (as base64 data URLs) per message during branch editing
  backup: Record<string, string[]>
}

// Tool definitions - now defined locally in toolDefinitions.ts
// Sent with each message to the server for AI API calls
export interface ToolDefinition {
  name: string
  enabled: boolean
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }
  // Custom tool metadata (set for user-defined tools)
  isCustom?: boolean
  sourcePath?: string
  version?: string
  author?: string
  // MCP tool metadata (set for MCP server tools)
  isMcp?: boolean
  mcpServerName?: string
  mcpToolName?: string
  mcpUi?: {
    resourceUri?: string
    visibility?: Array<'model' | 'app'>
  }
  // Custom app permissions (used by iframe bridge for custom tool UIs)
  appPermissions?: {
    agent?: 'read' | 'write'
  }
  jsRuntimeMode?: 'electron' | 'custom' | 'none'
  jsRuntimes?: string
}

// Alias for backwards compatibility
export type tools = ToolDefinition

// User System Prompt types
export interface UserSystemPrompt {
  id: string
  owner_id: string
  name: string
  content: string
  description?: string | null
  is_default: boolean
  created_at: string
  updated_at: string
}

export interface UserSystemPromptsState {
  prompts: UserSystemPrompt[]
  loading: boolean
  error: string | null
}
