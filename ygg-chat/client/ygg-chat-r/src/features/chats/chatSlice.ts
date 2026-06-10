import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import providersList from '../../../../../shared/providers.json'
import { ConversationId, MessageId } from '../../../../../shared/types'
import { isCommunityMode } from '../../config/runtimeMode'
import { parseId } from '../../utils/helpers'

import {
  Attachment,
  ChatState,
  ImageDraft,
  Message,
  MessageInput,
  OperationMode,
  SendingStartedPayload,
  StreamChunkPayload,
  StreamCompletedPayload,
  StreamingAbortedPayload,
  StreamState,
  ToolCallPermissionRequest,
  UserSystemPrompt,
} from './chatTypes'
import { createEmptyStreamState, DEFAULT_STREAM_ID } from './streamHelpers'
import toolDefinitions, { ToolDefinition } from './toolDefinitions'

// Helper to deep clone tool definitions for mutable Redux state
const cloneTools = (tools: ToolDefinition[]): ToolDefinition[] =>
  tools.map(t => ({
    ...t,
    inputSchema: {
      ...t.inputSchema,
      properties: { ...t.inputSchema.properties },
      required: t.inputSchema.required ? [...t.inputSchema.required] : undefined,
    },
  }))

const isElectronEnvironment =
  (typeof __IS_ELECTRON__ !== 'undefined' && __IS_ELECTRON__) || import.meta.env.VITE_ENVIRONMENT === 'electron'

const webHiddenProviders = new Set(['OpenAI (ChatGPT)', 'LM Studio', 'Z.AI / GLM', 'Amazon Bedrock'])
const communityAllowedProviders = new Set(['LM Studio', 'OpenAI (ChatGPT)', 'OpenRouter', 'Z.AI / GLM'])

const getAvailableProviders = () => {
  const allProviders = Object.values(providersList.providers)
  if (isElectronEnvironment) {
    if (isCommunityMode) {
      return allProviders.filter(provider => communityAllowedProviders.has(provider.name))
    }
    return allProviders
  }
  return allProviders.filter(provider => !webHiddenProviders.has(provider.name))
}

const getInitialProvider = (providers: Array<{ name: string }>) => {
  const stored = localStorage.getItem('currentProvider')
  if (!stored) {
    return null
  }
  return providers.some(provider => provider.name === stored) ? stored : null
}

// Helper function to build path from root to a message
const buildPathToMessage = (messages: Message[], messageId: MessageId): MessageId[] => {
  const path: MessageId[] = []
  let currentId: MessageId | null = messageId
  while (currentId !== null) {
    path.unshift(currentId)
    const message = messages.find(m => m.id === currentId)
    currentId = message?.parent_id ?? null
  }
  return path
}

// Helper to check if a message is on the current branch
const isOnCurrentBranch = (currentPath: MessageId[], messages: Message[], messageId: MessageId): boolean => {
  if (currentPath.length === 0) return true
  const messagePath = buildPathToMessage(messages, messageId)
  // Check if the message's path shares the same prefix as current path
  const minLen = Math.min(currentPath.length, messagePath.length)
  for (let i = 0; i < minLen; i++) {
    if (currentPath[i] !== messagePath[i]) return false
  }
  return true
}

// Helper to keep the visible conversation buffer scoped to the currently selected conversation.
const isMessageForCurrentConversation = (
  state: ChatState,
  message: Pick<Message, 'id' | 'parent_id'> & { conversation_id?: ConversationId | string | null }
): boolean => {
  const currentConversationId = state.conversation.currentConversationId
  if (currentConversationId == null) return true

  if (message.conversation_id != null) {
    return String(message.conversation_id) === String(currentConversationId)
  }

  if (state.conversation.messages.some(existing => String(existing.id) === String(message.id))) {
    return true
  }

  if (message.parent_id != null) {
    return state.conversation.messages.some(existing => String(existing.id) === String(message.parent_id))
  }

  return false
}

// Helper to get or create stream state with fallback
const getOrCreateStream = (state: ChatState, streamId: string): StreamState => {
  if (!state.streaming.byId[streamId]) {
    state.streaming.byId[streamId] = createEmptyStreamState('primary')
  }
  return state.streaming.byId[streamId]
}

