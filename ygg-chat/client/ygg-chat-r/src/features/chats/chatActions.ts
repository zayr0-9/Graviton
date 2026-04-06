import { createAsyncThunk } from '@reduxjs/toolkit'
import type { QueryClient } from '@tanstack/react-query'
import { v4 as uuidv4 } from 'uuid'
import { estimateTokenCount } from 'tokenx'
import { ConversationId, MessageId } from '../../../../../shared/types'
import { isCommunityMode } from '../../config/runtimeMode'
import { getDefaultUserSystemPromptFromCache } from '../../hooks/useQueries'
import { dualSync } from '../../lib/sync/dualSyncManager'
import type { RootState } from '../../store/store'
import { ThunkExtraArgument } from '../../store/thunkExtra'
import {
  API_BASE,
  apiCall,
  buildLocalApiUrl,
  createStreamingRequest,
  environment,
  getCachedLocalApiBase,
  localApi,
  shouldUseLocalApi,
} from '../../utils/api'
import { convContextSet, systemPromptSet } from '../conversations/conversationSlice'
import type { Conversation } from '../conversations/conversationTypes'
import { selectSelectedProject } from '../projects/projectSelectors'
import { chatSliceActions } from './chatSlice'
import {
  Attachment,
  BranchMessagePayload,
  EditMessagePayload,
  Message,
  Model,
  OperationMode,
  SendCCBranchPayload,
  SendCCMessagePayload,
  SendHermesMessagePayload,
  SendMessagePayload,
  ToolDefinition,
} from './chatTypes'
import { createLmStudioStreamingRequest } from './LMStudio'
import { createOpenAIChatGPTStreamingRequest } from './OpenAIChatGPT'
import { openStreamingWithPreFirstByteRetry } from './streamResilience'
import { buildCompactionHistoryLines, buildCompactionWriteOpAppendix } from './compactionContext'
import { persistToolResultsWithFallback } from './toolResultPersistence'
// OpenAI OAuth is handled internally by OpenAIChatGPT module
import {
  getSubagentEnabledTools,
  isOrchestratorEnabled,
  shouldForceSubagentOpenAIProvider,
  shouldUseGlobalAgentModelForSubagentDefault,
} from '../../helpers/subagentToolSettings'
import { loadAgentSettings } from '../../helpers/agentSettingsStorage'
import { loadAutoCompactionEnabled } from '../../helpers/chatUiSettingsStorage'
import { DEFAULT_COMPACTION_SYSTEM_PROMPT, loadProviderSettings } from '../../helpers/providerSettingsStorage'
import { getDefaultBashTimeoutMs, getDefaultToolCallTimeoutMs } from '../../helpers/toolExecutionSettings'
import { updateToolEnabledState } from '../../helpers/toolSettingsStorage'
import { generateStreamId, inferStreamTypeFromId, STREAM_PRUNE_DELAY } from './streamHelpers'
import sysPromptConfig from './sys_prompt.json'
import {
  getAllTools,
  getToolsForAI,
  getToolsForOpenAIChatGPT,
  setCustomTools,
  setMcpTools,
  updateToolEnabled as updateToolEnabledInDefinitions,
} from './toolDefinitions'
import { runChatHook, type ChatHookLineage, type ChatHookTurnContext } from './chatHookClient'


// TODO: Import when conversations feature is available
// import { conversationActions } from '../conversations'

// Remote API base for syncing from cloud (Railway)
const getRemoteApiBase = (): string | null =>
  isCommunityMode ? null : (import.meta.env.VITE_API_URL || 'https://webdrasil-production.up.railway.app/api')
// Tools that should not prompt for user permission before execution.
// Server-executed tools (e.g., brave_search) are already excluded upstream.
const TOOL_PERMISSION_ALWAYS_BYPASS = new Set(['skill_manager', 'mcp_manager'])
const CUSTOM_TOOL_MANAGER_BYPASS_ACTIONS = new Set(['list', 'get', 'enable', 'disable', 'add', 'remove', 'reload', 'settings'])

const getToolCallArgsObject = (toolCall: any): Record<string, any> | null => {
  const rawArgs = toolCall?.arguments
  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    return rawArgs as Record<string, any>
  }
  if (typeof rawArgs === 'string') {
    try {
      const parsed = JSON.parse(rawArgs)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, any>
      }
    } catch {
      return null
    }
  }
  return null
}

const shouldBypassToolPermission = (toolCall: any): boolean => {
  const toolName = typeof toolCall?.name === 'string' ? toolCall.name : ''
  if (!toolName) return false
  if (TOOL_PERMISSION_ALWAYS_BYPASS.has(toolName)) return true
  if (toolName !== 'custom_tool_manager') return false

  const args = getToolCallArgsObject(toolCall)
  const action = typeof args?.action === 'string' ? args.action.trim().toLowerCase() : ''
  if (!action) return false
  return action !== 'invoke' && CUSTOM_TOOL_MANAGER_BYPASS_ACTIONS.has(action)
}

/**
 * Creates a Message object for tool results to be used in LM Studio conversation history.
 * These are ephemeral messages used only for building the API request, not persisted.
 */
const createToolResultMessage = (
  conversationId: ConversationId,
  parentId: MessageId | null,
  toolCallId: string,
  content: string
): Message => ({
  id: uuidv4(),
  conversation_id: conversationId,
  parent_id: parentId,
  children_ids: [],
  role: 'tool',
  content,
  content_plain_text: content,
  thinking_block: '',
  tool_calls: [],
  tool_call_id: toolCallId,
  content_blocks: [],
  created_at: new Date().toISOString(),
  model_name: '',
  partial: false,
  artifacts: [],
  pastedContext: [],
})

/*
The Complete Toolkit: ThunkAPI Object
When you create an async thunk, the second parameter receives what's called the ThunkAPI object.
This is like a toolbox that Redux Toolkit hands you, containing everything you need to interact with the Redux ecosystem
during async operations.
typescriptconst myAsyncThunk = createAsyncThunk(
  'feature/actionName',
  async (arg, thunkAPI) => {
    // thunkAPI contains all the utilities
    const { dispatch, getState, rejectWithValue, fulfillWithValue, signal, extra } = thunkAPI
  }
)
*/

// API base URL - configure based on environment
// const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001/api'

/**
 * Get storage_mode from React Query cache for a conversation
 * Searches all cached conversation queries (main list, project lists, etc.)
 * This is more reliable than Redux state which may not have storage_mode populated
 */
const getStorageModeFromCache = (
  queryClient: QueryClient | null,
  conversationId: ConversationId
): 'local' | 'cloud' => {
  if (!queryClient) return 'cloud'

  // Search ALL cached conversation lists
  const allConversationQueries = queryClient.getQueriesData<Conversation[]>({ queryKey: ['conversations'] })

  for (const [, data] of allConversationQueries) {
    if (Array.isArray(data)) {
      const match = data.find(c => String(c.id) === String(conversationId))
      if (match?.storage_mode) {
        return match.storage_mode
      }
    }
  }

  return 'cloud' // Default to cloud if not found
}

/**
 * Builds a ChatNode tree structure from a flat array of messages
 * Mimics server-side convertMessagesToHeimdall logic
 */
const buildTreeFromMessages = (messages: Message[]): any | null => {
  if (!messages || messages.length === 0) return null

  // Find root messages (parent_id is null/undefined)
  const rootMessages = messages.filter(msg => !msg.parent_id)
  if (rootMessages.length === 0) return null

  // Recursive function to build tree node
  const buildNode = (message: Message): any => {
    const children = messages
      .filter(msg => msg.parent_id === message.id)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .map(buildNode)

    return {
      id: message.id.toString(),
      message: message.content,
      sender: message.role === 'user' ? 'user' : message.role === 'ex_agent' ? 'ex_agent' : 'assistant',
      children,
    }
  }

  // Single root - return it directly
  if (rootMessages.length === 1) {
    return buildNode(rootMessages[0])
  }

  // Multiple roots - create synthetic root
  const rootChildren = rootMessages
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .map(buildNode)

  return {
    id: 'root',
    message: 'Conversation',
    sender: 'assistant',
    children: rootChildren,
  }
}

/**
 * Recursively adds a new message to the tree structure at the correct parent location
 * Uses parent_id to find where to insert the new message as a child
 */
const addMessageToTree = (tree: any | null, newMessage: Message, parentId: MessageId | null): any | null => {
  // No existing tree - create new root node
  if (!tree) {
    return {
      id: newMessage.id.toString(),
      message: newMessage.content,
      sender: newMessage.role === 'user' ? 'user' : newMessage.role === 'ex_agent' ? 'ex_agent' : 'assistant',
      children: [],
    }
  }

  // If this is a root message (no parent), handle specially
  if (!parentId || parentId === null) {
    // For root messages, check if tree has a synthetic root or is a single root
    if (tree.id === 'root') {
      // Synthetic root exists - add as child
      const newChild = {
        id: newMessage.id.toString(),
        message: newMessage.content,
        sender: newMessage.role === 'user' ? 'user' : newMessage.role === 'ex_agent' ? 'ex_agent' : 'assistant',
        children: [],
      }
      return {
        ...tree,
        children: [...tree.children, newChild],
      }
    } else {
      // Single root exists - create synthetic root with both
      const newChild = {
        id: newMessage.id.toString(),
        message: newMessage.content,
        sender: newMessage.role === 'user' ? 'user' : newMessage.role === 'ex_agent' ? 'ex_agent' : 'assistant',
        children: [],
      }
      return {
        id: 'root',
        message: 'Conversation',
        sender: 'assistant',
        children: [tree, newChild],
      }
    }
  }

  // Helper to recursively traverse and update tree
  const updateNode = (node: any): any => {
    // Found the parent - add new message as child
    if (node.id === parentId.toString()) {
      const newChild = {
        id: newMessage.id.toString(),
        message: newMessage.content,
        sender: newMessage.role === 'user' ? 'user' : newMessage.role === 'ex_agent' ? 'ex_agent' : 'assistant',
        children: [],
      }

      return {
        ...node,
        children: [...node.children, newChild],
      }
    }

    // Not the parent - recurse into children
    return {
      ...node,
      children: node.children.map(updateNode),
    }
  }

  return updateNode(tree)
}

/**
 * Removes deleted messages from React Query cache and rebuilds tree
 * Keeps React Query cache in sync when messages are deleted
 */
const removeMessagesFromCache = (
  queryClient: QueryClient | null,
  conversationId: ConversationId,
  deletedIds: MessageId[]
) => {
  if (!queryClient) return

  const cacheKey = ['conversations', conversationId, 'messages']
  const existingData = queryClient.getQueryData<{ messages: Message[]; tree: any }>(cacheKey)

  if (existingData) {
    const deletedSet = new Set(deletedIds.map(String))

    // Filter out deleted messages
    const remainingMessages = existingData.messages.filter(msg => !deletedSet.has(String(msg.id)))

    // Rebuild tree from remaining messages
    const newTree = buildTreeFromMessages(remainingMessages)

    queryClient.setQueryData(cacheKey, {
      messages: remainingMessages,
      tree: newTree,
    })
  }
}

/**
 * Updates an edited message in React Query cache and rebuilds tree
 * Keeps React Query cache in sync when messages are edited (not branched)
 */
const updateMessageInCache = (
  queryClient: QueryClient | null,
  conversationId: ConversationId,
  messageId: MessageId,
  updatedContent: string,
  updatedNote?: string,
  updatedNoteColor?: string | null,
  updatedContentBlocks?: any
) => {
  if (!queryClient) return

  const cacheKey = ['conversations', conversationId, 'messages']
  const existingData = queryClient.getQueryData<{ messages: Message[]; tree: any }>(cacheKey)

  if (existingData) {
    // Update the message content in the messages array
    const updatedMessages = existingData.messages.map(msg =>
      msg.id === messageId
        ? {
            ...msg,
            content: updatedContent,
            content_plain_text: updatedContent,
            ...(updatedNote !== undefined && { note: updatedNote }),
            ...(updatedNoteColor !== undefined && { note_color: updatedNoteColor }),
            ...(updatedContentBlocks && { content_blocks: updatedContentBlocks }),
          }
        : msg
    )

    // Rebuild tree from updated messages to reflect content changes
    const newTree = buildTreeFromMessages(updatedMessages)

    queryClient.setQueryData(cacheKey, {
      messages: updatedMessages,
      tree: newTree,
    })
  }
}

/**
 * Helper function to update React Query cache with new messages
 * Keeps React Query cache in sync with Redux state when messages are added via SSE stream
 * Updates both messages array AND tree structure incrementally
 */
const updateMessageCache = (queryClient: QueryClient | null, conversationId: ConversationId, newMessage: Message) => {
  if (!queryClient) return

  // Update the messages cache
  const cacheKey = ['conversations', conversationId, 'messages']
  const existingData = queryClient.getQueryData<{ messages: Message[]; tree: any }>(cacheKey)

  if (existingData) {
    const updatedMessages = [...existingData.messages, newMessage]
    const updatedTree = addMessageToTree(existingData.tree, newMessage, newMessage.parent_id ?? null)

    queryClient.setQueryData(cacheKey, {
      messages: updatedMessages,
      tree: updatedTree,
    })
  }
}

/**
 * Updates a message's artifacts in React Query cache
 * Keeps React Query cache in sync with Redux state when artifacts are appended
 * Essential for ensuring images/attachments appear immediately in sent messages
 */
const updateMessageArtifactsInCache = (
  queryClient: QueryClient | null,
  conversationId: ConversationId,
  messageId: MessageId,
  newArtifacts: string[]
) => {
  if (!queryClient || !newArtifacts.length) return

  const cacheKey = ['conversations', conversationId, 'messages']
  const existingData = queryClient.getQueryData<{ messages: Message[]; tree: any }>(cacheKey)

  if (existingData) {
    // Update the message artifacts in the messages array
    const updatedMessages = existingData.messages.map(msg =>
      msg.id === messageId ? { ...msg, artifacts: [...(msg.artifacts || []), ...newArtifacts] } : msg
    )

    queryClient.setQueryData(cacheKey, {
      messages: updatedMessages,
      tree: existingData.tree, // Tree structure doesn't need artifact updates
    })
  }
}

/**
 * Updates a project's updated_at timestamp in React Query cache
 * Called when a message is added to a conversation in this project
 * This ensures the project list reflects recent activity immediately
 */
const touchProjectTimestampInCache = (
  queryClient: QueryClient | null,
  projectId: string | null,
  userId: string | null
) => {
  if (!queryClient || !projectId) return

  const now = new Date().toISOString()

  // Update projects list cache (main list with all projects)
  const projectsCacheKey = ['projects', userId]
  const projectsData = queryClient.getQueryData<any[]>(projectsCacheKey)

  if (projectsData) {
    queryClient.setQueryData(
      projectsCacheKey,
      projectsData.map(project =>
        String(project.id) === String(projectId)
          ? { ...project, updated_at: now, latest_conversation_updated_at: now }
          : project
      )
    )
  }

  // Update individual project cache if it exists
  const projectCacheKey = ['projects', projectId]
  const projectData = queryClient.getQueryData<any>(projectCacheKey)

  if (projectData) {
    queryClient.setQueryData(projectCacheKey, {
      ...projectData,
      updated_at: now,
    })
  }
}

interface ConversationInfinitePage {
  conversations: Conversation[]
}

interface ConversationInfiniteData {
  pages: ConversationInfinitePage[]
  pageParams: unknown[]
}

const updateConversationTitleInArray = (
  conversations: Conversation[] | undefined,
  conversationId: ConversationId,
  title: string | null
): Conversation[] | undefined => {
  if (!Array.isArray(conversations)) return conversations

  return conversations.map(conv => (String(conv.id) === String(conversationId) ? { ...conv, title } : conv))
}

const updateConversationTitleInInfinite = (
  data: ConversationInfiniteData | undefined,
  conversationId: ConversationId,
  title: string | null
): ConversationInfiniteData | undefined => {
  if (!data?.pages) return data

  return {
    ...data,
    pages: data.pages.map(page => ({
      ...page,
      conversations: updateConversationTitleInArray(page.conversations, conversationId, title) || page.conversations,
    })),
  }
}

/**
 * Keep all conversation list caches in sync after title updates.
 * Includes ConversationPage's infinite-query keys.
 */
const syncConversationTitleAcrossCaches = (
  queryClient: QueryClient | null,
  updatedConversation: Conversation
): void => {
  if (!queryClient) return

  const conversationId = updatedConversation.id
  const title = updatedConversation.title ?? null

  queryClient.setQueryData<Conversation[]>(['conversations'], old =>
    updateConversationTitleInArray(old, conversationId, title)
  )

  queryClient.setQueriesData<Conversation[]>({ queryKey: ['conversations', 'recent'] }, old =>
    updateConversationTitleInArray(old, conversationId, title)
  )

  // Update both project flat lists and project infinite lists in one pass.
  queryClient.setQueriesData({ queryKey: ['conversations', 'project'] }, old => {
    if (Array.isArray(old)) {
      return updateConversationTitleInArray(old as Conversation[], conversationId, title)
    }

    if (old && typeof old === 'object' && Array.isArray((old as ConversationInfiniteData).pages)) {
      return updateConversationTitleInInfinite(old as ConversationInfiniteData, conversationId, title)
    }

    return old
  })

  queryClient.setQueryData<ConversationInfiniteData>(['conversations', 'infinite'], old =>
    updateConversationTitleInInfinite(old, conversationId, title)
  )
}

const AUTO_CONVERSATION_TITLE_MAX_CHARS = 50

const buildAutoConversationTitle = (content: string | null | undefined): string | null => {
  const normalized = typeof content === 'string' ? content.trim().replace(/\s+/g, ' ') : ''
  if (!normalized) return null
  if (normalized.length <= AUTO_CONVERSATION_TITLE_MAX_CHARS) return normalized
  return `${normalized.slice(0, AUTO_CONVERSATION_TITLE_MAX_CHARS)}...`
}

const maybePersistAutoConversationTitle = async ({
  dispatch,
  conversationId,
  storageMode,
  parentId,
  content,
  contextLabel,
  skip,
  }: {
  dispatch: any
  conversationId: ConversationId
  storageMode?: 'cloud' | 'local'
  parentId: MessageId | null | undefined
  content: string | null | undefined
  contextLabel: string
  skip?: boolean
  }): Promise<void> => {
  if (skip || parentId != null) return

  const title = buildAutoConversationTitle(content)
  if (!title) return

  try {
    await (dispatch as any)(updateConversationTitle({ id: conversationId, title, storageMode })).unwrap()
  } catch (error) {
    console.error(`[${contextLabel}] Failed to auto-update conversation title:`, error)
  }
}

// Utility function for API calls
// const apiCall = async <T>(endpoint: string, options?: RequestInit): Promise<T> => {
//   const response = await fetch(`${API_BASE}${endpoint}`, {
//     headers: {
//       'Content-Type': 'application/json',
//       ...options?.headers,
//     },
//     ...options,
//   })

//   if (!response.ok) {
//     const errorText = await response.text()
//     throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`)
//   }

//   return response.json()
// }
// Helper: detect environment
const isElectronEnvironment = environment === 'electron' || (typeof __IS_ELECTRON__ !== 'undefined' && __IS_ELECTRON__)

// Helper: convert Blob to data URL
export const blobToDataURL = (blob: Blob): Promise<string> =>
  new Promise(resolve => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.readAsDataURL(blob)
  })

// Resolve an attachment's accessible URL from url or file_path
export const resolveAttachmentUrl = (
  urlOrPath?: string | null,
  filePath?: string | null,
  attachmentId?: string | null
): string | null => {
  const origin = API_BASE.replace(/\/?api\/?$/, '')

  // Helper to detect absolute paths (Unix: /path or Windows: C:/path, D:/path, etc.)
  const isAbsoluteLocalPath = (p: string): boolean => {
    // Unix absolute path (but not server paths like /uploads or /data)
    if (p.startsWith('/') && !p.startsWith('/uploads') && !p.startsWith('/data/')) {
      return true
    }
    // Windows absolute path (C:/, D:/, etc.)
    if (/^[A-Za-z]:\//.test(p)) {
      return true
    }
    return false
  }

  // For local mode with attachment ID, use the local file serving endpoint
  // This handles absolute paths like /home/user/.config/yggdrasil/user_images/...
  // or Windows paths like C:/Users/rajka/AppData/Roaming/yggdrasil/user_images/...
  if (attachmentId && environment === 'electron' && filePath) {
    const fp = filePath.replace(/\\/g, '/')
    // Check if it's an absolute path (not a relative server path)
    if (isAbsoluteLocalPath(fp)) {
      return `${getCachedLocalApiBase()}/local/attachments/${attachmentId}/file`
    }
  }

  if (urlOrPath) {
    if (/^https?:\/\//i.test(urlOrPath)) return urlOrPath
    if (urlOrPath.startsWith('/')) return `${origin}${urlOrPath}`
  }
  if (filePath) {
    const fp = filePath.replace(/\\/g, '/')
    if (fp.startsWith('data/uploads/')) {
      const filename = fp.split('/').pop() || ''
      if (filename) return `${origin}/uploads/${filename}`
    }
    // For electron with absolute local paths but no attachment ID, we can't serve them
    if (environment === 'electron' && isAbsoluteLocalPath(fp)) {
      // Can't serve without ID, return null to indicate unavailable
      console.warn('[resolveAttachmentUrl] Local file path without attachment ID:', fp)
      return null
    }
    // Fallbacks for relative server paths only
    // Don't append absolute local paths to origin - they're not server paths
    if (isAbsoluteLocalPath(fp)) {
      console.warn('[resolveAttachmentUrl] Absolute local path in non-electron environment:', fp)
      return null
    }
    if (fp.startsWith('/')) return `${origin}${fp}`
    return `${origin}/${fp}`
  }
  return null
}

// Helper: Parse content_blocks from string or array format
const parseContentBlocks = (blocks: string | any[] | undefined): any[] => {
  if (!blocks) return []
  if (Array.isArray(blocks)) return blocks
  if (typeof blocks === 'string') {
    try {
      return JSON.parse(blocks)
    } catch {
      return []
    }
  }
  return []
}

const looksLikeHtmlString = (text: string): boolean => {
  if (!text) return false
  const trimmed = text.trimStart()
  return /^<!doctype\s+html\b/i.test(trimmed) || /^<html\b/i.test(trimmed)
}

const extractHtmlPayload = (content: any): { html: string; toolName?: string | null } | null => {
  if (!content) return null

  let resolved: any = content
  if (typeof resolved === 'string') {
    if (looksLikeHtmlString(resolved)) {
      return { html: resolved }
    }
    try {
      resolved = JSON.parse(resolved)
    } catch {
      return null
    }
  }

  if (typeof resolved === 'string') {
    if (looksLikeHtmlString(resolved)) {
      return { html: resolved }
    }
    return null
  }

  if (typeof resolved === 'object' && resolved !== null) {
    if (typeof (resolved as any).html === 'string') {
      return {
        html: (resolved as any).html,
        toolName: (resolved as any).toolName ?? (resolved as any).tool_name ?? null,
      }
    }
    if ((resolved as any).type === 'text/html' && typeof (resolved as any).content === 'string') {
      return {
        html: (resolved as any).content,
        toolName: (resolved as any).toolName ?? (resolved as any).tool_name ?? null,
      }
    }
  }

  return null
}

const getToolCallName = (tc: any): string => {
  if (!tc) return ''
  if (typeof tc.name === 'string') return tc.name
  if (typeof tc?.function?.name === 'string') return tc.function.name
  return ''
}

const buildToolNameMap = (history: Message[]): Map<string, string> => {
  const map = new Map<string, string>()
  for (const msg of history) {
    if (!msg || msg.role !== 'assistant') continue
    const toolCalls = (msg as any).tool_calls
    if (!Array.isArray(toolCalls)) continue
    for (const tc of toolCalls) {
      const id = tc?.id
      const name = getToolCallName(tc)
      if (id && name) {
        map.set(id, name)
      }
    }
  }
  return map
}

const sanitizeToolResultContentForModel = (content: any, toolName?: string | null): any => {
  const htmlPayload = extractHtmlPayload(content)
  if (htmlPayload?.html) {
    const resolvedName = toolName ?? htmlPayload.toolName ?? null
    return `displaying ${resolvedName || 'custom tool'} ui now`
  }
  return content
}

const sanitizeContentBlocksForModel = (
  blocks: string | any[] | undefined,
  toolCalls?: any[]
): string | any[] | undefined => {
  if (!blocks) return blocks
  const parsed = parseContentBlocks(blocks)
  if (parsed.length === 0) return blocks

  const toolNameById = new Map<string, string>()
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      const id = tc?.id
      const name = getToolCallName(tc)
      if (id && name) {
        toolNameById.set(id, name)
      }
    }
  }

  const sanitized = parsed.map(block => {
    if (block?.type !== 'tool_result') return block
    const toolName = typeof block.tool_use_id === 'string' ? toolNameById.get(block.tool_use_id) : null
    const sanitizedContent = sanitizeToolResultContentForModel(block.content, toolName ?? null)
    if (sanitizedContent === block.content) return block
    return { ...block, content: sanitizedContent }
  })

  if (Array.isArray(blocks)) return sanitized
  if (typeof blocks === 'string') {
    try {
      return JSON.stringify(sanitized)
    } catch {
      return blocks
    }
  }
  return blocks
}

/**
 * Resolve timeout for a tool call.
 * Priority: explicit override -> tool args -> tool metadata -> global default.
 */
const resolveToolTimeoutMs = (toolCall: any, override?: number) => {
  if (typeof override === 'number' && Number.isFinite(override)) return override

  const args = getToolCallArgsObject(toolCall)
  const argTimeout = typeof args?.timeoutMs === 'number' ? args.timeoutMs : undefined
  const metadataTimeout = typeof toolCall?.timeoutMs === 'number' ? toolCall.timeoutMs : undefined

  if (typeof argTimeout === 'number' && Number.isFinite(argTimeout)) return argTimeout
  if (typeof metadataTimeout === 'number' && Number.isFinite(metadataTimeout)) return metadataTimeout
  return getDefaultToolCallTimeoutMs()
}

const applyDefaultBashProcessTimeout = (toolCall: any, jobTimeoutMs: number) => {
  if (getToolCallName(toolCall) !== 'bash') return toolCall

  const args = getToolCallArgsObject(toolCall) ?? {}
  if (typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)) {
    return toolCall
  }

  const defaultBashTimeout = getDefaultBashTimeoutMs()
  const boundedTimeout = Math.max(1, Math.min(defaultBashTimeout, jobTimeoutMs))

  return {
    ...toolCall,
    arguments: {
      ...args,
      timeoutMs: boundedTimeout,
    },
  }
}

const resolveOpenRouterTemperature = (providerSlug: string): number | undefined => {
  if (providerSlug !== 'openrouter') return undefined
  const configured = loadProviderSettings().openRouterTemperature
  return typeof configured === 'number' ? configured : undefined
}

const appendHookAdditionalContext = (target: string[], value: string | null | undefined) => {
  if (typeof value !== 'string') return
  const trimmed = value.trim()
  if (!trimmed) return
  target.push(trimmed)
}

const buildSystemPromptWithHookContext = (
  baseSystemPrompt: string | null | undefined,
  pendingHookContextForNextTurn: string[]
): string => {
  const segments = [typeof baseSystemPrompt === 'string' ? baseSystemPrompt.trim() : ''].filter(Boolean)
  const hookContextBlocks = pendingHookContextForNextTurn
    .map(context => context.trim())
    .filter(Boolean)
    .map(context => `[Hook context]\n${context}`)

  if (hookContextBlocks.length > 0) {
    segments.push(hookContextBlocks.join('\n\n'))
  }

  return segments.join('\n\n')
}

const getAssistantMessageTextForHook = (message: any): string => {
  if (!message) return ''
  if (typeof message.content_plain_text === 'string' && message.content_plain_text.trim()) {
    return message.content_plain_text
  }
  if (typeof message.content === 'string' && message.content.trim()) {
    return message.content
  }
  return ''
}

type HookMessageLike = Pick<Message, 'id' | 'parent_id'> & { conversation_id?: ConversationId | string | null }

const getHookMessagesForConversation = (params: {
  state?: RootState | null
  queryClient?: QueryClient | null
  conversationId?: ConversationId | string | null
}): HookMessageLike[] => {
  const conversationId = params.conversationId != null ? String(params.conversationId) : null
  if (!conversationId) return []

  const cachedMessages = params.queryClient?.getQueryData<{ messages: Message[]; tree: any }>([
    'conversations',
    conversationId,
    'messages',
  ])?.messages
  if (Array.isArray(cachedMessages) && cachedMessages.length > 0) {
    return cachedMessages
  }

  const stateMessages = params.state?.chat.conversation.messages
  if (!Array.isArray(stateMessages) || stateMessages.length === 0) return []
  return stateMessages.filter(message => String(message.conversation_id) === conversationId)
}

const buildHookLineage = (params: {
  messages: HookMessageLike[]
  messageId?: MessageId | string | null
  parentId?: MessageId | string | null
}): ChatHookLineage => {
  const messageId = params.messageId != null ? String(params.messageId) : null
  const explicitParentId = params.parentId != null ? String(params.parentId) : null
  const messageById = new Map(params.messages.map(message => [String(message.id), message]))

  const ancestorIds: string[] = []
  const visited = new Set<string>()

  let cursorId: string | null = null
  let isPersistedMessage = false

  if (messageId && messageById.has(messageId)) {
    cursorId = messageId
    isPersistedMessage = true
  } else if (explicitParentId) {
    cursorId = explicitParentId
  }

  while (cursorId && !visited.has(cursorId)) {
    visited.add(cursorId)
    const message = messageById.get(cursorId)
    if (!message) break
    ancestorIds.push(String(message.id))
    cursorId = message.parent_id != null ? String(message.parent_id) : null
  }

  ancestorIds.reverse()

  const rootMessageId = ancestorIds.length > 0 ? ancestorIds[0] : null
  const isRoot = isPersistedMessage ? ancestorIds.length === 1 : explicitParentId == null
  const depth = isPersistedMessage ? Math.max(ancestorIds.length - 1, 0) : ancestorIds.length

  return {
    rootMessageId,
    ancestorIds,
    depth,
    isRoot,
  }
}

const buildHookMetadata = (params: {
  conversationId?: ConversationId | string | null
  messageId?: MessageId | string | null
  parentId?: MessageId | string | null
  state?: RootState | null
  queryClient?: QueryClient | null
  turn?: ChatHookTurnContext | null
}) => {
  const conversationId = params.conversationId != null ? String(params.conversationId) : null
  const messageId = params.messageId != null ? String(params.messageId) : null
  let parentId = params.parentId != null ? String(params.parentId) : null
  const messages = getHookMessagesForConversation({
    state: params.state,
    queryClient: params.queryClient ?? null,
    conversationId,
  })

  if (messageId && parentId == null) {
    const currentMessage = messages.find(message => String(message.id) === messageId)
    if (currentMessage?.parent_id != null) {
      parentId = String(currentMessage.parent_id)
    }
  }

  return {
    conversationId,
    messageId,
    parentId,
    lineage: buildHookLineage({ messages, messageId, parentId }),
    lookup: {
      localApiBase: getCachedLocalApiBase(),
    },
    turn: params.turn ?? undefined,
  }
}

const maybeApplyUserPromptSubmitHook = async (params: {
  conversationId: ConversationId
  streamId: string
  cwd: string | null
  provider: string
  model: string | null | undefined
  operation: 'send' | 'branch' | 'edit-branch'
  prompt: string
  pendingHookContextForNextTurn: string[]
  parentId?: MessageId | null
  state?: RootState | null
  queryClient?: QueryClient | null
}): Promise<string> => {
  const hookMetadata = buildHookMetadata({
    conversationId: params.conversationId,
    parentId: params.parentId ?? null,
    state: params.state ?? null,
    queryClient: params.queryClient ?? null,
  })

  const hookResult = await runChatHook({
    event: 'UserPromptSubmit',
    conversationId: hookMetadata.conversationId,
    streamId: params.streamId,
    cwd: params.cwd,
    provider: params.provider,
    model: params.model ?? null,
    operation: params.operation,
    prompt: params.prompt,
    messageId: hookMetadata.messageId,
    parentId: hookMetadata.parentId,
    lineage: hookMetadata.lineage,
    lookup: hookMetadata.lookup,
  })

  appendHookAdditionalContext(params.pendingHookContextForNextTurn, hookResult.additionalContext)

  if (hookResult.blocked) {
    throw new Error(hookResult.reason || 'Blocked by hook')
  }

  return typeof hookResult.updatedPrompt === 'string' ? hookResult.updatedPrompt : params.prompt
}

const shouldContinueFromStopHook = async (params: {
  conversationId: ConversationId
  streamId: string
  cwd: string | null
  provider: string
  model: string | null | undefined
  operation: 'send' | 'branch' | 'edit-branch'
  pendingHookContextForNextTurn: string[]
  lastAssistantMessage: any
  state?: RootState | null
  queryClient?: QueryClient | null
}): Promise<boolean> => {
  const lastAssistantMessage = params.lastAssistantMessage
  if (!lastAssistantMessage) return false

  const lastAssistantMessageId = lastAssistantMessage?.id != null ? String(lastAssistantMessage.id) : null
  const lastUserMessageId = lastAssistantMessage?.parent_id != null ? String(lastAssistantMessage.parent_id) : null
  const hookMetadata = buildHookMetadata({
    conversationId: params.conversationId,
    messageId: lastAssistantMessageId,
    parentId: lastUserMessageId,
    state: params.state ?? null,
    queryClient: params.queryClient ?? null,
    turn: {
      lastUserMessageId,
      lastAssistantMessageId,
    },
  })

  const hookResult = await runChatHook({
    event: 'Stop',
    conversationId: hookMetadata.conversationId,
    streamId: params.streamId,
    cwd: params.cwd,
    provider: params.provider,
    model: params.model ?? null,
    operation: params.operation,
    lastAssistantMessage: getAssistantMessageTextForHook(lastAssistantMessage),
    messageId: hookMetadata.messageId,
    parentId: hookMetadata.parentId,
    lineage: hookMetadata.lineage,
    lookup: hookMetadata.lookup,
    turn: hookMetadata.turn,
  })

  appendHookAdditionalContext(params.pendingHookContextForNextTurn, hookResult.additionalContext)

  if (hookResult.blocked) {
    appendHookAdditionalContext(
      params.pendingHookContextForNextTurn,
      hookResult.reason || 'Hook requested continued execution.'
    )
    return true
  }

  return false
}


export const AUTO_COMPACTION_NOTE = '__auto_compaction_summary__'
export const AUTO_COMPACTION_SUMMARY_RESUME_LINE = 'Following is summary of the session, you have to resume the work.'

const isAutoCompactionSummaryMessage = (msg: Message | undefined | null): boolean => {
  if (!msg) return false
  return typeof msg.note === 'string' && msg.note === AUTO_COMPACTION_NOTE
}

const ensureCompactionSummaryResumeLine = (content: string | null | undefined): string => {
  const trimmed = typeof content === 'string' ? content.trim() : ''
  if (!trimmed) return AUTO_COMPACTION_SUMMARY_RESUME_LINE
  if (trimmed.startsWith(AUTO_COMPACTION_SUMMARY_RESUME_LINE)) return trimmed
  return `${AUTO_COMPACTION_SUMMARY_RESUME_LINE}\n\n${trimmed}`
}

const getCompactionSummaryHistoryContent = (msg: Message | undefined | null): string | null => {
  if (!isAutoCompactionSummaryMessage(msg)) return null

  const rawContent =
    typeof msg?.content === 'string'
      ? msg.content
      : typeof msg?.content_plain_text === 'string'
        ? msg.content_plain_text
        : ''

  const normalized = ensureCompactionSummaryResumeLine(rawContent)
  return normalized.trim().length > 0 ? normalized : null
}

const appendCompactionSummaryToLmStudioHistory = (target: any[], msg: Message | undefined | null): boolean => {
  const content = getCompactionSummaryHistoryContent(msg)
  if (!content) return false
  target.push({ role: 'system', content })
  return true
}

const appendCompactionSummaryToOpenAIChatGPTHistory = (target: any[], msg: Message | undefined | null): boolean => {
  const content = getCompactionSummaryHistoryContent(msg)
  if (!content) return false
  target.push({ role: 'developer', content })
  return true
}

const trimHistoryToLatestCompaction = (messages: Array<Message | undefined>): Message[] => {
  const resolved = messages.filter(Boolean) as Message[]
  if (resolved.length === 0) return []

  let lastCompactionIdx = -1
  for (let i = resolved.length - 1; i >= 0; i--) {
    if (isAutoCompactionSummaryMessage(resolved[i])) {
      lastCompactionIdx = i
      break
    }
  }

  if (lastCompactionIdx < 0) return resolved
  return resolved.slice(lastCompactionIdx)
}

/**
 * Execute browse_web locally (allowed even in non-electron)
 */
const executeBrowseWebLocally = async (
  toolCall: any,
  rootPath: string | null,
  operationMode: OperationMode,
  timeoutMs: number
) => {
  try {
    const response = await fetch(await buildLocalApiUrl('/tools/execute'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        toolName: toolCall.name,
        args: toolCall.arguments,
        rootPath,
        operationMode,
        timeoutMs,
      }),
    })

    if (!response.ok) {
      throw new Error(`Tool execution failed: ${response.statusText}`)
    }

    const data = await response.json()
    return data.result
  } catch (error) {
    console.error(`browse_web execution error:`, error)
    throw error instanceof Error ? error : new Error(String(error))
  }
}

const DEFAULT_SUBAGENT_MODEL = 'openai/gpt-5.1-codex-mini'
const SUBAGENT_MAX_TURNS = 12

const normalizeProviderSlug = (providerName: string | null | undefined): string =>
  (providerName || '').toLowerCase().replace(/\s+/g, '')

const isOpenAIChatGPTProvider = (providerName: string | null | undefined): boolean => {
  const slug = normalizeProviderSlug(providerName)
  return slug === 'openaichatgpt' || slug === 'openai(chatgpt)'
}

