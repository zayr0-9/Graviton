import { useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import 'boxicons' // Types
import 'boxicons/css/boxicons.min.css'
import { AnimatePresence, motion } from 'framer-motion'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { batch } from 'react-redux'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { estimateTokenCount } from 'tokenx'
import { ConversationId, ImageConfig, MessageId, ReasoningConfig } from '../../../../shared/types'
import {
  ActionPopover,
  Button,
  ChatMessage,
  DeleteConfirmModal,
  FreeGenerationsModal,
  Heimdall,
  InputTextArea,
  ModelSelectControl,
  Select,
  SettingsPane,
  TextField,
  ToolJobsModal,
  ToolPermissionDialog,
} from '../components'
import { useHtmlIframeRegistry } from '../components/HtmlIframeRegistry/HtmlIframeRegistry'
import {
  ChatInputBorderAnimationType,
  getStoredChatInputBorderAnimation,
  getStoredChatInputBorderDarkColor,
  getStoredChatInputBorderLightColor,
} from '../components/SettingsPane/ChatInputBorderAnimationSettings'
import {
  getStoredSendButtonAnimation,
  getStoredSendButtonColor,
  getStoredStreamingAnimation,
  getStoredStreamingDarkColor,
  getStoredStreamingLightColor,
  getStoredStreamingSpeed,
  SendButtonAnimationType,
  SendButtonLoadingAnimation,
  StreamingAnimationType,
  StreamingLoadingAnimation,
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
import {
  abortGeneration,
  AUTO_COMPACTION_NOTE,
  blobToDataURL,
  chatSliceActions,
  compactBranch,
  deleteMessage,
  editMessageWithBranching,
  initializeUserAndConversation,
  Message,
  resolveAttachmentUrl,
  respondToToolPermission,
  respondToToolPermissionAndEnableAll,
  selectCcCwd,
  selectConversationMessages,
  selectCurrentConversationId,
  selectCurrentPath,
  // Chat selectors
  selectCurrentViewStream,
  selectDisplayMessages,
  selectFocusedChatMessageId,
  selectHeimdallCompactMode,
  selectHeimdallData,
  selectHeimdallError,
  selectHeimdallLoading,
  selectMessageInput,
  selectMultiReplyCount,
  selectOperationMode,
  selectProviderState,
  selectSendingState,
  sendHermesMessage,
  sendMessage,
  syncConversationToLocal,
  updateConversationTitle,
} from '../features/chats'
import type { ContentBlock, ToolCall } from '../features/chats/chatTypes'
import {
  extractBranchFileMutations,
  type WorkspaceMutationOperation,
} from '../features/chats/workspaceMutationTracking'
import {
  clearTokens as clearOpenAITokens,
  fetchOpenAIUsageStatus,
  isOpenAIAuthenticated,
  saveTokens,
  type OpenAIUsageSnapshot,
} from '../features/chats/openaiOAuth'
import { buildBranchPathForMessage } from '../features/chats/pathUtils'
import { generateStreamId } from '../features/chats/streamHelpers'
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
import { refreshUserCredits, selectCurrentUser } from '../features/users'
import {
  CHAT_REASONING_SETTINGS_CHANGE_EVENT,
  loadChatReasoningSettings,
  REASONING_EFFORT_OPTIONS,
} from '../helpers/chatReasoningSettingsStorage'
import {
  CHAT_UI_AUTO_COMPACTION_ENABLED_CHANGE_EVENT,
  CHAT_UI_AUTO_COMPACTION_ENABLED_KEY,
  CHAT_UI_TOKEN_USAGE_VISIBILITY_CHANGE_EVENT,
  loadAutoCompactionEnabled,
  loadShowTokenUsageBar,
} from '../helpers/chatUiSettingsStorage'
import {
  loadProviderSettings,
  PROVIDER_SETTINGS_CHANGE_EVENT,
  ProviderSettings,
} from '../helpers/providerSettingsStorage'
import { isOrchestratorEnabled, toggleOrchestratorEnabled } from '../helpers/subagentToolSettings'
import { useAppDispatch, useAppSelector } from '../hooks/redux'
import { useAuth } from '../hooks/useAuth'
import { useIdeContext } from '../hooks/useIdeContext'
import { useIsMobile } from '../hooks/useMediaQuery'
import { useRunningJobs } from '../hooks/useToolJobs'
import {
  ResearchNoteItem,
  useConversationMessages,
  useConversationsByProject,
  useConversationStorageMode,
  useModels,
  useSelectedModel,
  useSelectModel,
} from '../hooks/useQueries'
import { useSubscriptionStatus } from '../hooks/useSubscriptionStatus'
import { CHAT_INSERT_FILE_PATH_EVENT, type ChatInsertFilePathDetail } from '../helpers/chatInputBridge'
import { dispatchOpenWorkspaceMutationDiffs } from '../helpers/workspaceMutationDiffBridge'
import { cloneConversation, localApi } from '../utils/api'
import { getAssetPath } from '../utils/assetPath'
import { parseId } from '../utils/helpers'
import { extractTextFromPdf } from '../utils/pdfUtils'

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

type ChatInputUpdater = string | ((prev: string) => string)

type ChatInputControllerHandle = {
  getValue: () => string
  setValue: (next: ChatInputUpdater) => void
  clear: () => void
  focus: () => void
}

type ComposerSlashCommandResult = {
  handled: boolean
  clearInput?: boolean
}

type ChatInputControllerProps = {
  conversationId: ConversationId | null
  initialValue: string
  slashCommands?: string[]
  onSlashCommandSelect?: (command: string) => ComposerSlashCommandResult | void
  onHasTextChange: (hasText: boolean) => void
  onSubmit: () => void
  onBlurPersist: (content: string) => void
  onAddCurrentIdeContext?: () => boolean
  onClearIdeContexts?: () => void
  selectedIdeContextItems?: Array<{ id: string; label: string }>
  fallbackFileSearchRoot?: string | null
}

type AddedIdeContext = {
  id: string
  filePath: string
  fileName: string
  startLine: number
  endLine: number
  selectedText: string
}

const EMPTY_PARSED_MESSAGE_DATA: ParsedMessageData = {}
const COMPOSER_SLASH_COMMANDS = [
  'status-openai',
  'compactify',
  'bench on',
  'bench off',
  'bench status',
  'bench export',
  'bench reset',
  'theme-demo on',
  'theme-demo off',
]
const CROSS_MESSAGE_PROCESS_GROUP_MIN_MESSAGES = 3
const DERIVED_RENDER_CACHE_LIMIT = 40
const ACTION_POPOVER_SELECT_DROPDOWN_Z_INDEX = 100001
const VIRTUAL_ROWS_FEATURE_FLAG = 'chat:virtualRowsV2'
const BENCH_MAX_SAMPLES = 3000
const BENCH_MAX_EVENTS = 1200
const BENCH_SCROLL_ACTIVE_WINDOW_MS = 140
const THEME_DEMO_INTERVAL_MS = 500

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

// const formatStreamDebugId = (value: unknown): string => {
//   if (value == null || value === '') return '—'
//   const stringValue = String(value)
//   return stringValue.length > 18 ? `${stringValue.slice(0, 8)}…${stringValue.slice(-6)}` : stringValue
// }

const EmptyChatState = () => (
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
    </div>
  </div>
)

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
  }

  return { toolCalls, contentBlocks }
}

const ChatInputController = React.memo(
  React.forwardRef<ChatInputControllerHandle, ChatInputControllerProps>(
    (
      {
        conversationId,
        initialValue,
        slashCommands,
        onSlashCommandSelect,
        onHasTextChange,
        onSubmit,
        onBlurPersist,
        onAddCurrentIdeContext,
        onClearIdeContexts,
        selectedIdeContextItems,
        fallbackFileSearchRoot,
      },
      ref
    ) => {
      const [value, setValueState] = useState(initialValue)
      const valueRef = useRef(initialValue)
      const wrapperRef = useRef<HTMLDivElement | null>(null)
      const lastHasTextRef = useRef(initialValue.trim().length > 0)

      const publishHasText = useCallback(
        (nextValue: string) => {
          const hasText = nextValue.trim().length > 0
          if (hasText !== lastHasTextRef.current) {
            lastHasTextRef.current = hasText
            onHasTextChange(hasText)
          }
        },
        [onHasTextChange]
      )

      const setValue = useCallback(
        (next: ChatInputUpdater) => {
          const prevValue = valueRef.current
          const nextValue = typeof next === 'function' ? next(prevValue) : next
          valueRef.current = nextValue
          setValueState(nextValue)
          publishHasText(nextValue)
        },
        [publishHasText]
      )

      const clear = useCallback(() => {
        setValue('')
      }, [setValue])

      const focus = useCallback(() => {
        const textarea = wrapperRef.current?.querySelector('textarea')
        if (!textarea) return
        try {
          textarea.focus({ preventScroll: true })
        } catch {
          textarea.focus()
        }
      }, [])

      useEffect(() => {
        valueRef.current = initialValue
        setValueState(initialValue)
        const hasText = initialValue.trim().length > 0
        lastHasTextRef.current = hasText
        onHasTextChange(hasText)
      }, [conversationId, initialValue, onHasTextChange])

      React.useImperativeHandle(
        ref,
        () => ({
          getValue: () => valueRef.current,
          setValue,
          clear,
          focus,
        }),
        [clear, focus, setValue]
      )

      const handleChange = useCallback(
        (nextValue: string) => {
          valueRef.current = nextValue
          setValueState(nextValue)
          publishHasText(nextValue)
        },
        [publishHasText]
      )

      const handleKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            onSubmit()
          }
        },
        [onSubmit]
      )

      const handleBlur = useCallback(() => {
        onBlurPersist(valueRef.current)
      }, [onBlurPersist])

      return (
        <div ref={wrapperRef}>
          <InputTextArea
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            placeholder='Type your message...'
            state='default'
            width='w-full'
            minRows={1}
            autoFocus={true}
            showCharCount={false}
            slashCommands={slashCommands}
            onSlashCommandSelect={onSlashCommandSelect}
            onAddCurrentIdeContext={onAddCurrentIdeContext}
            onClearIdeContexts={onClearIdeContexts}
            selectedIdeContextItems={selectedIdeContextItems}
            fallbackFileSearchRoot={fallbackFileSearchRoot}
            className='!border-0 !focus:border-0 !outline-none !shadow-none focus:!ring-0'
          />
        </div>
      )
    }
  )
)

ChatInputController.displayName = 'ChatInputController'