const makeInitialState = (): ChatState => {
  const availableProviders = getAvailableProviders()

  return {
    providerState: {
      providers: availableProviders,
      currentProvider: getInitialProvider(availableProviders),
      loading: false,
      error: null,
    },
    composition: {
      input: {
        content: '',
        modelOverride: undefined,
      },
      sending: false,
      compacting: false,
      compactingConversationId: null,
      validationError: null,
      draftMessage: null,
      multiReplyCount: 1,
      imageDrafts: [],
      editingBranch: false,
      optimisticMessage: null,
      optimisticBranchMessage: null,
    },
    // Multi-stream state container
    streaming: {
      activeIds: [],
      byId: {},
      primaryStreamId: null,
      lastCompletedId: null,
    },
    ui: {
      modelSelectorOpen: false,
    },
    conversation: {
      currentConversationId: null,
      focusedChatMessageId: null,
      currentPath: [],
      messages: [],
      bookmarked: [],
      excludedMessages: [],
      context: '',
      ccCwd: '',
    },
    heimdall: {
      treeData: null,
      subagentMap: {},
      loading: false,
      error: null,
      compactMode: false,
      lastFetchedAt: null,
      lastConversationId: null,
    },
    initialization: {
      loading: false,
      error: null,
      userId: null,
    },
    selectedNodes: [],
    attachments: {
      byMessage: {},
      backup: {},
    },
    tools: cloneTools(toolDefinitions),
    toolCallPermissionRequest: null,
    planClarificationRequest: null,
    toolAutoApprove: false,
    operationMode: 'plan',
    ccSlashCommands: [],
    freeTier: {
      freeGenerationsRemaining: null,
      showLimitModal: false,
      isFreeTierUser: false,
    },
    userSystemPrompts: {
      prompts: [],
      loading: false,
      error: null,
    },
  }
}

const initialState: ChatState = makeInitialState()