const resolveSubagentDefaults = async (
  requestedModel: unknown,
  currentProviderName?: string | null
): Promise<{ model: string; provider?: 'openaichatgpt' }> => {
  const normalizedRequestedModel = typeof requestedModel === 'string' ? requestedModel.trim() : ''

  let defaultModel = DEFAULT_SUBAGENT_MODEL
  if (shouldUseGlobalAgentModelForSubagentDefault()) {
    try {
      const agentSettings = await loadAgentSettings()
      if (typeof agentSettings.model === 'string' && agentSettings.model.trim().length > 0) {
        defaultModel = agentSettings.model.trim()
      }
    } catch (error) {
      console.warn('[subagent] Failed to load global agent model for defaulting:', error)
    }
  }

  const forceOpenAIProvider = shouldForceSubagentOpenAIProvider() && isOpenAIChatGPTProvider(currentProviderName)
  return {
    model: normalizedRequestedModel || defaultModel,
    provider: forceOpenAIProvider ? 'openaichatgpt' : undefined,
  }
}

const shouldUseCommunityLocalEphemeral = () => isCommunityMode && isElectronEnvironment

const parseToolResultsFromContentBlocks = (contentBlocks: any): any[] => {
  if (!Array.isArray(contentBlocks)) return []

  return contentBlocks
    .filter(block => block?.type === 'tool_result' && (block?.tool_use_id || block?.toolUseId))
    .map(block => ({
      tool_use_id: block.tool_use_id || block.toolUseId,
      content:
        typeof block.content === 'string'
          ? block.content
          : block.content == null
            ? ''
            : JSON.stringify(block.content),
      is_error: Boolean(block.is_error ?? block.isError),
      tool_name: typeof block.name === 'string' ? block.name : undefined,
      input: block.input,
    }))
}

/**
 * Simple subagent execution without tool calling (fallback when context not available)
 */
const executeSimpleSubagentCall = async (toolCall: any, accessToken: string | null): Promise<string> => {
  const args = toolCall.arguments || {}
  const { prompt, model, systemPrompt, maxTokens, temperature, response_format, responseFormat } = args
  const effectiveResponseFormat = response_format ?? responseFormat

  if (!prompt) {
    throw new Error('Subagent requires a prompt')
  }

  const { model: resolvedModel, provider: resolvedProvider } = await resolveSubagentDefaults(model)

  try {
    if (shouldUseCommunityLocalEphemeral()) {
      const localPayload = await localApi.post<any>('/headless/ephemeral/chat', {
        prompt,
        provider: resolvedProvider,
        model: resolvedModel,
        maxTokens: Math.min(maxTokens || 4096, 16384),
        temperature: temperature ?? 0.7,
        systemPrompt,
        response_format: effectiveResponseFormat,
      })

      if (!localPayload?.success) {
        throw new Error(localPayload?.error || 'Community local subagent generation failed')
      }

      const fullText = typeof localPayload?.message?.content === 'string' ? localPayload.message.content : ''
      const reasoning = typeof localPayload?.reasoning === 'string' ? localPayload.reasoning : ''

      if (reasoning) {
        return `<thinking>\n${reasoning}\n</thinking>\n\n${fullText}`
      }
      return fullText || 'Subagent returned empty response'
    }
    const response = await createStreamingRequest('/generate/ephemeral', accessToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        provider: resolvedProvider,
        model: resolvedModel,
        maxTokens: Math.min(maxTokens || 4096, 16384),
        temperature: temperature ?? 0.7,
        systemPrompt,
        response_format: effectiveResponseFormat,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Subagent generation failed: HTTP ${response.status}: ${errorText}`)
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('No response body from subagent')
    }

    const decoder = new TextDecoder()
    let fullText = ''
    let reasoning = ''
    let sseBuffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      sseBuffer += chunk

      const lines = sseBuffer.split('\n')
      sseBuffer = lines.pop() || ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6)
          if (data === '[DONE]') continue
          try {
            const parsed = JSON.parse(data)
            if (parsed.text) {
              fullText += parsed.text
            } else if (parsed.reasoning) {
              reasoning += parsed.reasoning
            }
          } catch {
            if (data.trim()) {
              fullText += data
            }
          }
        }
      }
    }

    if (reasoning) {
      return `<thinking>\n${reasoning}\n</thinking>\n\n${fullText}`
    }
    return fullText || 'Subagent returned empty response'
  } catch (error) {
    console.error('[executeSimpleSubagentCall] Error:', error)
    throw error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * Convert ToolDefinition to server's expected format for openrouter
 * Server expects: { name, enabled, description, inputSchema }
 */
const convertToServerToolFormat = (tool: ToolDefinition) => ({
  name: tool.name,
  enabled: true, // Tools sent to subagent are explicitly enabled
  description: tool.description || '',
  inputSchema: tool.inputSchema || { type: 'object', properties: {} },
})

const subagentAbortControllersByStream = new Map<string, Set<AbortController>>()
const generationAbortControllersByStream = new Map<string, Set<AbortController>>()

const registerSubagentAbortController = (streamId: string | null | undefined, controller: AbortController) => {
  if (!streamId) return () => {}
  let controllers = subagentAbortControllersByStream.get(streamId)
  if (!controllers) {
    controllers = new Set()
    subagentAbortControllersByStream.set(streamId, controllers)
  }
  controllers.add(controller)
  return () => {
    const set = subagentAbortControllersByStream.get(streamId)
    if (!set) return
    set.delete(controller)
    if (set.size === 0) subagentAbortControllersByStream.delete(streamId)
  }
}

const abortSubagentControllers = (streamId?: string | null) => {
  if (streamId) {
    const controllers = subagentAbortControllersByStream.get(streamId)
    if (controllers) {
      controllers.forEach(controller => controller.abort())
      subagentAbortControllersByStream.delete(streamId)
    }
    return
  }

  for (const controllers of subagentAbortControllersByStream.values()) {
    controllers.forEach(controller => controller.abort())
  }
  subagentAbortControllersByStream.clear()
}

const registerGenerationAbortController = (streamId: string | null | undefined, controller: AbortController) => {
  if (!streamId) return () => {}
  let controllers = generationAbortControllersByStream.get(streamId)
  if (!controllers) {
    controllers = new Set()
    generationAbortControllersByStream.set(streamId, controllers)
  }
  controllers.add(controller)
  return () => {
    const set = generationAbortControllersByStream.get(streamId)
    if (!set) return
    set.delete(controller)
    if (set.size === 0) generationAbortControllersByStream.delete(streamId)
  }
}

const abortGenerationControllers = (streamId?: string | null) => {
  if (streamId) {
    const controllers = generationAbortControllersByStream.get(streamId)
    if (controllers) {
      controllers.forEach(controller => controller.abort())
      generationAbortControllersByStream.delete(streamId)
    }
    return
  }

  for (const controllers of generationAbortControllersByStream.values()) {
    controllers.forEach(controller => controller.abort())
  }
  generationAbortControllersByStream.clear()
}

/**
 * Get filtered tool definitions for subagent based on mode
 * Returns tools in server's expected format: { name, enabled, description, inputSchema }
 */
const getSubagentToolDefinitions = (
  orchestratorMode: boolean,
  requestedTools: string[] | undefined
): Array<{ name: string; enabled: boolean; description: string; inputSchema: any }> => {
  // Check if orchestrator is globally enabled
  if (!isOrchestratorEnabled()) {
    // Orchestrator disabled - subagent cannot use any tools
    return []
  }

  const allTools = getAllTools()

  // Always exclude 'subagent' to prevent recursion
  const excludedTools = new Set(['subagent'])

  let allowedToolNames: Set<string>

  if (orchestratorMode && requestedTools?.length) {
    // Orchestrator mode: use requested tools (intersection with available)
    allowedToolNames = new Set(requestedTools.filter(name => !excludedTools.has(name)))
  } else {
    // Pre-configured mode: use localStorage settings
    const configuredTools = getSubagentEnabledTools()
    allowedToolNames = new Set(configuredTools.filter(name => !excludedTools.has(name)))
  }

  // Filter and convert to OpenAI format
  // When orchestratorMode=true with explicit requestedTools, bypass the t.enabled check
  // This allows the model to request any tool regardless of global enabled state
  const bypassEnabledCheck = !!(orchestratorMode && requestedTools?.length)

  return allTools
    .filter(t => {
      const passesEnabledCheck = bypassEnabledCheck ? true : t.enabled
      return passesEnabledCheck && allowedToolNames.has(t.name) && !excludedTools.has(t.name)
    })
    .map(convertToServerToolFormat)
}

/**
 * Execute subagent tool with full agentic capabilities.
 * Supports multi-turn tool execution, message persistence, and configurable tool access.
 */
const executeSubagentCall = async (
  toolCall: any,
  accessToken: string | null,
  context: {
    dispatch: any
    getState: () => RootState
    conversationId: string
    parentMessageId: string
    streamId?: string
    rootPath: string | null
  }
): Promise<string> => {
  const args = toolCall.arguments || {}
  const {
    prompt,
    model,
    systemPrompt,
    maxTokens,
    temperature,
    response_format,
    responseFormat,
    orchestratorMode = false,
    tools: requestedTools,
    inheritAutoApprove = true,
  } = args
  const effectiveResponseFormat = response_format ?? responseFormat

  if (!prompt) {
    throw new Error('Subagent requires a prompt')
  }

  const { dispatch, getState, conversationId, parentMessageId, rootPath } = context
  const streamId = context.streamId
  const state = getState()
  const { model: resolvedModel, provider: resolvedProvider } = await resolveSubagentDefaults(
    model,
    state.chat.providerState.currentProvider
  )

  // Get filtered tool definitions for this subagent
  const subagentTools = getSubagentToolDefinitions(orchestratorMode, requestedTools)

  // Generate unique session ID for this subagent invocation
  const subagentSessionId = uuidv4()
  let hadAnyToolActivity = false

  // Build conversation history for the subagent
  const conversationHistory: any[] = [{ role: 'user', content: prompt }]

  // Persist subagent user prompt message to local storage
  const promptMessageId = uuidv4()
  const storageMode = state.conversations.items.find(c => c.id === conversationId)?.storage_mode
  const isLocalMode = shouldUseLocalApi(storageMode)

  if (isLocalMode) {
    try {
      await localApi.post('/sync/message', {
        id: promptMessageId,
        conversation_id: conversationId,
        parent_id: parentMessageId,
        role: 'ex_agent',
        content: prompt,
        ex_agent_type: 'subagent',
        ex_agent_session_id: subagentSessionId,
        created_at: new Date().toISOString(),
      })
    } catch (err) {
      console.warn('[subagent] Failed to persist prompt message:', err)
    }
  }

  let finalResponse = ''
  let lastAssistantMessageId = promptMessageId

  const subagentAbortController = new AbortController()
  const unregisterAbortController = registerSubagentAbortController(streamId, subagentAbortController)
  const isStreamActive = () => {
    if (!streamId) return true
    return getState().chat.streaming.byId[streamId]?.active ?? false
  }

  // Agentic loop with hard limit
  let shouldContinue = true
  try {
    for (let turn = 0; turn < SUBAGENT_MAX_TURNS && shouldContinue; turn++) {

      if (!isStreamActive()) {
        subagentAbortController.abort()
        throw new Error('Subagent aborted')
      }

      // Call ephemeral endpoint with tools and conversation history
      const requestBody = {
        messages: conversationHistory,
        provider: resolvedProvider,
        model: resolvedModel,
        maxTokens: Math.min(maxTokens || 4096, 16384),
        temperature: temperature ?? 0.7,
        systemPrompt,
        response_format: effectiveResponseFormat,
        tools: subagentTools.length > 0 ? subagentTools : undefined,
      }

      let response: Response
      if (shouldUseCommunityLocalEphemeral()) {
        const localPayload = await localApi.post<any>('/headless/ephemeral/chat', requestBody)
        if (!localPayload?.success) {
          throw new Error(localPayload?.error || 'Community local subagent generation failed')
        }

        const syntheticEvents: string[] = []
        if (typeof localPayload?.reasoning === 'string' && localPayload.reasoning.length > 0) {
          syntheticEvents.push(`data: ${JSON.stringify({ type: 'chunk', part: 'reasoning', delta: localPayload.reasoning })}`)
        }
        if (typeof localPayload?.message?.content === 'string' && localPayload.message.content.length > 0) {
          syntheticEvents.push(`data: ${JSON.stringify({ type: 'chunk', part: 'text', delta: localPayload.message.content })}`)
        }

        const localToolCalls = Array.isArray(localPayload?.toolCalls) ? localPayload.toolCalls : []
        for (const toolCall of localToolCalls) {
          syntheticEvents.push(`data: ${JSON.stringify({ type: 'tool_call', toolCall })}`)
        }

        const localToolResults = parseToolResultsFromContentBlocks(localPayload?.contentBlocks)
        for (const toolResult of localToolResults) {
          syntheticEvents.push(`data: ${JSON.stringify({ type: 'tool_result', toolResult })}`)
        }

        syntheticEvents.push('data: [DONE]')
        response = new Response(`${syntheticEvents.join('\n')}\n`, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      } else {
        response = await createStreamingRequest('/generate/ephemeral', accessToken, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: subagentAbortController.signal,
        })
      }

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Subagent generation failed: HTTP ${response.status}: ${errorText}`)
      }

      const reader = response.body?.getReader()
      if (!reader) {
        throw new Error('No response body from subagent')
      }

      const decoder = new TextDecoder()
      let turnText = ''
      let turnReasoning = ''
      const turnToolCalls: any[] = []
      const serverToolResults: any[] = [] // Track tool results from server-executed tools (e.g., brave_search)
      const seenToolCallIds = new Set<string>()
      const seenToolResultIds = new Set<string>()
      let sseBuffer = ''

      const appendText = (value?: any) => {
        if (typeof value === 'string' && value.length > 0) {
          turnText += value
        }
      }

      const appendReasoning = (value?: any) => {
        if (typeof value === 'string' && value.length > 0) {
          turnReasoning += value
        }
      }

      const addToolCall = (toolCall?: any) => {
        if (!toolCall) return
        if (toolCall.id && seenToolCallIds.has(toolCall.id)) return
        if (toolCall.id) seenToolCallIds.add(toolCall.id)
        turnToolCalls.push(toolCall)
      }

      const addToolResult = (toolResult?: any) => {
        if (!toolResult) return
        if (toolResult.tool_use_id && seenToolResultIds.has(toolResult.tool_use_id)) return
        if (toolResult.tool_use_id) seenToolResultIds.add(toolResult.tool_use_id)
        serverToolResults.push(toolResult)
      }

      const buildContentBlocks = (toolResults: any[], includeToolUsesForResults = false) => {
        const blocks: any[] = []
        if (turnReasoning) {
          blocks.push({ type: 'thinking', content: turnReasoning })
        }
        if (turnText) {
          blocks.push({ type: 'text', content: turnText })
        }
        for (const tc of turnToolCalls) {
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments || tc.input })
        }
        if (includeToolUsesForResults && toolResults.length > 0) {
          const existingToolUseIds = new Set(turnToolCalls.map(tc => tc.id))
          for (const tr of toolResults) {
            if (tr?.tool_use_id && !existingToolUseIds.has(tr.tool_use_id) && tr.tool_name) {
              blocks.push({
                type: 'tool_use',
                id: tr.tool_use_id,
                name: tr.tool_name,
                input: tr.input ?? tr.args ?? tr.arguments,
              })
            }
          }
        }
        for (const tr of toolResults) {
          blocks.push({
            type: 'tool_result',
            tool_use_id: tr.tool_use_id,
            content: tr.content,
            is_error: tr.is_error,
          })
        }
        return blocks
      }

      // Parse SSE stream
      while (true) {
        if (!isStreamActive()) {
          subagentAbortController.abort()
          throw new Error('Subagent aborted')
        }

        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        sseBuffer += chunk

        const lines = sseBuffer.split('\n')
        sseBuffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data === '[DONE]') continue
            try {
              const parsed = JSON.parse(data)
              if (parsed?.type === 'chunk' && parsed?.part) {
                if (parsed.part === 'text') {
                  appendText(parsed.delta ?? parsed.content ?? parsed.text)
                } else if (parsed.part === 'reasoning') {
                  appendReasoning(parsed.delta ?? parsed.reasoning)
                } else if (parsed.part === 'tool_call') {
                  addToolCall(parsed.toolCall)
                } else if (parsed.part === 'tool_result') {
                  addToolResult(parsed.toolResult)
                }
              } else if (parsed?.type === 'tool_call') {
                addToolCall(parsed.toolCall || parsed.tool_call || parsed)
              } else if (parsed?.type === 'tool_result') {
                addToolResult(parsed.toolResult || parsed.tool_result || parsed)
              } else if (parsed?.toolCall) {
                addToolCall(parsed.toolCall)
              } else if (parsed?.toolResult) {
                // Server executed a server-only tool (e.g., brave_search)
                addToolResult(parsed.toolResult)
              } else if (parsed?.reasoning) {
                appendReasoning(parsed.reasoning)
              } else if (parsed?.text) {
                appendText(parsed.text)
              } else if (parsed?.delta) {
                appendText(parsed.delta)
              } else if (parsed?.content) {
                appendText(parsed.content)
              }
            } catch {
              if (data.trim()) {
                turnText += data
              }
            }
          }
        }
      }

      // Create assistant message for this turn
      const assistantMessageId = uuidv4()
      const assistantMessage: any = {
        id: assistantMessageId,
        conversation_id: conversationId,
        parent_id: lastAssistantMessageId,
        role: 'ex_agent',
        content: turnText,
        ex_agent_type: 'subagent',
        ex_agent_session_id: subagentSessionId,
        tool_calls: turnToolCalls.length > 0 ? JSON.stringify(turnToolCalls) : null,
        thinking_block: turnReasoning || null,
        created_at: new Date().toISOString(),
      }

      // If no client tool calls AND no server tool results, this is the final response
      if (turnToolCalls.length === 0 && serverToolResults.length === 0) {
        finalResponse = turnReasoning ? `<thinking>\n${turnReasoning}\n</thinking>\n\n${turnText}` : turnText

        // Build content_blocks for final message (text only, no tool calls/results)
        const finalContentBlocks = buildContentBlocks([])
        assistantMessage.content_blocks = JSON.stringify(finalContentBlocks)

        // Persist final assistant message
        if (isLocalMode) {
          try {
            await localApi.post('/sync/message', assistantMessage)
          } catch (err) {
            console.warn('[subagent] Failed to persist final assistant message:', err)
          }
        }
        break
      }

      // If server executed tools (e.g., brave_search) but no client tools needed,
      // we need to add the server results to conversation history and continue the loop
      // so the model can process the results
      if (turnToolCalls.length === 0 && serverToolResults.length > 0) {
        const contentBlocks = buildContentBlocks(serverToolResults, true)
        assistantMessage.content_blocks = JSON.stringify(contentBlocks)

        if (isLocalMode) {
          try {
            await localApi.post('/sync/message', assistantMessage)
          } catch (err) {
            console.warn('[subagent] Failed to persist assistant message (server tools only):', err)
          }
        }

        if (turnText || turnReasoning) {
          conversationHistory.push({
            role: 'assistant',
            content: turnText || '',
          })
        }

        hadAnyToolActivity = hadAnyToolActivity || serverToolResults.length > 0

        // Add server tool results to conversation history
        // The server already added the assistant message with tool_calls and executed them
        // We just need to add the tool results so the model can continue
        for (const tr of serverToolResults) {
          conversationHistory.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: tr.content,
          })
        }

        lastAssistantMessageId = assistantMessageId
        finalResponse = turnText

        // Continue to next turn - model will process the tool results
        continue
      }

      // Process client tool calls
      const toolResults: any[] = []

      // Build a set of tool IDs that were already executed by the server
      const serverExecutedToolIds = new Set(serverToolResults.map(tr => tr.tool_use_id))
      hadAnyToolActivity = hadAnyToolActivity || serverToolResults.length > 0

      // Filter out tool calls that were already executed by the server
      const clientToolCalls = turnToolCalls.filter(tc => !serverExecutedToolIds.has(tc.id))

      for (let i = 0; i < clientToolCalls.length; i++) {
        const tc = clientToolCalls[i]

        // Skip nested subagent calls
        if (tc.name === 'subagent') {
          toolResults.push({
            tool_use_id: tc.id,
            content: 'Error: Nested subagent calls are not allowed.',
            is_error: true,
          })
          hadAnyToolActivity = true
          continue
        }

        try {
          // Read live settings per tool call so toggles apply mid-stream.
          const liveState = getState()
          const parentAutoApprove = liveState.chat.toolAutoApprove
          const liveOperationMode = liveState.chat.operationMode
          const shouldAutoApprove = inheritAutoApprove && parentAutoApprove

          let result: string
          if (shouldAutoApprove) {
            // Execute directly without permission check
            result = await executeLocalTool(tc, rootPath, liveOperationMode, {
              conversationId,
              messageId: assistantMessageId,
              accessToken,
            })
          } else {
            // Show permission dialog
            result = await executeToolWithPermissionCheck(dispatch, getState, tc, rootPath, liveOperationMode, {
              conversationId,
              messageId: assistantMessageId,
              accessToken,
            })
          }

          toolResults.push({
            tool_use_id: tc.id,
            content: result,
            is_error: false,
          })
          hadAnyToolActivity = true
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          toolResults.push({
            tool_use_id: tc.id,
            content: `Error: ${errorMsg}`,
            is_error: true,
          })
          hadAnyToolActivity = true
        }
      }

      // Combine all tool results (server-executed + client-executed)
      const allToolResults = [...serverToolResults, ...toolResults]

      // Build content_blocks with tool results
      const contentBlocks = buildContentBlocks(allToolResults)
      assistantMessage.content_blocks = JSON.stringify(contentBlocks)

      // Persist assistant message with tool calls and results
      if (isLocalMode) {
        try {
          await localApi.post('/sync/message', assistantMessage)
        } catch (err) {
          console.warn('[subagent] Failed to persist assistant message:', err)
        }
      }

      // Add assistant message with tool_calls to conversation history
      const toolCallsForHistory = turnToolCalls
        .map(tc => ({
          id: tc?.id,
          type: 'function',
          function: {
            name:
              typeof tc?.name === 'string' ? tc.name : typeof tc?.function?.name === 'string' ? tc.function.name : '',
            arguments: JSON.stringify(tc.arguments || tc.input || tc?.function?.arguments || {}),
          },
        }))
        .filter(
          (tc): tc is { id: string; type: 'function'; function: { name: string; arguments: string } } =>
            typeof tc.id === 'string' &&
            tc.id.length > 0 &&
            typeof tc.function.name === 'string' &&
            tc.function.name.length > 0
        )

      conversationHistory.push({
        role: 'assistant',
        content: turnText || '',
        tool_calls: toolCallsForHistory,
      })

      // Add each tool result as a separate 'tool' message (same format as createToolResultMessage)
      // Include both server-executed and client-executed tool results
      for (const tr of allToolResults) {
        conversationHistory.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: tr.content,
        })
      }

      lastAssistantMessageId = assistantMessageId
      finalResponse = turnText
    }
  } catch (error) {
    if (subagentAbortController.signal.aborted) {
      throw new Error('Subagent aborted')
    }
    console.error('[subagent] Error in subagent execution:', error)
    throw error
  } finally {
    unregisterAbortController()
  }

  // Deterministic finalization: if tools ran but no text response, force one more turn
  const hasFinalText = typeof finalResponse === 'string' && finalResponse.trim().length > 0

  if (hadAnyToolActivity && !hasFinalText && !subagentAbortController.signal.aborted) {
    if (!isStreamActive()) {
      subagentAbortController.abort()
      throw new Error('Subagent aborted')
    }

    // Append a finalization instruction in subagent-only context
    conversationHistory.push({
      role: 'user',
      content:
        'Summarize the tool results above and provide the final answer. Do not call tools. Be concise and complete.',
    })

    const finalizeRequestBody = {
      messages: conversationHistory,
      provider: resolvedProvider,
      model: resolvedModel,
      maxTokens: Math.min(maxTokens || 1024, 4096),
      temperature: temperature ?? 0.3,
      systemPrompt,
      tools: undefined, // Force no tool calls for finalization
    }

    let finalizeResponse: Response
    if (shouldUseCommunityLocalEphemeral()) {
      const localPayload = await localApi.post<any>('/headless/ephemeral/chat', finalizeRequestBody)
      if (!localPayload?.success) {
        throw new Error(localPayload?.error || 'Community local subagent finalization failed')
      }

      const syntheticEvents: string[] = []
      if (typeof localPayload?.reasoning === 'string' && localPayload.reasoning.length > 0) {
        syntheticEvents.push(`data: ${JSON.stringify({ type: 'chunk', part: 'reasoning', delta: localPayload.reasoning })}`)
      }
      if (typeof localPayload?.message?.content === 'string' && localPayload.message.content.length > 0) {
        syntheticEvents.push(`data: ${JSON.stringify({ type: 'chunk', part: 'text', delta: localPayload.message.content })}`)
      }
      syntheticEvents.push('data: [DONE]')

      finalizeResponse = new Response(`${syntheticEvents.join('\n')}\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    } else {
      finalizeResponse = await createStreamingRequest('/generate/ephemeral', accessToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(finalizeRequestBody),
        signal: subagentAbortController.signal,
      })
    }

    if (!finalizeResponse.ok) {
      const errorText = await finalizeResponse.text()
      throw new Error(`Subagent finalization failed: HTTP ${finalizeResponse.status}: ${errorText}`)
    }

    const finalizeReader = finalizeResponse.body?.getReader()
    if (!finalizeReader) {
      throw new Error('No response body from subagent finalization')
    }

    const finalizeDecoder = new TextDecoder()
    let finalizeText = ''
    let finalizeReasoning = ''
    let finalizeBuffer = ''

    while (true) {
      if (!isStreamActive()) {
        subagentAbortController.abort()
        throw new Error('Subagent aborted')
      }

      const { done, value } = await finalizeReader.read()
      if (done) break

      const chunk = finalizeDecoder.decode(value, { stream: true })
      finalizeBuffer += chunk

      const lines = finalizeBuffer.split('\n')
      finalizeBuffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data)
          if (parsed?.type === 'chunk' && parsed?.part) {
            if (parsed.part === 'text') {
              const delta = parsed.delta ?? parsed.content ?? parsed.text
              if (typeof delta === 'string') finalizeText += delta
            } else if (parsed.part === 'reasoning') {
              const delta = parsed.delta ?? parsed.reasoning
              if (typeof delta === 'string') finalizeReasoning += delta
            }
          } else if (parsed?.text) {
            if (typeof parsed.text === 'string') finalizeText += parsed.text
          } else if (parsed?.reasoning) {
            if (typeof parsed.reasoning === 'string') finalizeReasoning += parsed.reasoning
          } else if (parsed?.delta) {
            if (typeof parsed.delta === 'string') finalizeText += parsed.delta
          } else if (parsed?.content) {
            if (typeof parsed.content === 'string') finalizeText += parsed.content
          }
        } catch {
          if (data.trim()) {
            finalizeText += data
          }
        }
      }
    }

    const finalizeMessageId = uuidv4()
    const finalizeMessage: any = {
      id: finalizeMessageId,
      conversation_id: conversationId,
      parent_id: lastAssistantMessageId,
      role: 'ex_agent',
      content: finalizeText,
      ex_agent_type: 'subagent',
      ex_agent_session_id: subagentSessionId,
      thinking_block: finalizeReasoning || null,
      created_at: new Date().toISOString(),
    }

    const finalizeBlocks: any[] = []
    if (finalizeReasoning) finalizeBlocks.push({ type: 'thinking', content: finalizeReasoning })
    if (finalizeText) finalizeBlocks.push({ type: 'text', content: finalizeText })
    finalizeMessage.content_blocks = JSON.stringify(finalizeBlocks)

    if (isLocalMode) {
      try {
        await localApi.post('/sync/message', finalizeMessage)
      } catch (err) {
        console.warn('[subagent] Failed to persist finalization message:', err)
      }
    }

    finalResponse = finalizeReasoning
      ? `<thinking>\n${finalizeReasoning}\n</thinking>\n\n${finalizeText}`
      : finalizeText
    lastAssistantMessageId = finalizeMessageId
  }

  return finalResponse || 'No response generated'
  // legacy summary removed\n\n${finalResponse || 'No response generated'}\n\n---\nTurns: ${turnsUsed}/${maxTurns} | Tool calls: ${totalToolCallsUsed}/${maxToolCalls} | Tools: ${toolSummary}`
}

/**
 * Execute a tool via orchestrator (blocking, immediate execution)
 */
export const executeLocalTool = async (
  toolCall: any,
  rootPath: string | null,
  operationMode: OperationMode,
  context?: {
    conversationId?: string
    messageId?: string
    streamId?: string
    priority?: 'low' | 'normal' | 'high' | 'critical'
    timeoutMs?: number
    accessToken?: string | null
    // For subagent execution
    dispatch?: any
    getState?: () => RootState
  }
) => {
  const timeoutMs = resolveToolTimeoutMs(toolCall, context?.timeoutMs)
  const preparedToolCall = applyDefaultBashProcessTimeout(toolCall, timeoutMs)

  // Subagent: execute via ephemeral endpoint (works in both electron and web)
  if (preparedToolCall?.name === 'subagent') {
    if (!context?.dispatch || !context?.getState || !context?.conversationId || !context?.messageId) {
      // Fallback to simple mode if context not available
      return await executeSimpleSubagentCall(preparedToolCall, context?.accessToken ?? null)
    }
    return await executeSubagentCall(preparedToolCall, context.accessToken ?? null, {
      dispatch: context.dispatch,
      getState: context.getState,
      conversationId: context.conversationId,
      parentMessageId: context.messageId,
      streamId: context.streamId,
      rootPath,
    })
  }

  // Non-electron: only allow browse_web, otherwise bail
  if (!isElectronEnvironment) {
    if (preparedToolCall?.name === 'browse_web') {
      return await executeBrowseWebLocally(preparedToolCall, rootPath, operationMode, timeoutMs)
    }
    throw new Error('Tool execution is only available in the desktop app.')
  }

  try {
    const result = await executeToolAsJobAndWait(preparedToolCall, rootPath, operationMode, {
      conversationId: context?.conversationId,
      messageId: context?.messageId,
      streamId: context?.streamId,
      priority: context?.priority ?? 'normal',
      timeoutMs,
    })
    const action = preparedToolCall?.arguments?.action
    if (
      preparedToolCall?.name === 'mcp_manager' &&
      context?.dispatch &&
      typeof action === 'string' &&
      ['stop', 'list_tools'].includes(action) &&
      result &&
      typeof result === 'object' &&
      (result as any).success
    ) {
      setTimeout(() => {
        context.dispatch(fetchMcpTools() as any)
      }, 500)
    }
    return result
  } catch (error) {
    console.error(`Tool execution error:`, error)
    throw error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * Execute a tool as a background job (via orchestrator)
 * Returns immediately with the job ID - use toolJobManager to track progress
 */
export const submitToolAsJob = async (
  toolCall: any,
  rootPath: string | null,
  operationMode: OperationMode,
  options?: {
    conversationId?: string
    messageId?: string
    streamId?: string
    priority?: 'low' | 'normal' | 'high' | 'critical'
    timeoutMs?: number
  }
) => {
  try {
    const response = await fetch(await buildLocalApiUrl('/jobs'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        toolName: toolCall.name,
        args: toolCall.arguments,
        options: {
          rootPath,
          operationMode,
          conversationId: options?.conversationId,
          messageId: options?.messageId,
          streamId: options?.streamId,
          priority: options?.priority ?? 'normal',
          timeoutMs: options?.timeoutMs ?? getDefaultToolCallTimeoutMs(),
        },
      }),
    })

    if (!response.ok) {
      throw new Error(`Job submission failed: ${response.statusText}`)
    }

    const data = await response.json()
    if (!data.success) {
      throw new Error(data.error || 'Job submission failed')
    }

    return data.job
  } catch (error) {
    console.error(`Tool job submission error:`, error)
    throw error
  }
}

/**
 * Execute a tool as a background job and wait for completion
 * Useful for stream integration where you want managed execution but need the result
 */
export const executeToolAsJobAndWait = async (
  toolCall: any,
  rootPath: string | null,
  operationMode: OperationMode,
  options?: {
    conversationId?: string
    messageId?: string
    streamId?: string
    priority?: 'low' | 'normal' | 'high' | 'critical'
    timeoutMs?: number
  }
) => {
  try {
    const response = await fetch(await buildLocalApiUrl('/jobs/execute-and-wait'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        toolName: toolCall.name,
        args: toolCall.arguments,
        timeoutMs: options?.timeoutMs ?? getDefaultToolCallTimeoutMs(),
        options: {
          rootPath,
          operationMode,
          conversationId: options?.conversationId,
          messageId: options?.messageId,
          streamId: options?.streamId,
          priority: options?.priority ?? 'normal',
        },
      }),
    })

    const data = await response.json()

    if (data.success) {
      return data.result
    }

    throw new Error(data.error || 'Job execution failed')
  } catch (error) {
    console.error(`Tool job execution error:`, error)
    return `Error executing tool ${toolCall.name}: ${error instanceof Error ? error.message : String(error)}`
  }
}

let pendingPermissionResolve: ((allowed: boolean) => void) | null = null

const requestToolPermissionDecision = async (
  dispatch: any,
  getState: () => RootState,
  toolCall: any
): Promise<'allow_once' | 'allow_always' | 'deny'> => {
  if (getState().chat.toolAutoApprove) {
    return 'allow_always'
  }

  dispatch(chatSliceActions.toolPermissionRequested({ toolCall }))

  const allowed = await new Promise<boolean>(resolve => {
    pendingPermissionResolve = resolve
  })

  if (!allowed) {
    return 'deny'
  }

  return getState().chat.toolAutoApprove ? 'allow_always' : 'allow_once'
}

const executeToolWithPermissionCheck = async (
  dispatch: any,
  getState: any,
  toolCall: any,
  rootPath: string | null,
  operationMode: OperationMode,
  context?: {
    conversationId?: string
    messageId?: string
    streamId?: string
    priority?: 'low' | 'normal' | 'high' | 'critical'
    timeoutMs?: number
    accessToken?: string | null
    queryClient?: QueryClient | null
    enableHooks?: boolean
    provider?: string | null
    model?: string | null
    operation?: 'send' | 'branch' | 'edit-branch'
    onHookAdditionalContext?: (value: string) => void
  }
) => {
  const readLiveState = () => getState() as RootState
  let effectiveToolCall = toolCall

  const emitHookAdditionalContext = (value: string | null | undefined) => {
    if (typeof value !== 'string' || !context?.onHookAdditionalContext) return
    const trimmed = value.trim()
    if (!trimmed) return
    context.onHookAdditionalContext(trimmed)
  }

  // Extend context with dispatch/getState for subagent execution
  const extendedContext = {
    ...context,
    dispatch,
    getState,
  }

  // Always resolve operation mode at execution time so Chat/Agent toggles apply mid-stream.
  const runToolWithLiveOperationMode = async () => {
    const liveOperationMode = readLiveState().chat.operationMode ?? operationMode
    return await executeLocalTool(effectiveToolCall, rootPath, liveOperationMode, extendedContext)
  }

  try {
    if (context?.enableHooks) {
      const hookMetadata = buildHookMetadata({
        conversationId: context.conversationId ?? null,
        messageId: context.messageId ?? null,
        state: readLiveState(),
        queryClient: context.queryClient ?? null,
      })

      const preToolHook = await runChatHook({
        event: 'PreToolUse',
        conversationId: hookMetadata.conversationId,
        streamId: context.streamId ?? null,
        cwd: rootPath,
        provider: context.provider ?? null,
        model: context.model ?? null,
        operation: context.operation ?? null,
        toolCall,
        messageId: hookMetadata.messageId,
        parentId: hookMetadata.parentId,
        lineage: hookMetadata.lineage,
        lookup: hookMetadata.lookup,
      })

      emitHookAdditionalContext(preToolHook.additionalContext)

      if (preToolHook.updatedInput) {
        effectiveToolCall = {
          ...toolCall,
          arguments: preToolHook.updatedInput,
        }
      }

      if (preToolHook.permissionDecision === 'deny') {
        throw new Error(preToolHook.permissionDecisionReason || 'Tool blocked by hook')
      }
    }

    let result: any
    if (shouldBypassToolPermission(effectiveToolCall)) {
      result = await runToolWithLiveOperationMode()
    } else {
      const permissionDecision = await requestToolPermissionDecision(dispatch, readLiveState, effectiveToolCall)

      if (permissionDecision === 'deny') {
        throw new Error('Tool execution denied by user')
      }

      result = await runToolWithLiveOperationMode()
    }

    if (context?.enableHooks) {
      const hookMetadata = buildHookMetadata({
        conversationId: context.conversationId ?? null,
        messageId: context.messageId ?? null,
        state: readLiveState(),
        queryClient: context.queryClient ?? null,
      })
      const serializedResult = typeof result === 'string' ? result : JSON.stringify(result)
      const postToolHook = await runChatHook({
        event: 'PostToolUse',
        conversationId: hookMetadata.conversationId,
        streamId: context.streamId ?? null,
        cwd: rootPath,
        provider: context.provider ?? null,
        model: context.model ?? null,
        operation: context.operation ?? null,
        toolCall: effectiveToolCall,
        toolResult: serializedResult,
        messageId: hookMetadata.messageId,
        parentId: hookMetadata.parentId,
        lineage: hookMetadata.lineage,
        lookup: hookMetadata.lookup,
      })
      emitHookAdditionalContext(postToolHook.additionalContext)
    }

    return result
  } catch (error) {
    if (context?.enableHooks) {
      const hookMetadata = buildHookMetadata({
        conversationId: context.conversationId ?? null,
        messageId: context.messageId ?? null,
        state: readLiveState(),
        queryClient: context.queryClient ?? null,
      })
      const errorMessage = error instanceof Error ? error.message : String(error)
      const postToolFailureHook = await runChatHook({
        event: 'PostToolUseFailure',
        conversationId: hookMetadata.conversationId,
        streamId: context.streamId ?? null,
        cwd: rootPath,
        provider: context.provider ?? null,
        model: context.model ?? null,
        operation: context.operation ?? null,
        toolCall: effectiveToolCall,
        error: errorMessage,
        messageId: hookMetadata.messageId,
        parentId: hookMetadata.parentId,
        lineage: hookMetadata.lineage,
        lookup: hookMetadata.lookup,
      })
      emitHookAdditionalContext(postToolFailureHook.additionalContext)
    }

    throw error
  }
}

