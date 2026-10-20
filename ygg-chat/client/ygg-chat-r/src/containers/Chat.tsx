import { selectHostFolder } from '../platform/hostPathPicker'
import { newClientId } from '../helpers/clientId'
import { isBrowserClient, isHostClient } from '../platform/clientCapabilities'
import { ConversationOpeningOverlay } from '../components/ChatPane/ConversationOpeningOverlay'
import { useModelSwitchConfirmation } from '../hooks/useModelSwitchConfirmation'
import { ModelSwitchDialog } from '../components/ModelSelectControl/ModelSwitchDialog'
import { resolveBranchModelSelection } from '../features/chats/branchModelSelection'
import { resolveBranchFastMode } from '../features/chats/branchFastMode'
import { isCommittedCompaction } from '../../../../shared/compaction'
import { isHiddenCompactionMessage } from '../features/chats/summaryPresentation'
import { useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import 'boxicons' // Types
import 'boxicons/css/boxicons.min.css'
import { AnimatePresence, motion } from 'framer-motion'
import { Settings } from 'lucide-react'
import { ConversationToolbar } from '../components/ChatPane/ConversationToolbar'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { useChatNavigate as useNavigate } from '../components/ChatSelection/ChatSelectionProvider'
import {
  ConversationId,
  ImageConfig,
  MessageId,
  OpenAIServiceTier,
  Project,
  ReasoningConfig,
} from '../../../../shared/types'
import {
  buildChatErrorEnvelope,
  type ChatErrorActionKind,
  type ChatErrorCode,
  type ChatErrorEnvelope,
} from '../../../../shared/chatErrors'
import {
  ActionPopover,
  Button,
  ChatMessage,
  DeleteConfirmModal,
  Heimdall,
  ParallelChatPane,
  type ParallelChatPaneTarget,
  ModelSelectControl,
  PlanClarificationPanel,
  ReasoningLevelControl,
  Select,
  SettingsPane,
  StreamingThinkingIndicator,
  ToolJobsModal,
  ToolPermissionDialog,
} from '../components'
import { ChatErrorBubble } from '../components/ChatErrorBubble/ChatErrorBubble'
import { ActionPopoverButton, ActionPopoverDisclosure, ActionPopoverSwitch } from '../components/ActionPopover/ActionPopoverControls'
import { ClipboardCheck, CodeXml, MessageSquare, ShieldHalf } from 'lucide-react'
import { useConversationRunStatistics } from '../hooks/useConversationRunStatistics'
import { deriveRunStatistics, placeRunFooters, interleaveRunFooters, type RunStatisticsFooterData } from '../features/chats/runStatistics'
import { RunStatisticsFooter } from '../components/ChatMessage/RunStatisticsFooter'
import { isWatcherCompletionMessage, WatcherCompletionNotice } from '../components/ChatMessage/WatcherCompletionNotice'
import { ImageAttachmentNotice, isImageAttachmentInfoMessage } from '../components/ChatMessage/ImageAttachmentNotice'
import { prepareImageFiles, waitForImagePreparation } from '../features/chats/imagePreparation'
import { hasAcceptedImageAttachments } from '../features/chats/acceptedImageAttachments'
import { isExcludedFromProcessRunGrouping } from '../components/ChatMessage/chatMessageShared'
import {
  ChatInputController,
  type ChatInputControllerHandle,
  type ChatInputUpdater,
  type ComposerSlashCommandResult,
} from '../components/ChatPane/ChatInputController'
import { useHtmlIframeRegistry } from '../components/HtmlIframeRegistry/HtmlIframeRegistry'
import { contentSpringTransition, softTransition } from '../components/motion'
import { ContextUsageSparkline } from '../components/ContextUsageSparkline/ContextUsageSparkline'
import { FastModeAnimationBackground } from '../components/FastModeAnimation/FastModeAnimation'
import { resolveComposerAgentTint } from '../components/FastModeAnimation/fastModePalette'
import { useFastModeAnimation } from '../helpers/fastModeAnimationSettings'
import { SubagentTranscriptModal } from '../components/SubagentTranscript/SubagentTranscript'
import {
  ChatInputBorderAnimationType,
  getStoredChatInputBorderAnimation,
  getStoredChatInputBorderDarkColor,
  getStoredChatInputBorderLightColor,
} from '../components/SettingsPane/ChatInputBorderAnimationSettings'
import {
  getStoredSendButtonAnimation,
  getStoredSendButtonDarkColor,
  getStoredSendButtonLightColor,
  SendButtonAnimationType,
  SendButtonLoadingAnimation,
} from '../components/SettingsPane/SendButtonAnimationSettings'
import {
  getThemeModeColor,
  saveCustomChatTheme,
  setCustomChatThemeEnabled,
  type CustomChatTheme,
  useCustomChatTheme,
  useHtmlDarkMode,
} from '../components/ThemeManager/themeConfig'
import { isCommunityMode } from '../config/runtimeMode'
import { getCompactionPresentationScope, isCompactionVisibleFor, type CompactionOwner } from '../features/chats/compactionVisibility'
import {
  abortGeneration,
  cancelPlanClarification,
  blobToDataURL,
  chatSliceActions,
  compactBranch,
  abortCompaction,
  deleteMessage,
  editMessageWithBranching,
  fetchConversationStreamUndo,
  initializeUserAndConversation,
  Message,
  resolveAttachmentUrl,
  respondToPlanClarification,
  respondToOperationModeUpgrade,
  respondToToolPermission,
  respondToToolPermissionAndEnableAll,
  restoreStreamFileEdits,
  resumeInFlightStreams,
  selectCcCwd,
  selectConversationMessages,
  selectCurrentConversationId,
  selectCurrentPath,
  // Chat selectors
  selectCurrentViewStream,
  selectDisplayMessages,
  selectHeimdallCompactMode,
  selectHeimdallData,
  selectHeimdallError,
  selectHeimdallLoading,
  selectMessageInput,
  selectMultiReplyCount,
  selectOperationMode,
  selectProviderState,
  selectSendingState,
  selectStreamUndoRoot,
  sendMessage,
  syncConversationToLocal,
  updateConversationTitle,
  updateMessage,
} from '../features/chats'
import type {
  ChatErrorRecord,
  ContentBlock,
  HookRunRecord,
  ImageDraftTarget,
  StreamUndoSummary,
  ToolCall,
} from '../features/chats/chatTypes'
import { selectChatErrorsForConversation } from '../features/chats/chatSelectors'
import { changeOperationMode, enqueueUserMessage, loadMessageQueue, cancelQueuedMessage, readServerLoopRejection } from '../features/chats/chatActions'
import { QueuedMessages } from '../components/ChatMessage/QueuedMessages'
import { OperationModeNotice } from '../components/ChatMessage/OperationModeNotice'
import { FullAccessNotice } from '../components/ChatMessage/FullAccessNotice'
import { isFullAccessNotification, isRunSettingsNotification } from '../../../../shared/accessNotifications'
import { SummarisedMessage } from '../components/ChatMessage/SummarisedMessage'
import {
  buildChatErrorRecord,
  classifyLocalChatError,
  type LocalChatErrorPhase,
} from '../features/chats/localChatErrors'
import type { PlanClarificationAnswer } from '../features/chats/planToolTypes'
import {
  calculateBranchContextUsage,
} from '../features/chats/contextTokenEstimate'
import { isOpenAIProvider } from '../../../../shared/contextUsage'
import { isContextInjectionMessage, parseMessageMeta } from '../../../../shared/contextInjection'
import { ContextInjectionCard, type ContextInjectionCardEntry } from '../components/ChatMessage/ContextInjectionCard'
import { AgentSteps } from '../components/ChatMessage/AgentSteps'
import { MessageActivity } from '../components/ChatMessage/MessageActivity'
import { getAgentProgress, splitLiveAgentEvents, hasTrailingAgentProse, canAttachLiveAgentGroup } from '../components/ChatMessage/agentActivity'
import {
  chatErrorRowHeight,
  DEFAULT_ROOT_FONT_SIZE,
  estimateMessageRowHeight,
  processGroupRowHeight,
  smallChromeRowHeight,
} from '../components/ChatMessage/estimateMessageHeight'
import {
  extractBranchFileMutations,
  type WorkspaceMutationOperation,
} from '../features/chats/workspaceMutationTracking'
import {
  clearTokens as clearOpenAITokens,
  fetchOpenAIUsageStatus,
  isOpenAIAuthenticated,
  type OpenAIUsageSnapshot,
} from '../features/chats/chatgptAccount'
import { generateStreamId, isStreamMessageAlreadyRendered } from '../features/chats/streamHelpers'
import { recordSentMessage } from '../components/ChatPane/sentMessageHistory'
import { getComposerSubmissionAvailability } from '../components/ChatPane/composerSubmission'
import {
  convContextSet,
  Conversation,
  conversationsLoaded,
  makeSelectConversationById,
  systemPromptSet,
  updateResearchNote,
} from '../features/conversations'
import { updateCwd } from '../features/conversations/conversationActions'
import { removeSelectedFileForChat, selectExtension, updateIdeContext } from '../features/ideContext'
import {
  selectCurrentSelection,
  selectExtensions,
  selectSelectedExtensionId,
  selectSelectedFilesForChat,
  selectWorkspace,
} from '../features/ideContext/ideContextSelectors'
import { selectSelectedProject } from '../features/projects/projectSelectors'
import { uiActions } from '../features/ui'
import { selectCurrentUser } from '../features/users'
import {
  CHAT_REASONING_SETTINGS_CHANGE_EVENT,
  loadChatReasoningSettings,
} from '../helpers/chatReasoningSettingsStorage'
import {
  CHAT_UI_ADDED_FILES_PILLS_VISIBILITY_CHANGE_EVENT,
  CHAT_UI_ADDED_FILES_PILLS_VISIBILITY_KEY,
  CHAT_UI_AUTO_COMPACTION_ENABLED_CHANGE_EVENT,
  CHAT_UI_AUTO_COMPACTION_ENABLED_KEY,
  CHAT_UI_TOKEN_USAGE_HOVER_DETAILS_VISIBILITY_CHANGE_EVENT,
  CHAT_UI_TOKEN_USAGE_HOVER_DETAILS_VISIBILITY_KEY,
  CHAT_UI_TOKEN_USAGE_VISIBILITY_CHANGE_EVENT,
  loadAutoCompactionEnabled,
  loadShowAddedFilesPills,
  loadShowTokenUsageBar,
  loadShowTokenUsageHoverDetails,
} from '../helpers/chatUiSettingsStorage'
import {
  loadProviderSettings,
  PROVIDER_SETTINGS_CHANGE_EVENT,
  ProviderSettings,
  resolveProviderContextLength,
} from '../helpers/providerSettingsStorage'
import { isOrchestratorEnabled, toggleOrchestratorEnabled } from '../helpers/subagentToolSettings'
import { useSyncExternalStore } from 'react'
import { isFullAccessEnabled, setFullAccessEnabled, subscribeFullAccess } from '../helpers/fullAccessSettings'
import { handleChatToggleShortcut, loadModelShortcutSlots } from '../helpers/chatKeyboardShortcuts'
import { useCommandBlocker, useCommands } from '../keyboard/KeyboardProvider'
import {
  loadToolOutputTruncationEnabled,
  TOOL_OUTPUT_TRUNCATION_CHANGE_EVENT,
  TOOL_OUTPUT_TRUNCATION_ENABLED_KEY,
} from '../helpers/toolOutputTruncation'
import { useAppDispatch, useAppSelector } from '../hooks/redux'
import { useAuth } from '../hooks/useAuth'
import { useIdeContext } from '../hooks/useIdeContext'
import { useIsMobile } from '../hooks/useMediaQuery'
import { useRunningJobs } from '../hooks/useToolJobs'
import {
  ResearchNoteItem,
  useConversationsByProject,
  useConversationStorageMode,
  useModels,
  useSelectedModel,
  useSelectModel,
} from '../hooks/useQueries'
import { useSubscriptionStatus } from '../hooks/useSubscriptionStatus'
import { useConversationSnapshotCoordinator } from '../hooks/useConversationSnapshotCoordinator'
import { CHAT_INSERT_FILE_PATH_EVENT, type ChatInsertFilePathDetail } from '../helpers/chatInputBridge'
import { dispatchOpenWorkspaceMutationDiffs } from '../helpers/workspaceMutationDiffBridge'
import { localApi } from '../utils/api'
import { useChatSelection } from '../components/ChatSelection/ChatSelectionProvider'
import { chatSelectionScrollHandled, isPendingViewStreamOwned, type PendingViewStream } from '../features/chats/chatSelection'
import { executeToolAndWait } from '../utils/executeToolAndWait'
import { getHookRunsRenderSignature } from '../components/ChatMessage/hookActivityState'
import { parseId } from '../utils/helpers'
import { extractTextFromPdf } from '../utils/pdfUtils'
import { addFileMentionLookupKeys } from '../../shared/fileMatchRanking'
import { extractLatestTodoList } from '../features/chats/todoListTracking'

type ParsedMessageData = {
  toolCalls?: ToolCall[]
  contentBlocks?: ContentBlock[]
}

type MessageRenderRow =
  | {
      kind: 'message'
      id: MessageId
      message: Message
    }
  | {
      kind: 'process_group'
      id: MessageId
      anchorMessageId: MessageId
      memberMessageIds: MessageId[]
      messages: Message[]
      toolCount: number
      reasoningCount: number
      bridgedMessageId?: MessageId
    }

type VirtualRenderRow =
  | { kind: 'run_stats'; key: string; statistics: RunStatisticsFooterData }
  | {
      kind: 'message_row'
      key: string
      row: MessageRenderRow
    }
  | {
      kind: 'optimistic_message'
      key: string
      message: Message
    }
  | {
      kind: 'optimistic_branch_message'
      key: string
      message: Message
    }
  | {
      kind: 'streaming_message'
      key: 'streaming'
    }
  | {
      kind: 'generation_loader'
      key: 'generation-loader'
    }
  // Tier 2 of the error surface: a failure with no assistant message to live on
  // (pre-persist server failures, renderer-local transport failures). Rendered as a
  // real row so a failed turn always leaves something visible in the transcript.
  | {
      kind: 'chat_error'
      key: string
      record: ChatErrorRecord
    }

type BenchAction = 'on' | 'off' | 'status' | 'export' | 'reset'
type ThemeDemoAction = 'on' | 'off'

type ThemeListItem = {
  id: string
  fileName: string
  name: string
  modifiedAt: string
}

type ThemeManagerListResult = {
  success?: boolean
  error?: string
  themes?: ThemeListItem[]
}

type ThemeManagerReadResult = {
  success?: boolean
  error?: string
  exists?: boolean
  theme?: CustomChatTheme
}

type BenchEvent = {
  ts: number
  kind: string
  details?: Record<string, unknown>
}

type BenchStats = {
  count: number
  min: number
  max: number
  avg: number
  p50: number
  p95: number
}

type AddedIdeContext = {
  id: string
  filePath: string
  fileName: string
  startLine: number
  endLine: number
  selectedText: string
}

type StreamingThinkingIndicatorPlacement = 'message' | 'input-tab'

const EMPTY_PARSED_MESSAGE_DATA: ParsedMessageData = {}
const COMPOSER_SLASH_COMMANDS = [
  'status-openai',
  'compact',
  'bench on',
  'bench off',
  'bench status',
  'bench export',
  'bench reset',
  'theme-demo on',
  'theme-demo off',
]
const CROSS_MESSAGE_PROCESS_GROUP_MIN_MESSAGES = 1
const DERIVED_RENDER_CACHE_LIMIT = 40
const ACTION_POPOVER_SELECT_DROPDOWN_Z_INDEX = 100001
const BENCH_MAX_SAMPLES = 3000
const BENCH_MAX_EVENTS = 1200
const BENCH_SCROLL_ACTIVE_WINDOW_MS = 140
const THEME_DEMO_INTERVAL_MS = 500
const STREAMING_THINKING_INDICATOR_PLACEMENT_STORAGE_KEY = 'chat:streamingThinkingIndicatorPlacement'
const EXPANDED_FILE_PREVIEW_EXIT_MS = 150

const getStoredStreamingThinkingIndicatorPlacement = (): StreamingThinkingIndicatorPlacement => {
  try {
    const stored = window.localStorage.getItem(STREAMING_THINKING_INDICATOR_PLACEMENT_STORAGE_KEY)
    return stored === 'input-tab' ? 'input-tab' : 'message'
  } catch {
    return 'message'
  }
}

const parseCreatedAtMs = (createdAt: string | Date | null | undefined): number | null => {
  if (!createdAt) return null

  const value = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt)
  return Number.isFinite(value) ? value : null
}

const formatWorkedDurationLabel = (durationMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const minuteLabel = `${minutes} minute${minutes === 1 ? '' : 's'}`
  const secondLabel = `${seconds} second${seconds === 1 ? '' : 's'}`

  return `worked for ${minuteLabel} ${secondLabel}`
}

const VIRTUAL_ROW_BASE_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  width: '100%',
}

const getWorkspaceFileBaseName = (filePath: string): string => {
  const normalizedPath = filePath.replace(/\\/g, '/')
  const segments = normalizedPath.split('/').filter(Boolean)
  return segments[segments.length - 1] || filePath
}

const getWorkspaceMutationLabel = (operation: WorkspaceMutationOperation): string => {
  switch (operation) {
    case 'create':
      return 'Created'
    case 'delete':
      return 'Deleted'
    default:
      return 'Edited'
  }
}

const getWorkspaceMutationBadgeClassName = (operation: WorkspaceMutationOperation): string => {
  switch (operation) {
    case 'create':
      return 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
    case 'delete':
      return 'border border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-300'
    default:
      return 'border border-sky-500/20 bg-sky-500/10 text-sky-600 dark:text-sky-300'
  }
}

const clampUsagePercent = (value: number | null | undefined): number | null => {
  if (value == null || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

const formatUsagePercent = (value: number | null | undefined): string => {
  const clamped = clampUsagePercent(value)
  return clamped == null ? '—' : `${Math.round(clamped)}%`
}

const getUsageMeterFillClassName = (percent: number | null): string => {
  if (percent == null) return 'bg-neutral-300/50 dark:bg-neutral-700/60'
  if (percent >= 95) return 'bg-rose-500 dark:bg-rose-400'
  if (percent >= 80) return 'bg-amber-500 dark:bg-amber-400'
  return 'bg-blue-500 dark:bg-orange-400'
}

type OpenAIUsageMeterProps = {
  label: string
  usedPercent: number | null | undefined
  resetAtIso?: string | null
  note?: string
}

const OpenAIUsageMeter = ({ label, usedPercent, resetAtIso, note }: OpenAIUsageMeterProps) => {
  const percent = clampUsagePercent(usedPercent)
  const activeSegments = percent == null ? 0 : Math.ceil((percent / 100) * 14)
  const fillClassName = getUsageMeterFillClassName(percent)

  return (
    <div className='rounded-2xl bg-white/45 px-3 py-3 backdrop-blur-xl dark:bg-black/20'>
      <div className='flex items-center justify-between gap-3'>
        <div className='min-w-0'>
          <div className='text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500 dark:text-neutral-400'>
            {label}
          </div>
          {note && <div className='mt-0.5 truncate text-xs text-neutral-500/80 dark:text-neutral-500'>{note}</div>}
        </div>
        <div className='shrink-0 text-base font-semibold tabular-nums text-neutral-900 dark:text-neutral-100'>
          {formatUsagePercent(percent)}
        </div>
      </div>
      <div className='mt-2.5 grid grid-cols-[repeat(14,minmax(0,1fr))] gap-1' aria-label={`${label} usage ${formatUsagePercent(percent)}`}>
        {Array.from({ length: 14 }).map((_, index) => (
          <div
            key={`${label}-usage-segment-${index}`}
            className={`h-2 rounded-full transition-colors duration-300 ${
              index < activeSegments ? fillClassName : 'bg-neutral-300/35 dark:bg-white/10'
            }`}
          />
        ))}
      </div>
      {resetAtIso && (
        <div className='mt-2 text-xs text-neutral-500 dark:text-neutral-400'>
          Resets {new Date(resetAtIso).toLocaleString()}
        </div>
      )}
    </div>
  )
}

// const formatStreamDebugId = (value: unknown): string => {
//   if (value == null || value === '') return '—'
//   const stringValue = String(value)
//   return stringValue.length > 18 ? `${stringValue.slice(0, 8)}…${stringValue.slice(-6)}` : stringValue
// }

type EmptyChatStateProps = {
  onSelectProjectFolder?: () => Promise<void> | void
  projectFolderPath?: string
}

const EmptyChatState = ({ onSelectProjectFolder, projectFolderPath }: EmptyChatStateProps) => {
  const projectFolderName = projectFolderPath?.trim() ? getWorkspaceFileBaseName(projectFolderPath.trim()) : ''

  return (
    <div className='flex min-h-[420px] flex-1 items-center justify-center px-6 py-12 sm:px-10'>
      <div className='mx-auto flex max-w-sm flex-col items-center text-center'>
        <div className='mb-5 rounded-[28px] border border-stone-200/80 bg-white/75 p-5 shadow-[0_16px_40px_-24px_rgba(0,0,0,0.35)] backdrop-blur-xl dark:border-white/10 dark:bg-neutral-900/70'>
          <svg
            aria-hidden='true'
            viewBox='0 0 180 128'
            className='h-28 w-40 text-stone-700 dark:text-stone-200'
            fill='none'
            xmlns='http://www.w3.org/2000/svg'
          >
            <circle cx='148' cy='26' r='10' fill='currentColor' opacity='0.12' />
            <circle cx='38' cy='98' r='14' fill='currentColor' opacity='0.08' />
            <path
              d='M35 38C35 28.6112 42.6112 21 52 21H99C108.389 21 116 28.6112 116 38V57C116 66.3888 108.389 74 99 74H72.5L55 89V74H52C42.6112 74 35 66.3888 35 57V38Z'
              fill='currentColor'
              opacity='0.12'
            />
            <path d='M69 52H96' stroke='currentColor' strokeWidth='6' strokeLinecap='round' opacity='0.55' />
            <path d='M55 52H58' stroke='currentColor' strokeWidth='6' strokeLinecap='round' opacity='0.55' />
            <path
              d='M92 88C92 79.1634 99.1634 72 108 72H128C136.837 72 144 79.1634 144 88V101C144 109.837 136.837 117 128 117H113L98 127V117H108C99.1634 117 92 109.837 92 101V88Z'
              fill='currentColor'
              opacity='0.18'
            />
            <path d='M108 94H128' stroke='currentColor' strokeWidth='5' strokeLinecap='round' opacity='0.7' />
            <path d='M108 104H122' stroke='currentColor' strokeWidth='5' strokeLinecap='round' opacity='0.4' />
            <path
              d='M126 33L130 41L138 45L130 49L126 57L122 49L114 45L122 41L126 33Z'
              fill='currentColor'
              opacity='0.3'
            />
          </svg>
        </div>
        <h3 className='text-lg font-semibold tracking-tight text-stone-900 dark:text-stone-100'>Start building</h3>
        <p className='mt-2 max-w-xs text-sm leading-6 text-stone-600 dark:text-stone-400'>
          Ask a question, drop in some context, or sketch an idea to make it real.
        </p>
        <div className='mt-4 flex items-center gap-3'>
          <span className='text-sm font-medium text-stone-700 dark:text-stone-300'>
            {projectFolderName ? `Working in ${projectFolderName}` : 'Open project folder'}
          </span>
          <button
            type='button'
            onClick={() => {
              void onSelectProjectFolder?.()
            }}
            className='inline-flex items-center justify-center rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 transition hover:bg-stone-100 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800 dark:focus:ring-orange-500/60'
            title='Select project folder'
          >
            <svg
              xmlns='http://www.w3.org/2000/svg'
              className='h-4 w-4'
              fill='none'
              viewBox='0 0 24 24'
              stroke='currentColor'
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                strokeWidth={2}
                d='M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z'
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}

type VirtualizedRowContainerProps = {
  id: string
  index: number
  start: number
  className?: string
  zIndex?: number
  measureElement?: ((element: Element | null) => void) | null
  children: React.ReactNode
}

const VirtualizedRowContainer = React.memo(function VirtualizedRowContainer({
  id,
  index,
  start,
  className,
  zIndex,
  measureElement,
  children,
}: VirtualizedRowContainerProps) {
  return (
    <div
      id={id}
      data-index={index}
      ref={measureElement as React.Ref<HTMLDivElement>}
      className={className}
      style={{
        ...VIRTUAL_ROW_BASE_STYLE,
        transform: `translateY(${start}px)`,
        ...(zIndex != null ? { zIndex } : null),
      }}
    >
      {children}
    </div>
  )
})

const setLimitedCacheEntry = <T,>(cache: Map<string, T>, key: string, value: T, limit = DERIVED_RENDER_CACHE_LIMIT) => {
  if (cache.has(key)) {
    cache.delete(key)
  }
  cache.set(key, value)

  while (cache.size > limit) {
    const oldestKey = cache.keys().next().value
    if (oldestKey == null) break
    cache.delete(oldestKey)
  }
}

const hashStringForRenderCache = (value: string): string => {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return hash.toString(36)
}

const hashUnknownForRenderCache = (value: unknown): string => {
  if (value == null) return ''
  if (typeof value === 'string') return hashStringForRenderCache(value)
  try {
    return hashStringForRenderCache(JSON.stringify(value))
  } catch {
    return hashStringForRenderCache(String(value))
  }
}

const pushLimitedSample = (samples: number[], value: number, limit = BENCH_MAX_SAMPLES) => {
  if (!Number.isFinite(value)) return
  samples.push(value)
  if (samples.length > limit) {
    samples.splice(0, samples.length - limit)
  }
}

const pushLimitedEvent = (events: BenchEvent[], event: BenchEvent, limit = BENCH_MAX_EVENTS) => {
  events.push(event)
  if (events.length > limit) {
    events.splice(0, events.length - limit)
  }
}

const calculateBenchStats = (values: number[]): BenchStats | null => {
  if (!Array.isArray(values) || values.length === 0) return null

  const sorted = [...values].sort((a, b) => a - b)
  const count = sorted.length
  const min = sorted[0]
  const max = sorted[count - 1]
  const avg = sorted.reduce((sum, value) => sum + value, 0) / count
  const pick = (ratio: number) => sorted[Math.min(count - 1, Math.max(0, Math.round((count - 1) * ratio)))]

  return {
    count,
    min,
    max,
    avg,
    p50: pick(0.5),
    p95: pick(0.95),
  }
}

const parseBenchAction = (command: string): BenchAction | null => {
  const normalized = command.trim().toLowerCase().replace(/^\/+/g, '').replace(/\s+/g, ' ')
  const match = normalized.match(/^bench(?:[\s-]+(on|off|status|export|reset))?$/)
  if (!match) return null
  return (match[1] as BenchAction | undefined) ?? 'status'
}

const parseThemeDemoAction = (command: string): ThemeDemoAction | null => {
  const normalized = command.trim().toLowerCase().replace(/^\/+/g, '').replace(/\s+/g, ' ')
  const match = normalized.match(/^theme-demo(?:[\s-]+(on|off))$/)
  if (!match) return null
  return match[1] as ThemeDemoAction
}

const isLikelyProcessAnnotationText = (text: string): boolean => {
  const trimmed = text.trim()
  if (!trimmed) return true
  if (trimmed.startsWith('```')) return false

  const normalized = trimmed.replace(/[*_`>#-]/g, ' ')
  const words = normalized.split(/\s+/).filter(Boolean)
  return words.length <= 14
}

const countReasoningEntriesInResponsesOutputItems = (items: unknown): number => {
  if (!Array.isArray(items)) return 0

  let count = 0

  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const itemRecord = item as Record<string, unknown>
    if (itemRecord.type !== 'reasoning') continue

    if (Array.isArray(itemRecord.content)) {
      for (const part of itemRecord.content) {
        if (!part || typeof part !== 'object') continue
        const partRecord = part as Record<string, unknown>
        if (
          partRecord.type === 'reasoning_text' &&
          typeof partRecord.text === 'string' &&
          partRecord.text.trim().length > 0
        ) {
          count += 1
        }
      }
    }

    if (Array.isArray(itemRecord.summary)) {
      for (const part of itemRecord.summary) {
        if (!part || typeof part !== 'object') continue
        const partRecord = part as Record<string, unknown>
        if (typeof partRecord.text === 'string' && partRecord.text.trim().length > 0) {
          count += 1
        }
      }
    }
  }

  return count
}

const extractAssistantTextsFromResponsesOutputItems = (items: unknown): string[] => {
  if (!Array.isArray(items)) return []

  const extracted: string[] = []

  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const itemRecord = item as Record<string, unknown>
    if (itemRecord.type !== 'message' || itemRecord.role !== 'assistant' || !Array.isArray(itemRecord.content)) {
      continue
    }

    const text = itemRecord.content
      .map(part => {
        if (!part || typeof part !== 'object') return ''
        const partRecord = part as Record<string, unknown>
        return typeof partRecord.text === 'string' ? partRecord.text : ''
      })
      .filter(Boolean)
      .join('')
      .trim()

    if (text) extracted.push(text)
  }

  return extracted
}

const getResponsesOutputReasoningCount = (block: ContentBlock): number => {
  const blockRecord = block as unknown as Record<string, unknown>
  if (blockRecord.type !== 'responses_output_items') return 0
  return countReasoningEntriesInResponsesOutputItems(blockRecord.items)
}

const getResponsesOutputAssistantTexts = (block: ContentBlock): string[] => {
  const blockRecord = block as unknown as Record<string, unknown>
  if (blockRecord.type !== 'responses_output_items') return []
  return extractAssistantTextsFromResponsesOutputItems(blockRecord.items)
}

/**
 * Identity of a failure as the user perceives it, used to tell "the same failure drawn twice"
 * from "two failures that happen to be similar".
 *
 * An `ErrorBlock` carries no record/stream id, so the envelope IS the only shared handle
 * between tier 1 (persisted block) and tier 2 (`ChatErrorRecord`). Code + the exact user-facing
 * string + the technical detail is a tight enough triple: two distinct failures that agree on
 * all three are indistinguishable on screen anyway, so collapsing them is still one bubble per
 * visible failure.
 */
const chatErrorIdentityKey = (envelope: ChatErrorEnvelope): string =>
  `${envelope.code}\u0000${envelope.userMessage ?? ''}\u0000${envelope.detail ?? ''}`

/**
 * Split a persisted instruction-set row (`renderInstructionSet` output) back into one
 * entry per `Contents of <path> (<label>):` section so the card can list and expand
 * each file. Falls back to one entry per `meta.files` path when the markers are absent.
 */
const splitInstructionSetIntoEntries = (content: string, files: string[], reason: string): ContextInjectionCardEntry[] => {
  const marker = /^Contents of (.+?) \((.+?)\):\s*$/gm
  const entries: ContextInjectionCardEntry[] = []
  const matches = Array.from(content.matchAll(marker))
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]
    const start = (match.index ?? 0) + match[0].length
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? content.length) : content.length
    const text = content
      .slice(start, end)
      .replace(/<\/system-reminder>\s*$/, '')
      .trim()
    entries.push({ path: match[1], label: match[2], text, reason })
  }
  if (entries.length > 0) return entries
  return files.map(file => ({ path: file, label: 'instruction file', text: content, reason }))
}

const parseToolArgumentsForGrouping = (value: unknown): Record<string, any> | null => {
  if (value == null || typeof value === 'object') return value as Record<string, any> | null
  if (typeof value !== 'string') return null

  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : null
  } catch {
    return null
  }
}

const getExcludedGroupingToolIds = (parsed: ParsedMessageData): Set<string> => {
  const excludedIds = new Set<string>()

  for (const toolCall of parsed.toolCalls ?? []) {
    if (isExcludedFromProcessRunGrouping(toolCall.name, parseToolArgumentsForGrouping(toolCall.arguments))) {
      excludedIds.add(String(toolCall.id))
    }
  }

  for (const block of parsed.contentBlocks ?? []) {
    if (block.type === 'tool_use' && isExcludedFromProcessRunGrouping(block.name, block.input)) {
      excludedIds.add(String(block.id))
      continue
    }

    const record = block as unknown as Record<string, any>
    if (record.type !== 'responses_output_items' || !Array.isArray(record.items)) continue
    for (const item of record.items) {
      if (!item || item.type !== 'function_call') continue
      if (isExcludedFromProcessRunGrouping(item.name, parseToolArgumentsForGrouping(item.arguments))) {
        excludedIds.add(String(item.call_id || item.id || ''))
      }
    }
  }

  excludedIds.delete('')
  return excludedIds
}

const hasExcludedGroupingTool = (parsed: ParsedMessageData): boolean => getExcludedGroupingToolIds(parsed).size > 0

const isProcessContentBlock = (block: ContentBlock): boolean => {
  if (
    block.type === 'thinking' ||
    block.type === 'tool_use' ||
    block.type === 'tool_result' ||
    block.type === 'reasoning_details'
  ) {
    return true
  }

  return getResponsesOutputReasoningCount(block) > 0
}

const parseMessageDataForRender = (msg: Message): ParsedMessageData => {
  let toolCalls: ToolCall[] | undefined
  if (msg.tool_calls) {
    try {
      if (typeof msg.tool_calls === 'object') {
        toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [msg.tool_calls]
      } else if (typeof msg.tool_calls === 'string') {
        const parsed = JSON.parse(msg.tool_calls)
        toolCalls = Array.isArray(parsed) ? parsed : [parsed]
      }
    } catch (error) {
      console.warn(`Failed to parse tool_calls for message ${msg.id}:`, msg.tool_calls, error)
    }
  }

  let contentBlocks: ContentBlock[] | undefined
  if ((msg.role === 'assistant' || msg.role === 'ex_agent') && msg.content_blocks) {
    try {
      let parsedBlocks: ContentBlock[] = []
      if (typeof msg.content_blocks === 'object') {
        parsedBlocks = Array.isArray(msg.content_blocks) ? msg.content_blocks : [msg.content_blocks]
      } else if (typeof msg.content_blocks === 'string') {
        const parsed = JSON.parse(msg.content_blocks)
        parsedBlocks = Array.isArray(parsed) ? parsed : [parsed]
      }

      if (parsedBlocks.length > 0) {
        const hasMissingIndexes = parsedBlocks.some(block => typeof block.index !== 'number')
        const isSortedByIndex = parsedBlocks.every((block, index, arr) => {
          if (index === 0) return true
          const prevIndex = typeof arr[index - 1].index === 'number' ? arr[index - 1].index : index - 1
          const currentIndex = typeof block.index === 'number' ? block.index : index
          return prevIndex <= currentIndex
        })

        if (!hasMissingIndexes && isSortedByIndex) {
          contentBlocks = parsedBlocks
        } else {
          contentBlocks = parsedBlocks
            .map((block, index) => ({
              ...block,
              index: typeof block.index === 'number' ? block.index : index,
            }))
            .sort((a, b) => a.index - b.index)
        }
      }
    } catch (error) {
      console.warn(`Failed to parse content_blocks for message ${msg.id}`, error)
      contentBlocks = undefined
    }
  } else if (msg.role === 'user' && msg.content_blocks) {
    // User rows carry only `context_injection` blocks (`/skill` expansion, UserPromptSubmit
    // hook output). Keep those and nothing else, so the legacy user text path is unchanged.
    try {
      const parsed = typeof msg.content_blocks === 'string' ? JSON.parse(msg.content_blocks) : msg.content_blocks
      const list: ContentBlock[] = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
      const injections = list.filter(block => block?.type === 'context_injection')
      if (injections.length > 0) contentBlocks = injections
    } catch (error) {
      console.warn(`Failed to parse user content_blocks for message ${msg.id}`, error)
    }
  }

  if (msg.role === 'assistant' || msg.role === 'ex_agent') {
    const legacyThinking = typeof msg.thinking_block === 'string' ? msg.thinking_block.trim() : ''
    if (legacyThinking.length > 0) {
      const hasThinkingInBlocks = Array.isArray(contentBlocks)
        ? contentBlocks.some(block => block?.type === 'thinking')
        : false
      const hasResponsesReasoningInBlocks = Array.isArray(contentBlocks)
        ? contentBlocks.some(block => getResponsesOutputReasoningCount(block) > 0)
        : false

      if (!hasThinkingInBlocks && !hasResponsesReasoningInBlocks) {
        console.debug('[Chat] Legacy thinking_block present but no reasoning in content_blocks', {
          messageId: msg.id,
          role: msg.role,
          thinkingLength: legacyThinking.length,
          contentBlocksCount: Array.isArray(contentBlocks) ? contentBlocks.length : 0,
        })
      }
    }
  }

  return { toolCalls, contentBlocks }
}


function Chat() {
  const dispatch = useAppDispatch()
  const { userId } = useAuth()
  const navigate = useNavigate()
  const { ideContext, requestContext } = useIdeContext()
  const queryClient = useQueryClient()
  const htmlRegistry = useHtmlIframeRegistry()

  // Keep high-frequency keystrokes inside the input controller to avoid rerendering Chat.
  const inputControllerRef = useRef<ChatInputControllerHandle | null>(null)
  const [hasLocalInput, setHasLocalInput] = useState(false)
  const [addedIdeContexts, setAddedIdeContexts] = useState<AddedIdeContext[]>([])
  const chatSelection = useChatSelection()
  const selection = useAppSelector(state => state.chat.selection)
  const selectionRevisionRef = useRef(selection.revision)
  selectionRevisionRef.current = selection.revision
  const [pendingViewStream, setPendingViewStream] = useState<PendingViewStream | null>(null)
  const pendingViewStreamId = pendingViewStream?.streamId ?? null
  // Tool call whose persisted subagent transcript is open in the viewer modal (Phase 5).
  const [subagentTranscriptToolCallId, setSubagentTranscriptToolCallId] = useState<string | null>(null)

  const getLocalInput = useCallback(() => inputControllerRef.current?.getValue() ?? '', [])
  const updateLocalInput = useCallback((next: ChatInputUpdater) => {
    inputControllerRef.current?.setValue(next)
  }, [])
  const clearLocalInput = useCallback(() => {
    inputControllerRef.current?.clear()
    // The controller restores this draft when initialValue changes. Clear both copies
    // without inputCleared(), which would discard images before sendMessage captures them.
    dispatch(chatSliceActions.inputChanged({ content: '' }))
  }, [dispatch])
  const focusLocalInput = useCallback(() => {
    inputControllerRef.current?.focus()
  }, [])
  const handleAddToChat = useCallback((text: string) => {
    inputControllerRef.current?.appendFencedText(text)
  }, [])

  useEffect(() => {
    const handleFilePathInsert = (event: Event) => {
      const customEvent = event as CustomEvent<ChatInsertFilePathDetail>
      const nextPath = customEvent.detail?.path?.trim()
      if (!nextPath) return

      updateLocalInput(prev => (prev ? prev + ' ' + nextPath : nextPath))
      focusLocalInput()
    }

    window.addEventListener(CHAT_INSERT_FILE_PATH_EVENT, handleFilePathInsert as EventListener)

    return () => {
      window.removeEventListener(CHAT_INSERT_FILE_PATH_EVENT, handleFilePathInsert as EventListener)
    }
  }, [focusLocalInput, updateLocalInput])

  // Subscription status for free/paid detection
  const { isFreeUser } = useSubscriptionStatus(userId)

  const modelSelectFooter = isFreeUser ? (
    <div className='space-y-2'>
      {/* <div className='text-sm text-neutral-700 dark:text-neutral-200'>Subscribe now for access to all 400+ models</div> */}
      <Button
        variant='outline2'
        size='small'
        className='w-full text-[13px]  text-neutral-500 dark:text-neutral-200'
        onClick={() => navigate('/payment')}
      >
        Subscribe now for access to all 400+ models
      </Button>
    </div>
  ) : null


  // Working directory input for local agent flows
  const ccCwd = useAppSelector(selectCcCwd)
  const isCwdDirtyRef = useRef(false)
  const latestCcCwdRef = useRef('')
  const persistedCcCwdRef = useRef('')
  const cwdLoadSeqRef = useRef(0)
  const pendingManualExtensionSyncRef = useRef(false)
  const pendingCwdAnnouncementByConversationRef = useRef(new Map<string, string>())

  // Image generation configuration (aspect ratio and size for Gemini image models)
  const [imageConfig, setImageConfig] = useState<ImageConfig>({})

  const [chatReasoningSettings, setChatReasoningSettings] = useState(() => loadChatReasoningSettings())

  // Reasoning configuration (effort level for extended thinking models)
  const [reasoningConfig, setReasoningConfig] = useState<ReasoningConfig>(() => ({
    effort: chatReasoningSettings.defaultReasoningEffort,
  }))
  const fastServiceTierEnabled = useAppSelector(state =>
    (state.chat.composition.editingBranch ? state.chat.composition.branchEditModes?.fastMode : undefined)
      ?? resolveBranchFastMode(state.chat)
  )


  // Get conversation ID and project ID from URL params FIRST (before any hooks that depend on it)
  const { id: conversationIdParam, projectId: projectIdParam } = useParams<{
    id?: string
    projectId?: string
    lineageId?: string
  }>()
  const conversationIdFromUrl = conversationIdParam ? parseId(conversationIdParam) : null
  const projectIdFromUrl = projectIdParam === 'null' ? null : projectIdParam || null

  // Get storageMode from navigation state (passed from Heimdall when creating new chat)
  // This is CRITICAL for immediate routing to local server before cache is populated
  const location = useLocation()
  const storageModeFromNav = location.state?.storageMode as 'local' | 'cloud' | undefined

  // Provider settings from localStorage
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>(() => loadProviderSettings())

  const autoCompactionInFlightRef = useRef(false)

  // Redux selectors
  const currentUser = useAppSelector(selectCurrentUser)
  const providers = useAppSelector(selectProviderState)
  const branchModelSelection = useAppSelector(state => resolveBranchModelSelection(state.chat))
  const toolDefinitions = useAppSelector(state => state.chat.tools)
  // MCP tools with a UI resource draw the always-open app card (ToolCallGroupCard). The row
  // estimator needs the same distinction, or every plain MCP call is guessed 600px too tall.
  const isMcpAppTool = useMemo(() => {
    const names = new Set<string>()
    for (const tool of toolDefinitions) {
      if (tool.isMcp && tool.mcpUi?.resourceUri) names.add(tool.name)
    }
    return (toolName: string) => names.has(toolName)
  }, [toolDefinitions])
  const currentProviderSlug = (providers.currentProvider || '').toLowerCase().replace(/\s+/g, '')
  const isOpenAIChatGPTProvider = currentProviderSlug === 'openaichatgpt' || currentProviderSlug === 'openai(chatgpt)'
  const isOpenAIContextProvider = isOpenAIProvider(providers.currentProvider)
  const openAIServiceTier: OpenAIServiceTier | undefined =
    isOpenAIChatGPTProvider && fastServiceTierEnabled ? 'priority' : undefined
  const messageInput = useAppSelector(selectMessageInput)
  const operationMode = useAppSelector(state =>
    (state.chat.composition.editingBranch ? state.chat.composition.branchEditModes?.operationMode : undefined)
      ?? selectOperationMode(state)
  )
  // const canSendFromRedux = useAppSelector(selectCanSend)
  const sendingState = useAppSelector(selectSendingState)
  const currentConversationId = useAppSelector(selectCurrentConversationId)
  // Undismissed tier-2 failures for this conversation. Memoized + stable-empty, so a
  // conversation with no errors never produces a new array reference.
  const chatErrorRecords = useAppSelector(state => selectChatErrorsForConversation(state, currentConversationId))
  const snapshotConversationId = useAppSelector(state => state.chat.conversation.snapshotConversationId)

  /**
   * The one place a renderer-local rejection becomes something the user can see.
   *
   * Every `.unwrap()` catch in this container used to terminate in `console.error`, which is
   * invisible; several of them additionally cleared the optimistic message, so the user's own
   * typed text vanished with no explanation at all. Route them here instead: the raw
   * `Error.message` goes to `envelope.detail` (behind the Details disclosure) and the user reads
   * only `envelope.userMessage`.
   */
  const recordLocalChatError = useCallback(
    (
      error: unknown,
      ctx: {
        phase?: LocalChatErrorPhase
        code?: ChatErrorCode
        conversationId?: ConversationId | null
        parentMessageId?: MessageId | null
        streamId?: string | null
      } = {}
    ): ChatErrorEnvelope | null => {
      const conversationId = ctx.conversationId ?? currentConversationId
      if (conversationId == null) return null

      // The server-loop thunks classify and surface their own failures before rejecting.
      // Re-recording here produced the SECOND bubble users saw: this catch received
      // `envelope.userMessage` (already humanised prose), `classifyLocalChatError` could not
      // match it, and it fell back to `internal_error` — a generic "Try again" beside the
      // real, specific explanation. Trust the carried classification and add nothing.
      const rejection = readServerLoopRejection(error)
      if (rejection) return rejection.envelope

      const envelope = classifyLocalChatError(error, {
        phase: ctx.phase,
        code: ctx.code,
        streamId: ctx.streamId ?? null,
      })
      // A user pressing Stop is not a failure to explain. Classify it (callers branch on the
      // code) but never put a bubble on screen for something the user just asked for.
      if (envelope.code === 'cancelled') return envelope
      dispatch(
        chatSliceActions.chatErrorRecorded(
          buildChatErrorRecord(envelope, {
            conversationId,
            parentMessageId: ctx.parentMessageId ?? null,
            streamId: ctx.streamId ?? null,
          })
        )
      )
      return envelope
    },
    [currentConversationId, dispatch]
  )

  /**
   * Put a user's own typed text back in the composer after a send failed.
   *
   * The optimistic-message rows are cleared on rejection, which is correct (the message was
   * never persisted) but on its own it means the text the user typed is simply gone. Returning
   * it to the composer is the difference between "that failed, press send again" and "the app
   * ate my paragraph". Never clobbers text the user has already started typing since.
   */
  const restoreFailedSendText = useCallback(
    (text: string | null | undefined) => {
      const restored = text ?? ''
      if (!restored.trim()) return
      updateLocalInput(previous => {
        const existing = previous ?? ''
        if (!existing.trim()) return restored
        if (existing.includes(restored.trim())) return existing
        return `${restored}\n\n${existing}`
      })
      setHasLocalInput(true)
    },
    [updateLocalInput]
  )
  const streamUndoRoot = useAppSelector(selectStreamUndoRoot)
  const compactingConversationId = useAppSelector(state => state.chat.composition.compactingConversationId)
  const compactingParentMessageId = useAppSelector(state => state.chat.composition.compactingParentMessageId)
  const compactingLineageId = useAppSelector(state => state.chat.composition.compactingLineageId)
  const compactionSummaryMessageId = useAppSelector(state => state.chat.composition.compactionSummaryMessageId)
  const compactionViewPath = useAppSelector(selectCurrentPath)
  const compactionViewLineageId = useAppSelector(state => state.chat.conversation.currentLineageId)

  // Current view stream - automatically selects the relevant stream based on currentPath
  const currentViewStream = useAppSelector(selectCurrentViewStream)
  const pendingStreamState = useAppSelector(state =>
    pendingViewStreamId ? (state.chat.streaming.byId[pendingViewStreamId] ?? null) : null
  )
  const effectiveViewStream = useMemo(() => {
    if (selection.status === 'pending' || selection.status === 'error') return null
    if (currentViewStream) return currentViewStream
    if (!pendingViewStreamId || !pendingStreamState ||
        !isPendingViewStreamOwned(pendingViewStream, currentConversationId, selection, pendingStreamState)) return null
    return { id: pendingViewStreamId, ...pendingStreamState }
  }, [currentConversationId, currentViewStream, pendingViewStream, pendingViewStreamId, pendingStreamState, selection])
  // Derived streamState object for compatibility (combines current/effective view stream data)
  const streamState = useMemo(
    () => ({
      id: effectiveViewStream?.id ?? null,
      active: effectiveViewStream?.active ?? false,
      status: effectiveViewStream?.status ?? 'idle',
      compactionStatus: effectiveViewStream?.compactionStatus,
      buffer: effectiveViewStream?.buffer ?? '',
      thinkingBuffer: effectiveViewStream?.thinkingBuffer ?? '',
      toolCalls: effectiveViewStream?.toolCalls ?? [],
      events: effectiveViewStream?.events ?? [],
      messageId: effectiveViewStream?.messageId ?? null,
      branchAnchorMessageId: effectiveViewStream?.branchAnchorMessageId ?? null,
      liveMessageId: effectiveViewStream?.liveMessageId ?? effectiveViewStream?.streamingMessageId ?? null,
      lastCompletedMessageId: effectiveViewStream?.lastCompletedMessageId ?? null,
      persistedTurnMessageId: effectiveViewStream?.persistedTurnMessageId ?? null,
      finalMessageId: effectiveViewStream?.finalMessageId ?? null,
      error: effectiveViewStream?.error ?? null,
      finished: effectiveViewStream?.finished ?? false,
      streamingMessageId: effectiveViewStream?.streamingMessageId ?? effectiveViewStream?.liveMessageId ?? null,
    }),
    [effectiveViewStream]
  )

  useEffect(() => {
    if (!pendingViewStreamId) return

    // Keep the pending stream fallback alive for the full lifetime of the stream.
    // The branch-aware selector can briefly resolve the stream and then lose it again
    // before the branch path fully stabilizes for top-level sends/branches.
    // If we clear the fallback on the first selector match, the UI regresses back to
    // the idle/send state until the first real message lands.
    if (pendingStreamState && (!pendingStreamState.active || pendingStreamState.finished)) {
      setPendingViewStream(null)
    }
  }, [pendingStreamState, pendingViewStreamId])

  useEffect(() => {
    setPendingViewStream(null)
  }, [currentConversationId])

  useEffect(() => {
    if (currentConversationId == null) return
    dispatch(fetchConversationStreamUndo(currentConversationId))
  }, [currentConversationId, dispatch])

  // Refetch stream-edit undo summaries when a stream ends. Keyed on streamState.active going
  // false (not streamState.finished, which is unreachable in this view — the selector drops the
  // stream the tick it goes inactive).
  const prevStreamActiveForUndoRef = useRef(false)
  useEffect(() => {
    const wasActive = prevStreamActiveForUndoRef.current
    prevStreamActiveForUndoRef.current = streamState.active
    if (currentConversationId == null) return
    if (wasActive && !streamState.active) {
      dispatch(fetchConversationStreamUndo(currentConversationId))
    }
  }, [currentConversationId, dispatch, streamState.active])

  const conversationMessages = useAppSelector(selectConversationMessages)
  const displayMessages = useAppSelector(selectDisplayMessages)
  const compactionView = useMemo(() => ({
    conversationId: currentConversationId,
    lineageId: compactionViewLineageId,
    path: compactionViewPath,
    messages: conversationMessages,
  }), [currentConversationId, compactionViewLineageId, compactionViewPath, conversationMessages])
  const isCurrentBranchCompacting = sendingState.compacting && isCompactionVisibleFor({
    conversationId: compactingConversationId,
    parentMessageId: compactingParentMessageId,
    lineageId: compactingLineageId,
    summaryMessageId: compactionSummaryMessageId,
  }, compactionView)
  const canStopCompaction = isCurrentBranchCompacting
  const toolCallPermissionRequest = useAppSelector(state =>
    streamState.id
      ? (state.chat.toolPermissionRequestsByStream[streamState.id] ?? null)
      : null
  )
  const operationModeUpgradeRequest = useAppSelector(state =>
    streamState.id
      ? (state.chat.operationModeUpgradeRequestsByStream[streamState.id] ?? null)
      : null
  )
  const planClarificationRequest = useAppSelector(state =>
    streamState.id
      ? (state.chat.planClarificationRequestsByStream[streamState.id] ?? null)
      : null
  )
  const toolAutoApprove = useAppSelector(state => state.chat.toolAutoApprove)
  // D3: free-tier exhaustion is a chat bubble, not a blocking modal. `sseProjection` records the
  // `free_tier_exhausted` bubble directly on `generation_limit_reached` and never raises
  // `freeTier.showLimitModal`, so the flag is dead and the modal is not rendered from here.

  // React Query for message fetching - MOVED BELOW after projectConversations is available
  // to enable passing storage_mode from cached conversations
  const selectedPath = useAppSelector(selectCurrentPath)
  const modeChange = useAppSelector(state => {
    const change = state.chat.operationModeChanges?.[String(currentConversationId)]
    return streamState.active && change?.streamId === streamState.id ? change : undefined
  })
  const modeLineageId = useAppSelector(state => state.chat.conversation.currentLineageId)
  const [queueSubmitting, setQueueSubmitting] = useState(false)
  const queueRetryRef = useRef<{ streamId: string; content: string; requestId: string } | null>(null)
  const queueSubmittingRef = useRef(false)
  const [lastQueueStreamId, setLastQueueStreamId] = useState<string | null>(null)
  const queueStreamId = streamState.active ? streamState.id : lastQueueStreamId
  const queueBranchAnchor = useAppSelector(state => queueStreamId ? state.chat.streaming.byId[queueStreamId]?.currentBranchAnchorMessageId : null)
  const queuedMessages = useAppSelector(state => queueStreamId ? state.chat.messageQueues?.[queueStreamId] : undefined)
  useEffect(() => { setLastQueueStreamId(null) }, [currentConversationId])
  useEffect(() => {
    if (!streamState.active || !streamState.id || !currentConversationId) return
    setLastQueueStreamId(streamState.id)
    void dispatch(loadMessageQueue({ conversationId: currentConversationId, streamId: streamState.id }))
  }, [dispatch, currentConversationId, streamState.id, streamState.active])
  const isBranchEditing = useAppSelector(state => state.chat.composition.editingBranch)
  const handleOperationModeChange = useCallback((mode: 'plan' | 'execute') => {
    if (modeChange && !isBranchEditing) return
    void dispatch(changeOperationMode({
      mode, conversationId: currentConversationId,
      // Branch editing selects the new run's mode without interrupting the current run.
      streamId: streamState.active && !isBranchEditing ? streamState.id : null,
      parentId: selectedPath[selectedPath.length - 1] ?? null,
      lineageId: modeLineageId,
    }))
  }, [dispatch, currentConversationId, selectedPath, streamState.active, streamState.id, modeChange, modeLineageId, isBranchEditing])
  const handleToggleOperationMode = useCallback(() => {
    handleOperationModeChange(operationMode === 'plan' ? 'execute' : 'plan')
  }, [handleOperationModeChange, operationMode])
  const handleToggleFastServiceTier = useCallback(() => {
    if (!isOpenAIChatGPTProvider) return
    dispatch(chatSliceActions.branchFastModeSelected(!fastServiceTierEnabled))
  }, [dispatch, isOpenAIChatGPTProvider, fastServiceTierEnabled])
  const runningToolJobs = useRunningJobs()
  const multiReplyCount = useAppSelector(selectMultiReplyCount)

  // const streamingRoot = useAppSelector(state => state.chat.streaming)
  // const [streamDebugPanelOpen, setStreamDebugPanelOpen] = useState(true)

  const selectedPathStringSet = useMemo(() => new Set(selectedPath.map(id => String(id))), [selectedPath])

  // const selectedPathDebugLabel = useMemo(
  //   () => (selectedPath.length ? selectedPath.map(formatStreamDebugId).join(' → ') : '—'),
  //   [selectedPath]
  // )

  // const streamDebugRows = useMemo(() => {
  //   return Object.entries(streamingRoot.byId)
  //     .map(([id, stream]) => {
  //       const lastEvent = stream.events[stream.events.length - 1]
  //       const rootMessageId = stream.lineage.rootMessageId == null ? null : String(stream.lineage.rootMessageId)

  //       const lastEventLabel = (() => {
  //         if (!lastEvent) return '—'
  //         if (lastEvent.type === 'tool_call') return `tool:${lastEvent.toolCall?.name ?? 'call'}`
  //         if (lastEvent.type === 'tool_result') return 'tool_result'
  //         if (lastEvent.type === 'image') return 'image'
  //         if (lastEvent.type === 'reasoning') return 'reasoning'
  //         return 'text'
  //       })()

  //       return {
  //         id,
  //         active: stream.active,
  //         finished: stream.finished,
  //         error: stream.error,
  //         streamType: stream.streamType,
  //         conversationId: stream.conversationId == null ? null : String(stream.conversationId),
  //         isPrimary: streamingRoot.primaryStreamId === id,
  //         isCurrentView: currentViewStream?.id === id,
  //         rootInSelectedPath: rootMessageId != null && selectedPathStringSet.has(rootMessageId),
  //         rootMessageId,
  //         originMessageId: stream.lineage.originMessageId == null ? null : String(stream.lineage.originMessageId),
  //         parentStreamId: stream.lineage.parentStreamId ?? null,
  //         messageId: stream.messageId == null ? null : String(stream.messageId),
  //         streamingMessageId: stream.streamingMessageId == null ? null : String(stream.streamingMessageId),
  //         bufferLength: stream.buffer.length,
  //         thinkingLength: stream.thinkingBuffer.length,
  //         eventCount: stream.events.length,
  //         toolCallCount: stream.toolCalls.length,
  //         createdAt: stream.createdAt,
  //         lastEventLabel,
  //       }
  //     })
  //     .sort((a, b) => {
  //       if (a.isCurrentView !== b.isCurrentView) return a.isCurrentView ? -1 : 1
  //       if (a.active !== b.active) return a.active ? -1 : 1
  //       return b.createdAt.localeCompare(a.createdAt)
  //     })
  // }, [streamingRoot.byId, streamingRoot.primaryStreamId, currentViewStream?.id, selectedPathStringSet])

  // const matchingSelectedPathStreamCount = useMemo(
  //   () => streamDebugRows.filter(stream => stream.rootInSelectedPath).length,
  //   [streamDebugRows]
  // )

  // const ideContext = useAppSelector(selectIdeContext)
  const workspace = useAppSelector(selectWorkspace)
  const currentIdeSelection = useAppSelector(selectCurrentSelection)
  const extensions = useAppSelector(selectExtensions)
  const selectedExtensionId = useAppSelector(selectSelectedExtensionId)
  // const isIdeConnected = useAppSelector(selectIsIdeConnected)
  // const activeFile = useAppSelector(selectActiveFile)
  const selectedFilesForChat = useAppSelector(selectSelectedFilesForChat)
  // const mentionableFilesForDebug = useAppSelector(selectMentionableFiles)
  const optimisticMessage = useAppSelector(state => state.chat.composition.optimisticMessage)
  const imageDrafts = useAppSelector(state => state.chat.composition.imageDrafts)
  const imageDraftTarget = useAppSelector(state => state.chat.composition.imageDraftTarget)

  const composerImageDrafts = useMemo(
    () => (imageDraftTarget?.kind === 'composer' ? imageDrafts : []),
    [imageDrafts, imageDraftTarget]
  )
  const composerImageDraftDataUrls = useMemo(
    () => composerImageDrafts.map(draft => draft.dataUrl),
    [composerImageDrafts]
  )

  const getBranchImageDraftDataUrls = useCallback(
    (messageId: MessageId | string): string[] => {
      if (imageDraftTarget?.kind !== 'branch' || String(imageDraftTarget.messageId) !== String(messageId)) return []
      return imageDrafts.map(draft => draft.dataUrl)
    },
    [imageDrafts, imageDraftTarget]
  )

  const addCurrentIdeContextToMessage = useCallback((): boolean => {
    const selectedText = currentIdeSelection?.selectedText?.trim()
    const filePath = currentIdeSelection?.filePath || currentIdeSelection?.relativePath
    if (!selectedText || !filePath) return false

    const startLine = currentIdeSelection?.startLine ?? 0
    const endLine = currentIdeSelection?.endLine ?? startLine
    const fileName = filePath.split(/[\\/]/).pop() || filePath
    const id = `${filePath}:${startLine}-${endLine}:${selectedText}`

    let added = false
    setAddedIdeContexts(prev => {
      if (prev.some(item => item.id === id)) return prev
      added = true
      return [
        ...prev,
        {
          id,
          filePath,
          fileName,
          startLine,
          endLine,
          selectedText,
        },
      ]
    })

    return added
  }, [currentIdeSelection])

  const clearIdeContexts = useCallback(() => {
    setAddedIdeContexts([])
  }, [])

  const [activeBranchEditingMessageId, setActiveBranchEditingMessageId] = useState<string | null>(null)

  const handleMessageEditingStateChange = useCallback(
    (messageId: string, isEditing: boolean, mode: 'edit' | 'branch' | null) => {
      if (isEditing && mode === 'branch') {
        setActiveBranchEditingMessageId(messageId)
        return
      }

      setActiveBranchEditingMessageId(prev => (prev === messageId ? null : prev))
    },
    []
  )

  useEffect(() => {
    if (!isBranchEditing && activeBranchEditingMessageId) {
      setActiveBranchEditingMessageId(null)
    }
  }, [isBranchEditing, activeBranchEditingMessageId])

  const addedIdeContextItems = useMemo(
    () =>
      addedIdeContexts.map(item => ({
        id: item.id,
        label: `${item.fileName}:${item.startLine}-${item.endLine}`,
      })),
    [addedIdeContexts]
  )
  const optimisticBranchMessage = useAppSelector(state => state.chat.composition.optimisticBranchMessage)

  // File chip expanded modal state
  const [expandedFilePath, setExpandedFilePath] = useState<string | null>(null)
  // Temporary closing state to animate back to hover size before hiding
  const [closingFilePath, setClosingFilePath] = useState<string | null>(null)
  // Temporary opening state to blur content while expanding
  const [openingFilePath, setOpeningFilePath] = useState<string | null>(null)
  // Anchor position for fixed expanded panel (viewport coords)
  const [expandedAnchor, setExpandedAnchor] = useState<{ left: number; top: number } | null>(null)
  // Dynamic input area height for adaptive streaming/message padding
  const [inputAreaHeight, setInputAreaHeight] = useState(170)
  const [containerHeight, setContainerHeight] = useState(1100)
  // Credits refresh loading state
  // Todo list collapsed state
  const [todoListCollapsed, setTodoListCollapsed] = useState(false)
  const [workspaceMutationsCollapsed, setWorkspaceMutationsCollapsed] = useState(false)
  const [streamingThinkingIndicatorPlacement, setStreamingThinkingIndicatorPlacement] =
    useState<StreamingThinkingIndicatorPlacement>(getStoredStreamingThinkingIndicatorPlacement)
  // Tool jobs modal state
  const [jobsModalOpen, setJobsModalOpen] = useState(false)
  const [orchestratorEnabled, setOrchestratorEnabledState] = useState(() => isOrchestratorEnabled())
  const fullAccessEnabled = useSyncExternalStore(subscribeFullAccess, isFullAccessEnabled)
  // OpenRouter cloud-sign-in required modal state
  const [openRouterLoginRequiredModalOpen, setOpenRouterLoginRequiredModalOpen] = useState(false)
  // OpenAI ChatGPT login modal state
  const [openaiLoginModalOpen, setOpenaiLoginModalOpen] = useState(false)
  const [openaiAuthFlow, setOpenaiAuthFlow] = useState<{ url: string; verifier: string; state: string } | null>(null)
  // const [openaiCallbackInput, setOpenaiCallbackInput] = useState('')
  const [openaiAuthError, setOpenaiAuthError] = useState<string | null>(null)
  const [openaiAuthLoading, setOpenaiAuthLoading] = useState(false)
  const [openaiAuthPolling, setOpenaiAuthPolling] = useState(false)
  const [showOpenAIUsagePanel, setShowOpenAIUsagePanel] = useState(false)
  const [openAIUsageData, setOpenAIUsageData] = useState<OpenAIUsageSnapshot | null>(null)
  const [openAIUsageLoading, setOpenAIUsageLoading] = useState(false)
  const [openAIUsageError, setOpenAIUsageError] = useState<string | null>(null)

  const [benchEnabled, setBenchEnabled] = useState(false)
  const [benchStatusMessage, setBenchStatusMessage] = useState<string | null>(null)
  const benchStatusTimeoutRef = useRef<number | null>(null)
  const benchStartedAtRef = useRef<number | null>(null)
  const benchStoppedAtRef = useRef<number | null>(null)
  const benchLastRafTsRef = useRef<number | null>(null)
  const benchLastScrollEventTsRef = useRef<number>(0)
  const benchRafIdRef = useRef<number | null>(null)
  const benchEventsRef = useRef<BenchEvent[]>([])
  const benchCommitDurationsRef = useRef<number[]>([])
  const benchDeriveDurationsRef = useRef<number[]>([])
  const benchFrameDurationsRef = useRef<number[]>([])
  const benchScrollFrameDurationsRef = useRef<number[]>([])
  const benchLatestMessageCountRef = useRef(0)
  const benchLatestVirtualRowCountRef = useRef(0)
  const benchLatestConversationIdRef = useRef<string | null>(null)

  const themeDemoEnabledRef = useRef(false)
  const themeDemoIntervalRef = useRef<number | null>(null)
  const themeDemoApplyingRef = useRef(false)
  const themeDemoThemeIdsRef = useRef<string[]>([])
  const themeDemoThemeIndexRef = useRef(0)

  const composerSlashCommands = COMPOSER_SLASH_COMMANDS
  const isElectronEnv = useMemo(
    () =>
      import.meta.env.VITE_ENVIRONMENT === 'electron' ||
      (typeof window !== 'undefined' && (window as any).__IS_ELECTRON__),
    []
  )

  const appendBenchEvent = useCallback((kind: string, details?: Record<string, unknown>) => {
    const ts = typeof performance !== 'undefined' ? performance.now() : Date.now()
    pushLimitedEvent(benchEventsRef.current, { ts, kind, details })
  }, [])

  const clearBenchData = useCallback(() => {
    benchEventsRef.current = []
    benchCommitDurationsRef.current = []
    benchDeriveDurationsRef.current = []
    benchFrameDurationsRef.current = []
    benchScrollFrameDurationsRef.current = []
    benchLastRafTsRef.current = null
    benchLastScrollEventTsRef.current = 0
  }, [])

  const showBenchNotice = useCallback((message: string) => {
    setBenchStatusMessage(message)
    if (benchStatusTimeoutRef.current != null) {
      window.clearTimeout(benchStatusTimeoutRef.current)
    }
    benchStatusTimeoutRef.current = window.setTimeout(() => {
      setBenchStatusMessage(null)
      benchStatusTimeoutRef.current = null
    }, 6000)
  }, [])

  const setBenchEnabledState = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        clearBenchData()
        benchStartedAtRef.current = Date.now()
        benchStoppedAtRef.current = null
        appendBenchEvent('bench_started', {
          conversationId: currentConversationId != null ? String(currentConversationId) : null,
        })
        setBenchEnabled(true)
        showBenchNotice('Benchmark enabled. Use /bench export to save logs.')
        return
      }

      if (benchEnabled) {
        appendBenchEvent('bench_stopped')
      }
      benchStoppedAtRef.current = Date.now()
      setBenchEnabled(false)
      showBenchNotice('Benchmark disabled.')
    },
    [appendBenchEvent, benchEnabled, clearBenchData, currentConversationId, showBenchNotice]
  )

  const createBenchReport = useCallback(() => {
    const now = Date.now()
    const startedAt = benchStartedAtRef.current
    const stoppedAt = benchStoppedAtRef.current
    const endedAt = benchEnabled ? now : (stoppedAt ?? now)

    const durationMs = startedAt != null ? Math.max(0, endedAt - startedAt) : 0

    return {
      exportedAtIso: new Date(now).toISOString(),
      benchmark: {
        active: benchEnabled,
        startedAtIso: startedAt != null ? new Date(startedAt).toISOString() : null,
        stoppedAtIso: stoppedAt != null ? new Date(stoppedAt).toISOString() : null,
        durationMs,
      },
      environment: {
        mode: import.meta.env.VITE_ENVIRONMENT,
        electron: isElectronEnv,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
        platform: typeof navigator !== 'undefined' ? navigator.platform : 'unknown',
        hardwareConcurrency: typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? null) : null,
        deviceMemory: typeof navigator !== 'undefined' ? ((navigator as any).deviceMemory ?? null) : null,
      },
      conversation: {
        id: benchLatestConversationIdRef.current,
        messageCount: benchLatestMessageCountRef.current,
        virtualRowCount: benchLatestVirtualRowCountRef.current,
      },
      summary: {
        renderFrameMs: calculateBenchStats(benchFrameDurationsRef.current),
        scrollFrameMs: calculateBenchStats(benchScrollFrameDurationsRef.current),
        scrollFps:
          benchScrollFrameDurationsRef.current.length > 0
            ? calculateBenchStats(benchScrollFrameDurationsRef.current.map(ms => (ms > 0 ? 1000 / ms : 0)))
            : null,
        commitDurationMs: calculateBenchStats(benchCommitDurationsRef.current),
        deriveDurationMs: calculateBenchStats(benchDeriveDurationsRef.current),
      },
      sampleCounts: {
        events: benchEventsRef.current.length,
        renderFrames: benchFrameDurationsRef.current.length,
        scrollFrames: benchScrollFrameDurationsRef.current.length,
        commits: benchCommitDurationsRef.current.length,
        derives: benchDeriveDurationsRef.current.length,
      },
      samples: {
        renderFrameMs: benchFrameDurationsRef.current,
        scrollFrameMs: benchScrollFrameDurationsRef.current,
        commitDurationMs: benchCommitDurationsRef.current,
        deriveDurationMs: benchDeriveDurationsRef.current,
      },
      events: benchEventsRef.current,
    }
  }, [benchEnabled, isElectronEnv])

  const exportBenchReport = useCallback(async () => {
    const report = createBenchReport()
    const payload = JSON.stringify(report, null, 2)
    const fileName = `chat-bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`

    try {
      const electronApi = (window as any).electronAPI
      if (electronApi?.dialog?.saveFile && electronApi?.fs?.writeFile) {
        const result = await electronApi.dialog.saveFile({
          title: 'Export Chat Benchmark',
          defaultPath: fileName,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        })

        if (result?.success && result?.filePath) {
          const writeResult = await electronApi.fs.writeFile(result.filePath, payload, 'utf8')
          if (writeResult?.success === false) {
            throw new Error(writeResult?.error || 'Failed to write benchmark file')
          }
          appendBenchEvent('bench_exported', { mode: 'electron', filePath: result.filePath })
          showBenchNotice(`Benchmark exported: ${result.filePath}`)
          return true
        }
      }

      const blob = new Blob([payload], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = fileName
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      appendBenchEvent('bench_exported', { mode: 'browser-download', fileName })
      showBenchNotice(`Benchmark exported: ${fileName}`)
      return true
    } catch (error) {
      console.error('Failed to export benchmark report:', error)
      appendBenchEvent('bench_export_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      showBenchNotice('Benchmark export failed. Check console for details.')
      return false
    }
  }, [appendBenchEvent, createBenchReport, showBenchNotice])

  const handleBenchAction = useCallback(
    async (action: BenchAction): Promise<ComposerSlashCommandResult> => {
      switch (action) {
        case 'on':
          setBenchEnabledState(true)
          return { handled: true, clearInput: true }
        case 'off':
          setBenchEnabledState(false)
          return { handled: true, clearInput: true }
        case 'reset':
          clearBenchData()
          benchStartedAtRef.current = benchEnabled ? Date.now() : null
          benchStoppedAtRef.current = null
          appendBenchEvent('bench_reset', { active: benchEnabled })
          showBenchNotice('Benchmark samples reset.')
          return { handled: true, clearInput: true }
        case 'export':
          await exportBenchReport()
          return { handled: true, clearInput: true }
        case 'status':
        default: {
          const startedAt = benchStartedAtRef.current
          const stoppedAt = benchStoppedAtRef.current
          const endedAt = benchEnabled ? Date.now() : (stoppedAt ?? Date.now())
          const durationSeconds = startedAt != null ? Math.round((endedAt - startedAt) / 1000) : 0
          showBenchNotice(
            `Bench ${benchEnabled ? 'ON' : 'OFF'} • commits: ${benchCommitDurationsRef.current.length} • derives: ${benchDeriveDurationsRef.current.length} • duration: ${durationSeconds}s`
          )
          return { handled: true, clearInput: true }
        }
      }
    },
    [appendBenchEvent, benchEnabled, clearBenchData, exportBenchReport, setBenchEnabledState, showBenchNotice]
  )

  const clearThemeDemoInterval = useCallback(() => {
    if (themeDemoIntervalRef.current != null) {
      window.clearInterval(themeDemoIntervalRef.current)
      themeDemoIntervalRef.current = null
    }
  }, [])

  const stopThemeDemo = useCallback(() => {
    clearThemeDemoInterval()
    themeDemoEnabledRef.current = false
    themeDemoApplyingRef.current = false
    themeDemoThemeIdsRef.current = []
    themeDemoThemeIndexRef.current = 0
  }, [clearThemeDemoInterval])

  const applyThemeById = useCallback(async (themeId: string): Promise<boolean> => {
    try {
      const data = await executeToolAndWait<ThemeManagerReadResult>({
        toolName: 'theme_manager',
        args: {
          action: 'read',
          name: themeId,
        },
      })

      const result = data?.result
      if (!result?.success || !result.exists || !result.theme) {
        console.warn('[ThemeDemo] Theme read failed', {
          themeId,
          error: result?.error,
        })
        return false
      }

      saveCustomChatTheme(result.theme)
      setCustomChatThemeEnabled(true)
      return true
    } catch (error) {
      console.warn('[ThemeDemo] Failed to apply theme', {
        themeId,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }, [])

  const runThemeDemoTick = useCallback(async () => {
    if (!themeDemoEnabledRef.current || themeDemoApplyingRef.current) return

    const themeIds = themeDemoThemeIdsRef.current
    if (themeIds.length === 0) {
      stopThemeDemo()
      return
    }

    const index = themeDemoThemeIndexRef.current % themeIds.length
    const themeId = themeIds[index]

    themeDemoApplyingRef.current = true
    try {
      await applyThemeById(themeId)
      if (themeDemoEnabledRef.current) {
        themeDemoThemeIndexRef.current = (index + 1) % themeIds.length
      }
    } finally {
      themeDemoApplyingRef.current = false
    }
  }, [applyThemeById, stopThemeDemo])

  const handleThemeDemoAction = useCallback(
    async (action: ThemeDemoAction): Promise<ComposerSlashCommandResult> => {
      if (action === 'off') {
        stopThemeDemo()
        return { handled: true, clearInput: true }
      }

      stopThemeDemo()

      try {
        const data = await executeToolAndWait<ThemeManagerListResult>({
          toolName: 'theme_manager',
          args: {
            action: 'list',
          },
        })

        const result = data?.result
        if (!result?.success) {
          console.warn('[ThemeDemo] Unable to list custom themes', result?.error)
          return { handled: true, clearInput: true }
        }

        const themeIds = (result.themes || []).map(theme => theme.id).filter(Boolean)
        if (themeIds.length === 0) {
          console.warn('[ThemeDemo] No saved custom themes available to cycle.')
          return { handled: true, clearInput: true }
        }

        themeDemoThemeIdsRef.current = themeIds
        themeDemoThemeIndexRef.current = 0
        themeDemoEnabledRef.current = true

        await runThemeDemoTick()

        if (themeDemoEnabledRef.current) {
          themeDemoIntervalRef.current = window.setInterval(() => {
            void runThemeDemoTick()
          }, THEME_DEMO_INTERVAL_MS)
        }
      } catch (error) {
        console.warn('[ThemeDemo] Failed to start theme demo', error)
        stopThemeDemo()
      }

      return { handled: true, clearInput: true }
    },
    [runThemeDemoTick, stopThemeDemo]
  )

  const handleManualCompactifyCommand = useCallback(async (): Promise<ComposerSlashCommandResult> => {
    if (!currentConversationId) {
      console.warn('[ManualCompaction] skipped: missing conversation id')
      return { handled: true, clearInput: true }
    }

    const compactingCurrentConversation =
      sendingState.compacting &&
      compactingConversationId != null &&
      String(compactingConversationId) === String(currentConversationId)

    if (streamState.active || compactingCurrentConversation || autoCompactionInFlightRef.current) {
      console.warn('[ManualCompaction] skipped: generation or compaction already active', {
        streamActive: streamState.active,
        compactingCurrentConversation,
        inFlight: autoCompactionInFlightRef.current,
      })
      return { handled: true, clearInput: true }
    }

    const latestCompaction = (() => {
      for (let i = displayMessages.length - 1; i >= 0; i--) {
        const message = displayMessages[i]
        if (isCommittedCompaction(message)) {
          return { index: i, message }
        }
      }
      return { index: -1, message: null as Message | null }
    })()

    const compactionSourceMessages = (
      latestCompaction.index >= 0 ? displayMessages.slice(latestCompaction.index + 1) : displayMessages
    ).filter(Boolean)

    const lastMessage = displayMessages[displayMessages.length - 1]
    if (!lastMessage || isCommittedCompaction(lastMessage) || compactionSourceMessages.length < 2) {
      console.warn('[ManualCompaction] skipped: insufficient source context', {
        hasLastMessage: Boolean(lastMessage),
        lastIsCompaction: isCommittedCompaction(lastMessage),
        sourceCount: compactionSourceMessages.length,
      })
      return { handled: true, clearInput: true }
    }

    autoCompactionInFlightRef.current = true
    try {
      const compactionResult = await dispatch(
        compactBranch({
          conversationId: currentConversationId,
          parentMessageId: lastMessage.id,
          messages: compactionSourceMessages,
          providerName: providerSettings.compactionProvider || providers.currentProvider,
          modelName: providerSettings.compactionModel || null,
        })
      ).unwrap()

      const compactedMessage = compactionResult?.message ?? null
      const hasValidCompactionMarker = isCommittedCompaction(compactedMessage)

      if (!compactedMessage || !hasValidCompactionMarker) {
        console.error('[ManualCompaction] invalid summary message returned')
      }
    } catch (error) {
      console.error('[ManualCompaction] compactBranch failed:', error)
    } finally {
      autoCompactionInFlightRef.current = false
    }

    return { handled: true, clearInput: true }
  }, [
    compactingConversationId,
    currentConversationId,
    dispatch,
    displayMessages,
    providerSettings.compactionModel,
    providerSettings.compactionProvider,
    providers.currentProvider,
    sendingState.compacting,
    streamState.active,
  ])

  const runComposerCommand = useCallback(
    async (rawCommand: string): Promise<ComposerSlashCommandResult> => {
      const normalized = rawCommand.trim().toLowerCase().replace(/^\/+/, '')
      if (normalized === 'status-openai') {
        setShowOpenAIUsagePanel(true)
        setOpenAIUsageLoading(true)
        setOpenAIUsageError(null)

        void (async () => {
          const result = await fetchOpenAIUsageStatus()
          if (result.type === 'success') {
            setOpenAIUsageData(result.data)
            setOpenAIUsageError(null)
          } else {
            setOpenAIUsageData(null)
            setOpenAIUsageError(result.error)
          }
          setOpenAIUsageLoading(false)
        })()

        return { handled: true, clearInput: true }
      }

      if ((normalized === 'compact' || normalized === 'compactify')) {
        return handleManualCompactifyCommand()
      }

      const benchAction = parseBenchAction(rawCommand)
      if (benchAction) {
        return handleBenchAction(benchAction)
      }

      const themeDemoAction = parseThemeDemoAction(rawCommand)
      if (themeDemoAction) {
        return handleThemeDemoAction(themeDemoAction)
      }

      return { handled: false }
    },
    [handleBenchAction, handleManualCompactifyCommand, handleThemeDemoAction]
  )

  useEffect(() => {
    return () => {
      if (benchStatusTimeoutRef.current != null) {
        window.clearTimeout(benchStatusTimeoutRef.current)
      }
      stopThemeDemo()
    }
  }, [stopThemeDemo])

  // useEffect(() => {
  //   if (!isElectronEnv) return

  //   const sample = mentionableFilesForDebug.slice(0, 10).map(file => ({
  //     kind: file.kind,
  //     name: file.name,
  //     relativePath: file.relativePath,
  //     relativeDirectoryPath: file.relativeDirectoryPath,
  //     absolutePath: file.path,
  //   }))

  //   const withDirectoryCount = mentionableFilesForDebug.filter(file => Boolean(file.relativeDirectoryPath)).length

  //   console.log('[IDE DEBUG][Chat mentionable files for @]', {
  //     workspaceName: workspace?.name ?? null,
  //     workspaceRootPath: workspace?.rootPath ?? null,
  //     allFilesCount: ideContext.allFiles?.length ?? 0,
  //     mentionableFilesCount: mentionableFilesForDebug.length,
  //     mentionableFilesWithDirectoryCount: withDirectoryCount,
  //     sample,
  //   })
  // }, [isElectronEnv, mentionableFilesForDebug, workspace?.name, workspace?.rootPath, ideContext.allFiles])

  const handleCloseExpandedPreview = useCallback(() => {
    if (!expandedFilePath) return
    const path = expandedFilePath
    setExpandedFilePath(null)
    setClosingFilePath(path)
    window.setTimeout(() => setClosingFilePath(null), EXPANDED_FILE_PREVIEW_EXIT_MS)
  }, [expandedFilePath])

  const escapeRegExp = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  const handleRemoveFileSelection = useCallback(
    (file: { path: string; relativePath: string; name?: string }) => {
      // Remove from selected files in Redux
      dispatch(removeSelectedFileForChat(file.path))

      // Also remove the textual @mention from the local input value
      const mentionName = file.name || file.path.split('/').pop() || file.relativePath.split('/').pop() || ''
      if (mentionName) {
        const mentionRegex = new RegExp(`@${escapeRegExp(mentionName)}(\\b|$)\\s*`, 'g')
        updateLocalInput(prev => prev.replace(mentionRegex, ''))
      }
    },
    [dispatch, updateLocalInput]
  )

  const replaceFileMentionsWithPath = useCallback(
    // Renamed for clarity; revert if preferred.
    (message: string): string => {
      // Input: a string message. Output: modified string with full paths inserted.
      if (!message || typeof message !== 'string') return message || '' // Early return for invalid/empty input.

      // Build a lookup map of mentionable names -> full paths (changed from contents).
      const nameToPath = new Map<string, string>() // Renamed Map for clarity.

      // Populate the Map from selected files (assuming selectedFilesForChat is SelectedFileContent[]).
      // Adds basename, relative path, absolute path, and normalized slash variants so selector-inserted
      // mentions resolve consistently in both IDE and local fallback modes.
      for (const f of selectedFilesForChat) {
        addFileMentionLookupKeys(nameToPath, f.name, f.path)
        addFileMentionLookupKeys(nameToPath, f.relativePath, f.path)
        addFileMentionLookupKeys(nameToPath, f.path, f.path)
      }

      // Replace mentions in the message.
      // Regex: Matches @ followed by alphanumeric, dot (.), underscore (_), slash (/), dash (-).
      const mentionRegex = /@([A-Za-z0-9._\/-]+)/g // 'g' flag for global replacement.
      return message.replace(mentionRegex, (full: string, mName: string) => {
        // For each match: Look up full path by captured name (mName).
        // If found, replace with path; otherwise, keep original.
        const path = nameToPath.get(mName)
        return path != null ? path : full
      })
    },
    [selectedFilesForChat] // Dependency array: Re-creates if selectedFilesForChat changes.
  )

  const appendIdeContextToMessage = useCallback(
    (message: string): string => {
      if (!message || typeof message !== 'string') return message || ''

      const currentPath = currentIdeSelection?.filePath || currentIdeSelection?.relativePath || ''
      const currentText = currentIdeSelection?.selectedText?.trim() || ''
      const currentStart = currentIdeSelection?.startLine ?? 0
      const currentEnd = currentIdeSelection?.endLine ?? currentStart
      const currentFileName = currentPath ? currentPath.split(/[\\/]/).pop() || currentPath : ''

      const contexts: AddedIdeContext[] = [...addedIdeContexts]
      if (currentPath && currentText) {
        const currentId = `${currentPath}:${currentStart}-${currentEnd}:${currentText}`
        if (!contexts.some(item => item.id === currentId)) {
          contexts.push({
            id: currentId,
            filePath: currentPath,
            fileName: currentFileName,
            startLine: currentStart,
            endLine: currentEnd,
            selectedText: currentText,
          })
        }
      }

      if (contexts.length === 0) return message

      const footer = contexts
        .map((ctx, index) =>
          [
            `[${index + 1}] IDE context: ${ctx.filePath}`,
            `IDE file: ${ctx.fileName}`,
            `IDE selection lines: ${ctx.startLine}-${ctx.endLine}`,
            'IDE selected text:',
            '```',
            ctx.selectedText,
            '```',
          ].join('\n')
        )
        .join('\n\n')

      const ideContextFooter = `IDE contexts:\n${footer}`
      if (message.includes(ideContextFooter)) return message

      return `${message.trimEnd()}\n\n${ideContextFooter}`
    },
    [currentIdeSelection, addedIdeContexts]
  )

  // Ref for auto-scroll
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  // Track if the user manually scrolled during the current stream; disables bottom pin until finished
  const userScrolledDuringStreamRef = useRef<boolean>(false)
  const streamActiveRef = useRef<boolean>(false)
  const finalTextStreamingStartedRef = useRef<boolean>(false)
  const liveStreamingContentRef = useRef<HTMLDivElement>(null)
  const skippedInitialLiveTailFollowRef = useRef<boolean>(false)
  // Sentinel at the end of the list for robust bottom scrolling
  const bottomRef = useRef<HTMLDivElement>(null)
  // rAF id to coalesce frequent scroll requests during streaming
  const scrollRafRef = useRef<number | null>(null)
  // Track the most visible text-response message ID for Heimdall highlighting.
  // When the viewport moves over tool/reasoning-only rows, keep this sticky ref
  // pointing at the previous eligible message until the next text response appears.
  const [visibleMessageId, setVisibleMessageId] = useState<MessageId | null>(null)
  const lastVisibleTextMessageIdRef = useRef<MessageId | null>(null)
  const [showScrollToBottomButton, setShowScrollToBottomButton] = useState(false)
  const updateVisibleMessageRef = useRef<(() => void) | null>(null)
  // Ref for input area to measure its height dynamically
  const inputAreaRef = useRef<HTMLDivElement>(null)

  const attachmentInputRef = useRef<HTMLInputElement>(null)

  // Track if we already applied URL-driven selection to avoid overriding later user branch switches.
  const handledSelectionScrollRef = useRef<string | null>(null)


  // Lock page scroll while chat is mounted
  useEffect(() => {
    const prevDocOverflow = document.documentElement.style.overflow
    const prevBodyOverflow = document.body.style.overflow
    document.documentElement.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
    return () => {
      document.documentElement.style.overflow = prevDocOverflow
      document.body.style.overflow = prevBodyOverflow
    }
  }, [])

  // Measure input area height dynamically with ResizeObserver
  // useEffect(() => {
  //   const inputArea = inputAreaRef.current
  //   if (!inputArea) return

  //   const observer = new ResizeObserver(entries => {
  //     for (const entry of entries) {
  //       let height = entry.contentRect.height
  //       // Use borderBoxSize if available for more accurate height including padding/borders
  //       if (entry.borderBoxSize && entry.borderBoxSize.length > 0) {
  //         height = entry.borderBoxSize[0].blockSize
  //       }

  //       // Add margin
  //       const style = window.getComputedStyle(inputArea)
  //       const marginBottom = parseFloat(style.marginBottom) || 0

  //       // if (height > 0) {
  //       //   setInputAreaHeight(height + marginBottom)
  //       // }
  //     }
  //   })

  //   observer.observe(inputArea)

  //   // Initial measurement
  //   const rect = inputArea.getBoundingClientRect()
  //   const style = window.getComputedStyle(inputArea)
  //   const marginBottom = parseFloat(style.marginBottom) || 0
  //   if (rect.height > 0) {
  //     setInputAreaHeight(rect.height + marginBottom)
  //   }

  //   return () => {
  //     observer.disconnect()
  //   }
  // }, [])

  // Measure input area height dynamically so live streamed messages can stop above
  // the absolutely-positioned composer instead of being hidden behind it.
  useEffect(() => {
    const inputArea = inputAreaRef.current
    if (!inputArea) return

    const measure = () => {
      const rect = inputArea.getBoundingClientRect()
      const style = window.getComputedStyle(inputArea)
      const marginBottom = parseFloat(style.marginBottom) || 0
      const nextHeight = Math.ceil(rect.height + marginBottom)
      if (nextHeight > 0) {
        setInputAreaHeight(prev => (Math.abs(prev - nextHeight) > 1 ? nextHeight : prev))
      }
    }

    const observer = new ResizeObserver(measure)
    observer.observe(inputArea)
    measure()

    return () => {
      observer.disconnect()
    }
  }, [])

  // Measure messages container height dynamically
  useEffect(() => {
    const container = messagesContainerRef.current
    if (!container) return

    const observer = new ResizeObserver(() => {
      setContainerHeight(container.clientHeight)
    })

    observer.observe(container)

    // Initial measurement
    if (container.clientHeight > 0) {
      setContainerHeight(container.clientHeight)
    }

    return () => {
      observer.disconnect()
    }
  }, [])

  // Keep persisted image-reference notices in the transcript alongside other automated rows.
  const renderableMessages = useMemo(() => {
    return displayMessages.filter(msg => msg && msg.id != null && !isHiddenCompactionMessage(msg))
  }, [displayMessages])

  const conversationRuns = useConversationRunStatistics(conversationIdFromUrl == null ? null : String(conversationIdFromUrl))
  const runFooters = useMemo(() => deriveRunStatistics(conversationMessages, selectedPath, conversationRuns,
    currentConversationId == null ? null : String(currentConversationId), modeLineageId),
    [conversationMessages, selectedPath, conversationRuns, currentConversationId, modeLineageId])
  const runFootersByAnchor = useMemo(() => placeRunFooters(runFooters, selectedPath, renderableMessages.map(m => String(m.id))),
    [runFooters, selectedPath, renderableMessages])
  const runBoundarySignature = [...runFootersByAnchor.keys()].join('|')

  const [groupToolReasoningRuns, setGroupToolReasoningRuns] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem('chat:groupToolReasoningRuns')
      return stored === null ? true : stored === 'true'
    } catch {
      return true
    }
  })
  const [truncateToolOutput, setTruncateToolOutput] = useState<boolean>(loadToolOutputTruncationEnabled)

  const virtualizationMetricsRef = useRef<{
    lastRowDeriveMs: number
    lastRenderRowsCount: number
  }>({ lastRowDeriveMs: 0, lastRenderRowsCount: 0 })

  const parsedMessageDataCacheRef = useRef<Map<string, Map<MessageId, ParsedMessageData>>>(new Map())
  const messageRenderRowsCacheRef = useRef<Map<string, MessageRenderRow[]>>(new Map())

  const renderableMessagesSignature = useMemo(
    () =>
      renderableMessages
        .map(msg => {
          const updatedAt = (msg as Message & { updated_at?: string }).updated_at ?? msg.created_at
          const artifactCount = Array.isArray(msg.artifacts) ? msg.artifacts.length : 0
          const contentHash = hashStringForRenderCache(msg.content ?? '')
          const contentBlocksHash = hashUnknownForRenderCache(msg.content_blocks)
          const toolCallsHash = hashUnknownForRenderCache(msg.tool_calls)
          const thinkingHash = hashStringForRenderCache(msg.thinking_block ?? '')
          const noteHash = hashStringForRenderCache(`${msg.note ?? ''}:${msg.note_color ?? ''}`)
          const hookRunsHash = hashStringForRenderCache(getHookRunsRenderSignature(msg.hook_runs))
          return `${msg.id}:${msg.role}:${updatedAt}:a${artifactCount}:c${contentHash}:b${contentBlocksHash}:t${toolCallsHash}:r${thinkingHash}:n${noteHash}:h${hookRunsHash}`
        })
        .join('|'),
    [renderableMessages]
  )

  // Parse message payloads once per message-list change so row props remain stable while typing.
  const parsedMessageDataById = useMemo(() => {
    const cacheKey = renderableMessagesSignature
    const cached = parsedMessageDataCacheRef.current.get(cacheKey)
    if (cached) return cached

    const parsedById = new Map<MessageId, ParsedMessageData>()
    for (const msg of renderableMessages) {
      parsedById.set(msg.id, isCommittedCompaction(msg) ? EMPTY_PARSED_MESSAGE_DATA : parseMessageDataForRender(msg))
    }

    setLimitedCacheEntry(parsedMessageDataCacheRef.current, cacheKey, parsedById)
    return parsedById
  }, [renderableMessages, renderableMessagesSignature])

  const messageRenderRows = useMemo<MessageRenderRow[]>(() => {
    const deriveStart = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const debugProcessGrouping =
      typeof window !== 'undefined' && window.localStorage.getItem('chat:debugProcessGrouping') === 'true'

    const rowsCacheKey = `${groupToolReasoningRuns ? 'grouped' : 'plain'}|${renderableMessagesSignature}|${runBoundarySignature}`
    if (!debugProcessGrouping) {
      const cachedRows = messageRenderRowsCacheRef.current.get(rowsCacheKey)
      if (cachedRows) {
        virtualizationMetricsRef.current = {
          lastRowDeriveMs: 0,
          lastRenderRowsCount: cachedRows.length,
        }
        return cachedRows
      }
    }

    const hasResponsesOutputItems = (parsed: ParsedMessageData): boolean =>
      Array.isArray(parsed.contentBlocks)
        ? parsed.contentBlocks.some(
            block => (block as unknown as Record<string, unknown>).type === 'responses_output_items'
          )
        : false

    const hasSubstantialTextOrImage = (msg: Message, parsed: ParsedMessageData): boolean => {
      if (hasTrailingAgentProse(parsed.contentBlocks ?? [])) return true
      if (!parsed.contentBlocks?.some(block => block.type === 'text') && msg.content?.trim()) return true
      if (
        typeof msg.content === 'string' &&
        msg.content.trim().length > 0 &&
        !isLikelyProcessAnnotationText(msg.content)
      ) {
        return true
      }

      if (Array.isArray(parsed.contentBlocks)) {
        return parsed.contentBlocks.some(block => {
          if (block.type === 'text') {
            return (
              typeof block.content === 'string' &&
              block.content.trim().length > 0 &&
              !isLikelyProcessAnnotationText(block.content)
            )
          }
          if (block.type === 'image') {
            return Boolean(block.url)
          }
          // Context is projected below the collapsed history, so it no longer splits a run.
          if (block.type === 'context_injection') return false
          // Errors must remain visible outside process groups.
          if (block.type === 'error') return true

          const responseTexts = getResponsesOutputAssistantTexts(block)
          return responseTexts.some(text => text.trim().length > 0 && !isLikelyProcessAnnotationText(text))
        })
      }

      return false
    }

    const hasProcessSignal = (msg: Message, parsed: ParsedMessageData): boolean => {
      const hasThinking = typeof msg.thinking_block === 'string' && msg.thinking_block.trim().length > 0
      const hasToolCalls = Array.isArray(parsed.toolCalls) && parsed.toolCalls.length > 0
      const hasProcessBlocks = Array.isArray(parsed.contentBlocks)
        ? parsed.contentBlocks.some(block => isProcessContentBlock(block))
        : false

      return hasThinking || hasToolCalls || hasProcessBlocks
    }

    const countToolSignals = (parsed: ParsedMessageData): number => {
      const parsedToolCalls = Array.isArray(parsed.toolCalls) ? parsed.toolCalls.length : 0
      if (parsedToolCalls > 0) return parsedToolCalls

      return Array.isArray(parsed.contentBlocks)
        ? parsed.contentBlocks.filter(block => block.type === 'tool_use').length
        : 0
    }

    const countReasoningSignals = (msg: Message, parsed: ParsedMessageData): number => {
      if (!Array.isArray(parsed.contentBlocks) || parsed.contentBlocks.length === 0) {
        return typeof msg.thinking_block === 'string' && msg.thinking_block.trim().length > 0 ? 1 : 0
      }

      const thinkingBlockCount = parsed.contentBlocks.filter(block => block.type === 'thinking').length
      if (thinkingBlockCount > 0) {
        return thinkingBlockCount
      }

      const responsesOutputReasoningCount = parsed.contentBlocks.reduce(
        (count, block) => count + getResponsesOutputReasoningCount(block),
        0
      )

      if (responsesOutputReasoningCount > 0) return responsesOutputReasoningCount

      return typeof msg.thinking_block === 'string' && msg.thinking_block.trim().length > 0 ? 1 : 0
    }

    const isProcessOnlyAssistantStep = (msg: Message): boolean => {
      if (isCommittedCompaction(msg)) return false
      if (msg.role !== 'assistant' && msg.role !== 'ex_agent') {
        return false
      }

      const parsed = parsedMessageDataById.get(msg.id) ?? EMPTY_PARSED_MESSAGE_DATA
      if (!hasProcessSignal(msg, parsed) && !msg.hook_runs?.length && !parsed.contentBlocks?.some(block => block.type === 'context_injection')) {
        return false
      }

      if (hasSubstantialTextOrImage(msg, parsed) || hasExcludedGroupingTool(parsed)) {
        return false
      }

      return true
    }

    if (!groupToolReasoningRuns) {
      const plainRows = renderableMessages.map(msg => ({
        kind: 'message' as const,
        id: msg.id,
        message: msg,
      }))

      if (!debugProcessGrouping) {
        setLimitedCacheEntry(messageRenderRowsCacheRef.current, rowsCacheKey, plainRows)
      }

      const deriveEnd = typeof performance !== 'undefined' ? performance.now() : Date.now()
      virtualizationMetricsRef.current = {
        lastRowDeriveMs: Math.max(0, deriveEnd - deriveStart),
        lastRenderRowsCount: plainRows.length,
      }
      return plainRows
    }

    const rows: MessageRenderRow[] = []
    let index = 0

    while (index < renderableMessages.length) {
      const msg = renderableMessages[index]
      if (!msg) {
        index += 1
        continue
      }

      if (!isProcessOnlyAssistantStep(msg)) {
        rows.push({
          kind: 'message',
          id: msg.id,
          message: msg,
        })
        index += 1
        continue
      }

      const runMessages: Message[] = []
      let cursor = index
      while (cursor < renderableMessages.length) {
        const candidate = renderableMessages[cursor]
        if (!candidate || !isProcessOnlyAssistantStep(candidate)) {
          break
        }
        runMessages.push(candidate)
        cursor += 1
        if (runFootersByAnchor.has(String(candidate.id))) break
      }

      if (runMessages.length >= CROSS_MESSAGE_PROCESS_GROUP_MIN_MESSAGES) {
        const memberMessageIds = runMessages.map(message => message.id)

        let toolCount = 0
        let reasoningCount = 0
        for (const message of runMessages) {
          const parsed = parsedMessageDataById.get(message.id) ?? EMPTY_PARSED_MESSAGE_DATA
          toolCount += countToolSignals(parsed)
          reasoningCount += countReasoningSignals(message, parsed)
        }

        let bridgedMessageId: MessageId | undefined
        const trailingCandidate = renderableMessages[cursor]
        if (!runFootersByAnchor.has(String(runMessages[runMessages.length - 1]?.id)) &&
            trailingCandidate && (trailingCandidate.role === 'assistant' || trailingCandidate.role === 'ex_agent')) {
          const trailingParsed = parsedMessageDataById.get(trailingCandidate.id) ?? EMPTY_PARSED_MESSAGE_DATA
          const trailingHasProcessSignal = hasProcessSignal(trailingCandidate, trailingParsed)
          const trailingHasSubstantialContent = hasSubstantialTextOrImage(trailingCandidate, trailingParsed)
          const trailingUsesOrderedResponsesItems = hasResponsesOutputItems(trailingParsed)

          if (
            trailingHasProcessSignal &&
            trailingHasSubstantialContent &&
            !trailingUsesOrderedResponsesItems &&
            !hasExcludedGroupingTool(trailingParsed)
          ) {
            bridgedMessageId = trailingCandidate.id
            toolCount += countToolSignals(trailingParsed)
            reasoningCount += countReasoningSignals(trailingCandidate, trailingParsed)
          }
        }

        if (debugProcessGrouping) {
          console.debug('[Chat] Grouping process-only message run', {
            count: runMessages.length,
            toolCount,
            reasoningCount,
            messageIds: memberMessageIds,
            bridgedMessageId,
          })
        }

        rows.push({
          kind: 'process_group',
          // Keep group identity stable while new process messages append to the run.
          // If this key changes (e.g. first-last id), expanded state is lost and the group collapses.
          id: memberMessageIds[0],
          anchorMessageId: memberMessageIds[0],
          memberMessageIds,
          messages: runMessages,
          toolCount,
          reasoningCount,
          bridgedMessageId,
        })
      } else {
        if (debugProcessGrouping && runMessages.length > 0) {
          console.debug('[Chat] Process-only run below grouping threshold', {
            count: runMessages.length,
            threshold: CROSS_MESSAGE_PROCESS_GROUP_MIN_MESSAGES,
            messageIds: runMessages.map(message => message.id),
          })
        }

        for (const runMessage of runMessages) {
          rows.push({
            kind: 'message',
            id: runMessage.id,
            message: runMessage,
          })
        }
      }

      index = cursor
    }

    if (!debugProcessGrouping) {
      setLimitedCacheEntry(messageRenderRowsCacheRef.current, rowsCacheKey, rows)
    }

    const deriveEnd = typeof performance !== 'undefined' ? performance.now() : Date.now()
    virtualizationMetricsRef.current = {
      lastRowDeriveMs: Math.max(0, deriveEnd - deriveStart),
      lastRenderRowsCount: rows.length,
    }

    return rows
  }, [renderableMessages, renderableMessagesSignature, groupToolReasoningRuns, parsedMessageDataById, runBoundarySignature, runFootersByAnchor])

  const bridgedProcessMessageIds = useMemo(() => new Set(messageRenderRows.flatMap(row =>
    row.kind === 'process_group' && row.bridgedMessageId ? [String(row.bridgedMessageId)] : [])), [messageRenderRows])

  const messageById = useMemo(() => {
    const map = new Map<string, Message>()
    for (const msg of renderableMessages) {
      map.set(String(msg.id), msg)
    }
    return map
  }, [renderableMessages])

  const messageRowIndexByMessageId = useMemo(() => {
    const rowIndexByMessageId = new Map<string, number>()

    let virtualIndex = 0
    for (const row of messageRenderRows) {
      const ids = row.kind === 'message' ? [row.message.id] : row.memberMessageIds
      for (const id of ids) rowIndexByMessageId.set(String(id), virtualIndex)
      virtualIndex += 1 + (runFootersByAnchor.get(String(ids[ids.length - 1]))?.length ?? 0)
    }
    return rowIndexByMessageId
  }, [messageRenderRows, runFootersByAnchor])

  const assistantContainerClassByMessageId = useMemo(() => {
    const classByMessageId = new Map<string, string>()

    for (let index = 0; index < messageRenderRows.length; index++) {
      const row = messageRenderRows[index]
      if (row.kind !== 'message' || row.message.role !== 'assistant') {
        continue
      }

      const previousRow = index > 0 ? messageRenderRows[index - 1] : null
      const nextRow = index < messageRenderRows.length - 1 ? messageRenderRows[index + 1] : null

      const startsAssistantBlock = previousRow?.kind === 'message' && previousRow.message.role === 'user'
      const endsAssistantBlock = nextRow == null || (nextRow.kind === 'message' && nextRow.message.role === 'user')

      const radiusClassName =
        startsAssistantBlock && endsAssistantBlock
          ? '!rounded-md'
          : startsAssistantBlock
            ? '!rounded-none !rounded-t-md'
            : endsAssistantBlock
              ? '!rounded-none !rounded-b-md'
              : '!rounded-none'

      const containerClassName = radiusClassName

      if (containerClassName) {
        classByMessageId.set(String(row.message.id), containerClassName)
      }
    }

    return classByMessageId
  }, [messageRenderRows])

  const findMessageRowIndex = useCallback(
    (targetId: MessageId | null | undefined): number => {
      if (targetId == null) return -1
      return messageRowIndexByMessageId.get(String(targetId)) ?? -1
    },
    [messageRowIndexByMessageId]
  )

  // Trailing scroll room is provided by the in-flow bottom sentinel (see the message list render),
  // NOT by virtualizer paddingEnd. paddingEnd lives inside the totalSize div, i.e. above the
  // out-of-flow live streaming tail, so any non-zero value would open a visible gap between the
  // last persisted message and the streaming reply, and would corrupt the near-bottom metric.
  const virtualizerPaddingEnd = 0

  // Determine if optimistic/streaming messages should be shown (all modes for instant feedback)
  const showOptimisticMessage = !!optimisticMessage
  const showOptimisticBranchMessage = !!optimisticBranchMessage
  const compactionActive = isCurrentBranchCompacting ||
    (currentViewStream?.active === true && currentViewStream.compactionStatus === 'started')
  // Summary/mode rows can extend the same branch during completion. They must not
  // reset its presentation, whereas navigating to a sibling branch must.
  const compactionScope = getCompactionPresentationScope(
    currentConversationId, currentViewStream?.id ?? null, compactionViewPath, conversationMessages, compactionSummaryMessageId
  )
  const [compactionPresentation, setCompactionPresentation] = useState<{
    scope: string; owner: CompactionOwner | null; completed: boolean
  } | null>(null)
  useEffect(() => {
    if (compactionActive) {
      if (compactionPresentation?.scope === compactionScope && !compactionPresentation.completed) return
      setCompactionPresentation({
        scope: compactionScope,
        owner: isCurrentBranchCompacting ? {
          conversationId: compactingConversationId,
          parentMessageId: compactingParentMessageId,
          lineageId: compactingLineageId,
        } : null,
        completed: false,
      })
      return
    }
    if (!compactionPresentation) return
    if (compactionPresentation.scope !== compactionScope) {
      setCompactionPresentation(null)
      return
    }
    const succeeded = compactionPresentation.owner != null
      ? isCompactionVisibleFor({ ...compactionPresentation.owner, summaryMessageId: compactionSummaryMessageId }, compactionView) &&
        displayMessages.some(message => isCommittedCompaction(message) &&
          String(message.id) === String(compactionSummaryMessageId) &&
          String(message.parent_id ?? '') === String(compactionPresentation.owner?.parentMessageId))
      : currentViewStream?.compactionStatus === 'completed'
    if (!succeeded) {
      setCompactionPresentation(null)
      return
    }
    if (!compactionPresentation.completed) {
      setCompactionPresentation({ ...compactionPresentation, completed: true })
      return
    }
  }, [compactionActive, compactionScope, compactingConversationId, compactingParentMessageId,
    compactingLineageId, compactionSummaryMessageId, isCurrentBranchCompacting, compactionView,
    currentViewStream?.compactionStatus, displayMessages, compactionPresentation])
  useEffect(() => {
    if (!compactionPresentation?.completed) return
    const timeoutId = window.setTimeout(() => setCompactionPresentation(null), 600)
    return () => window.clearTimeout(timeoutId)
  }, [compactionPresentation])
  const compactionCompleted = compactionPresentation?.scope === compactionScope && compactionPresentation.completed &&
    (compactionPresentation.owner == null ||
      isCompactionVisibleFor({ ...compactionPresentation.owner, summaryMessageId: compactionSummaryMessageId }, compactionView))
  const showCompactionStatus = compactionActive || Boolean(compactionCompleted)
  const hasRunningToolJobForCurrentBranch = useMemo(() => {
    const conversationKey = currentConversationId != null ? String(currentConversationId) : null
    const currentStreamKey = streamState.id != null ? String(streamState.id) : null

    return runningToolJobs.some(job => {
      if (conversationKey != null) {
        if (job.conversationId == null) return false
        if (String(job.conversationId) !== conversationKey) return false
      }

      if (currentStreamKey != null && job.streamId != null && String(job.streamId) === currentStreamKey) {
        return true
      }

      if (job.messageId != null && selectedPathStringSet.has(String(job.messageId))) {
        return true
      }

      return false
    })
  }, [currentConversationId, runningToolJobs, selectedPathStringSet, streamState.id])
  const streamLifecycleActive =
    streamState.active ||
    streamState.status === 'active' ||
    streamState.status === 'waiting_for_tool' ||
    streamState.status === 'aborting'
  const showGenerationLoadingAnimation =
    selection.status !== 'pending' && selection.status !== 'error' && (showCompactionStatus || streamLifecycleActive || hasRunningToolJobForCurrentBranch)
  const hasFinalTextStreaming = Boolean(streamState.buffer?.trim())
  const hasProcessStreamingContent =
    Boolean(streamState.thinkingBuffer) || streamState.toolCalls.length > 0 || streamState.events.length > 0
  // R4: `streamState.error` deliberately does NOT keep the live row alive. The failure is drawn
  // by the message list and nowhere else — tier 1 when the server persisted a row carrying the
  // ErrorBlock, tier 2 (`chat_error`) when it could not. A stream that died before its first
  // token therefore renders no live row at all rather than an empty shell plus a second bubble.
  const hasStreamingMessageContent = hasFinalTextStreaming || hasProcessStreamingContent

  // Suppress the persisted current turn, not the previous turn's branch anchor.
  // New server-owned generations have no live message ID until persistence.
  const isStreamingMessageAlreadyRendered = isStreamMessageAlreadyRendered(streamState, messageRowIndexByMessageId)
  const showStreamingMessage = !compactionActive && !isStreamingMessageAlreadyRendered && hasStreamingMessageContent
  const liveAgentEvents = useMemo(() => splitLiveAgentEvents(streamState.events), [streamState.events])
  const trailingAgentRow = messageRenderRows[messageRenderRows.length - 1]
  const liveAgentGroupId = canAttachLiveAgentGroup({
    enabled: groupToolReasoningRuns, active: streamLifecycleActive, compacting: compactionActive,
    optimistic: showOptimisticMessage || showOptimisticBranchMessage, trailing: trailingAgentRow,
    anchor: streamState.lastCompletedMessageId ?? streamState.branchAnchorMessageId,
    boundaryAfter: trailingAgentRow?.kind === 'process_group' && runFootersByAnchor.has(String(trailingAgentRow.memberMessageIds[trailingAgentRow.memberMessageIds.length - 1])),
  }) ? String(trailingAgentRow.id) : null
  const visibleLiveEvents = liveAgentGroupId ? liveAgentEvents.outside : streamState.events
  const showStandaloneStreamingMessage = showStreamingMessage && (!liveAgentGroupId || visibleLiveEvents.length > 0)
  const showLiveStreamingTail = showStandaloneStreamingMessage && hasFinalTextStreaming
  // Once the final answer is streaming, the live tail is rendered OUTSIDE TanStack Virtual as an
  // in-flow sibling (see the message list render) so its token-by-token growth never enters
  // virtualizer geometry or the ResizeObserver, and can never drag scrollTop. Only the
  // process-only phase (thinking/tools, no text yet) is kept as a measured virtual row.
  const showStreamingMessageInVirtualList = showStandaloneStreamingMessage && !showLiveStreamingTail
  const showStreamingThinkingMessageRow = streamingThinkingIndicatorPlacement === 'message'
  const showStreamingThinkingInputTab = streamingThinkingIndicatorPlacement === 'input-tab'
  const showGenerationLoaderRow = showGenerationLoadingAnimation && showStreamingThinkingMessageRow
  const showGenerationLoaderInVirtualList = showGenerationLoaderRow && !showLiveStreamingTail && !liveAgentGroupId
  // The in-flow bottom sentinel is the sole trailing spacer (paddingEnd is 0). Sized to mirror the
  // previous paddingEnd so scroll-to-bottom lands the last message in the same place. It must be
  // flexShrink:0 in the render, otherwise the flex column collapses it to 0 and there is no room to
  // scroll the last message above the composer overlay.
  const bottomSentinelBaseHeight = Math.max(500, containerHeight * 0.6)
  const liveStreamingBottomClearance = Math.max(inputAreaHeight + 34, 170)
  // While the final answer streams outside the virtualizer, the clearance belongs to
  // the live tail itself. The bottom sentinel remains for explicit scroll-to-latest,
  // but automatic stream-follow must never target sentinel padding.
  const bottomSentinelHeight = bottomSentinelBaseHeight

  // R2: every failure already visible as a persisted ErrorBlock on a rendered message row
  // (tier 1). Anything in here must not also be drawn as a `chat_error` row (tier 2).
  const persistedErrorIdentityKeys = useMemo(() => {
    const keys = new Set<string>()

    for (const row of messageRenderRows) {
      const rowMessages = row.kind === 'message' ? [row.message] : row.messages
      for (const rowMessage of rowMessages) {
        const parsed = parsedMessageDataById.get(rowMessage.id)
        if (!Array.isArray(parsed?.contentBlocks)) continue
        for (const block of parsed.contentBlocks) {
          if (block.type === 'error') keys.add(chatErrorIdentityKey(block.envelope))
        }
      }
    }

    return keys
  }, [messageRenderRows, parsedMessageDataById])

  const virtualRows = useMemo<VirtualRenderRow[]>(() => {
    const rows: VirtualRenderRow[] = interleaveRunFooters(messageRenderRows, runFootersByAnchor).map(item => {
      if (item.kind === 'run_stats') return { ...item, key: `run-stats-${item.statistics.streamId}` }
      const row = item.row
      return { kind: 'message_row', key: row.kind === 'message' ? `message-${row.message.id}` : `group-${row.id}`, row }
    })

    if (showOptimisticMessage && optimisticMessage) {
      rows.push({
        kind: 'optimistic_message',
        key: `optimistic-${optimisticMessage.id}`,
        message: optimisticMessage,
      })
    }

    if (showOptimisticBranchMessage && optimisticBranchMessage) {
      rows.push({
        kind: 'optimistic_branch_message',
        key: `optimistic-branch-${optimisticBranchMessage.id}`,
        message: optimisticBranchMessage,
      })
    }

    if (showStreamingMessageInVirtualList) {
      rows.push({
        kind: 'streaming_message',
        key: 'streaming',
      })
    }

    if (showGenerationLoaderInVirtualList) {
      rows.push({
        kind: 'generation_loader',
        key: 'generation-loader',
      })
    }

    // Failures last, below whatever partial output survived (D1: partial text is never
    // discarded — the error is a separate row beneath it).
    for (const record of chatErrorRecords) {
      // R2 (belt and braces): the projection already refuses to create a record when the server
      // reports `persistedErrorMessageId`, but records written before that landed — or by any
      // path that never saw the id — must still not stack a second bubble on top of an
      // ErrorBlock the transcript is already showing.
      if (persistedErrorIdentityKeys.has(chatErrorIdentityKey(record.envelope))) continue

      rows.push({
        kind: 'chat_error',
        key: `chat-error-${record.id}`,
        record,
      })
    }

    return rows
  }, [
    messageRenderRows,
    runFootersByAnchor,
    showOptimisticMessage,
    optimisticMessage,
    showOptimisticBranchMessage,
    optimisticBranchMessage,
    showStreamingMessageInVirtualList,
    showGenerationLoaderInVirtualList,
    chatErrorRecords,
    persistedErrorIdentityKeys,
  ])

  const getUndoSummariesForMessage = useCallback(
    (messageId: string): StreamUndoSummary[] => {
      const directStreamIds = streamUndoRoot.streamIdsByParentMessageId[String(messageId)] || []
      const streamIds = new Set<string>(directStreamIds)
      const messageIndex = renderableMessages.findIndex(message => String(message.id) === String(messageId))

      if (messageIndex >= 0) {
        for (let index = messageIndex + 1; index < renderableMessages.length; index += 1) {
          const message = renderableMessages[index]
          if (!message) continue
          if (message.role === 'user') break
          const assistantStreamIds = streamUndoRoot.streamIdsByAssistantMessageId[String(message.id)] || []
          for (const streamId of assistantStreamIds) streamIds.add(streamId)
        }
      }

      return Array.from(streamIds)
        .map(id => streamUndoRoot.byStreamId[id])
        .filter((summary): summary is StreamUndoSummary => Boolean(summary))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    },
    [renderableMessages, streamUndoRoot]
  )

  const getUndoStateForMessage = useCallback(
    (messageId: string) => {
      const summaries = getUndoSummariesForMessage(messageId)
      if (summaries.length === 0) return undefined
      const latest = summaries[0]
      const restoring = streamUndoRoot.restoringByStreamId[latest.streamId] ?? false
      return {
        available: latest.status === 'available',
        restored: latest.status === 'restored',
        restoring,
        fileCount: latest.fileCount,
        error: streamUndoRoot.errorByStreamId[latest.streamId] ?? null,
      }
    },
    [getUndoSummariesForMessage, streamUndoRoot]
  )

  const handleUndoStreamEdits = useCallback(
    (messageId: string) => {
      if (currentConversationId != null) {
        void dispatch(fetchConversationStreamUndo(currentConversationId))
      }
      const latest = getUndoSummariesForMessage(messageId).find(summary => summary.status === 'available')
      if (!latest) return
      const ok = window.confirm(
        `Undo file edits from this agent run? This will restore ${latest.fileCount} file${latest.fileCount === 1 ? '' : 's'} to their pre-agent contents.`
      )
      if (!ok) return
      dispatch(
        restoreStreamFileEdits({
          streamId: latest.streamId,
          conversationId: currentConversationId,
          parentMessageId:
            latest.parentMessageId && String(latest.parentMessageId) === String(messageId)
              ? messageId
              : latest.parentMessageId,
        })
      )
    },
    [currentConversationId, dispatch, getUndoSummariesForMessage]
  )

  // Precompute per-user-message undo state AND a stable per-id handler in a single pass. Passing a
  // fresh `() => handleUndoStreamEdits(id)` arrow and a fresh undoState object per render defeated
  // ChatMessage's React.memo, forcing every visible user row (and its markdown) to re-render on every
  // stream token. These maps only change when the messages or undo root change, not per token.
  const { undoStateByMessageId, undoHandlerByMessageId } = useMemo(() => {
    const stateMap = new Map<string, ReturnType<typeof getUndoStateForMessage>>()
    const handlerMap = new Map<string, () => void>()
    for (const message of renderableMessages) {
      if (message.role !== 'user') continue
      const key = String(message.id)
      const undo = getUndoStateForMessage(key)
      if (!undo) continue
      stateMap.set(key, undo)
      handlerMap.set(key, () => handleUndoStreamEdits(key))
    }
    return { undoStateByMessageId: stateMap, undoHandlerByMessageId: handlerMap }
  }, [renderableMessages, getUndoStateForMessage, handleUndoStreamEdits])

  const userTurnElapsedLabelByMessageId = useMemo(() => {
    const labels = new Map<string, string>()
    let activeUserMessage: Message | null = null
    let latestAgentMessageAfterActiveUser: Message | null = null

    const setCompletedTurnLabel = (targetUserMessageId: MessageId | string | number | null | undefined) => {
      if (!activeUserMessage || !latestAgentMessageAfterActiveUser || targetUserMessageId == null) return
      if (runFooters.some(footer => footer.anchorMessageId === String(latestAgentMessageAfterActiveUser!.id))) return

      const userCreatedAtMs = parseCreatedAtMs(activeUserMessage.created_at)
      const agentCreatedAtMs = parseCreatedAtMs(latestAgentMessageAfterActiveUser.created_at)
      if (userCreatedAtMs == null || agentCreatedAtMs == null) return

      labels.set(String(targetUserMessageId), formatWorkedDurationLabel(agentCreatedAtMs - userCreatedAtMs))
    }

    for (const row of virtualRows) {
      const message =
        row.kind === 'message_row' && row.row.kind === 'message'
          ? row.row.message
          : row.kind === 'optimistic_message' || row.kind === 'optimistic_branch_message'
            ? row.message
            : null

      if (!message) continue

      if (message.role === 'user') {
        // Render the completed previous turn's separator before this user message,
        // while calculating only the actual work window: previous user -> latest agent.
        setCompletedTurnLabel(message.id)

        activeUserMessage = message
        latestAgentMessageAfterActiveUser = null
        continue
      }

      if ((message.role === 'assistant' || message.role === 'ex_agent') && activeUserMessage) {
        latestAgentMessageAfterActiveUser = message
      }
    }

    return labels
  }, [virtualRows, runFooters])

  useEffect(() => {
    benchLatestMessageCountRef.current = renderableMessages.length
    benchLatestVirtualRowCountRef.current = virtualRows.length
    benchLatestConversationIdRef.current = currentConversationId != null ? String(currentConversationId) : null
  }, [currentConversationId, renderableMessages.length, virtualRows.length])

  // Consider the user to be "at the bottom" if within this many pixels.
  // Keep the UI affordance generous, but use a much tighter threshold for automatic
  // follow/measurement correction so long final streamed answers do not move while reading.
  const NEAR_BOTTOM_PX = 600
  const AUTO_FOLLOW_BOTTOM_PX = 120
  const isNearBottom = (el: HTMLElement, threshold = NEAR_BOTTOM_PX) => {
    // Distance from the viewport bottom to the bottom of the last real content — NOT to the bottom
    // of the scrollable area. The scrollable area always ends with the bottom sentinel (and, while
    // streaming, the live-tail clearance), neither of which is message content. Measuring to
    // scrollHeight made a user parked at the last message read as ~600-800px "far from bottom", so
    // auto-follow never engaged and the scroll-to-bottom button showed permanently.
    const trailingNonContent = bottomSentinelHeight + (showLiveStreamingTail ? liveStreamingBottomClearance : 0)
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight - trailingNonContent
    return remaining <= threshold
  }

  // Memoized so its identity only changes when virtualRows change. An inline arrow here invalidated
  // the virtualizer's measurement memo every render, forcing a full O(count) measurements rebuild
  // per streamed token.
  const getVirtualItemKey = useCallback((index: number) => virtualRows[index]?.key ?? index, [virtualRows])

  // Font size offset for messages (synced from SettingsPane via custom event + localStorage)
  const [fontSizeOffset, setFontSizeOffset] = useState<number>(() => {
    try {
      const stored = localStorage.getItem('chat:fontSizeOffset')
      return stored ? parseInt(stored, 10) : 0
    } catch {
      return 0
    }
  })

  // Width of the scroll container, used to estimate how many lines a text block wraps to.
  // Only meaningful changes are published so the estimate callback does not churn per frame
  // during a window resize.
  const [messagesContainerWidth, setMessagesContainerWidth] = useState(0)
  useEffect(() => {
    const el = messagesContainerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return

    const apply = () => {
      const next = el.clientWidth
      setMessagesContainerWidth(prev => (Math.abs(prev - next) >= 8 ? next : prev))
    }

    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(el)
    return () => observer.disconnect()
  }, [currentConversationId])

  // Every Tailwind spacing utility is rem based, and index.css scales the root font size by
  // display density: 14px on a 2x retina panel, 16px normally. A row is therefore 12.5% shorter
  // on a retina laptop than the nominal class names suggest, so the estimate has to read the
  // real value rather than assume 16px.
  const [rootFontSize, setRootFontSize] = useState(DEFAULT_ROOT_FONT_SIZE)
  useEffect(() => {
    if (typeof window === 'undefined') return

    const readRootFontSize = () => {
      const parsed = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize)
      if (!Number.isFinite(parsed) || parsed <= 0) return
      setRootFontSize(prev => (Math.abs(prev - parsed) >= 0.5 ? parsed : prev))
    }

    readRootFontSize()
    // The density media queries key off resolution and viewport width, so both can change.
    window.addEventListener('resize', readRootFontSize)
    return () => window.removeEventListener('resize', readRootFontSize)
  }, [])

  // Content-aware row estimate.
  //
  // An unmeasured row is placed at this height; when it measures, the virtualizer corrects
  // scrollTop by the delta, and the React adapter repaints after that write, so the delta is
  // visible as a jump. virtual-core 3.17 suppresses this for re-measurement during backward
  // scroll, but a FIRST measurement is still corrected in both directions — which is exactly
  // the bottom-to-top pass through a freshly loaded conversation. So the estimate has to be
  // close. A flat guess per role was routinely 200px+ off on short tool-heavy replies.
  //
  // The model lives in ChatMessage/estimateMessageHeight.ts, next to the layout it mirrors.
  const estimateVirtualRowSize = useCallback(
    (index: number) => {
      const row = virtualRows[index]
      if (!row) return 200

      // Before the first measurement a typical desktop pane width is a better guess than 0.
      const containerWidth = messagesContainerWidth || 720

      const estimateForMessage = (message: Message) => {
        // Summaries draw only an h-8 notice with py-1, regardless of payload size.
        if (isCommittedCompaction(message) || isWatcherCompletionMessage(message) || isImageAttachmentInfoMessage(message)) return smallChromeRowHeight(rootFontSize)
        if (isRunSettingsNotification(message)) return 32
        const blocks = (parsedMessageDataById.get(message.id) ?? EMPTY_PARSED_MESSAGE_DATA).contentBlocks
        // Mirrors `hasContent && canBranchMessage` in ChatMessage, which gates the actions row.
        const hasText = typeof message.content === 'string' && message.content.trim().length > 0
        const hasBlockContent =
          Array.isArray(blocks) &&
          blocks.some(
            block =>
              (block.type === 'text' && typeof block.content === 'string' && block.content.trim().length > 0) ||
              block.type === 'image'
          )
        const canBranch =
          message.role === 'user' || (message.role === 'assistant' && message.parent_id == null)

        return estimateMessageRowHeight({
          role: message.role,
          content: typeof message.content === 'string' ? message.content : '',
          contentBlocks: blocks,
          containerWidth,
          rootFontSize,
          fontSizeOffset,
          groupToolReasoningRuns,
          artifactCount: Array.isArray(message.artifacts) ? message.artifacts.length : 0,
          hasAcceptedImages: hasAcceptedImageAttachments(message),
          showsActionsRow: (hasText || hasBlockContent) && canBranch,
          messageId: message.id,
          isMcpAppTool,
          hookRunCount: message.hook_runs?.length ?? 0,
        })
      }

      switch (row.kind) {
        case 'run_stats':
          return 36
        case 'message_row':
          return row.row.kind === 'process_group'
            ? processGroupRowHeight(rootFontSize) + row.row.messages.reduce((height, message) => {
                const blocks = parsedMessageDataById.get(message.id)?.contentBlocks ?? []
                const cards = blocks.filter((block, index) => block.type === 'context_injection' &&
                  (blocks[index - 1]?.type !== 'context_injection' || (blocks[index - 1] as any).tool_use_id !== block.tool_use_id)).length
                return height + (cards + (message.hook_runs?.length ? 1 : 0)) * 2 * rootFontSize
              }, 0)
            : estimateForMessage(row.row.message)
        case 'optimistic_message':
        case 'optimistic_branch_message':
          return estimateForMessage(row.message)
        case 'chat_error':
          return chatErrorRowHeight(rootFontSize)
        case 'generation_loader':
          return smallChromeRowHeight(rootFontSize)
        // The live row grows every token and is measured continuously, so its estimate only
        // has to be sane for the frame it mounts on.
        case 'streaming_message':
          return 200
        default:
          return 200
      }
    },
    [
      virtualRows,
      parsedMessageDataById,
      messagesContainerWidth,
      rootFontSize,
      fontSizeOffset,
      groupToolReasoningRuns,
      isMcpAppTool,
    ]
  )

  // Virtualizer for efficient message list rendering
  const virtualizer = useVirtualizer({
    count: virtualRows.length,
    getItemKey: getVirtualItemKey,
    getScrollElement: () => messagesContainerRef.current,
    estimateSize: estimateVirtualRowSize,
    overscan: 16, // Buffer rows above/below viewport
    // No paddingEnd: trailing scroll room comes from the in-flow bottom sentinel instead, so the
    // out-of-flow live tail sits flush under the last persisted message.
    paddingEnd: virtualizerPaddingEnd,
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.localStorage.getItem('chat:debugVirtualizerMetrics') !== 'true') return

    console.debug('[Chat] Virtual rows derived', {
      rows: virtualRows.length,
      deriveMs: virtualizationMetricsRef.current.lastRowDeriveMs,
      baseRows: virtualizationMetricsRef.current.lastRenderRowsCount,
    })
  }, [virtualRows.length, renderableMessagesSignature])

  const scrollToMessageRowIndex = useCallback(
    (targetIndex: number, align: 'start' | 'center' | 'end' | 'auto' = 'start'): boolean => {
      if (targetIndex < 0) return false
      virtualizer.scrollToIndex(targetIndex, { align })
      return true
    },
    [virtualizer]
  )

  const handleVirtualListProfilerRender = useCallback<React.ProfilerOnRenderCallback>(
    (id, phase, actualDuration, baseDuration, startTime, commitTime) => {
      if (!benchEnabled) return
      pushLimitedSample(benchCommitDurationsRef.current, actualDuration)
      appendBenchEvent('virtual_list_commit', {
        id,
        phase,
        actualDuration,
        baseDuration,
        startTime,
        commitTime,
      })
    },
    [appendBenchEvent, benchEnabled]
  )

  useEffect(() => {
    if (!benchEnabled) return

    const deriveMs = virtualizationMetricsRef.current.lastRowDeriveMs
    if (deriveMs > 0) {
      pushLimitedSample(benchDeriveDurationsRef.current, deriveMs)
      appendBenchEvent('virtual_rows_derived', {
        rows: virtualRows.length,
        deriveMs,
      })
    }
  }, [appendBenchEvent, benchEnabled, renderableMessagesSignature, virtualRows.length])

  useEffect(() => {
    if (!benchEnabled) {
      if (benchRafIdRef.current != null) {
        cancelAnimationFrame(benchRafIdRef.current)
        benchRafIdRef.current = null
      }
      return
    }

    const tick = (timestamp: number) => {
      const previous = benchLastRafTsRef.current
      if (previous != null) {
        const frameDelta = timestamp - previous
        pushLimitedSample(benchFrameDurationsRef.current, frameDelta)

        if (timestamp - benchLastScrollEventTsRef.current <= BENCH_SCROLL_ACTIVE_WINDOW_MS) {
          pushLimitedSample(benchScrollFrameDurationsRef.current, frameDelta)
        }
      }

      benchLastRafTsRef.current = timestamp
      benchRafIdRef.current = requestAnimationFrame(tick)
    }

    benchRafIdRef.current = requestAnimationFrame(tick)
    return () => {
      if (benchRafIdRef.current != null) {
        cancelAnimationFrame(benchRafIdRef.current)
        benchRafIdRef.current = null
      }
    }
  }, [benchEnabled])

  useEffect(() => {
    if (!benchEnabled) return

    const container = messagesContainerRef.current
    if (!container) return

    const onScroll = () => {
      benchLastScrollEventTsRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now()
    }

    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', onScroll)
    }
  }, [benchEnabled])

  useEffect(() => {
    if (!benchEnabled) return
    appendBenchEvent(streamState.active ? 'stream_started' : 'stream_stopped', {
      streamId: streamState.id,
      hasBuffer: Boolean(streamState.buffer),
      toolCalls: streamState.toolCalls.length,
      events: streamState.events.length,
    })
  }, [
    appendBenchEvent,
    benchEnabled,
    streamState.active,
    streamState.id,
    streamState.buffer,
    streamState.toolCalls.length,
    streamState.events.length,
  ])

  const updateScrollToBottomButtonVisibility = useCallback(() => {
    const el = messagesContainerRef.current
    if (!el || virtualRows.length === 0) {
      setShowScrollToBottomButton(false)
      return
    }

    setShowScrollToBottomButton(!isNearBottom(el, NEAR_BOTTOM_PX))
  }, [virtualRows.length])

  const scrollLiveTailToBottomOnce = useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      const container = messagesContainerRef.current
      const liveContent = liveStreamingContentRef.current
      if (!container || !liveContent) return

      const containerRect = container.getBoundingClientRect()
      const contentRect = liveContent.getBoundingClientRect()
      const contentBottom = container.scrollTop + contentRect.bottom - containerRect.top
      // The composer overlays the scroll container, so keep the streamed content above
      // that overlay. The separate spacer below the content supplies scrollable clearance;
      // this helper intentionally targets only the content bottom, never the spacer/sentinel.
      const desiredViewportBottomGap = Math.max(inputAreaHeight + 26, 106)
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
      const nextScrollTop = Math.min(
        maxScrollTop,
        Math.max(0, contentBottom + desiredViewportBottomGap - container.clientHeight)
      )

      if (Math.abs(container.scrollTop - nextScrollTop) > 1) {
        container.scrollTo({ top: nextScrollTop, behavior })
      }
    },
    [inputAreaHeight]
  )

  // Helper: scroll to bottom immediately using the sentinel first, with follow-up passes
  // to account for virtualized row measurement and late layout changes in long branches.
  const scrollToBottomNow = useCallback((behavior: ScrollBehavior = 'auto') => {
    const performScroll = (scrollBehavior: ScrollBehavior) => {
      const sentinel = bottomRef.current
      if (sentinel && typeof sentinel.scrollIntoView === 'function') {
        sentinel.scrollIntoView({ block: 'end', inline: 'nearest', behavior: scrollBehavior })
        return
      }

      const container = messagesContainerRef.current
      if (container) {
        container.scrollTo({ top: container.scrollHeight, behavior: scrollBehavior })
      }
    }

    performScroll(behavior)

    if (typeof window === 'undefined') return

    let attempts = 0
    const maxAttempts = 4

    const settleToBottom = () => {
      const container = messagesContainerRef.current
      if (!container) return
      if (isNearBottom(container, NEAR_BOTTOM_PX) || attempts >= maxAttempts) return

      attempts += 1
      performScroll('auto')
      window.requestAnimationFrame(settleToBottom)
    }

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(settleToBottom)
    })
  }, [])

  // Helper: scroll to show latest message at top of viewport (for normal mode)
  // const scrollToShowLatestAtTop = useCallback((behavior: ScrollBehavior = 'smooth') => {
  //   // console.log('scrolling to top')
  //   const container = messagesContainerRef.current
  //   if (!container) return

  //   // Scroll to position the latest message near the top of the viewport
  //   // We scroll to the bottom, which naturally shows the newest message
  //   const targetScroll = container.scrollHeight - container.clientHeight
  //   // console.log('targetScroll', targetScroll, container.scrollHeight, container.clientHeight)
  //   container.scrollTo({ top: Math.max(0, targetScroll), behavior })
  // }, [])

  // Heimdall state from Redux
  const heimdallData = useAppSelector(selectHeimdallData)

  const loading = useAppSelector(selectHeimdallLoading)
  const error = useAppSelector(selectHeimdallError)
  const compactMode = useAppSelector(selectHeimdallCompactMode)
  const selectedProject = useAppSelector(selectSelectedProject)

  // React Query hooks for model management
  const { data: modelsData } = useModels(providers.currentProvider)
  // const { data: recentModelsData } = useRecentModels(5)
  // const refreshModelsMutation = useRefreshModels()
  const selectModelMutation = useSelectModel()
  const selectedModel = useSelectedModel(providers.currentProvider, branchModelSelection?.model)
  const models = modelsData?.models || []

  // Helper to check if selected model can use image generation controls.
  // OpenAI ChatGPT uses the hosted Responses image_generation tool, so image controls can be shown
  // for that provider even when the selected chat model itself is not a dedicated image model.
  const isImageGenerationModel = useMemo(() => {
    const modelName = selectedModel?.name?.toLowerCase() || ''
    const providerName = providers.currentProvider?.toLowerCase() || ''
    const isOpenAIChatGPTProvider = providerName === 'openai (chatgpt)' || providerName === 'openaichatgpt'

    return (
      modelName.includes('gemini-3-pro-image-preview') ||
      modelName.includes('gemini-2.5-flash-image') ||
      modelName.includes('gpt-image') ||
      (isOpenAIChatGPTProvider && /\b(gpt-|codex|chatgpt)/i.test(modelName))
    )
  }, [providers.currentProvider, selectedModel?.name])
  // Conversation title editing
  const currentConversation = useAppSelector(
    currentConversationId ? makeSelectConversationById(currentConversationId) : () => null
  )

  const idsMatch = useCallback((a: ConversationId | null | undefined, b: ConversationId | null | undefined) => {
    if (a == null || b == null) return false
    return String(a) === String(b)
  }, [])

  const formatCwdChangedFooter = useCallback((cwdValue: string) => {
    const escapedCwd = cwdValue.replace(/```/g, '\`\`\`')
    const displayCwd = escapedCwd.length > 0 ? escapedCwd : '(cleared)'
    return `\n\n\`\`\`cwd_changed\n${displayCwd}\n\`\`\``
  }, [])

  const withPendingCwdAnnouncement = useCallback(
    (conversationId: ConversationId | null, baseContent: string) => {
      if (!conversationId) {
        return { content: baseContent, pendingCwdValue: null as string | null }
      }

      const key = String(conversationId)
      const hasPending = pendingCwdAnnouncementByConversationRef.current.has(key)
      if (!hasPending) {
        return { content: baseContent, pendingCwdValue: null as string | null }
      }

      const pendingCwdValue = pendingCwdAnnouncementByConversationRef.current.get(key) ?? ''
      return {
        content: `${baseContent}${formatCwdChangedFooter(pendingCwdValue)}`,
        pendingCwdValue,
      }
    },
    [formatCwdChangedFooter]
  )

  const clearPendingCwdAnnouncement = useCallback(
    (conversationId: ConversationId | null, pendingCwdValue: string | null) => {
      if (!conversationId || pendingCwdValue == null) return
      const key = String(conversationId)
      const hasPending = pendingCwdAnnouncementByConversationRef.current.has(key)
      if (!hasPending) return

      const currentPending = pendingCwdAnnouncementByConversationRef.current.get(key) ?? ''
      if (currentPending === pendingCwdValue) {
        pendingCwdAnnouncementByConversationRef.current.delete(key)
      }
    },
    []
  )

  const setCcCwdFromUser = useCallback(
    (nextValue: string) => {
      isCwdDirtyRef.current = true
      if (currentConversationId) {
        pendingCwdAnnouncementByConversationRef.current.set(String(currentConversationId), nextValue.trim())
      }
      dispatch(chatSliceActions.ccCwdSet(nextValue))
    },
    [currentConversationId, dispatch]
  )

  const handleSelectProjectFolder = useCallback(async () => {
    const result = await selectHostFolder(ccCwd)
    if (result.error) window.alert(result.error)
    if (result?.success && result.path) {
      setCcCwdFromUser(result.path)
    }
  }, [setCcCwdFromUser, ccCwd])

  const setCcCwdFromSystem = useCallback(
    (nextValue: string) => {
      isCwdDirtyRef.current = false
      dispatch(chatSliceActions.ccCwdSet(nextValue))
    },
    [dispatch]
  )

  // Fetch conversations for the current project using React Query
  // Use projectId from URL first (ensures correct cache is active on page refresh)
  const { data: projectConversations = [] } = useConversationsByProject(
    projectIdFromUrl || selectedProject?.id || currentConversation?.project_id || null
  )

  const findConversationForCurrent = useCallback(() => {
    if (!currentConversationId) return null
    const fromProject = projectConversations.find(c => idsMatch(c.id, currentConversationId))
    if (fromProject) return fromProject
    if (currentConversation && idsMatch(currentConversation.id, currentConversationId)) return currentConversation
    return null
  }, [currentConversationId, projectConversations, currentConversation, idsMatch])

  // Fetch storage mode using the robust hook
  const { data: storageModeFromHook } = useConversationStorageMode(conversationIdFromUrl)

  // Compute storage_mode from projectConversations (already loaded from ConversationPage)
  // This avoids unreliable cache lookups inside queryFn
  const conversationStorageMode = useMemo(() => {
    // Priority 1: Navigation state (immediate availability for new chats)
    if (storageModeFromNav) {
      return storageModeFromNav
    }

    // Priority 2: Hook result (robust check checking all caches + local fetch)
    if (storageModeFromHook) {
      return storageModeFromHook
    }

    if (!conversationIdFromUrl) {
      return undefined
    }

    // Priority 3: Check project conversations cache
    const conv = projectConversations.find(c => String(c.id) === String(conversationIdFromUrl))
    if (conv?.storage_mode) {
    }

    // Priority 4: Check all conversations cache (fallback)
    const allConvs = queryClient.getQueryData<Conversation[]>(['conversations'])
    const match = allConvs?.find(c => String(c.id) === String(conversationIdFromUrl))
    return match?.storage_mode
  }, [conversationIdFromUrl, projectConversations, storageModeFromNav, storageModeFromHook, queryClient])

  // Persisted snapshots only enter Redux through the generation-gated coordinator.
  // Cached query data is never projected directly, so Settings -> Back cannot clobber
  // the same-conversation live SSE projection before the route-entry fetch completes.
  const {
    data: conversationData,
    isFetched: isConversationDataFetched,
    acceptedConversationId,
    error: snapshotError,
    isCurrentError: isCurrentSnapshotError,
    isFetching: isSnapshotFetching,
    refresh: refreshConversationSnapshot,
  } = useConversationSnapshotCoordinator(conversationIdFromUrl, conversationStorageMode)

  const handleHookRunsUpdated = useCallback(
    (messageId: string, runs: HookRunRecord[]) => {
      dispatch(chatSliceActions.hookActivityReconciled({ messageId, runs }))
    },
    [dispatch]
  )

  // Stop hooks can update branch-anchor notes or content blocks after the chat stream
  // has already closed. Once active runs settle, reload the persisted conversation so
  // both Chat and Heimdall receive those hook-owned message mutations.
  const handleHookRunsSettled = useCallback(() => {
    void refreshConversationSnapshot()
  }, [refreshConversationSnapshot])

  // Route entry is the recovery boundary. A surviving module-level reader is skipped
  // per stream; only orphaned localStorage markers reattach to the main-process run.
  useEffect(() => {
    if (!conversationIdFromUrl) return
    const discover = () => { void dispatch(resumeInFlightStreams({ conversationId: String(conversationIdFromUrl) })) }
    discover()
    const timer = setInterval(discover, 3000)
    return () => clearInterval(timer)
  }, [conversationIdFromUrl, dispatch])

  // Use useMemo to ensure stable reference for empty object fallback
  // Without this, {} !== {} on each render, causing the useEffect below to
  // dispatch on every render, triggering an infinite update loop

  const [editingTitle, setEditingTitle] = useState(false)
  const editingTitleRef = useRef(false)
  const [isTitleBarVisible, setIsTitleBarVisible] = useState(true)
  const lastScrollTopRef = useRef(0)

  const handleTitleEditingChange = useCallback((editing: boolean) => {
    editingTitleRef.current = editing
    setEditingTitle(editing)
    if (editing) setIsTitleBarVisible(true)
  }, [])

  useEffect(() => {
    setAddedIdeContexts([])
  }, [currentConversationId])

  // Always reveal top bar when switching conversations.
  useEffect(() => {
    setIsTitleBarVisible(true)
    handleTitleEditingChange(false)
  }, [currentConversationId, handleTitleEditingChange])

  // Hide title bar on scroll down, reveal on scroll up (modern collapsing header behavior).
  useEffect(() => {
    const el = messagesContainerRef.current
    if (!el) return

    lastScrollTopRef.current = el.scrollTop
    let rafId: number | null = null

    const onScroll = () => {
      if (rafId != null) return
      rafId = requestAnimationFrame(() => {
        const currentTop = el.scrollTop
        const delta = currentTop - lastScrollTopRef.current
        const absDelta = Math.abs(delta)
        const nearTop = currentTop < 48

        if (nearTop) {
          setIsTitleBarVisible(true)
        } else if (absDelta > 8) {
          if (delta > 0 && !editingTitleRef.current) {
            setIsTitleBarVisible(false)
          } else if (delta < 0) {
            setIsTitleBarVisible(true)
          }
        }

        lastScrollTopRef.current = currentTop
        rafId = null
      })
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (rafId != null) cancelAnimationFrame(rafId)
    }
  }, [])

  // The thunk owns Redux and cache synchronization; typing never persists a partial title.
  const handleRenameConversation = useCallback(async (title: string) => {
    if (!currentConversationId) throw new Error('No conversation selected')
    await dispatch(updateConversationTitle({
      id: currentConversationId,
      title,
      storageMode: conversationStorageMode,
    })).unwrap()
  }, [currentConversationId, conversationStorageMode, dispatch])

  // Clear only on an actual A -> B switch. A Chat -> Settings -> Back remount retains
  // the live same-conversation Redux/tree/path state while the coordinator refetches.
  useEffect(() => {
    queryClient.removeQueries({
      queryKey: ['conversations'],
      type: 'inactive',
      predicate: query => {
        const key = query.queryKey
        return (
          Array.isArray(key) &&
          key[0] === 'conversations' &&
          key[2] === 'messages' &&
          String(key[1]) !== String(conversationIdFromUrl ?? '')
        )
      },
    })

    if (snapshotConversationId != null && String(snapshotConversationId) !== String(conversationIdFromUrl ?? '')) {
      dispatch(chatSliceActions.messagesLoaded([]))
      dispatch(chatSliceActions.heimdallDataLoaded({ treeData: null, subagentMap: {} }))
    }
  }, [conversationIdFromUrl, dispatch, queryClient, snapshotConversationId])

  // Run post-acceptance side effects. Messages/tree were already installed atomically by
  // the coordinator; this effect only mirrors and hydrates attachments.
  useEffect(() => {
    if (
      !conversationIdFromUrl ||
      !isConversationDataFetched ||
      !conversationData ||
      acceptedConversationId !== String(conversationIdFromUrl)
    ) return

    const fetchedMessages = conversationData.messages
    if (fetchedMessages.length === 0) return

    // Sync to local database in Electron mode
    // This handles syncing messages fetched from the server to the local SQLite DB
    if (import.meta.env.VITE_ENVIRONMENT === 'electron') {
      ;(dispatch as any)(
        syncConversationToLocal({
          conversationId: String(conversationIdFromUrl),
          messages: fetchedMessages,
          storageMode: conversationStorageMode,
        })
      )
    }

    // Process attachments from React Query response
    // This converts attachment URLs to base64 artifacts for display in ChatMessage
    fetchedMessages.forEach(msg => {
      const includedAttachments = (msg as any).attachments
      if (includedAttachments && Array.isArray(includedAttachments) && includedAttachments.length > 0) {
        // Dispatch attachment metadata immediately
        dispatch(
          chatSliceActions.attachmentsSetForMessage({
            messageId: msg.id,
            attachments: includedAttachments,
          })
        )

        // Fetch and convert binaries to base64 asynchronously (don't await, let it run in background)
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
      }
    })
  }, [acceptedConversationId, conversationData, conversationIdFromUrl, conversationStorageMode, dispatch, isConversationDataFetched])

  // Sync React Query conversations to Redux to ensure system_prompt and conversation_context are available
  // This fixes the issue where refreshing the page doesn't load context and system prompt from query cache
  useEffect(() => {
    if (projectConversations && projectConversations.length > 0) {
      dispatch(conversationsLoaded(projectConversations))
    }
  }, [projectConversations, dispatch])

  // Conversations are now fetched via React Query in Homepage/ConversationPage/SideBar
  // No need to fetch here - React Query automatically shares cached data across all components
  // This eliminates duplicate requests and rate limiting issues

  // Resizable split-pane state
  const containerRef = useRef<HTMLDivElement>(null)
  const [leftWidthPct, setLeftWidthPct] = useState<number>(() => {
    try {
      const stored = typeof window !== 'undefined' ? window.localStorage.getItem('chat:leftWidthPct') : null
      const n = stored ? parseFloat(stored) : NaN
      return Number.isFinite(n) ? Math.min(80, Math.max(20, n)) : 55
    } catch {
      return 55
    }
  })
  const [isResizing, setIsResizing] = useState(false)
  const [parallelSplitPct, setParallelSplitPct] = useState<number>(() => {
    try {
      const stored = typeof window !== 'undefined' ? window.localStorage.getItem('chat:parallelSplitPct') : null
      const parsed = stored ? Number.parseFloat(stored) : Number.NaN
      return Number.isFinite(parsed) ? Math.min(80, Math.max(20, parsed)) : 50
    } catch {
      return 50
    }
  })
  const [isParallelResizing, setIsParallelResizing] = useState(false)
  // Session-only secondary transcript. It intentionally resets with this route container.
  const [parallelPane, setParallelPane] = useState<ParallelChatPaneTarget | null>(null)
  const [activeChatPane, setActiveChatPane] = useState<'primary' | 'parallel'>('primary')
  const [settingsOpen, setSettingsOpen] = useState(false)
  useCommandBlocker(settingsOpen)
  const [think, setThink] = useState<boolean>(chatReasoningSettings.defaultThinkingEnabled)
  const [heimdallVisible, setHeimdallVisible] = useState<boolean>(() => {
    try {
      const stored = typeof window !== 'undefined' ? window.localStorage.getItem('chat:heimdallVisible') : null
      // Check if on mobile (< 768px) to set appropriate default
      const isMobileDevice = typeof window !== 'undefined' && window.innerWidth < 768
      const defaultValue = isMobileDevice ? false : true
      return stored !== null ? stored === 'true' : defaultValue
    } catch {
      // Fallback: check if mobile
      const isMobileDevice = typeof window !== 'undefined' && window.innerWidth < 768
      return isMobileDevice ? false : true
    }
  })

  const [treeFocusRequest, setTreeFocusRequest] = useState(0)
  useCommands([{
    id: 'heimdall.focus',
    enabled: () => Boolean(currentConversationId),
    run: () => {
      setHeimdallVisible(true)
      setTreeFocusRequest(request => request + 1)
    },
  }])

  const { theme: customTheme, enabled: customThemeEnabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()
  const chatSurfaceBackgroundColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.chatPanelBg, isDarkMode)
    : isDarkMode
      ? 'oklch(20.5% 0 0)'
      : 'oklch(98.5% 0 0)'
  const conversationToolbarBackgroundColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.conversationToolbarBg, isDarkMode)
    : isDarkMode
      ? 'rgba(23, 23, 23, 0.8)'
      : 'rgba(255, 255, 255, 0.8)'
  const chatProgressBarFillColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.chatProgressBarFill, isDarkMode)
    : undefined
  const actionPopoverInputBorderColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.actionPopoverBorder, isDarkMode)
    : undefined
  const actionPopoverTriggerStyle: React.CSSProperties | undefined = customThemeEnabled
    ? {
        backgroundColor: getThemeModeColor(customTheme.colors.settingsCustomThemesButtonBg, isDarkMode),
        color: getThemeModeColor(customTheme.colors.settingsCustomThemesButtonText, isDarkMode),
      }
    : undefined
  const contextUsagePopoverBackgroundColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.settingsCustomThemesInnerCardBg, isDarkMode)
    : undefined
  const contextUsagePopoverStyle: React.CSSProperties | undefined = contextUsagePopoverBackgroundColor
    ? {
        // Keep the surface opaque even when the selected theme token contains transparency.
        backgroundColor: isDarkMode ? '#171717' : '#ffffff',
        backgroundImage: `linear-gradient(${contextUsagePopoverBackgroundColor}, ${contextUsagePopoverBackgroundColor})`,
        color: getThemeModeColor(customTheme.colors.settingsCustomThemesBodyText, isDarkMode),
      }
    : undefined
  const contextUsagePopoverArrowStyle: React.CSSProperties | undefined = contextUsagePopoverBackgroundColor
    ? {
        backgroundColor: isDarkMode ? '#171717' : '#ffffff',
        backgroundImage: `linear-gradient(${contextUsagePopoverBackgroundColor}, ${contextUsagePopoverBackgroundColor})`,
      }
    : undefined
  const sendButtonAnimationThemeColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.sendButtonAnimationColor, isDarkMode)
    : undefined
  const composerToggleActiveStyle = customThemeEnabled
    ? {
        backgroundColor: getThemeModeColor(customTheme.colors.composerToggleActiveBg, isDarkMode),
        borderColor: getThemeModeColor(customTheme.colors.composerToggleActiveBorder, isDarkMode),
        color: getThemeModeColor(customTheme.colors.composerToggleActiveText, isDarkMode),
      }
    : undefined
  const authModalBackdropColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.authModalBackdrop, isDarkMode)
    : 'rgba(0, 0, 0, 0.5)'
  const authModalSurfaceBackgroundColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.authModalSurfaceBg, isDarkMode)
    : isDarkMode
      ? '#09090b'
      : '#ffffff'
  const authModalTitleTextColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.authModalTitleText, isDarkMode)
    : isDarkMode
      ? '#f5f5f5'
      : '#171717'
  const authModalBodyTextColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.authModalBodyText, isDarkMode)
    : isDarkMode
      ? '#d4d4d8'
      : '#525252'
  const authModalPrimaryButtonStyle = customThemeEnabled
    ? {
        backgroundColor: getThemeModeColor(customTheme.colors.authModalPrimaryButtonBg, isDarkMode),
        borderColor: getThemeModeColor(customTheme.colors.authModalPrimaryButtonBorder, isDarkMode),
        color: getThemeModeColor(customTheme.colors.authModalPrimaryButtonText, isDarkMode),
      }
    : undefined
  const authModalSecondaryButtonStyle = customThemeEnabled
    ? {
        backgroundColor: getThemeModeColor(customTheme.colors.authModalSecondaryButtonBg, isDarkMode),
        borderColor: getThemeModeColor(customTheme.colors.authModalSecondaryButtonBorder, isDarkMode),
        color: getThemeModeColor(customTheme.colors.authModalSecondaryButtonText, isDarkMode),
      }
    : undefined
  const authModalDangerButtonStyle = customThemeEnabled
    ? {
        backgroundColor: getThemeModeColor(customTheme.colors.authModalDangerButtonBg, isDarkMode),
        borderColor: getThemeModeColor(customTheme.colors.authModalDangerButtonBorder, isDarkMode),
        color: getThemeModeColor(customTheme.colors.authModalDangerButtonText, isDarkMode),
      }
    : undefined

  const [chatInputBorderAnimation, setChatInputBorderAnimation] = useState<ChatInputBorderAnimationType>(
    getStoredChatInputBorderAnimation
  )
  const [chatInputBorderLightColor, setChatInputBorderLightColor] = useState<string>(getStoredChatInputBorderLightColor)
  const [chatInputBorderDarkColor, setChatInputBorderDarkColor] = useState<string>(getStoredChatInputBorderDarkColor)

  const leftControlsBorderClasses = customThemeEnabled
    ? operationMode === 'plan'
      ? 'outline-1 outline-blue-200/70 dark:outline-neutral-700/50'
      : 'outline-1 outline-neutral-200/70 dark:outline-neutral-700/50'
    : operationMode === 'plan'
      ? 'outline-1 outline-blue-200/35 dark:outline-neutral-700/25'
      : 'outline-1 outline-neutral-200/35 dark:outline-neutral-700/25'

  const [showTokenUsageBar, setShowTokenUsageBar] = useState<boolean>(() => loadShowTokenUsageBar())
  const [showTokenUsageHoverDetails, setShowTokenUsageHoverDetails] = useState<boolean>(() =>
    loadShowTokenUsageHoverDetails()
  )
  const [autoCompactionEnabled, setAutoCompactionEnabled] = useState<boolean>(() => loadAutoCompactionEnabled())
  const [showAddedFilesPills, setShowAddedFilesPills] = useState<boolean>(() => loadShowAddedFilesPills())
  const [expandedProcessMessageRuns, setExpandedProcessMessageRuns] = useState<Set<string>>(() => new Set())
  const transientProcessGroupKey = `live:${streamState.id}`
  useEffect(() => {
    if (!liveAgentGroupId) return
    setExpandedProcessMessageRuns(previous => {
      if (!previous.has(transientProcessGroupKey)) return previous
      const next = new Set(previous)
      next.delete(transientProcessGroupKey)
      next.add(liveAgentGroupId)
      return next
    })
  }, [liveAgentGroupId, transientProcessGroupKey])
  useEffect(() => {
    // Listen for custom event from SettingsPane (same window)
    const handleCustomEvent = (e: Event) => {
      const detail = (e as CustomEvent<number>).detail
      if (typeof detail === 'number') setFontSizeOffset(detail)
    }
    // Listen for storage event (cross-tab/window sync)
    const handleStorageEvent = (e: StorageEvent) => {
      if (e.key === 'chat:fontSizeOffset' && e.newValue !== null) {
        const parsed = parseInt(e.newValue, 10)
        if (!isNaN(parsed)) setFontSizeOffset(parsed)
      }
    }
    window.addEventListener('fontSizeOffsetChange', handleCustomEvent)
    window.addEventListener('storage', handleStorageEvent)
    return () => {
      window.removeEventListener('fontSizeOffsetChange', handleCustomEvent)
      window.removeEventListener('storage', handleStorageEvent)
    }
  }, [])

  useEffect(() => {
    const handleGroupRunsEvent = (e: Event) => {
      const detail = (e as CustomEvent<boolean>).detail
      if (typeof detail === 'boolean') {
        setGroupToolReasoningRuns(detail)
      }
    }

    const handleToolOutputTruncationEvent = (e: Event) => {
      const detail = (e as CustomEvent<boolean>).detail
      if (typeof detail === 'boolean') {
        setTruncateToolOutput(detail)
      }
    }

    const handleStreamingIndicatorPlacementEvent = (e: Event) => {
      const detail = (e as CustomEvent<StreamingThinkingIndicatorPlacement>).detail
      if (detail === 'message' || detail === 'input-tab') {
        setStreamingThinkingIndicatorPlacement(detail)
      }
    }

    const handleStorageEvent = (e: StorageEvent) => {
      if (e.key === 'chat:groupToolReasoningRuns') {
        setGroupToolReasoningRuns(e.newValue === null ? true : e.newValue === 'true')
      }
      if (e.key === TOOL_OUTPUT_TRUNCATION_ENABLED_KEY) {
        setTruncateToolOutput(e.newValue === 'false' ? false : true)
      }
      if (e.key === STREAMING_THINKING_INDICATOR_PLACEMENT_STORAGE_KEY && e.newValue !== null) {
        setStreamingThinkingIndicatorPlacement(e.newValue === 'input-tab' ? 'input-tab' : 'message')
      }
    }

    window.addEventListener('groupToolReasoningRunsChange', handleGroupRunsEvent)
    window.addEventListener(TOOL_OUTPUT_TRUNCATION_CHANGE_EVENT, handleToolOutputTruncationEvent)
    window.addEventListener('streamingThinkingIndicatorPlacementChange', handleStreamingIndicatorPlacementEvent)
    window.addEventListener('storage', handleStorageEvent)

    return () => {
      window.removeEventListener('groupToolReasoningRunsChange', handleGroupRunsEvent)
      window.removeEventListener(TOOL_OUTPUT_TRUNCATION_CHANGE_EVENT, handleToolOutputTruncationEvent)
      window.removeEventListener('streamingThinkingIndicatorPlacementChange', handleStreamingIndicatorPlacementEvent)
      window.removeEventListener('storage', handleStorageEvent)
    }
  }, [])

  const toggleProcessMessageRun = useCallback((runId: string) => {
    setExpandedProcessMessageRuns(prev => {
      const next = new Set(prev)
      if (next.has(runId)) {
        next.delete(runId)
      } else {
        next.add(runId)
      }
      return next
    })
  }, [])

  useEffect(() => {
    const handleTokenUsageVisibilityEvent = (e: Event) => {
      const detail = (e as CustomEvent<boolean>).detail
      if (typeof detail === 'boolean') {
        setShowTokenUsageBar(detail)
      }
    }

    const handleTokenUsageHoverDetailsVisibilityEvent = (e: Event) => {
      const detail = (e as CustomEvent<boolean>).detail
      if (typeof detail === 'boolean') {
        setShowTokenUsageHoverDetails(detail)
      }
    }

    const handleAutoCompactionEnabledEvent = (e: Event) => {
      const detail = (e as CustomEvent<boolean>).detail
      if (typeof detail === 'boolean') {
        setAutoCompactionEnabled(detail)
      }
    }

    const handleAddedFilesPillsVisibilityEvent = (e: Event) => {
      const detail = (e as CustomEvent<boolean>).detail
      if (typeof detail === 'boolean') {
        setShowAddedFilesPills(detail)
      }
    }

    const handleStorageEvent = (e: StorageEvent) => {
      if (e.key === 'chat:showTokenUsageBar' && e.newValue !== null) {
        setShowTokenUsageBar(e.newValue === 'true')
      }

      if (e.key === CHAT_UI_TOKEN_USAGE_HOVER_DETAILS_VISIBILITY_KEY && e.newValue !== null) {
        setShowTokenUsageHoverDetails(e.newValue === 'true')
      }

      if (e.key === CHAT_UI_AUTO_COMPACTION_ENABLED_KEY && e.newValue !== null) {
        setAutoCompactionEnabled(e.newValue === 'true')
      }

      if (e.key === CHAT_UI_ADDED_FILES_PILLS_VISIBILITY_KEY && e.newValue !== null) {
        setShowAddedFilesPills(e.newValue === 'true')
      }
    }

    window.addEventListener(
      CHAT_UI_TOKEN_USAGE_VISIBILITY_CHANGE_EVENT,
      handleTokenUsageVisibilityEvent as EventListener
    )
    window.addEventListener(
      CHAT_UI_TOKEN_USAGE_HOVER_DETAILS_VISIBILITY_CHANGE_EVENT,
      handleTokenUsageHoverDetailsVisibilityEvent as EventListener
    )
    window.addEventListener(
      CHAT_UI_AUTO_COMPACTION_ENABLED_CHANGE_EVENT,
      handleAutoCompactionEnabledEvent as EventListener
    )
    window.addEventListener(
      CHAT_UI_ADDED_FILES_PILLS_VISIBILITY_CHANGE_EVENT,
      handleAddedFilesPillsVisibilityEvent as EventListener
    )
    window.addEventListener('storage', handleStorageEvent)

    return () => {
      window.removeEventListener(
        CHAT_UI_TOKEN_USAGE_VISIBILITY_CHANGE_EVENT,
        handleTokenUsageVisibilityEvent as EventListener
      )
      window.removeEventListener(
        CHAT_UI_TOKEN_USAGE_HOVER_DETAILS_VISIBILITY_CHANGE_EVENT,
        handleTokenUsageHoverDetailsVisibilityEvent as EventListener
      )
      window.removeEventListener(
        CHAT_UI_AUTO_COMPACTION_ENABLED_CHANGE_EVENT,
        handleAutoCompactionEnabledEvent as EventListener
      )
      window.removeEventListener(
        CHAT_UI_ADDED_FILES_PILLS_VISIBILITY_CHANGE_EVENT,
        handleAddedFilesPillsVisibilityEvent as EventListener
      )
      window.removeEventListener('storage', handleStorageEvent)
    }
  }, [])

  // Send button animation settings (synced from SettingsPane via custom event + localStorage)
  const [sendButtonAnimation, setSendButtonAnimation] = useState<SendButtonAnimationType>(getStoredSendButtonAnimation)
  const [sendButtonLightColor, setSendButtonLightColor] = useState<string>(getStoredSendButtonLightColor)
  const [sendButtonDarkColor, setSendButtonDarkColor] = useState<string>(getStoredSendButtonDarkColor)

  useEffect(() => {
    const handleSendButtonAnimationEvent = (e: Event) => {
      const detail = (e as CustomEvent<SendButtonAnimationType>).detail
      if (detail) setSendButtonAnimation(detail)
    }
    const handleSendButtonLightColorEvent = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail
      if (detail) setSendButtonLightColor(detail)
    }
    const handleSendButtonDarkColorEvent = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail
      if (detail) setSendButtonDarkColor(detail)
    }
    const handleInputBorderAnimationEvent = (e: Event) => {
      const detail = (e as CustomEvent<ChatInputBorderAnimationType>).detail
      if (detail) setChatInputBorderAnimation(detail)
    }
    const handleInputBorderLightColorEvent = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail
      if (detail) setChatInputBorderLightColor(detail)
    }
    const handleInputBorderDarkColorEvent = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail
      if (detail) setChatInputBorderDarkColor(detail)
    }
    const handleStorageEvent = (e: StorageEvent) => {
      if (e.key === 'chat:sendButtonAnimation' && e.newValue) {
        setSendButtonAnimation(e.newValue as SendButtonAnimationType)
      }
      if (e.key === 'chat:sendButtonLightColor' && e.newValue) {
        setSendButtonLightColor(e.newValue)
      }
      if (e.key === 'chat:sendButtonDarkColor' && e.newValue) {
        setSendButtonDarkColor(e.newValue)
      }
      if (e.key === 'chat:inputBorderAnimation' && e.newValue) {
        setChatInputBorderAnimation(e.newValue as ChatInputBorderAnimationType)
      }
      if (e.key === 'chat:inputBorderLightColor' && e.newValue) {
        setChatInputBorderLightColor(e.newValue)
      }
      if (e.key === 'chat:inputBorderDarkColor' && e.newValue) {
        setChatInputBorderDarkColor(e.newValue)
      }
    }

    window.addEventListener('sendButtonAnimationChange', handleSendButtonAnimationEvent)
    window.addEventListener('sendButtonLightColorChange', handleSendButtonLightColorEvent)
    window.addEventListener('sendButtonDarkColorChange', handleSendButtonDarkColorEvent)
    window.addEventListener('inputBorderAnimationChange', handleInputBorderAnimationEvent)
    window.addEventListener('inputBorderLightColorChange', handleInputBorderLightColorEvent)
    window.addEventListener('inputBorderDarkColorChange', handleInputBorderDarkColorEvent)
    window.addEventListener('storage', handleStorageEvent)

    return () => {
      window.removeEventListener('sendButtonAnimationChange', handleSendButtonAnimationEvent)
      window.removeEventListener('sendButtonLightColorChange', handleSendButtonLightColorEvent)
      window.removeEventListener('sendButtonDarkColorChange', handleSendButtonDarkColorEvent)
      window.removeEventListener('inputBorderAnimationChange', handleInputBorderAnimationEvent)
      window.removeEventListener('inputBorderLightColorChange', handleInputBorderLightColorEvent)
      window.removeEventListener('inputBorderDarkColorChange', handleInputBorderDarkColorEvent)
      window.removeEventListener('storage', handleStorageEvent)
    }
  }, [])
  // Detect if user is on mobile device (below md breakpoint: 768px)
  const isMobile = useIsMobile()
  // One-time spin flags for icon buttons
  const [spinSettings, setSpinSettings] = useState(false)
  // const [spinRefresh, setSpinRefresh] = useState(false)
  // Session-level delete confirmation preference and modal state
  const [confirmDel, setconfirmDel] = useState<boolean>(true)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [dontAskAgain, setDontAskAgain] = useState<boolean>(false)

  useEffect(() => {
    if (!isResizing) return

    const clamp = (v: number) => Math.max(20, Math.min(99, v))

    const handleMove = (clientX: number) => {
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const pct = clamp(((clientX - rect.left) / rect.width) * 100)
      setLeftWidthPct(pct)
      try {
        window.localStorage.setItem('chat:leftWidthPct', pct.toFixed(2))
      } catch {}
    }

    const stopResizing = () => setIsResizing(false)
    const onMouseMove = (e: MouseEvent) => handleMove(e.clientX)
    const onMouseUp = stopResizing
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches && e.touches[0]) handleMove(e.touches[0].clientX)
    }
    const onTouchEnd = stopResizing
    const onWindowBlur = stopResizing

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('touchend', onTouchEnd)
    window.addEventListener('blur', onWindowBlur)

    const prevUserSelect = document.body.style.userSelect
    const prevCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
      window.removeEventListener('blur', onWindowBlur)
      document.body.style.userSelect = prevUserSelect
      document.body.style.cursor = prevCursor
    }
  }, [isResizing, parallelPane])

  useEffect(() => {
    if (!isParallelResizing || !parallelPane || isMobile) return

    const clamp = (value: number) => Math.max(20, Math.min(80, value))
    const handleMove = (clientX: number) => {
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      const chatWorkspaceWidth = heimdallVisible ? rect.width * (leftWidthPct / 100) : rect.width
      if (chatWorkspaceWidth <= 0) return
      const nextSplit = clamp(((clientX - rect.left) / chatWorkspaceWidth) * 100)
      setParallelSplitPct(nextSplit)
      try {
        window.localStorage.setItem('chat:parallelSplitPct', nextSplit.toFixed(2))
      } catch {}
    }

    const stopResizing = () => setIsParallelResizing(false)
    const onMouseMove = (event: MouseEvent) => handleMove(event.clientX)
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches[0]) handleMove(event.touches[0].clientX)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', stopResizing)
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('touchend', stopResizing)
    window.addEventListener('blur', stopResizing)

    const previousUserSelect = document.body.style.userSelect
    const previousCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', stopResizing)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', stopResizing)
      window.removeEventListener('blur', stopResizing)
      document.body.style.userSelect = previousUserSelect
      document.body.style.cursor = previousCursor
    }
  }, [heimdallVisible, isMobile, isParallelResizing, leftWidthPct, parallelPane])

  // Sync system prompt and context from current conversation
  // Read directly from React Query projectConversations to avoid Redux sync race conditions
  useEffect(() => {
    if (!currentConversationId) {
      // If no conversation is selected, clear prompts and context
      dispatch(systemPromptSet(null))
      dispatch(convContextSet(null))
      return
    }

    const conversation = findConversationForCurrent()
    if (!conversation) return

    // Extract system_prompt and conversation_context from the found conversation
    dispatch(systemPromptSet(conversation.system_prompt ?? null))
    dispatch(convContextSet(conversation.conversation_context ?? null))
  }, [currentConversationId, findConversationForCurrent, dispatch])

  useEffect(() => {
    latestCcCwdRef.current = ccCwd
  }, [ccCwd])

  // Load cwd from local server when conversation changes.
  // This avoids stale cache races and treats the local row as the source of persisted truth.
  useEffect(() => {
    const loadSeq = ++cwdLoadSeqRef.current
    isCwdDirtyRef.current = false
    pendingManualExtensionSyncRef.current = false
    persistedCcCwdRef.current = ''

    if (!currentConversationId) {
      setCcCwdFromSystem('')
      return
    }

    // Clear immediately so the previous conversation cwd is never reused while loading.
    setCcCwdFromSystem('')

    void (async () => {
      try {
        const localConversation = await localApi.get<Conversation>(`/app/conversations/${currentConversationId}`)
        if (cwdLoadSeqRef.current !== loadSeq) return
        let loadedCwd = typeof localConversation?.cwd === 'string' ? localConversation.cwd : ''

        if (!loadedCwd.trim() && projectIdFromUrl) {
          try {
            const localProject = await localApi.get<Project>(`/app/projects/${projectIdFromUrl}`)
            if (cwdLoadSeqRef.current !== loadSeq) return
            const projectCwd = typeof localProject?.cwd === 'string' ? localProject.cwd : ''
            if (projectCwd.trim()) {
              loadedCwd = projectCwd
              void dispatch(
                updateCwd({
                  id: currentConversationId,
                  cwd: projectCwd,
                  storageMode: 'local',
                })
              )
            }
          } catch (projectCwdError) {
            const message = projectCwdError instanceof Error ? projectCwdError.message : String(projectCwdError)
            if (!message.includes('HTTP 404')) {
              console.error('[Chat] Failed to load local project cwd fallback:', projectCwdError)
            }
          }
        }

        persistedCcCwdRef.current = loadedCwd.trim()
        setCcCwdFromSystem(loadedCwd)
      } catch (error) {
        if (cwdLoadSeqRef.current !== loadSeq) return
        const message = error instanceof Error ? error.message : String(error)
        if (!message.includes('HTTP 404')) {
          console.error('[Chat] Failed to load local conversation cwd:', error)
        }
        persistedCcCwdRef.current = ''
        setCcCwdFromSystem('')
      }
    })()
  }, [currentConversationId, dispatch, projectIdFromUrl, setCcCwdFromSystem])

  // Auto-sync cwd from IDE extension when connected
  // Passive IDE updates should only fill when cwd is empty.
  // Manual extension selection can force one override on next workspace update.
  useEffect(() => {
    if (!ideContext?.extensionConnected || !workspace?.rootPath || !currentConversationId) return
    const hasCwd = ccCwd.trim().length > 0
    const shouldApplyWorkspaceRoot = pendingManualExtensionSyncRef.current || !hasCwd
    if (!shouldApplyWorkspaceRoot) return

    setCcCwdFromSystem(workspace.rootPath)
    pendingManualExtensionSyncRef.current = false
  }, [ideContext?.extensionConnected, workspace?.rootPath, currentConversationId, ccCwd, setCcCwdFromSystem])

  // Debounce cwd updates to save manual input to database
  // Similar pattern to title update debounce (lines 503-556)
  useEffect(() => {
    if (!currentConversationId) return

    // Find current conversation to compare against stored value
    const conversation = findConversationForCurrent()

    // Normalize for comparison (treat empty string same as null/undefined)
    const normalizedCcCwd = ccCwd.trim()
    const normalizedStoredCwd = persistedCcCwdRef.current

    // No-op if unchanged (also release dirty lock once backend catches up)
    if (normalizedCcCwd === normalizedStoredCwd) {
      isCwdDirtyRef.current = false
      return
    }

    const handle = setTimeout(() => {
      const targetConversationId = currentConversationId
      const targetCwd = normalizedCcCwd
      dispatch(
        updateCwd({
          id: targetConversationId,
          cwd: targetCwd || null, // Convert empty string to null
          storageMode: 'local', // cwd is Electron-only feature
        })
      )
        .unwrap()
        .then(() => {
          if (latestCcCwdRef.current.trim() === targetCwd) {
            persistedCcCwdRef.current = targetCwd
            isCwdDirtyRef.current = false
          }

          // Update React Query caches to reflect the new cwd
          const projectId = selectedProject?.id || conversation?.project_id

          // Update all conversations cache
          const conversationsCache = queryClient.getQueryData<Conversation[]>(['conversations'])
          if (conversationsCache) {
            queryClient.setQueryData(
              ['conversations'],
              conversationsCache.map(conv =>
                idsMatch(conv.id, targetConversationId) ? { ...conv, cwd: targetCwd || null } : conv
              )
            )
          }

          // Update project conversations cache if project exists
          if (projectId) {
            const projectConversationsCache = queryClient.getQueryData<Conversation[]>([
              'conversations',
              'project',
              projectId,
            ])
            if (projectConversationsCache) {
              queryClient.setQueryData(
                ['conversations', 'project', projectId],
                projectConversationsCache.map(conv =>
                  idsMatch(conv.id, targetConversationId) ? { ...conv, cwd: targetCwd || null } : conv
                )
              )
            }
          }
        })
        .catch(error => {
          console.error('Failed to update conversation cwd:', error)
        })
    }, 1000) // 1 second debounce (same as title)

    return () => clearTimeout(handle)
  }, [ccCwd, currentConversationId, findConversationForCurrent, dispatch, queryClient, selectedProject?.id, idsMatch])

  // Query invalidation is now handled directly in sendMessage and editMessageWithBranching success handlers
  // This prevents aggressive refetching and duplicate API requests

  // Cleanup any pending streaming scroll work on unmount
  useEffect(() => {
    return () => {
      if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current)
    }
  }, [])

  useEffect(() => {
    streamActiveRef.current = streamState.active
  }, [streamState.active])

  useEffect(() => {
    finalTextStreamingStartedRef.current = false
    skippedInitialLiveTailFollowRef.current = false
    if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current)
  }, [streamState.id])

  // Detect user scroll intent during a stream from INPUT events only — wheel, touch, keyboard
  // navigation, and scrollbar drags. The previous version inferred intent from raw scrollTop
  // deltas, but app follow-scrolls and the virtualizer's own resize adjustments also dispatch
  // trusted `scroll` events, so they were misread as "the user scrolled" (killing follow on its
  // own), while inside the 300ms programmatic window real downward drags were ignored entirely
  // ("scrolling down does not stop it"). Any real scroll input means "stop following" until the
  // stream ends or the user hits scroll-to-bottom.
  useEffect(() => {
    const el = messagesContainerRef.current
    if (!el) return

    const markUserIntent = () => {
      if (!streamActiveRef.current) return
      userScrolledDuringStreamRef.current = true
      if (scrollRafRef.current != null) {
        cancelAnimationFrame(scrollRafRef.current)
        scrollRafRef.current = null
      }
    }

    const navKeys = new Set(['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' ', 'Spacebar'])
    const onKeyDown = (e: KeyboardEvent) => {
      if (navKeys.has(e.key)) markUserIntent()
    }
    const onPointerDown = (e: PointerEvent) => {
      // Pointer down in the scrollbar gutter (to the right of the content box) = about to drag-scroll.
      if (e.clientX >= el.getBoundingClientRect().left + el.clientWidth) markUserIntent()
    }

    el.addEventListener('wheel', markUserIntent, { passive: true })
    el.addEventListener('touchmove', markUserIntent, { passive: true })
    el.addEventListener('keydown', onKeyDown)
    el.addEventListener('pointerdown', onPointerDown, { passive: true })
    return () => {
      el.removeEventListener('wheel', markUserIntent)
      el.removeEventListener('touchmove', markUserIntent)
      el.removeEventListener('keydown', onKeyDown)
      el.removeEventListener('pointerdown', onPointerDown)
    }
  }, [])

  useEffect(() => {
    if (!streamState.active) {
      finalTextStreamingStartedRef.current = false
      return
    }

    if (hasFinalTextStreaming && !finalTextStreamingStartedRef.current) {
      finalTextStreamingStartedRef.current = true
      const container = messagesContainerRef.current
      if (container && !isNearBottom(container, AUTO_FOLLOW_BOTTOM_PX)) {
        userScrolledDuringStreamRef.current = true
      }
    }
  }, [hasFinalTextStreaming, streamState.active])

  useEffect(() => {
    if (!showLiveStreamingTail) {
      skippedInitialLiveTailFollowRef.current = false
      return
    }
    if (userScrolledDuringStreamRef.current) return
    if (typeof window === 'undefined') return

    // Mounting the live tail changes the bottom spacer/sentinel layout. Do not auto-scroll
    // on that first render; otherwise stream start still looks like a jump to the bottom.
    // Subsequent token growth can follow normally while the user has not scrolled away.
    if (!skippedInitialLiveTailFollowRef.current) {
      skippedInitialLiveTailFollowRef.current = true
      return
    }

    if (scrollRafRef.current != null) {
      window.cancelAnimationFrame(scrollRafRef.current)
    }

    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null
      if (userScrolledDuringStreamRef.current) return
      scrollLiveTailToBottomOnce('auto')
    })

    return () => {
      if (scrollRafRef.current != null) {
        window.cancelAnimationFrame(scrollRafRef.current)
        scrollRafRef.current = null
      }
    }
  }, [scrollLiveTailToBottomOnce, showLiveStreamingTail, streamState.buffer])

  // Reset streaming scroll state when the stream ends. Keyed on the stream LIFECYCLE going
  // active -> inactive, not on streamState.finished: `finished` is unreachable in this component
  // (the view-stream selector drops a stream the same tick `active` flips false, and abort/error
  // paths never set `finished`), so the old effect never ran and userScrolledDuringStreamRef stayed
  // poisoned across streams, permanently disabling auto-follow for the rest of the session.
  // Do not perform an anchor-based handoff restore here: after the live tail is replaced by the
  // persisted virtual row, that restore was moving the viewport upward by a couple of messages.
  const prevStreamLifecycleActiveRef = useRef(false)
  useEffect(() => {
    const wasActive = prevStreamLifecycleActiveRef.current
    prevStreamLifecycleActiveRef.current = streamLifecycleActive
    if (!wasActive || streamLifecycleActive) return

    userScrolledDuringStreamRef.current = false
    finalTextStreamingStartedRef.current = false
    if (scrollRafRef.current != null) {
      cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = null
    }
  }, [streamLifecycleActive])

  useEffect(() => {
    const el = messagesContainerRef.current
    if (!el) return

    const updateVisibility = () => updateScrollToBottomButtonVisibility()
    updateVisibility()

    el.addEventListener('scroll', updateVisibility, { passive: true })

    const resizeObserver = new ResizeObserver(() => {
      updateVisibility()
    })
    resizeObserver.observe(el)

    const sentinel = bottomRef.current
    if (sentinel) {
      resizeObserver.observe(sentinel)
    }

    return () => {
      el.removeEventListener('scroll', updateVisibility)
      resizeObserver.disconnect()
    }
  }, [currentConversationId, updateScrollToBottomButtonVisibility])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const rafId = window.requestAnimationFrame(() => {
      updateScrollToBottomButtonVisibility()
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [
    currentConversationId,
    displayMessages.length,
    streamState.active,
    streamState.buffer,
    streamState.thinkingBuffer,
    streamState.toolCalls.length,
    updateScrollToBottomButtonVisibility,
    virtualRows.length,
  ])

  // A navigation intent is consumed once, only after its target row exists. Token updates and
  // completion never replay an old focus; an explicit re-click gets a new request ID.
  useEffect(() => {
    const intent = selection.scroll
    if (!intent || handledSelectionScrollRef.current === intent.requestId) return
    if (intent.mode === 'focus' && intent.focus != null) {
      const index = findMessageRowIndex(intent.focus)
      if (index === -1) return
      userScrolledDuringStreamRef.current = true
      scrollToMessageRowIndex(index, 'start')
    } else {
      if (!virtualRows.length && conversationMessages.length) return
      scrollToBottomNow('auto')
    }
    handledSelectionScrollRef.current = intent.requestId
    dispatch(chatSelectionScrollHandled(intent.requestId))
  }, [selection.scroll, findMessageRowIndex, scrollToMessageRowIndex, scrollToBottomNow,
    virtualRows.length, conversationMessages.length, dispatch])

  // Helper to check if a message can drive Heimdall's current viewport highlight.
  // Only simple text-response content should move the outline. Tool calls, tool
  // results, reasoning, thinking, and image-only messages are intentionally ignored
  // so Heimdall can keep the previous text node highlighted while those rows pass by.
  const isHeimdallVisibleTextResponseMessage = useCallback((msg: Message): boolean => {
    if (!msg || msg.role === 'tool') return false

    const hasPlainContent = typeof msg.content === 'string' && msg.content.trim().length > 0
    if (msg.role === 'user') {
      return hasPlainContent
    }

    if (!msg.content_blocks) {
      return hasPlainContent
    }

    try {
      const blocks = typeof msg.content_blocks === 'string' ? JSON.parse(msg.content_blocks) : msg.content_blocks
      const arr = Array.isArray(blocks) ? blocks : [blocks]

      return arr.some((block: any) => {
        if (!block || typeof block !== 'object') return false

        if (block.type === 'text') {
          const text =
            typeof block.text === 'string' ? block.text : typeof block.content === 'string' ? block.content : ''
          return text.trim().length > 0
        }

        return getResponsesOutputAssistantTexts(block as ContentBlock).some(text => text.trim().length > 0)
      })
    } catch {
      return false
    }
  }, [])

  const visibilityInputsRef = useRef<{
    renderableMessages: Message[]
    virtualRows: VirtualRenderRow[]
    isHeimdallVisibleTextResponseMessage: (msg: Message) => boolean
  }>({
    renderableMessages,
    virtualRows,
    isHeimdallVisibleTextResponseMessage,
  })

  useEffect(() => {
    visibilityInputsRef.current = {
      renderableMessages,
      virtualRows,
      isHeimdallVisibleTextResponseMessage,
    }
  }, [renderableMessages, virtualRows, isHeimdallVisibleTextResponseMessage])

  useEffect(() => {
    lastVisibleTextMessageIdRef.current = null
    setVisibleMessageId(null)
  }, [currentConversationId])

  useEffect(() => {
    const stickyId = lastVisibleTextMessageIdRef.current
    if (stickyId == null) return

    const stickyStillInCurrentBranch = renderableMessages.some(message => String(message.id) === String(stickyId))
    if (!stickyStillInCurrentBranch) {
      lastVisibleTextMessageIdRef.current = null
      setVisibleMessageId(null)
    }
  }, [renderableMessages, selectedPath])

  // Track the most visible message using virtualizer's virtual items on scroll
  // Since elements are virtualized, we compute visibility based on scroll position
  useEffect(() => {
    const container = messagesContainerRef.current
    if (!container) return

    const updateVisibleMessage = () => {
      const {
        renderableMessages: currentMessages,
        virtualRows: currentVirtualRows,
        isHeimdallVisibleTextResponseMessage: isHighlightCandidate,
      } = visibilityInputsRef.current
      const virtualItems = virtualizer.getVirtualItems()

      const findFirstHighlightCandidate = (): MessageId | null => {
        for (const msg of currentMessages) {
          if (msg && isHighlightCandidate(msg)) {
            return msg.id
          }
        }
        return null
      }
      // Only reached in the fallback branches (no visible highlight row), so validate the sticky id
      // with a short-circuiting scan here instead of allocating an id Set on every scroll event.
      const getStickyOrInitialHighlightMessage = (): MessageId | null => {
        const stickyId = lastVisibleTextMessageIdRef.current
        if (stickyId != null && currentMessages.some(message => String(message.id) === String(stickyId))) {
          return stickyId
        }

        const fallback = findFirstHighlightCandidate()
        lastVisibleTextMessageIdRef.current = fallback
        return fallback
      }

      if (virtualItems.length === 0) {
        setVisibleMessageId(getStickyOrInitialHighlightMessage())
        return
      }

      const scrollTop = container.scrollTop
      const viewportHeight = container.clientHeight
      const detectionOffset = 20
      const adjustedScrollTop = scrollTop + detectionOffset

      let closestItem: (typeof virtualItems)[0] | null = null

      for (const item of virtualItems) {
        const virtualRenderRow = currentVirtualRows[item.index]
        if (!virtualRenderRow || virtualRenderRow.kind !== 'message_row' || virtualRenderRow.row.kind !== 'message') {
          continue
        }

        const msg = virtualRenderRow.row.message
        if (!msg || !isHighlightCandidate(msg)) continue

        const itemTop = item.start
        const itemBottom = item.start + item.size
        const topHalfEnd = adjustedScrollTop + viewportHeight * 0.5
        if (itemBottom < adjustedScrollTop || itemTop > topHalfEnd) continue

        if (!closestItem || item.start < closestItem.start) {
          closestItem = item
        }
      }

      if (!closestItem) {
        setVisibleMessageId(getStickyOrInitialHighlightMessage())
        return
      }

      const closestVirtualRenderRow = currentVirtualRows[closestItem.index]
      if (closestVirtualRenderRow?.kind === 'message_row' && closestVirtualRenderRow.row.kind === 'message') {
        const nextVisibleMessageId = closestVirtualRenderRow.row.message.id
        lastVisibleTextMessageIdRef.current = nextVisibleMessageId
        setVisibleMessageId(nextVisibleMessageId)
      }
    }

    updateVisibleMessageRef.current = updateVisibleMessage
    updateVisibleMessage()

    container.addEventListener('scroll', updateVisibleMessage, { passive: true })
    return () => {
      updateVisibleMessageRef.current = null
      container.removeEventListener('scroll', updateVisibleMessage)
    }
  }, [virtualizer])

  useEffect(() => {
    updateVisibleMessageRef.current?.()
  }, [renderableMessagesSignature, virtualRows])

  // Route and in-place navigation share one resolution pipeline. Snapshot loading remains
  // owned by this Chat instance; selection never installs a second copy of fetched rows.
  useEffect(() => {
    if (snapshotError && isCurrentSnapshotError() && !isSnapshotFetching && !acceptedConversationId && conversationIdFromUrl) {
      chatSelection.snapshotFailed(String(conversationIdFromUrl), selection.requestId)
    } else {
      void chatSelection.resolve(acceptedConversationId, refreshConversationSnapshot)
    }
  }, [chatSelection, acceptedConversationId, refreshConversationSnapshot, selection.requestId, conversationMessages,
    snapshotError, isCurrentSnapshotError, isSnapshotFetching, conversationIdFromUrl])

  // Clear selectedFilesForChat on route change
  useEffect(() => {
    dispatch(updateIdeContext({ selectedFilesForChat: [] }))
  }, [location.pathname, dispatch])

  // Also clear selectedFilesForChat on unmount
  useEffect(() => {
    return () => {
      dispatch(updateIdeContext({ selectedFilesForChat: [] }))
    }
  }, [dispatch])



  // Models are now loaded automatically via React Query hooks
  // No manual loading needed - React Query handles caching and refetching
  // Filtering and sorting is handled by useFilteredModels hook

  // Listen for provider settings changes from Settings page
  useEffect(() => {
    const handleProviderSettingsChange = (e: CustomEvent<ProviderSettings>) => {
      setProviderSettings(e.detail)
    }

    window.addEventListener(PROVIDER_SETTINGS_CHANGE_EVENT, handleProviderSettingsChange as EventListener)
    return () =>
      window.removeEventListener(PROVIDER_SETTINGS_CHANGE_EVENT, handleProviderSettingsChange as EventListener)
  }, [])

  // Listen for default reasoning settings changes from Settings page.
  useEffect(() => {
    const handleReasoningSettingsChange = (e: CustomEvent<ReturnType<typeof loadChatReasoningSettings>>) => {
      setChatReasoningSettings(e.detail)
    }

    window.addEventListener(CHAT_REASONING_SETTINGS_CHANGE_EVENT, handleReasoningSettingsChange as EventListener)
    return () =>
      window.removeEventListener(CHAT_REASONING_SETTINGS_CHANGE_EVENT, handleReasoningSettingsChange as EventListener)
  }, [])

  // Apply default thinking/effort only when model capability is known.
  // This prevents races where selectedModel is not yet loaded on first render.
  useEffect(() => {
    if (!selectedModel) return

    if (!selectedModel.thinking) {
      setThink(false)
      return
    }

    setThink(chatReasoningSettings.defaultThinkingEnabled)
    setReasoningConfig(prev =>
      prev.effort === chatReasoningSettings.defaultReasoningEffort
        ? prev
        : { ...prev, effort: chatReasoningSettings.defaultReasoningEffort }
    )
  }, [
    selectedModel?.name,
    selectedModel?.thinking,
    chatReasoningSettings.defaultThinkingEnabled,
    chatReasoningSettings.defaultReasoningEffort,
  ])

  // Set default provider based on settings or community constraints.
  useEffect(() => {
    const allowedProviders = providers.providers.map(p => p.name)

    if (isCommunityMode) {
      const preferredCommunityDefault = allowedProviders.includes('LM Studio')
        ? 'LM Studio'
        : allowedProviders[0] || null

      if (!preferredCommunityDefault) return

      if (
        !providers.currentProvider ||
        !allowedProviders.includes(providers.currentProvider) ||
        providers.currentProvider === 'OpenRouter'
      ) {
        dispatch(chatSliceActions.providerSelected(preferredCommunityDefault))
      }
      return
    }

    if (!providers.currentProvider) {
      // If provider selector is hidden and a default is configured, use it
      if (!providerSettings.showProviderSelector && providerSettings.defaultProvider) {
        dispatch(chatSliceActions.providerSelected(providerSettings.defaultProvider))
      } else if (allowedProviders.includes('OpenRouter')) {
        dispatch(chatSliceActions.providerSelected('OpenRouter'))
      } else if (allowedProviders.length > 0) {
        dispatch(chatSliceActions.providerSelected(allowedProviders[0]))
      }
    }
  }, [
    providers.currentProvider,
    providers.providers,
    dispatch,
    providerSettings.showProviderSelector,
    providerSettings.defaultProvider,
  ])

  // Auto-apply default provider when visibility is toggled off
  useEffect(() => {
    if (isCommunityMode) return
    if (!providerSettings.showProviderSelector && providerSettings.defaultProvider) {
      dispatch(chatSliceActions.providerSelected(providerSettings.defaultProvider))
    }
  }, [providerSettings.showProviderSelector, providerSettings.defaultProvider, dispatch])

  // Creation remains separate from navigation; routed conversations are owned by the controller.
  useEffect(() => {
    if (!conversationIdFromUrl) dispatch(initializeUserAndConversation())
  }, [conversationIdFromUrl, dispatch])

  const modelSwitchScope = JSON.stringify([currentConversationId, modeLineageId, selection.revision])
  const openaiSelectionScopeRef = useRef<string | null>(null)
  const { pending: pendingModelSwitch, request: requestModelSwitch, cancel: cancelModelSwitch, confirm: confirmModelSwitch } =
    useModelSwitchConfirmation(modelSwitchScope, branchModelSelection ? {
      provider: providers.currentProvider, model: selectedModel?.name ?? branchModelSelection.model,
    } : null)

  // Handle model selection
  const handleModelSelect = useCallback(
    (modelName: string) => {
      const model = models.find(m => m.name === modelName)
      if (model) {
        requestModelSwitch({ provider: providers.currentProvider, model: model.name }, () => {
          dispatch(chatSliceActions.branchModelSelected({ provider: providers.currentProvider, model: model.name }))
          selectModelMutation.mutate({ provider: providers.currentProvider, model })
        })
      } else {
        console.warn('Selected model not found:', modelName)
      }
    },
    [models, selectModelMutation, providers.currentProvider, requestModelSwitch, dispatch]
  )

  const handleExtensionSelection = useCallback(
    (val: string) => {
      const extensionId = val || null
      pendingManualExtensionSyncRef.current = Boolean(extensionId)
      dispatch(selectExtension(extensionId))

      if (extensionId) {
        const selectedExtension = extensions.find(ext => ext.id === extensionId)
        if (selectedExtension?.rootPath) {
          setCcCwdFromSystem(selectedExtension.rootPath)
          pendingManualExtensionSyncRef.current = false
        }
      }

      // Immediately request context for the chosen extension.
      requestContext(extensionId)
    },
    [dispatch, extensions, requestContext, setCcCwdFromSystem]
  )
  // Provider selection handler with OpenAI auth check
  const openOpenaiAuthUrl = useCallback(async (url: string) => {
    if (window.electronAPI?.auth?.openExternal) {
      try {
        await window.electronAPI.auth.openExternal(url)
        return
      } catch (error) {
        console.error('Failed to open browser:', error)
        setOpenaiAuthError('Failed to open browser. Please copy the URL manually.')
        return
      }
    }

    window.open(url, '_blank')
  }, [])

  const handleProviderSelect = useCallback(
    async (providerName: string) => {
      if (providerName === providers.currentProvider) return
      if (providerName === 'OpenRouter' && isCommunityMode) {
        setOpenRouterLoginRequiredModalOpen(true)
        return
      }

      // Check if OpenAI ChatGPT provider is selected and user is not authenticated
      if (providerName === 'OpenAI (ChatGPT)' && !isOpenAIAuthenticated()) {
        openaiSelectionScopeRef.current = modelSwitchScope
        // Request OAuth flow from local server (server generates and stores PKCE)
        try {
          const data = await localApi.post<{ success?: boolean; authUrl?: string; state?: string; error?: string }>(
            '/openai/auth/start'
          )
          if (data.success && data.authUrl && data.state) {
            setOpenaiAuthFlow({ url: data.authUrl, verifier: '', state: data.state })
            setOpenaiAuthError(null)
            // setOpenaiCallbackInput('')
            setOpenaiLoginModalOpen(true)
            void openOpenaiAuthUrl(data.authUrl)
          } else {
            throw new Error(data.error || 'Failed to start OAuth flow')
          }
        } catch (error) {
          console.error('Failed to create OpenAI auth flow:', error)
          setOpenaiAuthError('Failed to start authentication flow. Make sure the app is running in Electron mode.')
          setOpenaiLoginModalOpen(true)
        }
        return // Don't select provider until authenticated
      }
      requestModelSwitch({ provider: providerName, model: null }, () => {
        dispatch(chatSliceActions.branchModelSelected({ provider: providerName, model: null }))
        dispatch(chatSliceActions.providerSelected(providerName))
      })
    },
    [dispatch, openOpenaiAuthUrl, requestModelSwitch, providers.currentProvider, modelSwitchScope]
  )

  useEffect(() => {
    const handleChatKeyboardShortcut = (event: KeyboardEvent) => {
      const hasPrimaryModifier = event.ctrlKey || event.metaKey
      if (!hasPrimaryModifier || event.altKey) return

      // Ctrl/Cmd + , opens quick chat settings; adding Shift opens the full Settings route.
      if (event.code === 'Comma') {
        event.preventDefault()
        if (event.shiftKey) {
          navigate('/settings')
        } else {
          setSettingsOpen(true)
        }
        return
      }

      if (event.shiftKey || !/^Digit[1-9]$/.test(event.code)) return

      const slot = Number(event.code.slice(-1))
      const assignment = loadModelShortcutSlots()[slot]
      if (!assignment) return

      const providerExists = providers.providers.some(provider => provider.name === assignment.provider)
      if (!providerExists) {
        console.warn(`Model shortcut ${slot} uses an unavailable provider:`, assignment.provider)
        return
      }

      if (assignment.provider === 'OpenRouter' && isCommunityMode) {
        event.preventDefault()
        setOpenRouterLoginRequiredModalOpen(true)
        return
      }

      if (assignment.provider === 'OpenAI (ChatGPT)' && !isOpenAIAuthenticated()) {
        event.preventDefault()
        void handleProviderSelect(assignment.provider)
        return
      }

      event.preventDefault()
      requestModelSwitch({ provider: assignment.provider, model: assignment.model.name }, () => {
        dispatch(chatSliceActions.branchModelSelected({ provider: assignment.provider, model: assignment.model.name }))
        dispatch(chatSliceActions.providerSelected(assignment.provider))
        selectModelMutation.mutate({ provider: assignment.provider, model: assignment.model })
      })
    }

    // Capture these toggles before editor autocomplete can consume Shift+Tab.
    const handleChatToggleKeyDown = (event: KeyboardEvent) => {
      // The shortcut recorder owns keys before this legacy capture-phase handler.
      if (document.querySelector('[data-shortcut-editor]')) return
      handleChatToggleShortcut(event, {
        toggleOperationMode: handleToggleOperationMode,
        toggleFastServiceTier: isOpenAIChatGPTProvider ? handleToggleFastServiceTier : undefined,
      })
    }
    window.addEventListener('keydown', handleChatToggleKeyDown, true)
    window.addEventListener('keydown', handleChatKeyboardShortcut)
    return () => {
      window.removeEventListener('keydown', handleChatToggleKeyDown, true)
      window.removeEventListener('keydown', handleChatKeyboardShortcut)
    }
  }, [dispatch, handleProviderSelect, handleToggleOperationMode, handleToggleFastServiceTier, isOpenAIChatGPTProvider, navigate, providers.providers, selectModelMutation, requestModelSwitch])

  const handleComposerSlashCommandSelect = useCallback(
    (command: string): ComposerSlashCommandResult | void => {
      const normalized = command.trim().toLowerCase().replace(/^\/+/, '')
      const isKnownSlashCommand =
        normalized === 'status-openai' ||
        (normalized === 'compact' || normalized === 'compactify') ||
        parseBenchAction(command) != null ||
        parseThemeDemoAction(command) != null

      if (!isKnownSlashCommand) {
        return { handled: false }
      }

      void runComposerCommand(command)
      return {
        handled: true,
        clearInput: true,
      }
    },
    [runComposerCommand]
  )

  const { canSend: canSendImmediately, canQueue: canQueueLocal } = getComposerSubmissionAvailability({
    ready: selection.status !== 'pending' && selection.status !== 'error',
    hasInput: hasLocalInput,
    isRetrigger: !hasLocalInput && displayMessages.length > 0 && displayMessages[displayMessages.length - 1]?.role === 'user' &&
      !isRunSettingsNotification(displayMessages[displayMessages.length - 1]),
    hasModel: !!selectedModel,
    streamActive: streamState.active,
    compacting: isCurrentBranchCompacting,
    modeChanging: !!modeChange,
    queueSubmitting,
  })
  const canSendLocal = canSendImmediately || canQueueLocal

  /**
   * Re-run generation from the last user message on the current branch.
   *
   * Extracted from `handleSend` so the error bubble's `retry` action drives the exact same
   * path a manual retrigger does — a second implementation would drift the moment either
   * changes. Returns false when there is nothing to retrigger.
   */
  const retriggerLastUserMessage = useCallback(
    (repeatCount: number): boolean => {
      if (!currentConversationId) return false

      const lastUserMessage = displayMessages[displayMessages.length - 1]

      // Safety check: ensure lastUserMessage exists before accessing properties
      if (!lastUserMessage || lastUserMessage.role !== 'user' || isRunSettingsNotification(lastUserMessage)) {
        console.error('Cannot retrigger: No last user message found in displayMessages')
        return false
      }

      const parent: MessageId | null = lastUserMessage.parent_id || null
      const contentToRetrigger = lastUserMessage.content
      const { content: retriggerContent, pendingCwdValue } = withPendingCwdAnnouncement(
        currentConversationId,
        contentToRetrigger
      )

      // Dispatch sendMessage with retrigger flag
      const streamId = generateStreamId('primary')
      setPendingViewStream({ streamId, conversationId: currentConversationId!, selectionRevision: selection.fallbackRevision })

      dispatch(
        sendMessage({
          conversationId: currentConversationId,
          input: { content: retriggerContent },
          parent,
          repeatNum: repeatCount,
          think: think,
          retrigger: true,
          imageConfig: isImageGenerationModel ? imageConfig : undefined,
          reasoningConfig: think ? reasoningConfig : undefined,
          serviceTier: openAIServiceTier,
          cwd: ccCwd || undefined,
          operationMode,
          selectionRevision: selection.revision,
          lineageId: modeLineageId,
          branchPath: selectedPath,
          streamId,
        })
      )
        .unwrap()
        .then(result => {
          clearPendingCwdAnnouncement(currentConversationId, pendingCwdValue)
          if (!result?.userMessage) {
            console.warn('Server did not confirm user message')
          }
          // ✅ No refetch needed - messages already added to Redux via SSE stream
          // Stream sends: user_message event + complete event with full message data
          // Redux already updated via messageAdded() + messageBranchCreated() dispatches
        })
        .catch(error => {
          // A retrigger that dies here produced no stream and therefore no server-side error
          // frame. Without a record the button would simply do nothing, forever.
          console.error('Failed to retrigger generation:', error)
          recordLocalChatError(error, {
            phase: 'open',
            conversationId: currentConversationId,
            parentMessageId: parent,
            streamId,
          })
        })

      return true
    },
    [
      ccCwd,
      clearPendingCwdAnnouncement,
      selection.revision,
      selection.fallbackRevision,
      modeLineageId,
      selectedPath,
      currentConversationId,
      dispatch,
      displayMessages,
      imageConfig,
      isImageGenerationModel,
      openAIServiceTier,
      operationMode,
      reasoningConfig,
      recordLocalChatError,
      think,
      withPendingCwdAnnouncement,
    ]
  )

  const handlePreparedSend = useCallback(
    (value: number) => {
      const localInputValue = getLocalInput()
      const trimmedInputValue = localInputValue.trim()
      const normalizedInput = trimmedInputValue.toLowerCase().replace(/^\/+/, '')
      const slashBenchAction = parseBenchAction(trimmedInputValue)
      const slashThemeDemoAction = parseThemeDemoAction(trimmedInputValue)
      const isKnownSlashCommand =
        normalizedInput === 'status-openai' ||
        (normalizedInput === 'compact' || normalizedInput === 'compactify') ||
        slashBenchAction != null ||
        slashThemeDemoAction != null

      if (trimmedInputValue.startsWith('/') && isKnownSlashCommand) {
        void runComposerCommand(trimmedInputValue).then(result => {
          if (result.handled && result.clearInput) {
            clearLocalInput()
          }
        })
        return
      }

      if (canQueueLocal && currentConversationId && streamState.id) {
        if (queueSubmittingRef.current) return
        queueSubmittingRef.current = true
        setQueueSubmitting(true)
        const { content, pendingCwdValue } = withPendingCwdAnnouncement(currentConversationId,
          appendIdeContextToMessage(replaceFileMentionsWithPath(localInputValue)))
        const retry = queueRetryRef.current
        const queuedSubmission = retry?.streamId === streamState.id && retry.content === content
          ? retry : { streamId: streamState.id, content, requestId: newClientId() }
        queueRetryRef.current = queuedSubmission
        recordSentMessage(localInputValue)
        clearLocalInput()
        void dispatch(enqueueUserMessage({ conversationId: currentConversationId, ...queuedSubmission })).unwrap().then(() => {
          queueRetryRef.current = null
          clearPendingCwdAnnouncement(currentConversationId, pendingCwdValue)
          setAddedIdeContexts([])
        }).catch(error => {
          recordLocalChatError(error, { phase: 'open', conversationId: currentConversationId, streamId: streamState.id })
        }).finally(() => { queueSubmittingRef.current = false; setQueueSubmitting(false) })
        return
      }

      if (canSendImmediately && currentConversationId) {
        // Check if this is a retrigger scenario (empty input + last message is user)
        const isRetrigger =
          !hasLocalInput && displayMessages.length > 0 && displayMessages[displayMessages.length - 1]?.role === 'user' &&
      !isRunSettingsNotification(displayMessages[displayMessages.length - 1])

        if (isRetrigger) {
          retriggerLastUserMessage(value)
        } else {
            // Normal send flow
            // Process file mentions with actual content before sending
            const processedContent = replaceFileMentionsWithPath(localInputValue)
            const contentWithIdeContext = appendIdeContextToMessage(processedContent)
            const selectedParent: MessageId | null =
              selectedPath.length > 0 ? selectedPath[selectedPath.length - 1] : null

            const latestCompaction = (() => {
              for (let i = displayMessages.length - 1; i >= 0; i--) {
                const message = displayMessages[i]
                if (isCommittedCompaction(message)) {
                  return { index: i, message }
                }
              }
              return { index: -1, message: null as Message | null }
            })()

            let effectiveParent: MessageId | null = selectedParent
            if (latestCompaction.message) {
              const selectedParentIndex =
                selectedParent == null
                  ? -1
                  : displayMessages.findIndex(message => String(message?.id) === String(selectedParent))

              if (selectedParentIndex < latestCompaction.index) {
                effectiveParent = latestCompaction.message.id
              }
            }

            const sendWithParent = (parentForSend: MessageId | null) => {
              if (selectionRevisionRef.current !== selection.revision) return
              const { content: contentToSend, pendingCwdValue } = withPendingCwdAnnouncement(
                currentConversationId,
                contentWithIdeContext
              )

              // Create optimistic message for instant UI feedback
              const optimisticUserMessage: Message = {
                id: `temp-${Date.now()}`,
                conversation_id: currentConversationId,
                role: 'user' as const,
                content: contentToSend,
                content_plain_text: contentToSend,
                parent_id: parentForSend || null,
                children_ids: [],
                created_at: new Date().toISOString(),
                model_name: selectedModel?.name || '',
                partial: false,
                pastedContext: [],
                artifacts: composerImageDraftDataUrls,
              }
              dispatch(chatSliceActions.optimisticMessageSet(optimisticUserMessage))

              // Use processed content for immediate send
              const inputToSend = { content: contentToSend }
              // Keep an in-memory history of raw user input, then clear the composer.
              recordSentMessage(localInputValue)
              clearLocalInput()

              // Dispatch a single sendMessage with repeatNum set to value.
              const streamId = generateStreamId('primary')
              setPendingViewStream({ streamId, conversationId: currentConversationId!, selectionRevision: selection.fallbackRevision })

              dispatch(
                sendMessage({
                  conversationId: currentConversationId,
                  input: inputToSend,
                  parent: parentForSend,
                  repeatNum: value,
                  think: think,
                  imageConfig: isImageGenerationModel ? imageConfig : undefined,
                  reasoningConfig: think ? reasoningConfig : undefined,
                  serviceTier: openAIServiceTier,
                  cwd: ccCwd || undefined,
                  operationMode,
                  selectionRevision: selection.revision,
                  lineageId: modeLineageId,
                  branchPath: selectedPath,
                  streamId,
                })
              )
                .unwrap()
                .then(result => {
                  clearPendingCwdAnnouncement(currentConversationId, pendingCwdValue)
                  // Optional: warn if server didn't confirm message
                  if (!result?.userMessage) {
                    console.warn('Server did not confirm user message')
                  }
                  setAddedIdeContexts([])
                  // ✅ No refetch needed - messages already added to Redux via SSE stream
                  // Stream sends: user_message event + complete event with full message data
                  // Redux already updated via messageAdded() + messageBranchCreated() dispatches
                })
                .catch(error => {
                  // Clear optimistic message on error
                  // Note: Success case is handled in chatActions when user_message chunk arrives
                  dispatch(chatSliceActions.optimisticMessageCleared())
                  console.error('Failed to send message:', error)
                  // Clearing the optimistic row is right when nothing was persisted. Keep the
                  // composer clear; the raw input remains available through sent-message history.
                  recordLocalChatError(error, {
                    phase: 'open',
                    conversationId: currentConversationId,
                    parentMessageId: parentForSend,
                    streamId,
                  })
                })
            }

            // Context checks and compaction belong to the server's safe boundary.
            sendWithParent(effectiveParent)
        }
      } else if (!currentConversationId) {
        console.error('📤 No conversation ID available')
      }
    },
    [
      canSendImmediately,
      canQueueLocal,
      selection.revision,
      selection.fallbackRevision,
      modeLineageId,
      streamState.active,
      streamState.id,
      currentConversationId,
      selectedPath,
      think,
      dispatch,
      getLocalInput,
      hasLocalInput,
      isCurrentBranchCompacting,
      sendingState.sending,
      sendingState.compacting,
      clearLocalInput,
      displayMessages,
      replaceFileMentionsWithPath,
      appendIdeContextToMessage,
      scrollToBottomNow,
      selectedModel,
      ccCwd,
      projectConversations,
      queryClient,
      selectedProject,
      currentConversation,
      currentUser,
      autoCompactionEnabled,
      providerSettings.compactionProvider,
      providerSettings.compactionModel,
      providers.currentProvider,
      isImageGenerationModel,
      imageConfig,
      reasoningConfig,
      openAIServiceTier,
      operationMode,
      withPendingCwdAnnouncement,
      clearPendingCwdAnnouncement,
      runComposerCommand,
      composerImageDraftDataUrls,
      retriggerLastUserMessage,
      recordLocalChatError,
    ]
  )

  // Re-enter the latest render after waiting: active stream, selected branch and
  // input may all have changed while the file was being prepared.
  const preparedSendRef = useRef(handlePreparedSend)
  preparedSendRef.current = handlePreparedSend
  const imageSubmitPendingRef = useRef(false)
  const handleSend = useCallback(async (value: number) => {
    if (imageSubmitPendingRef.current) return
    imageSubmitPendingRef.current = true
    const revision = selectionRevisionRef.current
    try {
      await dispatch(waitForImagePreparation({ kind: 'composer' }))
      if (selectionRevisionRef.current === revision) preparedSendRef.current(value)
    } catch (error) {
      recordLocalChatError(error, { phase: 'preflight', conversationId: currentConversationId })
    } finally {
      imageSubmitPendingRef.current = false
    }
  }, [dispatch, currentConversationId, recordLocalChatError])

  const handleStopGeneration = useCallback(() => {
    if (selection.status === 'pending' || selection.status === 'error') return
    if (canStopCompaction && compactingConversationId != null && compactingParentMessageId != null) {
      dispatch(abortCompaction({ conversationId: compactingConversationId, parentMessageId: compactingParentMessageId }))
      return
    }
    if (!streamState.id && !streamState.streamingMessageId) return

    dispatch(
      abortGeneration({
        streamId: streamState.id,
        messageId: streamState.streamingMessageId,
      })
    )
  }, [selection.status, streamState.id, streamState.streamingMessageId, canStopCompaction, compactingConversationId, compactingParentMessageId, dispatch])

  // The error bubble owns exactly one button. This is where its `kind` becomes a real recovery.
  // Deliberately routed through the handlers that already exist in this container rather than
  // reimplemented, so retry means the same thing here as it does from the composer.
  const [pendingChatErrorActionId, setPendingChatErrorActionId] = useState<string | null>(null)

  const dismissChatError = useCallback(
    (record: ChatErrorRecord) => {
      dispatch(chatSliceActions.chatErrorDismissed({ conversationId: record.conversationId, id: record.id }))
    },
    [dispatch]
  )

  const handleChatErrorAction = useCallback(
    (record: ChatErrorRecord, kind: ChatErrorActionKind) => {
      switch (kind) {
        case 'retry': {
          // Same path as pressing send on an empty composer after a user turn.
          const started = retriggerLastUserMessage(multiReplyCount)
          // Only clear the bubble once a new attempt is actually under way; otherwise the
          // explanation would vanish and leave the failure invisible again.
          if (started) dismissChatError(record)
          return
        }
        case 'sign_in': {
          // D2: an expired session never force-redirects. The user chose to go here.
          dismissChatError(record)
          navigate('/login?required=cloud')
          return
        }
        case 'upgrade': {
          dismissChatError(record)
          navigate('/payment')
          return
        }
        case 'switch_mode': {
          // The only mode switch an error can ask for: the run needed write access.
          handleOperationModeChange('execute')
          dismissChatError(record)
          return
        }
        case 'compact': {
          setPendingChatErrorActionId(record.id)
          void handleManualCompactifyCommand().finally(() => {
            setPendingChatErrorActionId(null)
            dismissChatError(record)
          })
          return
        }
        case 'reload_conversation': {
          setPendingChatErrorActionId(record.id)
          void Promise.resolve(refreshConversationSnapshot()).finally(() => {
            setPendingChatErrorActionId(null)
            dismissChatError(record)
          })
          return
        }
        case 'reconnect_provider': {
          // Provider credentials (API keys, OAuth reconnects) live on the full `/settings`
          // route (containers/Settings.tsx), NOT the in-chat SettingsPane — so this
          // navigates rather than opening the pane. `provider_signin_required` is the code
          // that asks for it: the user has to actually re-enter something.
          dismissChatError(record)
          navigate('/settings')
          return
        }
        case 'open_settings': {
          // Everything else that says "check a setting" (MCP servers, hooks) is reachable
          // from the pane without losing the conversation.
          setSettingsOpen(true)
          return
        }
        default: {
          // Exhaustiveness guard: a new ChatErrorActionKind must be wired here, not silently
          // rendered as a dead button.
          const unhandled: never = kind
          console.warn('[Chat] Unhandled chat error action', unhandled)
          return
        }
      }
    },
    [
      dismissChatError,
      dispatch,
      handleOperationModeChange,
      handleManualCompactifyCommand,
      multiReplyCount,
      navigate,
      refreshConversationSnapshot,
      retriggerLastUserMessage,
      setSettingsOpen,
    ]
  )

  /**
   * The tier-1 bridge: a button on a PERSISTED `ErrorBlock` (transcript content, the only
   * error surface that survives a reload) routed into the same switch tier-2 uses.
   *
   * A persisted block has no `ChatErrorRecord`, so we synthesise one. Its id is deliberately
   * not in `errorNotices`, which makes the `dismissChatError` calls inside the switch harmless
   * no-ops — correct, because transcript content is not dismissible.
   */
  const handlePersistedChatErrorAction = useCallback(
    (kind: ChatErrorActionKind, messageId: MessageId, envelope: ChatErrorEnvelope) => {
      if (currentConversationId == null) return
      handleChatErrorAction(
        {
          id: `persisted-error-${String(messageId)}`,
          conversationId: currentConversationId,
          envelope: buildChatErrorEnvelope(envelope.code, envelope),
          parentMessageId: messageId,
          streamId: null,
          lineageId: null,
          createdAt: 0,
          dismissed: false,
        },
        kind
      )
    },
    [currentConversationId, handleChatErrorAction]
  )

  const submitMessageAsBranch = useCallback(
    (id: string, newContent: string, _newContentBlocks?: any) => {
      if (!currentConversationId || selection.status === 'pending' || selection.status === 'error') return false

      // Replace any @file mentions with actual file contents before branching.
      const processed = replaceFileMentionsWithPath(newContent)
      const contentWithIdeContext = appendIdeContextToMessage(processed)
      const parsedId = parseId(id)
      const originalMessage = conversationMessages.find(m => m.id === parsedId)
      const { content: contentWithCwdAnnouncement, pendingCwdValue } = withPendingCwdAnnouncement(
        currentConversationId,
        contentWithIdeContext
      )

      if (!originalMessage) {
        console.error('Message not found for branch/edit:', id)
        return false
      }

      // Keep artifacts so pasted images do not flicker away during branch send.
      const branchDraftArtifacts = getBranchImageDraftDataUrls(parsedId)
      const optimisticArtifacts = Array.from(
        new Set([
          ...(Array.isArray(originalMessage.artifacts) ? originalMessage.artifacts : []),
          ...branchDraftArtifacts,
        ])
      )
      const optimisticBranchMessage: Message = {
        id: `branch-temp-${Date.now()}`,
        conversation_id: currentConversationId,
        role: 'user' as const,
        content: contentWithCwdAnnouncement,
        content_plain_text: contentWithCwdAnnouncement,
        parent_id: originalMessage.parent_id,
        children_ids: [],
        created_at: new Date().toISOString(),
        model_name: selectedModel?.name || '',
        partial: false,
        pastedContext: [],
        artifacts: optimisticArtifacts,
      }
      dispatch(chatSliceActions.optimisticBranchMessageSet(optimisticBranchMessage))

      const streamId = generateStreamId('branch')
      setPendingViewStream({ streamId, conversationId: currentConversationId!, selectionRevision: selection.fallbackRevision })
      recordSentMessage(newContent)

      dispatch(
        editMessageWithBranching({
          conversationId: currentConversationId,
          originalMessageId: parsedId,
          newContent: contentWithCwdAnnouncement,
          modelOverride: selectedModel?.name,
          think: think,
          serviceTier: openAIServiceTier,
          cwd: ccCwd || undefined,
          operationMode,
          selectionRevision: selection.revision,
          lineageId: modeLineageId,
          branchPath: selectedPath,
          streamId,
        })
      )
        .unwrap()
        .then(() => {
          clearPendingCwdAnnouncement(currentConversationId, pendingCwdValue)
          dispatch(chatSliceActions.messageArtifactsBackupCleared({ messageId: parsedId }))
          void refreshConversationSnapshot()
        })
        .catch(error => {
          // Clear optimistic branch message on error
          dispatch(chatSliceActions.optimisticBranchMessageCleared())
          console.error('Failed to branch message:', error)
          // The branch attempt failed; surface the error without mutating the main composer.
          recordLocalChatError(error, {
            phase: 'open',
            conversationId: currentConversationId,
            parentMessageId: originalMessage.parent_id ?? null,
            streamId,
          })
        })
      return true
    },
    [
      selection.revision,
      selection.fallbackRevision,
      modeLineageId,
      selectedPath,
      selection.status,
      currentConversationId,
      selectedModel?.name,
      think,
      openAIServiceTier,
      operationMode,
      ccCwd,
      dispatch,
      replaceFileMentionsWithPath,
      appendIdeContextToMessage,
      conversationMessages,
      refreshConversationSnapshot,
      withPendingCwdAnnouncement,
      clearPendingCwdAnnouncement,
      getBranchImageDraftDataUrls,
      recordLocalChatError,
    ]
  )

  const handleMessageEdit = useCallback(
    (id: string, newContent: string, newContentBlocks?: any) => {
      dispatch(
        updateMessage({
          id: parseId(id),
          content: newContent,
          content_blocks: newContentBlocks,
        })
      )
        .unwrap()
        .then(() => {
          if (currentConversationId) void refreshConversationSnapshot()
        })
        .catch(error => {
          console.error('Failed to update message:', error)
          // The editor closes on submit, so a rejected save silently reverted the message to its
          // old text with no indication the edit was lost. Say so.
          recordLocalChatError(error, {
            phase: 'open',
            conversationId: currentConversationId,
            parentMessageId: parseId(id),
          })
        })
    },
    [currentConversationId, dispatch, refreshConversationSnapshot, recordLocalChatError]
  )

  const handleMessageBranch = useCallback(
    (id: string, newContent: string, newContentBlocks?: any) => {
      return submitMessageAsBranch(id, newContent, newContentBlocks)
    },
    [submitMessageAsBranch]
  )

  const handleExplainFromSelection = useCallback(
    (id: string, newContent: string) => {
      if (!currentConversationId || selection.status === 'pending' || selection.status === 'error') return false

      // Explain selection should always create a new user child under the selected message,
      // even when that message already has children.
      const processed = replaceFileMentionsWithPath(newContent)
      const contentWithIdeContext = appendIdeContextToMessage(processed)
      const parsedId = parseId(id)
      const originalMessage = conversationMessages.find(m => m.id === parsedId)
      const { content: contentWithCwdAnnouncement, pendingCwdValue } = withPendingCwdAnnouncement(
        currentConversationId,
        contentWithIdeContext
      )

      if (!originalMessage) {
        console.error('Message not found:', id)
        return false
      }

      const optimisticUserMessage: Message = {
        id: `temp-${Date.now()}`,
        conversation_id: currentConversationId,
        role: 'user' as const,
        content: contentWithCwdAnnouncement,
        content_plain_text: contentWithCwdAnnouncement,
        parent_id: parsedId,
        children_ids: [],
        created_at: new Date().toISOString(),
        model_name: selectedModel?.name || '',
        partial: false,
        pastedContext: [],
        artifacts: [],
      }
      dispatch(chatSliceActions.optimisticMessageSet(optimisticUserMessage))

      const streamId = generateStreamId('primary')
      setPendingViewStream({ streamId, conversationId: currentConversationId!, selectionRevision: selection.fallbackRevision })
      recordSentMessage(newContent)

      dispatch(
        sendMessage({
          conversationId: currentConversationId,
          input: { content: contentWithCwdAnnouncement },
          // Keep normal-send UI/settings, but explicitly authorize a child at this
          // selected historical message rather than ordinary head continuation.
          isBranch: true,
          parent: parsedId,
          repeatNum: 1,
          think: think,
          imageConfig: isImageGenerationModel ? imageConfig : undefined,
          reasoningConfig: think ? reasoningConfig : undefined,
          serviceTier: openAIServiceTier,
          cwd: ccCwd || undefined,
          operationMode,
          selectionRevision: selection.revision,
          lineageId: modeLineageId,
          branchPath: selectedPath,
          streamId,
        })
      )
        .unwrap()
        .then(result => {
          clearPendingCwdAnnouncement(currentConversationId, pendingCwdValue)
          if (!result?.userMessage) {
            console.warn('Server did not confirm user message')
          }
          // Messages already added to Redux via SSE stream
        })
        .catch(error => {
          dispatch(chatSliceActions.optimisticMessageCleared())
          console.error('Failed to send explain-selection message:', error)
          // Surface the failure without copying this branch prompt into the main composer.
          recordLocalChatError(error, {
            phase: 'open',
            conversationId: currentConversationId,
            parentMessageId: parsedId,
            streamId,
          })
        })
      return true
    },
    [
      selection.revision,
      selection.fallbackRevision,
      modeLineageId,
      selectedPath,
      selection.status,
      currentConversationId,
      selectedModel?.name,
      think,
      dispatch,
      replaceFileMentionsWithPath,
      appendIdeContextToMessage,
      conversationMessages,
      ccCwd,
      isImageGenerationModel,
      imageConfig,
      reasoningConfig,
      openAIServiceTier,
      operationMode,
      withPendingCwdAnnouncement,
      clearPendingCwdAnnouncement,
      recordLocalChatError,
    ]
  )

  const handleResend = useCallback(
    (id: string) => {
      // Find the message by id from displayed messages first, fallback to all conversation messages
      const parsedId = parseId(id)
      const msg = displayMessages.find(m => m.id === parsedId) || conversationMessages.find(m => m.id === parsedId)

      if (!msg) {
        console.warn('Resend requested for unknown message id:', id)
        return
      }

      // For resend, branch from the PARENT user message with the parent's content
      const parentId = msg.parent_id
      if (!parentId) {
        console.warn('Resend requested but message has no parent to branch from:', id)
        return
      }
      const parentMsg =
        displayMessages.find(m => m.id === parentId) || conversationMessages.find(m => m.id === parentId)
      if (!parentMsg) {
        console.warn('Parent message not found for resend. Parent id:', parentId)
        return
      }

      // Use parent message id and its content to create a sibling branch (resend)
      handleMessageBranch(parentId.toString(), parentMsg.content)
    },
    [displayMessages, conversationMessages, handleMessageBranch]
  )

  const handleNodeSelect = useCallback(
    (nodeId: string, path: string[]) => {
      if (!nodeId || !path.length || !currentConversationId) return
      chatSelection.select({
        kind: 'message', conversationId: currentConversationId,
        messageId: nodeId, path,
      }, { inPlace: true, source: 'heimdall' })
    },
    [chatSelection, currentConversationId]
  )

  const handleOpenParallel = useCallback(
    (conversationId: ConversationId, messageId: MessageId, path: string[]) => {
      if (currentConversationId == null || String(conversationId) !== String(currentConversationId)) return
      const parsedPath = path.map(parseId).filter(id => typeof id === 'string' || typeof id === 'number') as MessageId[]
      if (parsedPath.length === 0) return
      setParallelPane({ conversationId, messageId, path: parsedPath })
      setActiveChatPane('parallel')
    },
    [currentConversationId]
  )

  // Close/reset the session-only second pane when navigating to another conversation.
  useEffect(() => {
    setParallelPane(null)
    setActiveChatPane('primary')
  }, [conversationIdFromUrl])

  // const handleOnResend = (id: string) => {
  //   if (currentConversationId) {
  //     dispatch(
  //       sendMessage({
  //         conversationId: currentConversationId,
  //         input: messageInput,
  //         repeatNum: 1,
  //         parent: parseInt(id),
  //       })
  //     )
  //   }
  // }

  const performDelete = useCallback(
    async (id: string) => {
      const messageId = parseId(id)
      // console.log('[Chat] performDelete called:', {
      //   messageId,
      //   currentConversationId,
      //   conversationStorageMode,
      // })
      dispatch(chatSliceActions.messageDeleted(messageId))

      if (!currentConversationId) {
        return
      }

      try {
        await dispatch(
          deleteMessage({ id: messageId, conversationId: currentConversationId, storageMode: conversationStorageMode })
        ).unwrap()
      } catch (error) {
        console.error('[Chat] Failed to delete message:', error)
      } finally {
        await refreshConversationSnapshot()
      }
    },
    [dispatch, currentConversationId, conversationStorageMode, refreshConversationSnapshot]
  )

  const handleRequestDelete = useCallback(
    (id: string) => {
      if (!confirmDel) {
        void performDelete(id)
      } else {
        setPendingDeleteId(id)
      }
    },
    [confirmDel, performDelete]
  )

  const closeDeleteModal = () => {
    setPendingDeleteId(null)
    setDontAskAgain(false)
  }

  const confirmDeleteModal = () => {
    if (dontAskAgain) setconfirmDel(false)
    if (pendingDeleteId) void performDelete(pendingDeleteId)
    closeDeleteModal()
  }

  const closeOpenRouterLoginRequiredModal = () => {
    setOpenRouterLoginRequiredModalOpen(false)
  }

  const confirmOpenRouterLoginRequired = () => {
    setOpenRouterLoginRequiredModalOpen(false)
    navigate('/login?required=cloud')
  }

  // OpenAI ChatGPT login modal handlers
  const closeOpenaiLoginModal = () => {
    setOpenaiLoginModalOpen(false)
    setOpenaiAuthFlow(null)
    // setOpenaiCallbackInput('')
    setOpenaiAuthError(null)
    setOpenaiAuthLoading(false)
    setOpenaiAuthPolling(false)
  }

  const handleOpenaiLogin = async () => {
    if (!openaiAuthFlow) return
    await openOpenaiAuthUrl(openaiAuthFlow.url)
  }

  const completeOpenaiAuthFlow = async (
    state: string,
    options: { silentPending?: boolean; suppressErrors?: boolean } = {}
  ): Promise<'success' | 'pending' | 'error'> => {
    setOpenaiAuthLoading(true)
    if (!options.silentPending) {
      setOpenaiAuthError(null)
    }

    try {
      // Retrieve tokens from server using state (server already exchanged the code)
      const data = await localApi.post<{
        pending?: boolean
        success?: boolean
        error?: string
        accessToken?: string
        refreshToken?: string
        expiresAt?: number
        accountId?: string
        email?: string | null
      }>('/openai/auth/complete', { state })

      if (data.pending) {
        if (!options.silentPending) {
          setOpenaiAuthError('Please complete the sign-in in your browser first.')
        }
        return 'pending'
      }

      if (!data.success) {
        if (!options.suppressErrors) {
          setOpenaiAuthError(data.error || 'Authentication failed. Please try again.')
        }
        return 'error'
      }

      // The server committed the connection; no OAuth credentials cross this boundary.

      // Successfully authenticated, select the provider
      requestModelSwitch({ provider: 'OpenAI (ChatGPT)', model: null }, () => {
        dispatch(chatSliceActions.branchModelSelected({ provider: 'OpenAI (ChatGPT)', model: null }))
        dispatch(chatSliceActions.providerSelected('OpenAI (ChatGPT)'))
      }, openaiSelectionScopeRef.current ?? modelSwitchScope)
      closeOpenaiLoginModal()
      return 'success'
    } catch (error) {
      console.error('OpenAI auth callback error:', error)
      if (!options.suppressErrors) {
        setOpenaiAuthError('Authentication failed. Please try again.')
      }
      return 'error'
    } finally {
      setOpenaiAuthLoading(false)
    }
  }

  useEffect(() => {
    if (!openaiLoginModalOpen || !openaiAuthFlow?.state) return

    let cancelled = false
    let inFlight = false
    const state = openaiAuthFlow.state
    const startedAt = Date.now()
    const timeoutMs = 2 * 60 * 1000
    const pollIntervalMs = 1500

    setOpenaiAuthPolling(true)

    const poll = async () => {
      if (cancelled || inFlight) return
      inFlight = true

      const result = await completeOpenaiAuthFlow(state, { silentPending: true, suppressErrors: true })
      inFlight = false

      if (cancelled || result === 'success') return

      if (result === 'error') {
        setOpenaiAuthPolling(false)
        setOpenaiAuthError('Authentication failed or expired. Please restart sign-in and try again.')
        return
      }

      if (Date.now() - startedAt >= timeoutMs) {
        setOpenaiAuthPolling(false)
        setOpenaiAuthError(
          'Sign-in is taking longer than expected. Finish in your browser or open the sign-in page again.'
        )
        return
      }

      window.setTimeout(poll, pollIntervalMs)
    }

    const initialPollDelay = window.setTimeout(poll, 1000)

    return () => {
      cancelled = true
      window.clearTimeout(initialPollDelay)
    }
    // Polling intentionally captures the completion handler for this OAuth state only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openaiLoginModalOpen, openaiAuthFlow?.state])

  const handleOpenaiLogout = async () => {
    clearOpenAITokens()
    try {
      await clearOpenAITokens()
    } catch (error) {
      console.error('Failed to clear headless OpenAI ChatGPT tokens:', error)
    }
    // If currently on OpenAI provider, switch back to an allowed local provider
    if (providers.currentProvider === 'OpenAI (ChatGPT)') {
      const fallbackProvider = providers.providers.some(provider => provider.name === 'LM Studio')
        ? 'LM Studio'
        : providers.providers[0]?.name
      if (fallbackProvider) {
        dispatch(chatSliceActions.providerSelected(fallbackProvider))
      }
    }
    closeOpenaiLoginModal()
  }

  // Handle adding text to research note
  const handleAddToNote = useCallback(
    (text: string) => {
      if (!currentConversationId) {
        console.warn('No active conversation to add note to')
        return
      }

      // Expand the right bar to show the note
      dispatch(uiActions.rightBarExpanded())

      // Get current research note from conversation
      const existingNote = currentConversation?.research_note || ''

      // Create timestamp for the note entry
      const timestamp = new Date().toLocaleString()

      // Append new text with timestamp and separator
      const separator = existingNote ? '\n\n---\n\n' : ''
      const newEntry = `[${timestamp}]\n${text}`
      const updatedNote = existingNote + separator + newEntry

      // Dispatch update action
      dispatch(updateResearchNote({ id: currentConversationId, researchNote: updatedNote }))
        .unwrap()
        .then(() => {
          // Update React Query caches to reflect the new research note
          const projectId = selectedProject?.id || currentConversation?.project_id

          // Update all conversations cache
          const conversationsCache = queryClient.getQueryData<Conversation[]>(['conversations'])
          if (conversationsCache) {
            queryClient.setQueryData(
              ['conversations'],
              conversationsCache.map(conv =>
                conv.id === currentConversationId ? { ...conv, research_note: updatedNote } : conv
              )
            )
          }

          // Update project conversations cache if project exists
          if (projectId) {
            const projectConversationsCache = queryClient.getQueryData<Conversation[]>([
              'conversations',
              'project',
              projectId,
            ])
            if (projectConversationsCache) {
              queryClient.setQueryData(
                ['conversations', 'project', projectId],
                projectConversationsCache.map(conv =>
                  conv.id === currentConversationId ? { ...conv, research_note: updatedNote } : conv
                )
              )
            }
          }

          // Update recent conversations cache
          const recentCache = queryClient.getQueryData<Conversation[]>(['conversations', 'recent'])
          if (recentCache) {
            queryClient.setQueryData(
              ['conversations', 'recent'],
              recentCache.map(conv =>
                conv.id === currentConversationId ? { ...conv, research_note: updatedNote } : conv
              )
            )
          }

          // Update research notes cache
          const researchNotesCache = queryClient.getQueryData<ResearchNoteItem[]>(['research-notes', userId])
          if (researchNotesCache) {
            // If note is empty or whitespace, remove from list
            if (!updatedNote || updatedNote.trim().length === 0) {
              queryClient.setQueryData(
                ['research-notes', userId],
                researchNotesCache.filter(item => item.id !== currentConversationId)
              )
            } else {
              // Update existing note or add new one
              const existingIndex = researchNotesCache.findIndex(item => item.id === currentConversationId)
              if (existingIndex >= 0) {
                // Update existing note
                queryClient.setQueryData(
                  ['research-notes', userId],
                  researchNotesCache.map(item =>
                    item.id === currentConversationId
                      ? {
                          ...item,
                          research_note: updatedNote,
                          updated_at: new Date().toISOString(),
                        }
                      : item
                  )
                )
              } else {
                // Add new note to the list
                queryClient.setQueryData(
                  ['research-notes', userId],
                  [
                    {
                      id: currentConversationId,
                      title: currentConversation?.title || `Conversation ${currentConversationId}`,
                      research_note: updatedNote,
                      updated_at: new Date().toISOString(),
                      project_id: projectId || null,
                    },
                    ...researchNotesCache,
                  ]
                )
              }
            }
          }

          // console.log('Added to research note successfully')
        })
        .catch(error => {
          console.error('Failed to update research note:', error)
        })
    },
    [currentConversationId, currentConversation, selectedProject, queryClient, dispatch, userId]
  )

  const handleComposerSubmit = useCallback(() => {
    const content = getLocalInput().trim()
    if (content.startsWith('/')) {
      void (async () => {
        const commandResult = await runComposerCommand(content)
        if (commandResult.handled) {
          if (commandResult.clearInput) {
            clearLocalInput()
          }
          return
        }

        handleSend(multiReplyCount)
      })()
      return
    }

    handleSend(multiReplyCount)
  }, [clearLocalInput, getLocalInput, handleSend, multiReplyCount, runComposerCommand])

  const handleComposerBlurPersist = useCallback(
    (content: string) => {
      dispatch(chatSliceActions.inputChanged({ content }))
    },
    [dispatch]
  )

  const handleAttachmentInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || [])
      if (files.length === 0) return

      const pdfFiles = files.filter(file => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))
      const imageFiles = files.filter(file => file.type.startsWith('image/'))

      // Register image preparation before awaiting unrelated PDF extraction.
      if (imageFiles.length) {
        const target: ImageDraftTarget = activeBranchEditingMessageId != null
          ? { kind: 'branch', messageId: parseId(activeBranchEditingMessageId) } : { kind: 'composer' }
        void dispatch(prepareImageFiles(imageFiles, target))
      }

      if (pdfFiles.length > 0) {
        try {
          const pdfTexts = await Promise.all(
            pdfFiles.map(async file => {
              const text = await extractTextFromPdf(file)
              return `[Pdf Content for ${file.name}]:\n${text}`
            })
          )
          updateLocalInput(prev => {
            const prefix = prev ? `${prev}\n\n` : ''
            return prefix + '```\n' + pdfTexts + '\n``` \n\n'
          })
          focusLocalInput()
        } catch (err) {
          console.error('Failed to extract PDF text(s)', err)
        }
      }


      e.target.value = ''
    },
    [dispatch, activeBranchEditingMessageId, updateLocalInput, focusLocalInput]
  )

  // const handleMultiReplyCountChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
  //   const value = e.target.value
  //   if (value === '' || !isNaN(Number(value))) {
  //     dispatch(chatActions.multiReplyCountSet(Number(value)))
  //   }
  // }

  const handleOpenToolHtmlModal = useCallback(
    (key?: string) => {
      htmlRegistry?.openModal(key)
    },
    [htmlRegistry]
  )
  const canOpenHtmlTools = Boolean(htmlRegistry)
  const openToolHtmlModal = canOpenHtmlTools ? handleOpenToolHtmlModal : undefined

  const openSubagentTranscript = useCallback((toolCallId: string) => {
    setSubagentTranscriptToolCallId(toolCallId)
  }, [])

  // Refresh models using React Query mutation
  // const handleRefreshModels = useCallback(() => {
  //   if (providers.currentProvider) {
  //     refreshModelsMutation.mutate(providers.currentProvider)
  //   }
  // }, [providers.currentProvider, refreshModelsMutation])

  // Extract the most recent direct or multi_call-nested todo_list result from the current branch.
  const latestTodoList = useMemo(() => extractLatestTodoList(displayMessages), [displayMessages])

  const branchFileMutationData = useMemo(() => extractBranchFileMutations(displayMessages), [displayMessages])
  const hasLatestTodoList = Boolean(latestTodoList?.items?.length)
  const hasBranchFileMutations = branchFileMutationData.latestByPath.length > 0
  const showComposerSummaryPanels = hasLatestTodoList || hasBranchFileMutations
  const showComposerSummaryPanelsAsRow = hasLatestTodoList && hasBranchFileMutations
  const composerSummaryPanelClassName = showComposerSummaryPanelsAsRow ? 'min-w-0 flex-1 basis-0' : 'min-w-0 w-full'
  const composerSummaryPanelsCollapsed = showComposerSummaryPanelsAsRow
    ? todoListCollapsed && workspaceMutationsCollapsed
    : false
  const effectiveTodoListCollapsed = showComposerSummaryPanelsAsRow ? composerSummaryPanelsCollapsed : todoListCollapsed
  const effectiveWorkspaceMutationsCollapsed = showComposerSummaryPanelsAsRow
    ? composerSummaryPanelsCollapsed
    : workspaceMutationsCollapsed
  const toggleTodoListCollapsed = useCallback(() => {
    const nextCollapsed = !effectiveTodoListCollapsed
    setTodoListCollapsed(nextCollapsed)
    if (showComposerSummaryPanelsAsRow) {
      setWorkspaceMutationsCollapsed(nextCollapsed)
    }
  }, [effectiveTodoListCollapsed, showComposerSummaryPanelsAsRow])
  const toggleWorkspaceMutationsCollapsed = useCallback(() => {
    const nextCollapsed = !effectiveWorkspaceMutationsCollapsed
    setWorkspaceMutationsCollapsed(nextCollapsed)
    if (showComposerSummaryPanelsAsRow) {
      setTodoListCollapsed(nextCollapsed)
    }
  }, [effectiveWorkspaceMutationsCollapsed, showComposerSummaryPanelsAsRow])

  const handleOpenWorkspaceMutationDiffs = useCallback(() => {
    const filePaths = branchFileMutationData.latestByPath.map(summary => summary.path)
    if (filePaths.length === 0) return

    dispatchOpenWorkspaceMutationDiffs({
      filePaths,
      basePath: ccCwd || null,
      focusPath: branchFileMutationData.latestByPath[0]?.path || null,
    })
  }, [branchFileMutationData.latestByPath, ccCwd])
  const handleOpenWorkspaceMutationDiffForPath = useCallback(
    (filePath: string) => {
      const normalizedPath = filePath.trim()
      if (!normalizedPath) return

      dispatchOpenWorkspaceMutationDiffs({
        filePaths: [normalizedPath],
        basePath: ccCwd || null,
        focusPath: normalizedPath,
      })
    },
    [ccCwd]
  )

  // Removed obsolete streaming completion effect that synthesized assistant messages.
  // The streaming thunks now dispatch messageAdded and messageBranchCreated directly,
  // and reducers update currentPath appropriately. This avoids race conditions and
  // incorrect parent linking that could break currentPath after branching.

  // Get current credits from user state (in USD cents)
  const current_credits = currentUser?.cached_current_credits ?? 0

  // Calculate context usage from displayed messages (current branch).
  // Includes project/conversation prompts + message content + nested content_blocks/tool_calls.
  const tokenUsage = useMemo(() => calculateBranchContextUsage({
    providerName: providers.currentProvider,
    messages: displayMessages,
    prompts: [
      selectedProject?.system_prompt,
      selectedProject?.context,
      currentConversation?.system_prompt,
      currentConversation?.conversation_context,
    ],
  }), [
    displayMessages,
    selectedProject?.system_prompt,
    selectedProject?.context,
    currentConversation?.system_prompt,
    currentConversation?.conversation_context,
    providers.currentProvider,
  ])

  // Calculate total context budget (single combined budget for easier interpretation).
  const tokenLimits = useMemo(() => {
    const usdValue = current_credits / 100 // Convert credits to USD

    // Model context limit.
    const totalContextLimit =
      resolveProviderContextLength(providers.currentProvider, selectedModel?.contextLength, providerSettings) || 128_000

    // Cost is per 1K tokens: cost = (tokens / 1000) * costPer1K
    // So: tokens = (usd * 1000) / costPer1K
    const promptCostPer1K = selectedModel?.promptCost ?? 0
    const completionCostPer1K = selectedModel?.completionCost ?? 0

    // Calculate credit-based limits.
    let creditInputLimit = Infinity
    let creditOutputLimit = Infinity

    if (promptCostPer1K > 0) {
      creditInputLimit = Math.floor((usdValue * 1000) / promptCostPer1K)
    }
    if (completionCostPer1K > 0) {
      creditOutputLimit = Math.floor((usdValue * 1000) / completionCostPer1K)
    }

    // Single budget: constrained by model context and available credit limits.
    const totalBudget = Math.max(0, Math.min(totalContextLimit, creditInputLimit, creditOutputLimit))

    return { totalBudget, totalContextLimit }
  }, [
    selectedModel?.promptCost,
    selectedModel?.completionCost,
    selectedModel?.contextLength,
    providers.currentProvider,
    providerSettings.openAiChatGptMaxContextTokens,
    current_credits,
  ])

  // Calculate progress percentages.
  const totalContextProgress =
    tokenLimits.totalBudget > 0 ? Math.min((tokenUsage.totalContextTokens / tokenLimits.totalBudget) * 100, 100) : 0
  const tokenUsageProgressColor =
    customThemeEnabled && chatProgressBarFillColor
      ? chatProgressBarFillColor
      : totalContextProgress >= 95
        ? isDarkMode
          ? '#f87171'
          : '#ef4444'
        : totalContextProgress >= 80
          ? isDarkMode
            ? '#fbbf24'
            : '#f59e0b'
          : isDarkMode
            ? '#60a5fa'
            : '#3b82f6'
  const tokenUsageTintStrength = isDarkMode ? 16 : 13
  const leftControlsTokenTintBaseColor = isDarkMode ? 'rgba(23, 23, 23, 0.4)' : 'rgba(245, 245, 245, 0.4)'
  const leftControlsTokenTintStyle: React.CSSProperties | undefined = showTokenUsageBar
    ? {
        backgroundImage: `linear-gradient(90deg, color-mix(in srgb, ${tokenUsageProgressColor} ${tokenUsageTintStrength}%, transparent) 0%, color-mix(in srgb, ${tokenUsageProgressColor} ${tokenUsageTintStrength}%, transparent) ${totalContextProgress}%, ${leftControlsTokenTintBaseColor} ${Math.min(totalContextProgress + 8, 100)}%)`,
      }
    : undefined
  const rightControlsTintColor = resolveComposerAgentTint(isDarkMode, customThemeEnabled ? customTheme : undefined, {
    animation: chatInputBorderAnimation,
    lightColor: chatInputBorderLightColor,
    darkColor: chatInputBorderDarkColor,
  })
  const fastModeAnimation = useFastModeAnimation()
  const showFastModeAnimation = isOpenAIChatGPTProvider && fastServiceTierEnabled && fastModeAnimation !== 'none'
  const rightControlsTintStrength = isDarkMode ? 28 : 24
  const rightControlsTintStyle: React.CSSProperties | undefined =
    operationMode === 'plan'
      ? undefined
      : {
          backgroundColor: `color-mix(in srgb, ${rightControlsTintColor} ${rightControlsTintStrength}%, ${leftControlsTokenTintBaseColor})`,
        }
  // Auto-compaction now runs as part of the explicit user send flow (handleSend),
  // so we intentionally avoid passive threshold-triggered compaction effects here.

  return (
    <motion.div
      initial={{ opacity: 0, x: 10 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -10 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      ref={containerRef}
      className='chat-layout flex h-full min-h-0 min-w-0 overflow-hidden bg-transparent dark:bg-transparent'
    >
      <div
        data-chat-pane-surface='true'
        data-chat-pane-kind='primary'
        data-chat-pane-active={activeChatPane === 'primary' ? 'true' : 'false'}
        onMouseDown={() => setActiveChatPane('primary')}
        onFocusCapture={() => setActiveChatPane('primary')}
        className={`relative flex flex-col ${(heimdallVisible || parallelPane) && !isMobile ? 'flex-none' : 'flex-1'} rounded-xl mb-2 min-w-0 bg-transparent sm:min-w-[240px] md:min-w-[280px] overflow-hidden`}
        style={{
          width: isMobile
            ? '100%'
            : parallelPane
              ? `calc(${((heimdallVisible ? leftWidthPct : 100) * parallelSplitPct) / 100}% - 6px)`
              : heimdallVisible
                ? `${leftWidthPct}%`
                : 'auto',
          backgroundColor: chatSurfaceBackgroundColor,
        }}
      >
        <div
          className={`relative mx-4 flex flex-col thin-scrollbar rounded-lg bg-transparent dark:bg-transparent flex-1 min-h-0 min-w-0 overflow-hidden transition-[padding-bottom] duration-200 ${!heimdallVisible ? 'px-0 sm:px-0 ' : ''}`}
          style={{ paddingBottom: `0px`, backgroundColor: chatSurfaceBackgroundColor }}
        >
          <ConversationOpeningOverlay visible={isBrowserClient && selection.status === 'pending'} />
          {/* Conversation title and actions */}
          {currentConversationId && (
            <div
              inert={!isTitleBarVisible}
              className={`absolute my-2 top-0 left-0 px-2 z-10 mx-auto right-0 transition-[opacity,transform] duration-[var(--ygg-motion-duration-standard)] ease-out motion-reduce:transform-none ${isTitleBarVisible ? 'opacity-100 translate-y-0 pointer-events-auto' : 'opacity-0 -translate-y-4 pointer-events-none'} ${!heimdallVisible ? 'max-w-full sm:max-w-xl md:max-w-2xl lg:max-w-3xl xl:max-w-3xl 2xl:max-w-4xl 3xl:max-w-6xl' : 'max-w-full sm:max-w-xl md:max-w-2xl lg:max-w-3xl xl:max-w-4xl 2xl:max-w-4xl'}`}
            >
              <ConversationToolbar
                key={String(currentConversationId)}
                title={currentConversation?.title ?? ''}
                backgroundColor={conversationToolbarBackgroundColor}
                treeVisible={heimdallVisible}
                customTheme={customTheme}
                customThemeEnabled={customThemeEnabled}
                isDarkMode={isDarkMode}
                onToggleTree={() => {
                  const newValue = !heimdallVisible
                  setHeimdallVisible(newValue)
                  try {
                    window.localStorage.setItem('chat:heimdallVisible', String(newValue))
                  } catch {}
                }}
                onRefresh={() => { void refreshConversationSnapshot() }}
                onRename={handleRenameConversation}
                onEditingChange={handleTitleEditingChange}
              />
            </div>
          )}
          {/* Messages Display. `isolate` keeps row z-indexes (focus-within:z-[70], the editing row's
              zIndex 80) local to this list. Without it they compete in the root stacking context
              and paint over the right bar (`relative z-10` in rightBar.tsx). Message popovers are
              portaled to body, so nothing in here needs to escape.
              Keep toolbar clearance independent of visibility: shrinking padding at the bottom
              clamps scrollTop, which the direction listener mistakes for an upward user scroll.
              Only the absolute toolbar animates; hiding it must not change transcript geometry. */}
          <div
            ref={messagesContainerRef}
            className={`isolate flex flex-col ${currentConversationId ? (editingTitle ? 'pt-28' : 'pt-22') : 'pt-6'} dark:border-neutral-700 border-stone-200 rounded-lg overflow-y-auto overflow-x-hidden thin-scrollbar overscroll-y-contain touch-pan-y`}
            style={{
              ['overflowAnchor' as any]: 'none',
              willChange: 'scroll-position',
              backgroundColor: chatSurfaceBackgroundColor,
            }}
          >
            <React.Profiler id='chat-virtual-list' onRender={handleVirtualListProfilerRender}>
              {virtualRows.length === 0 ? (
                // Only show the empty state once the conversation's messages have actually resolved
                // (or there is no conversation yet). Otherwise, on every conversation switch the list
                // flashes "Start building" during the refetch while messagesLoaded([]) has cleared it.
                !conversationIdFromUrl || isConversationDataFetched ? (
                  <EmptyChatState onSelectProjectFolder={handleSelectProjectFolder} projectFolderPath={ccCwd} />
                ) : null
              ) : (
                (() => {
                  const totalSize = virtualizer.getTotalSize()
                  const virtualItems = virtualizer.getVirtualItems()

                  return (
                    <div
                      style={{
                        minHeight: `${totalSize}px`,
                        height: `${totalSize}px`,
                        width: '100%',
                        position: 'relative',
                        flexShrink: 0,
                      }}
                    >
                      {virtualItems.map(virtualRow => {
                        const renderRow = virtualRows[virtualRow.index]
                        if (!renderRow) return null

                        if (renderRow.kind === 'run_stats') {
                          return (
                            <VirtualizedRowContainer key={renderRow.key} id={renderRow.key}
                              index={virtualRow.index} start={virtualRow.start} measureElement={virtualizer.measureElement}>
                              <RunStatisticsFooter statistics={renderRow.statistics} customTheme={customTheme}
                                customThemeEnabled={customThemeEnabled} isDarkMode={isDarkMode} />
                            </VirtualizedRowContainer>
                          )
                        }
                        if (renderRow.kind === 'optimistic_message') {
                          const message = renderRow.message
                          return (
                            <VirtualizedRowContainer
                              key={renderRow.key}
                              id={`message-optimistic-${message.id}`}
                              index={virtualRow.index}
                              start={virtualRow.start}
                              measureElement={virtualizer.measureElement}
                            >
                              <ChatMessage
                                id={message.id.toString()}
                                role={message.role}
                                content={message.content}
                                timestamp={message.created_at}
                                modelName={message.model_name}
                                artifacts={message.artifacts}
                                width='w-full'
                                fontSizeOffset={fontSizeOffset}
                                groupToolReasoningRuns={groupToolReasoningRuns}
                                truncateToolOutput={truncateToolOutput}
                                customTheme={customTheme}
                                customThemeEnabled={customThemeEnabled}
                                isDarkMode={isDarkMode}
                                className='opacity-70'
                                userTurnElapsedLabel={userTurnElapsedLabelByMessageId.get(String(message.id))}
                                onOpenToolHtmlModal={openToolHtmlModal}
                                onOpenSubagentTranscript={openSubagentTranscript}
                                onChatErrorAction={handlePersistedChatErrorAction}
                              />
                            </VirtualizedRowContainer>
                          )
                        }

                        if (renderRow.kind === 'optimistic_branch_message') {
                          const message = renderRow.message
                          return (
                            <VirtualizedRowContainer
                              key={renderRow.key}
                              id={`message-optimistic-branch-${message.id}`}
                              index={virtualRow.index}
                              start={virtualRow.start}
                              measureElement={virtualizer.measureElement}
                            >
                              <ChatMessage
                                id={message.id.toString()}
                                role={message.role}
                                content={message.content}
                                timestamp={message.created_at}
                                modelName={message.model_name}
                                artifacts={message.artifacts}
                                width='w-full'
                                fontSizeOffset={fontSizeOffset}
                                groupToolReasoningRuns={groupToolReasoningRuns}
                                truncateToolOutput={truncateToolOutput}
                                customTheme={customTheme}
                                customThemeEnabled={customThemeEnabled}
                                isDarkMode={isDarkMode}
                                className='opacity-70'
                                userTurnElapsedLabel={userTurnElapsedLabelByMessageId.get(String(message.id))}
                                onOpenToolHtmlModal={openToolHtmlModal}
                                onOpenSubagentTranscript={openSubagentTranscript}
                                onChatErrorAction={handlePersistedChatErrorAction}
                              />
                            </VirtualizedRowContainer>
                          )
                        }

                        if (renderRow.kind === 'streaming_message') {
                          if (!hasStreamingMessageContent) return null

                          // R4: no error bubble here. A failed stream is drawn by the message
                          // list only — see the `chat_error` row below (tier 2) or the persisted
                          // ErrorBlock on a real assistant row (tier 1).

                          // Process-only phase (thinking/tools, no final text yet). Once final text
                          // begins, this row leaves virtualRows and the live tail renders out of flow
                          // below (see `showLiveStreamingTail` block after the virtual list).
                          return (
                            <VirtualizedRowContainer
                              key={renderRow.key}
                              id='message-streaming'
                              index={virtualRow.index}
                              start={virtualRow.start}
                              measureElement={virtualizer.measureElement}
                            >
                              <ChatMessage
                                id='streaming'
                                role='assistant'
                                content={streamState.buffer}
                                streamEvents={visibleLiveEvents}
                    processRunActive={streamLifecycleActive}
                    firstProcessGroupExpanded={!liveAgentGroupId ? expandedProcessMessageRuns.has(transientProcessGroupKey) : undefined}
                    onFirstProcessGroupToggle={() => toggleProcessMessageRun(transientProcessGroupKey)}
                                width='w-full'
                                fontSizeOffset={fontSizeOffset}
                                groupToolReasoningRuns={groupToolReasoningRuns}
                                truncateToolOutput={truncateToolOutput}
                                customTheme={customTheme}
                                customThemeEnabled={customThemeEnabled}
                                isDarkMode={isDarkMode}
                                modelName={selectedModel?.name || undefined}
                                className=''
                                onOpenToolHtmlModal={openToolHtmlModal}
                                onOpenSubagentTranscript={openSubagentTranscript}
                                onChatErrorAction={handlePersistedChatErrorAction}
                              />
                            </VirtualizedRowContainer>
                          )
                        }

                        if (renderRow.kind === 'chat_error') {
                          const record = renderRow.record
                          return (
                            <VirtualizedRowContainer
                              key={renderRow.key}
                              id={`message-chat-error-${record.id}`}
                              index={virtualRow.index}
                              start={virtualRow.start}
                              measureElement={virtualizer.measureElement}
                            >
                              <div className='px-2 pt-2'>
                                <ChatErrorBubble
                                  envelope={record.envelope}
                                  actionPending={pendingChatErrorActionId === record.id}
                                  onAction={kind => handleChatErrorAction(record, kind)}
                                  onDismiss={() => dismissChatError(record)}
                                />
                              </div>
                            </VirtualizedRowContainer>
                          )
                        }

                        if (renderRow.kind === 'generation_loader') {
                          if (!showGenerationLoadingAnimation) return null

                          return (
                            <VirtualizedRowContainer
                              key={renderRow.key}
                              id='message-generation-loader'
                              index={virtualRow.index}
                              start={virtualRow.start}
                              measureElement={virtualizer.measureElement}
                            >
                              <div className={`${showStreamingMessage ? 'pt-2' : 'pt-1'} px-0 sm:px-2`}>
                                <StreamingThinkingIndicator
                                  compacting={showCompactionStatus}
                                  compactionCompleted={Boolean(compactionCompleted)}
                                  style={
                                    fontSizeOffset !== 0
                                      ? { fontSize: `calc(0.75em + ${fontSizeOffset}px)` }
                                      : undefined
                                  }
                                />
                              </div>
                            </VirtualizedRowContainer>
                          )
                        }

                        const row = renderRow.row

                        if (row.kind === 'process_group') {
                          const runId = String(row.id)
                          const liveHere = liveAgentGroupId === runId
                          const isExpanded = expandedProcessMessageRuns.has(runId) || (liveHere && expandedProcessMessageRuns.has(transientProcessGroupKey))
                          const liveEvents = liveHere && showStreamingMessage ? liveAgentEvents.process : []
                          const activityMessages = row.bridgedMessageId ? [...row.messages, ...(messageById.has(String(row.bridgedMessageId)) ? [messageById.get(String(row.bridgedMessageId))!] : [])] : row.messages
                          const groupedBlocks = activityMessages.flatMap(message => parsedMessageDataById.get(message.id)?.contentBlocks ?? [])
                          const groupedHooks = activityMessages.flatMap(message => message.hook_runs ?? [])
                          const progress = getAgentProgress(groupedBlocks, liveEvents, groupedHooks, liveHere)
                          const summary = progress.toolCount ? `${progress.completed} completed${progress.active && progress.pending ? ` · ${progress.pending} pending` : ''}` : row.toolCount ? `${row.toolCount} tools` : undefined
                          let toolOffset = 0
                          const activity = activityMessages.map(message => {
                            const blocks = parsedMessageDataById.get(message.id)?.contentBlocks ?? []
                            const offset = toolOffset
                            toolOffset += blocks.filter(block => block.type === 'tool_use').length
                            return <MessageActivity key={message.id} messageId={String(message.id)} blocks={blocks} hooks={message.hook_runs}
                              toolOffset={offset} fontSizeOffset={fontSizeOffset} customTheme={customTheme} customThemeEnabled={customThemeEnabled}
                              isDarkMode={isDarkMode} onHookRunsUpdated={handleHookRunsUpdated} onHookRunsSettled={handleHookRunsSettled} />
                          })
                          const hasActivity = groupedHooks.length > 0 || groupedBlocks.some(block => block.type === 'context_injection')

                          return (
                            <VirtualizedRowContainer
                              key={renderRow.key}
                              id={`message-group-${runId}`}
                              index={virtualRow.index}
                              start={virtualRow.start}
                              measureElement={virtualizer.measureElement}
                              className='z-0'
                            >
                              <div className='min-w-0 px-0 py-1 sm:px-2'>
                                <AgentSteps id={`message-group-${runId}`} expanded={isExpanded} onToggle={() => toggleProcessMessageRun(runId)}
                                  summary={summary} activity={hasActivity ? activity : undefined} status={progress.status} active={progress.active}
                                  style={fontSizeOffset !== 0 ? { fontSize: `calc(1em + ${fontSizeOffset}px)` } : undefined}
                                  history={<div>
                                    {row.messages.map(groupedMessage => {
                                      const { contentBlocks } =
                                        parsedMessageDataById.get(groupedMessage.id) ?? EMPTY_PARSED_MESSAGE_DATA
                                      return (
                                        <ChatMessage
                                          key={groupedMessage.id}
                                          id={groupedMessage.id.toString()}
                                          role={groupedMessage.role}
                                          content={groupedMessage.content}
                                          contentBlocks={contentBlocks?.filter(block => block.type !== 'context_injection')}
                                          timestamp={groupedMessage.created_at}
                                          width='w-full'
                                          modelName={groupedMessage.model_name}
                                          artifacts={groupedMessage.artifacts}
                                          fontSizeOffset={fontSizeOffset}
                                          groupToolReasoningRuns={false}
                                          truncateToolOutput={truncateToolOutput}
                                          customTheme={customTheme}
                                          customThemeEnabled={customThemeEnabled}
                                          isDarkMode={isDarkMode}
                                          onOpenToolHtmlModal={openToolHtmlModal}
                                          onOpenSubagentTranscript={openSubagentTranscript}
                                          onChatErrorAction={handlePersistedChatErrorAction}
                                          onHookRunsUpdated={handleHookRunsUpdated}
                                          onHookRunsSettled={handleHookRunsSettled}
                                        />
                                      )
                                    })}

                                    {(() => {
                                      if (row.bridgedMessageId == null) return null
                                      const bridgedMessage = messageById.get(String(row.bridgedMessageId))
                                      if (!bridgedMessage) return null

                                      const bridgedParsed =
                                        parsedMessageDataById.get(bridgedMessage.id) ?? EMPTY_PARSED_MESSAGE_DATA
                                      const bridgedProcessBlocks = Array.isArray(bridgedParsed.contentBlocks)
                                        ? bridgedParsed.contentBlocks.filter(block => isProcessContentBlock(block))
                                        : []

                                      const hasThinking =
                                        typeof bridgedMessage.thinking_block === 'string' &&
                                        bridgedMessage.thinking_block.trim().length > 0
                                      const hasToolCalls =
                                        Array.isArray(bridgedParsed.toolCalls) && bridgedParsed.toolCalls.length > 0
                                      const hasProcessBlocks = bridgedProcessBlocks.length > 0

                                      if (!hasThinking && !hasToolCalls && !hasProcessBlocks) {
                                        return null
                                      }

                                      return (
                                        <ChatMessage
                                          key={`bridged-process-${bridgedMessage.id}`}
                                          id={`${bridgedMessage.id}-process`}
                                          role={bridgedMessage.role}
                                          content=''
                                          contentBlocks={bridgedProcessBlocks}
                                          timestamp={bridgedMessage.created_at}
                                          width='w-full'
                                          modelName={bridgedMessage.model_name}
                                          artifacts={bridgedMessage.artifacts}
                                          fontSizeOffset={fontSizeOffset}
                                          groupToolReasoningRuns={false}
                                          truncateToolOutput={truncateToolOutput}
                                          customTheme={customTheme}
                                          customThemeEnabled={customThemeEnabled}
                                          isDarkMode={isDarkMode}
                                          onOpenToolHtmlModal={openToolHtmlModal}
                                          onOpenSubagentTranscript={openSubagentTranscript}
                                          onChatErrorAction={handlePersistedChatErrorAction}
                                          onHookRunsUpdated={handleHookRunsUpdated}
                                          onHookRunsSettled={handleHookRunsSettled}
                                        />
                                      )
                                    })()}
                                    {liveEvents.length > 0 && <ChatMessage id={`streaming-${runId}`} role='assistant' content='' streamEvents={liveEvents}
                                      width='w-full' fontSizeOffset={fontSizeOffset} groupToolReasoningRuns={false} truncateToolOutput={truncateToolOutput}
                                      customTheme={customTheme} customThemeEnabled={customThemeEnabled} isDarkMode={isDarkMode}
                                      onOpenToolHtmlModal={openToolHtmlModal} onOpenSubagentTranscript={openSubagentTranscript} />}
                                  </div>} />
                              </div>
                            </VirtualizedRowContainer>
                          )
                        }

                        const msg = row.message
                        if (isImageAttachmentInfoMessage(msg)) {
                          return (
                            <VirtualizedRowContainer key={renderRow.key} id={`message-${msg.id}`}
                              index={virtualRow.index} start={virtualRow.start} measureElement={virtualizer.measureElement} className='z-0'>
                              <ImageAttachmentNotice customTheme={customTheme}
                                customThemeEnabled={customThemeEnabled} isDarkMode={isDarkMode} />
                            </VirtualizedRowContainer>
                          )
                        }
                        if (isWatcherCompletionMessage(msg)) {
                          return (
                            <VirtualizedRowContainer key={renderRow.key} id={`message-${msg.id}`}
                              index={virtualRow.index} start={virtualRow.start} measureElement={virtualizer.measureElement} className='z-0'>
                              <WatcherCompletionNotice content={msg.content} customTheme={customTheme}
                                customThemeEnabled={customThemeEnabled} isDarkMode={isDarkMode} />
                            </VirtualizedRowContainer>
                          )
                        }
                        if (isCommittedCompaction(msg)) {
                          return (
                            <VirtualizedRowContainer
                              key={renderRow.key}
                              id={`message-${msg.id}`}
                              index={virtualRow.index}
                              start={virtualRow.start}
                              measureElement={virtualizer.measureElement}
                              className='z-0'
                            >
                              <SummarisedMessage
                                customTheme={customTheme}
                                customThemeEnabled={customThemeEnabled}
                                isDarkMode={isDarkMode}
                              />
                            </VirtualizedRowContainer>
                          )
                        }
                        const { contentBlocks } =
                          parsedMessageDataById.get(msg.id) ?? EMPTY_PARSED_MESSAGE_DATA
                        const isProcessBridgeSourceMessage = bridgedProcessMessageIds.has(String(msg.id))

                        const displayContentBlocks =
                          isProcessBridgeSourceMessage && Array.isArray(contentBlocks)
                            ? contentBlocks.filter(block => !isProcessContentBlock(block) && block.type !== 'context_injection')
                            : contentBlocks
                        const assistantContainerClassName = assistantContainerClassByMessageId.get(String(msg.id))

                        if (isFullAccessNotification(msg)) {
                          return (
                            <VirtualizedRowContainer key={renderRow.key} id={`message-${msg.id}`}
                              index={virtualRow.index} start={virtualRow.start} measureElement={virtualizer.measureElement} className='z-0'>
                              <FullAccessNotice />
                            </VirtualizedRowContainer>
                          )
                        }
                        const modeMeta = parseMessageMeta(msg.meta)
                        if (modeMeta?.kind === 'operation_mode_change' && (modeMeta.mode === 'plan' || modeMeta.mode === 'execute')) {
                          return (
                            <VirtualizedRowContainer key={renderRow.key} id={`message-${msg.id}`}
                              index={virtualRow.index} start={virtualRow.start} measureElement={virtualizer.measureElement} className='z-0'>
                              <OperationModeNotice mode={modeMeta.mode} initial={!modeMeta.previousMode} />
                            </VirtualizedRowContainer>
                          )
                        }
                        if (isContextInjectionMessage(msg)) {
                          // Auto-loaded instruction files (AGENTS.md / CLAUDE.md, rules, MEMORY.md):
                          // a persisted user row the model reads in full. People get one collapsed line.
                          const injectionMeta = parseMessageMeta((msg as any).meta)
                          const injectedFiles = Array.isArray(injectionMeta?.files)
                            ? (injectionMeta!.files as unknown[]).filter((file): file is string => typeof file === 'string')
                            : []
                          const injectionReason = typeof injectionMeta?.reason === 'string' ? injectionMeta.reason : 'session_start'
                          return (
                            <VirtualizedRowContainer
                              key={renderRow.key}
                              id={`message-${msg.id}`}
                              index={virtualRow.index}
                              start={virtualRow.start}
                              measureElement={virtualizer.measureElement}
                              className='z-0'
                            >
                              <ContextInjectionCard
                                variant='launch'
                                entries={splitInstructionSetIntoEntries(msg.content, injectedFiles, injectionReason)}
                                fontSizeOffset={fontSizeOffset}
                                customTheme={customTheme}
                                customThemeEnabled={customThemeEnabled}
                                isDarkMode={isDarkMode}
                              />
                            </VirtualizedRowContainer>
                          )
                        }

                        return (
                          <VirtualizedRowContainer
                            key={renderRow.key}
                            id={`message-${msg.id}`}
                            index={virtualRow.index}
                            start={virtualRow.start}
                            measureElement={virtualizer.measureElement}
                            className='z-0 focus-within:z-[70]'
                            zIndex={
                              activeBranchEditingMessageId != null &&
                              String(msg.id) === String(activeBranchEditingMessageId)
                                ? 80
                                : 0
                            }
                          >
                            <ChatMessage
                              id={msg.id.toString()}
                              role={msg.role}
                              content={msg.content}
                              contentBlocks={displayContentBlocks}
                              hookRuns={isProcessBridgeSourceMessage ? undefined : msg.hook_runs}
                              timestamp={msg.created_at}
                              width='w-full'
                              modelName={msg.model_name}
                              artifacts={msg.artifacts}
                              fontSizeOffset={fontSizeOffset}
                              groupToolReasoningRuns={groupToolReasoningRuns}
                              truncateToolOutput={truncateToolOutput}
                              customTheme={customTheme}
                              customThemeEnabled={customThemeEnabled}
                              isDarkMode={isDarkMode}
                              className={assistantContainerClassName}
                              userTurnElapsedLabel={userTurnElapsedLabelByMessageId.get(String(msg.id))}
                              undoState={msg.role === 'user' ? undoStateByMessageId.get(String(msg.id)) : undefined}
                              onHookRunsUpdated={handleHookRunsUpdated}
                              onHookRunsSettled={handleHookRunsSettled}
                              onUndoStreamEdits={
                                msg.role === 'user' ? undoHandlerByMessageId.get(String(msg.id)) : undefined
                              }
                              onEdit={handleMessageEdit}
                              onBranch={handleMessageBranch}
                              onDelete={handleRequestDelete}
                              onResend={handleResend}
                              onAddToNote={handleAddToNote}
                              onAddToChat={handleAddToChat}
                              onExplainFromSelection={handleExplainFromSelection}
                              branchSubmissionDisabled={selection.status === 'pending' || selection.status === 'error'}
                              onOpenToolHtmlModal={openToolHtmlModal}
                              onOpenSubagentTranscript={openSubagentTranscript}
                              onChatErrorAction={handlePersistedChatErrorAction}
                              onEditingStateChange={handleMessageEditingStateChange}
                            />
                          </VirtualizedRowContainer>
                        )
                      })}
                    </div>
                  )
                })()
              )}
            </React.Profiler>

            {/* Live streaming tail rendered OUTSIDE the virtualizer as an in-flow sibling. Once final
                text starts, the token-by-token growth happens here and never enters virtualizer
                geometry or the ResizeObserver, so it can never drag scrollTop. `flexShrink: 0` keeps
                the flex column from collapsing it (mirrors the totalSize div). Auto-follow targets
                liveStreamingContentRef via getBoundingClientRect, which is layout-agnostic. */}
            {showLiveStreamingTail && (
              <div style={{ flexShrink: 0 }} data-live-streaming-tail='true'>
                <div ref={liveStreamingContentRef}>
                  <ChatMessage
                    id='streaming'
                    role='assistant'
                    content={streamState.buffer}
                    streamEvents={visibleLiveEvents}
                    processRunActive={streamLifecycleActive}
                    firstProcessGroupExpanded={!liveAgentGroupId ? expandedProcessMessageRuns.has(transientProcessGroupKey) : undefined}
                    onFirstProcessGroupToggle={() => toggleProcessMessageRun(transientProcessGroupKey)}
                    width='w-full'
                    fontSizeOffset={fontSizeOffset}
                    groupToolReasoningRuns={groupToolReasoningRuns}
                    truncateToolOutput={truncateToolOutput}
                    customTheme={customTheme}
                    customThemeEnabled={customThemeEnabled}
                    isDarkMode={isDarkMode}
                    modelName={selectedModel?.name || undefined}
                    className=''
                    onOpenToolHtmlModal={openToolHtmlModal}
                    onOpenSubagentTranscript={openSubagentTranscript}
                    onChatErrorAction={handlePersistedChatErrorAction}
                  />
                </div>
                <div
                  aria-hidden='true'
                  data-live-streaming-clearance='true'
                  style={{ height: liveStreamingBottomClearance, flexShrink: 0 }}
                />
              </div>
            )}

            {/* Bottom sentinel: the sole trailing spacer (paddingEnd is 0). flexShrink:0 so the flex
                column cannot collapse it, otherwise there is no room to scroll the last message above
                the composer overlay and near-bottom math over-subtracts. */}
            <div
              ref={bottomRef}
              data-bottom-sentinel='true'
              style={{ height: bottomSentinelHeight, flexShrink: 0 }}
            />
          </div>
        </div>
        {/* Input area: controls row + textarea (absolutely positioned overlay) */}
        <div
          ref={inputAreaRef}
          data-chat-pane-composer='true'
          className={`absolute ${isBranchEditing ? 'z-100' : 'z-10'} bottom-0 left-0 right-0 mx-auto mb-2 px-2 sm:px-0 md:px-4 lg:px-4 2xl:px-4  ${!heimdallVisible ? 'max-w-full sm:max-w-xl md:max-w-2xl lg:max-w-3xl xl:max-w-3xl 2xl:max-w-4xl 3xl:max-w-6xl' : 'max-w-full sm:max-w-xl md:max-w-2xl lg:max-w-3xl xl:max-w-4xl 2xl:max-w-4xl'}`}
          style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
        >
          {/* Controls row (above) */}

          {showScrollToBottomButton && virtualRows.length > 0 && (
            <Button
              variant='outline2'
              size='medium'
              className='absolute -top-12 right-5 z-20 !rounded-full !p-2 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.45)] backdrop-blur-xl transition-all duration-200 hover:-translate-y-0.5 hover:bg-black/5 dark:hover:bg-white/5'
              aria-label='Scroll to latest messages'
              title='Scroll to bottom'
              onClick={() => {
                userScrolledDuringStreamRef.current = false
                if (showLiveStreamingTail) {
                  scrollLiveTailToBottomOnce('auto')
                } else {
                  scrollToBottomNow('auto')
                }
              }}
            >
              <i className='bx bx-down-arrow-alt text-lg' aria-hidden='true'></i>
            </Button>
          )}

          {/* Textarea (bottom, grows upward because wrapper is bottom-pinned) */}
          <div className='relative isolate'>
            {!isBrowserClient && selection.status === 'pending' && (
              <div role='status' className='px-3 py-1 text-xs opacity-70'>Opening conversation…</div>
            )}
            {selection.error && (
              <div role='status' className='px-3 py-1 text-xs opacity-70'>
                {selection.error}{' '}
                <button type='button' className='underline' disabled={isSnapshotFetching} onClick={() => {
                  // Retry is a new intent before any I/O. The snapshot owner reloads
                  // failed selections; accepted snapshots resolve missing targets through
                  // the controller. No superseded refresh promise can strand this retry.
                  if (selection.target) chatSelection.select(selection.target, { inPlace: true, source: 'retry' })
                }}>Retry</button>
              </div>
            )}
            {showGenerationLoadingAnimation && showStreamingThinkingInputTab && (
              <div className='absolute left-0 top-0 z-0 flex -translate-y-[calc(100%-8px)]'>
                <StreamingThinkingIndicator variant='tab' compacting={showCompactionStatus} compactionCompleted={Boolean(compactionCompleted)} />
              </div>
            )}

            <div
              aria-hidden='true'
              className={`pointer-events-none absolute left-0 top-0 z-0 h-[9px] w-28 rounded-t-sm bg-neutral-100/40 backdrop-blur-xl dark:bg-neutral-900/40 ${
                showGenerationLoadingAnimation && showStreamingThinkingInputTab ? 'block' : 'hidden'
              }`}
            />

            <div
              className={`slate-input-wrapper relative z-10 ${leftControlsBorderClasses} bg-neutral-100/40 dark:bg-neutral-900/40 backdrop-blur-xl rounded-3xl px-2 pt-3 pb-2 transition-all duration-300`}
            >
              {operationModeUpgradeRequest && (
                <ToolPermissionDialog
                  toolCall={operationModeUpgradeRequest.toolCall}
                  variant='operation-mode-upgrade'
                  onGrant={() =>
                    dispatch(respondToOperationModeUpgrade({ approved: true, streamId: operationModeUpgradeRequest.streamId }))
                  }
                  onDeny={() =>
                    dispatch(respondToOperationModeUpgrade({ approved: false, streamId: operationModeUpgradeRequest.streamId }))
                  }
                />
              )}
              {!operationModeUpgradeRequest && toolCallPermissionRequest && (
                <ToolPermissionDialog
                  toolCall={toolCallPermissionRequest.toolCall}
                  onGrant={() =>
                    dispatch(respondToToolPermission({ allowed: true, streamId: toolCallPermissionRequest.streamId }))
                  }
                  onDeny={() =>
                    dispatch(respondToToolPermission({ allowed: false, streamId: toolCallPermissionRequest.streamId }))
                  }
                  onAllowAll={() => dispatch(respondToToolPermissionAndEnableAll(toolCallPermissionRequest.streamId))}
                />
              )}
              {planClarificationRequest && (
                <PlanClarificationPanel
                  request={planClarificationRequest}
                  onSubmit={(answers: PlanClarificationAnswer[]) =>
                    dispatch(respondToPlanClarification({ answers, streamId: planClarificationRequest.streamId }))
                  }
                  onCancel={() => dispatch(cancelPlanClarification(planClarificationRequest.streamId))}
                />
              )}
              {/* Todo List / Modified Files Display */}
              {showComposerSummaryPanels && (
                <div
                  className={`mx-2 ${toolCallPermissionRequest || operationModeUpgradeRequest ? 'mt-1' : 'mt-2'} mb-1 ${
                    showComposerSummaryPanelsAsRow ? 'flex gap-2' : 'block'
                  }`}
                >
                  {hasLatestTodoList && latestTodoList && (
                    <div
                      className={`${composerSummaryPanelClassName} rounded-[16px] bg-neutral-100/80 px-2 py-1 dark:bg-neutral-800/50`}
                    >
                      <div className='flex items-center justify-between gap-3'>
                        <span className='min-w-0 flex items-center gap-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-400'>
                          <i className='bx bx-list-check shrink-0 text-base'></i>
                          <span className='truncate text-[12px]'>Todo list</span>
                          {effectiveTodoListCollapsed && (
                            <span className='ml-1 shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500'>
                              ({latestTodoList.items.filter(i => i.done).length}/{latestTodoList.items.length})
                            </span>
                          )}
                        </span>
                        <div className='flex shrink-0 items-center gap-2'>
                          <span className='text-[10px] text-neutral-400 dark:text-neutral-500'>
                            {latestTodoList.action === 'create'
                              ? 'Created'
                              : latestTodoList.action === 'edit'
                                ? 'Updated'
                                : ''}
                          </span>
                          <button
                            type='button'
                            onClick={() => toggleTodoListCollapsed()}
                            className='rounded-md px-1 py-0.5 text-neutral-500 transition-colors hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'
                            title={effectiveTodoListCollapsed ? 'Expand todo list' : 'Collapse todo list'}
                          >
                            <i
                              className={`bx ${effectiveTodoListCollapsed ? 'bx-chevron-down' : 'bx-chevron-up'} translate-y-px text-sm transition-transform duration-300 ease-in-out`}
                            ></i>
                          </button>
                        </div>
                      </div>
                      <div
                        className={`overflow-hidden transition-[max-height,opacity,margin] duration-300 ease-in-out ${
                          effectiveTodoListCollapsed ? 'mt-0 max-h-0 opacity-0' : 'mt-1.5 max-h-44 opacity-100'
                        }`}
                        aria-hidden={effectiveTodoListCollapsed}
                      >
                        <ul className='max-h-40 space-y-1 overflow-y-auto pr-1 thin-scrollbar'>
                          {latestTodoList.items.map((item, idx) => (
                            <li
                              key={`todo-item-${idx}`}
                              className={`flex min-w-0 items-center gap-2 px-1 py-1 text-xs ${
                                item.done
                                  ? 'text-neutral-500 dark:text-neutral-400'
                                  : 'text-neutral-800 dark:text-neutral-200'
                              }`}
                            >
                              <span
                                className={`shrink-0 whitespace-nowrap ${
                                  item.done ? 'text-green-600 dark:text-green-400' : 'text-neutral-400'
                                }`}
                              >
                                {item.done ? '[✓]' : '[ ]'}
                              </span>
                              <span className={`min-w-0 flex-1 truncate ${item.done ? 'line-through opacity-80' : ''}`}>
                                {item.text}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )}
                  {hasBranchFileMutations && (
                    <div
                      className={`${composerSummaryPanelClassName} rounded-[16px] bg-neutral-100/80 px-2 py-1 dark:bg-neutral-800/50`}
                    >
                      <div className='flex items-center justify-between gap-3'>
                        <span className='min-w-0 flex items-center gap-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-400'>
                          <i className='bx bx-file shrink-0 text-base'></i>
                          <span className='truncate text-[12px]'>Modified Files</span>
                          <span className='translate-y-px shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500'>
                            {branchFileMutationData.latestByPath.length} file
                            {branchFileMutationData.latestByPath.length === 1 ? '' : 's'}
                          </span>
                        </span>
                        <div className='flex shrink-0 items-center gap-2'>
                          <button
                            type='button'
                            onClick={handleOpenWorkspaceMutationDiffs}
                            className='text-[10px] font-medium text-neutral-500 transition-colors hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'
                            title='Open modified files in Git diff'
                          >
                            Diffs
                          </button>
                          <button
                            onClick={() => toggleWorkspaceMutationsCollapsed()}
                            className='rounded-md px-1 py-0.5 text-neutral-500 transition-colors hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'
                            title={
                              effectiveWorkspaceMutationsCollapsed ? 'Expand modified files' : 'Collapse modified files'
                            }
                          >
                            <i
                              className={`bx ${effectiveWorkspaceMutationsCollapsed ? 'bx-chevron-down' : 'bx-chevron-up'} translate-y-px text-sm transition-transform duration-300 ease-in-out`}
                            ></i>
                          </button>
                        </div>
                      </div>
                      <div
                        className={`overflow-hidden transition-[max-height,opacity,margin] duration-300 ease-in-out ${
                          effectiveWorkspaceMutationsCollapsed
                            ? 'mt-0 max-h-0 opacity-0'
                            : 'mt-1.5 max-h-44 opacity-100'
                        }`}
                        aria-hidden={effectiveWorkspaceMutationsCollapsed}
                      >
                        <ul className='max-h-40 space-y-1 overflow-y-auto pr-1 thin-scrollbar'>
                          {branchFileMutationData.latestByPath.map(summary => {
                            const latestMutation = summary.latestMutation
                            const fileName = getWorkspaceFileBaseName(summary.path)
                            return (
                              <li key={`workspace-summary-${summary.path}`} className='px-1 py-1'>
                                <div className='flex items-center gap-2'>
                                  <span
                                    className={`inline-flex h-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[9px] font-semibold leading-none ${getWorkspaceMutationBadgeClassName(latestMutation.operation)}`}
                                  >
                                    {getWorkspaceMutationLabel(latestMutation.operation)}
                                  </span>
                                  <div className='min-w-0 flex-1'>
                                    <div className='flex items-center justify-between gap-2'>
                                      <div className='min-w-0 flex items-center gap-1.5'>
                                        <span className='truncate text-[12px] font-medium text-neutral-800 dark:text-neutral-100'>
                                          {fileName}
                                        </span>
                                        {summary.mutationCount > 1 && (
                                          <span className='shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500'>
                                            ×{summary.mutationCount}
                                          </span>
                                        )}
                                      </div>
                                      <button
                                        type='button'
                                        onClick={() => handleOpenWorkspaceMutationDiffForPath(summary.path)}
                                        className='shrink-0 text-[12px] font-medium text-neutral-500 transition-colors hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'
                                        title={`Open diff for ${fileName}`}
                                      >
                                        Diff
                                      </button>
                                    </div>
                                    <div className='mt-0.5 truncate text-[10px] text-neutral-500 dark:text-neutral-400'>
                                      {summary.path}
                                    </div>
                                  </div>
                                </div>
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {showOpenAIUsagePanel && (
                <div className='mx-2 mt-2 mb-1 rounded-[24px] bg-neutral-100/75 px-3 py-3 backdrop-blur-xl dark:bg-neutral-900/55'>
                  <div className='flex items-start justify-between gap-3'>
                    <div className='min-w-0'>
                      <div className='text-xs font-semibold text-neutral-900 dark:text-neutral-100'>Codex usage</div>
                      <div className='mt-0.5 text-[10px] text-neutral-500 dark:text-neutral-400'>
                        {openAIUsageData?.planType ? `${openAIUsageData.planType} plan` : 'ChatGPT account limits'}
                      </div>
                    </div>
                    <button
                      type='button'
                      className='inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/65 text-neutral-500 transition-all duration-200 hover:scale-105 hover:bg-white hover:text-neutral-900 active:scale-95 dark:bg-white/10 dark:text-neutral-400 dark:hover:bg-white/15 dark:hover:text-neutral-100'
                      aria-label='Close OpenAI usage panel'
                      onClick={() => setShowOpenAIUsagePanel(false)}
                    >
                      ×
                    </button>
                  </div>

                  {openAIUsageLoading ? (
                    <div className='mt-3 space-y-2'>
                      {[0, 1].map(index => (
                        <div key={`usage-loading-${index}`} className='rounded-2xl bg-white/45 px-3 py-2.5 dark:bg-black/20'>
                          <div className='h-3 w-24 animate-pulse rounded-full bg-neutral-300/70 dark:bg-neutral-700/70' />
                          <div className='mt-3 grid grid-cols-[repeat(14,minmax(0,1fr))] gap-1'>
                            {Array.from({ length: 14 }).map((_, segmentIndex) => (
                              <div
                                key={`usage-loading-${index}-${segmentIndex}`}
                                className='h-2 animate-pulse rounded-full bg-neutral-300/45 dark:bg-white/10'
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : openAIUsageError ? (
                    <div className='mt-3 rounded-2xl bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300'>
                      {openAIUsageError}
                    </div>
                  ) : openAIUsageData ? (
                    <div className='mt-3 space-y-2'>
                      <OpenAIUsageMeter
                        label='Session'
                        usedPercent={openAIUsageData.session.usedPercent}
                        resetAtIso={openAIUsageData.session.resetAtIso}
                        note='Primary Codex window'
                      />
                      <OpenAIUsageMeter
                        label='Weekly'
                        usedPercent={openAIUsageData.weekly.usedPercent}
                        resetAtIso={openAIUsageData.weekly.resetAtIso}
                        note='Secondary limit window'
                      />
                      {openAIUsageData.reviews.usedPercent != null && (
                        <OpenAIUsageMeter
                          label='Reviews'
                          usedPercent={openAIUsageData.reviews.usedPercent}
                          resetAtIso={openAIUsageData.reviews.resetAtIso}
                          note='Code review allowance'
                        />
                      )}
                      {openAIUsageData.credits && openAIUsageData.credits.balance != null && (
                        <div className='flex items-center justify-between gap-3 rounded-2xl bg-white/45 px-3 py-2 text-xs text-neutral-700 dark:bg-black/20 dark:text-neutral-200'>
                          <span className='text-neutral-500 dark:text-neutral-400'>Credits</span>
                          <span className='font-semibold tabular-nums'>{openAIUsageData.credits.balance.toFixed(2)}</span>
                        </div>
                      )}
                      <div className='text-[10px] text-neutral-500 dark:text-neutral-500'>
                        Updated {new Date(openAIUsageData.fetchedAtIso).toLocaleTimeString()}
                      </div>
                    </div>
                  ) : (
                    <div className='mt-3 rounded-2xl bg-white/45 px-3 py-2 text-xs text-neutral-600 dark:bg-black/20 dark:text-neutral-300'>
                      No usage data available.
                    </div>
                  )}
                </div>
              )}

              {(benchEnabled || benchStatusMessage) && (
                <div className='mx-2 mt-2 mb-1 rounded-[16px] border border-violet-300/80 dark:border-violet-600/50 bg-violet-100/70 dark:bg-violet-900/30 px-3 py-2'>
                  <div className='flex items-center justify-between gap-2'>
                    <div className='text-xs font-semibold text-violet-700 dark:text-violet-300'>
                      Benchmark {benchEnabled ? 'ON' : 'OFF'}
                    </div>
                    {benchEnabled && (
                      <div className='text-[10px] text-violet-700/80 dark:text-violet-300/80'>
                        commits {benchCommitDurationsRef.current.length} • derives{' '}
                        {benchDeriveDurationsRef.current.length}
                      </div>
                    )}
                  </div>
                  {benchStatusMessage && (
                    <div className='mt-1 text-[11px] text-violet-700 dark:text-violet-200'>{benchStatusMessage}</div>
                  )}
                </div>
              )}

              {queuedMessages && queuedMessages.conversationId === currentConversationId &&
                (streamState.active || (modeLineageId != null && queuedMessages.lineageId === modeLineageId) ||
                  (queueBranchAnchor != null && selectedPath.includes(queueBranchAnchor))) && (
                <QueuedMessages items={queuedMessages.items}
                  onRestore={restoreFailedSendText}
                  onCancel={requestId => dispatch(cancelQueuedMessage({ conversationId: currentConversationId!,
                    streamId: queuedMessages.streamId, requestId })).unwrap()} />
              )}
              {/* Textarea with shortcut hint */}
              <div className=''>
                <ChatInputController
                  ref={inputControllerRef}
                  conversationId={currentConversationId}
                  initialValue={messageInput.content}
                  onHasTextChange={setHasLocalInput}
                  onSubmit={handleComposerSubmit}
                  onBlurPersist={handleComposerBlurPersist}
                  slashCommands={composerSlashCommands}
                  onSlashCommandSelect={handleComposerSlashCommandSelect}
                  onAddCurrentIdeContext={addCurrentIdeContextToMessage}
                  onClearIdeContexts={clearIdeContexts}
                  selectedIdeContextItems={addedIdeContextItems}
                  fallbackFileSearchRoot={ccCwd}
                  filterSelectedMentionFiles={showAddedFilesPills}
                  imageDraftTarget={{ kind: 'composer' }}
                  fontSizeOffset={fontSizeOffset}
                />
              </div>
              {/* Selected file chips moved from InputTextArea */}
              {showAddedFilesPills && selectedFilesForChat && selectedFilesForChat.length > 0 && (
                <div className='m-2 flex flex-wrap gap-2'>
                  {selectedFilesForChat.map(file => {
                    const displayName =
                      file.name || file.relativePath.split('/').pop() || file.path.split('/').pop() || file.relativePath
                    const directoryLabel =
                      file.relativeDirectoryPath ||
                      (file.relativePath.includes('/') ? file.relativePath.split('/').slice(0, -1).join('/') : '')
                    const isExpanded = expandedFilePath === file.path
                    const isClosing = closingFilePath === file.path
                    const isOpening = openingFilePath === file.path
                    return (
                      <div
                        key={file.path}
                        className='relative group inline-flex max-w-full items-center gap-2 rounded-full bg-neutral-100/70 px-2.5 py-1 text-neutral-800 transition-all duration-150 hover:border-neutral-400 hover:bg-neutral-200/70 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-100 dark:hover:border-neutral-500 dark:hover:bg-neutral-800/80'
                        title={file.relativePath || file.path}
                        onClick={e => {
                          if (!isExpanded) {
                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                            setExpandedAnchor({ left: rect.left, top: rect.top })
                            setOpeningFilePath(file.path)
                            setExpandedFilePath(file.path)
                            // Clear opening state after transition completes
                            window.setTimeout(() => setOpeningFilePath(null), 130)
                          }
                        }}
                      >
                        <span className='inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-500/15 text-[11px] text-blue-700 dark:bg-blue-400/15 dark:text-blue-300'>
                          📄
                        </span>
                        <span className='flex min-w-0 flex-col max-w-[110px] sm:max-w-[170px] md:max-w-[250px]'>
                          <span className='truncate text-[12px] font-medium leading-tight'>{displayName}</span>
                          {directoryLabel ? (
                            <span className='truncate font-mono text-[10px] leading-tight text-neutral-600/90 dark:text-neutral-400/90'>
                              {directoryLabel}
                            </span>
                          ) : null}
                        </span>
                        <button
                          type='button'
                          className='inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] text-neutral-500 transition-colors hover:bg-neutral-300/80 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-100'
                          aria-label={`Remove ${displayName}`}
                          onClick={e => {
                            e.stopPropagation()
                            handleRemoveFileSelection(file)
                          }}
                        >
                          ✕
                        </button>

                        {/* Hover tooltip that can expand into anchored modal */}
                        <div
                          className={`absolute bottom-full left-0 mb-2 origin-bottom-left rounded-lg shadow-sm p-3 transform transition-all duration-100 ease-out ${
                            isExpanded
                              ? 'hidden'
                              : 'z-50 dark:bg-neutral-900 bg-neutral-100 opacity-0 invisible scale-95 pointer-events-none w-64 sm:w-72 md:w-80 group-hover:opacity-100 group-hover:visible group-hover:scale-100'
                          }`}
                        >
                          <div className='text-xs text-blue-600 dark:text-blue-300 font-medium mb-1 truncate'>
                            {file.name || file.relativePath.split('/').pop() || file.path.split('/').pop()}
                          </div>
                          {directoryLabel ? (
                            <div className='text-[10px] text-neutral-600 dark:text-neutral-400 mb-2 truncate'>
                              {directoryLabel}
                            </div>
                          ) : null}
                          <div
                            className={`text-xs font-mono whitespace-pre-wrap break-words text-stone-800 dark:text-stone-300 ${isExpanded ? 'overflow-auto max-h-[60vh]' : isClosing ? 'overflow-hidden' : 'overflow-hidden line-clamp-6'} ${isOpening || isClosing ? 'opacity-50 ' : 'opacity-100 visible'} transition-opacity duration-50 overscroll-contain select-text`}
                          >
                            {file.contents}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

            </div>

            {/* Controls row */}
            <div className='composer-controls-row relative z-10 mt-2 flex items-center justify-between gap-3'>
                {/* Left side controls */}
                <div
                  className={`composer-controls-left relative z-20 flex h-10 xl:h-12 min-w-0 flex-[0_1_58%] max-w-[58%] items-center gap-1 overflow-visible rounded-full ${leftControlsBorderClasses} bg-neutral-100/40 px-2.5 py-1 md:py-1 xl:py-1.5 backdrop-blur-xl transition-all duration-300 dark:bg-neutral-900/40`}
                  style={leftControlsTokenTintStyle}
                >
                  <button
                    className='relative z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white/80 text-stone-700 backdrop-blur-xl transition-all duration-200 hover:-translate-y-0.5 hover:scale-105 hover:bg-white hover:text-stone-950 active:translate-y-0 active:scale-95 dark:bg-yBlack-900/80 dark:text-stone-200 dark:hover:bg-neutral-900 dark:hover:text-white'
                    style={actionPopoverTriggerStyle}
                    onClick={() => {
                      setSpinSettings(true)
                      setSettingsOpen(true)
                    }}
                    title='Chat Settings'
                  >
                    <Settings
                      className={`h-5 w-5 ${spinSettings ? 'animate-[spin_0.6s_linear_1]' : ''}`}
                      strokeWidth={2.25}
                      aria-hidden='true'
                      onAnimationEnd={() => setSpinSettings(false)}
                    />
                  </button>
                  <div className='composer-controls-left-selectors relative z-10 flex min-w-0 shrink items-center gap-1 flex-nowrap overflow-hidden'>
                    {isHostClient && extensions.length > 0 && (
                      <Select
                        value={selectedExtensionId || ''}
                        onChange={handleExtensionSelection}
                        blur='low'
                        options={
                          extensions.length > 0
                            ? extensions.map(ext => ({
                                value: ext.id,
                                label: ext.workspaceName || `Extension ${ext.id.slice(0, 6)}`,
                              }))
                            : [{ value: '', label: 'No extensions connected' }]
                        }
                        placeholder='Select extension'
                        disabled={extensions.length === 0}
                        className='ml-2 w-[94px] min-w-[42px] max-w-[180px] shrink transition-[width,transform] duration-150 hover:w-[180px] focus-within:w-[180px] data-[open=true]:w-[180px] active:scale-97 [&>button]:!rounded-full [&_.bx-chevron-down]:!text-[14px] 2xl:[&_.bx-chevron-down]:!text-[15px] 3xl:[&_.bx-chevron-down]:!text-xl 4xl:[&_.bx-chevron-down]:!text-2xl'
                        searchBarVisible={true}
                        size='large'
                        dropdownMinWidth={220}
                      />
                    )}

                    {/* Provider selector - visibility controlled by user settings */}
                    {isHostClient && providerSettings.showProviderSelector && (
                      <Select
                        value={providers.currentProvider || ''}
                        onChange={handleProviderSelect}
                        options={providers.providers.map(p => p.name)}
                        placeholder='Select a provider...'
                        disabled={providers.providers.length === 0}
                        className='w-[94px] min-w-[42px] max-w-[180px] shrink transition-[width,transform] duration-150 hover:w-[180px] focus-within:w-[180px] data-[open=true]:w-[180px] active:scale-97 [&>button]:!rounded-full [&_.bx-chevron-down]:!text-[14px] 2xl:[&_.bx-chevron-down]:!text-[15px] 3xl:[&_.bx-chevron-down]:!text-xl 4xl:[&_.bx-chevron-down]:!text-2xl'
                        searchBarVisible={true}
                        size='large'
                        dropdownMinWidth={220}
                      />
                    )}
                    <ModelSelectControl
                      provider={providers.currentProvider}
                      selectedModelName={selectedModel?.name || ''}
                      onChange={handleModelSelect}
                      placeholder='Select a model...'
                      blur='low'
                      className='w-[120px] min-w-[42px] max-w-[170px] shrink transition-[width,transform] duration-150 hover:w-[170px] focus-within:w-[170px] data-[open=true]:w-[170px] active:scale-99 [&>button]:!rounded-full'
                      showFilters={true}
                      footerContent={modelSelectFooter}
                    />
                  </div>
                  {/*
                    Hover target for the context usage popover, and the reason this row carries a
                    fourth slot. It sits AFTER the selectors rather than behind them: this element
                    takes pointer events, and the earlier version sat underneath the controls,
                    which left only the thin strips between them as a usable target. Keeping it a
                    sibling of the popover below is what lets `peer-hover` reach it.

                    It claims whatever width the pill has spare, and holds a 44px floor when the
                    window is narrow, so the target never collapses to nothing.
                  */}
                  <div className='peer min-w-[44px] flex-1 basis-0 self-stretch' aria-hidden='true' />
                  {showTokenUsageBar && showTokenUsageHoverDetails && (
                    <div className='pointer-events-none absolute bottom-full left-1/2 z-[60] mb-2 w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 translate-y-1 opacity-0 invisible transition-all duration-200 peer-hover:translate-y-0 peer-hover:opacity-100 peer-hover:visible'>
                      <div
                        className='isolate rounded-2xl bg-white px-3 py-2.5 text-black whitespace-nowrap backdrop-blur-2xl dark:bg-neutral-900 dark:text-white'
                        style={contextUsagePopoverStyle}
                      >
                        <div className='flex items-center gap-2 text-xs'>
                          <span className='text-blue-700 dark:text-blue-400'>Context:</span>
                          <span>
                            {tokenUsage.totalContextTokens.toLocaleString()} /{' '}
                            {tokenLimits.totalBudget.toLocaleString()}
                          </span>
                        </div>
                        {isOpenAIContextProvider && tokenUsage.openAIUsageHistory.length > 0 && (
                          <ContextUsageSparkline
                            points={tokenUsage.openAIUsageHistory}
                            totalColor={tokenUsageProgressColor}
                            isDarkMode={isDarkMode}
                          />
                        )}
                        {!isOpenAIContextProvider && (
                          <>
                            <div className='mt-1 flex items-center gap-2 text-xs'>
                              <span className='text-neutral-700 dark:text-neutral-300'>Messages:</span>
                              <span>{tokenUsage.messageTokens.toLocaleString()}</span>
                            </div>
                            <div className='mt-1 flex items-center gap-2 text-xs'>
                              <span className='text-neutral-700 dark:text-neutral-300'>Prompts + Context:</span>
                              <span>{tokenUsage.promptAndContextTokens.toLocaleString()}</span>
                            </div>
                            <div className='mt-1 flex items-center gap-2 text-xs'>
                              <span className='text-neutral-700 dark:text-neutral-300'>Model window:</span>
                              <span>{tokenLimits.totalContextLimit.toLocaleString()}</span>
                            </div>
                            <div className='mt-1 flex items-center gap-2 text-xs'>
                              <span className='text-neutral-900 dark:text-neutral-200'>Credits:</span>
                              <span>{(current_credits * 100).toFixed(3)}</span>
                            </div>
                          </>
                        )}
                        {/* Tooltip Arrow */}
                        <div
                          className='absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1 rotate-45 bg-white dark:bg-neutral-900'
                          style={contextUsagePopoverArrowStyle}
                        />
                      </div>
                    </div>
                  )}
                </div>
                {/* Right side controls */}
                <div
                  className={`fm-controls flex h-10 xl:h-12 shrink-0 items-center gap-1 rounded-full ${leftControlsBorderClasses} bg-neutral-100/40 px-2 py-1 md:py-1 xl:py-1.5 backdrop-blur-xl transition-all duration-300 dark:bg-neutral-900/40`}
                  style={rightControlsTintStyle}
                >
                  {showFastModeAnimation && (
                    <FastModeAnimationBackground
                      animation={fastModeAnimation}
                      dark={isDarkMode}
                      operationMode={operationMode}
                      agentTint={rightControlsTintColor}
                      theme={customThemeEnabled ? customTheme : undefined}
                    />
                  )}
                  {(isImageGenerationModel ||
                    think ||
                    (isHostClient && conversationIdFromUrl)) && (
                    <ActionPopover
                      isActive={
                        toolAutoApprove ||
                        operationMode === 'plan' ||
                        !!imageConfig.aspectRatio ||
                        !!imageConfig.imageSize ||
                        (isOpenAIChatGPTProvider && fastServiceTierEnabled) ||
                        (think && reasoningConfig.effort !== 'medium')
                      }
                      footer={
                        <div className='action-cloud-fields'>
                          {isHostClient && conversationIdFromUrl && (
                            <div className='action-cloud-directory'>
                              <label htmlFor='action-cloud-cwd'>Working directory</label>
                              <div className='action-cloud-path' style={actionPopoverInputBorderColor ? { outline: `1px solid ${actionPopoverInputBorderColor}` } : undefined}>
                                <input
                                  id='action-cloud-cwd'
                                  type='text'
                                  value={ccCwd}
                                  onChange={e => setCcCwdFromUser(e.target.value)}
                                  placeholder='Working directory (optional)'
                                  title='Specify the working directory used by local agent backends'
                                />
                                <button
                                  type='button'
                                  onClick={handleSelectProjectFolder}
                                  className='action-cloud-folder'
                                  aria-label='Choose working directory'
                                  title='Select Folder to let the AI work in'
                                >
                                  <svg
                                    xmlns='http://www.w3.org/2000/svg'
                                    className='h-4 w-4'
                                    fill='none'
                                    viewBox='0 0 24 24'
                                    stroke='currentColor'
                                  >
                                    <path
                                      strokeLinecap='round'
                                      strokeLinejoin='round'
                                      strokeWidth={2}
                                      d='M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z'
                                    />
                                  </svg>
                                </button>
                              </div>
                            </div>
                          )}

                          {/* Image Generation Options - shown only for image generation models */}
                          {isImageGenerationModel && (
                            <ActionPopoverDisclosure>
                              <div className='action-cloud-image-fields'>
                                <div className='flex flex-col gap-1'>
                                  <label className='text-xs text-neutral-500 dark:text-neutral-400'>Aspect Ratio</label>
                                  <Select
                                    value={imageConfig.aspectRatio || 'default'}
                                    options={[
                                      { value: 'default', label: 'Default' },
                                      { value: '1:1', label: '1:1 (Square)' },
                                      { value: '16:9', label: '16:9 (Landscape)' },
                                      { value: '9:16', label: '9:16 (Portrait)' },
                                      { value: '4:3', label: '4:3' },
                                      { value: '3:4', label: '3:4' },
                                      { value: '3:2', label: '3:2' },
                                      { value: '2:3', label: '2:3' },
                                      { value: '4:5', label: '4:5' },
                                      { value: '5:4', label: '5:4' },
                                      { value: '21:9', label: '21:9 (Ultrawide)' },
                                    ]}
                                    onChange={value =>
                                      setImageConfig(prev => ({
                                        ...prev,
                                        aspectRatio: value === 'default' ? undefined : value as ImageConfig['aspectRatio'],
                                      }))
                                    }
                                    placeholder='Select aspect ratio'
                                    size='small'
                                    className='action-cloud-select'
                                    dropdownZIndex={ACTION_POPOVER_SELECT_DROPDOWN_Z_INDEX}
                                  />
                                </div>
                                <div className='flex flex-col gap-1'>
                                  <label className='text-xs text-neutral-500 dark:text-neutral-400'>Image Size</label>
                                  <Select
                                    value={imageConfig.imageSize || 'default'}
                                    options={[
                                      { value: 'default', label: 'Default' },
                                      { value: '1K', label: '1K' },
                                      { value: '2K', label: '2K' },
                                      { value: '4K', label: '4K' },
                                    ]}
                                    onChange={value =>
                                      setImageConfig(prev => ({
                                        ...prev,
                                        imageSize: value === 'default' ? undefined : value as ImageConfig['imageSize'],
                                      }))
                                    }
                                    placeholder='Select image size'
                                    size='small'
                                    className='action-cloud-select'
                                    dropdownZIndex={ACTION_POPOVER_SELECT_DROPDOWN_Z_INDEX}
                                  />
                                </div>
                              </div>
                            </ActionPopoverDisclosure>
                          )}
                          {selectedModel?.thinking && (
                            <div className='action-cloud-row action-cloud-row-fast'>
                              <div className='flex min-w-0 flex-col'>
                                <span>Fast mode</span>
                                <span className='action-cloud-hint'>
                                  {isOpenAIChatGPTProvider ? 'Use OpenAI priority service tier' : 'Only sent for OpenAI ChatGPT provider'}
                                </span>
                              </div>
                              <ActionPopoverSwitch
                                label='Fast mode'
                                checked={isOpenAIChatGPTProvider && fastServiceTierEnabled}
                                disabled={!isOpenAIChatGPTProvider}
                                onClick={handleToggleFastServiceTier}
                                title={!isOpenAIChatGPTProvider ? 'Fast service tier is only sent for OpenAI ChatGPT, not OpenRouter' : fastServiceTierEnabled ? 'Fast OpenAI service tier enabled' : 'Use standard OpenAI service tier'}
                              />
                            </div>
                          )}
                          <div className='action-cloud-row'>
                            <span>Orchestrator</span>
                            <ActionPopoverSwitch
                              label='Orchestrator'
                              checked={orchestratorEnabled}
                              onClick={async () => {
                                try { setOrchestratorEnabledState(await toggleOrchestratorEnabled()) }
                                catch (error) { window.alert(error instanceof Error ? error.message : 'Could not save subagent setting') }
                              }}
                              title={orchestratorEnabled ? 'Subagent can use tools (click to disable)' : 'Subagent cannot use tools (click to enable)'}
                            />
                          </div>
                          <div className='flex flex-col gap-1'>
                            <div className='action-cloud-row'>
                              <span>Full access</span>
                              <ActionPopoverSwitch
                                label='Full access'
                                checked={fullAccessEnabled}
                                onClick={() => setFullAccessEnabled(!fullAccessEnabled, currentConversationId)}
                                title='Allow tools outside the working directory on new runs'
                              />
                            </div>
                            {fullAccessEnabled && (
                              <p role='status' className='w-0 min-w-full text-[11px] text-amber-600 dark:text-amber-400'>
                                Warning: access outside workspace.
                                <br />
                                New runs only; approvals still apply.
                              </p>
                            )}
                          </div>
                        </div>
                      }
                    >
                      {isHostClient && conversationIdFromUrl && (
                        <>
                          <ActionPopoverButton
                            label={jobsModalOpen ? 'Viewing' : 'Jobs'}
                            icon={<ClipboardCheck size={16} />}
                            active={jobsModalOpen}
                            aria-haspopup='dialog'
                            aria-expanded={jobsModalOpen}
                            onClick={() => setJobsModalOpen(true)}
                            title={isHostClient ? 'View tool jobs' : 'Connect to the Graviton host to view tool jobs'}
                            disabled={!isHostClient}
                          />
                          <ActionPopoverButton
                            label={toolAutoApprove ? 'Allow all' : 'Ask'}
                            icon={<ShieldHalf size={16} />}
                            active={toolAutoApprove}
                            aria-pressed={toolAutoApprove}
                            onClick={() => dispatch(chatSliceActions.toolAutoApproveToggled())}
                            title={toolAutoApprove ? 'Auto-approving tools (click to disable)' : 'Asking for permission (click to auto-approve)'}
                            aria-label={toolAutoApprove ? 'Disable auto-approve' : 'Enable auto-approve'}
                          />
                          <ActionPopoverButton
                            label={modeChange && !isBranchEditing ? 'Switching…' : operationMode === 'plan' ? 'Chat' : 'Agent'}
                            icon={operationMode === 'plan' ? <MessageSquare size={16} /> : <CodeXml size={16} />}
                            active={operationMode !== 'plan'}
                            aria-pressed={operationMode !== 'plan'}
                            aria-busy={Boolean(modeChange) && !isBranchEditing}
                            onClick={handleToggleOperationMode}
                            disabled={Boolean(modeChange) && !isBranchEditing}
                            title={operationMode === 'plan' ? 'Plan mode enabled (tools will be blocked)' : 'Execution mode enabled (tools may modify files)'}
                            aria-label={operationMode === 'plan' ? 'Switch to execution mode' : 'Switch to plan mode'}
                          />
                        </>
                      )}
                    </ActionPopover>
                  )}
                  <ReasoningLevelControl
                    supported={Boolean(selectedModel?.thinking)}
                    level={think ? reasoningConfig.effort : 'off'}
                    onLevelChange={level => {
                      if (level === 'off') {
                        setThink(false)
                        return
                      }
                      setThink(true)
                      setReasoningConfig(prev => ({ ...prev, effort: level }))
                    }}
                  />
                  {/* Attachment upload button */}
                  <input
                    ref={attachmentInputRef}
                    type='file'
                    accept='application/pdf,image/*'
                    multiple
                    onChange={handleAttachmentInputChange}
                    className='hidden'
                    aria-hidden='true'
                  />
                  <button
                    className='p-2 rounded-full text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 hover:bg-white/10 dark:hover:bg-white/5 transition-all duration-200'
                    onClick={() => attachmentInputRef.current?.click()}
                    title='Attach files'
                  >
                    <svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2'>
                      <path d='m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.51a2 2 0 0 1-2.83-2.83l8.49-8.48' />
                    </svg>
                  </button>
                  {streamState.active && hasLocalInput && (
                    <button type='button' onClick={() => handleSend(1)} disabled={!canQueueLocal}
                      title='Queue message' aria-label='Queue message'
                      className='rounded-full px-3 py-2 text-xs bg-black/5 dark:bg-white/10 disabled:opacity-40 focus-visible:outline focus-visible:outline-2'
                      style={customThemeEnabled ? composerToggleActiveStyle : undefined}>
                      {queueSubmitting ? 'Queueing…' : 'Queue'}
                    </button>
                  )}
                  {!currentConversationId ? (
                    <span className='text-xs text-neutral-400 dark:text-neutral-500 px-2'>Creating...</span>
                  ) : showGenerationLoadingAnimation ? (
                    <button
                      onClick={handleStopGeneration}
                      disabled={selection.status === 'pending' || (!streamState.active && !canStopCompaction)}
                      title={
                        canStopCompaction
                          ? 'Stop compaction'
                          : streamState.active
                            ? 'Stop generation'
                            : 'Generating...'
                      }
                      className='cursor-pointer hover:scale-105 active:scale-95 transition-transform'
                    >
                      <SendButtonLoadingAnimation
                        animationType={sendButtonAnimation}
                        bgColor={
                          sendButtonAnimationThemeColor || (isDarkMode ? sendButtonDarkColor : sendButtonLightColor)
                        }
                      />
                    </button>
                  ) : (
                    <button
                      className={`ml-1 w-9 h-9 flex items-center justify-center rounded-full transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${
                        canSendLocal && currentConversationId
                          ? 'bg-white dark:bg-neutral-200 text-black hover:bg-blue-500 hover:text-white hover:scale-105 active:scale-95 cursor-pointer'
                          : 'bg-neutral-300 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400 cursor-not-allowed'
                      }`}
                      disabled={!canSendLocal || !currentConversationId}
                      title='Send message'
                      onClick={() => {
                        handleSend(multiReplyCount)
                      }}
                    >
                      <svg
                        className='w-[24px] h-[24px] -rotate-45 relative'
                        fill='none'
                        viewBox='0 0 24 24'
                        stroke='currentColor'
                        strokeWidth={3}
                      >
                        <path d='m5 12 14 0' />
                        <path d='m12 5 7 7-7 7' />
                      </svg>
                    </button>
                  )}
                </div>
                {/* <Button
                  variant={canSendLocal && currentConversationId ? 'primary' : 'secondary'}
                  disabled={!canSendLocal || !currentConversationId}
                  onClick={() => handleSend(multiReplyCount)}
                >
                  {!currentConversationId
                    ? 'Creating...'
                    : sendingState.streaming
                      ? 'Streaming...'
                      : sendingState.sending
                        ? 'Sending...'
                        : 'Send'}
                </Button> */}
              </div>
            </div>
          </div>
        </div>

      {parallelPane && !isMobile && (
        <div
          className='group relative z-20 mb-2 flex w-3 shrink-0 cursor-col-resize select-none items-stretch justify-center'
          role='separator'
          aria-label='Resize original and parallel chat panes'
          aria-orientation='vertical'
          aria-valuemin={20}
          aria-valuemax={80}
          aria-valuenow={Math.round(parallelSplitPct)}
          tabIndex={0}
          onDoubleClick={() => {
            setParallelSplitPct(50)
            try {
              window.localStorage.setItem('chat:parallelSplitPct', '50')
            } catch {}
          }}
          onKeyDown={event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            const direction = event.key === 'ArrowLeft' ? -1 : 1
            setParallelSplitPct(previous => {
              const next = Math.max(20, Math.min(80, previous + direction * 2))
              try {
                window.localStorage.setItem('chat:parallelSplitPct', next.toFixed(2))
              } catch {}
              return next
            })
          }}
          onMouseDown={() => setIsParallelResizing(true)}
          onTouchStart={event => {
            event.preventDefault()
            setIsParallelResizing(true)
          }}
          title='Drag to resize chat panes · Double-click to reset'
        >
          <div
            className={`my-3 w-px rounded-full transition-[width,background-color] duration-150 ${
              isParallelResizing
                ? 'w-0.5 bg-blue-500 dark:bg-orange-400'
                : 'bg-neutral-300 group-hover:w-0.5 group-hover:bg-blue-400 dark:bg-neutral-700 dark:group-hover:bg-orange-400'
            }`}
          />
        </div>
      )}

      {parallelPane && !isMobile && (
        <ParallelChatPane
          target={parallelPane}
          active={activeChatPane === 'parallel'}
          width={`calc(${((heimdallVisible ? leftWidthPct : 100) * (100 - parallelSplitPct)) / 100}% - 6px)`}
          title={currentConversation?.title ? `${currentConversation.title} · Parallel` : 'Parallel branch'}
          fontSizeOffset={fontSizeOffset}
          groupToolReasoningRuns={groupToolReasoningRuns}
          truncateToolOutput={truncateToolOutput}
          onOpenToolHtmlModal={openToolHtmlModal}
          onOpenSubagentTranscript={openSubagentTranscript}
          onOpenSettings={() => setSettingsOpen(true)}
          onChatErrorAction={handleChatErrorAction}
          onEditMessage={handleMessageEdit}
          onDeleteMessage={handleRequestDelete}
          onAddToNote={handleAddToNote}
          onActivate={() => setActiveChatPane('parallel')}
          onClose={() => {
            setParallelPane(null)
            setActiveChatPane('primary')
          }}
        />
      )}

      {heimdallVisible && !isMobile && (
        <div
          className='w-2 z-10 dark:bg-transparent bg-transparent hover:dark:bg-neutral-800 hover:bg-neutral-200 cursor-col-resize select-none'
          style={{ border: 'none', outline: 'none', margin: 0, padding: 0 }}
          role='separator'
          aria-orientation='vertical'
          onMouseDown={() => setIsResizing(true)}
          onTouchStart={e => {
            e.preventDefault()
            setIsResizing(true)
          }}
          title='Drag to resize'
        />
      )}

      {(isResizing || isParallelResizing) && !isMobile && (
        <div
          className='fixed inset-0 z-[2000] cursor-col-resize select-none bg-transparent'
          aria-hidden='true'
          onMouseUp={() => {
            setIsResizing(false)
            setIsParallelResizing(false)
          }}
          onTouchEnd={() => {
            setIsResizing(false)
            setIsParallelResizing(false)
          }}
        />
      )}

      {pendingModelSwitch && (
        <ModelSwitchDialog from={pendingModelSwitch.from} to={pendingModelSwitch.to}
          onCancel={cancelModelSwitch} onConfirm={confirmModelSwitch} />
      )}

      {/* Desktop: side-by-side layout */}
      {heimdallVisible && !isMobile && (
        <div className='flex-1 min-w-0 mb-2'>
          <Heimdall
            key={currentConversationId ?? 'none'}
            keyboardFocusRequest={treeFocusRequest}
            onKeyboardFocusHandled={() => setTreeFocusRequest(0)}
            chatData={heimdallData}
            loading={loading}
            error={error}
            compactMode={compactMode}
            conversationId={currentConversationId}
            onNodeSelect={handleNodeSelect}
            onOpenParallel={handleOpenParallel}
            visibleMessageId={visibleMessageId}
            storageMode={conversationStorageMode}
          />
        </div>
      )}

      {/* Mobile: bottom drawer with backdrop */}
      {isMobile && (
        <>
          {/* Backdrop */}
          <AnimatePresence>
            {heimdallVisible && (
              <motion.div
                className='fixed inset-0 bg-black/50 z-[90]'
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={softTransition}
                onClick={() => {
                  setHeimdallVisible(false)
                  try {
                    window.localStorage.setItem('chat:heimdallVisible', 'false')
                  } catch {}
                }}
              />
            )}
          </AnimatePresence>

          {/* Drawer */}
          <AnimatePresence>
            {heimdallVisible && (
              <motion.div
                className='fixed bottom-0 left-0 right-0 h-[85vh] z-[100] bg-neutral-50 dark:bg-neutral-900 rounded-t-2xl shadow-2xl overflow-hidden'
                initial={{ y: '100%' }}
                animate={{ y: 0 }}
                exit={{ y: '100%' }}
                transition={contentSpringTransition}
              >
                {/* Drag handle indicator */}
                <div className='w-full flex justify-center py-3 bg-neutral-100 dark:bg-neutral-800 border-b border-neutral-200 dark:border-neutral-700'>
                  <div className='w-12 h-1.5 bg-neutral-400 dark:bg-neutral-600 rounded-full' />
                </div>

                {/* Heimdall component */}
                <div className='h-[calc(100%-3rem)] overflow-hidden'>
                  <Heimdall
                    key={currentConversationId ?? 'none'}
                    keyboardFocusRequest={treeFocusRequest}
                    onKeyboardFocusHandled={() => setTreeFocusRequest(0)}
                    chatData={heimdallData}
                    loading={loading}
                    error={error}
                    compactMode={compactMode}
                    conversationId={currentConversationId}
                    onNodeSelect={handleNodeSelect}
                    onOpenParallel={handleOpenParallel}
                    visibleMessageId={visibleMessageId}
                    storageMode={conversationStorageMode}
                  />
                </div>

                {/* Collapse button - bottom right corner */}
                <button
                  onClick={() => {
                    setHeimdallVisible(false)
                    try {
                      window.localStorage.setItem('chat:heimdallVisible', 'false')
                    } catch {}
                  }}
                  className='fixed bottom-6 right-6 z-110 w-12 h-12 rounded-full bg-neutral-700 dark:bg-neutral-600 hover:bg-neutral-800 dark:hover:bg-neutral-500 text-white shadow-lg flex items-center justify-center transition-colors'
                  aria-label='Close tree view'
                >
                  <i className='bx bx-chevron-down text-2xl' aria-hidden='true'></i>
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}

      <SettingsPane open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {/* Centered custom delete confirmation modal */}
      <DeleteConfirmModal
        isOpen={Boolean(pendingDeleteId && confirmDel)}
        title='Delete message?'
        description='This action cannot be undone.'
        dontAskAgain={dontAskAgain}
        onDontAskAgainChange={setDontAskAgain}
        onCancel={closeDeleteModal}
        onConfirm={confirmDeleteModal}
      />

      {/* Fixed expanded panel rendered at root to sit above backdrop and allow scroll */}
      {(expandedFilePath || closingFilePath) &&
        (() => {
          const activePath = expandedFilePath || closingFilePath
          const file = selectedFilesForChat.find(f => f.path === activePath)
          if (!file) return null
          const isClosing = !!closingFilePath && closingFilePath === file.path
          const name = file.name || file.relativePath.split('/').pop() || file.path.split('/').pop()
          const left = expandedAnchor?.left ?? 16
          const top = (expandedAnchor?.top ?? 16) - 8
          return (
            <div
              className='fixed z-[99999] -translate-y-full overflow-y-auto rounded-lg bg-neutral-100 p-3 shadow-sm transition-[opacity,transform] duration-[150ms] [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] pointer-events-auto dark:bg-neutral-900'
              style={{ left, top, maxWidth: '30vw', width: 'clamp(90vw, 90vw, 56rem)' }}
              onMouseDown={e => e.stopPropagation()}
              onMouseUp={e => e.stopPropagation()}
              onClick={e => e.stopPropagation()}
              onWheel={e => e.stopPropagation()}
              onTouchStart={e => e.stopPropagation()}
              onTouchMove={e => e.stopPropagation()}
              onTouchEnd={e => e.stopPropagation()}
            >
              <div className='flex items-center justify-between mb-2 gap-3'>
                <div className='text-xs text-blue-600 dark:text-blue-300 font-medium truncate'>{name}</div>
                <button
                  className='text-xs px-2 text-neutral-800 dark:text-neutral-300 py-1 rounded-xl border border-neutral-200 dark:border-neutral-600 hover:bg-neutral-200 dark:hover:bg-neutral-800'
                  onClick={handleCloseExpandedPreview}
                >
                  Close
                </button>
              </div>
              <div
                className={`text-xs font-mono whitespace-pre-wrap break-words text-stone-800 dark:text-stone-200 ${isClosing ? 'opacity-50' : 'opacity-100'} transition-opacity duration-100 overflow-auto thin-scrollbar max-h-[60vh] overscroll-contain select-text`}
              >
                {file.contents}
              </div>
            </div>
          )
        })()}

      {/* Transparent backdrop to allow click-out close. Keep during closing to finish animation */}
      {(expandedFilePath || closingFilePath) && (
        <div className='fixed inset-0 z-[99998] bg-transparent' onClick={handleCloseExpandedPreview} />
      )}

      {/* D3: the free-tier limit modal is intentionally NOT rendered here any more. Exhaustion
          arrives as a `free_tier_exhausted` chat bubble recorded by `sseProjection`, so a failed
          send never blocks the app. */}
      <ToolJobsModal isOpen={jobsModalOpen} onClose={() => setJobsModalOpen(false)} />
      <SubagentTranscriptModal
        toolCallId={subagentTranscriptToolCallId}
        onClose={() => setSubagentTranscriptToolCallId(null)}
      />

      {/* OpenRouter login required modal */}
      {openRouterLoginRequiredModalOpen && (
        <div
          className='fixed inset-0 z-[100] flex items-center justify-center'
          onClick={closeOpenRouterLoginRequiredModal}
          style={{ backgroundColor: authModalBackdropColor }}
        >
          <div
            className='rounded-lg shadow-xl p-6 w-[90%] max-w-md'
            onClick={e => e.stopPropagation()}
            style={{ backgroundColor: authModalSurfaceBackgroundColor }}
          >
            <h3 className='text-[20px] font-semibold mb-3' style={{ color: authModalTitleTextColor }}>
              Sign in required for Yggdrasil models
            </h3>
            <p className='text-[14px] mb-6' style={{ color: authModalBodyTextColor }}>
              you need to sign in with github or google account to access Yggdrasil models, logging in will merge your
              local and yggdrasil account, you wont lose any info
            </p>
            <div className='flex justify-end'>
              <Button
                variant='outline2'
                className='bg-emerald-600 hover:bg-emerald-700 border-emerald-700 text-white active:scale-90'
                onClick={confirmOpenRouterLoginRequired}
                style={authModalPrimaryButtonStyle}
              >
                Ok
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* OpenAI ChatGPT Login Modal */}
      {openaiLoginModalOpen && (
        <div
          className='fixed inset-0 z-[100] flex items-center justify-center'
          onClick={closeOpenaiLoginModal}
          style={{ backgroundColor: authModalBackdropColor }}
        >
          <div
            className='rounded-lg shadow-xl p-6 w-[90%] max-w-md'
            onClick={e => e.stopPropagation()}
            style={{ backgroundColor: authModalSurfaceBackgroundColor }}
          >
            <h3 className='text-[20px] font-semibold mb-2' style={{ color: authModalTitleTextColor }}>
              Sign in to OpenAI
            </h3>
            <p className='text-[14px] mb-4' style={{ color: authModalBodyTextColor }}>
              Use your ChatGPT Plus or Pro subscription to access GPT-4o and GPT-5 models locally.
            </p>

            {isOpenAIAuthenticated() ? (
              // Already authenticated - show logout option
              <div className='space-y-4'>
                <div className='flex items-center gap-2 p-3 bg-green-50 dark:bg-green-900/20 rounded-lg'>
                  <i className='bx bx-check-circle text-green-600 dark:text-green-400 text-xl'></i>
                  <span className='text-green-700 dark:text-green-300 text-sm'>You are signed in to OpenAI</span>
                </div>
                <div className='flex justify-end gap-2'>
                  <Button
                    variant='outline2'
                    onClick={closeOpenaiLoginModal}
                    className='active:scale-90'
                    style={authModalSecondaryButtonStyle}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant='outline2'
                    className='bg-red-600 hover:bg-red-700 border-red-700 text-white active:scale-90'
                    onClick={handleOpenaiLogout}
                    style={authModalDangerButtonStyle}
                  >
                    Sign Out
                  </Button>
                  <Button
                    variant='outline2'
                    className='bg-emerald-600 hover:bg-emerald-700 border-emerald-700 text-white active:scale-90'
                    onClick={() => {
                      requestModelSwitch({ provider: 'OpenAI (ChatGPT)', model: null }, () => {
                        dispatch(chatSliceActions.branchModelSelected({ provider: 'OpenAI (ChatGPT)', model: null }))
                        dispatch(chatSliceActions.providerSelected('OpenAI (ChatGPT)'))
                      }, openaiSelectionScopeRef.current ?? modelSwitchScope)
                      closeOpenaiLoginModal()
                    }}
                    style={authModalPrimaryButtonStyle}
                  >
                    Continue
                  </Button>
                </div>
              </div>
            ) : (
              // Not authenticated - show login flow
              <div className='space-y-4'>
                {openaiAuthError && (
                  <div className='flex items-center gap-2 p-3 bg-red-50 dark:bg-red-900/20 rounded-lg'>
                    <i className='bx bx-error-circle text-red-600 dark:text-red-400 text-xl'></i>
                    <span className='text-red-700 dark:text-red-300 text-sm'>{openaiAuthError}</span>
                  </div>
                )}

                <div className='rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900/50 dark:bg-emerald-900/20'>
                  <div className='flex items-center gap-2 text-sm text-emerald-800 dark:text-emerald-200'>
                    {(openaiAuthPolling || openaiAuthLoading) && (
                      <i className='bx bx-loader-alt animate-spin text-lg text-emerald-600 dark:text-emerald-300'></i>
                    )}
                    <span>
                      Complete the sign-in in your browser. Ygg Chat will finish automatically when OAuth completes.
                    </span>
                  </div>
                </div>

                <div className='flex justify-end gap-2 mt-6'>
                  <Button
                    variant='outline2'
                    onClick={closeOpenaiLoginModal}
                    className='active:scale-90'
                    style={authModalSecondaryButtonStyle}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant='outline2'
                    className='bg-neutral-800 hover:bg-neutral-900 border-neutral-700 text-white active:scale-90'
                    onClick={handleOpenaiLogin}
                    disabled={!openaiAuthFlow}
                    style={authModalPrimaryButtonStyle}
                  >
                    <i className='bx bx-link-external mr-2'></i>
                    Open Browser Again
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </motion.div>
  )
}

export default Chat
