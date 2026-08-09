// Types
export type {
  ChatState,
  CompositionState,
  Message,
  MessageInput,
  Model,
  ModelsResponse,
  SendMessagePayload,
  StreamChunk,
  StreamState,
} from './chatTypes'

// Slice
export { default as chatReducer, chatSliceActions } from './chatSlice'

// Async actions

// Note: Model selection (selectModel) has been migrated to React Query. See hooks/useQueries.ts for useSelectModel
// Model fetching thunks (fetchModels, fetchModelsForCurrentProvider, etc.) have been migrated to React Query
export {
  AUTO_COMPACTION_NOTE,
  GENERATED_IMAGE_PATH_HINT_NOTE,
  abortGeneration,
  resumeInFlightStreams,
  deleteMessage,
  editMessageWithBranching,
  refreshCurrentPathAfterDelete,
  respondToPlanClarification,
  respondToOperationModeUpgrade,
  cancelPlanClarification,
  respondToToolPermission,
  respondToToolPermissionAndEnableAll,
  compactBranch,
  sendMessage,
  sendMessageToBranch,
  syncConversationToLocal,
  updateMessage,
  fetchConversationStreamUndo,
  restoreStreamFileEdits,
} from './chatActions'

// Selectors - grouped by feature
// Note: Model-related selectors removed - use React Query hooks (useSelectedModel, useModels, useSelectModel)
// selectCanSend deprecated - use local canSendLocal in components
export {
  conversationContext,
  HeimdallDataReset,
  selectBookmarkedMessages,
  selectConversationMessages,
  selectConversationState,
  selectCcCwd,
  selectCurrentConversationId,
  selectCurrentPath,
  selectDisplayMessages,
  selectExcludedMessages,
  selectFilteredMessages,
  selectFocusedChatMessageId,
  selectInputContent,
  selectInputValid,
  selectIsModelAvailable,
  selectIsStreaming,
  selectMessageInput,
  selectModelSelectorOpen,
  selectOperationMode,
  selectProviderState,
  selectSendingState,
  selectStreamBuffer,
  selectStreamEvents,
  selectStreamState,
  selectThinkingBuffer,
  selectValidationError,
  // Multi-stream selectors
  selectActiveStreamIds,
  selectAllActiveStreams,
  selectCurrentViewStream,
  selectCurrentViewStreamFor,
  selectDisplayMessagesFor,
  selectIsAnyStreaming,
  selectPrimaryStreamId,
  selectPrimaryStreamState,
  selectStreamingRoot,
  selectStreamUndoRoot,
  selectStreamUndoSummariesForParentMessage,
  selectStreamUndoRestoringByStreamId,
  selectStreamUndoErrorByStreamId,
} from './chatSelectors'

// Convenience re-exports
// New async thunks
export {
  blobToDataURL,
  fetchConversationMessages,
  fetchCustomTools,
  fetchMcpTools,
  fetchMessageTree,
  fetchTools,
  initializeConversationData,
  initializeUserAndConversation,
  resolveAttachmentUrl,
  updateConversationTitle,
} from './chatActions'

// New selectors for Heimdall and initialization
export {
  selectHeimdallCompactMode,
  selectHeimdallData,
  selectHeimdallError,
  selectHeimdallLoading,
  selectHeimdallSubagentMap,
  selectHeimdallState,
  selectInitializationError,
  selectInitializationLoading,
  selectInitializationState,
  selectMultiReplyCount,
} from './chatSelectors'

export { chatSliceActions as actions } from './chatSlice'