const openConversationStreamWithRetry = async (
  endpoint: string,
  accessToken: string | null,
  requestInit: RequestInit,
  context: {
    conversationId?: ConversationId | string | null
    streamId?: string | null
    controllerSignal?: AbortSignal
  }
) =>
  openStreamingWithPreFirstByteRetry({
    endpoint,
    conversationId: context.conversationId ? String(context.conversationId) : null,
    streamId: context.streamId ?? null,
    parentSignal: context.controllerSignal,
    openAttempt: signal =>
      createStreamingRequest(endpoint, accessToken, {
        ...requestInit,
        signal,
      }),
  })

const persistAssistantMessageWithFallback = async (
  dispatch: any,
  params: {
    id: MessageId
    content: string
    updatedContentBlocks: any[]
    conversationId?: ConversationId | string | null
    streamId?: string | null
    contextLabel: string
  }
) => {
  const { id, content, updatedContentBlocks, conversationId, streamId, contextLabel } = params

  await persistToolResultsWithFallback({
    attemptPersist: async () => {
      const dispatched = dispatch(
        updateMessage({
          id,
          content,
          content_blocks: updatedContentBlocks,
        }) as any
      ) as any

      if (dispatched && typeof dispatched.unwrap === 'function') {
        await dispatched.unwrap()
        return
      }

      await dispatched
    },
    updatedContentBlocks,
    conversationId: conversationId ? String(conversationId) : null,
    streamId: streamId ?? null,
    messageId: String(id),
    contextLabel,
  })

  return updatedContentBlocks
}

// Model operations have been fully migrated to React Query
// See useModels, useRecentModels, useRefreshModels, and useSelectModel in hooks/useQueries.ts
// Model selection state is now managed entirely by React Query and localStorage


interface CompactBranchPayload {
  conversationId: ConversationId
  parentMessageId: MessageId | null
  messages: Message[]
  providerName?: string | null
  modelName?: string | null
}

export const compactBranch = createAsyncThunk<
  { message: Message | null },
  CompactBranchPayload,
  { state: RootState; extra: ThunkExtraArgument }
>(
  'chat/compactBranch',
  async ({ conversationId, parentMessageId, messages, providerName, modelName }, { dispatch, getState, extra, rejectWithValue }) => {
    dispatch(chatSliceActions.compactingStarted({ conversationId }))

    try {
      const { auth } = extra
      const state = getState() as RootState

      const provider = providerName || state.chat.providerState.currentProvider || 'OpenRouter'
      const providerSlug = provider.toLowerCase().replace(/\s+/g, '')
      const isLmStudio = providerSlug === 'lmstudio'
      const isOpenAIChatGPT = providerSlug === 'openaichatgpt' || providerSlug === 'openai(chatgpt)'

      console.log('[compactBranch] start', {
        conversationId,
        parentMessageId,
        inputMessages: messages.length,
        providerName: provider,
        modelName: modelName ?? null,
        providerSlug,
      })

      const modelsData = extra.queryClient?.getQueryData<{ models: Model[]; default: Model; selected: Model }>([
        'models',
        provider,
      ])
      const resolvedModelName = modelName || modelsData?.selected?.name || modelsData?.default?.name
      if (!resolvedModelName) {
        throw new Error('No model selected for compaction')
      }

      const compactableHistory = trimHistoryToLatestCompaction(messages)
      const historyLines = buildCompactionHistoryLines(compactableHistory)
      const historyText =
        historyLines.length > 0
          ? historyLines.join('\n\n')
          : '(No non-tool conversational text remained after filtering tool outputs.)'
      const writeOpAppendix = buildCompactionWriteOpAppendix(compactableHistory)

      console.log('[compactBranch] prepared', {
        resolvedModelName,
        compactableHistoryCount: compactableHistory.length,
        historyLinesCount: historyLines.length,
        writeOpAppendixChars: writeOpAppendix.length,
      })

      if (historyLines.length === 0 && !writeOpAppendix) {
        console.log('[compactBranch] skip: no history lines or write-op appendix')
        return { message: null }
      }

      const providerSettings = loadProviderSettings()
      const compactionSystemPrompt =
        providerSettings.compactionSystemPrompt?.trim() || DEFAULT_COMPACTION_SYSTEM_PROMPT
      const compactionUserPrompt = [
        'Compact this branch context for continued conversation.',
        'Output sections:',
        '1) Objective',
        '2) Confirmed facts',
        '3) Decisions made',
        '4) Open tasks / next steps',
        '5) Risks / ambiguities',
        '',
        'Conversation history:',
        historyText,
      ].join('\n')

      let summaryText = ''

      console.log('[compactBranch] execution route', {
        provider,
        providerSlug,
        isLmStudio,
        isOpenAIChatGPT,
        usingEphemeral: !isLmStudio && !isOpenAIChatGPT,
      })

      if (isLmStudio) {
        await createLmStudioStreamingRequest(
          {
            conversationId,
            parentId: parentMessageId,
            modelName: resolvedModelName,
            systemPrompt: compactionSystemPrompt,
            messages: [
              { role: 'system', content: compactionSystemPrompt },
              { role: 'user', content: compactionUserPrompt },
            ],
            tools: [],
          },
          {
            onChunk: chunk => {
              if (chunk?.part === 'text' && typeof chunk?.delta === 'string') {
                summaryText += chunk.delta
              }
              if (chunk?.type === 'complete' && chunk?.message?.content) {
                summaryText = chunk.message.content
              }
            },
          }
        )
      } else if (isOpenAIChatGPT) {
        await createOpenAIChatGPTStreamingRequest(
          {
            conversationId,
            parentId: parentMessageId,
            modelName: resolvedModelName,
            systemPrompt: compactionSystemPrompt,
            messages: [
              { role: 'system', content: compactionSystemPrompt },
              { role: 'user', content: compactionUserPrompt },
            ],
            tools: [],
          },
          {
            onChunk: chunk => {
              if (chunk?.part === 'text' && typeof chunk?.delta === 'string') {
                summaryText += chunk.delta
              }
              if (chunk?.type === 'complete' && chunk?.message?.content) {
                summaryText = chunk.message.content
              }
            },
          }
        )
      } else {
        const response = await createStreamingRequest('/generate/ephemeral', auth.accessToken, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: resolvedModelName,
            systemPrompt: compactionSystemPrompt,
            prompt: compactionUserPrompt,
            temperature: 0.2,
            maxTokens: 1200,
          }),
        })

        if (!response.ok) {
          const text = await response.text()
          throw new Error(`Compaction request failed: HTTP ${response.status}: ${text}`)
        }

        const reader = response.body?.getReader()
        if (!reader) throw new Error('Compaction response stream missing')

        const decoder = new TextDecoder()
        let sseBuffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          sseBuffer += decoder.decode(value, { stream: true })
          const lines = sseBuffer.split('\n')
          sseBuffer = lines.pop() || ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6)
            if (data === '[DONE]') continue
            try {
              const parsed = JSON.parse(data)
              if (typeof parsed.text === 'string') {
                summaryText += parsed.text
              }
            } catch {
              if (data.trim()) summaryText += data
            }
          }
        }
      }

      const finalSummary = summaryText.trim()
      console.log('[compactBranch] summary received', {
        summaryChars: finalSummary.length,
      })
      if (!finalSummary) {
        throw new Error('Compaction returned empty summary')
      }

      const fencedWriteOpAppendix = writeOpAppendix ? `\`\`\`\n${writeOpAppendix}\n\`\`\`` : ''
      const persistedSummaryContent = ensureCompactionSummaryResumeLine(
        [finalSummary, fencedWriteOpAppendix]
          .filter(section => typeof section === 'string' && section.trim().length > 0)
          .join('\n\n')
      )

      const summaryMessage: Message = {
        id: uuidv4(),
        conversation_id: conversationId,
        parent_id: parentMessageId,
        children_ids: [],
        role: 'system',
        content: persistedSummaryContent,
        content_plain_text: persistedSummaryContent,
        thinking_block: '',
        tool_calls: [],
        content_blocks: [],
        created_at: new Date().toISOString(),
        model_name: resolvedModelName,
        partial: false,
        artifacts: [],
        pastedContext: [],
        note: AUTO_COMPACTION_NOTE,
      }

      dispatch(chatSliceActions.messageAdded(summaryMessage))
      dispatch(chatSliceActions.messageBranchCreated({ newMessage: summaryMessage }))
      updateMessageCache(extra.queryClient, conversationId, summaryMessage)

      const selectedProject = selectSelectedProject(state)
      const storageMode = getStorageModeFromCache(extra.queryClient, conversationId)

      dualSync.syncMessage({
        ...summaryMessage,
        user_id: auth.userId,
        project_id: selectedProject?.id || null,
        storage_mode: storageMode,
      })

      if (import.meta.env.VITE_ENVIRONMENT === 'electron') {
        localApi
          .post('/sync/message', {
            ...summaryMessage,
            conversation_id: conversationId,
            children_ids: summaryMessage.children_ids,
            content_blocks: summaryMessage.content_blocks,
            tool_calls: summaryMessage.tool_calls,
            user_id: auth.userId,
            owner_id: auth.userId,
            project_id: selectedProject?.id || null,
            storage_mode: storageMode,
          })
          .catch(err => console.error('[compactBranch] Failed to sync compaction message locally:', err))
      }

      console.log('[compactBranch] saved summary message', {
        messageId: summaryMessage.id,
        role: summaryMessage.role,
        note: summaryMessage.note,
        parentId: summaryMessage.parent_id,
        modelName: summaryMessage.model_name,
      })

      return { message: summaryMessage }
    } catch (error) {
      console.error('[compactBranch] failed', error)
      return rejectWithValue(error instanceof Error ? error.message : 'Failed to compact branch')
    } finally {
      dispatch(chatSliceActions.compactingFinished())
    }
  }
)

// Streaming message sending with proper error handling
export const sendMessage = createAsyncThunk<

  { messageId: MessageId | null; userMessage: any; streamId: string },
  SendMessagePayload & { streamId?: string },
  { state: RootState; extra: ThunkExtraArgument }
