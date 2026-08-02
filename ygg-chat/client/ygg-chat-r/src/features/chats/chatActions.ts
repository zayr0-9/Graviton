import { createAsyncThunk } from '@reduxjs/toolkit'
import type { QueryClient } from '@tanstack/react-query'
import { v4 as uuidv4 } from 'uuid'
import {
  estimateContentBlocksForContext,
  safeEstimateTokenCount,
} from './contextTokenEstimate'
import { ConversationId, MessageId } from '../../../../../shared/types'
import { isCommunityMode } from '../../config/runtimeMode'
import { localMirror as dualSync } from '../../lib/localMirror'
import type { RootState } from '../../store/store'
import { ThunkExtraArgument } from '../../store/thunkExtra'
import {
  API_BASE,
  buildLocalApiUrl,
  createStreamingRequest,
  cloudApi,
  environment,
  getCachedLocalApiBase,
  gwApi,
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
  ImageDraft,
  Message,
  Model,
  SendMessagePayload,
  ToolDefinition,
} from './chatTypes'
import { createBedrockStreamingRequest } from './Bedrock'
import { createLmStudioStreamingRequest } from './LMStudio'
import { createOpenAIChatGPTStreamingRequest } from './OpenAIChatGPT'
import { createZaiStreamingRequest } from './Zai'
import {
  buildCompactionHistoryLines,
  buildCompactionToolContextAppendix,
  buildCompactionWriteOpAppendix,
} from './compactionContext'
// OpenAI OAuth is handled internally by OpenAIChatGPT module
import { loadAutoCompactionEnabled } from '../../helpers/chatUiSettingsStorage'
import { getSubagentReasoningEffort } from '../../helpers/subagentToolSettings'
import { loadLongTermMemoryContextEnabled } from '../../helpers/longTermMemorySettingsStorage'
import { DEFAULT_COMPACTION_SYSTEM_PROMPT, loadProviderSettings } from '../../helpers/providerSettingsStorage'
import { updateToolEnabledState } from '../../helpers/toolSettingsStorage'
import { generateStreamId, STREAM_PRUNE_DELAY } from './streamHelpers'
import { createStreamingRun, finishStreamingRun } from './streamRunTracking'
import { runServerChatLoop, runServerReattach, postStreamAbort } from './mainChatClient'
import {
  addInflightStream,
  removeInflightStream,
  listInflightStreams,
  updateInflightStreamCursor,
} from './inflightStreams'
import { isResumableRunsEnabled } from '../../helpers/serverLoopSettings'
import { buildServerLoopRequest } from './buildServerLoopRequest'
import { buildConversationTree } from './conversationTree'
import { conversationQueryKeys } from './conversationQueryKeys'
import type { ConversationMessagesTreeData } from './conversationMessagesApi'
import { getValidTokens } from './openaiOAuth'
import { filterToolsForOperationMode } from './operationModeSystemPrompt'
import {
  getAllTools,
  setCustomTools,
  setMcpTools,
  updateToolEnabled as updateToolEnabledInDefinitions,
} from './toolDefinitions'
import { type ChatHookProjectContext } from './chatHookClient'
import { type PlanClarificationAnswer } from './planToolTypes'
import { abortSubagentControllers } from './subagentClient'
import {
  fetchConversationUndoSummaries,
  markStreamUndoFinalMessage,
  restoreStreamUndo as restoreStreamUndoApi,
} from './streamUndoApi'

// TODO: Import when conversations feature is available
// import { conversationActions } from '../conversations'

// Remote API base for syncing from cloud (Railway)
const getRemoteApiBase = (): string | null =>
  isCommunityMode ? null : import.meta.env.VITE_API_URL || 'https://webdrasil-production.up.railway.app/api'
// Tools that should not prompt for user permission before execution.
// Server-executed tools (e.g., brave_search) are already excluded upstream.




/**
 * Creates a Message object for tool results to be used in LM Studio conversation history.
 * These are ephemeral messages used only for building the API request, not persisted.
 */

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

const buildTreeFromMessages = buildConversationTree

/**
 * Best-effort live refresh of the Heimdall node tree during a server-owned run.
 *
 * Heimdall renders from its own `heimdall.treeData` slice, normally fed from the React
 * Query messages/tree cache. The thin-client SSE loop updates Redux
 * `conversation.messages` (via projection) but NOT that query cache, so pre-fix the graph
 * did not update mid-send — it only refreshed after a conversation switch evicted+refetched
 * the query. We rebuild the tree from the live Redux messages and dispatch it straight into
 * `heimdall.treeData`. Deliberately NOT via `setQueryData` on the messages cache: that would
 * re-fire Chat.tsx's `messagesLoaded` effect and clobber the in-flight streamed messages.
 * Wrapped so a failure never interrupts generation. Called on each persisted message
 * (user / assistant / terminal) by the server-loop client's onMessagePersisted hook.
 */
const refreshHeimdallTreeFromState = (getState: () => RootState, dispatch: (action: unknown) => unknown): void => {
  try {
    const messages = getState().chat.conversation.messages
    dispatch(chatSliceActions.heimdallDataLoaded({ treeData: buildTreeFromMessages(messages) }))
  } catch (error) {
    console.warn('[serverLoop] Heimdall tree refresh failed (non-fatal):', error)
  }
}

/**
 * Build the compaction/context fields for the server-owned loop request from the renderer's
 * settings. Pre-fix these were dropped, so the server always fell back to its defaults:
 * auto-compaction ran even when the user disabled it, and the trigger used a per-model
 * default window instead of the SELECTED model's context length. Sourced from the same
 * settings the manual compactBranch path uses (loadAutoCompactionEnabled + providerSettings).
 * contextLength comes from the selected model's cache entry. buildServerLoopRequest forwards
 * each field only-when-set, so a caller that can't resolve one keeps the server default.
 */