function Chat() {
  const dispatch = useAppDispatch()
  const { accessToken, userId } = useAuth()
  const navigate = useNavigate()
  const { ideContext, requestContext } = useIdeContext()
  const queryClient = useQueryClient()
  const htmlRegistry = useHtmlIframeRegistry()

  // Keep high-frequency keystrokes inside the input controller to avoid rerendering Chat.
  const inputControllerRef = useRef<ChatInputControllerHandle | null>(null)
  const [hasLocalInput, setHasLocalInput] = useState(false)
  const [addedIdeContexts, setAddedIdeContexts] = useState<AddedIdeContext[]>([])
  const [pendingViewStreamId, setPendingViewStreamId] = useState<string | null>(null)

  const getLocalInput = useCallback(() => inputControllerRef.current?.getValue() ?? '', [])
  const updateLocalInput = useCallback((next: ChatInputUpdater) => {
    inputControllerRef.current?.setValue(next)
  }, [])
  const clearLocalInput = useCallback(() => {
    inputControllerRef.current?.clear()
  }, [])
  const focusLocalInput = useCallback(() => {
    inputControllerRef.current?.focus()
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

  // Hermes ACP mode toggle (desktop-only)
  const [hermesMode, setHermesMode] = useState(() => {
    if (import.meta.env.VITE_ENVIRONMENT === 'web') return false
    try {
      return window.localStorage.getItem('chat:agentMode') === 'hermes'
    } catch {
      return false
    }
  })

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

  // Hermes mode is available in desktop builds
  const hermesModeAvailable = import.meta.env.VITE_ENVIRONMENT !== 'web'

  // Get conversation ID and project ID from URL params FIRST (before any hooks that depend on it)
  const { id: conversationIdParam, projectId: projectIdParam } = useParams<{ id?: string; projectId?: string }>()
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
  const messageInput = useAppSelector(selectMessageInput)
  const operationMode = useAppSelector(selectOperationMode)
  // const canSendFromRedux = useAppSelector(selectCanSend)
  const sendingState = useAppSelector(selectSendingState)
  const currentConversationId = useAppSelector(selectCurrentConversationId)
  const compactingConversationId = useAppSelector(state => state.chat.composition.compactingConversationId)
  // Current view stream - automatically selects the relevant stream based on currentPath
  const currentViewStream = useAppSelector(selectCurrentViewStream)
  const pendingViewStream = useAppSelector(state =>
    pendingViewStreamId ? (state.chat.streaming.byId[pendingViewStreamId] ?? null) : null
  )
  const effectiveViewStream = useMemo(() => {
    if (currentViewStream) return currentViewStream
    if (!pendingViewStreamId || !pendingViewStream?.active) return null
    if (
      currentConversationId != null &&
      pendingViewStream.conversationId != null &&
      String(pendingViewStream.conversationId) !== String(currentConversationId)
    ) {
      return null
    }
    return { id: pendingViewStreamId, ...pendingViewStream }
  }, [currentConversationId, currentViewStream, pendingViewStream, pendingViewStreamId])
  // Derived streamState object for compatibility (combines current/effective view stream data)
  const streamState = useMemo(
    () => ({
      id: effectiveViewStream?.id ?? null,
      active: effectiveViewStream?.active ?? false,
      buffer: effectiveViewStream?.buffer ?? '',
      thinkingBuffer: effectiveViewStream?.thinkingBuffer ?? '',
      toolCalls: effectiveViewStream?.toolCalls ?? [],
      events: effectiveViewStream?.events ?? [],
      messageId: effectiveViewStream?.messageId ?? null,
      error: effectiveViewStream?.error ?? null,
      finished: effectiveViewStream?.finished ?? false,
      streamingMessageId: effectiveViewStream?.streamingMessageId ?? null,
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
    if (pendingViewStream && (!pendingViewStream.active || pendingViewStream.finished)) {
      setPendingViewStreamId(null)
    }
  }, [pendingViewStream, pendingViewStreamId])

  useEffect(() => {
    setPendingViewStreamId(null)
  }, [currentConversationId])

  const conversationMessages = useAppSelector(selectConversationMessages)
  const displayMessages = useAppSelector(selectDisplayMessages)
  const toolCallPermissionRequest = useAppSelector(state => state.chat.toolCallPermissionRequest)
  const toolAutoApprove = useAppSelector(state => state.chat.toolAutoApprove)
  const showFreeTierModal = useAppSelector(state => state.chat.freeTier.showLimitModal)
  // const freeGenerationsRemaining = useAppSelector(state => state.chat.freeTier.freeGenerationsRemaining)

  // React Query for message fetching - MOVED BELOW after projectConversations is available
  // to enable passing storage_mode from cached conversations
  const selectedPath = useAppSelector(selectCurrentPath)
  const runningToolJobs = useRunningJobs()
  const multiReplyCount = useAppSelector(selectMultiReplyCount)
  const focusedChatMessageId = useAppSelector(selectFocusedChatMessageId)
  const isBranchEditing = useAppSelector(state => state.chat.composition.editingBranch)

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
  // Dynamic input area height for adaptive padding
  // const [inputAreaHeight, setInputAreaHeight] = useState(170)
  const [containerHeight, setContainerHeight] = useState(1100)
  // Credits refresh loading state
  const [isRefreshingCredits, setIsRefreshingCredits] = useState(false)
  // Todo list collapsed state
  const [todoListCollapsed, setTodoListCollapsed] = useState(false)
  const [workspaceMutationsCollapsed, setWorkspaceMutationsCollapsed] = useState(false)
  // Tool jobs modal state
  const [jobsModalOpen, setJobsModalOpen] = useState(false)
  const [orchestratorEnabled, setOrchestratorEnabledState] = useState(() => isOrchestratorEnabled())
  // OpenRouter cloud-sign-in required modal state
  const [openRouterLoginRequiredModalOpen, setOpenRouterLoginRequiredModalOpen] = useState(false)
  // OpenAI ChatGPT login modal state
  const [openaiLoginModalOpen, setOpenaiLoginModalOpen] = useState(false)
  const [openaiAuthFlow, setOpenaiAuthFlow] = useState<{ url: string; verifier: string; state: string } | null>(null)
  // const [openaiCallbackInput, setOpenaiCallbackInput] = useState('')
  const [openaiAuthError, setOpenaiAuthError] = useState<string | null>(null)
  const [openaiAuthLoading, setOpenaiAuthLoading] = useState(false)
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
      const data = await localApi.post<{ result?: ThemeManagerReadResult }>('/tools/execute', {
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
        const data = await localApi.post<{ result?: ThemeManagerListResult }>('/tools/execute', {
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
        if (message?.role === 'system' && message?.note === AUTO_COMPACTION_NOTE) {
          return { index: i, message }
        }
      }
      return { index: -1, message: null as Message | null }
    })()

    const compactionSourceMessages = (
      latestCompaction.index >= 0 ? displayMessages.slice(latestCompaction.index + 1) : displayMessages
    ).filter(Boolean)

    const lastMessage = displayMessages[displayMessages.length - 1]
    if (!lastMessage || lastMessage.note === AUTO_COMPACTION_NOTE || compactionSourceMessages.length < 2) {
      console.warn('[ManualCompaction] skipped: insufficient source context', {
        hasLastMessage: Boolean(lastMessage),
        lastIsCompaction: lastMessage?.note === AUTO_COMPACTION_NOTE,
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
      const hasValidCompactionMarker =
        compactedMessage?.role === 'system' &&
        compactedMessage?.note === AUTO_COMPACTION_NOTE &&
        String(compactedMessage?.parent_id ?? '') === String(lastMessage.id)

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

      if (normalized === 'compactify') {
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
    // Match transition duration (100ms)
    window.setTimeout(() => setClosingFilePath(null), 130)
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

      // Helper function to extract basename (filename without full path).
      // Handles both Windows (\) and Unix (/) path separators.
      const basename = (p: string) => {
        if (!p) return p
        const parts = p.split(/\\\\|\//) // Regex splits on \\ (escaped for JS) or /.
        return parts[parts.length - 1] // Returns the last part (e.g., 'api.ts' from '/src/api.ts').
      }

      // Populate the Map from selected files (assuming selectedFilesForChat is SelectedFileContent[]).
      // Adds multiple variations of the filename as keys for flexible matching.
      // Values are now f.path (full path).
      for (const f of selectedFilesForChat) {
        if (f.name && !nameToPath.has(f.name)) nameToPath.set(f.name, f.path)
        const baseRel = basename(f.relativePath)
        if (baseRel && !nameToPath.has(baseRel)) nameToPath.set(baseRel, f.path)
        const basePath = basename(f.path)
        if (basePath && !nameToPath.has(basePath)) nameToPath.set(basePath, f.path)
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
  // Track whether the upcoming selection change came from an explicit user click in Heimdall
  const selectionScrollCauseRef = useRef<'user' | null>(null)
  // Track if the user manually scrolled during the current stream; disables bottom pin until finished
  const userScrolledDuringStreamRef = useRef<boolean>(false)
  const streamActiveRef = useRef<boolean>(false)
  // Sentinel at the end of the list for robust bottom scrolling
  const bottomRef = useRef<HTMLDivElement>(null)
  // rAF id to coalesce frequent scroll requests during streaming
  const scrollRafRef = useRef<number | null>(null)
  // Remember the last focused message we already scrolled to (to avoid repeated jumps)
  const lastFocusedScrollIdRef = useRef<MessageId | null>(null)
  // Track the most visible message ID for Heimdall highlighting
  const [visibleMessageId, setVisibleMessageId] = useState<MessageId | null>(null)
  const [showScrollToBottomButton, setShowScrollToBottomButton] = useState(false)
  const updateVisibleMessageRef = useRef<(() => void) | null>(null)
  // Ref for input area to measure its height dynamically
  const inputAreaRef = useRef<HTMLDivElement>(null)

  const attachmentInputRef = useRef<HTMLInputElement>(null)

  // Track if we already applied the URL hash-based path to avoid overriding user branch switches
  const hashAppliedRef = useRef<MessageId | null>(null)

  const findNearestHermesSessionFromMessage = useCallback(
    (startMessageId: MessageId | null | undefined): string | undefined => {
      if (startMessageId == null) return undefined

      let currentMessageId: MessageId | null = startMessageId

      while (currentMessageId != null) {
        const message = conversationMessages.find(m => String(m.id) === String(currentMessageId))

        if (typeof message?.ex_agent_session_id === 'string' && message.ex_agent_session_id.trim().length > 0) {
          return message.ex_agent_session_id
        }

        currentMessageId = message?.parent_id ?? null
      }

      return undefined
    },
    [conversationMessages]
  )

  // Helper function to find the last Hermes session ID in a message path.
  // This follows the selected lineage tip first and then walks upward through ancestors.
  const findLastHermesSession = useCallback(
    (messageIds: MessageId[]): string | undefined => {
      if (!messageIds || messageIds.length === 0) return undefined
      return findNearestHermesSessionFromMessage(messageIds[messageIds.length - 1])
    },
    [findNearestHermesSessionFromMessage]
  )

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

  // Filtered messages for virtualization - removes nulls and invalid IDs
  const filteredMessages = useMemo(() => {
    return displayMessages.filter(msg => msg && msg.id != null)
  }, [displayMessages])

  const [groupToolReasoningRuns, setGroupToolReasoningRuns] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem('chat:groupToolReasoningRuns')
      return stored === null ? false : stored === 'true'
    } catch {
      return false
    }
  })

  const [virtualRowsV2Enabled] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(VIRTUAL_ROWS_FEATURE_FLAG)
      return stored == null ? true : stored !== 'false'
    } catch {
      return true
    }
  })

  const virtualizationMetricsRef = useRef<{
    lastRowDeriveMs: number
    lastRenderRowsCount: number
  }>({ lastRowDeriveMs: 0, lastRenderRowsCount: 0 })

  const parsedMessageDataCacheRef = useRef<Map<string, Map<MessageId, ParsedMessageData>>>(new Map())
  const messageRenderRowsCacheRef = useRef<Map<string, MessageRenderRow[]>>(new Map())

  const filteredMessagesSignature = useMemo(
    () =>
      filteredMessages
        .map(msg => {
          const updatedAt = (msg as Message & { updated_at?: string }).updated_at ?? msg.created_at
          const artifactCount = Array.isArray(msg.artifacts) ? msg.artifacts.length : 0
          return `${msg.id}:${updatedAt}:a${artifactCount}`
        })
        .join('|'),
    [filteredMessages]
  )

  // Parse message payloads once per message-list change so row props remain stable while typing.
  const parsedMessageDataById = useMemo(() => {
    const cacheKey = filteredMessagesSignature
    const cached = parsedMessageDataCacheRef.current.get(cacheKey)
    if (cached) return cached

    const parsedById = new Map<MessageId, ParsedMessageData>()
    for (const msg of filteredMessages) {
      parsedById.set(msg.id, parseMessageDataForRender(msg))
    }

    setLimitedCacheEntry(parsedMessageDataCacheRef.current, cacheKey, parsedById)
    return parsedById
  }, [filteredMessages, filteredMessagesSignature])

  const messageRenderRows = useMemo<MessageRenderRow[]>(() => {
    const deriveStart = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const debugProcessGrouping =
      typeof window !== 'undefined' && window.localStorage.getItem('chat:debugProcessGrouping') === 'true'

    const rowsCacheKey = `${groupToolReasoningRuns ? 'grouped' : 'plain'}|${filteredMessagesSignature}`
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
      if (msg.role !== 'assistant' && msg.role !== 'ex_agent') {
        return false
      }

      const parsed = parsedMessageDataById.get(msg.id) ?? EMPTY_PARSED_MESSAGE_DATA
      if (!hasProcessSignal(msg, parsed)) {
        return false
      }

      if (hasSubstantialTextOrImage(msg, parsed)) {
        return false
      }

      return true
    }

    if (!groupToolReasoningRuns) {
      const plainRows = filteredMessages.map(msg => ({
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

    while (index < filteredMessages.length) {
      const msg = filteredMessages[index]
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
      while (cursor < filteredMessages.length) {
        const candidate = filteredMessages[cursor]
        if (!candidate || !isProcessOnlyAssistantStep(candidate)) {
          break
        }
        runMessages.push(candidate)
        cursor += 1
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
        const trailingCandidate = filteredMessages[cursor]
        if (trailingCandidate && (trailingCandidate.role === 'assistant' || trailingCandidate.role === 'ex_agent')) {
          const trailingParsed = parsedMessageDataById.get(trailingCandidate.id) ?? EMPTY_PARSED_MESSAGE_DATA
          const trailingHasProcessSignal = hasProcessSignal(trailingCandidate, trailingParsed)
          const trailingHasSubstantialContent = hasSubstantialTextOrImage(trailingCandidate, trailingParsed)
          const trailingUsesOrderedResponsesItems = hasResponsesOutputItems(trailingParsed)

          if (trailingHasProcessSignal && trailingHasSubstantialContent && !trailingUsesOrderedResponsesItems) {
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
  }, [filteredMessages, filteredMessagesSignature, groupToolReasoningRuns, parsedMessageDataById])

  const messageById = useMemo(() => {
    const map = new Map<string, Message>()
    for (const msg of filteredMessages) {
      map.set(String(msg.id), msg)
    }
    return map
  }, [filteredMessages])

  const messageRowIndexByMessageId = useMemo(() => {
    const rowIndexByMessageId = new Map<string, number>()

    for (let index = 0; index < messageRenderRows.length; index++) {
      const row = messageRenderRows[index]
      if (row.kind === 'message') {
        rowIndexByMessageId.set(String(row.message.id), index)
        continue
      }

      for (const memberId of row.memberMessageIds) {
        const key = String(memberId)
        if (!rowIndexByMessageId.has(key)) {
          rowIndexByMessageId.set(key, index)
        }
      }
    }

    return rowIndexByMessageId
  }, [messageRenderRows])

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

      const containerClassName = [startsAssistantBlock ? 'pt-4' : '', endsAssistantBlock ? 'pb-4' : '', radiusClassName]
        .filter(Boolean)
        .join(' ')

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

  // Calculate padding for end of list - allows last message to scroll to middle of viewport
  const virtualizerPaddingEnd = useMemo(() => {
    return Math.max(500, containerHeight * 0.6)
  }, [containerHeight])

  // Determine if optimistic/streaming messages should be shown (all modes for instant feedback)
  const showOptimisticMessage = !!optimisticMessage
  const showOptimisticBranchMessage = !!optimisticBranchMessage
  const isCurrentConversationCompacting =
    sendingState.compacting &&
    currentConversationId != null &&
    compactingConversationId != null &&
    String(compactingConversationId) === String(currentConversationId)
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
  const showGenerationLoadingAnimation =
    isCurrentConversationCompacting || streamState.active || hasRunningToolJobForCurrentBranch
  const hasStreamingMessageContent =
    Boolean(streamState.buffer) ||
    Boolean(streamState.thinkingBuffer) ||
    streamState.toolCalls.length > 0 ||
    streamState.events.length > 0
  const isStreamingMessageAlreadyRendered =
    streamState.messageId != null && messageRowIndexByMessageId.has(String(streamState.messageId))
  const showStreamingMessage = !isStreamingMessageAlreadyRendered && hasStreamingMessageContent
  const showGenerationLoaderRow = showGenerationLoadingAnimation

  const virtualRows = useMemo<VirtualRenderRow[]>(() => {
    const rows: VirtualRenderRow[] = messageRenderRows.map((row, index) => ({
      kind: 'message_row',
      key: virtualRowsV2Enabled
        ? row.kind === 'message'
          ? `message-${row.message.id}`
          : `group-${row.id}`
        : `legacy-row-${index}`,
      row,
    }))

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

    if (showStreamingMessage) {
      rows.push({
        kind: 'streaming_message',
        key: 'streaming',
      })
    }

    if (showGenerationLoaderRow) {
      rows.push({
        kind: 'generation_loader',
        key: 'generation-loader',
      })
    }

    return rows
  }, [
    messageRenderRows,
    showOptimisticMessage,
    optimisticMessage,
    showOptimisticBranchMessage,
    optimisticBranchMessage,
    showStreamingMessage,
    showGenerationLoaderRow,
    virtualRowsV2Enabled,
  ])

  useEffect(() => {
    benchLatestMessageCountRef.current = filteredMessages.length
    benchLatestVirtualRowCountRef.current = virtualRows.length
    benchLatestConversationIdRef.current = currentConversationId != null ? String(currentConversationId) : null
  }, [currentConversationId, filteredMessages.length, virtualRows.length])

  // Virtualizer for efficient message list rendering
  const virtualizer = useVirtualizer({
    count: virtualRows.length,
    getItemKey: index => (virtualRowsV2Enabled ? (virtualRows[index]?.key ?? index) : index),
    getScrollElement: () => messagesContainerRef.current,
    estimateSize: () => 100, // Estimated average message height
    overscan: 6, // Buffer rows above/below viewport
    paddingEnd: virtualizerPaddingEnd,
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.localStorage.getItem('chat:debugVirtualizerMetrics') !== 'true') return

    console.debug('[Chat] Virtual rows derived', {
      v2: virtualRowsV2Enabled,
      rows: virtualRows.length,
      deriveMs: virtualizationMetricsRef.current.lastRowDeriveMs,
      baseRows: virtualizationMetricsRef.current.lastRenderRowsCount,
    })
  }, [virtualRows.length, filteredMessagesSignature, virtualRowsV2Enabled])

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
  }, [appendBenchEvent, benchEnabled, filteredMessagesSignature, virtualRows.length])

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

  // Consider the user to be "at the bottom" if within this many pixels
  const NEAR_BOTTOM_PX = 600
  const isNearBottom = (el: HTMLElement, threshold = NEAR_BOTTOM_PX) => {
    // Distance remaining to bottom within the scroll container
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight
    return remaining <= threshold
  }

  const updateScrollToBottomButtonVisibility = useCallback(() => {
    const el = messagesContainerRef.current
    if (!el || virtualRows.length === 0) {
      setShowScrollToBottomButton(false)
      return
    }

    setShowScrollToBottomButton(!isNearBottom(el, NEAR_BOTTOM_PX))
  }, [virtualRows.length])

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
  const selectedModel = useSelectedModel(providers.currentProvider)
  const models = modelsData?.models || []

  // Helper to check if selected model is an image generation model
  const isImageGenerationModel = useMemo(() => {
    const modelName = selectedModel?.name?.toLowerCase() || ''
    return modelName.includes('gemini-3-pro-image-preview') || modelName.includes('gemini-2.5-flash-image')
  }, [selectedModel?.name])
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

  const setCcCwdFromSystem = useCallback(
    (nextValue: string) => {
      isCwdDirtyRef.current = false
      dispatch(chatSliceActions.ccCwdSet(nextValue))
    },
    [dispatch]
  )

  const setHermesModeEnabled = useCallback(
    (enabled: boolean) => {
      if (!hermesModeAvailable) {
        setHermesMode(false)
        return
      }

      setHermesMode(enabled)
      try {
        window.localStorage.setItem('chat:agentMode', enabled ? 'hermes' : 'default')
      } catch {
        // noop
      }
    },
    [hermesModeAvailable]
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

  // React Query for message fetching (automatic deduplication and caching)
  // Use URL-derived ID to ensure correct fetching even on page refresh
  // Single request fetches both messages AND tree data to eliminate duplicate requests
  // Pass storage_mode from projectConversations to correctly route to local/cloud API
  const { data: conversationData, isFetched: isConversationDataFetched } = useConversationMessages(
    conversationIdFromUrl,
    conversationStorageMode
  )
  const treeData = conversationData?.tree
  // Use useMemo to ensure stable reference for empty object fallback
  // Without this, {} !== {} on each render, causing the useEffect below to
  // dispatch on every render, triggering an infinite update loop

  const [titleInput, setTitleInput] = useState(currentConversation?.title ?? '')
  const [editingTitle, setEditingTitle] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const editingTitleRef = useRef(false)
  const optionsOpenRef = useRef(false)
  const [cloningConversation, setCloningConversation] = useState(false)
  const [isTitleBarVisible, setIsTitleBarVisible] = useState(true)
  const lastScrollTopRef = useRef(0)
  const optionsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setTitleInput(currentConversation?.title ?? '')
  }, [currentConversation?.title])

  useEffect(() => {
    editingTitleRef.current = editingTitle
  }, [editingTitle])

  useEffect(() => {
    optionsOpenRef.current = optionsOpen
  }, [optionsOpen])

  useEffect(() => {
    setAddedIdeContexts([])
  }, [currentConversationId])

  // Close options dropdown on outside click
  useEffect(() => {
    if (!optionsOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (optionsRef.current && !optionsRef.current.contains(e.target as Node)) {
        setOptionsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [optionsOpen])

  // Always reveal top bar when switching conversations.
  useEffect(() => {
    setIsTitleBarVisible(true)
  }, [currentConversationId])

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
          if (delta > 0 && !editingTitleRef.current && !optionsOpenRef.current) {
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

  // Debounce title updates to avoid dispatching on every keystroke
  useEffect(() => {
    if (!currentConversationId) return
    const trimmed = titleInput.trim()
    const currentTrimmed = (currentConversation?.title ?? '').trim()
    // No-op if unchanged
    if (trimmed === currentTrimmed) return
    const handle = setTimeout(() => {
      dispatch(
        updateConversationTitle({
          id: currentConversationId,
          title: trimmed,
          storageMode: currentConversation?.storage_mode,
        })
      )
        .unwrap()
        .then(() => {
          // Update React Query caches to reflect the new title
          const projectId = selectedProject?.id || currentConversation?.project_id

          // Update all conversations cache
          const conversationsCache = queryClient.getQueryData<Conversation[]>(['conversations'])
          if (conversationsCache) {
            queryClient.setQueryData(
              ['conversations'],
              conversationsCache.map(conv => (conv.id === currentConversationId ? { ...conv, title: trimmed } : conv))
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
                  conv.id === currentConversationId ? { ...conv, title: trimmed } : conv
                )
              )
            }
          }

          // Update recent conversations cache
          const recentCache = queryClient.getQueryData<Conversation[]>(['conversations', 'recent'])
          if (recentCache) {
            queryClient.setQueryData(
              ['conversations', 'recent'],
              recentCache.map(conv => (conv.id === currentConversationId ? { ...conv, title: trimmed } : conv))
            )
          }
        })
        .catch(error => {
          console.error('Failed to update conversation title:', error)
        })
    }, 1000)
    return () => clearTimeout(handle)
  }, [titleInput, currentConversationId, currentConversation?.title, dispatch, queryClient, selectedProject?.id])

  // Reset visible messages immediately when switching conversations to prevent stale message bleed.
  // Also evict inactive message caches from previously visited conversations to reduce memory pressure.
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

    dispatch(chatSliceActions.messagesLoaded([]))
  }, [conversationIdFromUrl, dispatch, queryClient])

  // Sync React Query messages to Redux when query resolves, including empty conversations.
  // This keeps Redux state updated for components that still depend on it.
  useEffect(() => {
    if (!conversationIdFromUrl || !isConversationDataFetched) return

    const fetchedMessages = conversationData?.messages ?? []
    dispatch(chatSliceActions.messagesLoaded(fetchedMessages))

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
  }, [conversationData, conversationIdFromUrl, conversationStorageMode, dispatch, isConversationDataFetched])

  // Sync tree data to Redux when it arrives
  // Always dispatch even when treeData is null/undefined to keep Redux in sync with React Query
  useEffect(() => {
    dispatch(chatSliceActions.heimdallDataLoaded({ treeData, subagentMap: {} }))
  }, [treeData, dispatch])

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

  // Sort conversations by updated_at descending for the Select dropdown
  const sortedConversations = useMemo(() => {
    const projectId = projectIdFromUrl || selectedProject?.id || currentConversation?.project_id
    if (!projectId) return []

    return [...projectConversations].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
  }, [projectConversations, projectIdFromUrl, selectedProject?.id, currentConversation?.project_id])

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
  const [settingsOpen, setSettingsOpen] = useState(false)
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
  // Font size offset for messages (synced from SettingsPane via custom event + localStorage)
  const [fontSizeOffset, setFontSizeOffset] = useState<number>(() => {
    try {
      const stored = localStorage.getItem('chat:fontSizeOffset')
      return stored ? parseInt(stored, 10) : 0
    } catch {
      return 0
    }
  })

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
  const chatInputAreaBorderColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.chatInputAreaBorder, isDarkMode)
    : undefined
  const chatProgressBarFillColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.chatProgressBarFill, isDarkMode)
    : undefined
  const actionPopoverInputBorderColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.actionPopoverBorder, isDarkMode)
    : undefined
  const sendButtonAnimationThemeColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.sendButtonAnimationColor, isDarkMode)
    : undefined
  const streamingAnimationThemeColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.streamingAnimationColor, isDarkMode)
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

  const useCustomInputAreaBorderColor = customThemeEnabled && operationMode !== 'plan'
  const chatInputBorderAnimationEnabled = operationMode !== 'plan' && chatInputBorderAnimation !== 'none'
  const effectiveAnimatedInputBorderColor =
    useCustomInputAreaBorderColor && chatInputAreaBorderColor ? chatInputAreaBorderColor : undefined
  const effectiveChatInputBorderLightColor = effectiveAnimatedInputBorderColor ?? chatInputBorderLightColor
  const effectiveChatInputBorderDarkColor = effectiveAnimatedInputBorderColor ?? chatInputBorderDarkColor

  const inputAreaBorderClasses = chatInputBorderAnimationEnabled
    ? `chat-input-border-anim chat-input-border-${chatInputBorderAnimation}`
    : operationMode === 'plan'
      ? 'outline-1 outline-blue-200/70 dark:outline-neutral-700/50'
      : useCustomInputAreaBorderColor
        ? 'outline-2 dark:outline-2'
        : 'outline-2 dark:outline-2 dark:outline-orange-700/70 outline-orange-700/70'

  const [showTokenUsageBar, setShowTokenUsageBar] = useState<boolean>(() => loadShowTokenUsageBar())
  const [autoCompactionEnabled, setAutoCompactionEnabled] = useState<boolean>(() => loadAutoCompactionEnabled())
  const [expandedProcessMessageRuns, setExpandedProcessMessageRuns] = useState<Set<string>>(() => new Set())
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

    const handleStorageEvent = (e: StorageEvent) => {
      if (e.key === 'chat:groupToolReasoningRuns' && e.newValue !== null) {
        setGroupToolReasoningRuns(e.newValue === 'true')
      }
    }

    window.addEventListener('groupToolReasoningRunsChange', handleGroupRunsEvent)
    window.addEventListener('storage', handleStorageEvent)

    return () => {
      window.removeEventListener('groupToolReasoningRunsChange', handleGroupRunsEvent)
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

    const handleAutoCompactionEnabledEvent = (e: Event) => {
      const detail = (e as CustomEvent<boolean>).detail
      if (typeof detail === 'boolean') {
        setAutoCompactionEnabled(detail)
      }
    }

    const handleStorageEvent = (e: StorageEvent) => {
      if (e.key === 'chat:showTokenUsageBar' && e.newValue !== null) {
        setShowTokenUsageBar(e.newValue === 'true')
      }

      if (e.key === CHAT_UI_AUTO_COMPACTION_ENABLED_KEY && e.newValue !== null) {
        setAutoCompactionEnabled(e.newValue === 'true')
      }
    }

    window.addEventListener(
      CHAT_UI_TOKEN_USAGE_VISIBILITY_CHANGE_EVENT,
      handleTokenUsageVisibilityEvent as EventListener
    )
    window.addEventListener(
      CHAT_UI_AUTO_COMPACTION_ENABLED_CHANGE_EVENT,
      handleAutoCompactionEnabledEvent as EventListener
    )
    window.addEventListener('storage', handleStorageEvent)

    return () => {
      window.removeEventListener(
        CHAT_UI_TOKEN_USAGE_VISIBILITY_CHANGE_EVENT,
        handleTokenUsageVisibilityEvent as EventListener
      )
      window.removeEventListener(
        CHAT_UI_AUTO_COMPACTION_ENABLED_CHANGE_EVENT,
        handleAutoCompactionEnabledEvent as EventListener
      )
      window.removeEventListener('storage', handleStorageEvent)
    }
  }, [])

  // Send button animation settings (synced from SettingsPane via custom event + localStorage)
  const [sendButtonAnimation, setSendButtonAnimation] = useState<SendButtonAnimationType>(getStoredSendButtonAnimation)
  const [sendButtonColor, setSendButtonColor] = useState<string>(getStoredSendButtonColor)

  // Streaming animation settings (shown below the live assistant message while content is streaming)
  const [streamingAnimation, setStreamingAnimation] = useState<StreamingAnimationType>(getStoredStreamingAnimation)
  const [streamingAnimationLightColor, setStreamingAnimationLightColor] = useState<string>(getStoredStreamingLightColor)
  const [streamingAnimationDarkColor, setStreamingAnimationDarkColor] = useState<string>(getStoredStreamingDarkColor)
  const [streamingAnimationSpeed, setStreamingAnimationSpeed] = useState<number>(getStoredStreamingSpeed)

  useEffect(() => {
    const handleSendButtonAnimationEvent = (e: Event) => {
      const detail = (e as CustomEvent<SendButtonAnimationType>).detail
      if (detail) setSendButtonAnimation(detail)
    }
    const handleSendButtonColorEvent = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail
      if (detail) setSendButtonColor(detail)
    }
    const handleStreamingAnimationEvent = (e: Event) => {
      const detail = (e as CustomEvent<StreamingAnimationType>).detail
      if (detail) setStreamingAnimation(detail)
    }
    const handleStreamingLightColorEvent = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail
      if (detail) setStreamingAnimationLightColor(detail)
    }
    const handleStreamingDarkColorEvent = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail
      if (detail) setStreamingAnimationDarkColor(detail)
    }
    const handleStreamingSpeedEvent = (e: Event) => {
      const detail = (e as CustomEvent<number>).detail
      if (Number.isFinite(detail)) setStreamingAnimationSpeed(detail)
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
      if (e.key === 'chat:sendButtonColor' && e.newValue) {
        setSendButtonColor(e.newValue)
      }
      if (e.key === 'chat:streamingAnimation' && e.newValue) {
        setStreamingAnimation(e.newValue as StreamingAnimationType)
      }
      if (e.key === 'chat:streamingAnimationColor' && e.newValue) {
        setStreamingAnimationLightColor(e.newValue)
        setStreamingAnimationDarkColor(e.newValue)
      }
      if (e.key === 'chat:streamingAnimationLightColor' && e.newValue) {
        setStreamingAnimationLightColor(e.newValue)
      }
      if (e.key === 'chat:streamingAnimationDarkColor' && e.newValue) {
        setStreamingAnimationDarkColor(e.newValue)
      }
      if (e.key === 'chat:streamingAnimationSpeed' && e.newValue) {
        const nextSpeed = Number.parseFloat(e.newValue)
        if (Number.isFinite(nextSpeed)) {
          setStreamingAnimationSpeed(nextSpeed)
        }
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
    window.addEventListener('sendButtonColorChange', handleSendButtonColorEvent)
    window.addEventListener('streamingAnimationChange', handleStreamingAnimationEvent)
    window.addEventListener('streamingAnimationColorChange', handleStreamingLightColorEvent)
    window.addEventListener('streamingAnimationLightColorChange', handleStreamingLightColorEvent)
    window.addEventListener('streamingAnimationDarkColorChange', handleStreamingDarkColorEvent)
    window.addEventListener('streamingAnimationSpeedChange', handleStreamingSpeedEvent)
    window.addEventListener('inputBorderAnimationChange', handleInputBorderAnimationEvent)
    window.addEventListener('inputBorderLightColorChange', handleInputBorderLightColorEvent)
    window.addEventListener('inputBorderDarkColorChange', handleInputBorderDarkColorEvent)
    window.addEventListener('storage', handleStorageEvent)

    return () => {
      window.removeEventListener('sendButtonAnimationChange', handleSendButtonAnimationEvent)
      window.removeEventListener('sendButtonColorChange', handleSendButtonColorEvent)
      window.removeEventListener('streamingAnimationChange', handleStreamingAnimationEvent)
      window.removeEventListener('streamingAnimationColorChange', handleStreamingLightColorEvent)
      window.removeEventListener('streamingAnimationLightColorChange', handleStreamingLightColorEvent)
      window.removeEventListener('streamingAnimationDarkColorChange', handleStreamingDarkColorEvent)
      window.removeEventListener('streamingAnimationSpeedChange', handleStreamingSpeedEvent)
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
  }, [isResizing])

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
        const loadedCwd = typeof localConversation?.cwd === 'string' ? localConversation.cwd : ''
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
  }, [currentConversationId, setCcCwdFromSystem])

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

  // Cleanup any pending rAF on unmount
  useEffect(() => {
    return () => {
      if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current)
    }
  }, [])

  useEffect(() => {
    streamActiveRef.current = streamState.active
  }, [streamState.active])

  // Listen for user scrolls; while streaming, toggle override based on proximity to bottom
  useEffect(() => {
    const el = messagesContainerRef.current
    if (!el) return

    const onScroll = (e: Event) => {
      if (!e.isTrusted || !streamActiveRef.current) return
      const nearBottom = isNearBottom(el, NEAR_BOTTOM_PX)
      // If the user is near the bottom, allow auto-pinning; otherwise, suppress it
      userScrolledDuringStreamRef.current = !nearBottom
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
    }
  }, [])

  // Reset the user scroll override when the stream finishes
  useEffect(() => {
    if (streamState.finished) {
      userScrolledDuringStreamRef.current = false
      if (scrollRafRef.current != null) {
        cancelAnimationFrame(scrollRafRef.current)
        scrollRafRef.current = null
      }
    }
  }, [streamState.finished])

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

  // Scroll to show new message at top when stream starts (normal mode only)
  // DISABLED: Auto-scroll temporarily disabled
  // useEffect(() => {
  //   if (streamState.active && !hermesMode) {
  //     // Scroll to position new message at top of viewport
  //     // setTimeout(() => {
  //     //   scrollToShowLatestAtTop('smooth')
  //     // }, 450)
  //     scrollToShowLatestAtTop('smooth')
  //   }
  // }, [streamState.active, hermesMode, scrollToShowLatestAtTop])

  // Scroll to selected node when path changes (only for user-initiated selections)
  useEffect(() => {
    if (selectionScrollCauseRef.current === 'user' && selectedPath && selectedPath.length > 0) {
      const targetId = focusedChatMessageId
      // Find the index of the target message in filteredMessages for virtualizer
      const targetIndex = findMessageRowIndex(targetId)

      if (targetIndex !== -1) {
        // Use virtualizer to scroll to the message index
        scrollToMessageRowIndex(targetIndex, 'start')

        // Record that we've scrolled to this focused target to avoid later auto-scrolls fighting it
        if (typeof targetId === 'number') {
          lastFocusedScrollIdRef.current = targetId
        }
      }

      // After handling, reset so programmatic path changes (e.g., during send/stream) won't recenter
      selectionScrollCauseRef.current = null
    }
  }, [selectedPath, focusedChatMessageId, findMessageRowIndex, scrollToMessageRowIndex])

  // Scroll to the focused message when focus changes via hash/search (non user-click cases)
  useEffect(() => {
    // Skip if no focus or a user-initiated selection will handle scrolling
    if (focusedChatMessageId == null) return
    if (selectionScrollCauseRef.current === 'user') return

    // If we've already scrolled to this focused message, don't re-run on every list change
    if (lastFocusedScrollIdRef.current === focusedChatMessageId) return

    // If focus changed programmatically during streaming, temporarily disable bottom pinning
    if (streamState.active) {
      userScrolledDuringStreamRef.current = true
    }

    // Find the index of the target message in filteredMessages for virtualizer
    const targetIndex = findMessageRowIndex(focusedChatMessageId)

    if (targetIndex !== -1) {
      // Use virtualizer to scroll to the message index
      scrollToMessageRowIndex(targetIndex, 'start')
      // Mark this focus as handled so we don't keep re-centering on subsequent renders
      lastFocusedScrollIdRef.current = focusedChatMessageId
    }
  }, [focusedChatMessageId, findMessageRowIndex, scrollToMessageRowIndex, streamState.active])

  // Helper to check if a message should be excluded from visibility tracking
  // (tool-only or reasoning-only messages without meaningful text content)
  const isToolOrReasoningOnly = useCallback((msg: Message): boolean => {
    if (msg.role === 'tool') return true

    if (msg.content_blocks) {
      try {
        const blocks = typeof msg.content_blocks === 'string' ? JSON.parse(msg.content_blocks) : msg.content_blocks
        const arr = Array.isArray(blocks) ? blocks : [blocks]

        // Helper to check if a block has text content
        const hasTextContent = (b: any): boolean => {
          if (b.type === 'text' || b.type === 'image') return true
          if (b.type === 'thinking' && b.content && typeof b.content === 'string' && b.content.trim()) return true
          if (b.type === 'reasoning_details' && Array.isArray(b.reasoningDetails)) {
            return b.reasoningDetails.some((r: any) => r.text && typeof r.text === 'string' && r.text.trim())
          }
          if (b.type === 'tool_result' && b.content) {
            if (typeof b.content === 'string' && b.content.trim()) return true
            if (Array.isArray(b.content)) {
              return b.content.some((c: any) => c.type === 'text' && c.text && c.text.trim())
            }
          }
          return false
        }

        // Exclude only if no blocks have meaningful text content
        return arr.length > 0 && !arr.some(hasTextContent)
      } catch {
        return false
      }
    }
    return false
  }, [])

  const visibilityInputsRef = useRef<{
    filteredMessages: Message[]
    virtualRows: VirtualRenderRow[]
    isToolOrReasoningOnly: (msg: Message) => boolean
  }>({
    filteredMessages,
    virtualRows,
    isToolOrReasoningOnly,
  })

  useEffect(() => {
    visibilityInputsRef.current = {
      filteredMessages,
      virtualRows,
      isToolOrReasoningOnly,
    }
  }, [filteredMessages, virtualRows, isToolOrReasoningOnly])

  // Track the most visible message using virtualizer's virtual items on scroll
  // Since elements are virtualized, we compute visibility based on scroll position
  useEffect(() => {
    const container = messagesContainerRef.current
    if (!container) return

    const updateVisibleMessage = () => {
      const {
        filteredMessages: currentMessages,
        virtualRows: currentVirtualRows,
        isToolOrReasoningOnly: isExcluded,
      } = visibilityInputsRef.current
      const virtualItems = virtualizer.getVirtualItems()

      const findFirstAllowedMessage = (): MessageId | null => {
        for (const msg of currentMessages) {
          if (msg && !isExcluded(msg)) {
            return msg.id
          }
        }
        return null
      }

      const findLastAllowedMessage = (): MessageId | null => {
        for (let i = currentMessages.length - 1; i >= 0; i--) {
          const msg = currentMessages[i]
          if (msg && !isExcluded(msg)) {
            return msg.id
          }
        }
        return null
      }

      if (virtualItems.length === 0) {
        const fallback = findFirstAllowedMessage()
        if (fallback) {
          setVisibleMessageId(fallback)
        }
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
        if (!msg || isExcluded(msg)) continue

        const itemTop = item.start
        const itemBottom = item.start + item.size
        const topHalfEnd = adjustedScrollTop + viewportHeight * 0.5
        if (itemBottom < adjustedScrollTop || itemTop > topHalfEnd) continue

        if (!closestItem || item.start < closestItem.start) {
          closestItem = item
        }
      }

      if (!closestItem) {
        const fallback = findLastAllowedMessage()
        if (fallback) {
          setVisibleMessageId(fallback)
        }
        return
      }

      const closestVirtualRenderRow = currentVirtualRows[closestItem.index]
      if (closestVirtualRenderRow?.kind === 'message_row' && closestVirtualRenderRow.row.kind === 'message') {
        setVisibleMessageId(closestVirtualRenderRow.row.message.id)
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
  }, [filteredMessagesSignature, virtualRows])

  // If URL contains a #messageId fragment, capture it once
  // const location = useLocation() // Moved to top
  const hashMessageId = React.useMemo(() => {
    if (location.hash && location.hash.startsWith('#')) {
      const idNum = parseId(location.hash.substring(1))
      return typeof idNum === 'number' && isNaN(idNum) ? null : idNum
    }
    return null
  }, [location.hash])

  // When we have messages loaded and a hashMessageId, build path to that message and set it ONCE per hash.
  // This avoids resetting currentPath when the user switches branches after landing from a search result.
  useEffect(() => {
    // If hash cleared, allow future re-application when a new hash appears
    if (!hashMessageId) {
      hashAppliedRef.current = null
      return
    }
    // Skip if we've already applied this hash
    if (hashAppliedRef.current === hashMessageId) return

    if (conversationMessages.length > 0) {
      // Guard: only proceed if the target hash message exists
      const exists = conversationMessages.some(m => m.id === hashMessageId)
      if (!exists) return

      const path = buildBranchPathForMessage(conversationMessages, hashMessageId)
      if (!path.length) return

      dispatch(chatSliceActions.conversationPathSet(path))
      // Ensure the focused message id is set so scrolling targets the correct element
      dispatch(chatSliceActions.focusedChatMessageSet(hashMessageId))
      hashAppliedRef.current = hashMessageId
    }
  }, [hashMessageId, conversationMessages, dispatch])

  // Reset the hash application guard when switching conversations
  useEffect(() => {
    hashAppliedRef.current = null
    // Allow programmatic focus in the new conversation to scroll once
    lastFocusedScrollIdRef.current = null
  }, [currentConversationId])

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

  // useEffect(() => {
  //   if (focusedChatMessageId && conversationMessages.length > 0) {
  //     const path = getParentPath(conversationMessages, focusedChatMessageId)
  //     dispatch(chatSliceActions.conversationPathSet(path))
  //   }
  // }, [focusedChatMessageId, conversationMessages, dispatch])

  // Auto-select latest branch when messages first load
  useEffect(() => {
    if (conversationMessages.length > 0 && (!selectedPath || selectedPath.length === 0)) {
      // If URL has a hash message that exists, skip auto-selecting latest branch
      if (hashMessageId && conversationMessages.some(m => m.id === hashMessageId)) {
        return
      }
      // latest message by timestamp
      const latest = [...conversationMessages].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )[0]
      if (latest) {
        // Use buildBranchPathForMessage to get the complete path including leaf nodes
        const pathNums = buildBranchPathForMessage(conversationMessages, latest.id)
        if (pathNums.length) {
          // console.log(`path nums ${pathNums}`)
          dispatch(chatSliceActions.conversationPathSet(pathNums))
        }
      }
    }
  }, [conversationMessages, selectedPath, dispatch, hashMessageId])

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

  // Initialize or set conversation based on route param
  useEffect(() => {
    if (conversationIdFromUrl) {
      if (
        (typeof conversationIdFromUrl === 'number' && !isNaN(conversationIdFromUrl)) ||
        typeof conversationIdFromUrl === 'string'
      ) {
        dispatch(chatSliceActions.conversationSet(conversationIdFromUrl))
      }
    } else {
      dispatch(initializeUserAndConversation())
    }
  }, [conversationIdFromUrl, dispatch])

  // Handle model selection
  const handleModelSelect = useCallback(
    (modelName: string) => {
      const model = models.find(m => m.name === modelName)
      if (model) {
        selectModelMutation.mutate({ provider: providers.currentProvider, model })
      } else {
        console.warn('Selected model not found:', modelName)
      }
    },
    [models, selectModelMutation, providers.currentProvider, selectedModel?.name]
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
  const handleProviderSelect = useCallback(
    async (providerName: string) => {
      if (providerName === 'OpenRouter' && isCommunityMode) {
        setOpenRouterLoginRequiredModalOpen(true)
        return
      }

      // Check if OpenAI ChatGPT provider is selected and user is not authenticated
      if (providerName === 'OpenAI (ChatGPT)' && !isOpenAIAuthenticated()) {
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
      dispatch(chatSliceActions.providerSelected(providerName))
    },
    [dispatch]
  )

  const handleComposerSlashCommandSelect = useCallback(
    (command: string): ComposerSlashCommandResult | void => {
      const normalized = command.trim().toLowerCase().replace(/^\/+/, '')
      const isKnownSlashCommand =
        normalized === 'status-openai' ||
        normalized === 'compactify' ||
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

  // Local version of canSend that checks input controller state.
  const canSendLocal = useMemo(() => {
    const isNotSending = !streamState.active && !isCurrentConversationCompacting
    const hasModel = !!selectedModel

    // Allow retrigger: empty input when last displayed message is from user
    const isRetrigger =
      !hasLocalInput && displayMessages.length > 0 && displayMessages[displayMessages.length - 1]?.role === 'user'

    return (hasLocalInput || isRetrigger) && isNotSending && hasModel
  }, [hasLocalInput, isCurrentConversationCompacting, streamState.active, selectedModel, displayMessages])

  const handleSend = useCallback(
    (value: number) => {
      const localInputValue = getLocalInput()
      const trimmedInputValue = localInputValue.trim()
      const normalizedInput = trimmedInputValue.toLowerCase().replace(/^\/+/, '')
      const slashBenchAction = parseBenchAction(trimmedInputValue)
      const slashThemeDemoAction = parseThemeDemoAction(trimmedInputValue)
      const isKnownSlashCommand =
        normalizedInput === 'status-openai' ||
        normalizedInput === 'compactify' ||
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

      // Re-enable auto-pinning for Hermes mode sends until the user scrolls during this stream
      if (hermesMode) {
        userScrolledDuringStreamRef.current = false
      }
      if (canSendLocal && currentConversationId) {
        // Check if this is a retrigger scenario (empty input + last message is user)
        const isRetrigger =
          !hasLocalInput && displayMessages.length > 0 && displayMessages[displayMessages.length - 1]?.role === 'user'

        // Hermes mode routes messages to the local Hermes ACP endpoint.
        if (hermesMode && hermesModeAvailable) {
          const parent: MessageId | null = selectedPath.length > 0 ? selectedPath[selectedPath.length - 1] : null
          const lastHermesSessionId = findLastHermesSession(selectedPath)

          if (isRetrigger) {
            const lastUserMessage = displayMessages[displayMessages.length - 1]

            if (!lastUserMessage) {
              console.error('Cannot retrigger: No last user message found in displayMessages')
              return
            }

            const contentToRetrigger = lastUserMessage.content

            const streamId = generateStreamId('primary')
            setPendingViewStreamId(streamId)

            dispatch(
              sendHermesMessage({
                conversationId: currentConversationId,
                message: contentToRetrigger,
                cwd: ccCwd || undefined,
                model: selectedModel?.name,
                resume: true,
                parentId: parent,
                sessionId: lastHermesSessionId,
                streamId,
              })
            )
              .unwrap()
              .catch(error => {
                console.error('Failed to send Hermes retrigger message:', error)
              })
          } else {
            const processedContent = replaceFileMentionsWithPath(localInputValue)
            const contentWithIdeContext = appendIdeContextToMessage(processedContent)

            dispatch(chatSliceActions.inputChanged({ content: contentWithIdeContext }))
            clearLocalInput()

            const streamId = generateStreamId('primary')
            setPendingViewStreamId(streamId)

            dispatch(
              sendHermesMessage({
                conversationId: currentConversationId,
                message: contentWithIdeContext,
                cwd: ccCwd || undefined,
                model: selectedModel?.name,
                resume: true,
                parentId: parent,
                sessionId: lastHermesSessionId,
                streamId,
              })
            )
              .unwrap()
              .then(() => {
                setAddedIdeContexts([])
              })
              .catch(error => {
                console.error('Failed to send Hermes message:', error)
              })
          }
        } else {
          // Regular model send (non-Hermes mode)
          if (isRetrigger) {
            // Retrigger: Use the last user message's content and parent
            const lastUserMessage = displayMessages[displayMessages.length - 1]

            // Safety check: ensure lastUserMessage exists before accessing properties
            if (!lastUserMessage) {
              console.error('Cannot retrigger: No last user message found in displayMessages')
              return
            }

            const parent: MessageId | null = lastUserMessage.parent_id || null
            const contentToRetrigger = lastUserMessage.content
            const { content: retriggerContent, pendingCwdValue } = withPendingCwdAnnouncement(
              currentConversationId,
              contentToRetrigger
            )

            // Dispatch sendMessage with retrigger flag
            const streamId = generateStreamId('primary')
            setPendingViewStreamId(streamId)

            dispatch(
              sendMessage({
                conversationId: currentConversationId,
                input: { content: retriggerContent },
                parent,
                repeatNum: value,
                think: think,
                retrigger: true,
                imageConfig: isImageGenerationModel ? imageConfig : undefined,
                reasoningConfig: think ? reasoningConfig : undefined,
                cwd: ccCwd || undefined,
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
                console.error('Failed to retrigger generation:', error)
              })
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
                if (message?.role === 'system' && message?.note === AUTO_COMPACTION_NOTE) {
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
              const { content: contentToSend, pendingCwdValue } = withPendingCwdAnnouncement(
                currentConversationId,
                contentWithIdeContext
              )

              // Update Redux state with processed content before sending
              dispatch(chatSliceActions.inputChanged({ content: contentToSend }))

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
                artifacts: [],
              }
              dispatch(chatSliceActions.optimisticMessageSet(optimisticUserMessage))

              // Use processed content for immediate send
              const inputToSend = { content: contentToSend }
              // Clear local input immediately after sending
              clearLocalInput()

              // Dispatch a single sendMessage with repeatNum set to value.
              const streamId = generateStreamId('primary')
              setPendingViewStreamId(streamId)

              dispatch(
                sendMessage({
                  conversationId: currentConversationId,
                  input: inputToSend,
                  parent: parentForSend,
                  repeatNum: value,
                  think: think,
                  imageConfig: isImageGenerationModel ? imageConfig : undefined,
                  reasoningConfig: think ? reasoningConfig : undefined,
                  cwd: ccCwd || undefined,
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
                })
            }

            void (async () => {
              const safeEstimateTokenCount = (value: unknown): number => {
                if (value == null) return 0
                if (typeof value === 'string') {
                  return value.length > 0 ? estimateTokenCount(value) : 0
                }

                try {
                  const serialized = JSON.stringify(value)
                  return serialized ? estimateTokenCount(serialized) : 0
                } catch {
                  return 0
                }
              }

              const usageStartIndex = latestCompaction.index >= 0 ? latestCompaction.index : 0
              const usageMessages = displayMessages.slice(usageStartIndex)
              const compactionSourceMessages = (
                latestCompaction.index >= 0 ? displayMessages.slice(latestCompaction.index + 1) : displayMessages
              ).filter(Boolean)

              let promptAndContextTokens = 0
              promptAndContextTokens += safeEstimateTokenCount(selectedProject?.system_prompt)
              promptAndContextTokens += safeEstimateTokenCount(selectedProject?.context)
              promptAndContextTokens += safeEstimateTokenCount(currentConversation?.system_prompt)
              promptAndContextTokens += safeEstimateTokenCount(currentConversation?.conversation_context)

              let messageTokens = 0
              usageMessages.forEach(message => {
                if (!message) return
                messageTokens += safeEstimateTokenCount(message.content)
                messageTokens += safeEstimateTokenCount((message as any).content_blocks)
                messageTokens += safeEstimateTokenCount((message as any).tool_calls)
              })

              const totalContextTokens = promptAndContextTokens + messageTokens
              const usdValue = (currentUser?.cached_current_credits ?? 0) / 100
              const totalContextLimit = selectedModel?.contextLength || 128_000
              const promptCostPer1K = selectedModel?.promptCost ?? 0
              const completionCostPer1K = selectedModel?.completionCost ?? 0

              let creditInputLimit = Infinity
              let creditOutputLimit = Infinity
              if (promptCostPer1K > 0) {
                creditInputLimit = Math.floor((usdValue * 1000) / promptCostPer1K)
              }
              if (completionCostPer1K > 0) {
                creditOutputLimit = Math.floor((usdValue * 1000) / completionCostPer1K)
              }

              const totalBudget = Math.max(0, Math.min(totalContextLimit, creditInputLimit, creditOutputLimit))
              const totalContextProgress = totalBudget > 0 ? Math.min((totalContextTokens / totalBudget) * 100, 100) : 0
              const modelContextProgress =
                totalContextLimit > 0 ? Math.min((totalContextTokens / totalContextLimit) * 100, 100) : 0

              const lastMessage = displayMessages[displayMessages.length - 1]
              const shouldAutoCompact =
                autoCompactionEnabled &&
                totalContextLimit > 0 &&
                (modelContextProgress >= 85 || totalContextProgress >= 85) &&
                Boolean(lastMessage) &&
                lastMessage?.note !== AUTO_COMPACTION_NOTE &&
                compactionSourceMessages.length >= 2 &&
                !autoCompactionInFlightRef.current

              if (shouldAutoCompact && lastMessage) {
                autoCompactionInFlightRef.current = true

                try {
                  const compactionResult = await dispatch(
                    compactBranch({
                      conversationId: currentConversationId,
                      parentMessageId: lastMessage.id,
                      messages: compactionSourceMessages,
                      providerName: providerSettings.compactionProvider || providers.currentProvider,
                      modelName: providerSettings.compactionModel || selectedModel?.name || null,
                    })
                  ).unwrap()

                  const compactedMessage = compactionResult?.message ?? null
                  const hasValidCompactionMarker =
                    compactedMessage?.role === 'system' &&
                    compactedMessage?.note === AUTO_COMPACTION_NOTE &&
                    String(compactedMessage?.parent_id ?? '') === String(lastMessage.id)

                  console.log('[AutoCompaction][send] compactBranch result', {
                    messageId: compactedMessage?.id ?? null,
                    role: compactedMessage?.role ?? null,
                    note: compactedMessage?.note ?? null,
                    parentId: compactedMessage?.parent_id ?? null,
                    hasValidCompactionMarker,
                  })

                  if (!compactedMessage || !hasValidCompactionMarker) {
                    console.error('[AutoCompaction][send] invalid attached summary message. Send aborted.')
                    return
                  }

                  effectiveParent = compactedMessage.id
                } catch (error) {
                  console.error('[AutoCompaction][send] compactBranch failed. Send aborted:', error)
                  return
                } finally {
                  autoCompactionInFlightRef.current = false
                }
              } else {
                console.log('[AutoCompaction][send] skip compactBranch', {
                  reason: {
                    disabledInSettings: !autoCompactionEnabled,
                    noContextLimit: totalContextLimit <= 0,
                    belowThreshold: modelContextProgress < 85 && totalContextProgress < 85,
                    missingLastMessage: !lastMessage,
                    lastIsCompaction: lastMessage?.note === AUTO_COMPACTION_NOTE,
                    tooFewSourceMessages: compactionSourceMessages.length < 2,
                    inFlight: autoCompactionInFlightRef.current,
                  },
                })
              }
              sendWithParent(effectiveParent)
            })()
          }
        }
      } else if (!currentConversationId) {
        console.error('📤 No conversation ID available')
      }
    },
    [
      canSendLocal,
      currentConversationId,
      selectedPath,
      think,
      dispatch,
      getLocalInput,
      hasLocalInput,
      isCurrentConversationCompacting,
      sendingState.sending,
      sendingState.compacting,
      clearLocalInput,
      displayMessages,
      replaceFileMentionsWithPath,
      appendIdeContextToMessage,
      scrollToBottomNow,
      selectedModel,
      hermesMode,
      ccCwd,
      hermesModeAvailable,
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
      findLastHermesSession,
      withPendingCwdAnnouncement,
      clearPendingCwdAnnouncement,
      runComposerCommand,
    ]
  )

  const handleStopGeneration = useCallback(() => {
    if (!streamState.id && !streamState.streamingMessageId) return

    dispatch(
      abortGeneration({
        streamId: streamState.id,
        messageId: streamState.streamingMessageId,
      })
    )
  }, [streamState.id, streamState.streamingMessageId, dispatch])

  const submitMessageAsBranch = useCallback(
    (id: string, newContent: string, _newContentBlocks?: any) => {
      if (!currentConversationId) return

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
        return
      }

      const branchParentId =
        originalMessage.role === 'assistant' || originalMessage.role === 'ex_agent'
          ? originalMessage.id
          : (originalMessage.parent_id ?? null)

      if (hermesMode && hermesModeAvailable) {
        const branchSourceSessionId = findNearestHermesSessionFromMessage(branchParentId)
        const streamId = generateStreamId('branch')
        setPendingViewStreamId(streamId)

        dispatch(
          sendHermesMessage({
            conversationId: currentConversationId,
            message: contentWithCwdAnnouncement,
            cwd: ccCwd || undefined,
            model: selectedModel?.name,
            resume: branchSourceSessionId ? true : false,
            parentId: branchParentId,
            sessionId: branchSourceSessionId,
            forkSession: Boolean(branchSourceSessionId),
            streamId,
          })
        )
          .unwrap()
          .then(() => {
            clearPendingCwdAnnouncement(currentConversationId, pendingCwdValue)
            dispatch(chatSliceActions.messageArtifactsBackupCleared({ messageId: parsedId }))
          })
          .catch(error => {
            console.error('Failed to send Hermes branch session:', error)
          })

        return
      }

      // Regular message branching logic (non-Hermes mode)
      // Keep artifacts so pasted images do not flicker away during branch send.
      const optimisticArtifacts = Array.isArray(originalMessage.artifacts) ? originalMessage.artifacts : []
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
      setPendingViewStreamId(streamId)

      dispatch(
        editMessageWithBranching({
          conversationId: currentConversationId,
          originalMessageId: parsedId,
          newContent: contentWithCwdAnnouncement,
          modelOverride: selectedModel?.name,
          think: think,
          cwd: ccCwd || undefined,
          streamId,
        })
      )
        .unwrap()
        .then(() => {
          clearPendingCwdAnnouncement(currentConversationId, pendingCwdValue)
          dispatch(chatSliceActions.messageArtifactsBackupCleared({ messageId: parsedId }))
          // Invalidate React Query cache after successful branch to fetch new messages.
          // Note: messages query now includes tree data, so only one invalidation is needed.
          queryClient.invalidateQueries({
            queryKey: ['conversations', currentConversationId, 'messages'],
            refetchType: 'active',
          })
        })
        .catch(error => {
          // Clear optimistic branch message on error
          dispatch(chatSliceActions.optimisticBranchMessageCleared())
          console.error('Failed to branch message:', error)
        })
    },
    [
      currentConversationId,
      selectedModel?.name,
      think,
      hermesMode,
      ccCwd,
      hermesModeAvailable,
      dispatch,
      replaceFileMentionsWithPath,
      appendIdeContextToMessage,
      conversationMessages,
      queryClient,
      withPendingCwdAnnouncement,
      clearPendingCwdAnnouncement,
      findNearestHermesSessionFromMessage,
    ]
  )

  const handleMessageEdit = useCallback(
    (id: string, newContent: string, newContentBlocks?: any) => {
      submitMessageAsBranch(id, newContent, newContentBlocks)
    },
    [submitMessageAsBranch]
  )

  const handleMessageBranch = useCallback(
    (id: string, newContent: string, newContentBlocks?: any) => {
      submitMessageAsBranch(id, newContent, newContentBlocks)
    },
    [submitMessageAsBranch]
  )

  const handleExplainFromSelection = useCallback(
    (id: string, newContent: string) => {
      if (currentConversationId) {
        // Replace any @file mentions with actual file contents before branching
        const processed = replaceFileMentionsWithPath(newContent)
        const contentWithIdeContext = appendIdeContextToMessage(processed)
        // console.log(processed)

        // Find the message to check if it has children
        const parsedId = parseId(id)
        const originalMessage = conversationMessages.find(m => m.id === parsedId)
        const { content: contentWithCwdAnnouncement, pendingCwdValue } = withPendingCwdAnnouncement(
          currentConversationId,
          contentWithIdeContext
        )

        if (!originalMessage) {
          console.error('Message not found:', id)
          return
        }

        // Check if message has children
        const hasChildren = originalMessage.children_ids && originalMessage.children_ids.length > 0

        if (!hasChildren) {
          // No children: send a new message with this message as parent (linear continuation)
          // Create optimistic message for instant UI feedback
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

          // Send as a regular message with the selected message as parent
          const streamId = generateStreamId('primary')
          setPendingViewStreamId(streamId)

          dispatch(
            sendMessage({
              conversationId: currentConversationId,
              input: { content: contentWithCwdAnnouncement },
              parent: parsedId,
              repeatNum: 1,
              think: think,
              imageConfig: isImageGenerationModel ? imageConfig : undefined,
              reasoningConfig: think ? reasoningConfig : undefined,
              cwd: ccCwd || undefined,
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
              // Clear optimistic message on error
              dispatch(chatSliceActions.optimisticMessageCleared())
              console.error('Failed to send message:', error)
            })
        } else {
          // Has children: create a branch (same as branch button behavior)
          // Create optimistic branch message for instant UI feedback.
          // Keep artifacts so pasted images do not flicker away during branch send.
          const optimisticArtifacts = Array.isArray(originalMessage.artifacts) ? originalMessage.artifacts : []
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
          setPendingViewStreamId(streamId)

          dispatch(
            editMessageWithBranching({
              conversationId: currentConversationId,
              originalMessageId: parsedId,
              newContent: contentWithCwdAnnouncement,
              modelOverride: selectedModel?.name,
              think: think,
              cwd: ccCwd || undefined,
              streamId,
            })
          )
            .unwrap()
            .then(() => {
              clearPendingCwdAnnouncement(currentConversationId, pendingCwdValue)
              dispatch(chatSliceActions.messageArtifactsBackupCleared({ messageId: parsedId }))
              // Invalidate React Query cache after successful branch to fetch new messages
              queryClient.invalidateQueries({
                queryKey: ['conversations', currentConversationId, 'messages'],
                refetchType: 'active',
              })
            })
            .catch(error => {
              // Clear optimistic branch message on error
              dispatch(chatSliceActions.optimisticBranchMessageCleared())
              console.error('Failed to branch message:', error)
            })
        }
      }
    },
    [
      currentConversationId,
      selectedModel?.name,
      think,
      dispatch,
      replaceFileMentionsWithPath,
      appendIdeContextToMessage,
      conversationMessages,
      queryClient,
      ccCwd,
      isImageGenerationModel,
      imageConfig,
      withPendingCwdAnnouncement,
      clearPendingCwdAnnouncement,
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
      if (!nodeId || !path || path.length === 0) return // ignore clicks on empty space

      const parsedNodeId = parseId(nodeId)
      const isValidNodeId =
        typeof parsedNodeId === 'string' || (typeof parsedNodeId === 'number' && !Number.isNaN(parsedNodeId))
      if (!isValidNodeId) return

      const parsedPath = path
        .map(id => parseId(id))
        .filter(id => typeof id === 'string' || (typeof id === 'number' && !Number.isNaN(id)))

      if (parsedPath.length === 0) return

      const samePath =
        selectedPath.length === parsedPath.length &&
        selectedPath.every((id, index) => String(id) === String(parsedPath[index]))
      const sameFocus = focusedChatMessageId != null && String(focusedChatMessageId) === String(parsedNodeId)

      if (samePath && sameFocus) {
        // Re-clicking the same already-focused node should still re-scroll to it.
        if (streamState.active) {
          userScrolledDuringStreamRef.current = true
        }
        const targetIndex = findMessageRowIndex(parsedNodeId)
        if (targetIndex !== -1) {
          scrollToMessageRowIndex(targetIndex, 'start')
          lastFocusedScrollIdRef.current = parsedNodeId
        }
        return
      }

      // Only trigger scroll if clicking a different node than currently visible
      // This allows re-scrolling after manual navigation, but prevents redundant scrolls
      if (String(parsedNodeId) !== String(visibleMessageId)) {
        // Mark this selection as user-initiated so the scroll-to-selection effect may run
        selectionScrollCauseRef.current = 'user'
      }

      // Treat user selection during streaming as an override to bottom pinning
      if (streamState.active) {
        userScrolledDuringStreamRef.current = true
      }

      React.startTransition(() => {
        batch(() => {
          if (!samePath) {
            // User explicitly switched branches. Drop the local pending-stream fallback so
            // another branch can be interacted with independently while a different
            // branch keeps streaming in the background.
            setPendingViewStreamId(null)
            dispatch(chatSliceActions.conversationPathSet(parsedPath))
          }
          if (!sameFocus) {
            dispatch(chatSliceActions.focusedChatMessageSet(parsedNodeId))
          }
        })
      })
    },
    [
      dispatch,
      focusedChatMessageId,
      selectedPath,
      streamState.active,
      visibleMessageId,
      findMessageRowIndex,
      scrollToMessageRowIndex,
    ]
  )

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
        await queryClient.invalidateQueries({
          queryKey: ['conversations', currentConversationId, 'messages'],
        })
        await queryClient.refetchQueries({
          queryKey: ['conversations', currentConversationId, 'messages'],
          type: 'active',
        })
      }
    },
    [dispatch, currentConversationId, conversationStorageMode, queryClient]
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
  }

  const handleOpenaiLogin = async () => {
    if (!openaiAuthFlow) return

    // Open the authorization URL in the default browser
    if (window.electronAPI?.auth?.openExternal) {
      try {
        await window.electronAPI.auth.openExternal(openaiAuthFlow.url)
      } catch (error) {
        console.error('Failed to open browser:', error)
        setOpenaiAuthError('Failed to open browser. Please copy the URL manually.')
      }
    } else {
      // Fallback: open in new tab (web mode, though this provider is Electron-only)
      window.open(openaiAuthFlow.url, '_blank')
    }
  }

  const handleOpenaiAuthCallback = async () => {
    if (!openaiAuthFlow) return

    setOpenaiAuthLoading(true)
    setOpenaiAuthError(null)

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
      }>('/openai/auth/complete', { state: openaiAuthFlow.state })

      if (data.pending) {
        setOpenaiAuthError('Please complete the sign-in in your browser first, then click this button again.')
        setOpenaiAuthLoading(false)
        return
      }

      if (!data.success) {
        setOpenaiAuthError(data.error || 'Authentication failed. Please try again.')
        setOpenaiAuthLoading(false)
        return
      }

      // Save tokens to localStorage using the openaiOAuth module
      const tokens = {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: data.expiresAt,
        accountId: data.accountId,
      }
      saveTokens(tokens)

      // Successfully authenticated, select the provider
      dispatch(chatSliceActions.providerSelected('OpenAI (ChatGPT)'))
      closeOpenaiLoginModal()
    } catch (error) {
      console.error('OpenAI auth callback error:', error)
      setOpenaiAuthError('Authentication failed. Please try again.')
    } finally {
      setOpenaiAuthLoading(false)
    }
  }

  const handleOpenaiLogout = () => {
    clearOpenAITokens()
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

      if (imageFiles.length > 0) {
        Promise.all(
          imageFiles.map(async image => {
            const dataUrl = await blobToDataURL(image)
            return { dataUrl, name: image.name, type: image.type, size: image.size }
          })
        )
          .then(drafts => {
            dispatch(chatSliceActions.imageDraftsAppended(drafts))

            // During branch editing, always attach previews to the actively edited message.
            const targetMessageId =
              activeBranchEditingMessageId != null ? parseId(activeBranchEditingMessageId) : focusedChatMessageId

            if (targetMessageId != null) {
              dispatch(
                chatSliceActions.messageArtifactsAppended({
                  messageId: targetMessageId,
                  artifacts: drafts.map(d => d.dataUrl),
                })
              )
            }
          })
          .catch(err => console.error('Failed to read selected images', err))
      }

      e.target.value = ''
    },
    [dispatch, focusedChatMessageId, activeBranchEditingMessageId, updateLocalInput, focusLocalInput]
  )

  // const handleMultiReplyCountChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
  //   const value = e.target.value
  //   if (value === '' || !isNaN(Number(value))) {
  //     dispatch(chatActions.multiReplyCountSet(Number(value)))
  //   }
  // }

  // Clone conversation
  const handleCloneConversation = useCallback(async () => {
    if (!currentConversationId) return

    setCloningConversation(true)
    setOptionsOpen(false)

    try {
      const result = await cloneConversation(currentConversationId, accessToken)
      // Invalidate React Query cache to refetch conversations list
      // This updates the dropdown and sidebar without duplicate API calls
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      // Navigate to the cloned conversation
      navigate(`/chat/${result.project_id || projectIdFromUrl || 'unknown'}/${result.id}`)
    } catch (error) {
      console.error('Failed to clone conversation:', error)
      // Could add error toast/notification here
    } finally {
      setCloningConversation(false)
    }
  }, [currentConversationId, accessToken, navigate, queryClient])

  const handleOpenToolHtmlModal = useCallback(
    (key?: string) => {
      htmlRegistry?.openModal(key)
    },
    [htmlRegistry]
  )
  const canOpenHtmlTools = Boolean(htmlRegistry)
  const openToolHtmlModal = canOpenHtmlTools ? handleOpenToolHtmlModal : undefined

  // Refresh models using React Query mutation
  // const handleRefreshModels = useCallback(() => {
  //   if (providers.currentProvider) {
  //     refreshModelsMutation.mutate(providers.currentProvider)
  //   }
  // }, [providers.currentProvider, refreshModelsMutation])

  // Helper: Parse todo items from markdown content
  const TODO_ITEM_REGEX = /^\s*[-*]\s*\[(x|X| )\]\s*(.*)$/
  const parseTodoItems = (markdownContent: string): { text: string; done: boolean }[] => {
    const items: { text: string; done: boolean }[] = []
    const lines = markdownContent.split('\n')
    for (const line of lines) {
      const match = TODO_ITEM_REGEX.exec(line)
      if (match) {
        items.push({
          done: match[1].toLowerCase() === 'x',
          text: match[2].trim(),
        })
      }
    }
    return items
  }

  // Extract the most recent todo_list tool result from displayMessages
  // This finds the latest tool_use block for 'todo_list' and its corresponding result
  const latestTodoList = useMemo(() => {
    // Iterate from most recent to oldest
    for (let i = displayMessages.length - 1; i >= 0; i--) {
      const msg = displayMessages[i]
      if ((msg.role === 'assistant' || msg.role === 'ex_agent') && msg.content_blocks) {
        let blocks: ContentBlock[] = []
        try {
          if (typeof msg.content_blocks === 'object') {
            blocks = Array.isArray(msg.content_blocks) ? msg.content_blocks : [msg.content_blocks]
          } else if (typeof msg.content_blocks === 'string') {
            const parsed = JSON.parse(msg.content_blocks)
            blocks = Array.isArray(parsed) ? parsed : [parsed]
          }
        } catch {
          continue
        }

        // Look for tool_use blocks for todo_list and find corresponding tool_result
        for (const block of blocks) {
          if (block.type === 'tool_use' && (block as any).name === 'todo_list') {
            const toolUseBlock = block as any
            // Find the corresponding tool_result
            const resultBlock = blocks.find(
              b => b.type === 'tool_result' && (b as any).tool_use_id === toolUseBlock.id
            ) as any
            if (resultBlock && !resultBlock.is_error) {
              const action = toolUseBlock.input?.action
              if (action === 'create' || action === 'read' || action === 'edit') {
                // Parse the result content to extract the markdown content
                let resultData: any = resultBlock.content

                // If content is a string, try to parse it as JSON
                if (typeof resultData === 'string') {
                  try {
                    resultData = JSON.parse(resultData)
                  } catch {
                    // If parsing fails, use the string as-is (might be raw markdown)
                  }
                }

                // Extract the markdown content from the result object
                let markdownContent = ''
                if (typeof resultData === 'object' && resultData !== null && 'content' in resultData) {
                  markdownContent = resultData.content || ''
                } else if (typeof resultData === 'string') {
                  markdownContent = resultData
                }

                // Parse the markdown into todo items
                const items = parseTodoItems(markdownContent)

                // Only return if there are actual todo items
                if (items.length > 0) {
                  return {
                    name: resultData?.name || toolUseBlock.input?.name || 'Todo List',
                    action,
                    items,
                    messageId: msg.id,
                  }
                }
              }
            }
          }
        }
      }
    }
    return null
  }, [displayMessages])

  const branchFileMutationData = useMemo(() => extractBranchFileMutations(displayMessages), [displayMessages])
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
  const tokenUsage = useMemo(() => {
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

    let promptAndContextTokens = 0
    let messageTokens = 0

    // Include project system prompt and context.
    promptAndContextTokens += safeEstimateTokenCount(selectedProject?.system_prompt)
    promptAndContextTokens += safeEstimateTokenCount(selectedProject?.context)

    // Include conversation system prompt and context.
    promptAndContextTokens += safeEstimateTokenCount(currentConversation?.system_prompt)
    promptAndContextTokens += safeEstimateTokenCount(currentConversation?.conversation_context)

    // Count visible branch payload from the latest compaction marker (if any) onward.
    let startIndex = 0
    for (let i = displayMessages.length - 1; i >= 0; i--) {
      if (displayMessages[i]?.note === AUTO_COMPACTION_NOTE) {
        startIndex = i
        break
      }
    }

    displayMessages.slice(startIndex).forEach(msg => {
      if (!msg) return

      const contentTokens = safeEstimateTokenCount(msg.content)
      const contentBlockTokens = safeEstimateTokenCount((msg as any).content_blocks)
      const toolCallTokens = safeEstimateTokenCount((msg as any).tool_calls)

      // This ensures messages with empty content but non-empty content_blocks/tool_calls are counted.
      messageTokens += contentTokens + contentBlockTokens + toolCallTokens
    })

    return {
      promptAndContextTokens,
      messageTokens,
      totalContextTokens: promptAndContextTokens + messageTokens,
    }
  }, [
    displayMessages,
    selectedProject?.system_prompt,
    selectedProject?.context,
    currentConversation?.system_prompt,
    currentConversation?.conversation_context,
  ])

  // Calculate total context budget (single combined budget for easier interpretation).
  const tokenLimits = useMemo(() => {
    const usdValue = current_credits / 100 // Convert credits to USD

    // Model context limit.
    const totalContextLimit = selectedModel?.contextLength || 128_000

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
  }, [selectedModel?.promptCost, selectedModel?.completionCost, selectedModel?.contextLength, current_credits])

  // Calculate progress percentages.
  const totalContextProgress =
    tokenLimits.totalBudget > 0 ? Math.min((tokenUsage.totalContextTokens / tokenLimits.totalBudget) * 100, 100) : 0
  // Auto-compaction now runs as part of the explicit user send flow (handleSend),
  // so we intentionally avoid passive threshold-triggered compaction effects here.

  // Handler to refresh user credits
  const handleRefreshCredits = useCallback(async () => {
    if (!userId || !accessToken || isRefreshingCredits) return
    setIsRefreshingCredits(true)
    try {
      await dispatch(refreshUserCredits({ userId, accessToken })).unwrap()
    } catch (error) {
      console.error('Failed to refresh credits:', error)
    } finally {
      setIsRefreshingCredits(false)
    }
  }, [dispatch, userId, accessToken, isRefreshingCredits])

  return (
    <motion.div
      initial={{ opacity: 0, x: 10 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -10 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      ref={containerRef}
      className='flex h-full overflow-hidden bg-transparent dark:bg-transparent'
    >
      <div
        className={`relative flex flex-col ${heimdallVisible && !isMobile ? 'flex-none' : 'flex-1'} rounded-xl mb-2 min-w-0 bg-transparent sm:min-w-[240px] md:min-w-[280px]  overflow-hidden`}
        style={{
          width: isMobile ? '100%' : heimdallVisible ? `${leftWidthPct}%` : 'auto',
          backgroundColor: chatSurfaceBackgroundColor,
        }}
      >
        <div
          className={`relative mx-4 flex flex-col thin-scrollbar rounded-lg bg-transparent dark:bg-transparent flex-1 min-h-0 min-w-0 overflow-hidden transition-[padding-bottom] duration-200 ${!heimdallVisible ? 'px-0 sm:px-0 md:pr-12 ' : ''}`}
          style={{ paddingBottom: `0px`, backgroundColor: chatSurfaceBackgroundColor }}
        >
          {/* Conversation Title Editor */}
          {currentConversationId && (
            <div
              className={`absolute mb-2 mt-4 top-0 left-0 px-2 z-10 mx-auto right-0 transition-all duration-300 ease-out ${isTitleBarVisible ? 'opacity-100 translate-y-0 pointer-events-auto' : 'opacity-0 -translate-y-4 pointer-events-none'} ${!heimdallVisible ? 'max-w-full sm:max-w-xl md:max-w-2xl lg:max-w-3xl xl:max-w-3xl 2xl:max-w-4xl 3xl:max-w-6xl' : 'max-w-full sm:max-w-xl md:max-w-2xl lg:max-w-3xl xl:max-w-4xl 2xl:max-w-4xl'}`}
            >
              <div
                className='flex items-center backdrop-blur-[12px] border rounded-full py-1 px-1.5 gap-1 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.2)] dark:shadow-[0_10px_30px_-10px_rgba(0,0,0,0.5)]'
                style={{
                  backgroundColor: conversationToolbarBackgroundColor,
                  borderColor: isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
                }}
              >
                {/* Workspace Actions */}
                {/* <Button
                  variant='outline2'
                  size='medium'
                  className='!rounded-full !p-2 transition-all duration-200 hover:bg-black/5 dark:hover:bg-white/5'
                  aria-label='Conversations'
                  onClick={() => {
                    const projectId = selectedProject?.id || currentConversation?.project_id
                    navigate(projectId ? `/conversationPage?projectId=${projectId}` : '/conversationPage')
                  }}
                  title='New Chat'
                >
                  <i className='bx bx-chat text-lg' aria-hidden='true'></i>
                </Button> */}

                <Button
                  variant='outline2'
                  size='medium'
                  className='!rounded-full !p-2 transition-all duration-200 hover:bg-black/5 dark:hover:bg-white/5'
                  aria-label={heimdallVisible ? 'Hide Tree View' : 'Show Tree View'}
                  onClick={() => {
                    const newValue = !heimdallVisible
                    setHeimdallVisible(newValue)
                    try {
                      window.localStorage.setItem('chat:heimdallVisible', String(newValue))
                    } catch {}
                  }}
                  title={heimdallVisible ? 'Hide Tree View' : 'Show Tree View'}
                >
                  <img src={getAssetPath('img/branchlighmode.svg')} alt='tree view' className='w-4 h-4 dark:hidden' />
                  <img
                    src={getAssetPath('img/branchdarkmode.svg')}
                    alt='tree view'
                    className='w-4 h-4 hidden dark:block'
                  />
                </Button>

                {/* Divider */}
                <div className='w-px h-4 bg-black/[0.08] dark:bg-white/[0.08] mx-1' />

                {/* Session Pill */}
                {editingTitle ? (
                  <>
                    <TextField
                      value={titleInput}
                      onChange={val => {
                        setTitleInput(val)
                      }}
                      placeholder='Conversation title'
                      size='large'
                      className='rounded-full'
                    />
                    <Button
                      variant='outline2'
                      size='medium'
                      className='!rounded-full !p-2 transition-all duration-200 hover:bg-black/5 dark:hover:bg-white/5'
                      aria-label='Confirm edit'
                      onClick={() => setEditingTitle(false)}
                    >
                      <i className='bx bx-check text-lg' aria-hidden='true'></i>
                    </Button>
                  </>
                ) : (
                  <>
                    <Select
                      value={currentConversationId ? String(currentConversationId) : ''}
                      onChange={val => {
                        const conv = sortedConversations.find(c => String(c.id) === val)
                        // Use setTimeout to defer navigation and allow Select to close properly
                        setTimeout(
                          () => navigate(`/chat/${conv?.project_id || projectIdFromUrl || 'unknown'}/${val}`),
                          0
                        )
                      }}
                      options={sortedConversations.map(conv => ({
                        value: String(conv.id),
                        label: conv.title || 'Untitled Conversation',
                      }))}
                      blur='high'
                      placeholder='Select conversation...'
                      disabled={sortedConversations.length === 0}
                      className='flex-1 transition-transform min-w-0 rounded-full border-transparent hover:border-black/5 dark:hover:border-white/5'
                      searchBarVisible={true}
                    />
                  </>
                )}

                {/* Divider */}
                <div className='w-px h-4 bg-black/[0.08] dark:bg-white/[0.08] mx-1' />

                {/* System Actions */}
                <Button
                  variant='outline2'
                  size='medium'
                  className='!rounded-full !p-2 transition-all duration-200 hover:bg-black/5 dark:hover:bg-white/5'
                  aria-label='Refresh Messages'
                  onClick={() => {
                    if (currentConversationId) {
                      queryClient.invalidateQueries({
                        queryKey: ['conversations', currentConversationId, 'messages'],
                      })
                    }
                  }}
                  title='Sync / Refresh'
                >
                  <i className='bx bx-refresh text-lg' aria-hidden='true'></i>
                </Button>

                <div ref={optionsRef} className='relative'>
                  <Button
                    variant='outline2'
                    size='medium'
                    className='!rounded-full !p-2 transition-all duration-200 hover:bg-black/5 dark:hover:bg-white/5'
                    aria-label='Options'
                    onClick={() => setOptionsOpen(!optionsOpen)}
                    title='Settings'
                  >
                    <i className='bx bx-dots-vertical-rounded text-lg' aria-hidden='true'></i>
                  </Button>
                  {optionsOpen && (
                    <div className='absolute right-0 top-full mt-1 z-50 bg-white/90 dark:bg-neutral-900/90 backdrop-blur-[12px] border border-black/[0.08] dark:border-white/[0.08] rounded-xl shadow-[0_10px_30px_-10px_rgba(0,0,0,0.3)] w-max'>
                      <button
                        className='w-full text-left px-3 py-2 text-sm text-neutral-500 hover:text-neutral-200 hover:bg-black/5 dark:hover:bg-white/5 transition-colors rounded-t-xl whitespace-nowrap'
                        onClick={() => {
                          setEditingTitle(true)
                          setOptionsOpen(false)
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className='w-full text-left px-3 py-2 text-sm text-neutral-500 hover:text-neutral-200 hover:bg-black/5 dark:hover:bg-white/5 transition-colors rounded-b-xl whitespace-nowrap'
                        onClick={handleCloneConversation}
                        disabled={cloningConversation}
                      >
                        {cloningConversation ? 'Cloning...' : 'Clone Chat'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
          {/* Messages Display */}
          <div
            ref={messagesContainerRef}
            className={`flex flex-col ${currentConversationId && isTitleBarVisible ? 'pt-25' : 'pt-6'} transition-[padding-top] duration-300 dark:border-neutral-700 border-stone-200 rounded-lg overflow-y-auto overflow-x-hidden thin-scrollbar overscroll-y-contain touch-pan-y`}
            style={{
              ['overflowAnchor' as any]: 'none',
              willChange: 'scroll-position',
              backgroundColor: chatSurfaceBackgroundColor,
            }}
          >
            <React.Profiler id='chat-virtual-list' onRender={handleVirtualListProfilerRender}>
              {virtualRows.length === 0 ? (
                <EmptyChatState />
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
                                customTheme={customTheme}
                                customThemeEnabled={customThemeEnabled}
                                isDarkMode={isDarkMode}
                                className='opacity-70'
                                onOpenToolHtmlModal={openToolHtmlModal}
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
                                customTheme={customTheme}
                                customThemeEnabled={customThemeEnabled}
                                isDarkMode={isDarkMode}
                                className='opacity-70'
                                onOpenToolHtmlModal={openToolHtmlModal}
                              />
                            </VirtualizedRowContainer>
                          )
                        }

                        if (renderRow.kind === 'streaming_message') {
                          if (!hasStreamingMessageContent) return null

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
                                thinking={streamState.thinkingBuffer}
                                toolCalls={streamState.toolCalls}
                                streamEvents={streamState.events}
                                width='w-full'
                                fontSizeOffset={fontSizeOffset}
                                groupToolReasoningRuns={groupToolReasoningRuns}
                                customTheme={customTheme}
                                customThemeEnabled={customThemeEnabled}
                                isDarkMode={isDarkMode}
                                modelName={selectedModel?.name || undefined}
                                className=''
                                onOpenToolHtmlModal={openToolHtmlModal}
                              />
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
                              <div className={`${showStreamingMessage ? 'pt-2' : 'pt-1'} pl-2`}>
                                <StreamingLoadingAnimation
                                  animationType={streamingAnimation}
                                  color={
                                    streamingAnimationThemeColor ||
                                    (isDarkMode ? streamingAnimationDarkColor : streamingAnimationLightColor)
                                  }
                                  speed={streamingAnimationSpeed}
                                />
                              </div>
                            </VirtualizedRowContainer>
                          )
                        }

                        const row = renderRow.row

                        if (row.kind === 'process_group') {
                          const runId = String(row.id)
                          const isExpanded = expandedProcessMessageRuns.has(runId)
                          const summaryParts: string[] = []
                          if (row.toolCount > 0) {
                            summaryParts.push(`${row.toolCount} tool${row.toolCount === 1 ? '' : 's'}`)
                          }
                          if (row.reasoningCount > 0) {
                            summaryParts.push(`${row.reasoningCount} reasoning`)
                          }

                          return (
                            <VirtualizedRowContainer
                              key={renderRow.key}
                              id={`message-group-${runId}`}
                              index={virtualRow.index}
                              start={virtualRow.start}
                              measureElement={virtualizer.measureElement}
                              className='z-0'
                            >
                              <div className='relative pl-6 py-3 ml-2 border-l border-neutral-300 dark:border-neutral-700'>
                                <div className='absolute -left-[5px] top-4 w-2.5 h-2.5 rounded-full bg-violet-500 shadow-[0_0_8px_rgba(139,92,246,0.35)]' />
                                <button
                                  onClick={() => toggleProcessMessageRun(runId)}
                                  className='flex items-center gap-2 group/run hover:opacity-80 transition-opacity cursor-pointer outline-none'
                                >
                                  <span className='text-[10px] uppercase tracking-wider text-neutral-500 dark:text-neutral-500 font-bold'>
                                    Agent Steps ({row.messages.length})
                                  </span>
                                  {!isExpanded && summaryParts.length > 0 && (
                                    <span className='text-xs text-neutral-500 dark:text-neutral-500 line-clamp-1 max-w-[320px]'>
                                      {summaryParts.join(' • ')}
                                    </span>
                                  )}
                                  <svg
                                    className={`tool-chevron w-3.5 h-3.5 text-neutral-400 dark:text-neutral-600 group-hover/run:text-neutral-500 dark:group-hover/run:text-neutral-400 ${isExpanded ? 'open' : ''}`}
                                    fill='none'
                                    viewBox='0 0 24 24'
                                    stroke='currentColor'
                                  >
                                    <path
                                      strokeLinecap='round'
                                      strokeLinejoin='round'
                                      strokeWidth={2}
                                      d='M9 5l7 7-7 7'
                                    />
                                  </svg>
                                </button>
                                <div className={`tool-expand-container ${isExpanded ? 'open' : ''}`}>
                                  <div className='tool-expand-content pt-2'>
                                    {row.messages.map(groupedMessage => {
                                      const { toolCalls, contentBlocks } =
                                        parsedMessageDataById.get(groupedMessage.id) ?? EMPTY_PARSED_MESSAGE_DATA
                                      return (
                                        <ChatMessage
                                          key={groupedMessage.id}
                                          id={groupedMessage.id.toString()}
                                          role={groupedMessage.role}
                                          content={groupedMessage.content}
                                          thinking={groupedMessage.thinking_block}
                                          toolCalls={toolCalls}
                                          contentBlocks={contentBlocks}
                                          timestamp={groupedMessage.created_at}
                                          width='w-full'
                                          modelName={groupedMessage.model_name}
                                          artifacts={groupedMessage.artifacts}
                                          fontSizeOffset={fontSizeOffset}
                                          groupToolReasoningRuns={false}
                                          customTheme={customTheme}
                                          customThemeEnabled={customThemeEnabled}
                                          isDarkMode={isDarkMode}
                                          onOpenToolHtmlModal={openToolHtmlModal}
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
                                          thinking={bridgedMessage.thinking_block}
                                          toolCalls={bridgedParsed.toolCalls}
                                          contentBlocks={bridgedProcessBlocks}
                                          timestamp={bridgedMessage.created_at}
                                          width='w-full'
                                          modelName={bridgedMessage.model_name}
                                          artifacts={bridgedMessage.artifacts}
                                          fontSizeOffset={fontSizeOffset}
                                          groupToolReasoningRuns={false}
                                          customTheme={customTheme}
                                          customThemeEnabled={customThemeEnabled}
                                          isDarkMode={isDarkMode}
                                          onOpenToolHtmlModal={openToolHtmlModal}
                                        />
                                      )
                                    })()}
                                  </div>
                                </div>
                              </div>
                            </VirtualizedRowContainer>
                          )
                        }

                        const msg = row.message
                        const { toolCalls, contentBlocks } =
                          parsedMessageDataById.get(msg.id) ?? EMPTY_PARSED_MESSAGE_DATA
                        const previousRenderRow = virtualRow.index > 0 ? virtualRows[virtualRow.index - 1] : null
                        const previousRow = previousRenderRow?.kind === 'message_row' ? previousRenderRow.row : null

                        const isProcessBridgeSourceMessage =
                          previousRow?.kind === 'process_group' &&
                          previousRow.bridgedMessageId != null &&
                          String(previousRow.bridgedMessageId) === String(msg.id)

                        const displayThinking = isProcessBridgeSourceMessage ? undefined : msg.thinking_block
                        const displayToolCalls = isProcessBridgeSourceMessage ? [] : toolCalls
                        const displayContentBlocks =
                          isProcessBridgeSourceMessage && Array.isArray(contentBlocks)
                            ? contentBlocks.filter(block => !isProcessContentBlock(block))
                            : contentBlocks
                        const assistantContainerClassName = assistantContainerClassByMessageId.get(String(msg.id))

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
                              thinking={displayThinking}
                              toolCalls={displayToolCalls}
                              contentBlocks={displayContentBlocks}
                              timestamp={msg.created_at}
                              width='w-full'
                              modelName={msg.model_name}
                              artifacts={msg.artifacts}
                              fontSizeOffset={fontSizeOffset}
                              groupToolReasoningRuns={groupToolReasoningRuns}
                              customTheme={customTheme}
                              customThemeEnabled={customThemeEnabled}
                              isDarkMode={isDarkMode}
                              className={assistantContainerClassName}
                              onEdit={handleMessageEdit}
                              onBranch={handleMessageBranch}
                              onDelete={handleRequestDelete}
                              onResend={handleResend}
                              onAddToNote={handleAddToNote}
                              onExplainFromSelection={handleExplainFromSelection}
                              onOpenToolHtmlModal={openToolHtmlModal}
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

            {/* Bottom sentinel and padding for scrolling past last message */}
            <div ref={bottomRef} data-bottom-sentinel='true' style={{ height: Math.max(100, containerHeight - 300) }} />
          </div>
        </div>
        {/* Input area: controls row + textarea (absolutely positioned overlay) */}
        <div
          ref={inputAreaRef}
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
              onClick={() => scrollToBottomNow('auto')}
            >
              <i className='bx bx-down-arrow-alt text-lg' aria-hidden='true'></i>
            </Button>
          )}

          {/* Textarea (bottom, grows upward because wrapper is bottom-pinned) */}
          <div
            className={`slate-input-wrapper ${inputAreaBorderClasses} bg-neutral-100/40 dark:bg-neutral-900/40 backdrop-blur-xl rounded-3xl px-2 py-3 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.25)] dark:shadow-[0_20px_50px_-12px_rgba(0,0,0,0.5)] transition-all duration-300`}
            style={
              chatInputBorderAnimationEnabled
                ? ({
                    '--chat-input-border-light': effectiveChatInputBorderLightColor,
                    '--chat-input-border-dark': effectiveChatInputBorderDarkColor,
                  } as React.CSSProperties)
                : useCustomInputAreaBorderColor && chatInputAreaBorderColor
                  ? { outlineColor: chatInputAreaBorderColor }
                  : undefined
            }
          >
            {toolCallPermissionRequest && (
              <ToolPermissionDialog
                toolCall={toolCallPermissionRequest.toolCall}
                onGrant={() => dispatch(respondToToolPermission(true))}
                onDeny={() => dispatch(respondToToolPermission(false))}
                onAllowAll={() => dispatch(respondToToolPermissionAndEnableAll())}
              />
            )}
            {/* Todo List Display - shows latest todo_list tool result */}
            {latestTodoList && latestTodoList.items && latestTodoList.items.length > 0 && (
              <div
                className={`mx-2 ${toolCallPermissionRequest ? 'mt-1' : 'mt-2'} mb-1 px-2 py-0.5 rounded-[16px] bg-neutral-100/80 dark:bg-neutral-800/50 border border-neutral-200 dark:border-neutral-700`}
              >
                <div className='flex items-center justify-between'>
                  <span className='text-xs font-medium text-neutral-600 dark:text-neutral-400 flex items-center gap-1.5'>
                    <i className='bx bx-list-check text-2xl'></i>
                    <span className='text-[12px]'>{latestTodoList.name || 'Todo List'}</span>
                    {todoListCollapsed && (
                      <span className='text-[10px] text-neutral-400 dark:text-neutral-500 ml-1'>
                        ({latestTodoList.items.filter(i => i.done).length}/{latestTodoList.items.length})
                      </span>
                    )}
                  </span>
                  <div className='flex items-center gap-2'>
                    <span className='text-[10px] text-neutral-400 dark:text-neutral-500'>
                      {latestTodoList.action === 'create'
                        ? 'Created'
                        : latestTodoList.action === 'edit'
                          ? 'Updated'
                          : ''}
                    </span>
                    <button
                      onClick={() => setTodoListCollapsed(!todoListCollapsed)}
                      className='py-0.5 mt-1 px-2 rounded-lg hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors'
                      title={todoListCollapsed ? 'Expand todo list' : 'Collapse todo list'}
                    >
                      <i
                        className={`bx ${todoListCollapsed ? 'bx-chevron-down' : 'bx-chevron-up'} text-sm text-neutral-500`}
                      ></i>
                    </button>
                  </div>
                </div>
                {!todoListCollapsed && (
                  <ul className='space-y-1 pb-2 mt-1.5 max-h-40 overflow-y-auto thin-scrollbar'>
                    {latestTodoList.items.map((item, idx) => (
                      <li
                        key={`todo-item-${idx}`}
                        className={`flex items-center gap-2 text-xs ${
                          item.done
                            ? 'text-neutral-500 dark:text-neutral-400'
                            : 'text-neutral-800 dark:text-neutral-200'
                        }`}
                      >
                        <span className={item.done ? 'text-green-600 dark:text-green-400' : 'text-neutral-400'}>
                          {item.done ? '[✓]' : '[ ]'}
                        </span>
                        <span className={item.done ? 'line-through opacity-80' : ''}>{item.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {branchFileMutationData.latestByPath.length > 0 && (
              <div
                className={`mx-2 ${latestTodoList && latestTodoList.items && latestTodoList.items.length > 0 ? 'mt-1' : toolCallPermissionRequest ? 'mt-1' : 'mt-2'} mb-1 px-1 py-1`}
              >
                <div className='flex items-center justify-between gap-3'>
                  <span className='min-w-0 flex items-center gap-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-400'>
                    <i className='bx bx-file text-base shrink-0'></i>
                    <span className='truncate text-[12px]'>Modified Files</span>
                    <span className='shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500'>
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
                      onClick={() => setWorkspaceMutationsCollapsed(!workspaceMutationsCollapsed)}
                      className='rounded-md px-1 py-0.5 text-neutral-500 transition-colors hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'
                      title={workspaceMutationsCollapsed ? 'Expand modified files' : 'Collapse modified files'}
                    >
                      <i
                        className={`bx ${workspaceMutationsCollapsed ? 'bx-chevron-down' : 'bx-chevron-up'} text-sm transition-transform duration-300 ease-in-out`}
                      ></i>
                    </button>
                  </div>
                </div>
                <div
                  className={`overflow-hidden transition-[max-height,opacity,margin] duration-300 ease-in-out ${
                    workspaceMutationsCollapsed ? 'mt-0 max-h-0 opacity-0' : 'mt-1.5 max-h-44 opacity-100'
                  }`}
                  aria-hidden={workspaceMutationsCollapsed}
                >
                  <ul className='space-y-1 max-h-40 overflow-y-auto pr-1 thin-scrollbar'>
                    {branchFileMutationData.latestByPath.map(summary => {
                      const latestMutation = summary.latestMutation
                      const fileName = getWorkspaceFileBaseName(summary.path)
                      return (
                        <li key={`workspace-summary-${summary.path}`} className='px-1 py-1'>
                          <div className='flex items-start gap-2'>
                            <span
                              className={`mt-0.5 inline-flex h-5 shrink-0 items-center rounded-full px-1.5 text-[9px] font-semibold leading-none ${getWorkspaceMutationBadgeClassName(latestMutation.operation)}`}
                            >
                              {getWorkspaceMutationLabel(latestMutation.operation)}
                            </span>
                            <div className='min-w-0 flex-1'>
                              <div className='flex items-center justify-between gap-2'>
                                <div className='min-w-0 flex items-center gap-1.5'>
                                  <span className='truncate text-xs font-medium text-neutral-800 dark:text-neutral-100'>
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
                                  className='shrink-0 text-[10px] font-medium text-neutral-500 transition-colors hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'
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
            {showOpenAIUsagePanel && (
              <div className='mx-2 mt-2 mb-1 rounded-[16px] border border-neutral-200 dark:border-neutral-700 bg-neutral-100/90 dark:bg-neutral-800/60 px-3 py-2'>
                <div className='flex items-start justify-between gap-3'>
                  <div className='text-xs font-semibold text-neutral-700 dark:text-neutral-200'>OpenAI Usage</div>
                  <button
                    type='button'
                    className='text-red-500 hover:text-red-400 text-xs font-semibold leading-none'
                    aria-label='Close OpenAI usage panel'
                    onClick={() => setShowOpenAIUsagePanel(false)}
                  >
                    X
                  </button>
                </div>

                {openAIUsageLoading ? (
                  <div className='mt-2 text-xs text-neutral-600 dark:text-neutral-300'>Loading usage…</div>
                ) : openAIUsageError ? (
                  <div className='mt-2 text-xs text-red-500'>{openAIUsageError}</div>
                ) : openAIUsageData ? (
                  <div className='mt-2 space-y-1 text-xs text-neutral-700 dark:text-neutral-200'>
                    <div className='flex items-center justify-between gap-2'>
                      <span className='text-neutral-500 dark:text-neutral-400'>Session</span>
                      <span>
                        {openAIUsageData.session.usedPercent == null
                          ? '—'
                          : `${Math.round(openAIUsageData.session.usedPercent)}%`}
                      </span>
                    </div>
                    <div className='flex items-center justify-between gap-2'>
                      <span className='text-neutral-500 dark:text-neutral-400'>Weekly</span>
                      <span>
                        {openAIUsageData.weekly.usedPercent == null
                          ? '—'
                          : `${Math.round(openAIUsageData.weekly.usedPercent)}%`}
                      </span>
                    </div>
                    {openAIUsageData.reviews.usedPercent != null && (
                      <div className='flex items-center justify-between gap-2'>
                        <span className='text-neutral-500 dark:text-neutral-400'>Reviews</span>
                        <span>{`${Math.round(openAIUsageData.reviews.usedPercent)}%`}</span>
                      </div>
                    )}
                    {openAIUsageData.credits && openAIUsageData.credits.balance != null && (
                      <div className='flex items-center justify-between gap-2'>
                        <span className='text-neutral-500 dark:text-neutral-400'>Credits</span>
                        <span>{openAIUsageData.credits.balance.toFixed(2)}</span>
                      </div>
                    )}
                    {openAIUsageData.session.resetAtIso && (
                      <div className='pt-1 text-[10px] text-neutral-500 dark:text-neutral-400'>
                        Session reset: {new Date(openAIUsageData.session.resetAtIso).toLocaleString()}
                      </div>
                    )}
                    {openAIUsageData.weekly.resetAtIso && (
                      <div className='text-[10px] text-neutral-500 dark:text-neutral-400'>
                        Weekly reset: {new Date(openAIUsageData.weekly.resetAtIso).toLocaleString()}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className='mt-2 text-xs text-neutral-600 dark:text-neutral-300'>No usage data available.</div>
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
              />
            </div>
            {/* Selected file chips moved from InputTextArea */}
            {selectedFilesForChat && selectedFilesForChat.length > 0 && (
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

            {/* Token Usage Progress Bar - Optional */}
            {showTokenUsageBar && (
              <div className='mx-1 mb-0.5 group relative cursor-pointer'>
                <div className='flex items-center gap-2'>
                  <div className='flex-1 h-1 bg-neutral-300/50 dark:bg-neutral-700/50 rounded-full overflow-hidden relative'>
                    <div
                      className={`absolute inset-0 h-full rounded-full transition-all duration-300 ${
                        customThemeEnabled
                          ? ''
                          : totalContextProgress >= 95
                            ? 'bg-red-500 dark:bg-red-400'
                            : totalContextProgress >= 80
                              ? 'bg-amber-500 dark:bg-amber-400'
                              : 'bg-blue-500 dark:bg-blue-400'
                      }`}
                      style={{
                        width: `${totalContextProgress}%`,
                        ...(customThemeEnabled && chatProgressBarFillColor
                          ? { backgroundColor: chatProgressBarFillColor }
                          : {}),
                      }}
                    />
                  </div>
                  {/* Refresh credits button */}
                  <button
                    onClick={handleRefreshCredits}
                    disabled={isRefreshingCredits}
                    className='p-1 rounded-full hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors disabled:opacity-50'
                    title='Refresh credits'
                  >
                    <svg
                      className={`w-3 h-3 text-neutral-500 dark:text-neutral-400 ${isRefreshingCredits ? 'animate-spin' : ''}`}
                      fill='none'
                      stroke='currentColor'
                      viewBox='0 0 24 24'
                    >
                      <path
                        strokeLinecap='round'
                        strokeLinejoin='round'
                        strokeWidth={2}
                        d='M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15'
                      />
                    </svg>
                  </button>
                </div>
                {/* Hover Popup with Token Details */}
                <div className='absolute left-1/2 -translate-x-1/2 bottom-full mb-2 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50'>
                  <div className='bg-neutral-100 dark:bg-neutral-900 text-black dark:text-white rounded-lg shadow-lg px-3 py-2 whitespace-nowrap'>
                    <div className='flex items-center gap-2 text-xs'>
                      <span className='text-blue-700 dark:text-blue-400'>Context:</span>
                      <span>
                        {tokenUsage.totalContextTokens.toLocaleString()} / {tokenLimits.totalBudget.toLocaleString()}
                      </span>
                    </div>
                    <div className='flex items-center gap-2 text-xs mt-1'>
                      <span className='text-neutral-700 dark:text-neutral-300'>Messages:</span>
                      <span>{tokenUsage.messageTokens.toLocaleString()}</span>
                    </div>
                    <div className='flex items-center gap-2 text-xs mt-1'>
                      <span className='text-neutral-700 dark:text-neutral-300'>Prompts + Context:</span>
                      <span>{tokenUsage.promptAndContextTokens.toLocaleString()}</span>
                    </div>
                    <div className='flex items-center gap-2 text-xs mt-1'>
                      <span className='text-neutral-700 dark:text-neutral-300'>Model window:</span>
                      <span>{tokenLimits.totalContextLimit.toLocaleString()}</span>
                    </div>
                    <div className='flex items-center gap-2 text-xs mt-1'>
                      <span className='text-neutral-900 dark:text-neutral-200'>Credits:</span>
                      <span>{(current_credits * 100).toFixed(3)}</span>
                    </div>
                    {/* Tooltip Arrow */}
                    <div className='absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-neutral-800 dark:border-t-neutral-900' />
                  </div>
                </div>
              </div>
            )}
            {/* Controls row */}
            <div className='flex items-center justify-between gap-0 flex-wrap'>
              {/* Left side controls */}
              <div className='flex items-center min-w-0 flex-1'>
                <button
                  className='pt-1.5 px-2 rounded-lg text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 hover:bg-white/10 dark:hover:bg-white/5 transition-all duration-200'
                  onClick={() => {
                    setSpinSettings(true)
                    setSettingsOpen(true)
                  }}
                  title='Chat Settings'
                >
                  <i
                    className={`bx bx-cog text-[22px] ${spinSettings ? 'animate-[spin_0.6s_linear_1]' : ''}`}
                    aria-hidden='true'
                    onAnimationEnd={() => setSpinSettings(false)}
                  ></i>
                </button>
                <div className='flex items-center gap-1 flex-nowrap min-w-0 flex-1'>
                  {import.meta.env.VITE_ENVIRONMENT === 'electron' && extensions.length > 0 && (
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
                      className='flex-1 basis-0 min-w-0 max-w-[200px] ml-2 text-xs sm:text-sm text-[14px] sm:text-[12px] md:text-[12px] lg:text-[12px] xl:text-[12px] 2xl:text-[13px] 3xl:text-[12px] 4xl:text-[22px] dark:text-neutral-200 break-words line-clamp-1 text-right'
                      size='small'
                    />
                  )}

                  {/* Provider selector - visibility controlled by user settings */}
                  {import.meta.env.VITE_ENVIRONMENT === 'electron' && providerSettings.showProviderSelector && (
                    <Select
                      value={providers.currentProvider || ''}
                      onChange={handleProviderSelect}
                      options={providers.providers.map(p => p.name)}
                      placeholder='Select a provider...'
                      disabled={providers.providers.length === 0}
                      className='flex-1 basis-0 min-w-0 max-w-[200px] transition-transform duration-60 active:scale-97'
                      searchBarVisible={true}
                      size='large'
                    />
                  )}
                  <ModelSelectControl
                    provider={providers.currentProvider}
                    selectedModelName={selectedModel?.name || ''}
                    onChange={handleModelSelect}
                    placeholder='Select a model...'
                    blur='low'
                    className='flex-1 basis-0 min-w-0 max-w-[200px] transition-transform duration-60 active:scale-99 rounded-4xl'
                    showFilters={true}
                    footerContent={modelSelectFooter}
                  />
                </div>
              </div>
              {/* Right side controls */}
              <div className='flex items-center gap-1 mr-2'>
                {(isImageGenerationModel ||
                  think ||
                  (import.meta.env.VITE_ENVIRONMENT === 'electron' && conversationIdFromUrl)) && (
                  <ActionPopover
                    isActive={
                      toolAutoApprove ||
                      operationMode === 'plan' ||
                      hermesMode ||
                      !!imageConfig.aspectRatio ||
                      !!imageConfig.imageSize ||
                      (think && reasoningConfig.effort !== 'medium')
                    }
                    footer={
                      <div className='flex flex-col gap-2'>
                        {import.meta.env.VITE_ENVIRONMENT === 'electron' && conversationIdFromUrl && (
                          <>
                            <span className='text-black dark:text-neutral-200 text-[16px]'>Agent backend:</span>
                            <Select
                              value={hermesMode ? 'hermes' : 'default'}
                              options={[
                                { value: 'default', label: 'Default model backend' },
                                { value: 'hermes', label: 'Hermes ACP backend' },
                              ]}
                              onChange={value => setHermesModeEnabled(value === 'hermes')}
                              placeholder='Select backend'
                              size='small'
                              dropdownZIndex={ACTION_POPOVER_SELECT_DROPDOWN_Z_INDEX}
                              disabled={!hermesModeAvailable}
                            />

                            <span className='text-black dark:text-neutral-200 text-[16px]'>Work directory:</span>
                            <div className='flex gap-2'>
                              <input
                                type='text'
                                value={ccCwd}
                                onChange={e => setCcCwdFromUser(e.target.value)}
                                placeholder='Working directory (optional)'
                                className='flex-1 px-3 py-2 text-sm border border-neutral-300 dark:border-neutral-900 rounded-lg bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-orange-500/60'
                                style={
                                  actionPopoverInputBorderColor
                                    ? { borderColor: actionPopoverInputBorderColor }
                                    : undefined
                                }
                                title='Specify the working directory used by local agent backends'
                              />
                              <button
                                type='button'
                                onClick={async () => {
                                  const result = await window.electronAPI?.dialog?.selectFolder()
                                  if (result?.success && result.path) {
                                    setCcCwdFromUser(result.path)
                                  }
                                }}
                                className='px-3 py-2 text-sm border border-neutral-300 dark:border-neutral-900 rounded-lg bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-orange-500/60'
                                style={
                                  actionPopoverInputBorderColor
                                    ? { borderColor: actionPopoverInputBorderColor }
                                    : undefined
                                }
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
                          </>
                        )}

                        {/* Image Generation Options - shown only for image generation models */}
                        {isImageGenerationModel && (
                          <>
                            <h1 className='text-black dark:text-neutral-200 text-[16px]'>Image Options</h1>
                            <div className='flex flex-col gap-1'>
                              <label className='text-xs text-neutral-500 dark:text-neutral-400'>Aspect Ratio</label>
                              <Select
                                value={imageConfig.aspectRatio || ''}
                                options={[
                                  { value: '', label: 'Default' },
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
                                    aspectRatio: (value as ImageConfig['aspectRatio']) || undefined,
                                  }))
                                }
                                placeholder='Select aspect ratio'
                                size='small'
                                dropdownZIndex={ACTION_POPOVER_SELECT_DROPDOWN_Z_INDEX}
                              />
                            </div>
                            <div className='flex flex-col gap-1'>
                              <label className='text-xs text-neutral-500 dark:text-neutral-400'>Image Size</label>
                              <Select
                                value={imageConfig.imageSize || ''}
                                options={[
                                  { value: '', label: 'Default' },
                                  { value: '1K', label: '1K' },
                                  { value: '2K', label: '2K' },
                                  { value: '4K', label: '4K' },
                                ]}
                                onChange={value =>
                                  setImageConfig(prev => ({
                                    ...prev,
                                    imageSize: (value as ImageConfig['imageSize']) || undefined,
                                  }))
                                }
                                placeholder='Select image size'
                                size='small'
                                dropdownZIndex={ACTION_POPOVER_SELECT_DROPDOWN_Z_INDEX}
                              />
                            </div>
                          </>
                        )}
                        {/* Reasoning Effort Options - shown when thinking is enabled */}
                        {selectedModel?.thinking && (
                          <>
                            <h1 className='text-black dark:text-neutral-200 text-[16px]'>Reasoning Options</h1>
                            <div className='flex flex-col gap-1'>
                              <label className='text-xs text-neutral-500 dark:text-neutral-400'>Effort Level</label>
                              <Select
                                value={reasoningConfig.effort}
                                options={REASONING_EFFORT_OPTIONS.map(option => ({
                                  value: option,
                                  label:
                                    option === 'medium'
                                      ? 'Medium (Default)'
                                      : option === 'xhigh'
                                        ? 'X-High'
                                        : option.charAt(0).toUpperCase() + option.slice(1),
                                }))}
                                onChange={value =>
                                  setReasoningConfig(prev => ({
                                    ...prev,
                                    effort: value as ReasoningConfig['effort'],
                                  }))
                                }
                                placeholder='Select effort level'
                                size='small'
                                dropdownZIndex={ACTION_POPOVER_SELECT_DROPDOWN_Z_INDEX}
                              />
                            </div>
                          </>
                        )}
                        {/* Orchestrator Mode Toggle */}
                        <div className='flex items-center gap-2'>
                          <span className='text-xs text-neutral-500 dark:text-neutral-400'>Orchestrator</span>
                          <button
                            onClick={() => {
                              const newState = toggleOrchestratorEnabled()
                              setOrchestratorEnabledState(newState)
                            }}
                            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                              orchestratorEnabled ? 'bg-blue-600' : 'bg-neutral-300 dark:bg-neutral-600'
                            }`}
                            title={
                              orchestratorEnabled
                                ? 'Subagent can use tools (click to disable)'
                                : 'Subagent cannot use tools (click to enable)'
                            }
                          >
                            <span
                              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                                orchestratorEnabled ? 'translate-x-4.5' : 'translate-x-1'
                              }`}
                            />
                          </button>
                        </div>
                      </div>
                    }
                  >
                    {import.meta.env.VITE_ENVIRONMENT === 'electron' && conversationIdFromUrl && (
                      <>
                        <Button
                          variant='outline2'
                          className='rounded-full'
                          size='medium'
                          onClick={() => setJobsModalOpen(true)}
                          title={isElectronEnv ? 'View tool jobs' : 'Tool jobs are available in the desktop app'}
                          disabled={!isElectronEnv}
                        >
                          <i className='bx bx-task pb-0.5' aria-hidden='true'></i>
                          Jobs
                        </Button>
                        {/* Allow All / Ask toggle */}
                        <Button
                          variant='outline2'
                          size='medium'
                          onClick={() => dispatch(chatSliceActions.toolAutoApproveToggled())}
                          className={
                            toolAutoApprove
                              ? customThemeEnabled
                                ? 'dark:hover:bg-white/5'
                                : 'text-orange-700 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/20 dark:hover:bg-white/5'
                              : 'text-neutral-600 dark:text-neutral-200 dark:hover:bg-white/5'
                          }
                          style={toolAutoApprove && customThemeEnabled ? composerToggleActiveStyle : undefined}
                          title={
                            toolAutoApprove
                              ? 'Auto-approving tools (click to disable)'
                              : 'Asking for permission (click to auto-approve)'
                          }
                          aria-label={toolAutoApprove ? 'Disable auto-approve' : 'Enable auto-approve'}
                        >
                          <i className='bx bx-shield-quarter pr-1 pb-0.5'></i>
                          {toolAutoApprove ? 'Allow all' : 'Ask'}
                        </Button>

                        {/* Chat / Agent toggle */}
                        <Button
                          variant='outline2'
                          size='medium'
                          onClick={() => dispatch(chatSliceActions.operationModeToggled())}
                          className={
                            operationMode === 'plan'
                              ? 'text-fuchsia-700 dark:text-fuchsia-300 bg-blue-50 dark:bg-blue-900/30 hover:bg-blue-100 dark:hover:bg-white/5'
                              : customThemeEnabled
                                ? 'hover:bg-neutral-100 dark:hover:bg-white/5'
                                : 'text-orange-700 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/20 hover:bg-orange-100 dark:hover:bg-white/5'
                          }
                          style={operationMode !== 'plan' && customThemeEnabled ? composerToggleActiveStyle : undefined}
                          title={
                            operationMode === 'plan'
                              ? 'Plan mode enabled (tools will be blocked)'
                              : 'Execution mode enabled (tools may modify files)'
                          }
                          aria-label={operationMode === 'plan' ? 'Switch to execution mode' : 'Switch to plan mode'}
                        >
                          <i
                            className={`bx ${operationMode === 'plan' ? 'bx-clipboard' : 'bx-code-block'} mr-1 pb-0.5`}
                          ></i>
                          {operationMode === 'plan' ? 'Chat' : 'Agent'}
                        </Button>
                      </>
                    )}
                  </ActionPopover>
                )}
                {/* Thinking toggle - next to popover, disabled when not supported */}
                <button
                  className={`p-2 rounded-lg transition-all duration-200 ${
                    selectedModel?.thinking
                      ? 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 hover:bg-white/10 dark:hover:bg-white/5'
                      : 'text-neutral-300 dark:text-neutral-600 cursor-not-allowed'
                  }`}
                  onClick={() => setThink(t => !t)}
                  disabled={!selectedModel?.thinking}
                  title={selectedModel?.thinking ? 'Enable thinking' : 'Thinking not supported by this model'}
                >
                  {think ? (
                    <>
                      <img
                        src={getAssetPath('img/thinkingonlightmode.svg')}
                        alt='Thinking active'
                        className='w-[22px] h-[22px] dark:hidden'
                      />
                      <img
                        src={getAssetPath('img/thinkingondarkmode.svg')}
                        alt='Thinking active'
                        className='w-[22px] h-[22px] hidden dark:block'
                      />
                    </>
                  ) : (
                    <>
                      <img
                        src={getAssetPath('img/thinkingofflightmode.svg')}
                        alt='Thinking'
                        className='w-[22px] h-[22px] dark:hidden'
                      />
                      <img
                        src={getAssetPath('img/thinkingoffdarkmode.svg')}
                        alt='Thinking'
                        className='w-[22px] h-[22px] hidden dark:block'
                      />
                    </>
                  )}
                </button>
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
                  className='p-2 rounded-lg text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 hover:bg-white/10 dark:hover:bg-white/5 transition-all duration-200'
                  onClick={() => attachmentInputRef.current?.click()}
                  title='Attach files'
                >
                  <svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2'>
                    <path d='m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.51a2 2 0 0 1-2.83-2.83l8.49-8.48' />
                  </svg>
                </button>
                {!currentConversationId ? (
                  <span className='text-xs text-neutral-400 dark:text-neutral-500 px-2'>Creating...</span>
                ) : showGenerationLoadingAnimation ? (
                  <button
                    onClick={handleStopGeneration}
                    disabled={!streamState.active}
                    title={
                      isCurrentConversationCompacting
                        ? 'Compacting context...'
                        : streamState.active
                          ? 'Stop generation'
                          : 'Generating...'
                    }
                    className='cursor-pointer hover:scale-105 active:scale-95 transition-transform'
                  >
                    <SendButtonLoadingAnimation
                      animationType={sendButtonAnimation}
                      bgColor={sendButtonAnimationThemeColor || sendButtonColor}
                    />
                  </button>
                ) : (
                  <button
                    className={`ml-1 w-9 h-9 flex items-center justify-center rounded-lg transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${
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

      {/* SEPARATOR - Hidden on mobile */}
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

      {isResizing && !isMobile && (
        <div
          className='fixed inset-0 z-[2000] cursor-col-resize select-none bg-transparent'
          aria-hidden='true'
          onMouseUp={() => setIsResizing(false)}
          onTouchEnd={() => setIsResizing(false)}
        />
      )}

      {/* Desktop: side-by-side layout */}
      {heimdallVisible && !isMobile && (
        <div className='flex-1 min-w-0 mb-2'>
          <Heimdall
            key={currentConversationId ?? 'none'}
            chatData={heimdallData}
            loading={loading}
            error={error}
            compactMode={compactMode}
            conversationId={currentConversationId}
            onNodeSelect={handleNodeSelect}
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
                transition={{ duration: 0.2 }}
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
                transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              >
                {/* Drag handle indicator */}
                <div className='w-full flex justify-center py-3 bg-neutral-100 dark:bg-neutral-800 border-b border-neutral-200 dark:border-neutral-700'>
                  <div className='w-12 h-1.5 bg-neutral-400 dark:bg-neutral-600 rounded-full' />
                </div>

                {/* Heimdall component */}
                <div className='h-[calc(100%-3rem)] overflow-hidden'>
                  <Heimdall
                    key={currentConversationId ?? 'none'}
                    chatData={heimdallData}
                    loading={loading}
                    error={error}
                    compactMode={compactMode}
                    conversationId={currentConversationId}
                    onNodeSelect={handleNodeSelect}
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
              className={`fixed z-[99999] -translate-y-full rounded-lg shadow-2xl overflow-y-auto shadow-sm p-3 transform transition-all duration-100 ease-out dark:bg-neutral-900 bg-neutral-100 pointer-events-auto`}
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

      {/* Free Tier Limit Modal */}
      <FreeGenerationsModal
        isOpen={showFreeTierModal}
        onClose={() => dispatch(chatSliceActions.freeTierLimitModalHidden())}
      />
      <ToolJobsModal isOpen={jobsModalOpen} onClose={() => setJobsModalOpen(false)} />

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
                      dispatch(chatSliceActions.providerSelected('OpenAI (ChatGPT)'))
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

                <div className='space-y-3'>
                  <div className='text-sm' style={{ color: authModalBodyTextColor }}>
                    <strong>Step 1:</strong> Click the button below to sign in with your OpenAI account in your browser.
                  </div>
                  <Button
                    variant='outline2'
                    className='w-full bg-neutral-800 hover:bg-neutral-900 border-neutral-700 text-white active:scale-98'
                    onClick={handleOpenaiLogin}
                    disabled={!openaiAuthFlow}
                    style={authModalPrimaryButtonStyle}
                  >
                    <i className='bx bx-link-external mr-2'></i>
                    Open OpenAI Login
                  </Button>
                </div>

                <div className='space-y-3'>
                  <div className='text-sm' style={{ color: authModalBodyTextColor }}>
                    <strong>Step 2:</strong> After completing sign-in in your browser, click the button below.
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
                    className='bg-emerald-600 hover:bg-emerald-700 border-emerald-700 text-white active:scale-90'
                    onClick={handleOpenaiAuthCallback}
                    disabled={!openaiAuthFlow || openaiAuthLoading}
                    style={authModalPrimaryButtonStyle}
                  >
                    {openaiAuthLoading ? (
                      <>
                        <i className='bx bx-loader-alt animate-spin mr-2'></i>
                        Verifying...
                      </>
                    ) : (
                      'Complete Sign In'
                    )}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {/* <div className='pointer-events-none fixed bottom-4 right-4 z-[1400] flex max-w-[360px] flex-col items-end gap-2'>
        <button
          type='button'
          onClick={() => setStreamDebugPanelOpen(prev => !prev)}
          className='pointer-events-auto rounded-full border border-black/10 bg-white/90 px-3 py-1.5 text-[11px] font-semibold text-neutral-700 shadow-lg backdrop-blur transition hover:scale-[1.02] dark:border-white/10 dark:bg-neutral-900/90 dark:text-neutral-200'
          title='Toggle stream debug panel'
        >
          {streamDebugPanelOpen ? 'Hide stream debug' : `Stream debug (${streamingRoot.activeIds.length} active)`}
        </button>

        {streamDebugPanelOpen && (
          <div className='pointer-events-auto w-[340px] max-h-[46vh] overflow-hidden rounded-xl border border-black/10 bg-white/90 p-3 text-[11px] shadow-2xl backdrop-blur dark:border-white/10 dark:bg-neutral-950/90 dark:text-neutral-100'>
            <div className='flex items-center justify-between gap-2'>
              <div className='text-[12px] font-semibold tracking-tight'>Stream / branch debug</div>
              <div className='rounded-full bg-black/5 px-2 py-0.5 font-mono text-[10px] dark:bg-white/10'>
                {streamingRoot.activeIds.length} active
              </div>
            </div>

            <div className='mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[10px] leading-4'>
              <div>conv: {formatStreamDebugId(currentConversationId)}</div>
              <div>path tip: {formatStreamDebugId(selectedPath[selectedPath.length - 1])}</div>
              <div>global sending: {String(sendingState.sending)}</div>
              <div>global streaming: {String(sendingState.streaming)}</div>
              <div>compacting: {String(sendingState.compacting)}</div>
              <div>matches path: {matchingSelectedPathStreamCount}</div>
              <div>view stream: {formatStreamDebugId(currentViewStream?.id)}</div>
              <div>primary: {formatStreamDebugId(streamingRoot.primaryStreamId)}</div>
              <div>view active: {String(streamState.active)}</div>
              <div>view events: {streamState.events.length}</div>
              <div>view buf: {streamState.buffer.length}</div>
              <div>view think: {streamState.thinkingBuffer.length}</div>
            </div>

            <div className='mt-2 rounded-lg bg-black/5 p-2 font-mono text-[10px] leading-4 break-all dark:bg-white/5'>
              <div className='mb-1 text-[9px] uppercase tracking-wider text-neutral-500 dark:text-neutral-400'>
                selectedPath
              </div>
              <div>{selectedPathDebugLabel}</div>
            </div>

            <div className='mt-3 max-h-[28vh] space-y-2 overflow-y-auto pr-1'>
              {streamDebugRows.length === 0 ? (
                <div className='rounded-lg border border-dashed border-black/10 px-3 py-2 text-[10px] text-neutral-500 dark:border-white/10 dark:text-neutral-400'>
                  No streams in Redux.
                </div>
              ) : (
                streamDebugRows.map(stream => (
                  <div
                    key={stream.id}
                    className={`rounded-lg border p-2 font-mono text-[10px] leading-4 ${
                      stream.isCurrentView
                        ? 'border-blue-500/50 bg-blue-500/10'
                        : stream.active
                          ? 'border-emerald-500/30 bg-emerald-500/5'
                          : 'border-black/10 bg-black/5 dark:border-white/10 dark:bg-white/5'
                    }`}
                  >
                    <div className='flex flex-wrap items-center gap-1.5'>
                      <span className='font-semibold'>{formatStreamDebugId(stream.id)}</span>
                      <span className='rounded bg-black/10 px-1.5 py-0.5 dark:bg-white/10'>{stream.streamType}</span>
                      {stream.active && (
                        <span className='rounded bg-emerald-500/20 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300'>
                          active
                        </span>
                      )}
                      {stream.finished && <span className='rounded bg-neutral-500/20 px-1.5 py-0.5'>finished</span>}
                      {stream.isPrimary && (
                        <span className='rounded bg-violet-500/20 px-1.5 py-0.5 text-violet-700 dark:text-violet-300'>
                          primary
                        </span>
                      )}
                      {stream.isCurrentView && (
                        <span className='rounded bg-blue-500/20 px-1.5 py-0.5 text-blue-700 dark:text-blue-300'>
                          currentView
                        </span>
                      )}
                      {stream.rootInSelectedPath && (
                        <span className='rounded bg-amber-500/20 px-1.5 py-0.5 text-amber-700 dark:text-amber-300'>
                          root∈path
                        </span>
                      )}
                    </div>

                    <div className='mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5'>
                      <div>conv: {formatStreamDebugId(stream.conversationId)}</div>
                      <div>root: {formatStreamDebugId(stream.rootMessageId)}</div>
                      <div>origin: {formatStreamDebugId(stream.originMessageId)}</div>
                      <div>parentStream: {formatStreamDebugId(stream.parentStreamId)}</div>
                      <div>msg: {formatStreamDebugId(stream.messageId)}</div>
                      <div>streamMsg: {formatStreamDebugId(stream.streamingMessageId)}</div>
                      <div>last: {stream.lastEventLabel}</div>
                      <div>buf: {stream.bufferLength}</div>
                      <div>think: {stream.thinkingLength}</div>
                      <div>events: {stream.eventCount}</div>
                      <div>tools: {stream.toolCallCount}</div>
                    </div>

                    {stream.error && (
                      <div className='mt-1 rounded bg-red-500/10 px-1.5 py-1 text-red-700 dark:text-red-300'>
                        err: {stream.error}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div> */}
    </motion.div>
  )
}

export default Chat