>(
  'chat/sendMessage',
  async (
    {
      conversationId,
      input,
      parent,
      repeatNum,
      think,
      retrigger = false,
      imageConfig,
      reasoningConfig,
      cwd,
      streamId: providedStreamId,
    },
    { dispatch, getState, extra, rejectWithValue, signal }
  ) => {
    const { auth } = extra

    // Generate or use provided stream ID
    const streamId = providedStreamId ?? generateStreamId('primary')
    const preSendState = getState() as RootState
    const preSendDrafts = preSendState.chat.composition.imageDrafts || []
    const preSendAttachmentsBase64 = preSendDrafts.length
      ? preSendDrafts.map(d => ({ dataUrl: d.dataUrl, name: d.name, type: d.type, size: d.size }))
      : null
    const preSendSelectedFilesForChat = preSendState.ideContext.selectedFilesForChat || []

    dispatch(
      chatSliceActions.sendingStarted({
        streamId,
        streamType: 'primary',
        conversationId,
        lineage: {
          rootMessageId: parent,
        },
      })
    )

    let controller: AbortController | undefined
    let unregisterGenerationAbortController = () => {}

    try {
      controller = new AbortController()
      signal.addEventListener('abort', () => controller?.abort())
      unregisterGenerationAbortController = registerGenerationAbortController(streamId, controller)

      const state = getState() as RootState
      const { messages: currentMessages } = state.chat.conversation
      const currentPathIds = state.chat.conversation.currentPath.filter(id => id !== 'root')
      const currentPathMessages = trimHistoryToLatestCompaction(
        currentPathIds.map(id => currentMessages.find(m => m.id === id))
      )
      const latestCompactionMessage = currentPathMessages.find(isAutoCompactionSummaryMessage) ?? null
      if (latestCompactionMessage) {
        const allowedParentIds = new Set(currentPathMessages.map(msg => String(msg.id)))
        const parentIsInPostCompactionPath = parent != null && allowedParentIds.has(String(parent))
        if (!parentIsInPostCompactionPath) {
          parent = latestCompactionMessage.id
        }
      }
      // Read selected model from React Query cache
      // Use original provider case for cache lookup (React Query keys are case-sensitive)
      const provider = state.chat.providerState.currentProvider
      const modelsData = extra.queryClient?.getQueryData<{
        models: Model[]
        default: Model
        selected: Model
      }>(['models', provider])
      const selectedName = modelsData?.selected?.name || modelsData?.default?.name
      const modelName = input.modelOverride || selectedName
      // Map UI provider to server provider id
      const providerRaw = state.chat.providerState.currentProvider || 'ollama'
      const appProvider = providerRaw.toLowerCase()
      const providerSlug = appProvider.replace(/\s+/g, '')
      const serverProvider = providerSlug === 'google' ? 'gemini' : providerSlug
      const openRouterTemperature = resolveOpenRouterTemperature(providerSlug)
      const isLmStudio = providerSlug === 'lmstudio'
      const isOpenAIChatGPT = providerSlug === 'openaichatgpt' || providerSlug === 'openai(chatgpt)'
      // Gather any image drafts (base64) captured before send start so UI can clear immediately.
      const attachmentsBase64 = preSendAttachmentsBase64

      // Combine system prompts in order: user default > project > conversation
      const selectedProject = selectSelectedProject(state)
      let systemPrompt = ''

      // 1. First, check for default user system prompt from React Query cache
      const defaultUserPrompt = getDefaultUserSystemPromptFromCache(extra.queryClient, auth.userId)
      if (defaultUserPrompt?.content) {
        systemPrompt = defaultUserPrompt.content
      }

      // 2. Then add project system prompt
      if (selectedProject?.system_prompt) {
        if (systemPrompt) systemPrompt += '\n\n'
        systemPrompt += selectedProject.system_prompt
      }

      // 3. Finally add conversation-specific system prompt
      if (state.conversations.systemPrompt) {
        if (systemPrompt) systemPrompt += '\n\n'
        systemPrompt += state.conversations.systemPrompt
      }
      const projectContext = selectedProject?.context || null
      const conversationContextSource = state.conversations.convContext || null
      const combinedContext =
        projectContext && conversationContextSource
          ? `${projectContext}\n\n${conversationContextSource}`
          : projectContext || conversationContextSource || null
// Get selected files for chat captured before send start so UI can clear immediately
const selectedFilesForChat = preSendSelectedFilesForChat

const conversationMeta = state.conversations.items.find(c => c.id === conversationId)
// Use React Query cache as fallback for storage mode detection (handles local conversations not yet in Redux)
const storageMode = conversationMeta?.storage_mode || getStorageModeFromCache(extra.queryClient, conversationId)
// Keep cwd for tool execution context only (do not inject cwd into system prompt)
const payloadCwd = typeof cwd === 'string' ? cwd.trim() : (cwd ?? null)
const effectiveToolRootPath = payloadCwd || conversationMeta?.cwd || state.ideContext.workspace?.rootPath || null
// Append custom tools explanation to system prompt
systemPrompt = systemPrompt + '\n\n' + sysPromptConfig.customToolsPrompt
const baseSystemPrompt = systemPrompt

// Determine execution mode
const isElectronMode =
  import.meta.env.VITE_ENVIRONMENT === 'electron' || (typeof __IS_ELECTRON__ !== 'undefined' && __IS_ELECTRON__)
// For local tool execution support (GemTools), we prefer client mode even in web environment
// This allows the client to intercept tool calls and execute them via the discovered local server endpoint.
const executionMode = 'client'
      let currentTurnHistory = [...currentPathMessages]
      const pendingHookContextForNextTurn: string[] = []
      let currentTurnContent = await maybeApplyUserPromptSubmitHook({
        conversationId,
        streamId,
        cwd: effectiveToolRootPath,
        provider: serverProvider,
        model: modelName,
        operation: 'send',
        prompt: input.content.trim(),
        pendingHookContextForNextTurn,
        parentId: parent ?? null,
        state,
        queryClient: extra.queryClient,
      })
      let continueTurn = true
      let turnCount = 0
      const MAX_TURNS = 100

      let messageId: MessageId | null = null
      let userMessage: any = null

      while (continueTurn && turnCount < MAX_TURNS) {
        turnCount++
        continueTurn = false // Default to stop unless tool calls occur
        const systemPrompt = buildSystemPromptWithHookContext(baseSystemPrompt, pendingHookContextForNextTurn)
        pendingHookContextForNextTurn.length = 0

        // Check if streaming was aborted by user (check this specific stream)
        const streamingActive = getState().chat.streaming.byId[streamId]?.active ?? false
        if (!streamingActive) {
          controller?.abort()
          break
        }

        let response = null
        let streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null
        let firstRead: ReadableStreamReadResult<Uint8Array> | null = null

        if (!modelName) {
          throw new Error('No model selected')
        }

        const shouldUseLmStudio = isElectronMode && isLmStudio
        const shouldUseOpenAIChatGPT = isElectronMode && isOpenAIChatGPT

        // For LM Studio or OpenAI ChatGPT, synthesize the user message locally on the first turn so history is not empty
        if (
          (shouldUseLmStudio || shouldUseOpenAIChatGPT) &&
          turnCount === 1 &&
          currentTurnContent &&
          currentTurnContent.trim()
        ) {
          const newUserMessage: Message = {
            id: uuidv4(),
            conversation_id: conversationId,
            parent_id: parent,
            children_ids: [],
            role: 'user',
            content: currentTurnContent,
            content_plain_text: currentTurnContent,
            thinking_block: '',
            tool_calls: [],
            content_blocks: [],
            created_at: new Date().toISOString(),
            model_name: modelName || '',
            partial: false,
            artifacts: [],
            pastedContext: [],
          }

          dispatch(chatSliceActions.messageAdded(newUserMessage))
          dispatch(chatSliceActions.messageBranchCreated({ newMessage: newUserMessage }))
          updateMessageCache(extra.queryClient, conversationId, newUserMessage)
          dispatch(chatSliceActions.optimisticMessageCleared())

          // Save to local DB if in local storage mode
          if (storageMode === 'local' && attachmentsBase64 && attachmentsBase64.length > 0) {
            localApi
              .post('/local/attachments/save-base64', {
                messageId: newUserMessage.id,
                attachments: attachmentsBase64,
              })
              .catch(err => console.error('[sendMessage][lmstudio] Failed to save local attachments:', err))
          }

          // Append draft artifacts immediately for UI parity
          if (preSendDrafts.length > 0) {
            const artifactDataUrls = preSendDrafts.map(d => d.dataUrl)
            dispatch(
              chatSliceActions.messageArtifactsAppended({
                messageId: newUserMessage.id,
                artifacts: artifactDataUrls,
              })
            )
            updateMessageArtifactsInCache(extra.queryClient, conversationId, newUserMessage.id, artifactDataUrls)
          }

          // Persist locally (dual sync still respects storage mode)
          dualSync.syncMessage({
            ...newUserMessage,
            user_id: auth.userId,
            project_id: selectedProject?.id || null,
            storage_mode: storageMode,
          })

          // Directly persist to local SQLite for LM Studio/OpenAI ChatGPT (dualSync skips local-only records)
          if ((shouldUseLmStudio || shouldUseOpenAIChatGPT) && isElectronMode) {
            const providerLabel = shouldUseLmStudio ? 'lmstudio' : 'openai-chatgpt'
            localApi
              .post('/sync/message', {
                ...newUserMessage,
                conversation_id: conversationId,
                children_ids: newUserMessage.children_ids,
                content_blocks: newUserMessage.content_blocks,
                tool_calls: newUserMessage.tool_calls,
                user_id: auth.userId,
                owner_id: auth.userId,
                project_id: selectedProject?.id || null,
                storage_mode: storageMode,
              })
              .catch(err => console.error(`[sendMessage][${providerLabel}] Failed to sync user message locally:`, err))
          }

          // Track for return payload
          userMessage = newUserMessage
          currentTurnHistory.push(newUserMessage)
          await maybePersistAutoConversationTitle({
            dispatch,
            conversationId,
            storageMode,
            parentId: newUserMessage.parent_id,
            content: newUserMessage.content_plain_text || input.content,
            contextLabel: shouldUseLmStudio ? 'sendMessage/lmstudio' : 'sendMessage/openai-chatgpt',
          })

          // CRITICAL: Update parent to user message ID so assistant reply is parented correctly
          parent = newUserMessage.id
        }

        if (repeatNum > 1 && turnCount === 1) {
          if (shouldUseLmStudio) {
            const toolNameById = buildToolNameMap(currentTurnHistory)
            const lmMessages: any[] = []
            if (systemPrompt && systemPrompt.trim()) {
              lmMessages.push({ role: 'system', content: systemPrompt })
            }
            // Build OpenAI-compatible messages from history
            for (const m of currentTurnHistory) {
              if (m.role === 'user') {
                lmMessages.push({ role: 'user', content: m.content })
              } else if (m.role === 'assistant') {
                const assistantMsg: any = { role: 'assistant', content: m.content || '' }
                if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                  assistantMsg.tool_calls = m.tool_calls.map(tc => ({
                    id: tc.id,
                    type: 'function',
                    function: {
                      name: tc.name,
                      arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}),
                    },
                  }))
                }
                lmMessages.push(assistantMsg)
              } else if (appendCompactionSummaryToLmStudioHistory(lmMessages, m)) {
                continue
              } else if (m.role === 'tool' && m.tool_call_id) {
                const toolName = toolNameById.get(m.tool_call_id)
                const sanitizedContent = sanitizeToolResultContentForModel(m.content, toolName ?? null)
                lmMessages.push({
                  role: 'tool',
                  tool_call_id: m.tool_call_id,
                  content: typeof sanitizedContent === 'string' ? sanitizedContent : JSON.stringify(sanitizedContent),
                })
              }
            }
            const trimmedTurnContent = currentTurnContent.trim()
            const lastLmMessage = currentTurnHistory[currentTurnHistory.length - 1]
            const isDuplicateUser =
              lastLmMessage?.role === 'user' &&
              typeof lastLmMessage?.content === 'string' &&
              lastLmMessage.content.trim() === trimmedTurnContent
            if (trimmedTurnContent && !isDuplicateUser) {
              lmMessages.push({ role: 'user', content: currentTurnContent })
            }

            await createLmStudioStreamingRequest(
              {
                conversationId,
                parentId: parent,
                modelName,
                systemPrompt,
                messages: lmMessages,
                tools: getAllTools(),
              },
              {
                onChunk: chunk => {
                  dispatch(chatSliceActions.streamChunkReceived({ streamId, chunk }))

                  if (chunk.part === 'tool_call' && chunk.toolCall) {
                    // Accumulate tool calls for local execution
                    const exists = currentTurnHistory.some(
                      msg =>
                        Array.isArray(msg.tool_calls) && msg.tool_calls.some((tc: any) => tc.id === chunk.toolCall.id)
                    )
                    if (!exists) {
                      // create a synthetic assistant message if needed to host tool calls
                    }
                  }

                  if (chunk.type === 'complete' && chunk.message) {
                    const assistantMsg = chunk.message
                    // Add to Redux + update branch path
                    dispatch(chatSliceActions.messageAdded(assistantMsg))
                    dispatch(chatSliceActions.messageBranchCreated({ newMessage: assistantMsg }))
                    // Sync to React Query cache
                    updateMessageCache(extra.queryClient, conversationId, assistantMsg)
                    // dualSync skips local-only records, so sync directly to local SQLite
                    localApi
                      .post('/sync/message', {
                        ...assistantMsg,
                        conversation_id: conversationId,
                        children_ids: assistantMsg.children_ids || [],
                        content_blocks: assistantMsg.content_blocks || [],
                        tool_calls: assistantMsg.tool_calls || [],
                        user_id: auth.userId,
                        owner_id: auth.userId,
                        project_id: selectedProject?.id || null,
                        storage_mode: storageMode,
                      })
                      .catch(err =>
                        console.error('[sendMessage][lmstudio repeat] Failed to sync assistant message:', err)
                      )

                    messageId = assistantMsg.id
                    currentTurnHistory.push(assistantMsg)
                  }
                },
                signal: controller.signal,
              }
            )

            // After streaming, handle tool calls (same pattern as main LM Studio path)
            const lastMsg = currentTurnHistory[currentTurnHistory.length - 1]
            const pendingToolCalls = Array.isArray(lastMsg?.tool_calls) ? lastMsg.tool_calls : []
            const isStreamActive = getState().chat.streaming.byId[streamId]?.active ?? false

            if (pendingToolCalls.length > 0 && isStreamActive) {
              const rootPath = effectiveToolRootPath
              const operationMode = state.chat.operationMode
              const toolResultBlocks: any[] = []
              let successfulTool = false

              for (const toolCall of pendingToolCalls) {
                let content: string
                let isError = false

                try {
                  const result = await executeToolWithPermissionCheck(
                    dispatch,
                    getState,
                    toolCall,
                    rootPath,
                    operationMode,
                    {
                      conversationId,
                      messageId: lastMsg.id,
                      streamId,
                      accessToken: auth.accessToken,
                      queryClient: extra.queryClient,
                      enableHooks: true,
                      provider: serverProvider,
                      model: modelName,
                      operation: 'send',
                      onHookAdditionalContext: value => appendHookAdditionalContext(pendingHookContextForNextTurn, value),
                    }
                  )
                  content = typeof result === 'string' ? result : JSON.stringify(result)
                  successfulTool = true
                } catch (error) {
                  isError = true
                  content = error instanceof Error ? error.message : String(error)
                }

                const toolResultBlock = {
                  type: 'tool_result',
                  tool_use_id: toolCall.id,
                  content,
                  is_error: isError,
                }
                toolResultBlocks.push(toolResultBlock)

                dispatch(
                  chatSliceActions.streamChunkReceived({
                    streamId,
                    chunk: {
                      type: 'chunk',
                      part: 'tool_result',
                      toolResult: { tool_use_id: toolCall.id, content, is_error: isError },
                    },
                  })
                )

                currentTurnHistory.push(createToolResultMessage(conversationId, lastMsg.id, toolCall.id, content))
              }

              if (toolResultBlocks.length > 0 && lastMsg.id) {
                const existingBlocks = Array.isArray(lastMsg.content_blocks) ? lastMsg.content_blocks : []
                const updatedContentBlocks = [...existingBlocks, ...toolResultBlocks]

                await persistAssistantMessageWithFallback(dispatch, {
                  id: lastMsg.id,
                  content: lastMsg.content,
                  updatedContentBlocks,
                  conversationId,
                  streamId,
                  contextLabel: 'sendMessage/lmstudio-repeat',
                })

                const historyIndex = currentTurnHistory.findIndex(msg => msg.id === lastMsg.id)
                if (historyIndex !== -1) {
                  currentTurnHistory[historyIndex] = {
                    ...currentTurnHistory[historyIndex],
                    content_blocks: updatedContentBlocks,
                  }
                }
              }

              currentTurnContent = ''
              parent = lastMsg.id
              continueTurn = successfulTool
            } else {
              continueTurn = false
            }

            if (!continueTurn) {
              const shouldContinueAfterStop = await shouldContinueFromStopHook({
                conversationId,
                streamId,
                cwd: effectiveToolRootPath,
                provider: serverProvider,
                model: modelName,
                operation: 'send',
                pendingHookContextForNextTurn,
                lastAssistantMessage: lastMsg,
                state: getState(),
                queryClient: extra.queryClient,
              })

              if (shouldContinueAfterStop) {
                currentTurnContent = ''
                parent = lastMsg.id
                continueTurn = true
              }
            }

            if (!continueTurn) break
            continue
          }

          // OpenAI ChatGPT: handle repeat locally via OAuth tokens
          if (shouldUseOpenAIChatGPT) {
            const toolNameById = buildToolNameMap(currentTurnHistory)
            const chatgptMessages: any[] = []
            if (systemPrompt && systemPrompt.trim()) {
              chatgptMessages.push({ role: 'system', content: systemPrompt })
            }
            for (const m of currentTurnHistory) {
              if (m.role === 'user') {
                const userContent = typeof m.content === 'string' ? m.content : String(m.content ?? '')
                const lastMessage = chatgptMessages[chatgptMessages.length - 1]
                const lastContent =
                  lastMessage?.role === 'user' && typeof lastMessage?.content === 'string' ? lastMessage.content : null
                if (lastContent && lastContent.trim() === userContent.trim()) {
                  continue
                }
                chatgptMessages.push({
                  role: 'user',
                  content: m.content,
                  artifacts: Array.isArray((m as any).artifacts) ? (m as any).artifacts : undefined,
                  content_blocks: (m as any).content_blocks,
                  attachments: (m as any).attachments,
                })
              } else if (m.role === 'assistant') {
                const assistantMsg: any = {
                  role: 'assistant',
                  content: m.content || '',
                  content_blocks: sanitizeContentBlocksForModel(m.content_blocks, m.tool_calls),
                  responses_output_items: (m as any)?.responses_output_items,
                }
                if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                  assistantMsg.tool_calls = m.tool_calls.map(tc => ({
                    id: tc.id,
                    name: tc.name,
                    arguments: tc.arguments,
                  }))
                }
                chatgptMessages.push(assistantMsg)
              } else if (appendCompactionSummaryToOpenAIChatGPTHistory(chatgptMessages, m)) {
                continue
              } else if (m.role === 'tool' && m.tool_call_id) {
                const toolName = toolNameById.get(m.tool_call_id)
                const sanitizedContent = sanitizeToolResultContentForModel(m.content, toolName ?? null)
                chatgptMessages.push({
                  role: 'tool',
                  tool_call_id: m.tool_call_id,
                  content: typeof sanitizedContent === 'string' ? sanitizedContent : JSON.stringify(sanitizedContent),
                })
              }
            }
            const trimmedTurnContent = currentTurnContent.trim()
            const lastChatGPTMessage = currentTurnHistory[currentTurnHistory.length - 1]
            const isDuplicateUser =
              lastChatGPTMessage?.role === 'user' &&
              typeof lastChatGPTMessage?.content === 'string' &&
              lastChatGPTMessage.content.trim() === trimmedTurnContent
            if (trimmedTurnContent && !isDuplicateUser) {
              chatgptMessages.push({ role: 'user', content: currentTurnContent })
            }

            await createOpenAIChatGPTStreamingRequest(
              {
                conversationId,
                parentId: parent,
                modelName,
                systemPrompt,
                messages: chatgptMessages,
                attachmentsBase64: turnCount === 1 ? attachmentsBase64 : undefined,
                tools: getToolsForOpenAIChatGPT(),
                reasoningConfig,
              },
              {
                onChunk: chunk => {
                  dispatch(chatSliceActions.streamChunkReceived({ streamId, chunk }))
                  if (chunk.type === 'complete' && chunk.message) {
                    const assistantMsg = chunk.message
                    dispatch(chatSliceActions.messageAdded(assistantMsg))
                    dispatch(chatSliceActions.messageBranchCreated({ newMessage: assistantMsg }))
                    updateMessageCache(extra.queryClient, conversationId, assistantMsg)
                    localApi
                      .post('/sync/message', {
                        ...assistantMsg,
                        conversation_id: conversationId,
                        children_ids: assistantMsg.children_ids || [],
                        content_blocks: assistantMsg.content_blocks || [],
                        tool_calls: assistantMsg.tool_calls || [],
                        user_id: auth.userId,
                        owner_id: auth.userId,
                        project_id: selectedProject?.id || null,
                        storage_mode: storageMode,
                      })
                      .catch(err =>
                        console.error('[sendMessage][openai-chatgpt repeat] Failed to sync assistant message:', err)
                      )
                    messageId = assistantMsg.id
                    currentTurnHistory.push(assistantMsg)
                    // Keep current streaming UI until the next generation_started event clears it.
                  }
                },
                signal: controller.signal,
              }
            )

            // Handle tool calls
            const lastMsg = currentTurnHistory[currentTurnHistory.length - 1]
            const pendingToolCalls = Array.isArray(lastMsg?.tool_calls) ? lastMsg.tool_calls : []
            const isStreamActive = getState().chat.streaming.byId[streamId]?.active ?? false

            if (pendingToolCalls.length > 0 && isStreamActive) {
              const rootPath = effectiveToolRootPath
              const operationMode = state.chat.operationMode
              const toolResultBlocks: any[] = []
              let successfulTool = false

              for (const toolCall of pendingToolCalls) {
                let content: string
                let isError = false
                try {
                  const result = await executeToolWithPermissionCheck(
                    dispatch,
                    getState,
                    toolCall,
                    rootPath,
                    operationMode,
                    {
                      conversationId,
                      messageId: lastMsg.id,
                      streamId,
                      accessToken: auth.accessToken,
                      queryClient: extra.queryClient,
                      enableHooks: true,
                      provider: serverProvider,
                      model: modelName,
                      operation: 'send',
                      onHookAdditionalContext: value => appendHookAdditionalContext(pendingHookContextForNextTurn, value),
                    }
                  )
                  content = typeof result === 'string' ? result : JSON.stringify(result)
                  successfulTool = true
                } catch (error) {
                  isError = true
                  content = error instanceof Error ? error.message : String(error)
                }

                toolResultBlocks.push({
                  type: 'tool_result',
                  tool_use_id: toolCall.id,
                  content,
                  is_error: isError,
                })

                dispatch(
                  chatSliceActions.streamChunkReceived({
                    streamId,
                    chunk: {
                      type: 'chunk',
                      part: 'tool_result',
                      toolResult: { tool_use_id: toolCall.id, content, is_error: isError },
                    },
                  })
                )

                currentTurnHistory.push(createToolResultMessage(conversationId, lastMsg.id, toolCall.id, content))
              }

              if (toolResultBlocks.length > 0 && lastMsg.id) {
                const existingBlocks = Array.isArray(lastMsg.content_blocks) ? lastMsg.content_blocks : []
                const updatedContentBlocks = [...existingBlocks, ...toolResultBlocks]

                await persistAssistantMessageWithFallback(dispatch, {
                  id: lastMsg.id,
                  content: lastMsg.content,
                  updatedContentBlocks,
                  conversationId,
                  streamId,
                  contextLabel: 'sendMessage/openai-repeat',
                })

                const historyIndex = currentTurnHistory.findIndex(msg => msg.id === lastMsg.id)
                if (historyIndex !== -1) {
                  currentTurnHistory[historyIndex] = {
                    ...currentTurnHistory[historyIndex],
                    content_blocks: updatedContentBlocks,
                  }
                }
              }

              currentTurnContent = ''
              parent = lastMsg.id
              continueTurn = successfulTool
            } else {
              continueTurn = false
            }

            if (!continueTurn) {
              const shouldContinueAfterStop = await shouldContinueFromStopHook({
                conversationId,
                streamId,
                cwd: effectiveToolRootPath,
                provider: serverProvider,
                model: modelName,
                operation: 'send',
                pendingHookContextForNextTurn,
                lastAssistantMessage: lastMsg,
                state: getState(),
                queryClient: extra.queryClient,
              })

              if (shouldContinueAfterStop) {
                currentTurnContent = ''
                parent = lastMsg.id
                continueTurn = true
              }
            }

            if (!continueTurn) break
            continue
          }

          // Cloud server handles LLM generation; storageMode in body tells it whether to save to cloud DB
          const endpoint = `/conversations/${conversationId}/messages/repeat`
          const toolNameById = buildToolNameMap(currentTurnHistory)

          const streamOpen = await openConversationStreamWithRetry(
            endpoint,
            auth.accessToken,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                messages: currentTurnHistory.map(m => {
                  const contentBlocks = sanitizeContentBlocksForModel(m.content_blocks, m.tool_calls)
                  if (m.role === 'tool' && m.tool_call_id) {
                    const toolName = toolNameById.get(m.tool_call_id) ?? null
                    const sanitizedContent = sanitizeToolResultContentForModel(m.content, toolName)
                    if (sanitizedContent !== m.content) {
                      const contentPlain =
                        typeof sanitizedContent === 'string' ? sanitizedContent : JSON.stringify(sanitizedContent)
                      return {
                        id: m.id,
                        conversation_id: m.conversation_id,
                        parent_id: m.parent_id,
                        children_ids: m.children_ids,
                        role: m.role,
                        thinking_block: m.thinking_block,
                        tool_calls: m.tool_calls,
                        content_blocks: contentBlocks,
                        content: sanitizedContent,
                        content_plain_text: contentPlain,
                        created_at: m.created_at,
                        model_name: m.model_name,
                        partial: m.partial,
                        artifacts: m.artifacts,
                      }
                    }
                  }
                  return {
                    id: m.id,
                    conversation_id: m.conversation_id,
                    parent_id: m.parent_id,
                    children_ids: m.children_ids,
                    role: m.role,
                    thinking_block: m.thinking_block,
                    tool_calls: m.tool_calls,
                    content_blocks: contentBlocks,
                    content: m.content,
                    content_plain_text: m.content_plain_text,
                    created_at: m.created_at,
                    model_name: m.model_name,
                    partial: m.partial,
                    artifacts: m.artifacts,
                  }
                }),
                content: currentTurnContent,
                modelName: modelName,
                // parentId: (currentPath && currentPath.length ? currentPath[currentPath.length - 1] : currentMessages?.at(-1)?.id) || undefined,
                parentId: parent,
                systemPrompt: systemPrompt,
                conversationContext: combinedContext,
                projectContext,
                provider: serverProvider,
                ...(openRouterTemperature !== undefined ? { temperature: openRouterTemperature } : {}),
                repeatNum: repeatNum,
                attachmentsBase64,
                selectedFiles: selectedFilesForChat,
                think,
                retrigger,
                executionMode,
                storageMode,
                isElectron: isElectronMode,
                imageConfig,
                reasoningConfig,
                tools: getToolsForAI(),
              }),
              signal: controller.signal,
            },
            {
              conversationId,
              streamId,
              controllerSignal: controller.signal,
            }
          )
          response = streamOpen.response
          streamReader = streamOpen.reader
          firstRead = streamOpen.firstRead
        } else {
          if (shouldUseLmStudio) {
            const toolNameById = buildToolNameMap(currentTurnHistory)
            const lmMessages: any[] = []
            if (systemPrompt && systemPrompt.trim()) {
              lmMessages.push({ role: 'system', content: systemPrompt })
            }
            // Build OpenAI-compatible messages from history
            for (const m of currentTurnHistory) {
              if (m.role === 'user') {
                lmMessages.push({ role: 'user', content: m.content })
              } else if (m.role === 'assistant') {
                // Assistant message - include tool_calls if present
                const assistantMsg: any = { role: 'assistant', content: m.content || '' }
                if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                  assistantMsg.tool_calls = m.tool_calls.map(tc => ({
                    id: tc.id,
                    type: 'function',
                    function: {
                      name: tc.name,
                      arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}),
                    },
                  }))
                }
                lmMessages.push(assistantMsg)
              } else if (appendCompactionSummaryToLmStudioHistory(lmMessages, m)) {
                continue
              } else if (m.role === 'tool' && m.tool_call_id) {
                // Tool result message
                const toolName = toolNameById.get(m.tool_call_id)
                const sanitizedContent = sanitizeToolResultContentForModel(m.content, toolName ?? null)
                lmMessages.push({
                  role: 'tool',
                  tool_call_id: m.tool_call_id,
                  content: typeof sanitizedContent === 'string' ? sanitizedContent : JSON.stringify(sanitizedContent),
                })
              }
            }
            const trimmedTurnContent = currentTurnContent.trim()
            const lastLmMessage = currentTurnHistory[currentTurnHistory.length - 1]
            const isDuplicateUser =
              lastLmMessage?.role === 'user' &&
              typeof lastLmMessage?.content === 'string' &&
              lastLmMessage.content.trim() === trimmedTurnContent
            if (trimmedTurnContent && !isDuplicateUser) {
              lmMessages.push({ role: 'user', content: currentTurnContent })
            }

            await createLmStudioStreamingRequest(
              {
                conversationId,
                parentId: parent,
                modelName,
                systemPrompt,
                messages: lmMessages,
                tools: getAllTools(),
              },
              {
                onChunk: chunk => {
                  dispatch(chatSliceActions.streamChunkReceived({ streamId, chunk }))
                  if (chunk.type === 'complete' && chunk.message) {
                    // Add to Redux + update branch path
                    dispatch(chatSliceActions.messageAdded(chunk.message))
                    dispatch(chatSliceActions.messageBranchCreated({ newMessage: chunk.message }))
                    // Sync to React Query cache
                    updateMessageCache(extra.queryClient, conversationId, chunk.message)
                    // dualSync skips local-only records, so sync directly to local SQLite
                    localApi
                      .post('/sync/message', {
                        ...chunk.message,
                        conversation_id: conversationId,
                        children_ids: chunk.message.children_ids || [],
                        content_blocks: chunk.message.content_blocks || [],
                        tool_calls: chunk.message.tool_calls || [],
                        user_id: auth.userId,
                        owner_id: auth.userId,
                        project_id: selectedProject?.id || null,
                        storage_mode: storageMode,
                      })
                      .catch(err => console.error('[sendMessage][lmstudio] Failed to sync assistant message:', err))
                    messageId = chunk.message.id
                    currentTurnContent = ''
                    currentTurnHistory.push(chunk.message)
                    // Keep current streaming UI until the next generation_started event clears it.
                  }
                },
                signal: controller.signal,
              }
            )

            // After LM Studio streaming, check for tool calls and execute them (same as non-LM Studio client mode)
            const lastMsg = currentTurnHistory[currentTurnHistory.length - 1]
            const pendingToolCalls = Array.isArray(lastMsg?.tool_calls) ? lastMsg.tool_calls : []
            const isStreamActive = getState().chat.streaming.byId[streamId]?.active ?? false

            if (pendingToolCalls.length > 0 && isStreamActive) {
              const rootPath = effectiveToolRootPath
              const operationMode = state.chat.operationMode
              const toolResultBlocks: any[] = []
              let successfulTool = false

              for (const toolCall of pendingToolCalls) {
                let content: string
                let isError = false

                try {
                  const result = await executeToolWithPermissionCheck(
                    dispatch,
                    getState,
                    toolCall,
                    rootPath,
                    operationMode,
                    {
                      conversationId,
                      messageId: lastMsg.id,
                      streamId,
                      accessToken: auth.accessToken,
                      queryClient: extra.queryClient,
                      enableHooks: true,
                      provider: serverProvider,
                      model: modelName,
                      operation: 'send',
                      onHookAdditionalContext: value => appendHookAdditionalContext(pendingHookContextForNextTurn, value),
                    }
                  )
                  content = typeof result === 'string' ? result : JSON.stringify(result)
                  successfulTool = true
                } catch (error) {
                  isError = true
                  content = error instanceof Error ? error.message : String(error)
                }

                const toolResultBlock = {
                  type: 'tool_result',
                  tool_use_id: toolCall.id,
                  content,
                  is_error: isError,
                }
                toolResultBlocks.push(toolResultBlock)

                // Dispatch tool result event for UI
                dispatch(
                  chatSliceActions.streamChunkReceived({
                    streamId,
                    chunk: {
                      type: 'chunk',
                      part: 'tool_result',
                      toolResult: {
                        tool_use_id: toolCall.id,
                        content,
                        is_error: isError,
                      },
                    },
                  })
                )

                // Add tool result to history for next LM Studio request
                currentTurnHistory.push(createToolResultMessage(conversationId, lastMsg.id, toolCall.id, content))
              }

              // Update assistant message with tool results (like non-LM Studio flow)
              if (toolResultBlocks.length > 0 && lastMsg.id) {
                const existingBlocks = Array.isArray(lastMsg.content_blocks) ? lastMsg.content_blocks : []
                const updatedContentBlocks = [...existingBlocks, ...toolResultBlocks]

                await persistAssistantMessageWithFallback(dispatch, {
                  id: lastMsg.id,
                  content: lastMsg.content,
                  updatedContentBlocks,
                  conversationId,
                  streamId,
                  contextLabel: 'sendMessage/lmstudio',
                })

                // Update in currentTurnHistory
                const historyIndex = currentTurnHistory.findIndex(msg => msg.id === lastMsg.id)
                if (historyIndex !== -1) {
                  currentTurnHistory[historyIndex] = {
                    ...currentTurnHistory[historyIndex],
                    content_blocks: updatedContentBlocks,
                  }
                }
              }

              // Prepare for next turn
              currentTurnContent = ''
              parent = lastMsg.id
              continueTurn = successfulTool
            } else {
              continueTurn = false
            }

            if (!continueTurn) {
              const shouldContinueAfterStop = await shouldContinueFromStopHook({
                conversationId,
                streamId,
                cwd: effectiveToolRootPath,
                provider: serverProvider,
                model: modelName,
                operation: 'send',
                pendingHookContextForNextTurn,
                lastAssistantMessage: lastMsg,
                state: getState(),
                queryClient: extra.queryClient,
              })

              if (shouldContinueAfterStop) {
                currentTurnContent = ''
                parent = lastMsg.id
                continueTurn = true
              }
            }

            if (!continueTurn) break
            continue
          }

          // OpenAI ChatGPT: handle locally via OAuth tokens (personal use only)
          if (shouldUseOpenAIChatGPT) {
            const toolNameById = buildToolNameMap(currentTurnHistory)
            const chatgptMessages: any[] = []
            if (systemPrompt && systemPrompt.trim()) {
              chatgptMessages.push({ role: 'system', content: systemPrompt })
            }
            // Build OpenAI-compatible messages from history
            for (const m of currentTurnHistory) {
              if (m.role === 'user') {
                chatgptMessages.push({
                  role: 'user',
                  content: m.content,
                  artifacts: Array.isArray((m as any).artifacts) ? (m as any).artifacts : undefined,
                  content_blocks: (m as any).content_blocks,
                  attachments: (m as any).attachments,
                })
              } else if (m.role === 'assistant') {
                const assistantMsg: any = {
                  role: 'assistant',
                  content: m.content || '',
                  content_blocks: sanitizeContentBlocksForModel(m.content_blocks, m.tool_calls),
                  responses_output_items: (m as any)?.responses_output_items,
                }
                if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                  assistantMsg.tool_calls = m.tool_calls.map(tc => ({
                    id: tc.id,
                    name: tc.name,
                    arguments: tc.arguments,
                  }))
                }
                chatgptMessages.push(assistantMsg)
              } else if (appendCompactionSummaryToOpenAIChatGPTHistory(chatgptMessages, m)) {
                continue
              } else if (m.role === 'tool' && m.tool_call_id) {
                const toolName = toolNameById.get(m.tool_call_id)
                const sanitizedContent = sanitizeToolResultContentForModel(m.content, toolName ?? null)
                chatgptMessages.push({
                  role: 'tool',
                  tool_call_id: m.tool_call_id,
                  content: typeof sanitizedContent === 'string' ? sanitizedContent : JSON.stringify(sanitizedContent),
                })
              }
            }
            const trimmedTurnContent = currentTurnContent.trim()
            const lastChatGPTMessage = currentTurnHistory[currentTurnHistory.length - 1]
            const isDuplicateUser =
              lastChatGPTMessage?.role === 'user' &&
              typeof lastChatGPTMessage?.content === 'string' &&
              lastChatGPTMessage.content.trim() === trimmedTurnContent
            if (trimmedTurnContent && !isDuplicateUser) {
              chatgptMessages.push({ role: 'user', content: currentTurnContent })
            }

            await createOpenAIChatGPTStreamingRequest(
              {
                conversationId,
                parentId: parent,
                modelName,
                systemPrompt,
                messages: chatgptMessages,
                attachmentsBase64: turnCount === 1 ? attachmentsBase64 : undefined,
                tools: getToolsForOpenAIChatGPT(),
                reasoningConfig,
              },
              {
                onChunk: chunk => {
                  dispatch(chatSliceActions.streamChunkReceived({ streamId, chunk }))
                  if (chunk.type === 'complete' && chunk.message) {
                    // Add to Redux + update branch path
                    dispatch(chatSliceActions.messageAdded(chunk.message))
                    dispatch(chatSliceActions.messageBranchCreated({ newMessage: chunk.message }))
                    // Sync to React Query cache
                    updateMessageCache(extra.queryClient, conversationId, chunk.message)
                    // Sync directly to local SQLite
                    localApi
                      .post('/sync/message', {
                        ...chunk.message,
                        conversation_id: conversationId,
                        children_ids: chunk.message.children_ids || [],
                        content_blocks: chunk.message.content_blocks || [],
                        tool_calls: chunk.message.tool_calls || [],
                        user_id: auth.userId,
                        owner_id: auth.userId,
                        project_id: selectedProject?.id || null,
                        storage_mode: storageMode,
                      })
                      .catch(err =>
                        console.error('[sendMessage][openai-chatgpt] Failed to sync assistant message:', err)
                      )
                      messageId = chunk.message.id
                      currentTurnContent = ''
                      currentTurnHistory.push(chunk.message)
                      // Keep current streaming UI until the next generation_started event clears it.
                  }
                },
                signal: controller.signal,
              }
            )

            // After streaming, check for tool calls and execute them locally
            const lastMsg = currentTurnHistory[currentTurnHistory.length - 1]
            const pendingToolCalls = Array.isArray(lastMsg?.tool_calls) ? lastMsg.tool_calls : []
            const isStreamActive = getState().chat.streaming.byId[streamId]?.active ?? false

            if (pendingToolCalls.length > 0 && isStreamActive) {
              const rootPath = effectiveToolRootPath
              const operationMode = state.chat.operationMode
              const toolResultBlocks: any[] = []
              let successfulTool = false

              for (const toolCall of pendingToolCalls) {
                let content: string
                let isError = false

                try {
                  const result = await executeToolWithPermissionCheck(
                    dispatch,
                    getState,
                    toolCall,
                    rootPath,
                    operationMode,
                    {
                      conversationId,
                      messageId: lastMsg.id,
                      streamId,
                      accessToken: auth.accessToken,
                      queryClient: extra.queryClient,
                      enableHooks: true,
                      provider: serverProvider,
                      model: modelName,
                      operation: 'send',
                      onHookAdditionalContext: value => appendHookAdditionalContext(pendingHookContextForNextTurn, value),
                    }
                  )
                  content = typeof result === 'string' ? result : JSON.stringify(result)
                  successfulTool = true
                } catch (error) {
                  isError = true
                  content = error instanceof Error ? error.message : String(error)
                }

                const toolResultBlock = {
                  type: 'tool_result',
                  tool_use_id: toolCall.id,
                  content,
                  is_error: isError,
                }
                toolResultBlocks.push(toolResultBlock)

                // Dispatch tool result event for UI
                dispatch(
                  chatSliceActions.streamChunkReceived({
                    streamId,
                    chunk: {
                      type: 'chunk',
                      part: 'tool_result',
                      toolResult: {
                        tool_use_id: toolCall.id,
                        content,
                        is_error: isError,
                      },
                    },
                  })
                )

                // Add tool result to history for next request
                currentTurnHistory.push(createToolResultMessage(conversationId, lastMsg.id, toolCall.id, content))
              }

              // Update assistant message with tool results
              if (toolResultBlocks.length > 0 && lastMsg.id) {
                const existingBlocks = Array.isArray(lastMsg.content_blocks) ? lastMsg.content_blocks : []
                const updatedContentBlocks = [...existingBlocks, ...toolResultBlocks]

                await persistAssistantMessageWithFallback(dispatch, {
                  id: lastMsg.id,
                  content: lastMsg.content,
                  updatedContentBlocks,
                  conversationId,
                  streamId,
                  contextLabel: 'sendMessage/openai',
                })

                // Update in currentTurnHistory
                const historyIndex = currentTurnHistory.findIndex(msg => msg.id === lastMsg.id)
                if (historyIndex !== -1) {
                  currentTurnHistory[historyIndex] = {
                    ...currentTurnHistory[historyIndex],
                    content_blocks: updatedContentBlocks,
                  }
                }
              }

              // Prepare for next turn
              currentTurnContent = ''
              parent = lastMsg.id
              continueTurn = successfulTool
            } else {
              continueTurn = false
            }

            if (!continueTurn) {
              const shouldContinueAfterStop = await shouldContinueFromStopHook({
                conversationId,
                streamId,
                cwd: effectiveToolRootPath,
                provider: serverProvider,
                model: modelName,
                operation: 'send',
                pendingHookContextForNextTurn,
                lastAssistantMessage: lastMsg,
                state: getState(),
                queryClient: extra.queryClient,
              })

              if (shouldContinueAfterStop) {
                currentTurnContent = ''
                parent = lastMsg.id
                continueTurn = true
              }
            }

            if (!continueTurn) break
            continue
          }

          // Cloud server handles LLM generation; storageMode in body tells it whether to save to cloud DB
          const endpoint = `/conversations/${conversationId}/messages`
          const toolNameById = buildToolNameMap(currentTurnHistory)

          const streamOpen = await openConversationStreamWithRetry(
            endpoint,
            auth.accessToken,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                messages: currentTurnHistory.map(m => {
                  const contentBlocks = sanitizeContentBlocksForModel(m.content_blocks, m.tool_calls)
                  if (m.role === 'tool' && m.tool_call_id) {
                    const toolName = toolNameById.get(m.tool_call_id) ?? null
                    const sanitizedContent = sanitizeToolResultContentForModel(m.content, toolName)
                    if (sanitizedContent !== m.content) {
                      const contentPlain =
                        typeof sanitizedContent === 'string' ? sanitizedContent : JSON.stringify(sanitizedContent)
                      return {
                        id: m.id,
                        conversation_id: m.conversation_id,
                        parent_id: m.parent_id,
                        children_ids: m.children_ids,
                        role: m.role,
                        thinking_block: m.thinking_block,
                        tool_calls: m.tool_calls,
                        content_blocks: contentBlocks,
                        content: sanitizedContent,
                        content_plain_text: contentPlain,
                        created_at: m.created_at,
                        model_name: m.model_name,
                        partial: m.partial,
                        artifacts: m.artifacts,
                      }
                    }
                  }
                  return {
                    id: m.id,
                    conversation_id: m.conversation_id,
                    parent_id: m.parent_id,
                    children_ids: m.children_ids,
                    role: m.role,
                    thinking_block: m.thinking_block,
                    tool_calls: m.tool_calls,
                    content_blocks: contentBlocks,
                    content: m.content,
                    content_plain_text: m.content_plain_text,
                    created_at: m.created_at,
                    model_name: m.model_name,
                    partial: m.partial,
                    artifacts: m.artifacts,
                  }
                }),
                content: currentTurnContent, // Empty for tool continuation
                modelName: modelName,
                // parentId: (currentPath && currentPath.length ? currentPath[currentPath.length - 1] : currentMessages?.at(-1)?.id) || undefined,
                parentId: parent,
                systemPrompt: systemPrompt,
                conversationContext: combinedContext,
                projectContext,
                provider: serverProvider,
                ...(openRouterTemperature !== undefined ? { temperature: openRouterTemperature } : {}),
                attachmentsBase64: turnCount === 1 ? attachmentsBase64 : undefined, // Only send attachments on first turn
                selectedFiles: turnCount === 1 ? selectedFilesForChat : undefined,
                think,
                retrigger: turnCount === 1 ? retrigger : false,
                executionMode,
                storageMode,
                isElectron: isElectronMode,
                imageConfig,
                reasoningConfig,
                tools: getToolsForAI(),
              }),
              signal: controller.signal,
            },
            {
              conversationId,
              streamId,
              controllerSignal: controller.signal,
            }
          )
          response = streamOpen.response
          streamReader = streamOpen.reader
          firstRead = streamOpen.firstRead
        }

        if (!response.ok) {
          // Handle free tier limit exceeded (403)
          if (response.status === 403) {
            const errorData = await response.json().catch(() => ({ error: 'unknown' }))
            if (errorData.error === 'generation_limit_reached') {
              dispatch(chatSliceActions.freeTierLimitModalShown())
              throw new Error(errorData.message || 'Free generations exhausted. Please upgrade to continue.')
            }
          }
          const errorText = await response.text()
          throw new Error(`HTTP ${response.status}: ${errorText || 'Failed to send message'}`)
        }

        const reader = streamReader
        if (!reader) throw new Error('No stream reader available')

        const decoder = new TextDecoder()
        // Buffer for incomplete lines across chunks
        let buffer = ''

        // State for this turn
        let assistantMessageContent = ''
        let assistantThinking = ''
        let assistantToolCalls: any[] = []
        let turnAssistantMessageId: string | null = null
        // Track processed tool calls (already executed on server)
        const processedToolCallIds = new Set<string>()
        let pendingRead = firstRead

        try {
          while (true) {
            const readResult = pendingRead ?? (await reader.read())
            pendingRead = null
            const { done, value } = readResult
            if (done) break

            // Append new data to buffer and split by newlines
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')

            // Keep the last incomplete line in the buffer
            buffer = lines.pop() || ''

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue

              try {
                const chunk = JSON.parse(line.slice(6))

                if (chunk.type === 'user_message' && chunk.message) {
                  userMessage = chunk.message
                  // console.log('we got userMessage', userMessage)
                  if (!chunk.message.timestamp) {
                    chunk.message.timestamp = new Date().toISOString()
                  }
                  // Add to messages list
                  dispatch(chatSliceActions.messageAdded(chunk.message))
                  // And update currentPath to navigate to this new node
                  dispatch(chatSliceActions.messageBranchCreated({ newMessage: chunk.message }))
                  // Sync to React Query cache immediately
                  updateMessageCache(extra.queryClient, conversationId, chunk.message)
                  // Sync user message to local SQLite (fire-and-forget)
                  dualSync.syncMessage({
                    ...chunk.message,
                    user_id: auth.userId,
                    project_id: selectedProject?.id || null,
                  })

                  // Touch project timestamp to reflect recent activity
                  if (selectedProject?.id) {
                    dualSync.touchProjectTimestamp(selectedProject.id)
                    // Update React Query cache immediately for instant UI update
                    touchProjectTimestampInCache(extra.queryClient, selectedProject.id, auth.userId)
                  }

                  // Save image attachments to local DB when in local mode
                  if (storageMode === 'local' && attachmentsBase64 && attachmentsBase64.length > 0) {
                    localApi
                      .post('/local/attachments/save-base64', {
                        messageId: chunk.message.id,
                        attachments: attachmentsBase64,
                      })
                      .catch(err => console.error('[sendMessage] Failed to save local attachments:', err))
                  }

                  // Add to local history tracking for next turn
                  currentTurnHistory.push(chunk.message)

                  // Clear optimistic message immediately when real user message confirmed
                  dispatch(chatSliceActions.optimisticMessageCleared())
                  // Live-update: append pre-send image drafts to this new user message's artifacts
                  if (preSendDrafts.length > 0) {
                    const artifactDataUrls = preSendDrafts.map(d => d.dataUrl)
                    dispatch(
                      chatSliceActions.messageArtifactsAppended({
                        messageId: chunk.message.id,
                        artifacts: artifactDataUrls,
                      })
                    )
                    // Sync artifacts to React Query cache so images appear immediately
                    updateMessageArtifactsInCache(extra.queryClient, conversationId, chunk.message.id, artifactDataUrls)
                  }
                  await maybePersistAutoConversationTitle({
                    dispatch,
                    conversationId,
                    storageMode,
                    parentId: chunk.message.parent_id ?? parent ?? null,
                    content: chunk.message?.content_plain_text || chunk.message?.content || input.content,
                    contextLabel: 'sendMessage',
                  })
                }

                // Handle tool results (accumulated server-side into content_blocks)
                if (chunk.part === 'tool_result' && chunk.toolResult) {
                  // Mark this tool call as processed by server
                  processedToolCallIds.add(chunk.toolResult.tool_use_id)

                  // Dispatch structured tool result data for proper rendering in streaming events
                  dispatch(
                    chatSliceActions.streamChunkReceived({
                      streamId,
                      chunk: {
                        type: 'chunk',
                        part: 'tool_result',
                        toolResult: chunk.toolResult,
                      },
                    })
                  )
                  // Skip generic chunk handler to prevent duplicate dispatch
                } else if (chunk.part === 'tool_call' && chunk.toolCall) {
                  // Accumulate tool calls locally
                  // We assume server sends structured tool calls
                  // Check if we already have this tool call (by id) to avoid duplicates if server resends
                  const exists = assistantToolCalls.some(tc => tc.id === chunk.toolCall.id)
                  if (!exists) {
                    assistantToolCalls.push(chunk.toolCall)
                  }

                  dispatch(
                    chatSliceActions.streamChunkReceived({
                      streamId,
                      chunk: {
                        type: 'chunk',
                        part: 'tool_call',
                        toolCall: chunk.toolCall,
                      },
                    })
                  )
                } else if (chunk.type === 'generation_started') {
                  dispatch(chatSliceActions.streamChunkReceived({ streamId, chunk }))
                  if (chunk.messageId) {
                    turnAssistantMessageId = chunk.messageId
                    // If this is the first assistant message (not continuation), it might not be in history yet
                    // But we usually get 'complete' event later
                  }
                } else if (chunk.type === 'chunk') {
                  dispatch(chatSliceActions.streamChunkReceived({ streamId, chunk }))
                  // Accumulate text/reasoning for local reconstruction if needed
                  if (chunk.part === 'text' && chunk.content) {
                    assistantMessageContent += chunk.content // Note: chunk.content is delta usually, verify
                  } else if (chunk.part === 'text' && chunk.delta) {
                    assistantMessageContent += chunk.delta
                  } else if (chunk.part === 'reasoning' && chunk.delta) {
                    assistantThinking += chunk.delta
                  }
                } else if (chunk.type === 'complete' && chunk.message) {
                  // Push each assistant reply as its own message
                  dispatch(chatSliceActions.messageAdded(chunk.message))
                  // Update branch/path to point to the completed assistant message
                  dispatch(chatSliceActions.messageBranchCreated({ newMessage: chunk.message }))
                  // Sync to React Query cache immediately
                  updateMessageCache(extra.queryClient, conversationId, chunk.message)
                  // Sync assistant message to local SQLite (fire-and-forget)
                  dualSync.syncMessage({
                    ...chunk.message,
                    user_id: auth.userId,
                    project_id: selectedProject?.id || null,
                  })

                  // Add to local history
                  currentTurnHistory.push(chunk.message)

                  // Sync provider cost if available
                  if (chunk.cost) {
                    dualSync.syncProviderCost({
                      ...chunk.cost,
                      message_id: chunk.message.id,
                    })
                  }
                  // Preserve current streaming UI until the next generation_started event clears it.
                  messageId = chunk.message.id
                } else if (chunk.type === 'free_generations_update') {
                  // Update free generations remaining count
                  dispatch(
                    chatSliceActions.freeGenerationsUpdated({
                      remaining: chunk.remaining,
                      isFreeTier: true,
                    })
                  )
                } else if (chunk.type === 'aborted') {
                  // Server deleted the empty assistant message, no need to keep it in client state
                  dispatch(
                    chatSliceActions.streamChunkReceived({
                      streamId,
                      chunk: { type: 'error', error: 'Generation aborted' },
                    })
                  )
                } else if (chunk.type === 'error') {
                  dispatch(chatSliceActions.streamChunkReceived({ streamId, chunk }))
                  throw new Error(chunk.error || 'Stream error')
                }
              } catch (parseError) {
                // Silently skip malformed JSON chunks (e.g., emoji-prefixed tool indicators)
                // These are often tool call markers from the server that aren't valid JSON
                if (line.length > 100) {
                  console.warn('Failed to parse chunk:', line.substring(0, 100) + '...', parseError)
                }
              }
            }
          }
        } finally {
          reader.releaseLock()
        }

        // End of stream for this turn. Check if we have pending tool calls to execute locally.
        // Also check if streaming is still active (user didn't click Stop)
        const isStreamActive = getState().chat.streaming.byId[streamId]?.active ?? false
        if (assistantToolCalls.length > 0 && executionMode === 'client' && isStreamActive) {
          // Filter out tool calls that were already processed by server
          const pendingToolCalls = assistantToolCalls.filter(tc => !processedToolCallIds.has(tc.id))

          if (pendingToolCalls.length > 0) {
            // console.log(`🛠️ [chatActions] Executing ${pendingToolCalls.length} tool calls locally...`)

            // if (processedToolCallIds.size > 0) {
            //   console.log(`⏩ [chatActions] Skipped ${processedToolCallIds.size} tool calls already handled by server`)
            // }

            // 1. Synthesize Assistant Message if we didn't get a 'complete' event
            // (In client mode, server aborts before sending 'complete')
            if (!messageId && turnAssistantMessageId) {
              // Create ephemeral assistant message
              const assistantMsg: any = {
                id: turnAssistantMessageId,
                conversation_id: conversationId,
                role: 'assistant',
                content: assistantMessageContent,
                thinking_block: assistantThinking,
                tool_calls: assistantToolCalls, // Store as array (or string if needed by backend, but we are client side now)
                content_blocks: assistantToolCalls.map(tc => ({
                  type: 'tool_use',
                  id: tc.id,
                  name: tc.name,
                  input: tc.arguments,
                })),
                created_at: new Date().toISOString(),
                model_name: modelName,
                parent_id: userMessage?.id || parent, // Link to parent
              }

              // Dispatch to Redux
              dispatch(chatSliceActions.messageAdded(assistantMsg))
              dispatch(chatSliceActions.messageBranchCreated({ newMessage: assistantMsg }))
              updateMessageCache(extra.queryClient, conversationId, assistantMsg)

              // Sync to DB (so it persists)
              dualSync.syncMessage({
                ...assistantMsg,
                user_id: auth.userId,
                project_id: selectedProject?.id || null,
              })

              // Update history
              currentTurnHistory.push(assistantMsg)
              messageId = assistantMsg.id
            }

            // 2. Execute tools and append tool_result blocks to assistant message
            const toolResultBlocks: any[] = []

            // Get rootPath from conversation cwd first, falling back to IDE context
            const rootPath = effectiveToolRootPath
            const operationMode = state.chat.operationMode
            // console.log(`🛠️ [chatActions] rootPath passed to tool: ${rootPath}`)
            let successfulDesktopTool = false
            let successfulBrowseWeb = false

            for (const toolCall of pendingToolCalls) {
              let content: string
              let isError = false

              try {
                const result = await executeToolWithPermissionCheck(
                  dispatch,
                  getState,
                  toolCall,
                  rootPath,
                  operationMode,
                  {
                    conversationId,
                    messageId: messageId ?? turnAssistantMessageId ?? undefined,
                    streamId,
                    accessToken: auth.accessToken,
                    queryClient: extra.queryClient,
                    enableHooks: true,
                    provider: serverProvider,
                    model: modelName,
                    operation: 'send',
                    onHookAdditionalContext: value => appendHookAdditionalContext(pendingHookContextForNextTurn, value),
                  }
                )

                content = typeof result === 'string' ? result : JSON.stringify(result)
                if (isElectronEnvironment) {
                  successfulDesktopTool = true
                } else if (toolCall?.name === 'browse_web') {
                  successfulBrowseWeb = true
                }
              } catch (error) {
                isError = true
                content = error instanceof Error ? error.message : String(error)
              }

              const toolResultBlock = {
                type: 'tool_result',
                tool_use_id: toolCall.id,
                content,
                is_error: isError,
              }

              toolResultBlocks.push(toolResultBlock)

              // Inform UI of tool result for real-time display
              dispatch(
                chatSliceActions.streamChunkReceived({
                  streamId,
                  chunk: {
                    type: 'chunk',
                    part: 'tool_result',
                    toolResult: {
                      tool_use_id: toolCall.id,
                      content: toolResultBlock.content,
                      is_error: isError,
                    },
                  },
                })
              )
            }

            // 3. Update assistant message with tool results
            if (toolResultBlocks.length > 0 && messageId) {
              // Find the assistant message from history
              const assistantMessage = currentTurnHistory.find(msg => msg.id === messageId)
              if (assistantMessage) {
                // Parse existing content_blocks
                const existingBlocks = parseContentBlocks(assistantMessage.content_blocks)
                const updatedContentBlocks = [...existingBlocks, ...toolResultBlocks]

                // Update message via updateMessage thunk (syncs to both local and cloud)
                await persistAssistantMessageWithFallback(dispatch, {
                  id: assistantMessage.id,
                  content: assistantMessage.content,
                  updatedContentBlocks,
                  conversationId,
                  streamId,
                  contextLabel: 'sendMessage/cloud-client-tools',
                })

                // Update the assistant message in currentTurnHistory
                const historyIndex = currentTurnHistory.findIndex(msg => msg.id === assistantMessage.id)
                if (historyIndex !== -1) {
                  currentTurnHistory[historyIndex] = {
                    ...currentTurnHistory[historyIndex],
                    content_blocks: updatedContentBlocks,
                  }
                }
              }
            }

            // 4. Prepare for next turn (continuation)
            const hasSuccessfulTool = successfulDesktopTool || successfulBrowseWeb

            currentTurnContent = '' // No new user input
            parent = messageId // Parent is the assistant message (not tool message)
            continueTurn = hasSuccessfulTool // Loop again only when we executed a tool successfully

            // Reset buffers
            assistantMessageContent = ''
            assistantThinking = ''
            assistantToolCalls = []
          } else {
            // All tool calls handled by server (or none exist)
            // if (assistantToolCalls.length > 0 && processedToolCallIds.size > 0) {
            //   console.log('✅ [chatActions] All tool calls handled by server')
            //   // Ensure message state is complete if we have a messageId
            //   if (messageId) {
            //     // This might be redundant if server sent 'complete', but ensures safety
            //   }
            // }

            // If no pending calls, we're done with this turn
            continueTurn = false
          }
        } else {
          // No tool calls or server handled it -> finish
          continueTurn = false
        }

        if (!continueTurn && isStreamActive) {
          const shouldContinueAfterStop = await shouldContinueFromStopHook({
            conversationId,
            streamId,
            cwd: effectiveToolRootPath,
            provider: serverProvider,
            model: modelName,
            operation: 'send',
            pendingHookContextForNextTurn,
            lastAssistantMessage:
              currentTurnHistory[currentTurnHistory.length - 1] ??
              (messageId ? { id: messageId, content: assistantMessageContent } : null),
            state: getState(),
            queryClient: extra.queryClient,
          })

          if (shouldContinueAfterStop) {
            currentTurnContent = ''
            parent = messageId ?? parent
            continueTurn = true
            assistantMessageContent = ''
            assistantThinking = ''
            assistantToolCalls = []
          }
        }
      } // end while loop

      if (messageId) {
        dispatch(chatSliceActions.streamCompleted({ streamId, messageId, updatePath: true }))
      }

      dispatch(chatSliceActions.sendingCompleted({ streamId }))

      // Schedule stream cleanup after delay
      setTimeout(() => {
        dispatch(chatSliceActions.streamPruned({ streamId }))
      }, STREAM_PRUNE_DELAY)

      return { messageId, userMessage, streamId }
    } catch (error) {
      dispatch(chatSliceActions.sendingCompleted({ streamId }))

      if (error instanceof Error && error.name === 'AbortError') {
        return rejectWithValue('Message cancelled')
      }

      const message = error instanceof Error ? error.message : 'Failed to send message'
      dispatch(chatSliceActions.streamChunkReceived({ streamId, chunk: { type: 'error', error: message } }))
      return rejectWithValue(message)
    } finally {
      unregisterGenerationAbortController()
    }
  }
)

export const updateMessage = createAsyncThunk<
  Message,
  { id: MessageId; content: string; note?: string; note_color?: string | null; content_blocks?: any },
  { state: RootState; extra: ThunkExtraArgument }
>(
  'chat/updateMessage',
  async ({ id, content, note, note_color, content_blocks }, { dispatch, getState, extra, rejectWithValue }) => {
    const { auth } = extra
    try {
      const currentState = getState() as RootState
      const currentConversationId = currentState.chat.conversation.currentConversationId
      const conversation = currentState.conversations.items.find(c => c.id === currentConversationId)
      // Use React Query cache as fallback for storage mode detection (handles local conversations not yet in Redux)
      const storageMode =
        conversation?.storage_mode || getStorageModeFromCache(extra.queryClient, currentConversationId!)
      const isLocalMode = shouldUseLocalApi(storageMode)

      let updated: Message

      if (isLocalMode) {
        // In local mode, persist to local SQLite via localApi
        const body: any = { content, note }
        if (note_color !== undefined && isLocalMode) {
          body.note_color = note_color
        }
        if (content_blocks) {
          body.content_blocks = content_blocks
        }

        updated = await localApi.put<Message>(`/app/messages/${id}`, body)
      } else {
        const body: any = { content, note }
        if (content_blocks) {
          body.content_blocks = content_blocks
        }

        updated = await apiCall<Message>(`/messages/${id}`, auth.accessToken, {
          method: 'PUT',
          body: JSON.stringify(body),
        })
      }
      const appliedNoteColor = isLocalMode ? note_color : undefined
      dispatch(chatSliceActions.messageUpdated({ id, content, note, note_color: appliedNoteColor, content_blocks }))

      // Sync to React Query cache immediately
      const state = getState()
      const conversationId = state.chat.conversation.currentConversationId
      if (conversationId) {
        updateMessageInCache(extra.queryClient, conversationId, id, content, note, appliedNoteColor, content_blocks)
      }

      // Sync message update to local SQLite (fire-and-forget)
      const selectedProject = selectSelectedProject(state)
      dualSync.syncMessage(
        {
          ...updated,
          content_blocks: content_blocks, // Explicitly include from request to ensure local sync
          user_id: auth.userId,
          project_id: selectedProject?.id || null,
        },
        'update'
      )

      return updated
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : 'Update failed')
    }
  }
)

// Fetch conversation messages from server
export const fetchConversationMessages = createAsyncThunk<
  Message[],
  ConversationId,
  { state: RootState; extra: ThunkExtraArgument }
>('chat/fetchConversationMessages', async (conversationId, { dispatch, extra, rejectWithValue, getState }) => {
  const { auth } = extra
  try {
    const raw = await apiCall<Message[]>(`/conversations/${conversationId}/messages`, auth.accessToken)
    // Ensure client-only fields exist
    const messages: Message[] = (raw || []).map(m => ({
      ...m,
      pastedContext: Array.isArray((m as any).pastedContext) ? (m as any).pastedContext : [],
      artifacts: Array.isArray((m as any).artifacts) ? (m as any).artifacts : [],
    }))

    dispatch(chatSliceActions.messagesLoaded(messages))

    // Conditional attachments fetch: only when metadata indicates or when metadata absent (back-compat)
    const state = getState() as RootState
    const attachmentsByMessage = state.chat.attachments.byMessage || {}

    for (const msg of messages) {
      const alreadyFetched = Array.isArray(attachmentsByMessage[msg.id]) && attachmentsByMessage[msg.id].length > 0
      const hasMeta = typeof msg.has_attachments !== 'undefined' || typeof msg.attachments_count !== 'undefined'
      const indicatesAttachments =
        msg.has_attachments === true || (typeof msg.attachments_count === 'number' && msg.attachments_count > 0)

      if (!alreadyFetched) {
        if ((hasMeta && indicatesAttachments) || !hasMeta /* fallback to previous behavior */) {
          // Fire-and-forget; errors handled inside thunk
          dispatch(fetchAttachmentsByMessage({ messageId: msg.id }))
        }
      }
    }

    return messages
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : 'Failed to fetch messages')
  }
})