export const chatSlice = createSlice({
  name: 'chat',
  initialState,
  reducers: {
    //provider management
    providerSelected: (state, action: PayloadAction<string>) => {
      if (!state.providerState.providers.some(provider => provider.name === action.payload)) {
        return
      }
      state.providerState.currentProvider = action.payload
      localStorage.setItem('currentProvider', action.payload)
    },
    // Composition - validation integrated
    inputChanged: (state, action: PayloadAction<Partial<MessageInput>>) => {
      Object.assign(state.composition.input, action.payload)

      // Immediate validation
      const content = state.composition.input.content.trim()
      if (content.length === 0) {
        state.composition.validationError = null
      } else if (content.length > 1000000) {
        state.composition.validationError = 'Message too long'
      } else {
        state.composition.validationError = null
      }
    },

    inputCleared: state => {
      state.composition.input = initialState.composition.input
      state.composition.validationError = null
      state.composition.imageDrafts = []
    },

    imageDraftsAppended: (state, action: PayloadAction<ImageDraft[]>) => {
      const existing = new Set(state.composition.imageDrafts.map(d => d.dataUrl))
      for (const draft of action.payload) {
        if (!existing.has(draft.dataUrl)) {
          state.composition.imageDrafts.push(draft)
          existing.add(draft.dataUrl)
        }
      }
    },
    imageDraftsCleared: state => {
      state.composition.imageDrafts = []
    },
    imageDraftRemoved: (state, action: PayloadAction<number>) => {
      const index = action.payload
      if (index >= 0 && index < state.composition.imageDrafts.length) {
        state.composition.imageDrafts.splice(index, 1)
      }
    },

    // Branch editing flag
    editingBranchSet: (state, action: PayloadAction<boolean>) => {
      state.composition.editingBranch = action.payload
    },

    compactingStarted: (state, action: PayloadAction<{ conversationId?: ConversationId | null } | undefined>) => {
      state.composition.compacting = true
      state.composition.compactingConversationId =
        action.payload?.conversationId ?? state.conversation.currentConversationId ?? null
    },

    compactingFinished: state => {
      state.composition.compacting = false
      state.composition.compactingConversationId = null
    },

    sendingStarted: (state, action: PayloadAction<SendingStartedPayload | undefined>) => {
      const streamId = action.payload?.streamId ?? DEFAULT_STREAM_ID
      const streamType = action.payload?.streamType ?? 'primary'
      const conversationId = action.payload?.conversationId ?? state.conversation.currentConversationId ?? null
      const lineage = action.payload?.lineage ?? {}

      // Create new stream state
      state.streaming.byId[streamId] = {
        ...createEmptyStreamState(streamType, lineage),
        active: true,
        status: 'active',
        conversationId,
      }

      // Add to active list (dedupe)
      if (!state.streaming.activeIds.includes(streamId)) {
        state.streaming.activeIds.push(streamId)
      }

      // Set as primary if it's the main stream
      if (streamType === 'primary') {
        state.streaming.primaryStreamId = streamId
      }

      // Legacy: Keep composition.sending in sync for primary streams
      if (streamType === 'primary') {
        state.composition.sending = true
        state.composition.input.content = ''
      }

      if (streamType === 'primary' || streamType === 'branch') {
        state.composition.imageDrafts = []
      }
    },

    sendingCompleted: (state, action: PayloadAction<{ streamId: string } | undefined>) => {
      const streamId = action.payload?.streamId ?? DEFAULT_STREAM_ID
      const stream = state.streaming.byId[streamId]

      if (stream) {
        stream.active = false
        stream.status = 'completed'
        stream.finished = true
        stream.liveMessageId = null
        stream.finalMessageId = stream.messageId
        stream.streamingMessageId = null

        // Remove from active list
        state.streaming.activeIds = state.streaming.activeIds.filter(id => id !== streamId)

        // Legacy sync for primary streams
        if (stream.streamType === 'primary') {
          state.composition.sending = false
          state.composition.imageDrafts = []
        }

        // Clear primary if this was the primary stream
        if (state.streaming.primaryStreamId === streamId) {
          state.streaming.primaryStreamId = null
        }
      } else {
        // Fallback for backward compatibility when no stream exists
        state.composition.sending = false
        state.composition.imageDrafts = []
      }
    },

    streamingAborted: (state, action: PayloadAction<StreamingAbortedPayload | undefined>) => {
      const streamId = action.payload?.streamId ?? DEFAULT_STREAM_ID
      const error = action.payload?.error ?? 'Generation aborted'
      const stream = state.streaming.byId[streamId]

      if (stream) {
        stream.active = false
        stream.status = 'aborting'
        stream.error = error
        stream.liveMessageId = null
        stream.streamingMessageId = null

        // Remove from active list
        state.streaming.activeIds = state.streaming.activeIds.filter(id => id !== streamId)

        // Legacy sync for primary streams
        if (stream.streamType === 'primary') {
          state.composition.sending = false
        }

        // Clear primary if this was the primary stream
        if (state.streaming.primaryStreamId === streamId) {
          state.streaming.primaryStreamId = null
        }
      } else {
        // Fallback for backward compatibility
        state.composition.sending = false
      }
    },

    // Abort all active streams at once
    allStreamsAborted: state => {
      for (const streamId of state.streaming.activeIds) {
        const stream = state.streaming.byId[streamId]
        if (stream) {
          stream.active = false
          stream.status = 'aborting'
          stream.error = 'Generation aborted'
          stream.liveMessageId = null
          stream.streamingMessageId = null
        }
      }
      state.streaming.activeIds = []
      state.streaming.primaryStreamId = null
      state.composition.sending = false
    },

    // Streaming - optimized buffer management with sequential event logging
    // Supports both legacy (StreamChunk) and new (StreamChunkPayload with streamId) formats
    streamChunkReceived: (state, action: PayloadAction<StreamChunkPayload | any>) => {
      // Handle both old format (just chunk) and new format (with streamId)
      const hasStreamId = action.payload && 'streamId' in action.payload && 'chunk' in action.payload
      const streamId = hasStreamId ? action.payload.streamId : DEFAULT_STREAM_ID
      const chunk = hasStreamId ? action.payload.chunk : action.payload

      // Get or create the target stream
      const stream = getOrCreateStream(state, streamId)

      if (chunk.type !== 'reset' && !stream.active) {
        // Late chunks can arrive after abort/completion. Do not let them mutate
        // visible branch state after the stream has left the in-flight set.
        stream.suppressedEventCount = (stream.suppressedEventCount ?? 0) + 1
        return
      }

      if (chunk.type === 'reset') {
        stream.status = stream.active ? 'active' : 'idle'
        stream.buffer = ''
        stream.thinkingBuffer = ''
        stream.toolCalls = []
        stream.events = []
        stream.error = null
        stream.messageId = null
        stream.liveMessageId = null
        stream.lastCompletedMessageId = null
        stream.finalMessageId = null
        stream.streamingMessageId = null
        return
      }

      if (chunk.type === 'generation_started') {
        stream.active = true
        stream.status = 'active'
        stream.error = null
        stream.liveMessageId = chunk.messageId || null
        stream.streamingMessageId = chunk.messageId || null
        // Keep messageId/lastCompletedMessageId as branch anchors. Chat.tsx uses
        // liveMessageId/streamingMessageId for duplicate suppression instead.
        // Clear previous turn's transient render buffers for the new live answer.
        stream.events = []
        stream.buffer = ''
        stream.thinkingBuffer = ''
        stream.toolCalls = []
      } else if (chunk.type === 'chunk') {
        if (chunk.part === 'reasoning') {
          const delta = chunk.delta ?? chunk.content ?? ''
          stream.thinkingBuffer += delta
          // Log reasoning delta immediately so it appears during streaming
          stream.events.push({
            type: 'reasoning',
            delta,
          })
        } else if (chunk.part === 'tool_call') {
          // Handle structured tool call data (supports both legacy and new formats)
          if (chunk.toolCall) {
            const existingIndex = stream.toolCalls.findIndex(tc => tc.id === chunk.toolCall!.id)
            if (existingIndex >= 0) {
              stream.toolCalls[existingIndex] = chunk.toolCall
            } else {
              stream.toolCalls.push(chunk.toolCall)
            }

            const existingEventIndex = stream.events.findIndex(
              e => e.type === 'tool_call' && e.toolCall?.id === chunk.toolCall!.id
            )

            if (existingEventIndex >= 0) {
              stream.events[existingEventIndex].toolCall = chunk.toolCall
            } else {
              stream.events.push({
                type: 'tool_call',
                toolCall: chunk.toolCall,
                complete: true,
              })
            }
          }
        } else if (chunk.part === 'tool_result') {
          // Handle tool result events during streaming. Upsert instead of ignoring
          // duplicates so a final/updated result replaces any earlier placeholder
          // and becomes visible immediately in Chat.tsx.
          if (chunk.toolResult) {
            const existingEventIndex = stream.events.findIndex(
              e => e.type === 'tool_result' && e.toolResult?.tool_use_id === chunk.toolResult!.tool_use_id
            )

            const nextToolResultEvent = {
              type: 'tool_result' as const,
              toolResult: chunk.toolResult,
              complete: true,
            }

            if (existingEventIndex >= 0) {
              stream.events[existingEventIndex] = nextToolResultEvent
            } else {
              stream.events.push(nextToolResultEvent)
            }
          }
        } else if (chunk.part === 'image') {
          // Handle image events from image generation models
          // Check for duplicates before adding
          const imageExists = stream.events.some(e => e.type === 'image' && e.url === chunk.url)

          if (!imageExists) {
            stream.events.push({
              type: 'image',
              url: chunk.url,
              mimeType: chunk.mimeType || 'image/png',
              complete: true,
            })
          }
        } else {
          const delta = chunk.delta ?? chunk.content ?? ''
          stream.buffer += delta
          // Log text deltas as they come (text is typically streamed token by token)
          stream.events.push({
            type: 'text',
            delta,
          })
        }
      } else if (chunk.type === 'tool_call') {
        // Handle legacy tool_call format (chunk.type === 'tool_call' directly)
        if (chunk.toolCall) {
          const existingIndex = stream.toolCalls.findIndex(tc => tc.id === chunk.toolCall!.id)
          if (existingIndex >= 0) {
            stream.toolCalls[existingIndex] = chunk.toolCall
          } else {
            stream.toolCalls.push(chunk.toolCall)
          }

          const existingEventIndex = stream.events.findIndex(
            e => e.type === 'tool_call' && e.toolCall?.id === chunk.toolCall!.id
          )

          if (existingEventIndex >= 0) {
            stream.events[existingEventIndex].toolCall = chunk.toolCall
          } else {
            stream.events.push({
              type: 'tool_call',
              toolCall: chunk.toolCall,
              complete: true,
            })
          }
        }
      } else if (chunk.type === 'complete') {
        const completedMessageId = chunk.message?.id || null
        stream.messageId = completedMessageId
        stream.lastCompletedMessageId = completedMessageId
        if (completedMessageId) {
          stream.branchAnchorMessageId = completedMessageId
        }
        stream.liveMessageId = null
        stream.streamingMessageId = null
        const completedMessage = chunk.message as any
        const hasToolCalls =
          (Array.isArray(completedMessage?.tool_calls) && completedMessage.tool_calls.length > 0) ||
          (Array.isArray(completedMessage?.content_blocks) &&
            completedMessage.content_blocks.some((block: any) => block?.type === 'tool_use'))
        stream.status = hasToolCalls ? 'waiting_for_tool' : 'active'
        // Do NOT set active=false here. Wait for explicit streamCompleted action.
        // This is crucial for multi-turn loops where 'complete' chunks arrive per turn.
      } else if (chunk.type === 'error') {
        stream.error = chunk.error || 'Unknown stream error'
        stream.status = 'error'
        stream.active = false
        stream.liveMessageId = null
        stream.streamingMessageId = null

        // Remove from active list
        state.streaming.activeIds = state.streaming.activeIds.filter(id => id !== streamId)

        // Clear primary if this was the primary stream
        if (state.streaming.primaryStreamId === streamId) {
          state.streaming.primaryStreamId = null
        }
      }
    },

    streamCompleted: (state, action: PayloadAction<StreamCompletedPayload | { messageId: MessageId }>) => {
      // Handle both old format (just messageId) and new format (with streamId and updatePath)
      const hasStreamId = 'streamId' in action.payload
      const streamId = hasStreamId ? (action.payload as StreamCompletedPayload).streamId : DEFAULT_STREAM_ID
      const messageId = action.payload.messageId
      const updatePath = hasStreamId ? ((action.payload as StreamCompletedPayload).updatePath ?? true) : true

      const stream = state.streaming.byId[streamId]

      if (stream) {
        // Mark stream as complete
        stream.active = false
        stream.status = 'completed'
        stream.finished = true
        stream.messageId = messageId
        stream.lastCompletedMessageId = messageId
        stream.finalMessageId = messageId
        stream.liveMessageId = null
        stream.streamingMessageId = null

        // Remove from active list
        state.streaming.activeIds = state.streaming.activeIds.filter(id => id !== streamId)

        // Update last completed
        state.streaming.lastCompletedId = streamId

        // CRITICAL: Only update currentPath if explicitly requested AND conditions are met
        if (updatePath) {
          const shouldUpdatePath =
            state.conversation.currentPath.length === 0 ||
            isOnCurrentBranch(state.conversation.currentPath, state.conversation.messages, messageId)

          if (shouldUpdatePath) {
            const exists = state.conversation.messages.some(m => m.id === messageId)
            if (exists) {
              state.conversation.currentPath = buildPathToMessage(state.conversation.messages, messageId)
            }
          }
        }

        // Clear primary if this was the primary stream
        if (state.streaming.primaryStreamId === streamId) {
          state.streaming.primaryStreamId = null
        }

        // Legacy: Keep composition.sending in sync for primary streams
        if (stream.streamType === 'primary') {
          state.composition.sending = false
        }
      } else {
        // Fallback for backward compatibility when using old format without stream
        const exists = state.conversation.messages.some(m => m.id === messageId)
        if (exists && updatePath) {
          state.conversation.currentPath = buildPathToMessage(state.conversation.messages, messageId)
        }
        state.composition.sending = false
      }
    },

    // Garbage collection: remove a finished stream from byId
    streamPruned: (state, action: PayloadAction<{ streamId: string }>) => {
      const { streamId } = action.payload

      // Remove from byId
      delete state.streaming.byId[streamId]

      // Clean up activeIds (should already be removed, but safety)
      state.streaming.activeIds = state.streaming.activeIds.filter(id => id !== streamId)

      // Clear lastCompletedId if it matches
      if (state.streaming.lastCompletedId === streamId) {
        state.streaming.lastCompletedId = null
      }
    },

    // Update stream lineage after getting target parent ID
    // This is called when we know the actual parent of the streaming message
    streamLineageUpdated: (state, action: PayloadAction<{ streamId: string; targetParentId: MessageId }>) => {
      const { streamId, targetParentId } = action.payload
      const stream = state.streaming.byId[streamId]
      if (stream) {
        stream.lineage.rootMessageId = targetParentId
        stream.branchAnchorMessageId = targetParentId
      }
    },

    // UI - minimal
    modelSelectorToggled: state => {
      state.ui.modelSelectorOpen = !state.ui.modelSelectorOpen
    },

    conversationSet: (state, action: PayloadAction<ConversationId>) => {
      state.conversation.currentConversationId = action.payload
    },

    conversationCleared: state => {
      state.conversation.currentConversationId = null
      state.conversation.messages = []
      state.conversation.currentPath = []
      state.conversation.ccCwd = ''
    },

    nodesSelected: (state, action: PayloadAction<MessageId[]>) => {
      state.selectedNodes = action.payload
    },

    focusedChatMessageSet: (state, action: PayloadAction<MessageId>) => {
      state.conversation.focusedChatMessageId = action.payload
    },

    messageAdded: (state, action: PayloadAction<Message>) => {
      const m = action.payload
      if (!isMessageForCurrentConversation(state, m)) {
        return
      }

      const existing = state.conversation.messages.findIndex(x => x.id === m.id)
      if (existing >= 0) {
        state.conversation.messages[existing] = m
      } else {
        state.conversation.messages.push(m)
      }
    },

    messagesCleared: state => {
      state.conversation.messages = []
    },

    messageUpdated: (
      state,
      action: PayloadAction<{ id: MessageId; content: string; note?: string; note_color?: string | null; content_blocks?: any }>
    ) => {
      const { id, content, note, note_color, content_blocks } = action.payload
      const msg = state.conversation.messages.find(m => m.id === id)
      if (msg) {
        msg.content = content
        if (note !== undefined) msg.note = note
        if (note_color !== undefined) msg.note_color = note_color
        if (content_blocks) msg.content_blocks = content_blocks
      }
    },

    messageDeleted: (state, action: PayloadAction<MessageId>) => {
      const id = action.payload
      state.conversation.messages = state.conversation.messages.filter(m => m.id !== id)
    },

    messagesLoaded: (state, action: PayloadAction<Message[]>) => {
      // Preserve already-loaded artifacts when a refetch returns messages before
      // attachment hydration completes (common in local mode right after branch/send).
      const existingArtifactsById = new Map<MessageId, string[]>()
      for (const message of state.conversation.messages) {
        if (Array.isArray(message.artifacts) && message.artifacts.length > 0) {
          existingArtifactsById.set(message.id, message.artifacts)
        }
      }

      state.conversation.messages = action.payload.map(message => {
        const hasIncomingArtifacts = Array.isArray(message.artifacts) && message.artifacts.length > 0
        if (hasIncomingArtifacts) return message

        const messageWithAttachmentMeta = message as Message & {
          has_attachments?: boolean
          attachments_count?: number
        }
        const explicitlyNoAttachments =
          messageWithAttachmentMeta.has_attachments === false ||
          (typeof messageWithAttachmentMeta.attachments_count === 'number' &&
            messageWithAttachmentMeta.attachments_count === 0)
        if (explicitlyNoAttachments) return message

        const preservedArtifacts = existingArtifactsById.get(message.id)
        if (!preservedArtifacts || preservedArtifacts.length === 0) return message

        return {
          ...message,
          artifacts: preservedArtifacts,
        }
      })

      // If the conversation becomes empty, clear the currentPath to avoid stale selection
      if (!state.conversation.messages || state.conversation.messages.length === 0) {
        state.conversation.currentPath = []
      } else {
        const validIds = new Set(state.conversation.messages.map(m => m.id))
        const cleanedPath = state.conversation.currentPath.filter(id => validIds.has(id))

        // Only update if the path actually changed (to avoid unnecessary re-renders)
        if (cleanedPath.length !== state.conversation.currentPath.length) {
          state.conversation.currentPath = cleanedPath
        }
      }
    },

    // Branching support
    messageBranchCreated: (state, action: PayloadAction<{ newMessage: Message }>) => {
      const { newMessage } = action.payload
      if (!isMessageForCurrentConversation(state, newMessage)) {
        return
      }

      const normalizeIds = (ids: any): MessageId[] => {
        if (Array.isArray(ids)) return ids as MessageId[]
        if (typeof ids === 'string') return ids.split(',').map(id => parseId(id))
        return []
      }

      const parentMessage = state.conversation.messages.find(m => m.id === newMessage.parent_id)
      if (parentMessage) {
        parentMessage.children_ids = normalizeIds(parentMessage.children_ids)
        if (!parentMessage.children_ids.includes(newMessage.id)) {
          parentMessage.children_ids.push(newMessage.id)
        }
      }

      // Auto-navigate current path to new branch by building complete path from root
      // This ensures we switch cleanly to the new branch without leftover messages
      const buildPathToMessage = (messageId: MessageId): MessageId[] => {
        const path: MessageId[] = []
        let currentId: MessageId | null = messageId

        // Walk up the parent chain to build the complete path
        while (currentId !== null) {
          path.unshift(currentId)
          const message = state.conversation.messages.find(m => m.id === currentId)
          currentId = message?.parent_id ?? null
        }

        return path
      }

      // Only auto-navigate if:
      // 1. It's a user message (user initiated a new branch)
      // 2. OR we are currently at the parent of the new message (extending current view)
      // 3. OR the current path is empty
      const currentTip =
        state.conversation.currentPath.length > 0
          ? state.conversation.currentPath[state.conversation.currentPath.length - 1]
          : null

      const shouldSwitch =
        newMessage.role === 'user' || state.conversation.currentPath.length === 0 || currentTip === newMessage.parent_id

      if (shouldSwitch) {
        state.conversation.currentPath = buildPathToMessage(newMessage.id)
      }
    },

    // Set current path for navigation through branches
    conversationPathSet: (state, action: PayloadAction<MessageId[]>) => {
      state.conversation.currentPath = action.payload
    },

    // Set selected node path (string IDs from Heimdall)
    selectedNodePathSet: (state, action: PayloadAction<string[]>) => {
      // Convert string IDs to proper format based on environment
      const parsedPath = action.payload
        .filter(id => id !== 'empty' && id !== '' && id !== 'root') // Filter out empty/default/synthetic root nodes
        .map(id => parseId(id))
        .filter(id => (typeof id === 'number' && !isNaN(id)) || typeof id === 'string') // Filter out invalid IDs
      state.conversation.currentPath = parsedPath
    },

    // Update Claude Code session info
    ccSessionUpdated: (
      state,
      action: PayloadAction<{ sessionId: string; lastMessageAt: string; messageCount: number; cwd: string }>
    ) => {
      state.conversation.ccSession = action.payload
    },
    ccCwdSet: (state, action: PayloadAction<string>) => {
      state.conversation.ccCwd = action.payload
    },

    /* Heimdall tree reducers */
    heimdallLoadingStarted: state => {
      state.heimdall.loading = true
      state.heimdall.error = null
    },
    heimdallDataLoaded: (state, action: PayloadAction<{ treeData: any; subagentMap?: Record<string, any[]> }>) => {
      state.heimdall.treeData = action.payload.treeData
      state.heimdall.subagentMap = action.payload.subagentMap ?? {}
      state.heimdall.loading = false
      state.heimdall.error = null
    },
    heimdallError: (state, action: PayloadAction<string>) => {
      state.heimdall.error = action.payload
      state.heimdall.loading = false
    },
    heimdallCompactModeToggled: state => {
      state.heimdall.compactMode = !state.heimdall.compactMode
    },

    /* Initialization reducers */
    initializationStarted: state => {
      state.initialization.loading = true
      state.initialization.error = null
    },
    initializationCompleted: (state, action: PayloadAction<{ userId: string; conversationId: ConversationId }>) => {
      state.initialization.loading = false
      state.initialization.userId = action.payload.userId
      state.conversation.currentConversationId = action.payload.conversationId
    },
    initializationError: (state, action: PayloadAction<string>) => {
      state.initialization.loading = false
      state.initialization.error = action.payload
    },
    multiReplyCountSet: (state, action: PayloadAction<number>) => {
      state.composition.multiReplyCount = action.payload
    },

    /* Optimistic message reducers (web mode only) */
    optimisticMessageSet: (state, action: PayloadAction<Message>) => {
      state.composition.optimisticMessage = action.payload
    },
    optimisticMessageCleared: state => {
      state.composition.optimisticMessage = null
    },
    optimisticBranchMessageSet: (state, action: PayloadAction<Message>) => {
      state.composition.optimisticBranchMessage = action.payload
    },
    optimisticBranchMessageCleared: state => {
      state.composition.optimisticBranchMessage = null
    },

    /* Attachment reducers */
    attachmentsSetForMessage: (state, action: PayloadAction<{ messageId: MessageId; attachments: Attachment[] }>) => {
      const { messageId, attachments } = action.payload
      state.attachments.byMessage[String(messageId)] = attachments
    },
    attachmentUpsertedForMessage: (state, action: PayloadAction<{ messageId: MessageId; attachment: Attachment }>) => {
      const { messageId, attachment } = action.payload
      const key = String(messageId)
      const arr = state.attachments.byMessage[key] || []
      const idx = arr.findIndex(a => a.id === attachment.id)
      if (idx >= 0) {
        arr[idx] = attachment
      } else {
        arr.push(attachment)
      }
      state.attachments.byMessage[key] = arr
    },
    attachmentsClearedForMessage: (state, action: PayloadAction<MessageId>) => {
      const messageId = action.payload
      state.attachments.byMessage[String(messageId)] = []
    },
    // When editing a branch, allow removing an artifact image while backing it up for potential restore
    messageArtifactDeleted: (state, action: PayloadAction<{ messageId: MessageId; index: number }>) => {
      const { messageId, index } = action.payload
      const msg = state.conversation.messages.find(m => m.id === messageId)
      if (!msg || !Array.isArray(msg.artifacts)) return
      if (index < 0 || index >= msg.artifacts.length) return
      const removed = msg.artifacts.splice(index, 1)[0]
      const key = String(messageId)
      if (!state.attachments.backup[key]) state.attachments.backup[key] = []
      // Store removed artifact (base64) in backup bucket for this message
      state.attachments.backup[key].push(removed)
    },
    // Restore backed up artifacts to the message (used on cancel)
    messageArtifactsRestoreFromBackup: (state, action: PayloadAction<{ messageId: MessageId }>) => {
      const { messageId } = action.payload
      const key = String(messageId)
      const backup = state.attachments.backup[key]
      if (!backup || backup.length === 0) return
      const msg = state.conversation.messages.find(m => m.id === messageId)
      if (!msg) return
      const current = Array.isArray(msg.artifacts) ? msg.artifacts : []
      msg.artifacts = [...current, ...backup]
      state.attachments.backup[key] = []
    },
    // Clear backup explicitly (used after creating branch)
    messageArtifactsBackupCleared: (state, action: PayloadAction<{ messageId: MessageId }>) => {
      const { messageId } = action.payload
      state.attachments.backup[String(messageId)] = []
    },
    // Update a message's artifacts (e.g., after fetching attachments)
    messageArtifactsSet: (state, action: PayloadAction<{ messageId: MessageId; artifacts: string[] }>) => {
      const { messageId, artifacts } = action.payload
      const msg = state.conversation.messages.find(m => m.id === messageId)
      if (msg) {
        msg.artifacts = artifacts
      }
    },
    // Append artifacts to a message (e.g., when user adds image drafts)
    messageArtifactsAppended: (state, action: PayloadAction<{ messageId: MessageId; artifacts: string[] }>) => {
      const { messageId, artifacts } = action.payload
      const msg = state.conversation.messages.find(m => m.id === messageId)
      if (msg) {
        const existing = Array.isArray(msg.artifacts) ? [...msg.artifacts] : []
        const existingSet = new Set(existing)
        const newArtifacts = artifacts.filter(artifact => !existingSet.has(artifact))
        if (newArtifacts.length > 0) {
          msg.artifacts = [...existing, ...newArtifacts]
        }
      }
    },

    // Tools management
    toolsLoaded: (state, action: PayloadAction<any[]>) => {
      state.tools = cloneTools(action.payload)
    },
    toolsError: (_state, action: PayloadAction<string>) => {
      console.error('Tools error:', action.payload)
    },
    toolEnabledUpdated: (state, action: PayloadAction<{ toolName: string; enabled: boolean }>) => {
      const tool = state.tools.find(t => t.name === action.payload.toolName)
      if (tool) {
        tool.enabled = action.payload.enabled
      }
    },
    // Set entire tools array (used when merging with custom tools)
    setTools: (state, action: PayloadAction<ToolDefinition[]>) => {
      state.tools = cloneTools(action.payload)
    },

    toolPermissionRequested: (state, action: PayloadAction<ToolCallPermissionRequest>) => {
      state.toolCallPermissionRequest = action.payload
    },

    toolPermissionResponded: state => {
      state.toolCallPermissionRequest = null
    },

    planClarificationRequested: (state, action: PayloadAction<import('./planToolTypes').PlanClarificationRequest>) => {
      state.planClarificationRequest = action.payload
    },

    planClarificationResponded: state => {
      state.planClarificationRequest = null
    },

    toolAutoApproveEnabled: state => {
      state.toolAutoApprove = true
    },

    toolAutoApproveDisabled: state => {
      state.toolAutoApprove = false
    },

    toolAutoApproveToggled: state => {
      state.toolAutoApprove = !state.toolAutoApprove
    },

    operationModeSet: (state, action: PayloadAction<OperationMode>) => {
      state.operationMode = action.payload
    },

    operationModeToggled: state => {
      state.operationMode = state.operationMode === 'plan' ? 'execute' : 'plan'
    },

    // CC Slash Commands
    ccSlashCommandsLoaded: (state, action: PayloadAction<string[]>) => {
      state.ccSlashCommands = action.payload
    },

    ccSlashCommandsCleared: state => {
      state.ccSlashCommands = []
    },

    /* Free tier reducers */
    freeGenerationsUpdated: (state, action: PayloadAction<{ remaining: number; isFreeTier: boolean }>) => {
      state.freeTier.freeGenerationsRemaining = action.payload.remaining
      state.freeTier.isFreeTierUser = action.payload.isFreeTier
    },
    freeTierLimitModalShown: state => {
      state.freeTier.showLimitModal = true
    },
    freeTierLimitModalHidden: state => {
      state.freeTier.showLimitModal = false
    },

    /* User System Prompts reducers */
    userSystemPromptsLoadingStarted: state => {
      state.userSystemPrompts.loading = true
      state.userSystemPrompts.error = null
    },
    userSystemPromptsLoaded: (state, action: PayloadAction<UserSystemPrompt[]>) => {
      state.userSystemPrompts.prompts = action.payload
      state.userSystemPrompts.loading = false
      state.userSystemPrompts.error = null
    },
    userSystemPromptsError: (state, action: PayloadAction<string>) => {
      state.userSystemPrompts.loading = false
      state.userSystemPrompts.error = action.payload
    },
    userSystemPromptAdded: (state, action: PayloadAction<UserSystemPrompt>) => {
      state.userSystemPrompts.prompts.push(action.payload)
    },
    userSystemPromptUpdated: (state, action: PayloadAction<UserSystemPrompt>) => {
      const index = state.userSystemPrompts.prompts.findIndex(p => p.id === action.payload.id)
      if (index >= 0) {
        state.userSystemPrompts.prompts[index] = action.payload
      }
    },
    userSystemPromptDeleted: (state, action: PayloadAction<string>) => {
      state.userSystemPrompts.prompts = state.userSystemPrompts.prompts.filter(p => p.id !== action.payload)
    },

    stateReset: () => makeInitialState(),
  },
})

export const chatSliceActions = chatSlice.actions
export default chatSlice.reducer