const buildCompactionRequestParams = (
  modelsData: { models?: Model[]; default?: Model; selected?: Model } | undefined,
  modelName: string | undefined
): {
  autoCompactionEnabled: boolean
  contextLength: number | undefined
  compactionProvider: string | null
  compactionModelName: string | null
  compactionSystemPrompt: string
} => {
  const settings = loadProviderSettings()
  const model =
    modelsData?.models?.find(m => m.name === modelName) || modelsData?.selected || modelsData?.default || null
  return {
    autoCompactionEnabled: loadAutoCompactionEnabled(),
    contextLength: model?.contextLength,
    compactionProvider: settings.compactionProvider,
    compactionModelName: settings.compactionModel,
    compactionSystemPrompt: settings.compactionSystemPrompt,
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

  const cacheKey = conversationQueryKeys.messages(conversationId)
  const existingData = queryClient.getQueryData<ConversationMessagesTreeData>(cacheKey)

  if (existingData) {
    const deletedSet = new Set(deletedIds.map(String))

    // Filter out deleted messages
    const remainingMessages = existingData.messages.filter(msg => !deletedSet.has(String(msg.id)))

    // Rebuild tree from remaining messages
    const newTree = buildTreeFromMessages(remainingMessages)

    queryClient.setQueryData(cacheKey, {
      ...existingData,
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

  const cacheKey = conversationQueryKeys.messages(conversationId)
  const existingData = queryClient.getQueryData<ConversationMessagesTreeData>(cacheKey)

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
      ...existingData,
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
  const cacheKey = conversationQueryKeys.messages(conversationId)
  const existingData = queryClient.getQueryData<ConversationMessagesTreeData>(cacheKey)

  if (existingData) {
    const updatedMessages = [...existingData.messages, newMessage]
    const updatedTree = addMessageToTree(existingData.tree, newMessage, newMessage.parent_id ?? null)

    queryClient.setQueryData(cacheKey, {
      ...existingData,
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
const mergeArtifactUrls = (existing: string[] | undefined, incoming: string[]): string[] => {
  const merged = Array.isArray(existing) ? [...existing] : []
  const seen = new Set(merged)
  for (const artifact of incoming) {
    if (!seen.has(artifact)) {
      merged.push(artifact)
      seen.add(artifact)
    }
  }
  return merged
}

const getDraftsForTarget = (
  state: RootState,
  target: { kind: 'composer' } | { kind: 'branch'; messageId: MessageId }
): ImageDraft[] => {
  const draftTarget = state.chat.composition.imageDraftTarget
  if (!draftTarget) return []
  if (draftTarget.kind !== target.kind) return []
  if (target.kind === 'branch') {
    if (draftTarget.kind !== 'branch' || String(draftTarget.messageId) !== String(target.messageId)) return []
  }
  return state.chat.composition.imageDrafts || []
}

type LocalAttachmentDraft = {
  dataUrl: string
  name?: string
  type?: string
  size?: number
  filePath?: string
  attachmentId?: string
  sha256?: string
}

type PreparedLocalAttachment = {
  id: string
  file_path: string
  sha256: string
  mime_type: string
  size_bytes: number
}

const prepareLocalAttachmentsForModel = async (
  attachments: LocalAttachmentDraft[] | null,
  contextLabel: string
): Promise<LocalAttachmentDraft[] | null> => {
  if (!attachments?.length) return attachments
  try {
    const result = await localApi.post<{ attachments?: PreparedLocalAttachment[] }>('/local/attachments/prepare-base64', { attachments })
    const prepared = Array.isArray(result?.attachments) ? result.attachments : []
    if (prepared.length !== attachments.length) throw new Error('Local attachment preparation returned an incomplete result')
    return attachments.map((attachment, index) => ({
      ...attachment,
      filePath: prepared[index].file_path,
      attachmentId: prepared[index].id,
      sha256: prepared[index].sha256,
    }))
  } catch (err) {
    console.error(`[${contextLabel}] Failed to prepare local attachments:`, err)
    throw new Error('Failed to save attached image locally before sending the message')
  }
}




const updateMessageArtifactsInCache = (
  queryClient: QueryClient | null,
  conversationId: ConversationId,
  messageId: MessageId,
  newArtifacts: string[]
) => {
  if (!queryClient || !newArtifacts.length) return

  const cacheKey = conversationQueryKeys.messages(conversationId)
  const existingData = queryClient.getQueryData<ConversationMessagesTreeData>(cacheKey)

  if (existingData) {
    // Update the message artifacts in the messages array without dropping existing local previews.
    const updatedMessages = existingData.messages.map(msg =>
      msg.id === messageId ? { ...msg, artifacts: mergeArtifactUrls(msg.artifacts, newArtifacts) } : msg
    )

    queryClient.setQueryData(cacheKey, {
      ...existingData,
      messages: updatedMessages,
    })
  }
}

/**
 * Updates a project's updated_at timestamp in React Query cache
 * Called when a message is added to a conversation in this project
 * This ensures the project list reflects recent activity immediately
 */

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













/**
 * Resolve timeout for a tool call.
 * Priority: explicit override -> tool args -> tool metadata -> global default.
 */


const resolveOpenRouterTemperature = (providerSlug: string): number | undefined => {
  if (providerSlug !== 'openrouter') return undefined
  const configured = loadProviderSettings().openRouterTemperature
  return typeof configured === 'number' ? configured : undefined
}


type MemoryContexts = {
  longTermMemory: string | null
  recentMemory: string | null
  projectMemory: string | null
  projectName: string | null
}

const maybeLoadMemoryContexts = async (project?: ChatHookProjectContext | null): Promise<MemoryContexts> => {
  const emptyMemoryContexts: MemoryContexts = { longTermMemory: null, recentMemory: null, projectMemory: null, projectName: null }
  const isElectronMode =
    import.meta.env.VITE_ENVIRONMENT === 'electron' ||
    (typeof __IS_ELECTRON__ !== 'undefined' && __IS_ELECTRON__)

  if (!isElectronMode || !loadLongTermMemoryContextEnabled()) return emptyMemoryContexts

  try {
    const params = new URLSearchParams({ maxChars: '10000', recentMaxChars: '10000', projectMaxChars: '12000' })
    if (project?.projectId) params.set('projectId', project.projectId)
    if (project?.projectName) params.set('projectName', project.projectName)
    const result = await localApi.get<{
      success?: boolean
      memory?: string
      recentMemory?: string
      projectMemory?: string
      projectName?: string | null
    }>(`/memory/context?${params.toString()}`)
    const longTermMemory = typeof result?.memory === 'string' ? result.memory.trim() : ''
    const recentMemory = typeof result?.recentMemory === 'string' ? result.recentMemory.trim() : ''
    const projectMemory = typeof result?.projectMemory === 'string' ? result.projectMemory.trim() : ''
    return {
      longTermMemory: longTermMemory || null,
      recentMemory: recentMemory || null,
      projectMemory: projectMemory || null,
      projectName: typeof result?.projectName === 'string' && result.projectName.trim() ? result.projectName.trim() : project?.projectName ?? null,
    }
  } catch (error) {
    console.warn('[longTermMemory] Failed to load memory context:', error)
    return emptyMemoryContexts
  }
}


const buildProjectContextForMemory = (project: { id?: string | null; name?: string | null } | null | undefined): ChatHookProjectContext | null => {
  if (!project?.id && !project?.name) return null
  return {
    projectId: project?.id != null ? String(project.id) : null,
    projectName: typeof project?.name === 'string' ? project.name : null,
  }
}


export const AUTO_COMPACTION_NOTE = '__auto_compaction_summary__'
export const AUTO_COMPACTION_SUMMARY_RESUME_LINE = 'Following is summary of the session, you have to resume the work.'
export const GENERATED_IMAGE_PATH_HINT_NOTE = '__generated_image_path_hint__'

const isAutoCompactionSummaryMessage = (msg: Message | undefined | null): boolean => {
  if (!msg) return false
  return typeof msg.note === 'string' && msg.note === AUTO_COMPACTION_NOTE
}

const isGeneratedImagePathHintMessage = (msg: Message | undefined | null): boolean => {
  if (!msg) return false
  return typeof msg.note === 'string' && msg.note === GENERATED_IMAGE_PATH_HINT_NOTE
}


const ensureCompactionSummaryResumeLine = (content: string | null | undefined): string => {
  const trimmed = typeof content === 'string' ? content.trim() : ''
  if (!trimmed) return AUTO_COMPACTION_SUMMARY_RESUME_LINE
  if (trimmed.startsWith(AUTO_COMPACTION_SUMMARY_RESUME_LINE)) return trimmed
  return `${AUTO_COMPACTION_SUMMARY_RESUME_LINE}\n\n${trimmed}`
}








const trimHistoryToLatestCompaction = (messages: Array<Message | undefined>): Message[] => {
  const resolved = messages.filter(Boolean) as Message[]

  if (resolved.length === 0) return []

  let latestCompactionIndex = -1

  for (let i = resolved.length - 1; i >= 0; i--) {
    if (isAutoCompactionSummaryMessage(resolved[i])) {
      latestCompactionIndex = i

      break
    }
  }

  return latestCompactionIndex >= 0 ? resolved.slice(latestCompactionIndex) : resolved
}

const appendGeneratedImagePathHintsForHistory = (history: Message[], allMessages: Message[]): Message[] => {
  if (!Array.isArray(history) || history.length === 0 || !Array.isArray(allMessages) || allMessages.length === 0) {
    return history
  }

  const historyIds = new Set(history.map(message => String(message.id)))

  const hintByParent = new Map<string, Message[]>()

  for (const message of allMessages) {
    if (!isGeneratedImagePathHintMessage(message) || message.parent_id == null) continue

    if (historyIds.has(String(message.id))) continue

    const key = String(message.parent_id)

    const existing = hintByParent.get(key)

    if (existing) existing.push(message)
    else hintByParent.set(key, [message])
  }

  if (hintByParent.size === 0) return history

  const expanded: Message[] = []

  let changed = false

  for (const message of history) {
    expanded.push(message)

    const hints = hintByParent.get(String(message.id))

    if (!hints?.length) continue

    changed = true

    expanded.push(...hints.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()))
  }

  return changed ? expanded : history
}

/**
 * Execute browse_web locally (allowed even in non-electron)
 */

const generationAbortControllersByStream = new Map<string, Set<AbortController>>()

/** True when this renderer already owns the live reader for a server run. */
export const hasGenerationReader = (streamId: string | null | undefined): boolean =>
  Boolean(streamId && generationAbortControllersByStream.get(streamId)?.size)

// Stop retains markers whose server abort request failed. The owning thunk consumes this
// hint in its finally path instead of erasing the only way to reconcile the live run.
const retainInflightMarkerOnReaderClose = new Set<string>()

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
  async (
    { conversationId, parentMessageId, messages, providerName, modelName },
    { dispatch, getState, extra, rejectWithValue }
  ) => {
    dispatch(chatSliceActions.compactingStarted({ conversationId }))

    try {
      const { auth } = extra
      const state = getState() as RootState

      const provider = providerName || state.chat.providerState.currentProvider || 'OpenRouter'
      const providerSlug = provider.toLowerCase().replace(/\s+/g, '')
      const isLmStudio = providerSlug === 'lmstudio'
      const isOpenAIChatGPT = providerSlug === 'openaichatgpt' || providerSlug === 'openai(chatgpt)'
      const isBedrock = /^(bedrock|awsbedrock|aws-bedrock|amazonbedrock|amazon-bedrock)$/.test(providerSlug)
      const isZai =
        providerSlug === 'z.ai/glm' || providerSlug === 'zai/glm' || providerSlug === 'zai' || providerSlug === 'glm'

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
      const toolContextAppendix = buildCompactionToolContextAppendix(compactableHistory)
      const writeOpAppendix = buildCompactionWriteOpAppendix(compactableHistory)

      console.log('[compactBranch] prepared', {
        resolvedModelName,
        compactableHistoryCount: compactableHistory.length,
        historyLinesCount: historyLines.length,
        toolContextAppendixChars: toolContextAppendix.length,
        writeOpAppendixChars: writeOpAppendix.length,
      })

      if (historyLines.length === 0 && !toolContextAppendix && !writeOpAppendix) {
        console.log('[compactBranch] skip: no history lines or tool appendices')
        return { message: null }
      }

      const providerSettings = loadProviderSettings()
      const compactionSystemPrompt = providerSettings.compactionSystemPrompt?.trim() || DEFAULT_COMPACTION_SYSTEM_PROMPT
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
        ...(toolContextAppendix ? ['', toolContextAppendix] : []),
      ].join('\n')

      let summaryText = ''

      console.log('[compactBranch] execution route', {
        provider,
        providerSlug,
        isLmStudio,
        isOpenAIChatGPT,
        isZai,
        usingEphemeral: !isLmStudio && !isOpenAIChatGPT && !isZai,
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
      } else if (isOpenAIChatGPT || isZai || isBedrock) {
        await (isBedrock ? createBedrockStreamingRequest : isZai ? createZaiStreamingRequest : createOpenAIChatGPTStreamingRequest)(
          {
            conversationId,
            parentId: parentMessageId,
            modelName: resolvedModelName,
            systemPrompt: compactionSystemPrompt,
            messages: [
              { role: 'system', content: compactionSystemPrompt },
              { role: 'user', content: compactionUserPrompt },
            ],
            ...(isZai || isBedrock ? { userId: auth.userId } : {}),
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

      const fencedToolContextAppendix = toolContextAppendix ? `\`\`\`\n${toolContextAppendix}\n\`\`\`` : ''
      const fencedWriteOpAppendix = writeOpAppendix ? `\`\`\`\n${writeOpAppendix}\n\`\`\`` : ''
      const persistedSummaryContent = ensureCompactionSummaryResumeLine(
        [finalSummary, fencedToolContextAppendix, fencedWriteOpAppendix]
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
      think,
      imageConfig,
      reasoningConfig,
      serviceTier,
      cwd,
      operationMode: requestedOperationMode,
      streamId: providedStreamId,
    },
    { dispatch, getState, extra, rejectWithValue, signal }
  ) => {
    const { auth } = extra

    // Generate or use provided stream ID
    const streamId = providedStreamId ?? generateStreamId('primary')
    const preSendState = getState() as RootState
    const preSendDrafts = getDraftsForTarget(preSendState, { kind: 'composer' })
    const preSendAttachmentsBase64 = preSendDrafts.length
      ? preSendDrafts.map(d => ({
        dataUrl: d.dataUrl,
        name: d.name,
        type: d.type,
        size: d.size,
        filePath: d.filePath,
        attachmentId: d.attachmentId,
        sha256: d.sha256,
      }))
      : null
    const preSendSelectedFilesForChat = preSendState.ideContext.selectedFilesForChat || []

    dispatch(
      chatSliceActions.sendingStarted({
        streamId,
        streamType: 'primary',
        conversationId,
        lineage: {
          lineageId: preSendState.chat.conversation.currentLineageId ?? undefined,
          rootMessageId: parent,
        },
      })
    )
    void createStreamingRun({
      streamId,
      conversationId,
      parentMessageId: parent ?? null,
      streamType: 'primary',
      operation: 'send',
      source: 'renderer',
      lineage: { rootMessageId: parent },
    })
    // Detach/reattach: mark this run in-flight so a reload can re-attach to it. Cleared
    // in the finally below on normal end; a reload kills the thunk first, leaving the
    // marker for mount-time resume (resumeInFlightStreams).
    if (isResumableRunsEnabled()) {
      addInflightStream({
        streamId,
        conversationId: String(conversationId),
        streamType: 'primary',
        parentMessageId: parent ?? null,
      })
    }

    let controller: AbortController | undefined
    let unregisterGenerationAbortController = () => {}

    try {
      controller = new AbortController()
      signal.addEventListener('abort', () => controller?.abort())
      unregisterGenerationAbortController = registerGenerationAbortController(streamId, controller)

      const state = getState() as RootState
      const { messages: currentMessages } = state.chat.conversation
      const currentPathIds = state.chat.conversation.currentPath.filter(id => id !== 'root')
      const currentPathMessages = appendGeneratedImagePathHintsForHistory(
        trimHistoryToLatestCompaction(currentPathIds.map(id => currentMessages.find(m => m.id === id))),
        currentMessages
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
      const serverProvider =
        providerSlug === 'google' ? 'gemini' : /^(zai|glm|z\.ai)(\/glm)?$/.test(providerSlug) ? 'zai' : /^(bedrock|awsbedrock|aws-bedrock|amazonbedrock|amazon-bedrock)$/.test(providerSlug) ? 'bedrock' : providerSlug
      const openRouterTemperature = resolveOpenRouterTemperature(providerSlug)
      const isOpenAIChatGPT = providerSlug === 'openaichatgpt' || providerSlug === 'openai(chatgpt)'
      // Gather any image drafts (base64) captured before send start so UI can clear immediately.
      const attachmentsBase64 = await prepareLocalAttachmentsForModel(preSendAttachmentsBase64, 'image attachments')

      // Combine mode, user default, project, and conversation system prompts.
      const selectedProject = selectSelectedProject(state)
      const operationModeAtSend = requestedOperationMode ?? state.chat.operationMode
      const projectContext = selectedProject?.context || null
      const conversationContextSource = state.conversations.convContext || null
      // Get selected files for chat captured before send start so UI can clear immediately
      const selectedFilesForChat = preSendSelectedFilesForChat

      const conversationMeta = state.conversations.items.find(c => c.id === conversationId)
      // Use React Query cache as fallback for storage mode detection (handles local conversations not yet in Redux)
      const storageMode = conversationMeta?.storage_mode || getStorageModeFromCache(extra.queryClient, conversationId)
      // Keep cwd for tool execution context only (do not inject cwd into system prompt)
      const payloadCwd = typeof cwd === 'string' ? cwd.trim() : (cwd ?? null)
      const effectiveToolRootPath = payloadCwd || conversationMeta?.cwd || state.ideContext.workspace?.rootPath || null

      // Determine execution mode
      const isElectronMode =
        import.meta.env.VITE_ENVIRONMENT === 'electron' || (typeof __IS_ELECTRON__ !== 'undefined' && __IS_ELECTRON__)

      // ── Server-owned chat loop (thin client) ──
      // Every provider's send now runs through the headless engine (Phase 6 cutover;
      // there is no client-owned fallback loop). toolAutoApprove is forwarded so the
      // server auto-approves (true) or pauses per tool for an interactive permission
      // decision (false). The stream setup (sendingStarted / AbortController) above and
      // the catch/finally below are shared. Web mode is not a target — the throw below
      // covers the non-Electron path.
      if (isElectronMode) {
        // ChatGPT auth: resolve fresh {accessToken, accountId} from the renderer (auto-
        // refreshing) so the server uses them directly. null for every other provider.
        const chatgptServerAuth = isOpenAIChatGPT ? await getValidTokens() : null
        const { path, body } = buildServerLoopRequest('send', {
          conversationId: String(conversationId),
          content: input.content.trim(),
          provider: serverProvider,
          modelName,
          userId: auth.userId,
          parentId: parent ?? null,
          operationMode: operationModeAtSend,
          think,
          reasoningConfig,
          subagentReasoningEffort: getSubagentReasoningEffort(),
          imageConfig,
          rootPath: effectiveToolRootPath,
          conversationContext: conversationContextSource,
          projectContext,
          storageMode,
          attachmentsBase64,
          selectedFiles: selectedFilesForChat,
          tools: filterToolsForOperationMode(getAllTools(), operationModeAtSend),
          streamId,
          currentLineageId: state.chat.conversation.currentLineageId,
          toolAutoApprove: state.chat.toolAutoApprove,
          hooksEnabled: isElectronMode,
          localApiBase: getCachedLocalApiBase(),
          // Phase 4 openrouter parity: undefined for lmstudio/zai (omitted from body),
          // so the local-provider request is unchanged; serviceTier only for openrouter.
          temperature: openRouterTemperature,
          serviceTier: providerSlug === 'openrouter' ? serviceTier : undefined,
          // ChatGPT: forward fresh renderer tokens so the server resolves auth directly
          // (null for every other provider => omitted from the body).
          accessToken: chatgptServerAuth?.accessToken,
          accountId: chatgptServerAuth?.accountId,
          // Auto-compaction / context settings (previously dropped => server used defaults,
          // ignoring the user's disable toggle and the selected model's real context window).
          ...buildCompactionRequestParams(modelsData, modelName),
        })
        const result = await runServerChatLoop(
          {
            operation: 'send',
            conversationId: String(conversationId),
            streamId,
            path,
            request: body,
            signal: controller.signal,
          },
          {
            dispatch,
            getState,
            onMessagePersisted: () => refreshHeimdallTreeFromState(getState, dispatch),
            onSeq: (seq, event) => {
              if (
                event.type !== 'permission_required' &&
                event.type !== 'clarify_required' &&
                event.type !== 'operation_mode_upgrade_required'
              )
                updateInflightStreamCursor(streamId, seq)
            },
          }
        )
        if (result.messageId) {
          void finishStreamingRun(streamId, {
            status: result.providerError ? 'error' : 'completed',
            endReason: result.providerError ? 'error' : 'completed',
            assistantMessageId: result.messageId,
            finalMessageId: result.messageId,
          })
          void markStreamUndoFinalMessage(streamId, String(result.messageId))
            .then(summary => {
              if (summary)
                dispatch(
                  chatSliceActions.streamUndoSummariesReceived({
                    conversationId: String(conversationId),
                    summaries: [summary],
                  })
                )
            })
            .catch(error => console.warn('[serverLoop] Failed to mark final message', error))
        }
        // NOTE: streamCompleted is dispatched by the projection on the terminal 'complete'
        // event, so the shim must NOT re-dispatch it here (avoid double-finalize).
        dispatch(chatSliceActions.sendingCompleted({ streamId }))
        setTimeout(() => dispatch(chatSliceActions.streamPruned({ streamId })), STREAM_PRUNE_DELAY)
        return { messageId: result.messageId, userMessage: result.userMessage, streamId }
      }

      // Phase 6: the renderer is a pure thin client — there is no client-owned
      // fallback loop. Web mode is not a target; the server-owned loop requires the
      // local Electron server.
      throw new Error('The server-owned chat loop requires Electron.')
    } catch (error) {
      dispatch(chatSliceActions.sendingCompleted({ streamId }))

      if (error instanceof Error && error.name === 'AbortError') {
        return rejectWithValue('Message cancelled')
      }

      const message = error instanceof Error ? error.message : 'Failed to send message'
      void finishStreamingRun(streamId, {
        status: error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'error',
        endReason:
          error instanceof Error && error.name === 'AbortError'
            ? 'aborted'
            : error instanceof Error && error.message.includes('context compaction')
              ? 'context_compaction_failed'
              : 'error',
        error: message,
      })
      dispatch(chatSliceActions.streamChunkReceived({ streamId, chunk: { type: 'error', error: message } }))
      return rejectWithValue(message)
    } finally {
      unregisterGenerationAbortController()
      // Terminal for THIS session (completed / errored / cancelled). Only a reload —
      // which kills the thunk before finally — leaves the marker for mount-time resume.
      if (!retainInflightMarkerOnReaderClose.delete(streamId)) removeInflightStream(streamId)
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

      // Storage-aware update via the gateway (routes local vs cloud + mirrors).
      const body: any = { content, note }
      if (note_color !== undefined && isLocalMode) body.note_color = note_color
      if (content_blocks) body.content_blocks = content_blocks
      const updated = await gwApi.put<Message>(
        `/messages/${id}?conversationId=${encodeURIComponent(String(currentConversationId ?? ''))}`,
        body
      )
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
>('chat/fetchConversationMessages', async (conversationId, { dispatch, rejectWithValue, getState }) => {
  try {
    const raw = await gwApi.get<Message[]>(`/conversations/${conversationId}/messages`)
    // Ensure client-only fields exist
    const messages: Message[] = (raw || []).map(m => ({
      ...m,
      pastedContext: Array.isArray((m as any).pastedContext) ? (m as any).pastedContext : [],
      artifacts: Array.isArray((m as any).artifacts) ? (m as any).artifacts : [],
    }))

    if (String(getState().chat.conversation.currentConversationId ?? '') !== String(conversationId)) {
      return messages
    }
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
>('chat/deleteMessage', async ({ id, conversationId, storageMode }, { extra, rejectWithValue }) => {
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

    // Storage-aware delete via the gateway (routes local vs cloud).
    await gwApi.delete(`/messages/${id}?conversationId=${encodeURIComponent(String(conversationId))}`)
    // Sync React Query cache immediately
    removeMessagesFromCache(extra.queryClient, conversationId, [id])
    // Sync message deletion to local SQLite (fire-and-forget)
    dualSync.syncMessage({ id }, 'delete')
    // Chat routes reconcile the authoritative post-delete snapshot through the
    // generation-gated coordinator. Do not dispatch a legacy raw snapshot here.
    void isLocalMode
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
    {
      conversationId,
      originalMessageId,
      newContent,
      modelOverride,
      think,
      serviceTier,
      cwd,
      operationMode: requestedOperationMode,
      streamId: providedStreamId,
    },
    { dispatch, getState, extra, rejectWithValue, signal }
  ) => {
    const { auth } = extra

    // Generate or use provided stream ID
    const streamId = providedStreamId ?? generateStreamId('branch')

    // Snapshot composition state before send start so UI can clear immediately.
    const preSendState = getState() as RootState
    const preSendDrafts = getDraftsForTarget(preSendState, { kind: 'branch', messageId: originalMessageId })
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
          lineageId: preSendState.chat.conversation.currentLineageId ?? undefined,
          originMessageId: originalMessageId,
          rootMessageId: parentMessageId, // Parent where new branch attaches
        },
      })
    )
    void createStreamingRun({
      streamId,
      conversationId,
      parentMessageId: parentMessageId ?? null,
      streamType: 'branch',
      operation: 'edit-branch',
      source: 'renderer',
      lineage: { originMessageId: originalMessageId, rootMessageId: parentMessageId },
    })
    if (isResumableRunsEnabled()) {
      addInflightStream({
        streamId,
        conversationId: String(conversationId),
        streamType: 'branch',
        parentMessageId: parentMessageId ?? null,
      })
    }

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
      const currentPathMessages = appendGeneratedImagePathHintsForHistory(
        trimHistoryToLatestCompaction(truncatedPathIds.map(id => currentMessages.find(m => m.id === id))),
        currentMessages
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
      const serverProvider =
        providerSlug === 'google' ? 'gemini' : /^(zai|glm|z\.ai)(\/glm)?$/.test(providerSlug) ? 'zai' : /^(bedrock|awsbedrock|aws-bedrock|amazonbedrock|amazon-bedrock)$/.test(providerSlug) ? 'bedrock' : providerSlug
      const openRouterTemperature = resolveOpenRouterTemperature(providerSlug)
      const isOpenAIChatGPT = providerSlug === 'openaichatgpt' || providerSlug === 'openai(chatgpt)'

      // Combine mode, user default, project, and conversation system prompts.
      const selectedProject = selectSelectedProject(state)
      const operationModeAtSend = requestedOperationMode ?? state.chat.operationMode
      const projectContext = selectedProject?.context || null
      const conversationContextSource = state.conversations.convContext || null
      const projectMemoryContext = buildProjectContextForMemory(selectedProject)
      const memoryContexts = await maybeLoadMemoryContexts(projectMemoryContext)

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
      const attachmentDrafts = combinedArtifacts.length
        ? combinedArtifacts.map(dataUrl => {
            // Try to find matching draft for full metadata
            const matchingDraft = drafts.find(d => d.dataUrl === dataUrl)
            if (matchingDraft) {
              return {
                dataUrl,
                name: matchingDraft.name,
                type: matchingDraft.type,
                size: matchingDraft.size,
                filePath: matchingDraft.filePath,
                attachmentId: matchingDraft.attachmentId,
                sha256: matchingDraft.sha256,
              }
            }
            // For existing artifacts (data URLs), extract type from the data URL
            const typeMatch = dataUrl.match(/^data:([^;]+);/)
            const mimeType = typeMatch ? typeMatch[1] : 'image/png'
            return { dataUrl, name: 'image', type: mimeType, size: 0 }
          })
        : null
      const attachmentsBase64 = await prepareLocalAttachmentsForModel(attachmentDrafts, 'edit message image attachments')

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

      const resolvedModel =
        modelsData?.models?.find(model => model.name === modelName) ||
        modelsData?.selected ||
        modelsData?.default ||
        null
      const branchContextLimit = resolvedModel?.contextLength || 128_000

      let promptAndContextTokens = 0
      promptAndContextTokens += safeEstimateTokenCount(selectedProject?.system_prompt)
      promptAndContextTokens += safeEstimateTokenCount(selectedProject?.context)
      promptAndContextTokens += safeEstimateTokenCount(state.conversations.systemPrompt)
      promptAndContextTokens += safeEstimateTokenCount(state.conversations.convContext)
      promptAndContextTokens += safeEstimateTokenCount(memoryContexts.longTermMemory)
      promptAndContextTokens += safeEstimateTokenCount(memoryContexts.recentMemory)
      promptAndContextTokens += safeEstimateTokenCount(memoryContexts.projectMemory)

      let messageTokens = 0
      currentPathMessages.forEach(message => {
        if (!message) return
        messageTokens += safeEstimateTokenCount(message.content)
        messageTokens += estimateContentBlocksForContext((message as any).content_blocks)
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

      // Determine execution mode
      const isElectronMode =
        import.meta.env.VITE_ENVIRONMENT === 'electron' || (typeof __IS_ELECTRON__ !== 'undefined' && __IS_ELECTRON__)

      // ── Server-owned chat loop (thin client) — edit-branch ──
      // Every provider runs through the headless engine (Phase 6). Web mode is not a
      // target — the throw below covers the non-Electron path.
      if (isElectronMode) {
        // ChatGPT auth: resolve fresh {accessToken, accountId} from the renderer (auto-
        // refreshing) so the server uses them directly. null for every other provider.
        const chatgptServerAuth = isOpenAIChatGPT ? await getValidTokens() : null
        const { path, body } = buildServerLoopRequest('edit', {
          conversationId: String(conversationId),
          content: newContent,
          provider: serverProvider,
          modelName,
          userId: auth.userId,
          messageId: String(originalMessageId),
          parentId: parentMessageId ?? null,
          operationMode: operationModeAtSend,
          think,
          subagentReasoningEffort: getSubagentReasoningEffort(),
          rootPath: effectiveToolRootPath,
          conversationContext: conversationContextSource,
          projectContext,
          storageMode,
          attachmentsBase64,
          selectedFiles: selectedFilesForChat,
          tools: filterToolsForOperationMode(getAllTools(), operationModeAtSend),
          streamId,
          currentLineageId: state.chat.conversation.currentLineageId,
          toolAutoApprove: state.chat.toolAutoApprove,
          hooksEnabled: isElectronMode,
          localApiBase: getCachedLocalApiBase(),
          // Phase 4 openrouter parity: undefined for lmstudio/zai (omitted from body),
          // so the local-provider request is unchanged; serviceTier only for openrouter.
          temperature: openRouterTemperature,
          serviceTier: providerSlug === 'openrouter' ? serviceTier : undefined,
          // ChatGPT: forward fresh renderer tokens so the server resolves auth directly
          // (null for every other provider => omitted from the body).
          accessToken: chatgptServerAuth?.accessToken,
          accountId: chatgptServerAuth?.accountId,
          // Auto-compaction / context settings (previously dropped => server used defaults,
          // ignoring the user's disable toggle and the selected model's real context window).
          ...buildCompactionRequestParams(modelsData, modelName),
        })
        const result = await runServerChatLoop(
          {
            operation: 'edit',
            conversationId: String(conversationId),
            streamId,
            path,
            request: body,
            signal: controller.signal,
          },
          {
            dispatch,
            getState,
            onMessagePersisted: () => refreshHeimdallTreeFromState(getState, dispatch),
            onSeq: (seq, event) => {
              if (
                event.type !== 'permission_required' &&
                event.type !== 'clarify_required' &&
                event.type !== 'operation_mode_upgrade_required'
              )
                updateInflightStreamCursor(streamId, seq)
            },
          }
        )
        if (result.messageId) {
          void finishStreamingRun(streamId, {
            status: result.providerError ? 'error' : 'completed',
            endReason: result.providerError ? 'error' : 'completed',
            assistantMessageId: result.messageId,
            finalMessageId: result.messageId,
          })
          void markStreamUndoFinalMessage(streamId, String(result.messageId))
            .then(summary => {
              if (summary)
                dispatch(
                  chatSliceActions.streamUndoSummariesReceived({
                    conversationId: String(conversationId),
                    summaries: [summary],
                  })
                )
            })
            .catch(error => console.warn('[serverLoop] Failed to mark final message', error))
        }
        dispatch(chatSliceActions.sendingCompleted({ streamId }))
        setTimeout(() => dispatch(chatSliceActions.streamPruned({ streamId })), STREAM_PRUNE_DELAY)
        return { messageId: result.messageId, userMessage: result.userMessage, originalMessageId, streamId }
      }

      // Phase 6: the renderer is a pure thin client — there is no client-owned
      // fallback loop. Web mode is not a target; the server-owned loop requires the
      // local Electron server.
      throw new Error('The server-owned chat loop requires Electron.')
    } catch (error) {
      dispatch(chatSliceActions.sendingCompleted({ streamId }))

      if (error instanceof Error && error.name === 'AbortError') {
        return rejectWithValue('Message cancelled')
      }

      const message = error instanceof Error ? error.message : 'Failed to edit message'
      void finishStreamingRun(streamId, {
        status: error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'error',
        endReason:
          error instanceof Error && error.name === 'AbortError'
            ? 'aborted'
            : error instanceof Error && error.message.includes('context compaction')
              ? 'context_compaction_failed'
              : 'error',
        error: message,
      })
      dispatch(chatSliceActions.streamChunkReceived({ streamId, chunk: { type: 'error', error: message } }))
      return rejectWithValue(message)
    } finally {
      unregisterGenerationAbortController()
      if (!retainInflightMarkerOnReaderClose.delete(streamId)) removeInflightStream(streamId)
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
    {
      conversationId,
      parentId,
      content,
      modelOverride,
      think,
      serviceTier,
      cwd,
      operationMode: requestedOperationMode,
      streamId: providedStreamId,
    },
    { dispatch, getState, extra, rejectWithValue, signal }
  ) => {
    const { auth } = extra

    // Generate or use provided stream ID
    const streamId = providedStreamId ?? generateStreamId('branch')
    const preSendState = getState() as RootState
    const preSendDrafts = getDraftsForTarget(preSendState, { kind: 'branch', messageId: parentId })
    const preSendAttachmentsBase64 = preSendDrafts.length
      ? preSendDrafts.map(d => ({
        dataUrl: d.dataUrl,
        name: d.name,
        type: d.type,
        size: d.size,
        filePath: d.filePath,
        attachmentId: d.attachmentId,
        sha256: d.sha256,
      }))
      : null
    const preSendSelectedFilesForChat = preSendState.ideContext.selectedFilesForChat || []

    dispatch(
      chatSliceActions.sendingStarted({
        streamId,
        streamType: 'branch',
        conversationId,
        lineage: {
          lineageId: preSendState.chat.conversation.currentLineageId ?? undefined,
          rootMessageId: parentId,
        },
      })
    )
    void createStreamingRun({
      streamId,
      conversationId,
      parentMessageId: parentId ?? null,
      streamType: 'branch',
      operation: 'branch',
      source: 'renderer',
      lineage: { rootMessageId: parentId },
    })
    if (isResumableRunsEnabled()) {
      addInflightStream({
        streamId,
        conversationId: String(conversationId),
        streamType: 'branch',
        parentMessageId: parentId ?? null,
      })
    }

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
      const serverProvider =
        providerSlug === 'google' ? 'gemini' : /^(zai|glm|z\.ai)(\/glm)?$/.test(providerSlug) ? 'zai' : /^(bedrock|awsbedrock|aws-bedrock|amazonbedrock|amazon-bedrock)$/.test(providerSlug) ? 'bedrock' : providerSlug
      const openRouterTemperature = resolveOpenRouterTemperature(providerSlug)
      const isOpenAIChatGPT = providerSlug === 'openaichatgpt' || providerSlug === 'openai(chatgpt)'
      const attachmentsBase64 = await prepareLocalAttachmentsForModel(preSendAttachmentsBase64, 'image attachments')

      // Retrieve project and conversation context to send with branch message
      const selectedProject = selectSelectedProject(state)
      const projectContext = selectedProject?.context || null
      const conversationContextSource = state.conversations.convContext || null
      // Get selected files for chat captured before send start so UI can clear immediately
      const selectedFilesForChat = preSendSelectedFilesForChat

      const conversationMeta = state.conversations.items.find(c => c.id === conversationId)
      // Use React Query cache as fallback for storage mode detection (handles local conversations not yet in Redux)
      const storageMode = conversationMeta?.storage_mode || getStorageModeFromCache(extra.queryClient, conversationId)
      // Keep cwd for tool execution context only (do not inject cwd into system prompt)
      const operationModeAtSend = requestedOperationMode ?? state.chat.operationMode
      const payloadCwd = typeof cwd === 'string' ? cwd.trim() : (cwd ?? null)
      const effectiveToolRootPath = payloadCwd || conversationMeta?.cwd || state.ideContext.workspace?.rootPath || null

      // Determine execution mode
      const isElectronMode =
        import.meta.env.VITE_ENVIRONMENT === 'electron' || (typeof __IS_ELECTRON__ !== 'undefined' && __IS_ELECTRON__)

      // ── Server-owned chat loop (thin client) — branch ──
      // Every provider runs through the headless engine (Phase 6). Web mode is not a
      // target — the throw below covers the non-Electron path.
      if (isElectronMode) {
        // ChatGPT auth: resolve fresh {accessToken, accountId} from the renderer (auto-
        // refreshing) so the server uses them directly. null for every other provider.
        const chatgptServerAuth = isOpenAIChatGPT ? await getValidTokens() : null
        const { path, body } = buildServerLoopRequest('branch', {
          conversationId: String(conversationId),
          content,
          provider: serverProvider,
          modelName,
          userId: auth.userId,
          messageId: String(parentId),
          parentId: parentId ?? null,
          operationMode: operationModeAtSend,
          think,
          subagentReasoningEffort: getSubagentReasoningEffort(),
          rootPath: effectiveToolRootPath,
          conversationContext: conversationContextSource,
          projectContext,
          storageMode,
          attachmentsBase64,
          selectedFiles: selectedFilesForChat,
          tools: filterToolsForOperationMode(getAllTools(), operationModeAtSend),
          streamId,
          currentLineageId: state.chat.conversation.currentLineageId,
          toolAutoApprove: state.chat.toolAutoApprove,
          hooksEnabled: isElectronMode,
          localApiBase: getCachedLocalApiBase(),
          // Phase 4 openrouter parity: undefined for lmstudio/zai (omitted from body),
          // so the local-provider request is unchanged; serviceTier only for openrouter.
          temperature: openRouterTemperature,
          serviceTier: providerSlug === 'openrouter' ? serviceTier : undefined,
          // ChatGPT: forward fresh renderer tokens so the server resolves auth directly
          // (null for every other provider => omitted from the body).
          accessToken: chatgptServerAuth?.accessToken,
          accountId: chatgptServerAuth?.accountId,
          // Auto-compaction / context settings (previously dropped => server used defaults,
          // ignoring the user's disable toggle and the selected model's real context window).
          ...buildCompactionRequestParams(modelsData, modelName),
        })
        const result = await runServerChatLoop(
          {
            operation: 'branch',
            conversationId: String(conversationId),
            streamId,
            path,
            request: body,
            signal: controller.signal,
          },
          {
            dispatch,
            getState,
            onMessagePersisted: () => refreshHeimdallTreeFromState(getState, dispatch),
            onSeq: (seq, event) => {
              if (
                event.type !== 'permission_required' &&
                event.type !== 'clarify_required' &&
                event.type !== 'operation_mode_upgrade_required'
              )
                updateInflightStreamCursor(streamId, seq)
            },
          }
        )
        if (result.messageId) {
          void finishStreamingRun(streamId, {
            status: result.providerError ? 'error' : 'completed',
            endReason: result.providerError ? 'error' : 'completed',
            assistantMessageId: result.messageId,
            finalMessageId: result.messageId,
          })
          void markStreamUndoFinalMessage(streamId, String(result.messageId))
            .then(summary => {
              if (summary)
                dispatch(
                  chatSliceActions.streamUndoSummariesReceived({
                    conversationId: String(conversationId),
                    summaries: [summary],
                  })
                )
            })
            .catch(error => console.warn('[serverLoop] Failed to mark final message', error))
        }
        dispatch(chatSliceActions.sendingCompleted({ streamId }))
        setTimeout(() => dispatch(chatSliceActions.streamPruned({ streamId })), STREAM_PRUNE_DELAY)
        return { messageId: result.messageId, userMessage: result.userMessage, streamId }
      }

      // Phase 6: the renderer is a pure thin client — there is no client-owned
      // fallback loop. Web mode is not a target; the server-owned loop requires the
      // local Electron server.
      throw new Error('The server-owned chat loop requires Electron.')
    } catch (error) {
      dispatch(chatSliceActions.sendingCompleted({ streamId }))

      if (error instanceof Error && error.name === 'AbortError') {
        return rejectWithValue('Message cancelled')
      }

      const message = error instanceof Error ? error.message : 'Failed to send message'
      void finishStreamingRun(streamId, {
        status: error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'error',
        endReason:
          error instanceof Error && error.name === 'AbortError'
            ? 'aborted'
            : error instanceof Error && error.message.includes('context compaction')
              ? 'context_compaction_failed'
              : 'error',
        error: message,
      })
      dispatch(chatSliceActions.streamChunkReceived({ streamId, chunk: { type: 'error', error: message } }))
      return rejectWithValue(message)
    } finally {
      unregisterGenerationAbortController()
      if (!retainInflightMarkerOnReaderClose.delete(streamId)) removeInflightStream(streamId)
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
        // Fetch the source-of-truth conversation through the gateway (:3002), not Railway directly.
        conversation = await gwApi.get<Conversation>(`/conversations/${conversationId}`)
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
                project = await gwApi.get<any>(`/projects/${projectId}`)
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
>('chat/fetchMessageTree', async (payload, { dispatch, rejectWithValue, getState }) => {

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

    // Storage-aware fetch via the gateway (routes local vs cloud server-side).
    void storageMode
    response = await gwApi.get<{ messages: Message[]; tree: any }>(
      `/conversations/${conversationId}/messages/tree`
    )

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

      if (String(getState().chat.conversation.currentConversationId ?? '') !== String(conversationId)) {
        return response
      }
      dispatch(chatSliceActions.conversationSnapshotApplied({
        conversationId,
        messages: normalizedMessages,
        tree: buildConversationTree(normalizedMessages),
      }))

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

    // Snapshot messages and tree were installed atomically above. Empty legacy
    // responses still clear Heimdall only when this conversation remains current.
    if ((!messages || !Array.isArray(messages)) &&
        String(getState().chat.conversation.currentConversationId ?? '') === String(conversationId)) {
      dispatch(chatSliceActions.heimdallDataLoaded({ treeData }))
    }

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
>('chat/initializeConversationData', async (conversationId, { dispatch, rejectWithValue, getState }) => {

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
      gwApi.get<{ systemPrompt: string | null }>(`/conversations/${conversationId}/system-prompt`),
      gwApi.get<{ context: string | null }>(`/conversations/${conversationId}/context`),
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
  async ({ conversationId, messageId }, { getState, dispatch, rejectWithValue }) => {
    try {
      // Fetch direct children of the deleted message from the server
      const children = await gwApi.get<MessageId[]>(
        `/conversations/${conversationId}/messages/${messageId}/children`
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

      const conversation = await gwApi.post<{ id: ConversationId }>('/conversations', {
        userId: auth.userId,
        title: 'New Conversation',
        storageMode: 'local',
      })

      dispatch(
        chatSliceActions.initializationCompleted({ userId: String(auth.userId), conversationId: conversation.id })
      )
      return { userId: auth.userId, conversationId: conversation.id }
    }

    // Create test user (Railway-authoritative, via the cloud proxy)
    const user = await cloudApi.post<{ id: number }>('/users', { username: 'test-user' })

    // Create new conversation through the storage-aware gateway
    const conversation = await gwApi.post<{ id: ConversationId }>(`/conversations`, { userId: user.id })

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
  try {
    // Use storageMode passed from caller (most reliable) or fallback to cache lookup
    const effectiveStorageMode = storageMode ?? getStorageModeFromCache(extra.queryClient, conversationId)
    // Storage-aware bulk delete via the gateway (routes local vs cloud server-side).
    const response = await gwApi.post<{ deleted: number }>('/messages/deleteMany', {
      ids,
      conversationId,
      storageMode: effectiveStorageMode,
    })
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
  try {
    // Storage-aware title update via the gateway. Pass the authoritative storageMode
    // hint (Chat.tsx already supplies it) so a cloud conversation is never misrouted
    // to the local leg by a stale/ambiguous local mirror row.
    const mode = storageMode || getState().conversations.items.find(c => c.id === id)?.storage_mode
    const qs = mode ? `?storageMode=${mode}` : ''
    const updated = await gwApi.patch<Conversation>(`/conversations/${id}${qs}`, { title })
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
>('chat/uploadAttachment', async ({ file, messageId }, { dispatch, rejectWithValue }) => {
  try {
    const form = new FormData()
    form.append('file', file)
    if (messageId != null) form.append('messageId', String(messageId))

    // Routed through the storage-aware gateway (:3002/api/gw/attachments). The
    // multipart body is forwarded to Railway verbatim; messageId rides the query
    // string so the server can mirror/link the result without parsing the body.
    const qs = messageId != null ? `?messageId=${encodeURIComponent(String(messageId))}` : ''
    const attachment = await gwApi.post<Attachment>(`/attachments${qs}`, form)

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
>('chat/linkAttachmentsToMessage', async ({ messageId, attachmentIds }, { dispatch, rejectWithValue }) => {
  try {
    const attachments = await gwApi.post<Attachment[]>(`/messages/${messageId}/attachments`, { attachmentIds })

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
>('chat/fetchAttachmentsByMessage', async ({ messageId }, { dispatch, rejectWithValue }) => {
  try {
    const attachments = await gwApi.get<Attachment[]>(`/messages/${messageId}/attachments`)
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
>('chat/deleteAttachmentsByMessage', async ({ messageId }, { dispatch, rejectWithValue }) => {
  try {
    const result = await gwApi.delete<{ deleted: number }>(`/messages/${messageId}/attachments`)
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
  async ({ id }, { dispatch, rejectWithValue }) => {
    try {
      const attachment = await gwApi.get<Attachment>(`/attachments/${id}`)
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

// Abort local generation (including subagent runs) and optionally stop server streaming
export const abortGeneration = createAsyncThunk<
  void,
  { streamId?: string | null; messageId?: MessageId | null },
  { state: RootState }
>('chat/abortGeneration', async ({ streamId }, { dispatch }) => {
  abortSubagentControllers(streamId)

  // Under resumable runs a bare socket close only DETACHES (the run keeps going), so an
  // explicit Stop must cancel the server-owned run via POST /api/streams/:id/abort.
  // Fire it BEFORE tearing down the local reader. Best-effort (never throws).
  const records = streamId ? listInflightStreams().filter(rec => rec.streamId === streamId) : listInflightStreams()
  const streamIds = streamId ? [streamId] : records.map(rec => rec.streamId)
  let serverAbortSucceeded = !isResumableRunsEnabled()

  try {
    if (isResumableRunsEnabled()) {
      const results = await Promise.all(streamIds.map(async id => ({ id, ok: await postStreamAbort(id) })))
      serverAbortSucceeded = results.every(result => result.ok)
      for (const result of results) {
        if (!result.ok && hasGenerationReader(result.id)) retainInflightMarkerOnReaderClose.add(result.id)
      }
    }
  } finally {
    // Close local readers only after every server abort request has settled. If a request
    // failed, retain its marker so a later Chat mount can reconcile the unknown live run.
    abortGenerationControllers(streamId)

    if (streamId) {
      dispatch(chatSliceActions.streamingAborted({ streamId }))
      void finishStreamingRun(streamId, { status: 'aborted', endReason: 'aborted', error: 'Generation aborted' })
      if (serverAbortSucceeded) removeInflightStream(streamId)
    } else {
      dispatch(chatSliceActions.allStreamsAborted())
      if (serverAbortSucceeded) for (const rec of records) removeInflightStream(rec.streamId)
    }
  }
})

/**
 * Detach/reattach: after a reload, re-attach to any server-owned runs this renderer
 * started but never saw finish (tracked in localStorage across the reload). For each,
 * rebuild the stream slot (sendingStarted) and replay from the server by streamId. A
 * run the server no longer has (410) clears its marker; persisted messages already
 * loaded reflect the true state. No-op unless resumable runs are enabled.
 */
export const resumeInFlightStreams = createAsyncThunk<
  void,
  { conversationId: string },
  { state: RootState }
>('chat/resumeInFlightStreams', async ({ conversationId }, { dispatch, getState }) => {
  if (!isResumableRunsEnabled()) return
  const records = listInflightStreams(String(conversationId))
  for (const rec of records) {
    // Route remounts must not replace the module-level reader that survived the Chat
    // unmount. RunSession attach is last-writer-wins, so ownership is checked per stream.
    if (hasGenerationReader(rec.streamId)) continue

    const controller = new AbortController()
    const unregister = registerGenerationAbortController(rec.streamId, controller)
    dispatch(
      chatSliceActions.sendingStarted({
        streamId: rec.streamId,
        streamType: rec.streamType,
        conversationId: rec.conversationId,
        lineage: { rootMessageId: rec.parentMessageId ?? undefined },
      })
    )
    try {
      const result = await runServerReattach(
        {
          streamId: rec.streamId,
          conversationId: rec.conversationId,
          operation: rec.streamType === 'branch' ? 'branch' : 'send',
          fromSeq: rec.lastSeq ?? 0,
          signal: controller.signal,
        },
        {
          dispatch,
          getState,
          onMessagePersisted: () => refreshHeimdallTreeFromState(getState, dispatch),
          onSeq: (seq, event) => {
            if (
              event.type !== 'permission_required' &&
              event.type !== 'clarify_required' &&
              event.type !== 'operation_mode_upgrade_required'
            )
              updateInflightStreamCursor(rec.streamId, seq)
          },
        }
      )
      if (result.gone) dispatch(chatSliceActions.streamingAborted({ streamId: rec.streamId }))
      if (result.gone || result.terminal) removeInflightStream(rec.streamId)
    } catch {
      // Retain the marker after transient failures so a later route mount can retry.
    } finally {
      dispatch(chatSliceActions.sendingCompleted({ streamId: rec.streamId }))
      unregister()
    }
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
      source_id?: string
      parent_source_id?: string | null
      role: Message['role']
      content: string
      thinking_block?: string
      model_name?: string
      tool_calls?: string | any
      note?: string
      note_color?: string | null
      content_blocks?: any
    }>
    storageMode?: 'local' | 'cloud' // Optional: explicitly set storage mode (useful for newly created conversations)
  },
  { extra: ThunkExtraArgument }
>('chat/insertBulkMessages', async ({ conversationId, messages, storageMode }, { rejectWithValue }) => {
  try {
    void storageMode
    // Storage-aware bulk insert via the gateway (routes local vs cloud; mirrors cloud writes).
    const response = await gwApi.post<{ messages: Message[] }>(
      `/conversations/${conversationId}/messages/bulk`,
      { messages }
    )
    return response.messages
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to insert bulk messages'
    return rejectWithValue(message)
  }
})

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

/**
 * POST a decision to the server-owned loop's /api/resume (Phase 2). Errors
 * (404/409 = no pending / already resolved, or network) are swallowed so a
 * stale click never crashes the UI.
 */
const postDecisionResume = async (
  body: { streamId: string; toolCallId: string } & Record<string, unknown>
): Promise<void> => {
  try {
    const url = await buildLocalApiUrl('/resume')
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  } catch (error) {
    console.warn('[serverLoop] /resume failed', error)
  }
}

export const respondToToolPermission = createAsyncThunk<void, boolean, { state: RootState; extra: ThunkExtraArgument }>(
  'chat/respondToToolPermission',
  async (allowed, { dispatch, getState }) => {
    const req = getState().chat.toolCallPermissionRequest
    if (req?.streamId && req?.toolCallId) {
      // Server-owned loop: resolve the paused decision over /resume.
      await postDecisionResume({ streamId: req.streamId, toolCallId: req.toolCallId, decision: allowed ? 'allow_once' : 'deny' })
    }
    dispatch(chatSliceActions.toolPermissionResponded())
  }
)

export const respondToOperationModeUpgrade = createAsyncThunk<
  void,
  boolean,
  { state: RootState; extra: ThunkExtraArgument }
>('chat/respondToOperationModeUpgrade', async (approved, { dispatch, getState }) => {
  const req = getState().chat.operationModeUpgradeRequest
  if (approved) dispatch(chatSliceActions.operationModeSet('execute'))
  if (req?.streamId && req?.toolCallId) {
    await postDecisionResume({
      streamId: req.streamId,
      toolCallId: req.toolCallId,
      decision: approved ? 'switch_to_execute' : 'deny',
    })
  }
  dispatch(chatSliceActions.operationModeUpgradeResponded())
})

export const respondToPlanClarification = createAsyncThunk<
  void,
  PlanClarificationAnswer[],
  { state: RootState; extra: ThunkExtraArgument }
>('chat/respondToPlanClarification', async (answers, { dispatch, getState }) => {
  const req = getState().chat.planClarificationRequest
  if (req?.streamId && req?.toolCallId) {
    await postDecisionResume({ streamId: req.streamId, toolCallId: req.toolCallId, answers })
  }
  dispatch(chatSliceActions.planClarificationResponded())
})

export const cancelPlanClarification = createAsyncThunk<void, void, { state: RootState; extra: ThunkExtraArgument }>(
  'chat/cancelPlanClarification',
  async (_, { dispatch, getState }) => {
    const req = getState().chat.planClarificationRequest
    if (req?.streamId && req?.toolCallId) {
      await postDecisionResume({ streamId: req.streamId, toolCallId: req.toolCallId, cancelled: true })
    }
    dispatch(chatSliceActions.planClarificationResponded())
  }
)

export const respondToToolPermissionAndEnableAll = createAsyncThunk<
  void,
  void,
  { state: RootState; extra: ThunkExtraArgument }
>('chat/respondToToolPermissionAndEnableAll', async (_, { dispatch, getState }) => {
  // Enable auto-approve mode for all future tools; the server path relies on the
  // allow_always decision forwarded below.
  dispatch(chatSliceActions.toolAutoApproveEnabled())

  const req = getState().chat.toolCallPermissionRequest
  if (req?.streamId && req?.toolCallId) {
    await postDecisionResume({ streamId: req.streamId, toolCallId: req.toolCallId, decision: 'allow_always' })
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
    void accessToken
    const prompts = await cloudApi.get<any[]>('/system-prompts')
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

export const fetchConversationStreamUndo = createAsyncThunk<
  void,
  ConversationId | string,
  { state: RootState }
>('chat/fetchConversationStreamUndo', async (conversationId, { dispatch }) => {
  const id = String(conversationId)
  dispatch(chatSliceActions.streamUndoConversationLoadingSet({ conversationId: id, loading: true }))
  try {
    const summaries = await fetchConversationUndoSummaries(id)
    dispatch(chatSliceActions.streamUndoSummariesReceived({ conversationId: id, summaries }))
  } catch (error) {
    console.warn('[streamUndo] Failed to fetch conversation undo summaries', error)
    dispatch(chatSliceActions.streamUndoSummariesReceived({ conversationId: id, summaries: [] }))
  } finally {
    dispatch(chatSliceActions.streamUndoConversationLoadingSet({ conversationId: id, loading: false }))
  }
})

export const restoreStreamFileEdits = createAsyncThunk<
  void,
  { streamId: string; conversationId?: ConversationId | string | null; parentMessageId?: MessageId | string | null; force?: boolean },
  { state: RootState }
>('chat/restoreStreamFileEdits', async ({ streamId, conversationId, parentMessageId, force }, { dispatch, getState }) => {
  dispatch(chatSliceActions.streamUndoRestoringSet({ streamId, restoring: true }))
  dispatch(chatSliceActions.streamUndoErrorSet({ streamId, error: null }))
  try {
    const result = await restoreStreamUndoApi(streamId, {
      force,
      expectedParentMessageId: parentMessageId != null ? String(parentMessageId) : null,
    })
    if (!result.success) {
      const conflictText = Array.isArray(result.conflicts) && result.conflicts.length > 0 ? ' File changed after the agent edit.' : ''
      throw new Error((result.error || 'Failed to restore file edits') + conflictText)
    }
    const currentConversationId = conversationId ?? getState().chat.conversation.currentConversationId
    if (currentConversationId != null) {
      const summaries = await fetchConversationUndoSummaries(String(currentConversationId))
      dispatch(chatSliceActions.streamUndoSummariesReceived({ conversationId: String(currentConversationId), summaries }))
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    dispatch(chatSliceActions.streamUndoErrorSet({ streamId, error: message }))
    throw error
  } finally {
    dispatch(chatSliceActions.streamUndoRestoringSet({ streamId, restoring: false }))
  }
})