export const deleteMessage = createAsyncThunk<
  MessageId,
  { id: MessageId; conversationId: ConversationId; storageMode?: 'local' | 'cloud' },
  { extra: ThunkExtraArgument }
>('chat/deleteMessage', async ({ id, conversationId, storageMode }, { dispatch, extra, rejectWithValue }) => {
  const { auth } = extra
  try {
    // Use storageMode passed from caller (most reliable) or fallback to cache lookup
    const effectiveStorageMode = storageMode ?? getStorageModeFromCache(extra.queryClient, conversationId)
    const isLocalMode = shouldUseLocalApi(effectiveStorageMode)

    // console.log('[deleteMessage] Routing decision:', {
    //   passedStorageMode: storageMode,
    //   effectiveStorageMode,
    //   isLocalMode,
    //   environment,
    //   conversationId,
    //   messageId: id,
    // })

    if (isLocalMode) {
      // console.log('[deleteMessage] -> Routing to LOCAL API: /app/messages/' + id)
      await localApi.delete(`/app/messages/${id}`)
    } else {
      // console.log('[deleteMessage] -> Routing to CLOUD API: /messages/' + id)
      await apiCall(`/messages/${id}`, auth.accessToken, { method: 'DELETE' })
    }
    // Sync React Query cache immediately
    removeMessagesFromCache(extra.queryClient, conversationId, [id])
    // Sync message deletion to local SQLite (fire-and-forget)
    dualSync.syncMessage({ id }, 'delete')
    // Refetch conversation messages to ensure sync with server (cloud only)
    if (!isLocalMode) {
      await dispatch(fetchConversationMessages(conversationId))
    }
    return id
  } catch (error) {
    console.error('[deleteMessage] Error:', error)
    return rejectWithValue(error instanceof Error ? error.message : 'Delete failed')
  }
})

// Branch message when editing - creates new branch while preserving original
export const editMessageWithBranching = createAsyncThunk<
  { messageId: MessageId | null; userMessage: any; originalMessageId: MessageId; streamId: string },
  EditMessagePayload & { streamId?: string },
  { state: RootState; extra: ThunkExtraArgument }
>(
  'chat/editMessageWithBranching',
  async (
    { conversationId, originalMessageId, newContent, modelOverride, think, cwd, streamId: providedStreamId },
    { dispatch, getState, extra, rejectWithValue, signal }
  ) => {
    const { auth } = extra

    // Generate or use provided stream ID
    const streamId = providedStreamId ?? generateStreamId('branch')

    // Snapshot composition state before send start so UI can clear immediately.
    const preSendState = getState() as RootState
    const preSendDrafts = preSendState.chat.composition.imageDrafts || []
    const preSendSelectedFilesForChat = preSendState.ideContext.selectedFilesForChat || []

    // Get state early to find parent message ID for lineage
    const state = preSendState
    const messagesCache = extra.queryClient?.getQueryData<{ messages: Message[]; tree: any }>([
      'conversations',
      conversationId,
      'messages',
    ])
    const cachedMessages = messagesCache?.messages || []
    const currentMessages = cachedMessages.length > 0 ? cachedMessages : state.chat.conversation.messages
    const originalMessage = currentMessages.find(m => m.id === originalMessageId)
    const parentMessageId = originalMessage?.parent_id

    dispatch(
      chatSliceActions.sendingStarted({
        streamId,
        streamType: 'branch',
        conversationId,
        lineage: {
          originMessageId: originalMessageId,
          rootMessageId: parentMessageId, // Parent where new branch attaches
        },
      })
    )

    let controller: AbortController | undefined
    let unregisterGenerationAbortController = () => {}

    try {
      controller = new AbortController()
      signal.addEventListener('abort', () => controller?.abort())
      unregisterGenerationAbortController = registerGenerationAbortController(streamId, controller)

      const currentPathIds = state.chat.conversation.currentPath.filter(id => id !== 'root')
      // Truncate path to only include messages strictly before the originalMessageId
      const idxOriginal = currentPathIds.indexOf(originalMessageId)
      const truncatedPathIds = idxOriginal >= 0 ? currentPathIds.slice(0, idxOriginal) : currentPathIds
      const currentPathMessages = trimHistoryToLatestCompaction(
        truncatedPathIds.map(id => currentMessages.find(m => m.id === id))
      )

      // Read selected model from React Query cache
      const provider = state.chat.providerState.currentProvider
      const modelsData = extra.queryClient?.getQueryData<{
        models: Model[]
        default: Model
        selected: Model
      }>(['models', provider])
      const selectedName = modelsData?.selected?.name || modelsData?.default?.name
      const modelName = modelOverride || selectedName
      let activeParentId = originalMessage.parent_id

      // Map UI provider to server provider id
      const providerRaw = state.chat.providerState.currentProvider || 'ollama'
      const appProvider = providerRaw.toLowerCase()
      const providerSlug = appProvider.replace(/\s+/g, '')
      const serverProvider = providerSlug === 'google' ? 'gemini' : providerSlug
      const openRouterTemperature = resolveOpenRouterTemperature(providerSlug)
      const isLmStudio = providerSlug === 'lmstudio'
      const isOpenAIChatGPT = providerSlug === 'openaichatgpt' || providerSlug === 'openai(chatgpt)'

      // Combine system prompts in order: user default > project > conversation
      const selectedProject = selectSelectedProject(state)
      let systemPrompt = ''

      // 1. First, check for default user system prompt from React Query cache
      const defaultUserPrompt = getDefaultUserSystemPromptFromCache(extra.queryClient, auth.userId)
      if (defaultUserPrompt?.content) {
        systemPrompt = defaultUserPrompt.content
      }

      // 2. Then add project system prompt
      if (selectedProject?.system_prompt) {
        if (systemPrompt) systemPrompt += '\n\n'
        systemPrompt += selectedProject.system_prompt
      }

      // 3. Finally add conversation-specific system prompt
      if (state.conversations.systemPrompt) {
        if (systemPrompt) systemPrompt += '\n\n'
        systemPrompt += state.conversations.systemPrompt
      }
      const projectContext = selectedProject?.context || null
      const conversationContextSource = state.conversations.convContext || null
      const combinedContext =
        projectContext && conversationContextSource
          ? `${projectContext}\n\n${conversationContextSource}`
          : projectContext || conversationContextSource || null

      // Gather image drafts (new images being added) captured before send start.
      const drafts = preSendDrafts
      const draftDataUrls = drafts.map(d => d.dataUrl)

      // Build attachments: prioritize React Query cached artifacts, then Redux, plus new drafts
      // React Query cache has artifacts set via messageArtifactsSet after images are fetched
      const artifactsFromCache: string[] = Array.isArray(originalMessage?.artifacts)
        ? (originalMessage.artifacts as string[])
        : []
      // Also check Redux state for artifacts (fallback)
      const reduxMessage = state.chat.conversation.messages.find(m => m.id === originalMessageId)
      const artifactsFromRedux: string[] = Array.isArray(reduxMessage?.artifacts)
        ? (reduxMessage.artifacts as string[])
        : []
      // Use whichever has artifacts (prefer cache, fallback to Redux)
      const artifactsExisting = artifactsFromCache.length > 0 ? artifactsFromCache : artifactsFromRedux

      const deletedBackup: string[] = state.chat.attachments.backup?.[originalMessageId] || []
      const existingMinusDeleted = artifactsExisting.filter(a => !deletedBackup.includes(a))
      const combinedArtifacts = Array.from(new Set([...existingMinusDeleted, ...draftDataUrls]))

      // Build attachmentsBase64 with full metadata like sendMessage does
      const attachmentsBase64 = combinedArtifacts.length
        ? combinedArtifacts.map(dataUrl => {
            // Try to find matching draft for full metadata
            const matchingDraft = drafts.find(d => d.dataUrl === dataUrl)
            if (matchingDraft) {
              return { dataUrl, name: matchingDraft.name, type: matchingDraft.type, size: matchingDraft.size }
            }
            // For existing artifacts (data URLs), extract type from the data URL
            const typeMatch = dataUrl.match(/^data:([^;]+);/)
            const mimeType = typeMatch ? typeMatch[1] : 'image/png'
            return { dataUrl, name: 'image', type: mimeType, size: 0 }
          })
        : null

      // Before sending, reflect current image drafts in the UI by appending them
      // to the artifacts of the message being branched from.
      if (drafts.length > 0) {
        const draftDataUrls = drafts.map(d => d.dataUrl)
        dispatch(
          chatSliceActions.messageArtifactsAppended({
            messageId: originalMessageId,
            artifacts: draftDataUrls,
          })
        )
        // Sync artifacts to React Query cache to keep UI consistent
        updateMessageArtifactsInCache(extra.queryClient, conversationId, originalMessageId, draftDataUrls)
      }

      if (!modelName) {
        throw new Error('No model selected')
      }

      const safeEstimateTokenCount = (value: unknown): number => {
        if (value == null) return 0
        if (typeof value === 'string') {
          if (value.length === 0) return 0
          return estimateTokenCount(value)
        }

        try {
          const serialized = JSON.stringify(value)
          if (!serialized) return 0
          return estimateTokenCount(serialized)
        } catch {
          return 0
        }
      }

      const resolvedModel =
        modelsData?.models?.find(model => model.name === modelName) || modelsData?.selected || modelsData?.default || null
      const branchContextLimit = resolvedModel?.contextLength || 128_000

      let promptAndContextTokens = 0
      promptAndContextTokens += safeEstimateTokenCount(selectedProject?.system_prompt)
      promptAndContextTokens += safeEstimateTokenCount(selectedProject?.context)
      promptAndContextTokens += safeEstimateTokenCount(state.conversations.systemPrompt)
      promptAndContextTokens += safeEstimateTokenCount(state.conversations.convContext)

      let messageTokens = 0
      currentPathMessages.forEach(message => {
        if (!message) return
        messageTokens += safeEstimateTokenCount(message.content)
        messageTokens += safeEstimateTokenCount((message as any).content_blocks)
        messageTokens += safeEstimateTokenCount((message as any).tool_calls)
      })

      const branchContextTokens = promptAndContextTokens + messageTokens
      const branchContextProgress =
        branchContextLimit > 0 ? Math.min((branchContextTokens / branchContextLimit) * 100, 100) : 0

      const currentCreditsUsd = Number((state as any)?.users?.currentUser?.cached_current_credits ?? 0) / 100
      const promptCostPer1K = resolvedModel?.promptCost ?? 0
      const completionCostPer1K = resolvedModel?.completionCost ?? 0
      let creditInputLimit = Infinity
      let creditOutputLimit = Infinity
      if (promptCostPer1K > 0) {
        creditInputLimit = Math.floor((currentCreditsUsd * 1000) / promptCostPer1K)
      }
      if (completionCostPer1K > 0) {
        creditOutputLimit = Math.floor((currentCreditsUsd * 1000) / completionCostPer1K)
      }
      const branchTotalBudget = Math.max(0, Math.min(branchContextLimit, creditInputLimit, creditOutputLimit))
      const branchTotalProgress =
        branchTotalBudget > 0 ? Math.min((branchContextTokens / branchTotalBudget) * 100, 100) : 0

      let branchHistoryForSend = [...currentPathMessages]
      const autoCompactionEnabled = loadAutoCompactionEnabled()
      const shouldAutoCompactBranch =
        autoCompactionEnabled &&
        branchContextLimit > 0 &&
        (branchContextProgress >= 85 || branchTotalProgress >= 85) &&
        currentPathMessages.length >= 2 &&
        activeParentId != null

      console.log('[AutoCompaction][branch] precheck', {
        conversationId,
        originalMessageId,
        activeParentId,
        autoCompactionEnabled,
        branchContextTokens,
        branchContextLimit,
        branchContextProgress,
        branchTotalBudget,
        branchTotalProgress,
        historyCount: currentPathMessages.length,
        shouldAutoCompactBranch,
      })

      if (shouldAutoCompactBranch && activeParentId != null) {
        try {
          console.log('[AutoCompaction][branch] dispatch compactBranch', {
            conversationId,
            parentMessageId: activeParentId,
            sourceMessagesCount: currentPathMessages.length,
            providerName: provider,
            modelName,
          })

          const compactionResult = await dispatch(
            compactBranch({
              conversationId,
              parentMessageId: activeParentId,
              messages: currentPathMessages,
              providerName: provider,
              modelName,
            })
          ).unwrap()

          const compactedMessage = compactionResult?.message ?? null
          const hasValidCompaction =
            compactedMessage?.role === 'system' &&
            compactedMessage?.note === AUTO_COMPACTION_NOTE &&
            String(compactedMessage?.parent_id ?? '') === String(activeParentId)

          console.log('[AutoCompaction][branch] compactBranch result', {
            messageId: compactedMessage?.id ?? null,
            role: compactedMessage?.role ?? null,
            note: compactedMessage?.note ?? null,
            parentId: compactedMessage?.parent_id ?? null,
            hasValidCompaction,
          })

          if (!compactedMessage || !hasValidCompaction) {
            throw new Error('Invalid branch compaction summary returned')
          }

          activeParentId = compactedMessage.id
          branchHistoryForSend = trimHistoryToLatestCompaction([...currentPathMessages, compactedMessage])
        } catch (error) {
          console.error('[AutoCompaction][branch] compaction failed. Branch send aborted:', error)
          throw error instanceof Error ? error : new Error(String(error))
        }
      }

const selectedFilesForChat = preSendSelectedFilesForChat

const conversationMeta = state.conversations.items.find(c => c.id === conversationId)
// Use React Query cache as fallback for storage mode detection (handles local conversations not yet in Redux)
const storageMode = conversationMeta?.storage_mode || getStorageModeFromCache(extra.queryClient, conversationId)
// Keep cwd for tool execution context only (do not inject cwd into system prompt)
const payloadCwd = typeof cwd === 'string' ? cwd.trim() : (cwd ?? null)
const effectiveToolRootPath = payloadCwd || conversationMeta?.cwd || state.ideContext.workspace?.rootPath || null
// Append custom tools explanation to system prompt
systemPrompt = systemPrompt + '\n\n' + sysPromptConfig.customToolsPrompt
const baseSystemPrompt = systemPrompt

// Determine execution mode
const isElectronMode =
  import.meta.env.VITE_ENVIRONMENT === 'electron' || (typeof __IS_ELECTRON__ !== 'undefined' && __IS_ELECTRON__)
const executionMode = 'client' // Prefer client execution for tools
      let currentTurnHistory = [...branchHistoryForSend]
      const pendingHookContextForNextTurn: string[] = []
      let currentTurnContent = await maybeApplyUserPromptSubmitHook({
        conversationId,
        streamId,
        cwd: effectiveToolRootPath,
        provider: serverProvider,
        model: modelName,
        operation: 'edit-branch',
        prompt: newContent,
        pendingHookContextForNextTurn,
        parentId: activeParentId ?? null,
        state,
        queryClient: extra.queryClient,
      })
      let continueTurn = true
      let turnCount = 0
      const MAX_TURNS = 100

      let messageId: MessageId | null = null
      let userMessage: any = null

      const shouldUseLmStudio = isElectronMode && isLmStudio
      const shouldUseOpenAIChatGPT = isElectronMode && isOpenAIChatGPT

      while (continueTurn && turnCount < MAX_TURNS) {
        turnCount++
        continueTurn = false
        const systemPrompt = buildSystemPromptWithHookContext(baseSystemPrompt, pendingHookContextForNextTurn)
        pendingHookContextForNextTurn.length = 0
        let streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null
        let firstRead: ReadableStreamReadResult<Uint8Array> | null = null

        // LM Studio branch: handle locally like sendMessage does
        if (shouldUseLmStudio) {
          const toolNameById = buildToolNameMap(currentTurnHistory)
          // Synthesize user message locally on first turn
          if (turnCount === 1 && currentTurnContent && currentTurnContent.trim()) {
            const newUserMessage: Message = {
              id: uuidv4(),
              conversation_id: conversationId,
              parent_id: activeParentId,
              children_ids: [],
              role: 'user',
              content: currentTurnContent,
              content_plain_text: currentTurnContent,
              thinking_block: '',
              tool_calls: [],
              content_blocks: [],
              created_at: new Date().toISOString(),
              model_name: modelName || '',
              partial: false,
              artifacts: [],
              pastedContext: [],
            }

            dispatch(chatSliceActions.messageAdded(newUserMessage))
            dispatch(chatSliceActions.messageBranchCreated({ newMessage: newUserMessage }))
            updateMessageCache(extra.queryClient, conversationId, newUserMessage)
            dispatch(chatSliceActions.optimisticBranchMessageCleared())

            // Sync to local SQLite
            localApi
              .post('/sync/message', {
                ...newUserMessage,
                conversation_id: conversationId,
                children_ids: newUserMessage.children_ids,
                content_blocks: newUserMessage.content_blocks,
                tool_calls: newUserMessage.tool_calls,
                user_id: auth.userId,
                owner_id: auth.userId,
                project_id: selectedProject?.id || null,
                storage_mode: storageMode,
              })
              .catch(err => console.error('[editMessageWithBranching][lmstudio] Failed to sync user message:', err))

            userMessage = newUserMessage
            currentTurnHistory.push(newUserMessage)
            await maybePersistAutoConversationTitle({
              dispatch,
              conversationId,
              storageMode,
              parentId: newUserMessage.parent_id,
              content: newContent,
              contextLabel: 'editMessageWithBranching',
              skip: true,
            })
            activeParentId = newUserMessage.id
          }

          // Build LM Studio messages
          const lmMessages: any[] = []
          if (systemPrompt && systemPrompt.trim()) {
            lmMessages.push({ role: 'system', content: systemPrompt })
          }
          // Build OpenAI-compatible messages from history
          for (const m of currentTurnHistory) {
            if (m.role === 'user') {
              lmMessages.push({ role: 'user', content: m.content })
            } else if (m.role === 'assistant') {
              const assistantMsg: any = { role: 'assistant', content: m.content || '' }
              if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                assistantMsg.tool_calls = m.tool_calls.map(tc => ({
                  id: tc.id,
                  type: 'function',
                  function: {
                    name: tc.name,
                    arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}),
                  },
                }))
              }
              lmMessages.push(assistantMsg)
            } else if (appendCompactionSummaryToLmStudioHistory(lmMessages, m)) {
              continue
            } else if (m.role === 'tool' && m.tool_call_id) {
              const toolName = toolNameById.get(m.tool_call_id)
              const sanitizedContent = sanitizeToolResultContentForModel(m.content, toolName ?? null)
              lmMessages.push({
                role: 'tool',
                tool_call_id: m.tool_call_id,
                content: typeof sanitizedContent === 'string' ? sanitizedContent : JSON.stringify(sanitizedContent),
              })
            }
          }

          await createLmStudioStreamingRequest(
            {
              conversationId,
              parentId: activeParentId,
              modelName,
              systemPrompt,
              messages: lmMessages,
              tools: getToolsForAI(),
            },
            {
              onChunk: chunk => {
                dispatch(chatSliceActions.streamChunkReceived({ streamId, chunk }))
                if (chunk.type === 'complete' && chunk.message) {
                  dispatch(chatSliceActions.messageAdded(chunk.message))
                  dispatch(chatSliceActions.messageBranchCreated({ newMessage: chunk.message }))
                  updateMessageCache(extra.queryClient, conversationId, chunk.message)
                  // Sync to local SQLite
                  localApi
                    .post('/sync/message', {
                      ...chunk.message,
                      conversation_id: conversationId,
                      children_ids: chunk.message.children_ids || [],
                      content_blocks: chunk.message.content_blocks || [],
                      tool_calls: chunk.message.tool_calls || [],
                      user_id: auth.userId,
                      owner_id: auth.userId,
                      project_id: selectedProject?.id || null,
                      storage_mode: storageMode,
                    })
                    .catch(err =>
                      console.error('[editMessageWithBranching][lmstudio] Failed to sync assistant message:', err)
                    )
                  messageId = chunk.message.id
                  currentTurnContent = ''
                  currentTurnHistory.push(chunk.message)
                }
              },
              signal: controller.signal,
            }
          )

          // After streaming, handle tool calls (same pattern as sendMessage)
          const lastMsg = currentTurnHistory[currentTurnHistory.length - 1]
          const pendingToolCalls = Array.isArray(lastMsg?.tool_calls) ? lastMsg.tool_calls : []
          const isStreamActive = getState().chat.streaming.byId[streamId]?.active ?? false

          if (pendingToolCalls.length > 0 && isStreamActive) {
            const rootPath = effectiveToolRootPath
            const operationMode = state.chat.operationMode
            const toolResultBlocks: any[] = []
            let successfulTool = false

            for (const toolCall of pendingToolCalls) {
              let content: string
              let isError = false

              try {
                const result = await executeToolWithPermissionCheck(
                  dispatch,
                  getState,
                  toolCall,
                  rootPath,
                  operationMode,
                  {
                    conversationId,
                    messageId: lastMsg.id,
                    streamId,
                    accessToken: auth.accessToken,
                    queryClient: extra.queryClient,
                    enableHooks: true,
                    provider: serverProvider,
                    model: modelName,
                    operation: 'edit-branch',
                    onHookAdditionalContext: value => appendHookAdditionalContext(pendingHookContextForNextTurn, value),
                  }
                )
                content = typeof result === 'string' ? result : JSON.stringify(result)
                successfulTool = true
              } catch (error) {
                isError = true
                content = error instanceof Error ? error.message : String(error)
              }

              const toolResultBlock = {
                type: 'tool_result',
                tool_use_id: toolCall.id,
                content,
                is_error: isError,
              }
              toolResultBlocks.push(toolResultBlock)

              dispatch(
                chatSliceActions.streamChunkReceived({
                  streamId,
                  chunk: {
                    type: 'chunk',
                    part: 'tool_result',
                    toolResult: { tool_use_id: toolCall.id, content, is_error: isError },
                  },
                })
              )

              currentTurnHistory.push(createToolResultMessage(conversationId, lastMsg.id, toolCall.id, content))
            }

            if (toolResultBlocks.length > 0 && lastMsg.id) {
              const existingBlocks = Array.isArray(lastMsg.content_blocks) ? lastMsg.content_blocks : []
              const updatedContentBlocks = [...existingBlocks, ...toolResultBlocks]

              await persistAssistantMessageWithFallback(dispatch, {
                id: lastMsg.id,
                content: lastMsg.content,
                updatedContentBlocks,
                conversationId,
                streamId,
                contextLabel: 'editMessageWithBranching/lmstudio',
              })

              const historyIndex = currentTurnHistory.findIndex(msg => msg.id === lastMsg.id)
              if (historyIndex !== -1) {
                currentTurnHistory[historyIndex] = {
                  ...currentTurnHistory[historyIndex],
                  content_blocks: updatedContentBlocks,
                }
              }
            }

            currentTurnContent = ''
            activeParentId = lastMsg.id
            continueTurn = successfulTool
          } else {
            continueTurn = false
          }

          if (!continueTurn) {
            const shouldContinueAfterStop = await shouldContinueFromStopHook({
              conversationId,
              streamId,
              cwd: effectiveToolRootPath,
              provider: serverProvider,
              model: modelName,
              operation: 'edit-branch',
              pendingHookContextForNextTurn,
              lastAssistantMessage: lastMsg,
              state: getState(),
              queryClient: extra.queryClient,
            })

            if (shouldContinueAfterStop) {
              currentTurnContent = ''
              activeParentId = lastMsg.id
              continueTurn = true
            }
          }

          if (!continueTurn) break
          continue
        }

        // OpenAI ChatGPT branch: handle locally via OAuth tokens
        if (shouldUseOpenAIChatGPT) {
          const toolNameById = buildToolNameMap(currentTurnHistory)
          // Synthesize user message locally on first turn
          if (turnCount === 1 && currentTurnContent && currentTurnContent.trim()) {
            const newUserMessage: Message = {
              id: uuidv4(),
              conversation_id: conversationId,
              parent_id: activeParentId,
              children_ids: [],
              role: 'user',
              content: currentTurnContent,
              content_plain_text: currentTurnContent,
              thinking_block: '',
              tool_calls: [],
              content_blocks: [],
              created_at: new Date().toISOString(),
              model_name: modelName || '',
              partial: false,
              artifacts: [],
              pastedContext: [],
            }

            dispatch(chatSliceActions.messageAdded(newUserMessage))
            dispatch(chatSliceActions.messageBranchCreated({ newMessage: newUserMessage }))
            updateMessageCache(extra.queryClient, conversationId, newUserMessage)
            dispatch(chatSliceActions.optimisticBranchMessageCleared())

            try {
              await localApi.post('/sync/message', {
                ...newUserMessage,
                conversation_id: conversationId,
                children_ids: newUserMessage.children_ids,
                content_blocks: newUserMessage.content_blocks,
                tool_calls: newUserMessage.tool_calls,
                user_id: auth.userId,
                owner_id: auth.userId,
                project_id: selectedProject?.id || null,
                storage_mode: storageMode,
              })
            } catch (err) {
              console.error('[editMessageWithBranching][openai-chatgpt] Failed to sync user message:', err)
            }

            // Save image attachments to local DB for the new branched user message
            if (storageMode === 'local' && attachmentsBase64 && attachmentsBase64.length > 0) {
              localApi
                .post('/local/attachments/save-base64', {
                  messageId: newUserMessage.id,
                  attachments: attachmentsBase64,
                })
                .catch(err =>
                  console.error('[editMessageWithBranching][openai-chatgpt] Failed to save local attachments:', err)
                )
            }

            // Ensure branched user message shows intended artifacts immediately
            if (combinedArtifacts.length > 0) {
              dispatch(
                chatSliceActions.messageArtifactsSet({
                  messageId: newUserMessage.id,
                  artifacts: combinedArtifacts,
                })
              )

              const cacheKey = ['conversations', conversationId, 'messages']
              const existingData = extra.queryClient?.getQueryData<{ messages: Message[]; tree: any }>(cacheKey)
              if (existingData) {
                const updatedMessages = existingData.messages.map(msg =>
                  msg.id === newUserMessage.id ? { ...msg, artifacts: combinedArtifacts } : msg
                )
                extra.queryClient?.setQueryData(cacheKey, {
                  messages: updatedMessages,
                  tree: existingData.tree,
                })
              }
            }

            userMessage = newUserMessage
            currentTurnHistory.push(newUserMessage)
            await maybePersistAutoConversationTitle({
              dispatch,
              conversationId,
              storageMode,
              parentId: newUserMessage.parent_id,
              content: newContent,
              contextLabel: 'editMessageWithBranching',
              skip: true,
            })
            activeParentId = newUserMessage.id
          }

          // Build ChatGPT messages
          const chatgptMessages: any[] = []
          if (systemPrompt && systemPrompt.trim()) {
            chatgptMessages.push({ role: 'system', content: systemPrompt })
          }
          for (const m of currentTurnHistory) {
            if (m.role === 'user') {
              const userContent = typeof m.content === 'string' ? m.content : String(m.content ?? '')
              const lastMessage = chatgptMessages[chatgptMessages.length - 1]
              const lastContent =
                lastMessage?.role === 'user' && typeof lastMessage?.content === 'string' ? lastMessage.content : null
              if (lastContent && lastContent.trim() === userContent.trim()) {
                continue
              }
              chatgptMessages.push({
                role: 'user',
                content: m.content,
                artifacts: Array.isArray((m as any).artifacts) ? (m as any).artifacts : undefined,
                content_blocks: (m as any).content_blocks,
                attachments: (m as any).attachments,
              })
            } else if (m.role === 'assistant') {
              const assistantMsg: any = {
                role: 'assistant',
                content: m.content || '',
                content_blocks: sanitizeContentBlocksForModel(m.content_blocks, m.tool_calls),
                responses_output_items: (m as any)?.responses_output_items,
              }
              if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                assistantMsg.tool_calls = m.tool_calls.map(tc => ({
                  id: tc.id,
                  name: tc.name,
                  arguments: tc.arguments,
                }))
              }
              chatgptMessages.push(assistantMsg)
            } else if (appendCompactionSummaryToOpenAIChatGPTHistory(chatgptMessages, m)) {
              continue
            } else if (m.role === 'tool' && m.tool_call_id) {
              const toolName = toolNameById.get(m.tool_call_id)
              const sanitizedContent = sanitizeToolResultContentForModel(m.content, toolName ?? null)
              chatgptMessages.push({
                role: 'tool',
                tool_call_id: m.tool_call_id,
                content: typeof sanitizedContent === 'string' ? sanitizedContent : JSON.stringify(sanitizedContent),
              })
            }
          }

          await createOpenAIChatGPTStreamingRequest(
            {
              conversationId,
              parentId: activeParentId,
              modelName,
              systemPrompt,
              messages: chatgptMessages,
              attachmentsBase64: turnCount === 1 ? attachmentsBase64 : undefined,
              tools: getToolsForOpenAIChatGPT(),
            },
            {
              onChunk: chunk => {
                dispatch(chatSliceActions.streamChunkReceived({ streamId, chunk }))
                if (chunk.type === 'complete' && chunk.message) {
                  const assistantMsg = chunk.message
                  dispatch(chatSliceActions.messageAdded(assistantMsg))
                  dispatch(chatSliceActions.messageBranchCreated({ newMessage: assistantMsg }))
                  updateMessageCache(extra.queryClient, conversationId, assistantMsg)
                  localApi
                    .post('/sync/message', {
                      ...assistantMsg,
                      conversation_id: conversationId,
                      children_ids: assistantMsg.children_ids || [],
                      content_blocks: assistantMsg.content_blocks || [],
                      tool_calls: assistantMsg.tool_calls || [],
                      user_id: auth.userId,
                      owner_id: auth.userId,
                      project_id: selectedProject?.id || null,
                      storage_mode: storageMode,
                    })
                    .catch(err =>
                      console.error('[editMessageWithBranching][openai-chatgpt] Failed to sync assistant message:', err)
                    )
                    messageId = assistantMsg.id
                    currentTurnHistory.push(assistantMsg)
                    // Keep current streaming UI until the next generation_started event clears it.
                }
              },
              signal: controller.signal,
            }
          )

          // Handle tool calls
          const lastMsg = currentTurnHistory[currentTurnHistory.length - 1]
          const pendingToolCalls = Array.isArray(lastMsg?.tool_calls) ? lastMsg.tool_calls : []
          const isStreamActive = getState().chat.streaming.byId[streamId]?.active ?? false

          if (pendingToolCalls.length > 0 && isStreamActive) {
            const rootPath = effectiveToolRootPath
            const operationMode = state.chat.operationMode
            const toolResultBlocks: any[] = []
            let successfulTool = false

            for (const toolCall of pendingToolCalls) {
              let content: string
              let isError = false
              try {
                const result = await executeToolWithPermissionCheck(
                  dispatch,
                  getState,
                  toolCall,
                  rootPath,
                  operationMode,
                  {
                    conversationId,
                    messageId: lastMsg.id,
                    streamId,
                    accessToken: auth.accessToken,
                    queryClient: extra.queryClient,
                    enableHooks: true,
                    provider: serverProvider,
                    model: modelName,
                    operation: 'edit-branch',
                    onHookAdditionalContext: value => appendHookAdditionalContext(pendingHookContextForNextTurn, value),
                  }
                )
                content = typeof result === 'string' ? result : JSON.stringify(result)
                successfulTool = true
              } catch (error) {
                isError = true
                content = error instanceof Error ? error.message : String(error)
              }

              toolResultBlocks.push({
                type: 'tool_result',
                tool_use_id: toolCall.id,
                content,
                is_error: isError,
              })

              dispatch(
                chatSliceActions.streamChunkReceived({
                  streamId,
                  chunk: {
                    type: 'chunk',
                    part: 'tool_result',
                    toolResult: { tool_use_id: toolCall.id, content, is_error: isError },
                  },
                })
              )

              currentTurnHistory.push(createToolResultMessage(conversationId, lastMsg.id, toolCall.id, content))
            }

            if (toolResultBlocks.length > 0 && lastMsg.id) {
              const existingBlocks = Array.isArray(lastMsg.content_blocks) ? lastMsg.content_blocks : []
              const updatedContentBlocks = [...existingBlocks, ...toolResultBlocks]

              await persistAssistantMessageWithFallback(dispatch, {
                id: lastMsg.id,
                content: lastMsg.content,
                updatedContentBlocks,
                conversationId,
                streamId,
                contextLabel: 'editMessageWithBranching/openai',
              })

              const historyIndex = currentTurnHistory.findIndex(msg => msg.id === lastMsg.id)
              if (historyIndex !== -1) {
                currentTurnHistory[historyIndex] = {
                  ...currentTurnHistory[historyIndex],
                  content_blocks: updatedContentBlocks,
                }
              }
            }

            currentTurnContent = ''
            activeParentId = lastMsg.id
            continueTurn = successfulTool
          } else {
            continueTurn = false
          }

          if (!continueTurn) {
            const shouldContinueAfterStop = await shouldContinueFromStopHook({
              conversationId,
              streamId,
              cwd: effectiveToolRootPath,
              provider: serverProvider,
              model: modelName,
              operation: 'edit-branch',
              pendingHookContextForNextTurn,
              lastAssistantMessage: lastMsg,
              state: getState(),
              queryClient: extra.queryClient,
            })

            if (shouldContinueAfterStop) {
              currentTurnContent = ''
              activeParentId = lastMsg.id
              continueTurn = true
            }
          }

          if (!continueTurn) break
          continue
        }

        // Create new user message as a branch (or continuation) - cloud server handles LLM, storageMode in body controls DB
        const toolNameById = buildToolNameMap(currentTurnHistory)
        const streamOpen = await openConversationStreamWithRetry(
          `/conversations/${conversationId}/messages`,
          auth.accessToken,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messages: currentTurnHistory.map(m => {
                const contentBlocks = sanitizeContentBlocksForModel(m.content_blocks, m.tool_calls)
                if (m.role === 'tool' && m.tool_call_id) {
                  const toolName = toolNameById.get(m.tool_call_id) ?? null
                  const sanitizedContent = sanitizeToolResultContentForModel(m.content, toolName)
                  if (sanitizedContent !== m.content) {
                    const contentPlain =
                      typeof sanitizedContent === 'string' ? sanitizedContent : JSON.stringify(sanitizedContent)
                    return {
                      id: m.id,
                      conversation_id: m.conversation_id,
                      parent_id: m.parent_id,
                      children_ids: m.children_ids,
                      role: m.role,
                      thinking_block: m.thinking_block,
                      tool_calls: m.tool_calls,
                      content_blocks: contentBlocks,
                      content: sanitizedContent,
                      content_plain_text: contentPlain,
                      created_at: m.created_at,
                      model_name: m.model_name,
                      partial: m.partial,
                      artifacts: m.artifacts,
                    }
                  }
                }
                return {
                  id: m.id,
                  conversation_id: m.conversation_id,
                  parent_id: m.parent_id,
                  children_ids: m.children_ids,
                  role: m.role,
                  thinking_block: m.thinking_block,
                  tool_calls: m.tool_calls,
                  content_blocks: contentBlocks,
                  content: m.content,
                  content_plain_text: m.content_plain_text,
                  created_at: m.created_at,
                  model_name: m.model_name,
                  partial: m.partial,
                  artifacts: m.artifacts,
                }
              }),
              content: currentTurnContent,
              modelName,
              parentId: activeParentId, // Branch from the same parent as original (or updated parent)
              systemPrompt: systemPrompt,
              conversationContext: combinedContext,
              projectContext,
              provider: serverProvider,
              ...(openRouterTemperature !== undefined ? { temperature: openRouterTemperature } : {}),
              attachmentsBase64: turnCount === 1 ? attachmentsBase64 : undefined,
              selectedFiles: turnCount === 1 ? selectedFilesForChat : undefined,
              think,
              executionMode,
              isBranch: true,
              storageMode,
              isElectron: isElectronMode,
              tools: getToolsForAI(),
            }),
            signal: controller.signal,
          },
          {
            conversationId,
            streamId,
            controllerSignal: controller.signal,
          }
        )
        const response = streamOpen.response
        streamReader = streamOpen.reader
        firstRead = streamOpen.firstRead

        if (!response.ok) {
          // Handle free tier limit exceeded (403)
          if (response.status === 403) {
            const errorData = await response.json().catch(() => ({ error: 'unknown' }))
            if (errorData.error === 'generation_limit_reached') {
              dispatch(chatSliceActions.freeTierLimitModalShown())
              throw new Error(errorData.message || 'Free generations exhausted. Please upgrade to continue.')
            }
          }
          const errorText = await response.text()
          throw new Error(`HTTP ${response.status}: ${errorText}`)
        }

        const reader = streamReader
        if (!reader) throw new Error('No stream reader available')

        const decoder = new TextDecoder()
        // Buffer for incomplete lines across chunks
        let buffer = ''

        // State for this turn
        let assistantMessageContent = ''
        let assistantThinking = ''
        let assistantToolCalls: any[] = []
        let turnAssistantMessageId: string | null = null
        // Track processed tool calls (already executed on server)
        const processedToolCallIds = new Set<string>()
        let pendingRead = firstRead

        try {
          while (true) {
            const readResult = pendingRead ?? (await reader.read())
            pendingRead = null
            const { done, value } = readResult
            if (done) break

            // Append new data to buffer and split by newlines
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')

            // Keep the last incomplete line in the buffer
            buffer = lines.pop() || ''

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue

              try {
                const chunk = JSON.parse(line.slice(6))

                if (chunk.type === 'user_message' && chunk.message) {
                  userMessage = chunk.message
                  // Ensure message is in store
                  if (!chunk.message.timestamp) {
                    chunk.message.timestamp = new Date().toISOString()
                  }
                  dispatch(chatSliceActions.messageAdded(chunk.message))
                  // And update currentPath to this new user branch node
                  dispatch(chatSliceActions.messageBranchCreated({ newMessage: chunk.message }))
                  // Update stream lineage: assistant response will be child of this user message
                  dispatch(chatSliceActions.streamLineageUpdated({ streamId, targetParentId: chunk.message.id }))
                  // Sync to React Query cache immediately
                  updateMessageCache(extra.queryClient, conversationId, chunk.message)
                  // Sync user message to local SQLite (fire-and-forget)
                  dualSync.syncMessage({
                    ...chunk.message,
                    user_id: auth.userId,
                    project_id: selectedProject?.id || null,
                  })

                  // Touch project timestamp to reflect recent activity
                  if (selectedProject?.id) {
                    dualSync.touchProjectTimestamp(selectedProject.id)
                    // Update React Query cache immediately for instant UI update
                    touchProjectTimestampInCache(extra.queryClient, selectedProject.id, auth.userId)
                  }

                  // Save image attachments to local DB when in local mode
                  if (storageMode === 'local' && attachmentsBase64 && attachmentsBase64.length > 0) {
                    localApi
                      .post('/local/attachments/save-base64', {
                        messageId: chunk.message.id,
                        attachments: attachmentsBase64,
                      })
                      .catch(err => console.error('[editMessageWithBranching] Failed to save local attachments:', err))
                  }

                  // Add to local history for next turn
                  currentTurnHistory.push(chunk.message)
                  await maybePersistAutoConversationTitle({
                    dispatch,
                    conversationId,
                    storageMode,
                    parentId: chunk.message.parent_id ?? activeParentId ?? null,
                    content: chunk.message?.content_plain_text || chunk.message?.content || newContent,
                    contextLabel: 'editMessageWithBranching',
              skip: true,
                  })

                  // Live-update: ensure the new branched user message shows all intended artifacts immediately
                  // Use the combined list (existing - deleted + drafts) we computed prior to the request
                  if (combinedArtifacts.length > 0) {
                    dispatch(
                      chatSliceActions.messageArtifactsSet({
                        messageId: chunk.message.id,
                        artifacts: combinedArtifacts,
                      })
                    )
                    // Sync artifacts to React Query cache so images appear immediately in branched message
                    const cacheKey = ['conversations', conversationId, 'messages']
                    const existingData = extra.queryClient?.getQueryData<{ messages: Message[]; tree: any }>(cacheKey)
                    if (existingData) {
                      const updatedMessages = existingData.messages.map(msg =>
                        msg.id === chunk.message.id ? { ...msg, artifacts: combinedArtifacts } : msg
                      )
                      extra.queryClient?.setQueryData(cacheKey, {
                        messages: updatedMessages,
                        tree: existingData.tree,
                      })
                    }
                  }

                  // Clear optimistic branch message immediately when real branch message confirmed
                  dispatch(chatSliceActions.optimisticBranchMessageCleared())
                }

                // Handle tool results (accumulated server-side into content_blocks)
                if (chunk.part === 'tool_result' && chunk.toolResult) {
                  // console.log(
                  //   `✅ [editMessageWithBranching] Received tool_result for tool_use_id: ${chunk.toolResult.tool_use_id}`
                  // )

                  // Mark this tool call as processed by server
                  processedToolCallIds.add(chunk.toolResult.tool_use_id)

                  // Dispatch structured tool result data for proper rendering in streaming events
                  dispatch(
                    chatSliceActions.streamChunkReceived({
                      streamId,
                      chunk: {
                        type: 'chunk',
                        part: 'tool_result',
                        toolResult: chunk.toolResult,
                      },
                    })
                  )
                  // Skip generic chunk handler to prevent duplicate dispatch
                } else if (chunk.part === 'tool_call' && chunk.toolCall) {
                  // Accumulate tool calls locally
                  const exists = assistantToolCalls.some(tc => tc.id === chunk.toolCall.id)
                  if (!exists) {
                    assistantToolCalls.push(chunk.toolCall)
                  }
                  dispatch(
                    chatSliceActions.streamChunkReceived({
                      streamId,
                      chunk: {
                        type: 'chunk',
                        part: 'tool_call',
                        toolCall: chunk.toolCall,
                      },
                    })
                  )
                } else if (chunk.type === 'generation_started') {
                  dispatch(chatSliceActions.streamChunkReceived({ streamId, chunk }))
                  if (chunk.messageId) {
                    turnAssistantMessageId = chunk.messageId
                  }
                } else if (chunk.type === 'chunk') {
                  dispatch(chatSliceActions.streamChunkReceived({ streamId, chunk }))
                  if (chunk.part === 'text' && chunk.content) {
                    assistantMessageContent += chunk.content
                  } else if (chunk.part === 'text' && chunk.delta) {
                    assistantMessageContent += chunk.delta
                  } else if (chunk.part === 'reasoning' && chunk.delta) {
                    assistantThinking += chunk.delta
                  }
                } else if (chunk.type === 'complete' && chunk.message) {
                  messageId = chunk.message.id
                  // Store assistant message
                  dispatch(chatSliceActions.messageAdded(chunk.message))
                  // Navigate path to completed assistant reply
                  dispatch(chatSliceActions.messageBranchCreated({ newMessage: chunk.message }))
                  // Sync to React Query cache immediately
                  updateMessageCache(extra.queryClient, conversationId, chunk.message)
                  // Sync assistant message to local SQLite (fire-and-forget)
                  dualSync.syncMessage({
                    ...chunk.message,
                    user_id: auth.userId,
                    project_id: selectedProject?.id || null,
                  })

                  // Add to local history
                  currentTurnHistory.push(chunk.message)

                  // Sync provider cost if available
                  if (chunk.cost) {
                    dualSync.syncProviderCost({
                      ...chunk.cost,
                      message_id: chunk.message.id,
                    })
                  }
                  // Preserve current streaming UI until the next generation_started event clears it.
                } else if (chunk.type === 'free_generations_update') {
                  // Update free generations remaining count
                  dispatch(
                    chatSliceActions.freeGenerationsUpdated({
                      remaining: chunk.remaining,
                      isFreeTier: true,
                    })
                  )
                } else if (chunk.type === 'aborted') {
                  // Server deleted the empty assistant message, no need to keep it in client state
                  dispatch(
                    chatSliceActions.streamChunkReceived({
                      streamId,
                      chunk: { type: 'error', error: 'Generation aborted' },
                    })
                  )
                } else if (chunk.type === 'error') {
                  throw new Error(chunk.error || 'Stream error')
                }
              } catch (parseError) {
                // Silently skip malformed JSON chunks (e.g., emoji-prefixed tool indicators)
                // These are often tool call markers from the server that aren't valid JSON
                if (line.length > 100) {
                  console.warn('Failed to parse chunk:', line.substring(0, 100) + '...', parseError)
                }
              }
            }
          }
        } finally {
          reader.releaseLock()
        }

        // End of stream for this turn. Check if we have pending tool calls to execute locally.
        if (assistantToolCalls.length > 0 && executionMode === 'client') {
          // Filter out tool calls that were already processed by server
          const pendingToolCalls = assistantToolCalls.filter(tc => !processedToolCallIds.has(tc.id))

          if (pendingToolCalls.length > 0) {
            // console.log(`🛠️ [editMessageWithBranching] Executing ${pendingToolCalls.length} tool calls locally...`)

            // if (processedToolCallIds.size > 0) {
            //   console.log(
            //     `⏩ [editMessageWithBranching] Skipped ${processedToolCallIds.size} tool calls already handled by server`
            //   )
            // }

            // 1. Synthesize Assistant Message if we didn't get a 'complete' event
            if (!messageId && turnAssistantMessageId) {
              // Create ephemeral assistant message
              const assistantMsg: any = {
                id: turnAssistantMessageId,
                conversation_id: conversationId,
                role: 'assistant',
                content: assistantMessageContent,
                thinking_block: assistantThinking,
                tool_calls: assistantToolCalls,
                content_blocks: assistantToolCalls.map(tc => ({
                  type: 'tool_use',
                  id: tc.id,
                  name: tc.name,
                  input: tc.arguments,
                })),
                created_at: new Date().toISOString(),
                model_name: modelName,
                parent_id: userMessage?.id || activeParentId, // Link to parent (user msg or previous parent)
              }

              // Dispatch to Redux
              dispatch(chatSliceActions.messageAdded(assistantMsg))
              dispatch(chatSliceActions.messageBranchCreated({ newMessage: assistantMsg }))
              updateMessageCache(extra.queryClient, conversationId, assistantMsg)

              // Sync to DB
              dualSync.syncMessage({
                ...assistantMsg,
                user_id: auth.userId,
                project_id: selectedProject?.id || null,
              })

              // Update history
              currentTurnHistory.push(assistantMsg)
              messageId = assistantMsg.id
            }

            // 2. Execute tools and append tool_result blocks to assistant message
            const toolResultBlocks: any[] = []
            const rootPath = effectiveToolRootPath
            const operationMode = state.chat.operationMode

            let successfulDesktopTool = false
            let successfulBrowseWeb = false

            for (const toolCall of pendingToolCalls) {
              let content: string
              let isError = false

              try {
                const result = await executeToolWithPermissionCheck(
                  dispatch,
                  getState,
                  toolCall,
                  rootPath,
                  operationMode,
                  {
                    conversationId,
                    messageId: messageId ?? turnAssistantMessageId ?? undefined,
                    streamId,
                    accessToken: auth.accessToken,
                    queryClient: extra.queryClient,
                    enableHooks: true,
                    provider: serverProvider,
                    model: modelName,
                    operation: 'edit-branch',
                    onHookAdditionalContext: value => appendHookAdditionalContext(pendingHookContextForNextTurn, value),
                  }
                )

                content = typeof result === 'string' ? result : JSON.stringify(result)
                if (isElectronEnvironment) {
                  successfulDesktopTool = true
                } else if (toolCall?.name === 'browse_web') {
                  successfulBrowseWeb = true
                }
              } catch (error) {
                isError = true
                content = error instanceof Error ? error.message : String(error)
              }

              const toolResultBlock = {
                type: 'tool_result',
                tool_use_id: toolCall.id,
                content,
                is_error: isError,
              }

              toolResultBlocks.push(toolResultBlock)

              // Inform UI of tool result
              dispatch(
                chatSliceActions.streamChunkReceived({
                  streamId,
                  chunk: {
                    type: 'chunk',
                    part: 'tool_result',
                    toolResult: {
                      tool_use_id: toolCall.id,
                      content: toolResultBlock.content,
                      is_error: isError,
                    },
                  },
                })
              )
            }

            // 3. Update assistant message with tool results
            if (toolResultBlocks.length > 0 && messageId) {
              const assistantMessage = currentTurnHistory.find(msg => msg.id === messageId)
              if (assistantMessage) {
                const existingBlocks = parseContentBlocks(assistantMessage.content_blocks)
                const updatedContentBlocks = [...existingBlocks, ...toolResultBlocks]

                await persistAssistantMessageWithFallback(dispatch, {
                  id: assistantMessage.id,
                  content: assistantMessage.content,
                  updatedContentBlocks,
                  conversationId,
                  streamId,
                  contextLabel: 'editMessageWithBranching/cloud-client-tools',
                })

                // Update the assistant message in currentTurnHistory
                const historyIndex = currentTurnHistory.findIndex(msg => msg.id === assistantMessage.id)
                if (historyIndex !== -1) {
                  currentTurnHistory[historyIndex] = {
                    ...currentTurnHistory[historyIndex],
                    content_blocks: updatedContentBlocks,
                  }
                }
              }
            }

            // 4. Prepare for next turn
            const hasSuccessfulTool = successfulDesktopTool || successfulBrowseWeb

            currentTurnContent = ''
            activeParentId = messageId // Parent is the assistant message (not tool message)
            continueTurn = hasSuccessfulTool
            assistantMessageContent = ''
            assistantThinking = ''
            assistantToolCalls = []
          } else {
            // if (assistantToolCalls.length > 0 && processedToolCallIds.size > 0) {
            //   console.log('✅ [editMessageWithBranching] All tool calls handled by server')
            // }
            continueTurn = false
          }
        } else {
          continueTurn = false
        }

        if (!continueTurn) {
          const shouldContinueAfterStop = await shouldContinueFromStopHook({
            conversationId,
            streamId,
            cwd: effectiveToolRootPath,
            provider: serverProvider,
            model: modelName,
            operation: 'edit-branch',
            pendingHookContextForNextTurn,
            lastAssistantMessage:
              currentTurnHistory[currentTurnHistory.length - 1] ??
              (messageId ? { id: messageId, content: assistantMessageContent } : null),
            state: getState(),
            queryClient: extra.queryClient,
          })

          if (shouldContinueAfterStop) {
            currentTurnContent = ''
            activeParentId = messageId ?? activeParentId
            continueTurn = true
            assistantMessageContent = ''
            assistantThinking = ''
            assistantToolCalls = []
          }
        }
      } // end while loop

      if (messageId) {
        dispatch(chatSliceActions.streamCompleted({ streamId, messageId, updatePath: true }))
        // Clear backup after successfully creating the branch
        dispatch(chatSliceActions.messageArtifactsBackupCleared({ messageId: originalMessageId }))
      }

      dispatch(chatSliceActions.sendingCompleted({ streamId }))

      // Schedule stream cleanup after delay
      setTimeout(() => {
        dispatch(chatSliceActions.streamPruned({ streamId }))
      }, STREAM_PRUNE_DELAY)

      return { messageId, userMessage, originalMessageId, streamId }
    } catch (error) {
      dispatch(chatSliceActions.sendingCompleted({ streamId }))

      if (error instanceof Error && error.name === 'AbortError') {
        return rejectWithValue('Message cancelled')
      }

      const message = error instanceof Error ? error.message : 'Failed to edit message'
      dispatch(chatSliceActions.streamChunkReceived({ streamId, chunk: { type: 'error', error: message } }))
      return rejectWithValue(message)
    } finally {
      unregisterGenerationAbortController()
    }
  }
)

// Send message to specific branch
export const sendMessageToBranch = createAsyncThunk<
  { messageId: MessageId | null; userMessage: any; streamId: string },
  BranchMessagePayload & { streamId?: string },
  { state: RootState; extra: ThunkExtraArgument }
>(
  'chat/sendMessageToBranch',
  async (
    { conversationId, parentId, content, modelOverride, systemPrompt, think, cwd, streamId: providedStreamId },
    { dispatch, getState, extra, rejectWithValue, signal }
  ) => {
    const { auth } = extra

    // Generate or use provided stream ID
    const streamId = providedStreamId ?? generateStreamId('branch')
    const preSendState = getState() as RootState
    const preSendDrafts = preSendState.chat.composition.imageDrafts || []
    const preSendAttachmentsBase64 = preSendDrafts.length
      ? preSendDrafts.map(d => ({ dataUrl: d.dataUrl, name: d.name, type: d.type, size: d.size }))
      : null
    const preSendSelectedFilesForChat = preSendState.ideContext.selectedFilesForChat || []

    dispatch(
      chatSliceActions.sendingStarted({
        streamId,
        streamType: 'branch',
        conversationId,
        lineage: {
          rootMessageId: parentId,
        },
      })
    )

    let controller: AbortController | undefined
    let unregisterGenerationAbortController = () => {}

    try {
      controller = new AbortController()
      signal.addEventListener('abort', () => controller?.abort())
      unregisterGenerationAbortController = registerGenerationAbortController(streamId, controller)

      const state = getState() as RootState

      // Read selected model from React Query cache
      const provider = state.chat.providerState.currentProvider
      const modelsData = extra.queryClient?.getQueryData<{
        models: Model[]
        default: Model
        selected: Model
      }>(['models', provider])
      const selectedName = modelsData?.selected?.name || modelsData?.default?.name
      const modelName = modelOverride || selectedName
      // Map UI provider to server provider id
      const providerRaw = state.chat.providerState.currentProvider || 'ollama'
      const appProvider = providerRaw.toLowerCase()
      const providerSlug = appProvider.replace(/\s+/g, '')
      const serverProvider = providerSlug === 'google' ? 'gemini' : providerSlug
      const openRouterTemperature = resolveOpenRouterTemperature(providerSlug)
      const isLmStudio = providerSlug === 'lmstudio'
      const isOpenAIChatGPT = providerSlug === 'openaichatgpt' || providerSlug === 'openai(chatgpt)'
      const attachmentsBase64 = preSendAttachmentsBase64

      // Retrieve project and conversation context to send with branch message
      const selectedProject = selectSelectedProject(state)
      const projectContext = selectedProject?.context || null
      const conversationContextSource = state.conversations.convContext || null
      const combinedContext =
        projectContext && conversationContextSource
          ? `${projectContext}\n\n${conversationContextSource}`
          : projectContext || conversationContextSource || null
// Get selected files for chat captured before send start so UI can clear immediately
const selectedFilesForChat = preSendSelectedFilesForChat

const conversationMeta = state.conversations.items.find(c => c.id === conversationId)
// Use React Query cache as fallback for storage mode detection (handles local conversations not yet in Redux)
const storageMode = conversationMeta?.storage_mode || getStorageModeFromCache(extra.queryClient, conversationId)
// Keep cwd for tool execution context only (do not inject cwd into system prompt)
let effectiveSystemPrompt = systemPrompt
const payloadCwd = typeof cwd === 'string' ? cwd.trim() : (cwd ?? null)
const effectiveToolRootPath = payloadCwd || conversationMeta?.cwd || state.ideContext.workspace?.rootPath || null
// Append custom tools explanation to system prompt
effectiveSystemPrompt = (effectiveSystemPrompt || '') + '\n\n' + sysPromptConfig.customToolsPrompt
const baseSystemPrompt = effectiveSystemPrompt

// Determine execution mode
const isElectronMode =
  import.meta.env.VITE_ENVIRONMENT === 'electron' || (typeof __IS_ELECTRON__ !== 'undefined' && __IS_ELECTRON__)
const executionMode = 'client'

      const pendingHookContextForNextTurn: string[] = []
      let currentTurnContent = await maybeApplyUserPromptSubmitHook({
        conversationId,
        streamId,
        cwd: effectiveToolRootPath,
        provider: serverProvider,
        model: modelName,
        operation: 'branch',
        prompt: content,
        pendingHookContextForNextTurn,
        parentId: parentId ?? null,
        state,
        queryClient: extra.queryClient,
      })
      let currentParentId = parentId
      let continueTurn = true
      let turnCount = 0
      const MAX_TURNS = 100
      let messageId: MessageId | null = null
      let userMessage: any = null

      // Build history from parent chain for LM Studio
      const messagesCache = extra.queryClient?.getQueryData<{ messages: Message[]; tree: any }>([
        'conversations',
        conversationId,
        'messages',
      ])
      const cachedMessages = messagesCache?.messages || []
      const currentMessages = cachedMessages.length > 0 ? cachedMessages : state.chat.conversation.messages

      // Build history by walking up parent chain
      const buildHistoryFromParent = (parentId: MessageId | null): Message[] => {
        const history: Message[] = []
        let currentId = parentId
        while (currentId) {
          const msg = currentMessages.find(m => m.id === currentId)
          if (msg) {
            history.unshift(msg)
            currentId = msg.parent_id
          } else {
            break
          }
        }
        return history
      }

      let currentTurnHistory = buildHistoryFromParent(parentId)
      const shouldUseLmStudio = isElectronMode && isLmStudio
      const shouldUseOpenAIChatGPT = isElectronMode && isOpenAIChatGPT

      while (continueTurn && turnCount < MAX_TURNS) {
        turnCount++
        continueTurn = false
        const effectiveSystemPrompt = buildSystemPromptWithHookContext(baseSystemPrompt, pendingHookContextForNextTurn)
        pendingHookContextForNextTurn.length = 0
        let streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null
        let firstRead: ReadableStreamReadResult<Uint8Array> | null = null

        // LM Studio branch: handle locally
        if (shouldUseLmStudio) {
          const toolNameById = buildToolNameMap(currentTurnHistory)
          // Synthesize user message locally on first turn
          if (turnCount === 1 && currentTurnContent && currentTurnContent.trim()) {
            const newUserMessage: Message = {
              id: uuidv4(),
              conversation_id: conversationId,
              parent_id: currentParentId,
              children_ids: [],
              role: 'user',
              content: currentTurnContent,
              content_plain_text: currentTurnContent,
              thinking_block: '',
              tool_calls: [],
              content_blocks: [],
              created_at: new Date().toISOString(),
              model_name: modelName || '',
              partial: false,
              artifacts: [],
              pastedContext: [],
            }

            dispatch(chatSliceActions.messageBranchCreated({ newMessage: newUserMessage }))
            updateMessageCache(extra.queryClient, conversationId, newUserMessage)

            // Sync to local SQLite
            localApi
              .post('/sync/message', {
                ...newUserMessage,
                conversation_id: conversationId,
                children_ids: newUserMessage.children_ids,
                content_blocks: newUserMessage.content_blocks,
                tool_calls: newUserMessage.tool_calls,
                user_id: auth.userId,
                owner_id: auth.userId,
                project_id: selectedProject?.id || null,
                storage_mode: storageMode,
              })
              .catch(err => console.error('[sendMessageToBranch][lmstudio] Failed to sync user message:', err))

            userMessage = newUserMessage
            currentTurnHistory.push(newUserMessage)
            await maybePersistAutoConversationTitle({
              dispatch,
              conversationId,
              storageMode,
              parentId: newUserMessage.parent_id,
              content: content,
              contextLabel: 'sendMessageToBranch',
              skip: true,
            })
            currentParentId = newUserMessage.id
          }

          // Build LM Studio messages (OpenAI-compatible format)
          const lmMessages: any[] = []
          if (effectiveSystemPrompt && effectiveSystemPrompt.trim()) {
            lmMessages.push({ role: 'system', content: effectiveSystemPrompt })
          }
          for (const m of currentTurnHistory) {
            if (m.role === 'user') {
              lmMessages.push({ role: 'user', content: m.content })
            } else if (m.role === 'assistant') {
              const assistantMsg: any = { role: 'assistant', content: m.content || '' }
              if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                assistantMsg.tool_calls = m.tool_calls.map(tc => ({
                  id: tc.id,
                  type: 'function',
                  function: {
                    name: tc.name,
                    arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}),
                  },
                }))
              }
              lmMessages.push(assistantMsg)
            } else if (appendCompactionSummaryToLmStudioHistory(lmMessages, m)) {
              continue
            } else if (m.role === 'tool' && m.tool_call_id) {
              const toolName = toolNameById.get(m.tool_call_id)
              const sanitizedContent = sanitizeToolResultContentForModel(m.content, toolName ?? null)
              lmMessages.push({
                role: 'tool',
                tool_call_id: m.tool_call_id,
                content: typeof sanitizedContent === 'string' ? sanitizedContent : JSON.stringify(sanitizedContent),
              })
            }
          }

          await createLmStudioStreamingRequest(
            {
              conversationId,
              parentId: currentParentId,
              modelName,
              systemPrompt: effectiveSystemPrompt || '',
              messages: lmMessages,
              tools: getToolsForAI(),
            },
            {
              onChunk: chunk => {
                dispatch(chatSliceActions.streamChunkReceived({ streamId, chunk }))
                if (chunk.type === 'complete' && chunk.message) {
                  dispatch(chatSliceActions.messageBranchCreated({ newMessage: chunk.message }))
                  updateMessageCache(extra.queryClient, conversationId, chunk.message)
                  // Sync to local SQLite
                  localApi
                    .post('/sync/message', {
                      ...chunk.message,
                      conversation_id: conversationId,
                      children_ids: chunk.message.children_ids || [],
                      content_blocks: chunk.message.content_blocks || [],
                      tool_calls: chunk.message.tool_calls || [],
                      user_id: auth.userId,
                      owner_id: auth.userId,
                      project_id: selectedProject?.id || null,
                      storage_mode: storageMode,
                    })
                    .catch(err =>
                      console.error('[sendMessageToBranch][lmstudio] Failed to sync assistant message:', err)
                    )
                  messageId = chunk.message.id
                  currentTurnContent = ''
                  currentTurnHistory.push(chunk.message)
                }
              },
              signal: controller.signal,
            }
          )

          // After streaming, handle tool calls (same pattern as sendMessage)
          const lastMsg = currentTurnHistory[currentTurnHistory.length - 1]
          const pendingToolCalls = Array.isArray(lastMsg?.tool_calls) ? lastMsg.tool_calls : []
          const isStreamActive = getState().chat.streaming.byId[streamId]?.active ?? false

          if (pendingToolCalls.length > 0 && isStreamActive) {
            const rootPath = effectiveToolRootPath
            const operationMode = state.chat.operationMode
            const toolResultBlocks: any[] = []
            let successfulTool = false

            for (const toolCall of pendingToolCalls) {
              let content: string
              let isError = false

              try {
                const result = await executeToolWithPermissionCheck(
                  dispatch,
                  getState,
                  toolCall,
                  rootPath,
                  operationMode,
                  {
                    conversationId,
                    messageId: lastMsg.id,
                    streamId,
                    accessToken: auth.accessToken,
                    queryClient: extra.queryClient,
                    enableHooks: true,
                    provider: serverProvider,
                    model: modelName,
                    operation: 'branch',
                    onHookAdditionalContext: value => appendHookAdditionalContext(pendingHookContextForNextTurn, value),
                  }
                )
                content = typeof result === 'string' ? result : JSON.stringify(result)
                successfulTool = true
              } catch (error) {
                isError = true
                content = error instanceof Error ? error.message : String(error)
              }

              const toolResultBlock = {
                type: 'tool_result',
                tool_use_id: toolCall.id,
                content,
                is_error: isError,
              }
              toolResultBlocks.push(toolResultBlock)

              dispatch(
                chatSliceActions.streamChunkReceived({
                  streamId,
                  chunk: {
                    type: 'chunk',
                    part: 'tool_result',
                    toolResult: { tool_use_id: toolCall.id, content, is_error: isError },
                  },
                })
              )

              currentTurnHistory.push(createToolResultMessage(conversationId, lastMsg.id, toolCall.id, content))
            }

            if (toolResultBlocks.length > 0 && lastMsg.id) {
              const existingBlocks = Array.isArray(lastMsg.content_blocks) ? lastMsg.content_blocks : []
              const updatedContentBlocks = [...existingBlocks, ...toolResultBlocks]

              await persistAssistantMessageWithFallback(dispatch, {
                id: lastMsg.id,
                content: lastMsg.content,
                updatedContentBlocks,
                conversationId,
                streamId,
                contextLabel: 'sendMessageToBranch/lmstudio',
              })

              const historyIndex = currentTurnHistory.findIndex(msg => msg.id === lastMsg.id)
              if (historyIndex !== -1) {
                currentTurnHistory[historyIndex] = {
                  ...currentTurnHistory[historyIndex],
                  content_blocks: updatedContentBlocks,
                }
              }
            }

            currentTurnContent = ''
            currentParentId = lastMsg.id
            continueTurn = successfulTool
          } else {
            continueTurn = false
          }

          if (!continueTurn) {
            const shouldContinueAfterStop = await shouldContinueFromStopHook({
              conversationId,
              streamId,
              cwd: effectiveToolRootPath,
              provider: serverProvider,
              model: modelName,
              operation: 'branch',
              pendingHookContextForNextTurn,
              lastAssistantMessage: lastMsg,
              state: getState(),
              queryClient: extra.queryClient,
            })

            if (shouldContinueAfterStop) {
              currentTurnContent = ''
              currentParentId = lastMsg.id
              continueTurn = true
            }
          }

          if (!continueTurn) break
          continue
        }

        // OpenAI ChatGPT branch: handle locally via OAuth tokens
        if (shouldUseOpenAIChatGPT) {
          const toolNameById = buildToolNameMap(currentTurnHistory)
          // Synthesize user message locally on first turn
          if (turnCount === 1 && currentTurnContent && currentTurnContent.trim()) {
            const newUserMessage: Message = {
              id: uuidv4(),
              conversation_id: conversationId,
              parent_id: currentParentId,
              children_ids: [],
              role: 'user',
              content: currentTurnContent,
              content_plain_text: currentTurnContent,
              thinking_block: '',
              tool_calls: [],
              content_blocks: [],
              created_at: new Date().toISOString(),
              model_name: modelName || '',
              partial: false,
              artifacts: [],
              pastedContext: [],
            }

            dispatch(chatSliceActions.messageBranchCreated({ newMessage: newUserMessage }))
            updateMessageCache(extra.queryClient, conversationId, newUserMessage)

            try {
              await localApi.post('/sync/message', {
                ...newUserMessage,
                conversation_id: conversationId,
                children_ids: newUserMessage.children_ids,
                content_blocks: newUserMessage.content_blocks,
                tool_calls: newUserMessage.tool_calls,
                user_id: auth.userId,
                owner_id: auth.userId,
                project_id: selectedProject?.id || null,
                storage_mode: storageMode,
              })
            } catch (err) {
              console.error('[sendMessageToBranch][openai-chatgpt] Failed to sync user message:', err)
            }

            // Save image attachments to local DB for the new branched user message
            if (storageMode === 'local' && attachmentsBase64 && attachmentsBase64.length > 0) {
              localApi
                .post('/local/attachments/save-base64', {
                  messageId: newUserMessage.id,
                  attachments: attachmentsBase64,
                })
                .catch(err =>
                  console.error('[sendMessageToBranch][openai-chatgpt] Failed to save local attachments:', err)
                )
            }

            // Live-update artifacts so images appear immediately in the branch message
            if (preSendDrafts.length > 0) {
              const artifactDataUrls = preSendDrafts.map(d => d.dataUrl)
              dispatch(
                chatSliceActions.messageArtifactsAppended({
                  messageId: newUserMessage.id,
                  artifacts: artifactDataUrls,
                })
              )
              updateMessageArtifactsInCache(extra.queryClient, conversationId, newUserMessage.id, artifactDataUrls)
            }

            userMessage = newUserMessage
            currentTurnHistory.push(newUserMessage)
            await maybePersistAutoConversationTitle({
              dispatch,
              conversationId,
              storageMode,
              parentId: newUserMessage.parent_id,
              content: content,
              contextLabel: 'sendMessageToBranch',
              skip: true,
            })
            currentParentId = newUserMessage.id
          }

          // Build ChatGPT messages
          const chatgptMessages: any[] = []
          if (effectiveSystemPrompt && effectiveSystemPrompt.trim()) {
            chatgptMessages.push({ role: 'system', content: effectiveSystemPrompt })
          }
          for (const m of currentTurnHistory) {
            if (m.role === 'user') {
              chatgptMessages.push({
                role: 'user',
                content: m.content,
                artifacts: Array.isArray((m as any).artifacts) ? (m as any).artifacts : undefined,
                content_blocks: (m as any).content_blocks,
                attachments: (m as any).attachments,
              })
            } else if (m.role === 'assistant') {
              const assistantMsg: any = {
                role: 'assistant',
                content: m.content || '',
                content_blocks: sanitizeContentBlocksForModel(m.content_blocks, m.tool_calls),
                responses_output_items: (m as any)?.responses_output_items,
              }
              if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                assistantMsg.tool_calls = m.tool_calls.map(tc => ({
                  id: tc.id,
                  name: tc.name,
                  arguments: tc.arguments,
                }))
              }
              chatgptMessages.push(assistantMsg)
            } else if (appendCompactionSummaryToOpenAIChatGPTHistory(chatgptMessages, m)) {
              continue
            } else if (m.role === 'tool' && m.tool_call_id) {
              const toolName = toolNameById.get(m.tool_call_id)
              const sanitizedContent = sanitizeToolResultContentForModel(m.content, toolName ?? null)
              chatgptMessages.push({
                role: 'tool',
                tool_call_id: m.tool_call_id,
                content: typeof sanitizedContent === 'string' ? sanitizedContent : JSON.stringify(sanitizedContent),
              })
            }
          }

          await createOpenAIChatGPTStreamingRequest(
            {
              conversationId,
              parentId: currentParentId,
              modelName,
              systemPrompt: effectiveSystemPrompt || '',
              messages: chatgptMessages,
              attachmentsBase64: turnCount === 1 ? attachmentsBase64 : undefined,
              tools: getToolsForOpenAIChatGPT(),
            },
            {
              onChunk: chunk => {
                dispatch(chatSliceActions.streamChunkReceived({ streamId, chunk }))
                if (chunk.type === 'complete' && chunk.message) {
                  const assistantMsg = chunk.message
                  dispatch(chatSliceActions.messageBranchCreated({ newMessage: assistantMsg }))
                  updateMessageCache(extra.queryClient, conversationId, assistantMsg)
                  localApi
                    .post('/sync/message', {
                      ...assistantMsg,
                      conversation_id: conversationId,
                      children_ids: assistantMsg.children_ids || [],
                      content_blocks: assistantMsg.content_blocks || [],
                      tool_calls: assistantMsg.tool_calls || [],
                      user_id: auth.userId,
                      owner_id: auth.userId,
                      project_id: selectedProject?.id || null,
                      storage_mode: storageMode,
                    })
                    .catch(err =>
                      console.error('[sendMessageToBranch][openai-chatgpt] Failed to sync assistant message:', err)
                    )
                    messageId = assistantMsg.id
                    currentTurnHistory.push(assistantMsg)
                    // Keep current streaming UI until the next generation_started event clears it.
                }
              },
              signal: controller.signal,
            }
          )

          // Handle tool calls
          const lastMsg = currentTurnHistory[currentTurnHistory.length - 1]
          const pendingToolCalls = Array.isArray(lastMsg?.tool_calls) ? lastMsg.tool_calls : []
          const isStreamActive = getState().chat.streaming.byId[streamId]?.active ?? false

          if (pendingToolCalls.length > 0 && isStreamActive) {
            const rootPath = effectiveToolRootPath
            const operationMode = state.chat.operationMode
            const toolResultBlocks: any[] = []
            let successfulTool = false

            for (const toolCall of pendingToolCalls) {
              let content: string
              let isError = false
              try {
                const result = await executeToolWithPermissionCheck(
                  dispatch,
                  getState,
                  toolCall,
                  rootPath,
                  operationMode,
                  {
                    conversationId,
                    messageId: lastMsg.id,
                    streamId,
                    accessToken: auth.accessToken,
                    queryClient: extra.queryClient,
                    enableHooks: true,
                    provider: serverProvider,
                    model: modelName,
                    operation: 'branch',
                    onHookAdditionalContext: value => appendHookAdditionalContext(pendingHookContextForNextTurn, value),
                  }
                )
                content = typeof result === 'string' ? result : JSON.stringify(result)
                successfulTool = true
              } catch (error) {
                isError = true
                content = error instanceof Error ? error.message : String(error)
              }

              toolResultBlocks.push({
                type: 'tool_result',
                tool_use_id: toolCall.id,
                content,
                is_error: isError,
              })

              dispatch(
                chatSliceActions.streamChunkReceived({
                  streamId,
                  chunk: {
                    type: 'chunk',
                    part: 'tool_result',
                    toolResult: { tool_use_id: toolCall.id, content, is_error: isError },
                  },
                })
              )

              currentTurnHistory.push(createToolResultMessage(conversationId, lastMsg.id, toolCall.id, content))
            }

            if (toolResultBlocks.length > 0 && lastMsg.id) {
              const existingBlocks = Array.isArray(lastMsg.content_blocks) ? lastMsg.content_blocks : []
              const updatedContentBlocks = [...existingBlocks, ...toolResultBlocks]

              await persistAssistantMessageWithFallback(dispatch, {
                id: lastMsg.id,
                content: lastMsg.content,
                updatedContentBlocks,
                conversationId,
                streamId,
                contextLabel: 'sendMessageToBranch/openai',
              })

              const historyIndex = currentTurnHistory.findIndex(msg => msg.id === lastMsg.id)
              if (historyIndex !== -1) {
                currentTurnHistory[historyIndex] = {
                  ...currentTurnHistory[historyIndex],
                  content_blocks: updatedContentBlocks,
                }
              }
            }

            currentTurnContent = ''
            currentParentId = lastMsg.id
            continueTurn = successfulTool
          } else {
            continueTurn = false
          }

          if (!continueTurn) {
            const shouldContinueAfterStop = await shouldContinueFromStopHook({
              conversationId,
              streamId,
              cwd: effectiveToolRootPath,
              provider: serverProvider,
              model: modelName,
              operation: 'branch',
              pendingHookContextForNextTurn,
              lastAssistantMessage: lastMsg,
              state: getState(),
              queryClient: extra.queryClient,
            })

            if (shouldContinueAfterStop) {
              currentTurnContent = ''
              currentParentId = lastMsg.id
              continueTurn = true
            }
          }

          if (!continueTurn) break
          continue
        }

        // Cloud server handles LLM generation; storageMode in body tells it whether to save to cloud DB
        const endpoint = `/conversations/${conversationId}/messages`

        const streamOpen = await openConversationStreamWithRetry(
          endpoint,
          auth.accessToken,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: currentTurnContent,
              modelName,
              parentId: currentParentId,
              systemPrompt: effectiveSystemPrompt,
              conversationContext: combinedContext,
              projectContext,
              provider: serverProvider,
              ...(openRouterTemperature !== undefined ? { temperature: openRouterTemperature } : {}),
              attachmentsBase64: turnCount === 1 ? attachmentsBase64 : undefined,
              selectedFiles: turnCount === 1 ? selectedFilesForChat : undefined,
              think,
              executionMode,
              isBranch: true,
              storageMode,
              isElectron: isElectronMode,
              tools: getToolsForAI(),
            }),
            signal: controller.signal,
          },
          {
            conversationId,
            streamId,
            controllerSignal: controller.signal,
          }
        )
        const response = streamOpen.response
        streamReader = streamOpen.reader
        firstRead = streamOpen.firstRead

        if (!response.ok) {
          // Handle free tier limit exceeded (403)
          if (response.status === 403) {
            const errorData = await response.json().catch(() => ({ error: 'unknown' }))
            if (errorData.error === 'generation_limit_reached') {
              dispatch(chatSliceActions.freeTierLimitModalShown())
              throw new Error(errorData.message || 'Free generations exhausted. Please upgrade to continue.')
            }
          }
          const errorText = await response.text()
          throw new Error(`HTTP ${response.status}: ${errorText}`)
        }

        const reader = streamReader
        if (!reader) throw new Error('No stream reader available')

        const decoder = new TextDecoder()
        // Buffer for incomplete lines across chunks
        let buffer = ''

        // State for this turn
        let assistantMessageContent = ''
        let assistantThinking = ''
        let assistantToolCalls: any[] = []
        let turnAssistantMessageId: string | null = null
        // Track processed tool calls (already executed on server)
        const processedToolCallIds = new Set<string>()
        let pendingRead = firstRead

        try {
          while (true) {
            const readResult = pendingRead ?? (await reader.read())
            pendingRead = null
            const { done, value } = readResult
            if (done) break

            // Append new data to buffer and split by newlines
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')

            // Keep the last incomplete line in the buffer
            buffer = lines.pop() || ''

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue

              try {
                const chunk = JSON.parse(line.slice(6))

                if (chunk.type === 'user_message' && chunk.message) {
                  userMessage = chunk.message
                  dispatch(chatSliceActions.messageBranchCreated({ newMessage: chunk.message }))
                  // Sync to React Query cache immediately
                  updateMessageCache(extra.queryClient, conversationId, chunk.message)
                  // Sync user message to local SQLite (fire-and-forget)
                  dualSync.syncMessage({
                    ...chunk.message,
                    user_id: auth.userId,
                    project_id: selectedProject?.id || null,
                  })

                  // Touch project timestamp to reflect recent activity
                  if (selectedProject?.id) {
                    dualSync.touchProjectTimestamp(selectedProject.id)
                    // Update React Query cache immediately for instant UI update
                    touchProjectTimestampInCache(extra.queryClient, selectedProject.id, auth.userId)
                  }

                  // Save image attachments to local DB when in local mode
                  if (storageMode === 'local' && attachmentsBase64 && attachmentsBase64.length > 0) {
                    localApi
                      .post('/local/attachments/save-base64', {
                        messageId: chunk.message.id,
                        attachments: attachmentsBase64,
                      })
                      .catch(err => console.error('[sendMessageToBranch] Failed to save local attachments:', err))
                  }

                  await maybePersistAutoConversationTitle({
                    dispatch,
                    conversationId,
                    storageMode,
                    parentId: chunk.message.parent_id ?? currentParentId ?? null,
                    content: chunk.message?.content_plain_text || chunk.message?.content || content,
                    contextLabel: 'sendMessageToBranch',
              skip: true,
                  })
                }

                // Handle tool results (accumulated server-side into content_blocks)
                if (chunk.part === 'tool_result' && chunk.toolResult) {
                  // Mark this tool call as processed by server
                  processedToolCallIds.add(chunk.toolResult.tool_use_id)

                  // Dispatch structured tool result data for proper rendering in streaming events
                  dispatch(
                    chatSliceActions.streamChunkReceived({
                      streamId,
                      chunk: {
                        type: 'chunk',
                        part: 'tool_result',
                        toolResult: chunk.toolResult,
                      },
                    })
                  )
                  // Skip generic chunk handler to prevent duplicate dispatch
                } else if (chunk.part === 'tool_call' && chunk.toolCall) {
                  // Accumulate tool calls locally
                  const exists = assistantToolCalls.some(tc => tc.id === chunk.toolCall.id)
                  if (!exists) {
                    assistantToolCalls.push(chunk.toolCall)
                  }
                  dispatch(
                    chatSliceActions.streamChunkReceived({
                      streamId,
                      chunk: {
                        type: 'chunk',
                        part: 'tool_call',
                        toolCall: chunk.toolCall,
                      },
                    })
                  )
                } else if (chunk.type === 'generation_started') {
                  dispatch(chatSliceActions.streamChunkReceived({ streamId, chunk }))
                  if (chunk.messageId) {
                    turnAssistantMessageId = chunk.messageId
                  }
                } else if (chunk.type === 'chunk') {
                  dispatch(chatSliceActions.streamChunkReceived({ streamId, chunk }))
                  if (chunk.part === 'text' && chunk.content) {
                    assistantMessageContent += chunk.content
                  } else if (chunk.part === 'text' && chunk.delta) {
                    assistantMessageContent += chunk.delta
                  } else if (chunk.part === 'reasoning' && chunk.delta) {
                    assistantThinking += chunk.delta
                  }
                } else if (chunk.type === 'complete' && chunk.message) {
                  messageId = chunk.message.id
                  dispatch(chatSliceActions.messageBranchCreated({ newMessage: chunk.message }))
                  // Sync to React Query cache immediately
                  updateMessageCache(extra.queryClient, conversationId, chunk.message)
                  // Sync assistant message to local SQLite (fire-and-forget)
                  dualSync.syncMessage({
                    ...chunk.message,
                    user_id: auth.userId,
                    project_id: selectedProject?.id || null,
                  })
                  // Sync provider cost if available
                  if (chunk.cost) {
                    dualSync.syncProviderCost({
                      ...chunk.cost,
                      message_id: chunk.message.id,
                    })
                  }
                  // Preserve current streaming UI until the next generation_started event clears it.
                } else if (chunk.type === 'free_generations_update') {
                  // Update free generations remaining count
                  dispatch(
                    chatSliceActions.freeGenerationsUpdated({
                      remaining: chunk.remaining,
                      isFreeTier: true,
                    })
                  )
                } else if (chunk.type === 'aborted') {
                  // Server deleted the empty assistant message, no need to keep it in client state
                  dispatch(
                    chatSliceActions.streamChunkReceived({
                      streamId,
                      chunk: { type: 'error', error: 'Generation aborted' },
                    })
                  )
                } else if (chunk.type === 'error') {
                  throw new Error(chunk.error || 'Stream error')
                }
              } catch (parseError) {
                // Silently skip malformed JSON chunks (e.g., emoji-prefixed tool indicators)
                // These are often tool call markers from the server that aren't valid JSON
                if (line.length > 100) {
                  console.warn('Failed to parse chunk:', line.substring(0, 100) + '...', parseError)
                }
              }
            }
          }
        } finally {
          reader.releaseLock()
        }

        // End of stream for this turn. Check if we have pending tool calls to execute locally.
        if (assistantToolCalls.length > 0 && executionMode === 'client') {
          // Filter out tool calls that were already processed by server
          const pendingToolCalls = assistantToolCalls.filter(tc => !processedToolCallIds.has(tc.id))

          if (pendingToolCalls.length > 0) {
            // console.log(`🛠️ [sendMessageToBranch] Executing ${pendingToolCalls.length} tool calls locally...`)

            // if (processedToolCallIds.size > 0) {
            //   console.log(
            //     `⏩ [sendMessageToBranch] Skipped ${processedToolCallIds.size} tool calls already handled by server`
            //   )
            // }

            // 1. Synthesize Assistant Message if we didn't get a 'complete' event
            if (!messageId && turnAssistantMessageId) {
              // Create ephemeral assistant message
              const assistantMsg: any = {
                id: turnAssistantMessageId,
                conversation_id: conversationId,
                role: 'assistant',
                content: assistantMessageContent,
                thinking_block: assistantThinking,
                tool_calls: assistantToolCalls,
                content_blocks: assistantToolCalls.map(tc => ({
                  type: 'tool_use',
                  id: tc.id,
                  name: tc.name,
                  input: tc.arguments,
                })),
                created_at: new Date().toISOString(),
                model_name: modelName,
                parent_id: userMessage?.id || currentParentId, // Link to parent
              }

              // Dispatch to Redux (optimistic)
              dispatch(chatSliceActions.messageBranchCreated({ newMessage: assistantMsg }))
              // Normally we'd check if it's already added, but branch created adds it to path?
              // Actually messageBranchCreated usually updates path.
              // We should also add message to store if not there?
              // 'messageBranchCreated' in chatSlice handles adding to messages array?
              // Let's check 'messageAdded' usage in previous thunk.
              // It calls 'messageAdded' THEN 'messageBranchCreated'.

              dispatch(chatSliceActions.messageAdded(assistantMsg))
              // Re-dispatch branch created to ensure path is correct?
              // Actually if we just do messageAdded, it might not update path.
              // messageBranchCreated logic usually takes the message and updates path.
              // Let's call both to be safe and consistent with loop above.

              updateMessageCache(extra.queryClient, conversationId, assistantMsg)

              // Sync to DB
              dualSync.syncMessage({
                ...assistantMsg,
                user_id: auth.userId,
                project_id: selectedProject?.id || null,
              })

              messageId = assistantMsg.id
            }

            // 2. Execute tools and append tool_result blocks to assistant message
            const toolResultBlocks: any[] = []
            const rootPath = effectiveToolRootPath
            const operationMode = state.chat.operationMode

            let successfulDesktopTool = false
            let successfulBrowseWeb = false

            for (const toolCall of pendingToolCalls) {
              let content: string
              let isError = false

              try {
                const result = await executeToolWithPermissionCheck(
                  dispatch,
                  getState,
                  toolCall,
                  rootPath,
                  operationMode,
                  {
                    conversationId,
                    messageId: messageId ?? turnAssistantMessageId ?? undefined,
                    streamId,
                    accessToken: auth.accessToken,
                    queryClient: extra.queryClient,
                    enableHooks: true,
                    provider: serverProvider,
                    model: modelName,
                    operation: 'branch',
                    onHookAdditionalContext: value => appendHookAdditionalContext(pendingHookContextForNextTurn, value),
                  }
                )

                content = typeof result === 'string' ? result : JSON.stringify(result)
                if (isElectronEnvironment) {
                  successfulDesktopTool = true
                } else if (toolCall?.name === 'browse_web') {
                  successfulBrowseWeb = true
                }
              } catch (error) {
                isError = true
                content = error instanceof Error ? error.message : String(error)
              }

              const toolResultBlock = {
                type: 'tool_result',
                tool_use_id: toolCall.id,
                content,
                is_error: isError,
              }

              toolResultBlocks.push(toolResultBlock)

              // Inform UI of tool result
              dispatch(
                chatSliceActions.streamChunkReceived({
                  streamId,
                  chunk: {
                    type: 'chunk',
                    part: 'tool_result',
                    toolResult: {
                      tool_use_id: toolCall.id,
                      content: toolResultBlock.content,
                      is_error: isError,
                    },
                  },
                })
              )
            }

            // 3. Update assistant message with tool results
            if (toolResultBlocks.length > 0 && messageId) {
              // We need to fetch the message content to append blocks
              // Ideally we have it in `assistantMessageContent` + `assistantToolCalls`
              // But we better use `updateMessage` thunk which handles state update.
              // However, `updateMessage` takes `content`.

              // We need to construct the `content_blocks` array.
              // Existing blocks are `assistantToolCalls` (converted to blocks).
              // Plus `toolResultBlocks`.

              // Wait, if we synthesized the message, `content_blocks` is set.
              // If server sent it, we might not have local `content_blocks` in `assistantMsg` variable if we relied on server 'complete'.
              // But `messageId` is set.

              // Let's get the message from state to be sure.
              const currentMessages = getState().chat.conversation.messages
              const assistantMessage = currentMessages.find(m => m.id === messageId)

              if (assistantMessage) {
                const existingBlocks = parseContentBlocks(assistantMessage.content_blocks)
                const updatedContentBlocks = [...existingBlocks, ...toolResultBlocks]

                await persistAssistantMessageWithFallback(dispatch, {
                  id: assistantMessage.id,
                  content: assistantMessage.content,
                  updatedContentBlocks,
                  conversationId,
                  streamId,
                  contextLabel: 'sendMessageToBranch/cloud-client-tools',
                })

                const historyIndex = currentTurnHistory.findIndex(msg => msg.id === assistantMessage.id)
                if (historyIndex !== -1) {
                  currentTurnHistory[historyIndex] = {
                    ...currentTurnHistory[historyIndex],
                    content_blocks: updatedContentBlocks,
                  }
                }
              }
            }

            // 4. Prepare for next turn
            const hasSuccessfulTool = successfulDesktopTool || successfulBrowseWeb

            currentTurnContent = ''
            currentParentId = messageId // Parent is the assistant message
            continueTurn = hasSuccessfulTool
            assistantMessageContent = ''
            assistantThinking = ''
            assistantToolCalls = []
          } else {
            continueTurn = false
          }
        } else {
          continueTurn = false
        }

        if (!continueTurn) {
          const shouldContinueAfterStop = await shouldContinueFromStopHook({
            conversationId,
            streamId,
            cwd: effectiveToolRootPath,
            provider: serverProvider,
            model: modelName,
            operation: 'branch',
            pendingHookContextForNextTurn,
            lastAssistantMessage:
              currentTurnHistory[currentTurnHistory.length - 1] ??
              (messageId ? { id: messageId, content: assistantMessageContent } : null),
            state: getState(),
            queryClient: extra.queryClient,
          })

          if (shouldContinueAfterStop) {
            currentTurnContent = ''
            currentParentId = messageId ?? currentParentId
            continueTurn = true
            assistantMessageContent = ''
            assistantThinking = ''
            assistantToolCalls = []
          }
        }
      } // end while loop

      if (messageId) {
        dispatch(chatSliceActions.streamCompleted({ streamId, messageId, updatePath: true }))
      }

      dispatch(chatSliceActions.sendingCompleted({ streamId }))


      // Schedule stream cleanup after delay
      setTimeout(() => {
        dispatch(chatSliceActions.streamPruned({ streamId }))
      }, STREAM_PRUNE_DELAY)

      return { messageId, userMessage, streamId }
    } catch (error) {
      dispatch(chatSliceActions.sendingCompleted({ streamId }))

      if (error instanceof Error && error.name === 'AbortError') {
        return rejectWithValue('Message cancelled')
      }

      const message = error instanceof Error ? error.message : 'Failed to send message'
      dispatch(chatSliceActions.streamChunkReceived({ streamId, chunk: { type: 'error', error: message } }))
      return rejectWithValue(message)
    } finally {
      unregisterGenerationAbortController()
    }
  }
)

// Sync a conversation and its messages to local SQLite (Electron only)
export const syncConversationToLocal = createAsyncThunk<
  void,
  { conversationId: ConversationId; messages: Message[]; storageMode?: 'local' | 'cloud' },
  { state: RootState; extra: ThunkExtraArgument }
>('chat/syncConversationToLocal', async ({ conversationId, messages, storageMode }, { extra, getState }) => {
  // Only run in Electron mode
  if (import.meta.env.VITE_ENVIRONMENT !== 'electron') return
  const remoteApiBase = getRemoteApiBase()
  if (!remoteApiBase) return

  // Skip syncing for local-only conversations - they don't exist in cloud
  if (storageMode === 'local') {
    return
  }

  const { auth } = extra
  const state = getState() as RootState

  try {
    const exists = await dualSync.checkConversationExists(conversationId)
    // Determine project ID from state or conversation data
    let projectId: string | null = selectSelectedProject(state)?.id || null

    if (!exists) {
      // Fetch conversation from REMOTE source of truth (Cloud), not local API
      let conversation: Conversation | null = null
      try {
        const res = await fetch(`${remoteApiBase}/conversations/${conversationId}`, {
          headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            'Content-Type': 'application/json',
          },
        })
        if (res.ok) {
          conversation = await res.json()
        }
      } catch (e) {
        console.warn('Failed to fetch remote conversation for sync', e)
      }

      if (conversation) {
        projectId = conversation.project_id || projectId

        // Ensure project exists locally before syncing conversation
        if (projectId) {
          const projectExists = await dualSync.checkProjectExists(projectId)
          if (!projectExists) {
            // Try cache first
            const projectsCache = extra.queryClient?.getQueryData<any[]>(['projects', auth.userId])
            let project = projectsCache?.find(p => String(p.id) === String(projectId))

            // If not in cache, fetch from REMOTE API
            if (!project) {
              try {
                const projRes = await fetch(`${remoteApiBase}/projects/${projectId}`, {
                  headers: {
                    Authorization: `Bearer ${auth.accessToken}`,
                    'Content-Type': 'application/json',
                  },
                })
                if (projRes.ok) {
                  project = await projRes.json()
                }
              } catch (e) {
                console.warn(`Failed to fetch project ${projectId} for sync`, e)
              }
            }

            if (project) {
              dualSync.syncProject({
                id: project.id,
                name: project.name,
                user_id: auth.userId,
                context: project.context,
                system_prompt: project.system_prompt,
                created_at: project.created_at,
                updated_at: project.updated_at,
              })
            }
          }
        }

        dualSync.syncConversation(conversation)
      }
    }

    if (messages && messages.length > 0) {
      const operations = messages.map(msg => ({
        type: 'message',
        action: 'create',
        data: {
          ...msg,
          user_id: auth.userId,
          project_id: projectId, // Pass project_id context for potential stub creation
        },
      }))
      dualSync.syncBatch(operations)
    }
  } catch (error) {
    console.warn('Failed to sync conversation to local', error)
  }
})

// Fetch Heimdall message tree and messages combined (optimization: single endpoint)
export const fetchMessageTree = createAsyncThunk<
  any,
  ConversationId | { conversationId: ConversationId; storageMode?: 'local' | 'cloud' },
  { state: RootState; extra: ThunkExtraArgument }
>('chat/fetchMessageTree', async (payload, { dispatch, extra, rejectWithValue, getState }) => {
  const { auth } = extra

  // Handle both old (just conversationId) and new (object with storageMode) signatures
  const conversationId = typeof payload === 'object' ? payload.conversationId : payload
  const explicitStorageMode = typeof payload === 'object' ? payload.storageMode : undefined

  // Gating: avoid duplicate in-flight fetches and throttle rapid refetches
  const state = getState() as RootState
  const { heimdall } = state.chat
  const now = Date.now()
  if (heimdall.loading && heimdall.lastConversationId === conversationId) {
    // Skip: already fetching for this conversation
    return null as any
  }
  if (
    heimdall.lastConversationId === conversationId &&
    typeof heimdall.lastFetchedAt === 'number' &&
    now - heimdall.lastFetchedAt < 250
  ) {
    // Skip: fetched very recently for same conversation
    return null as any
  }

  dispatch(chatSliceActions.heimdallLoadingStarted())
  try {
    let response: { messages: Message[]; tree: any }

    // Use explicit storageMode if provided, otherwise check state
    const conversation = state.conversations.items.find(c => c.id === conversationId)
    const storageMode = explicitStorageMode || conversation?.storage_mode || 'cloud'

    // console.log(`[fetchMessageTree] ConversationId: ${conversationId}`)
    // console.log(`[fetchMessageTree] Found in state: ${!!conversation}`)
    // console.log(`[fetchMessageTree] Storage Mode: ${storageMode}`)
    // console.log(`[fetchMessageTree] Environment: ${environment}`)

    if (shouldUseLocalApi(storageMode, environment)) {
      // console.log('[fetchMessageTree] Routing to LOCAL API')
      response = await localApi.get<{ messages: Message[]; tree: any }>(
        `/app/conversations/${conversationId}/messages/tree`
      )
    } else {
      // console.log('[fetchMessageTree] Routing to CLOUD API')
      response = await apiCall<{ messages: Message[]; tree: any }>(
        `/conversations/${conversationId}/messages/tree`,
        auth.accessToken
      )
    }

    // Handle both old and new response formats for backward compatibility
    const treeData = response.tree || response
    const messages = response.messages

    // If messages are included, load them into state
    if (messages && Array.isArray(messages)) {
      // Ensure client-only fields exist
      const normalizedMessages: Message[] = messages.map(m => ({
        ...m,
        pastedContext: Array.isArray((m as any).pastedContext) ? (m as any).pastedContext : [],
        artifacts: Array.isArray((m as any).artifacts) ? (m as any).artifacts : [],
      }))

      dispatch(chatSliceActions.messagesLoaded(normalizedMessages))

      // Conditional attachments fetch: only when metadata indicates or when metadata absent
      const attachmentsByMessage = state.chat.attachments.byMessage || {}

      for (const msg of normalizedMessages) {
        const alreadyFetched = Array.isArray(attachmentsByMessage[msg.id]) && attachmentsByMessage[msg.id].length > 0

        // Check if attachments are included in the response (optimized path)
        const includedAttachments = (msg as any).attachments

        if (
          !alreadyFetched &&
          includedAttachments &&
          Array.isArray(includedAttachments) &&
          includedAttachments.length > 0
        ) {
          // Process included attachments - dispatch metadata immediately
          dispatch(
            chatSliceActions.attachmentsSetForMessage({
              messageId: msg.id,
              attachments: includedAttachments,
            })
          )

          // Fetch and convert binaries to base64 (async operation)
          Promise.all(
            includedAttachments.map(async (a: any) => {
              const url = resolveAttachmentUrl(a.url, a.storage_path || a.file_path, a.id)
              if (!url) return null
              try {
                const res = await fetch(url)
                if (!res.ok) return null
                const blob = await res.blob()
                return await blobToDataURL(blob)
              } catch {
                return null
              }
            })
          ).then(dataUrls => {
            const validUrls = dataUrls.filter((x): x is string => Boolean(x))
            if (validUrls.length > 0) {
              dispatch(chatSliceActions.messageArtifactsSet({ messageId: msg.id, artifacts: validUrls }))
            }
          })
        } else if (!alreadyFetched) {
          // Fallback: use old individual fetch logic if attachments not included
          const hasMeta = typeof msg.has_attachments !== 'undefined' || typeof msg.attachments_count !== 'undefined'
          const indicatesAttachments =
            msg.has_attachments === true || (typeof msg.attachments_count === 'number' && msg.attachments_count > 0)

          if ((hasMeta && indicatesAttachments) || !hasMeta) {
            dispatch(fetchAttachmentsByMessage({ messageId: msg.id }))
          }
        }
      }
    }

    // console.log('treeData', treeData)
    dispatch(chatSliceActions.heimdallDataLoaded({ treeData }))

    return response
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch message tree'
    dispatch(chatSliceActions.heimdallError(message))
    return rejectWithValue(message)
  }
})

// Consolidated conversation initialization - fetches all required data in sequence to avoid rate limiting
export const initializeConversationData = createAsyncThunk<
  { messages: Message[]; treeData: any; systemPrompt: string | null; context: string | null },
  ConversationId,
  { state: RootState; extra: ThunkExtraArgument }
>('chat/initializeConversationData', async (conversationId, { dispatch, extra, rejectWithValue, getState }) => {
  const { auth } = extra

  try {
    // Check if we already have this conversation's data loaded recently
    const state = getState() as RootState
    const { heimdall, conversation } = state.chat
    const now = Date.now()

    // Skip if we just loaded this conversation (within 500ms)
    if (
      conversation.currentConversationId === conversationId &&
      typeof heimdall.lastFetchedAt === 'number' &&
      now - heimdall.lastFetchedAt < 500
    ) {
      return {
        messages: conversation.messages,
        treeData: heimdall.treeData,
        systemPrompt: state.conversations.systemPrompt,
        context: state.conversations.convContext,
      }
    }

    // Fetch all data sequentially to avoid rate limiting
    dispatch(chatSliceActions.heimdallLoadingStarted())

    // 1. Fetch tree data (now includes messages - optimized single call)
    const treeResponse = await dispatch(fetchMessageTree(conversationId)).unwrap()
    const messages = treeResponse.messages || []
    const treeData = treeResponse.tree || treeResponse

    // 2. Fetch system prompt and context in parallel (these are lightweight)
    const [systemPromptRes, contextRes] = await Promise.all([
      apiCall<{ systemPrompt: string | null }>(`/conversations/${conversationId}/system-prompt`, auth.accessToken),
      apiCall<{ context: string | null }>(`/conversations/${conversationId}/context`, auth.accessToken),
    ])

    const systemPrompt = systemPromptRes?.systemPrompt ?? null
    const context = contextRes?.context ?? null

    // Update state
    dispatch(systemPromptSet(systemPrompt))
    dispatch(convContextSet(context))

    return { messages, treeData, systemPrompt, context }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to initialize conversation data'
    dispatch(chatSliceActions.heimdallError(message))
    return rejectWithValue(message)
  }
})

// Refresh currentPath after a cascade delete (server deletes a message and its subtree)
export const refreshCurrentPathAfterDelete = createAsyncThunk<
  { children: MessageId[]; newPath: MessageId[] },
  { conversationId: ConversationId; messageId: MessageId },
  { state: RootState; extra: ThunkExtraArgument }
>(
  'chat/refreshCurrentPathAfterDelete',
  async ({ conversationId, messageId }, { getState, dispatch, extra, rejectWithValue }) => {
    const { auth } = extra
    try {
      // Fetch direct children of the deleted message from the server
      const children = await apiCall<MessageId[]>(
        `/conversations/${conversationId}/messages/${messageId}/children`,
        auth.accessToken
      )

      const state = getState() as RootState
      const currentPath = state.chat.conversation.currentPath || []

      let newPath = currentPath

      // If the deleted message itself is on the path, truncate before it
      const idxDeleted = currentPath.indexOf(messageId)
      if (idxDeleted !== -1) {
        newPath = currentPath.slice(0, idxDeleted)
      } else if (children && children.length > 0) {
        // Otherwise, if any of its direct children are on the path, truncate before the first occurrence
        const childSet = new Set(children)
        const firstChildIdx = currentPath.findIndex(id => childSet.has(id))
        if (firstChildIdx !== -1) {
          newPath = currentPath.slice(0, firstChildIdx)
        }
      }

      // Only dispatch if the path actually changes
      if (newPath !== currentPath) {
        dispatch(chatSliceActions.conversationPathSet(newPath))
      }

      return { children, newPath }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to refresh path after delete'
      return rejectWithValue(message)
    }
  }
)

// Initialize user and conversation
export const initializeUserAndConversation = createAsyncThunk<
  { userId: string | number; conversationId: ConversationId },
  void,
  { extra: ThunkExtraArgument }
>('chat/initializeUserAndConversation', async (_arg, { dispatch, extra, rejectWithValue }) => {
  const { auth } = extra
  dispatch(chatSliceActions.initializationStarted())
  try {
    if (isCommunityMode && import.meta.env.VITE_ENVIRONMENT === 'electron') {
      if (!auth.userId) {
        throw new Error('User not authenticated')
      }

      const conversation = await localApi.post<{ id: ConversationId }>('/app/conversations', {
        user_id: auth.userId,
        title: 'New Conversation',
        storage_mode: 'local',
      })

      dispatch(chatSliceActions.initializationCompleted({ userId: String(auth.userId), conversationId: conversation.id }))
      return { userId: auth.userId, conversationId: conversation.id }
    }

    // Create test user
    const user = await apiCall<{ id: number }>('/users', auth.accessToken, {
      method: 'POST',
      body: JSON.stringify({ username: 'test-user' }),
    })

    // Create new conversation
    const conversation = await apiCall<{ id: ConversationId }>(`/conversations`, auth.accessToken, {
      method: 'POST',
      body: JSON.stringify({ userId: user.id }),
    })

    dispatch(chatSliceActions.initializationCompleted({ userId: String(user.id), conversationId: conversation.id }))
    return { userId: user.id, conversationId: conversation.id }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to initialize'
    dispatch(chatSliceActions.initializationError(message))
    return rejectWithValue(message)
  }
})

// Delete multiple messages by their IDs
export const deleteSelectedNodes = createAsyncThunk<
  { deleted: number },
  { ids: MessageId[]; conversationId: ConversationId; storageMode?: 'local' | 'cloud' },
  { extra: ThunkExtraArgument }
>('chat/deleteSelectedNodes', async ({ ids, conversationId, storageMode }, { extra, rejectWithValue }) => {
  const { auth } = extra
  try {
    // Use storageMode passed from caller (most reliable) or fallback to cache lookup
    const effectiveStorageMode = storageMode ?? getStorageModeFromCache(extra.queryClient, conversationId)
    const isLocalMode = shouldUseLocalApi(effectiveStorageMode)

    // console.log('[deleteSelectedNodes] Routing decision:', {
    //   passedStorageMode: storageMode,
    //   effectiveStorageMode,
    //   isLocalMode,
    //   environment,
    //   conversationId,
    //   messageCount: ids.length,
    // })

    let response: { deleted: number }
    if (isLocalMode) {
      // console.log('[deleteSelectedNodes] -> Routing to LOCAL API: /app/messages/deleteMany')
      response = await localApi.post<{ deleted: number }>('/app/messages/deleteMany', { ids })
    } else {
      // console.log('[deleteSelectedNodes] -> Routing to CLOUD API: /messages/deleteMany')
      response = await apiCall<{ deleted: number }>('/messages/deleteMany', auth.accessToken, {
        method: 'POST',
        body: JSON.stringify({ ids }),
      })
    }
    // Sync React Query cache immediately
    removeMessagesFromCache(extra.queryClient, conversationId, ids)
    return response
  } catch (error) {
    console.error('[deleteSelectedNodes] Error:', error)
    const message = error instanceof Error ? error.message : 'Failed to delete messages'
    return rejectWithValue(message)
  }
})

// Update a conversation title (Chat feature convenience)
export const updateConversationTitle = createAsyncThunk<
  Conversation,
  { id: ConversationId; title: string; storageMode?: 'cloud' | 'local' },
  { extra: ThunkExtraArgument; state: RootState }
>('chat/updateConversationTitle', async ({ id, title, storageMode }, { extra, getState, rejectWithValue }) => {
  const { auth } = extra
  try {
    // Infer storage mode from state if not provided
    let effectiveMode = storageMode
    if (!effectiveMode) {
      const conversation = getState().conversations.items.find(c => c.id === id)
      effectiveMode = conversation?.storage_mode || 'cloud'
    }

    // Route to appropriate API based on storage mode
    if (shouldUseLocalApi(effectiveMode, environment)) {
      const updated = await localApi.patch<Conversation>(`/app/conversations/${id}`, { title })
      syncConversationTitleAcrossCaches(extra.queryClient, updated)
      return updated
    }

    // Default to cloud API
    const updated = await apiCall<Conversation>(`/conversations/${id}/`, auth.accessToken, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    })
    syncConversationTitleAcrossCaches(extra.queryClient, updated)
    return updated
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update conversation'
    return rejectWithValue(message)
  }
})

/* Attachments: upload, link, fetch, delete */

// Upload an image file as multipart/form-data to /api/attachments
export const uploadAttachment = createAsyncThunk<
  Attachment,
  { file: File; messageId?: number | null },
  { extra: ThunkExtraArgument }
>('chat/uploadAttachment', async ({ file, messageId }, { dispatch, extra, rejectWithValue }) => {
  const { auth } = extra
  try {
    const form = new FormData()
    form.append('file', file)
    if (messageId != null) form.append('messageId', String(messageId))

    const attachment = await apiCall<Attachment>('/attachments', auth.accessToken, {
      method: 'POST',
      body: form,
    })

    if (attachment.message_id != null) {
      dispatch(
        chatSliceActions.attachmentUpsertedForMessage({
          messageId: attachment.message_id,
          attachment,
        })
      )
    }

    return attachment
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to upload attachment'
    return rejectWithValue(message)
  }
})

// Link existing attachments to a message
export const linkAttachmentsToMessage = createAsyncThunk<
  Attachment[],
  { messageId: MessageId; attachmentIds: string[] },
  { extra: ThunkExtraArgument }
>('chat/linkAttachmentsToMessage', async ({ messageId, attachmentIds }, { dispatch, extra, rejectWithValue }) => {
  const { auth } = extra
  try {
    const attachments = await apiCall<Attachment[]>(`/messages/${messageId}/attachments`, auth.accessToken, {
      method: 'POST',
      body: JSON.stringify({ attachmentIds }),
    })

    dispatch(chatSliceActions.attachmentsSetForMessage({ messageId, attachments }))
    return attachments
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to link attachments'
    return rejectWithValue(message)
  }
})

// Fetch attachments for a message
export const fetchAttachmentsByMessage = createAsyncThunk<
  Attachment[],
  { messageId: MessageId },
  { extra: ThunkExtraArgument }
>('chat/fetchAttachmentsByMessage', async ({ messageId }, { dispatch, extra, rejectWithValue }) => {
  const { auth } = extra
  try {
    const attachments = await apiCall<Attachment[]>(`/messages/${messageId}/attachments`, auth.accessToken)
    dispatch(chatSliceActions.attachmentsSetForMessage({ messageId, attachments }))
    // Fetch binaries and convert to base64 data URLs
    const dataUrls: string[] = (
      await Promise.all(
        (attachments || []).map(async a => {
          const url = resolveAttachmentUrl(a.url, a.file_path, a.id)
          if (!url) return null
          try {
            const res = await fetch(url)
            if (!res.ok) return null
            const blob = await res.blob()
            const dataUrl = await blobToDataURL(blob)
            return dataUrl
          } catch {
            return null
          }
        })
      )
    ).filter((x): x is string => Boolean(x))

    dispatch(chatSliceActions.messageArtifactsSet({ messageId, artifacts: dataUrls }))
    return attachments
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch attachments'
    return rejectWithValue(message)
  }
})

// Delete all attachments for a message
export const deleteAttachmentsByMessage = createAsyncThunk<
  { deleted: number },
  { messageId: MessageId },
  { extra: ThunkExtraArgument }
>('chat/deleteAttachmentsByMessage', async ({ messageId }, { dispatch, extra, rejectWithValue }) => {
  const { auth } = extra
  try {
    const result = await apiCall<{ deleted: number }>(`/messages/${messageId}/attachments`, auth.accessToken, {
      method: 'DELETE',
    })
    dispatch(chatSliceActions.attachmentsClearedForMessage(messageId))
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete attachments'
    return rejectWithValue(message)
  }
})

// Fetch a single attachment by ID
export const fetchAttachmentById = createAsyncThunk<Attachment, { id: MessageId }, { extra: ThunkExtraArgument }>(
  'chat/fetchAttachmentById',
  async ({ id }, { dispatch, extra, rejectWithValue }) => {
    const { auth } = extra
    try {
      const attachment = await apiCall<Attachment>(`/attachments/${id}`, auth.accessToken)
      if (attachment.message_id != null) {
        dispatch(
          chatSliceActions.attachmentUpsertedForMessage({
            messageId: attachment.message_id,
            attachment,
          })
        )
      }
      return attachment
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch attachment'
      return rejectWithValue(message)
    }
  }
)

// Abort a running generation
export const abortStreaming = createAsyncThunk<
  { success: boolean; messageDeleted?: boolean },
  { messageId: MessageId; streamId?: string | null },
  { state: RootState; extra: ThunkExtraArgument }
>(
  'chat/abortStreaming',
  async ({ messageId, streamId: providedStreamId }, { dispatch, getState, extra, rejectWithValue }) => {
    const { auth } = extra
    const state = getState()
    const streamId =
      providedStreamId ??
      Object.entries(state.chat.streaming.byId).find(([, stream]) => stream.streamingMessageId === messageId)?.[0] ??
      null
    try {
      const response = await apiCall<{ success: boolean; messageDeleted?: boolean }>(
        `/messages/${messageId}/abort`,
        auth.accessToken,
        {
          method: 'POST',
        }
      )

      if (response.success) {
        dispatch(chatSliceActions.streamingAborted(streamId ? { streamId } : undefined))

        // If the assistant message was deleted, refetch messages to update the UI
        if (response.messageDeleted) {
          const conversationId = state.chat.conversation.currentConversationId
          if (conversationId) {
            // Stabilize the currentPath first by truncating past the deleted leaf
            // Pass the user messageId (the generation root); the thunk will truncate before any direct child on path
            // dispatch(
            //   refreshCurrentPathAfterDelete({ conversationId, messageId })
            // )
            dispatch(fetchConversationMessages(conversationId))
          }
        }
      }

      return response
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to abort generation'
      return rejectWithValue(message)
    }
  }
)

// Abort local generation (including subagent runs) and optionally stop server streaming
export const abortGeneration = createAsyncThunk<
  void,
  { streamId?: string | null; messageId?: MessageId | null },
  { state: RootState }
>('chat/abortGeneration', async ({ streamId, messageId }, { dispatch }) => {
  abortSubagentControllers(streamId)

  if (messageId) {
    try {
      const response = await dispatch(abortStreaming({ messageId, streamId })).unwrap()
      if (response?.success) {
        // Keep the stream reader alive so the server can still emit the final
        // aborted completion payload (partial content + tool calls).
        return
      }
    } catch {
      // Fall through to hard local abort when server abort is unavailable/failed.
    }
  }

  abortGenerationControllers(streamId)

  if (streamId) {
    dispatch(chatSliceActions.streamingAborted({ streamId }))
  } else {
    dispatch(chatSliceActions.allStreamsAborted())
  }
})

// Fetch available tools - now returns local tool definitions
// Tools are defined locally in toolDefinitions.ts, not fetched from server
export const fetchTools = createAsyncThunk<ToolDefinition[], void, { state: RootState }>(
  'chat/fetchTools',
  async (_, { getState }) => {
    // Return tools from local state (already initialized from toolDefinitions.ts)
    const state = getState()
    return state.chat.tools
  }
)

// Update tool enabled status - updates local state and persists to localStorage
export const updateToolEnabled = createAsyncThunk<
  { success: boolean; toolName: string; enabled: boolean },
  { toolName: string; enabled: boolean },
  { state: RootState }
>('chat/updateToolEnabled', async ({ toolName, enabled }, { dispatch }) => {
  // Update toolDefinitions module (source of truth for merged tools)
  updateToolEnabledInDefinitions(toolName, enabled)
  // Persist to localStorage so state survives app restarts
  updateToolEnabledState(toolName, enabled)
  // Update Redux state for UI reactivity
  dispatch(chatSliceActions.toolEnabledUpdated({ toolName, enabled }))

  // Return the updated status
  return { success: true, toolName, enabled }
})

// Fetch and merge custom tools from local server (Electron only)
// This fetches user-defined tools from userData/custom-tools/ directory
export const fetchCustomTools = createAsyncThunk<void, void, { state: RootState }>(
  'chat/fetchCustomTools',
  async (_, { dispatch }) => {
    // Check if we're in Electron mode
    const isElectronMode =
      import.meta.env.VITE_ENVIRONMENT === 'electron' ||
      (typeof __IS_ELECTRON__ !== 'undefined' && __IS_ELECTRON__) ||
      (typeof window !== 'undefined' && (window as any).electronAPI)

    if (!isElectronMode) {
      // Custom tools only available in Electron mode
      return
    }

    try {
      const response = await fetch(await buildLocalApiUrl('/custom-tools'))
      if (!response.ok) {
        console.warn('[CustomTools] Failed to fetch custom tools:', response.statusText)
        return
      }

      const data = await response.json()
      if (data.success && Array.isArray(data.tools)) {
        // Merge custom tools with built-in tools
        setCustomTools(data.tools)

        // Update Redux state with merged tools
        dispatch(chatSliceActions.setTools(getAllTools()))
      }
    } catch (error) {
      // Silently fail - custom tools are optional
      console.warn('[CustomTools] Failed to load custom tools:', error)
    }
  }
)

// Reload custom tools from disk (useful after user adds new tools)
export const reloadCustomTools = createAsyncThunk<{ success: boolean; count: number }, void, { state: RootState }>(
  'chat/reloadCustomTools',
  async (_, { dispatch }) => {
    try {
      // Tell the server to reload tools from disk
      const reloadResponse = await fetch(await buildLocalApiUrl('/custom-tools/reload'), {
        method: 'POST',
      })

      if (!reloadResponse.ok) {
        throw new Error('Failed to reload custom tools')
      }

      const reloadData = await reloadResponse.json()

      if (reloadData.success && Array.isArray(reloadData.tools)) {
        // Merge reloaded custom tools with built-in tools
        setCustomTools(reloadData.tools)

        // Update Redux state with merged tools
        dispatch(chatSliceActions.setTools(getAllTools()))

        return { success: true, count: reloadData.tools.length }
      }

      return { success: false, count: 0 }
    } catch (error) {
      console.error('[CustomTools] Failed to reload custom tools:', error)
      return { success: false, count: 0 }
    }
  }
)

// Fetch and merge MCP tools from connected MCP servers (Electron only)
let mcpToolsRetryCount = 0
const MAX_MCP_TOOLS_RETRIES = 2
const MCP_TOOLS_RETRY_DELAY_MS = 2000

export const fetchMcpTools = createAsyncThunk<void, void, { state: RootState }>(
  'chat/fetchMcpTools',
  async (_, { dispatch }) => {
    // Check if we're in Electron mode
    const isElectronMode =
      import.meta.env.VITE_ENVIRONMENT === 'electron' ||
      (typeof __IS_ELECTRON__ !== 'undefined' && __IS_ELECTRON__) ||
      (typeof window !== 'undefined' && (window as any).electronAPI)

    if (!isElectronMode) {
      // MCP tools only available in Electron mode
      return
    }

    try {
      try {
        await fetch(await buildLocalApiUrl('/mcp/refresh-tools'), { method: 'POST' })
      } catch {
        // Ignore refresh errors; we'll still try to read tools
      }

      const response = await fetch(await buildLocalApiUrl('/mcp/tools'))
      if (!response.ok) {
        console.warn('[McpTools] Failed to fetch MCP tools:', response.statusText)
        return
      }

      const data = await response.json()
      if (data.success && Array.isArray(data.tools)) {
        // Transform MCP tools to ToolDefinition format
        const mcpToolDefinitions = data.tools.map((tool: any) => {
          const metaUi =
            tool?._meta?.ui ||
            (tool?._meta?.['ui/resourceUri'] ? { resourceUri: tool._meta['ui/resourceUri'] } : undefined)
          const visibility = Array.isArray(metaUi?.visibility) ? metaUi.visibility : ['model', 'app']
          const enabled = visibility.includes('model')
          return {
            name: tool.qualifiedName || tool.name,
            description: tool.description || `MCP tool from ${tool.serverName}`,
            enabled,
            inputSchema: tool.inputSchema || { type: 'object', properties: {} },
            isMcp: true,
            mcpServerName: tool.serverName,
            mcpToolName: tool.name,
            mcpUi: metaUi
              ? {
                  resourceUri: metaUi.resourceUri,
                  visibility,
                }
              : undefined,
          }
        })

        // Merge MCP tools with existing tools
        setMcpTools(mcpToolDefinitions)

        // Update Redux state with merged tools
        dispatch(chatSliceActions.setTools(getAllTools()))

        console.log(`[McpTools] Loaded ${mcpToolDefinitions.length} MCP tools`)

        if (mcpToolDefinitions.length > 0) {
          mcpToolsRetryCount = 0
        } else if (mcpToolsRetryCount < MAX_MCP_TOOLS_RETRIES) {
          mcpToolsRetryCount += 1
          setTimeout(() => {
            dispatch(fetchMcpTools())
          }, MCP_TOOLS_RETRY_DELAY_MS)
        }
      }
    } catch (error) {
      // Silently fail - MCP tools are optional
      console.warn('[McpTools] Failed to load MCP tools:', error)
    }
  }
)

// Bulk insert messages (for copying message chains to new conversation)
export const insertBulkMessages = createAsyncThunk<
  Message[],
  {
    conversationId: ConversationId
    messages: Array<{
      role: 'user' | 'assistant'
      content: string
      thinking_block?: string
      model_name?: string
      tool_calls?: string
      note?: string
      note_color?: string | null
      content_blocks?: any
    }>
    storageMode?: 'local' | 'cloud' // Optional: explicitly set storage mode (useful for newly created conversations)
  },
  { extra: ThunkExtraArgument }
>('chat/insertBulkMessages', async ({ conversationId, messages, storageMode }, { extra, rejectWithValue }) => {
  const { auth } = extra
  try {
    // Use provided storageMode if available, otherwise try cache lookup
    const effectiveStorageMode = storageMode || getStorageModeFromCache(extra.queryClient, conversationId)
    if (shouldUseLocalApi(effectiveStorageMode, environment)) {
      const response = await localApi.post<{ messages: Message[] }>(
        `/app/conversations/${conversationId}/messages/bulk`,
        { messages }
      )
      return response.messages
    }

    const response = await apiCall<{ messages: Message[] }>(
      `/conversations/${conversationId}/messages/bulk`,
      auth.accessToken,
      {
        method: 'POST',
        body: JSON.stringify({ messages }),
      }
    )
    return response.messages
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to insert bulk messages'
    return rejectWithValue(message)
  }
})

// ============================================================================
// CLAUDE CODE AGENT ENDPOINTS
// ============================================================================

/**
 * Fetch Claude Code session info for a conversation
 * Returns session metadata without starting/resuming a session
 * Always uses local server - CC is local-only
 */
export const getCCSessionInfo = createAsyncThunk<
  { hasSession: boolean; sessionId?: string; lastMessageAt?: string; messageCount?: number; cwd?: string },
  ConversationId,
  { state: RootState; extra: ThunkExtraArgument }
>('chat/getCCSessionInfo', async (conversationId, { rejectWithValue }) => {
  try {
    // CC always routes to local server
    const response = await localApi.get<{
      hasSession: boolean
      sessionId?: string
      lastMessageAt?: string
      messageCount?: number
      cwd?: string
    }>(`/agents/cc-session/${conversationId}`)

    return response
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get CC session info'
    return rejectWithValue(message)
  }
})

/**
 * Fetch available slash commands for Claude Code session
 * Commands are discovered from SDK init message and include built-in + custom commands
 * Always uses local server - CC is local-only
 */
export const fetchCCSlashCommands = createAsyncThunk<
  string[],
  { conversationId: ConversationId; cwd?: string },
  { state: RootState; extra: ThunkExtraArgument }
>('chat/fetchCCSlashCommands', async ({ conversationId, cwd }, { dispatch, rejectWithValue }) => {
  try {
    const queryParams = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    const response = await localApi.get<{ commands: string[] }>(`/agents/cc-commands/${conversationId}${queryParams}`)

    const commands = response.commands || []
    dispatch(chatSliceActions.ccSlashCommandsLoaded(commands))
    return commands
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch CC slash commands'
    return rejectWithValue(message)
  }
})

/**
 * Send message to the Hermes ACP backend with SSE streaming.
 * Always uses the local server - Hermes runtime is local-only in Electron mode.
 */
export const sendHermesMessage = createAsyncThunk<
  { sessionId: string; messageCount: number; userMessageId?: MessageId; streamId: string },
  SendHermesMessagePayload & { streamId?: string },
  { state: RootState; extra: ThunkExtraArgument }
>(
  'chat/sendHermesMessage',
  async (
    {
      conversationId,
      message,
      cwd,
      resume,
      parentId,
      sessionId: resumeSessionId,
      forkSession,
      model,
      maxIterations,
      streamId: providedStreamId,
    },
    { dispatch, extra, rejectWithValue, signal, getState }
  ) => {
    const streamId = providedStreamId ?? generateStreamId('primary')
    const streamType = inferStreamTypeFromId(streamId)

    dispatch(
      chatSliceActions.sendingStarted({
        streamId,
        streamType,
        conversationId,
        lineage:
          streamType === 'branch' && parentId !== undefined && parentId !== null
            ? {
                rootMessageId: parentId,
              }
            : undefined,
      })
    )

    let controller: AbortController | undefined
    let unregisterGenerationAbortController = () => {}

    try {
      controller = new AbortController()
      signal.addEventListener('abort', () => controller?.abort())
      unregisterGenerationAbortController = registerGenerationAbortController(streamId, controller)

      const requestBody: any = { message }
      if (cwd) requestBody.cwd = cwd
      if (resume !== undefined) requestBody.resume = resume
      if (parentId !== undefined) requestBody.parentId = parentId
      if (resumeSessionId) requestBody.sessionId = resumeSessionId
      if (forkSession !== undefined) requestBody.forkSession = forkSession
      if (model) requestBody.model = model
      if (typeof maxIterations === 'number') requestBody.maxIterations = maxIterations

      const response = await fetch(await buildLocalApiUrl(`/agents/hermes-messages/${conversationId}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText || 'Failed to send Hermes message'}`)
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error('No stream reader available')

      const decoder = new TextDecoder()
      let sessionId: string | null = null
      let messageCount = 0
      let userMessageId: MessageId | undefined
      let buffer = ''
      let shouldInvalidateMessages = false
      let completedMessageIdForStream: MessageId | null = null
      let sawHermesIncrementalTextDelta = false
      const currentPath = getState().chat.conversation.currentPath
      const inferredParentId =
        parentId !== undefined
          ? parentId
          : currentPath.length > 0
            ? currentPath[currentPath.length - 1]
            : null

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue

            try {
              const chunk = JSON.parse(line.slice(6))

              if (chunk.type === 'permission_request') {
                const permissionRequestId =
                  typeof chunk.requestId === 'string' && chunk.requestId.length > 0 ? chunk.requestId : null

                if (!permissionRequestId) {
                  throw new Error('Hermes permission request missing requestId')
                }

                const rawToolCall = chunk.toolCall && typeof chunk.toolCall === 'object' ? chunk.toolCall : {}
                const permissionToolCall = {
                  id:
                    typeof rawToolCall.id === 'string' && rawToolCall.id.length > 0
                      ? rawToolCall.id
                      : `hermes-permission-${permissionRequestId}`,
                  name:
                    typeof rawToolCall.name === 'string' && rawToolCall.name.length > 0
                      ? rawToolCall.name
                      : 'hermes_permission',
                  arguments:
                    rawToolCall.arguments && typeof rawToolCall.arguments === 'object'
                      ? rawToolCall.arguments
                      : {},
                  status: 'pending' as const,
                }

                const permissionDecision = await requestToolPermissionDecision(
                  dispatch,
                  () => getState() as RootState,
                  permissionToolCall
                )

                await localApi.post(`/agents/hermes-permission-response/${permissionRequestId}`, {
                  decision: permissionDecision,
                })
              } else if (chunk.messageType === 'tool_start' && chunk.event) {
                const event = chunk.event
                const toolCallId =
                  typeof event.tool_call_id === 'string' && event.tool_call_id.length > 0
                    ? event.tool_call_id
                    : uuidv4()
                const toolName =
                  typeof event.name === 'string' && event.name.length > 0 ? event.name : 'tool'
                const toolArgs =
                  event.arguments && typeof event.arguments === 'object'
                    ? event.arguments
                    : {}

                dispatch(
                  chatSliceActions.streamChunkReceived({
                    streamId,
                    chunk: {
                      type: 'chunk',
                      part: 'tool_call',
                      chunkType: 'tool_start',
                      toolCall: {
                        id: toolCallId,
                        name: toolName,
                        arguments: JSON.stringify(toolArgs),
                      },
                    },
                  })
                )
              } else if (chunk.messageType === 'tool_result' && chunk.event) {
                const event = chunk.event
                const toolResult = {
                  tool_use_id:
                    typeof event.tool_call_id === 'string' && event.tool_call_id.length > 0
                      ? event.tool_call_id
                      : uuidv4(),
                  tool_name:
                    typeof event.name === 'string' && event.name.length > 0 ? event.name : 'tool',
                  content:
                    typeof event.content === 'string'
                      ? event.content
                      : JSON.stringify(event.content ?? event.result ?? ''),
                  is_error: event.ok === false,
                }

                dispatch(
                  chatSliceActions.streamChunkReceived({
                    streamId,
                    chunk: {
                      type: 'chunk',
                      part: 'tool_result',
                      chunkType: 'tool_end',
                      toolResult,
                    },
                  })
                )
              } else if (chunk.type === 'user_message' && chunk.message) {
                const normalizedUserMessage: Message = {
                  id: String(chunk.message.id) as MessageId,
                  conversation_id: conversationId,
                  role: 'user',
                  content:
                    typeof chunk.message.content === 'string' && chunk.message.content.length > 0
                      ? chunk.message.content
                      : message,
                  content_plain_text:
                    typeof chunk.message.content_plain_text === 'string' && chunk.message.content_plain_text.length > 0
                      ? chunk.message.content_plain_text
                      : typeof chunk.message.content === 'string' && chunk.message.content.length > 0
                        ? chunk.message.content
                        : message,
                  parent_id: chunk.message.parent_id ?? inferredParentId ?? null,
                  children_ids: Array.isArray(chunk.message.children_ids) ? chunk.message.children_ids : [],
                  created_at:
                    typeof chunk.message.created_at === 'string' && chunk.message.created_at.length > 0
                      ? chunk.message.created_at
                      : new Date().toISOString(),
                  model_name:
                    typeof chunk.message.model_name === 'string' && chunk.message.model_name.length > 0
                      ? chunk.message.model_name
                      : 'user-input',
                  partial: typeof chunk.message.partial === 'boolean' ? chunk.message.partial : false,
                  pastedContext: Array.isArray(chunk.message.pastedContext) ? chunk.message.pastedContext : [],
                  artifacts: Array.isArray(chunk.message.artifacts) ? chunk.message.artifacts : [],
                }

                userMessageId = normalizedUserMessage.id

                const existsInStore = getState().chat.conversation.messages.some(
                  m => String(m.id) === String(normalizedUserMessage.id)
                )

                if (!existsInStore) {
                  dispatch(chatSliceActions.messageAdded(normalizedUserMessage))
                  dispatch(chatSliceActions.messageBranchCreated({ newMessage: normalizedUserMessage }))
                  updateMessageCache(extra.queryClient, conversationId, normalizedUserMessage)
                }

                dispatch(
                  chatSliceActions.streamLineageUpdated({
                    streamId,
                    targetParentId: normalizedUserMessage.id,
                  })
                )

                await maybePersistAutoConversationTitle({
                  dispatch,
                  conversationId,
                  parentId: normalizedUserMessage.parent_id,
                  content: normalizedUserMessage.content_plain_text || normalizedUserMessage.content || message,
                  contextLabel: 'sendHermesMessage',
                })
              } else if (chunk.type === 'chunk') {
                const normalizedPart = chunk.part || 'text'
                const normalizedDelta = chunk.delta || chunk.content || ''
                const normalizedChunkType = chunk.chunkType

                // Hermes ACP can emit a full assistant_message/final text event after
                // native assistant_delta streaming. If we've already seen incremental text,
                // skip the synthetic full-text replay to avoid duplicate output in UI.
                if (
                  normalizedPart === 'text' &&
                  typeof normalizedDelta === 'string' &&
                  normalizedDelta.length > 0
                ) {
                  if (normalizedChunkType === 'content_delta') {
                    sawHermesIncrementalTextDelta = true
                  }

                  const isSyntheticReplay =
                    sawHermesIncrementalTextDelta &&
                    (normalizedChunkType === 'assistant_message' || normalizedChunkType === 'final')

                  if (isSyntheticReplay) {
                    continue
                  }
                }

                dispatch(
                  chatSliceActions.streamChunkReceived({
                    streamId,
                    chunk: {
                      type: 'chunk',
                      delta: normalizedDelta,
                      part: normalizedPart,
                      chunkType: normalizedChunkType,
                    },
                  })
                )
              } else if (chunk.type === 'complete') {
                sessionId = chunk.sessionId || sessionId
                messageCount = chunk.messageCount || messageCount

                const completedMessageId =
                  typeof chunk.messageId === 'string' && chunk.messageId.length > 0
                    ? (chunk.messageId as MessageId)
                    : null

                if (completedMessageId) {
                  let completedMessage = getState().chat.conversation.messages.find(
                    msg => String(msg.id) === String(completedMessageId)
                  )

                  if (!completedMessage) {
                    try {
                      const latest = await localApi.get<{ messages: Message[]; tree: any }>(
                        `/app/conversations/${conversationId}/messages/tree`
                      )
                      completedMessage = latest.messages?.find(msg => String(msg.id) === String(completedMessageId))
                    } catch (fetchError) {
                      console.warn('[sendHermesMessage] Failed to fetch completed Hermes message:', fetchError)
                    }
                  }

                  if (completedMessage) {
                    const normalizedCompletedMessage: Message = {
                      ...completedMessage,
                      pastedContext: Array.isArray(completedMessage.pastedContext) ? completedMessage.pastedContext : [],
                      artifacts: Array.isArray(completedMessage.artifacts) ? completedMessage.artifacts : [],
                    }

                    const completedExistsInStore = getState().chat.conversation.messages.some(
                      msg => String(msg.id) === String(normalizedCompletedMessage.id)
                    )

                    dispatch(chatSliceActions.messageAdded(normalizedCompletedMessage))
                    dispatch(chatSliceActions.messageBranchCreated({ newMessage: normalizedCompletedMessage }))

                    if (!completedExistsInStore) {
                      updateMessageCache(extra.queryClient, conversationId, normalizedCompletedMessage)
                    }
                  }

                  completedMessageIdForStream = completedMessageId
                }

                shouldInvalidateMessages = true
              } else if (chunk.type === 'error') {
                dispatch(
                  chatSliceActions.streamChunkReceived({
                    streamId,
                    chunk: {
                      type: 'error',
                      error: chunk.error || 'Hermes ACP error',
                    },
                  })
                )
                throw new Error(chunk.error || 'Hermes stream error')
              }
            } catch (parseError) {
              if (line.length > 100) {
                console.warn('Failed to parse Hermes chunk:', line.substring(0, 100) + '...', parseError)
              }
            }
          }
        }
      } finally {
        reader.releaseLock()
      }

      if (completedMessageIdForStream) {
        dispatch(
          chatSliceActions.streamCompleted({
            streamId,
            messageId: completedMessageIdForStream,
            updatePath: true,
          })
        )
      }

      if (shouldInvalidateMessages) {
        await extra.queryClient.invalidateQueries({ queryKey: ['conversations', conversationId, 'messages'] })
      }

      if (!sessionId) {
        throw new Error('No session ID received from Hermes ACP')
      }

      dispatch(chatSliceActions.sendingCompleted({ streamId }))


      setTimeout(() => {
        dispatch(chatSliceActions.streamPruned({ streamId }))
      }, STREAM_PRUNE_DELAY)

      return { sessionId, messageCount, userMessageId, streamId }
    } catch (error) {
      dispatch(chatSliceActions.sendingCompleted({ streamId }))

      if (error instanceof Error && error.name === 'AbortError') {
        return rejectWithValue('Hermes message cancelled')
      }

      const message = error instanceof Error ? error.message : 'Failed to send Hermes message'
      dispatch(chatSliceActions.streamChunkReceived({ streamId, chunk: { type: 'error', error: message } }))
      return rejectWithValue(message)
    } finally {
      unregisterGenerationAbortController()
    }
  }
)

/**
 * Send message to Claude Code agent with SSE streaming
 *
 * Similar to sendMessage but uses CC agent endpoints.
 * Automatically saves messages with ex_agent role.
 * Tracks CC session ID in message metadata.
 * Always uses local server - CC is local-only.
 */
export const sendCCMessage = createAsyncThunk<
  { sessionId: string; messageCount: number; userMessageId?: MessageId; streamId: string },
  SendCCMessagePayload & { streamId?: string },
  { state: RootState; extra: ThunkExtraArgument }
>(
  'chat/sendCCMessage',
  async (
    {
      conversationId,
      message,
      cwd,
      permissionMode = 'default',
      resume,
      sessionId: resumeSessionId,
      forkSession,
      streamId: providedStreamId,
    },
    { dispatch, extra, rejectWithValue, signal, getState }
  ) => {
    // Generate or use provided stream ID
    const streamId = providedStreamId ?? generateStreamId('primary')

    dispatch(
      chatSliceActions.sendingStarted({
        streamId,
        streamType: 'primary',
        conversationId,
      })
    )

    let controller: AbortController | undefined
    let unregisterGenerationAbortController = () => {}

    try {
      controller = new AbortController()
      signal.addEventListener('abort', () => controller?.abort())
      unregisterGenerationAbortController = registerGenerationAbortController(streamId, controller)

      // Prepare request body
      const requestBody: any = {
        message,
        permissionMode,
      }

      if (cwd) requestBody.cwd = cwd
      if (resume !== undefined) requestBody.resume = resume
      if (resumeSessionId) requestBody.sessionId = resumeSessionId
      if (forkSession !== undefined) requestBody.forkSession = forkSession

      // CC always routes to local server (no auth needed)
      const response = await fetch(await buildLocalApiUrl(`/agents/cc-messages/${conversationId}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText || 'Failed to send CC message'}`)
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error('No stream reader available')

      const decoder = new TextDecoder()
      let sessionId: string | null = null
      let messageCount = 0
      let userMessageId: MessageId | undefined
      let buffer = ''
      let shouldInvalidateMessages = false
      const currentPath = getState().chat.conversation.currentPath
      const inferredParentId = currentPath.length > 0 ? currentPath[currentPath.length - 1] : null

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          // Buffer management - same pattern as sendMessage
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue

            try {
              const chunk = JSON.parse(line.slice(6))

              // Handle CC-specific event types
              if (chunk.type === 'user_message' && chunk.message) {
                const normalizedUserMessage: Message = {
                  id: String(chunk.message.id) as MessageId,
                  conversation_id: conversationId,
                  role: 'user',
                  content:
                    typeof chunk.message.content === 'string' && chunk.message.content.length > 0
                      ? chunk.message.content
                      : message,
                  content_plain_text:
                    typeof chunk.message.content_plain_text === 'string' && chunk.message.content_plain_text.length > 0
                      ? chunk.message.content_plain_text
                      : typeof chunk.message.content === 'string' && chunk.message.content.length > 0
                        ? chunk.message.content
                        : message,
                  parent_id: inferredParentId,
                  children_ids: Array.isArray(chunk.message.children_ids) ? chunk.message.children_ids : [],
                  created_at:
                    typeof chunk.message.created_at === 'string' && chunk.message.created_at.length > 0
                      ? chunk.message.created_at
                      : new Date().toISOString(),
                  model_name:
                    typeof chunk.message.model_name === 'string' && chunk.message.model_name.length > 0
                      ? chunk.message.model_name
                      : 'user-input',
                  partial: typeof chunk.message.partial === 'boolean' ? chunk.message.partial : false,
                  pastedContext: Array.isArray(chunk.message.pastedContext) ? chunk.message.pastedContext : [],
                  artifacts: Array.isArray(chunk.message.artifacts) ? chunk.message.artifacts : [],
                }

                userMessageId = normalizedUserMessage.id
                dispatch(chatSliceActions.messageAdded(normalizedUserMessage))
                dispatch(chatSliceActions.messageBranchCreated({ newMessage: normalizedUserMessage }))
                updateMessageCache(extra.queryClient, conversationId, normalizedUserMessage)
                dispatch(
                  chatSliceActions.streamLineageUpdated({
                    streamId,
                    targetParentId: normalizedUserMessage.id,
                  })
                )

                await maybePersistAutoConversationTitle({
                  dispatch,
                  conversationId,
                  parentId: normalizedUserMessage.parent_id,
                  content: normalizedUserMessage.content_plain_text || normalizedUserMessage.content || message,
                  contextLabel: 'sendCCMessage',
                })
              } else if (chunk.type === 'chunk') {
                // Real-time streaming chunk (delta) - display incrementally
                // This comes from the onStreamingChunk callback for live streaming
                dispatch(
                  chatSliceActions.streamChunkReceived({
                    type: 'chunk',
                    content: chunk.delta || chunk.content || '',
                    part: chunk.part || 'text',
                    chunkType: chunk.chunkType,
                  })
                )
              } else if (chunk.type === 'message' && chunk.message) {
                // CC assistant message with ex_agent role (complete message for persistence)
                // This comes after streaming completes for final database save
                const ccMessage: Message = {
                  ...chunk.message,
                  role: 'ex_agent',
                }
                dispatch(chatSliceActions.messageAdded(ccMessage))
                dispatch(chatSliceActions.messageBranchCreated({ newMessage: ccMessage }))
                updateMessageCache(extra.queryClient, conversationId, ccMessage)
              } else if (chunk.type === 'progress') {
                // Tool execution progress - show in streaming buffer
                dispatch(
                  chatSliceActions.streamChunkReceived({
                    type: 'chunk',
                    content: chunk.toolName ? `Executing: ${chunk.toolName}` : 'Processing...',
                    part: 'text',
                  })
                )
              } else if (chunk.type === 'system') {
                // System events (init, auth, etc.) - log silently for now
              } else if (chunk.type === 'result') {
                // Result message from slash commands - backend streams output as chunks
                // But also handle direct result.result for compatibility
                if (chunk.result?.result) {
                  dispatch(
                    chatSliceActions.streamChunkReceived({
                      type: 'chunk',
                      content: chunk.result.result,
                      part: 'text',
                      chunkType: 'result_output',
                    })
                  )
                }
              } else if (chunk.type === 'complete') {
                sessionId = chunk.sessionId
                messageCount = chunk.messageCount
                shouldInvalidateMessages = true
              } else if (chunk.type === 'error') {
                dispatch(
                  chatSliceActions.streamChunkReceived({
                    type: 'error',
                    error: chunk.error || 'CC error',
                  })
                )
                throw new Error(chunk.error || 'CC stream error')
              }
            } catch (parseError) {
              // Skip malformed chunks
              if (line.length > 100) {
                console.warn('Failed to parse CC chunk:', line.substring(0, 100) + '...', parseError)
              }
            }
          }
        }
      } finally {
        reader.releaseLock()
      }

      if (shouldInvalidateMessages) {
        await extra.queryClient.invalidateQueries({ queryKey: ['conversations', conversationId, 'messages'] })
      }

      if (!sessionId) {
        throw new Error('No session ID received from CC')
      }

      dispatch(chatSliceActions.sendingCompleted({ streamId }))


      // Schedule stream cleanup after delay
      setTimeout(() => {
        dispatch(chatSliceActions.streamPruned({ streamId }))
      }, STREAM_PRUNE_DELAY)

      return { sessionId, messageCount, userMessageId, streamId }
    } catch (error) {
      dispatch(chatSliceActions.sendingCompleted({ streamId }))

      if (error instanceof Error && error.name === 'AbortError') {
        return rejectWithValue('CC message cancelled')
      }

      const message = error instanceof Error ? error.message : 'Failed to send CC message'
      dispatch(chatSliceActions.streamChunkReceived({ streamId, chunk: { type: 'error', error: message } }))
      return rejectWithValue(message)
    } finally {
      unregisterGenerationAbortController()
    }
  }
)

/**
 * Send branch message to Claude Code agent with SSE streaming
 * Always uses local server - CC is local-only.
 */
export const sendCCBranch = createAsyncThunk<
  { sessionId: string; messageCount: number; userMessageId?: MessageId; streamId: string },
  SendCCBranchPayload & { streamId?: string },
  { state: RootState; extra: ThunkExtraArgument }
>(
  'chat/sendCCBranch',
  async (
    {
      conversationId,
      message,
      cwd,
      permissionMode = 'default',
      resume,
      parentId,
      sessionId: resumeSessionId,
      forkSession,
      streamId: providedStreamId,
    },
    { dispatch, extra, rejectWithValue, signal }
  ) => {
    // Generate or use provided stream ID
    const streamId = providedStreamId ?? generateStreamId('branch')

    dispatch(
      chatSliceActions.sendingStarted({
        streamId,
        streamType: 'branch',
        conversationId,
        lineage: {
          rootMessageId: parentId,
        },
      })
    )

    let controller: AbortController | undefined
    let unregisterGenerationAbortController = () => {}

    try {
      controller = new AbortController()
      signal.addEventListener('abort', () => controller?.abort())
      unregisterGenerationAbortController = registerGenerationAbortController(streamId, controller)

      if (!parentId) {
        throw new Error('parentId is required for CC branching')
      }

      // Prepare request body - parentId is required for branching
      const requestBody: any = {
        message,
        permissionMode,
        parentId, // Explicitly pass parentId for branching
      }

      if (cwd) requestBody.cwd = cwd
      if (resume !== undefined) requestBody.resume = resume
      if (resumeSessionId) requestBody.sessionId = resumeSessionId
      if (forkSession !== undefined) requestBody.forkSession = forkSession

      // CC always routes to local server (no auth needed)
      const response = await fetch(await buildLocalApiUrl(`/agents/cc-messages-branch/${conversationId}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText || 'Failed to send CC branch message'}`)
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error('No stream reader available')

      const decoder = new TextDecoder()
      let sessionId: string | null = null
      let messageCount = 0
      let userMessageId: MessageId | undefined
      let buffer = ''
      let shouldInvalidateMessages = false

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          // Buffer management - same pattern as sendMessage
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue

            try {
              const chunk = JSON.parse(line.slice(6))

              // Handle CC-specific event types
              if (chunk.type === 'user_message' && chunk.message) {
                const normalizedUserMessage: Message = {
                  id: String(chunk.message.id) as MessageId,
                  conversation_id: conversationId,
                  role: 'user',
                  content:
                    typeof chunk.message.content === 'string' && chunk.message.content.length > 0
                      ? chunk.message.content
                      : message,
                  content_plain_text:
                    typeof chunk.message.content_plain_text === 'string' && chunk.message.content_plain_text.length > 0
                      ? chunk.message.content_plain_text
                      : typeof chunk.message.content === 'string' && chunk.message.content.length > 0
                        ? chunk.message.content
                        : message,
                  parent_id: parentId,
                  children_ids: Array.isArray(chunk.message.children_ids) ? chunk.message.children_ids : [],
                  created_at:
                    typeof chunk.message.created_at === 'string' && chunk.message.created_at.length > 0
                      ? chunk.message.created_at
                      : new Date().toISOString(),
                  model_name:
                    typeof chunk.message.model_name === 'string' && chunk.message.model_name.length > 0
                      ? chunk.message.model_name
                      : 'user-input',
                  partial: typeof chunk.message.partial === 'boolean' ? chunk.message.partial : false,
                  pastedContext: Array.isArray(chunk.message.pastedContext) ? chunk.message.pastedContext : [],
                  artifacts: Array.isArray(chunk.message.artifacts) ? chunk.message.artifacts : [],
                }

                userMessageId = normalizedUserMessage.id
                dispatch(chatSliceActions.messageAdded(normalizedUserMessage))
                dispatch(chatSliceActions.messageBranchCreated({ newMessage: normalizedUserMessage }))
                updateMessageCache(extra.queryClient, conversationId, normalizedUserMessage)
                dispatch(
                  chatSliceActions.streamLineageUpdated({
                    streamId,
                    targetParentId: normalizedUserMessage.id,
                  })
                )

                await maybePersistAutoConversationTitle({
                  dispatch,
                  conversationId,
                  parentId: normalizedUserMessage.parent_id,
                  content: normalizedUserMessage.content_plain_text || normalizedUserMessage.content || message,
                  contextLabel: 'sendCCBranch',
                  skip: true,
                })
              } else if (chunk.type === 'chunk') {
                // Real-time streaming chunk (delta) - display incrementally
                dispatch(
                  chatSliceActions.streamChunkReceived({
                    type: 'chunk',
                    content: chunk.delta || chunk.content || '',
                    part: chunk.part || 'text',
                    chunkType: chunk.chunkType,
                  })
                )
              } else if (chunk.type === 'message' && chunk.message) {
                // CC assistant message with ex_agent role (complete message for persistence)
                const ccMessage: Message = {
                  ...chunk.message,
                  role: 'ex_agent',
                }
                dispatch(chatSliceActions.messageAdded(ccMessage))
                dispatch(chatSliceActions.messageBranchCreated({ newMessage: ccMessage }))
                updateMessageCache(extra.queryClient, conversationId, ccMessage)
              } else if (chunk.type === 'progress') {
                // Tool execution progress - show in streaming buffer
                dispatch(
                  chatSliceActions.streamChunkReceived({
                    type: 'chunk',
                    content: chunk.toolName ? `Executing: ${chunk.toolName}` : 'Processing...',
                    part: 'text',
                  })
                )
              } else if (chunk.type === 'system') {
                // System events (init, auth, etc.)
              } else if (chunk.type === 'result') {
                // Result message from slash commands - backend streams output as chunks
                // But also handle direct result.result for compatibility
                if (chunk.result?.result) {
                  dispatch(
                    chatSliceActions.streamChunkReceived({
                      type: 'chunk',
                      content: chunk.result.result,
                      part: 'text',
                      chunkType: 'result_output',
                    })
                  )
                }
              } else if (chunk.type === 'complete') {
                sessionId = chunk.sessionId
                messageCount = chunk.messageCount
                shouldInvalidateMessages = true
              } else if (chunk.type === 'error') {
                dispatch(
                  chatSliceActions.streamChunkReceived({
                    type: 'error',
                    error: chunk.error || 'CC error',
                  })
                )
                throw new Error(chunk.error || 'CC branch stream error')
              }
            } catch (parseError) {
              // Skip malformed chunks
              if (line.length > 100) {
                console.warn('Failed to parse CC branch chunk:', line.substring(0, 100) + '...', parseError)
              }
            }
          }
        }
      } finally {
        reader.releaseLock()
      }

      if (shouldInvalidateMessages) {
        await extra.queryClient.invalidateQueries({ queryKey: ['conversations', conversationId, 'messages'] })
      }

      if (!sessionId) {
        throw new Error('No session ID received from CC branch')
      }

      dispatch(chatSliceActions.sendingCompleted({ streamId }))


      // Schedule stream cleanup after delay
      setTimeout(() => {
        dispatch(chatSliceActions.streamPruned({ streamId }))
      }, STREAM_PRUNE_DELAY)

      return { sessionId, messageCount, userMessageId, streamId }
    } catch (error) {
      dispatch(chatSliceActions.sendingCompleted({ streamId }))

      if (error instanceof Error && error.name === 'AbortError') {
        return rejectWithValue('CC branch message cancelled')
      }

      const message = error instanceof Error ? error.message : 'Failed to send CC branch message'
      dispatch(chatSliceActions.streamChunkReceived({ streamId, chunk: { type: 'error', error: message } }))
      return rejectWithValue(message)
    } finally {
      unregisterGenerationAbortController()
    }
  }
)

// export const fetchMessageTree = createAsyncThunk(
//   'chat/fetchMessageTree',
//   async (conversationId: number, { dispatch, rejectWithValue }) => {
//     dispatch(chatActions.messageTreeLoadingStarted())

//     try {
//       const treeData = await apiCall<any>(`/conversations/${conversationId}/messages/tree`)
//       dispatch(chatActions.messageTreeLoaded({ conversationId, treeData }))
//       return treeData
//     } catch (error) {
//       const message = error instanceof Error ? error.message : 'Failed to fetch message tree'
//       dispatch(chatActions.messageTreeError(message))
//       return rejectWithValue(message)
//     }
//   }
// )

export const respondToToolPermission = createAsyncThunk<void, boolean, { state: RootState; extra: ThunkExtraArgument }>(
  'chat/respondToToolPermission',
  async (allowed, { dispatch }) => {
    if (pendingPermissionResolve) {
      pendingPermissionResolve(allowed)
      pendingPermissionResolve = null
    }
    dispatch(chatSliceActions.toolPermissionResponded())
  }
)

export const respondToToolPermissionAndEnableAll = createAsyncThunk<
  void,
  void,
  { state: RootState; extra: ThunkExtraArgument }
>('chat/respondToToolPermissionAndEnableAll', async (_, { dispatch }) => {
  // Enable auto-approve mode for all future tools
  dispatch(chatSliceActions.toolAutoApproveEnabled())

  // Approve the current pending tool call
  if (pendingPermissionResolve) {
    pendingPermissionResolve(true)
    pendingPermissionResolve = null
  }

  // Clear the permission dialog
  dispatch(chatSliceActions.toolPermissionResponded())
})

/**
 * Fetch all user system prompts for the current user
 */
export const fetchUserSystemPrompts = createAsyncThunk<
  void,
  { accessToken: string | null },
  { state: RootState; extra: ThunkExtraArgument }
>('chat/fetchUserSystemPrompts', async ({ accessToken }, { dispatch, rejectWithValue }) => {
  dispatch(chatSliceActions.userSystemPromptsLoadingStarted())

  try {
    const prompts = await apiCall<any[]>('/system-prompts', accessToken)
    dispatch(chatSliceActions.userSystemPromptsLoaded(prompts))
    return
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch user system prompts'
    dispatch(chatSliceActions.userSystemPromptsError(message))
    return rejectWithValue(message)
  }
})
// LM Studio models loader hook wiring TODO: integrate fetchLmStudioModels into useModels when provider = 'lmstudio'
// Type shim for LM Studio branch to track parent across tool turns
