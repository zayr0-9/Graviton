import type { ContentBlock, HookRunRecord, StreamEvent } from '@/features/chats/chatTypes'
import type { ChatErrorActionKind, ChatErrorEnvelope } from '../../../../../shared/chatErrors'
import type { MessageId } from '../../../../../shared/types'
import type { RootState } from '@/store/store'
import 'katex/dist/katex.min.css'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createSelector } from '@reduxjs/toolkit'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import { useNavigate } from 'react-router-dom'
import { useSelector } from 'react-redux'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { Check, X } from 'lucide-react'
import { AUTO_COMPACTION_NOTE, fetchMcpTools } from '../../features/chats/chatActions'
import { chatSliceActions } from '../../features/chats/chatSlice'
import {
  appendAttachedImagePathMetadata,
  extractAttachedImagePaths,
  stripAttachedImagePathMetadata,
} from '../../features/chats/attachedImagePaths'
import { useAppDispatch } from '../../hooks/redux'
import { useIsMobile } from '../../hooks/useMediaQuery'
import { environment, localApi } from '../../utils/api'
import { ChatErrorBubble } from '../ChatErrorBubble/ChatErrorBubble'
import { useHtmlIframeRegistry } from '../HtmlIframeRegistry/HtmlIframeRegistry'
import { ImageModal } from '../ImageModal/ImageModal'
import { MarkdownLink } from '../MarkdownLink/MarkdownLink'
import { MermaidDiagram, getMermaidSource, isMermaidCodeBlock, prepareMermaidMarkdown } from '../MermaidDiagram'
import { TextArea } from '../TextArea/TextArea'
import {
  type CustomChatTheme,
  createDefaultCustomChatTheme,
  getCustomChatThemeEnabled,
  getMarkdownThemeVars,
  getStoredCustomChatTheme,
  getThemeModeColor,
  resolveRoleThemeKey,
} from '../ThemeManager/themeConfig'
import { ContextInjectionCard, type ContextInjectionCardEntry } from './ContextInjectionCard'
import { HookActivityCard } from './HookActivityCard'
import { MessageActions } from './MessageActions'
import { Badge, DisclosurePanel, DisclosureRow } from './messagePrimitives'
import { ToolCallGroupCard, type McpViewerPayload } from './ToolCallGroupCard'
import {
  buildToolCallGroupsFromBlocks,
  buildToolCallGroupsFromStream,
  COLLAPSED_CONTENT_WORD_LIMIT,
  contentBlocksToEditableText,
  editableTextToContentBlocks,
  extractAssistantTextsFromResponsesOutputItems,
  extractHtmlFromToolResult,
  extractReasoningTextsFromResponsesOutputItems,
  FAST_COLOR_TRANSITION_CLASS,
  FOCUS_RING_CLASS,
  getChatFontSizeOffsetStyle,
  isProcessOnlyBlockSet,
  MESSAGE_BLOCK_INSET_CLASS,
  MESSAGE_BLOCK_STACK_CLASS,
  MESSAGE_IMAGE_CLASS,
  MESSAGE_IMAGE_WRAPPER_CLASS,
  normalizeReasoningTextForComparison,
  PROCESS_RUN_GROUP_MIN_ITEMS,
  REASONING_TEXT_MARKDOWN_CLASS,
  SHARED_TEXT_MARKDOWN_CLASS,
  TEXT_DETAIL_CLASS,
  TEXT_LABEL_CLASS,
  TEXT_MICRO_CLASS,
  TEXT_NANO_CLASS,
  type ToolCallRenderGroup,
} from './chatMessageShared'

type MessageRole = 'user' | 'assistant' | 'system' | 'ex_agent' | 'tool'

type ChatMessageWidth =
  | 'max-w-sm'
  | 'max-w-md'
  | 'max-w-lg'
  | 'max-w-xl'
  | 'max-w-2xl'
  | 'max-w-3xl'
  | 'w-full'
  | 'w-3/5'

interface ChatMessageProps {
  id: string
  role: MessageRole
  /**
   * Plain text of the message. User rows render it as their prose. Assistant rows use it
   * only as a fallback when neither `contentBlocks` nor `streamEvents` is present.
   */
  content: string
  contentBlocks?: ContentBlock[]
  streamEvents?: StreamEvent[]
  hookRuns?: HookRunRecord[]
  timestamp?: string | Date
  onEdit?: (id: string, newContent: string, newContentBlocks?: ContentBlock[]) => void
  onBranch?: (id: string, newContent: string, newContentBlocks?: ContentBlock[]) => void
  onDelete?: (id: string) => void
  onCopy?: (content: string) => void
  onResend?: (id: string) => void
  onAddToNote?: (text: string) => void
  onExplainFromSelection?: (id: string, newContent: string) => void
  onOpenToolHtmlModal?: (key?: string) => void
  onOpenSubagentTranscript?: (toolCallId: string) => void
  isEditing?: boolean
  width: ChatMessageWidth
  /** When true (default) user rows draw a tinted surface. When false every row is flat. */
  colored?: boolean
  modelName?: string
  className?: string
  artifacts?: string[]
  showInlineActions?: boolean
  /** Font size offset in pixels applied to every block through `calc(1em + Npx)`. */
  fontSizeOffset?: number
  /** Group long consecutive reasoning/tool runs into one "Agent steps" disclosure. */
  groupToolReasoningRuns?: boolean
  /** Display-only projection; canonical tool results remain complete. */
  truncateToolOutput?: boolean
  customTheme?: CustomChatTheme
  customThemeEnabled?: boolean
  isDarkMode?: boolean
  onEditingStateChange?: (id: string, isEditing: boolean, mode: 'edit' | 'branch' | null) => void
  onLayoutChange?: () => void
  onHookRunsUpdated?: (messageId: string, runs: HookRunRecord[]) => void
  onHookRunsSettled?: () => void
  userTurnElapsedLabel?: string
  undoState?: {
    available: boolean
    fileCount: number
    restoring?: boolean
    restored?: boolean
    error?: string | null
  }
  onUndoStreamEdits?: () => void
  /**
   * What the button on a PERSISTED error bubble (tier 1) does.
   *
   * Redux is not persisted, so after a reload a server-written `ErrorBlock` row is the ONLY
   * surface a failure has. Without this the bubble draws no button at all
   * (`ChatErrorBubble` requires `onAction` to render one) and every reloaded error is a dead
   * end. `Chat` supplies it, because only the container knows what `retry` / `sign_in` mean.
   */
  onChatErrorAction?: (kind: ChatErrorActionKind, messageId: MessageId, envelope: ChatErrorEnvelope) => void
}

type MoreMenuPlacement = {
  top: number
  left: number
  width: number
  openUp: boolean
}

type ProcessEntryType = 'tool' | 'reasoning'

interface MessageRenderItem {
  key: string
  kind: 'process' | 'other'
  processType?: ProcessEntryType
  ignoreForProcessRunGrouping?: boolean
  node: React.ReactNode
}

// Memoized id-indexed lookups shared across all ChatMessage instances. Replaces the previous
// per-instance `.find()` selectors, which re-ran an O(N) scan of the whole message/conversation
// list on EVERY redux dispatch (i.e. every stream token) for every mounted message.
const selectMessageByIdMap = createSelector(
  (state: RootState) => state.chat.conversation.messages,
  messages => {
    const map = new Map<string, (typeof messages)[number]>()
    for (const message of messages) map.set(String(message.id), message)
    return map
  }
)
const selectConversationByIdMap = createSelector(
  (state: RootState) => state.conversations.items,
  items => {
    const map = new Map<string, (typeof items)[number]>()
    for (const conversation of items) map.set(String(conversation.id), conversation)
    return map
  }
)

// Copy helper closes over nothing component-specific (browser APIs only), so it lives at module
// scope. This lets the markdown block/code renderers below also live at module scope with a stable
// identity — otherwise ReactMarkdown remounts every <pre>/<code> subtree on each render.
const copyRichText = async (plainText: string, html?: string): Promise<boolean> => {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.write === 'function' && html) {
      const htmlBlob = new Blob([html], { type: 'text/html' })
      const textBlob = new Blob([plainText], { type: 'text/plain' })
      const clipboardItem = new ClipboardItem({
        'text/html': htmlBlob,
        'text/plain': textBlob,
      })
      await navigator.clipboard.write([clipboardItem])
      return true
    }
  } catch {
    // Fall through to plain text copy
  }

  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(plainText)
      return true
    }
  } catch {
    // fall through to execCommand fallback
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = plainText
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    textarea.style.left = '-9999px'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    // Deprecated API used intentionally as a safe fallback when the Clipboard API is unavailable.
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch (err) {
    console.error('Copy fallback failed:', err)
    return false
  }
}

// Fenced code block with a stable copy action. Module-scoped so its identity is stable.
const PreRenderer: React.FC<any> = ({ children, className, ...props }) => {
  const [copied, setCopied] = useState(false)
  const preRef = useRef<HTMLPreElement | null>(null)

  const codeChild = React.Children.toArray(children).find(isMermaidCodeBlock)
  if (codeChild) {
    return <MermaidDiagram chart={getMermaidSource(codeChild)} />
  }

  const handleCopyCode = async () => {
    try {
      const plain = preRef.current?.innerText ?? ''
      if (!plain) return
      const ok = await copyRichText(plain)
      if (!ok) throw new Error('Clipboard write failed')
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.error('Failed to copy code block:', err)
    }
  }

  return (
    <div className='chat-markdown-code-block not-prose my-3 overflow-hidden rounded-2xl'>
      <div className='chat-markdown-code-header flex h-8 items-center justify-end px-2'>
        <button
          type='button'
          onMouseDown={event => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onClick={event => {
            event.stopPropagation()
            void handleCopyCode()
          }}
          className={`chat-markdown-code-copy-button inline-flex h-6 items-center gap-1 rounded-full px-2.5 ${TEXT_MICRO_CLASS} font-medium ${FAST_COLOR_TRANSITION_CLASS} ${FOCUS_RING_CLASS}`}
          aria-label={copied ? 'Copied' : 'Copy code'}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre
        ref={preRef}
        className={`not-prose thin-scrollbar m-0 overflow-auto bg-transparent px-3 py-2.5 text-[0.85em] leading-[1.5] ring-0 outline-none select-text ${className ?? ''}`}
        {...props}
      >
        {children}
      </pre>
    </div>
  )
}

const CodeRenderer: React.FC<any> = ({ inline, className, children, ...props }) => {
  if (inline) {
    return (
      <code className='chat-markdown-inline-code inline rounded-md px-1 py-0.5 whitespace-pre-wrap' {...props}>
        {children}
      </code>
    )
  }
  return (
    <code className={className} {...props}>
      {children}
    </code>
  )
}

// Stable components map so ReactMarkdown does not treat its renderers as changed each render.
const MARKDOWN_COMPONENTS = { pre: PreRenderer, code: CodeRenderer, a: MarkdownLink }

/**
 * R5 — `excludeFromContext` means EVERYWHERE, not just the server's history builder.
 *
 * An `ErrorBlock` is prose the APP wrote to explain a failure. It is not something the model
 * said. Every path that treats `content_blocks` as model output — "is this message empty",
 * copy-to-clipboard, the editable text round-trip, any token estimate — must read the
 * filtered view below and never `contentBlocks` directly, or the user copies "I couldn't
 * reach the provider" as if the assistant had said it.
 */
const isExcludedFromModelOutput = (block: ContentBlock | undefined | null): boolean => {
  if (!block) return true
  if (block.type === 'error') return true
  return (block as { excludeFromContext?: boolean }).excludeFromContext === true
}

const truncateWords = (text: string | any, maxWords: number = COLLAPSED_CONTENT_WORD_LIMIT): string => {
  const content = typeof text === 'object' ? JSON.stringify(text) : String(text)
  const words = content.split(/\s+/)
  if (words.length <= maxWords) return content
  return words.slice(0, maxWords).join(' ') + '...'
}

const getCollapsedReasoningSummary = (text: string | any): string => {
  const content = typeof text === 'object' ? JSON.stringify(text) : String(text)
  const firstBoldSection = content.match(/\*\*([\s\S]*?)\*\*/)?.[1]?.trim()
  if (firstBoldSection) return firstBoldSection.replace(/\s+/g, ' ')
  return truncateWords(content)
}

const isProcessRunSeparatorText = (text: string): boolean => {
  const trimmed = text.trim()
  if (!trimmed) return true
  // Keep obviously structured markdown content out of process-run grouping.
  if (trimmed.startsWith('#') || trimmed.startsWith('```')) return false
  // Short connective text (even if multiline) should not break an Agent Steps run.
  const words = trimmed.split(/\s+/).filter(Boolean)
  return words.length <= 12
}

const parseResponsesToolArgs = (rawArgs: unknown): unknown => {
  if (typeof rawArgs !== 'string') return rawArgs
  try {
    return rawArgs ? JSON.parse(rawArgs) : rawArgs
  } catch {
    return rawArgs
  }
}

const ROLE_LABEL: Record<string, string> = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
  ex_agent: 'Claude Code',
}

const ROLE_LABEL_CLASS: Record<string, string> = {
  user: 'text-indigo-700 dark:text-yPurple-50',
  assistant: 'text-lime-800 dark:text-yBrown-50',
  system: 'text-purple-500 dark:text-purple-300',
  ex_agent: 'text-orange-700 dark:text-orange-400',
}

const EXPLAIN_BUTTON_CLASS = `flex h-8 w-8 items-center justify-center rounded-full bg-black/[0.05] text-neutral-600 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white/[0.06] dark:text-neutral-300 ${FAST_COLOR_TRANSITION_CLASS} ${FOCUS_RING_CLASS}`

const FLOATING_SURFACE_CLASS =
  'rounded-2xl bg-white/95 backdrop-blur-xl ring-1 ring-black/[0.06] dark:bg-yBlack-900/95 dark:ring-white/[0.08]'

const ChatMessage: React.FC<ChatMessageProps> = React.memo(
  ({
    id,
    role,
    content,
    contentBlocks,
    streamEvents,
    hookRuns,
    onEdit,
    onBranch,
    onDelete,
    onCopy,
    onAddToNote,
    onExplainFromSelection,
    onOpenToolHtmlModal,
    onOpenSubagentTranscript,
    isEditing = false,
    width = 'w-3/5',
    colored = true,
    modelName,
    className,
    artifacts = [],
    showInlineActions = true,
    fontSizeOffset = 0,
    groupToolReasoningRuns = false,
    truncateToolOutput = true,
    customTheme: customThemeProp,
    customThemeEnabled: customThemeEnabledProp,
    isDarkMode: isDarkModeProp,
    onEditingStateChange,
    onLayoutChange,
    onHookRunsUpdated,
    onHookRunsSettled,
    userTurnElapsedLabel,
    undoState,
    onUndoStreamEdits,
    onChatErrorAction,
  }) => {
    const dispatch = useAppDispatch()
    const navigate = useNavigate()
    const isMobile = useIsMobile()
    const isDarkMode =
      typeof isDarkModeProp === 'boolean'
        ? isDarkModeProp
        : typeof document !== 'undefined'
          ? document.documentElement.classList.contains('dark')
          : false
    const customTheme = customThemeProp ?? getStoredCustomChatTheme()
    const customThemeEnabled =
      typeof customThemeEnabledProp === 'boolean' ? customThemeEnabledProp : getCustomChatThemeEnabled()

    const [editingState, setEditingState] = useState(isEditing)
    const visibleContent = useMemo(
      () => (role === 'user' ? stripAttachedImagePathMetadata(content) : content),
      [content, role]
    )
    const [editContent, setEditContent] = useState(visibleContent)
    const [editMode, setEditMode] = useState<'edit' | 'branch'>('edit')
    const [copied, setCopied] = useState(false)
    const [expandedBlocks, setExpandedBlocks] = useState<{
      toolCalls: Set<string>
      reasoning: Set<number>
      groupRuns: Set<string>
    }>({
      toolCalls: new Set(),
      reasoning: new Set(),
      groupRuns: new Set(),
    })
    const [showMoreMenu, setShowMoreMenu] = useState(false)
    const [moreMenuPlacement, setMoreMenuPlacement] = useState<MoreMenuPlacement | null>(null)
    const moreMenuRef = useRef<HTMLDivElement | null>(null)
    const [isHovering, setIsHovering] = useState(false)
    const moreButtonRef = useRef<HTMLDivElement | null>(null)
    const messageRef = useRef<HTMLDivElement | null>(null)

    const handleMobileMessageActivate = useCallback(() => {
      if (!isMobile) return
      setIsHovering(true)
    }, [isMobile])

    const [contextMenuOpen, setContextMenuOpen] = useState(false)
    const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(null)
    const [selectedText, setSelectedText] = useState<string>('')
    const floatingActionsRef = useRef<HTMLDivElement | null>(null)
    const [selectedArtifactUrl, setSelectedArtifactUrl] = useState<string | null>(null)
    const streamToolGroupsByIndex = useMemo(() => buildToolCallGroupsFromStream(streamEvents), [streamEvents])
    const contentToolGroupsByIndex = useMemo(() => buildToolCallGroupsFromBlocks(contentBlocks), [contentBlocks])
    const htmlRegistry = useHtmlIframeRegistry()
    const [showExplainInput, setShowExplainInput] = useState(false)
    const [explainInputValue, setExplainInputValue] = useState('')
    const explainInputPosition = useRef<{ x: number; y: number } | null>(null)
    const explainInputRef = useRef<HTMLDivElement | null>(null)
    const [explainInputFixedPosition, setExplainInputFixedPosition] = useState<{
      x: number
      y: number
      width: number
    } | null>(null)
    const [mcpLoadState, setMcpLoadState] = useState<Record<string, boolean>>({})
    const [mcpReloadTokens, setMcpReloadTokens] = useState<Record<string, number>>({})
    const hasStreamEvents = Array.isArray(streamEvents) && streamEvents.length > 0
    const isStreamingRender = id === 'streaming' || hasStreamEvents
    const handleExpandTransitionEnd = useCallback(() => {
      onLayoutChange?.()
    }, [onLayoutChange])

    const messageData = useSelector((state: RootState) => selectMessageByIdMap(state).get(String(id)))
    const isCompactionSummary = messageData?.note === AUTO_COMPACTION_NOTE
    const toolDefinitions = useSelector((state: RootState) => state.chat.tools)
    const conversationId = messageData?.conversation_id ?? null
    const projectId = useSelector((state: RootState) =>
      conversationId ? (selectConversationByIdMap(state).get(String(conversationId))?.project_id ?? null) : null
    )

    const handleLoadMcpApp = useCallback(
      async (serverName: string, reloadKey: string) => {
        if (environment !== 'electron') return
        setMcpLoadState(prev => ({ ...prev, [reloadKey]: true }))
        try {
          await localApi.post(`/mcp/servers/${encodeURIComponent(serverName)}/start`)
          await localApi.post('/mcp/refresh-tools')
          dispatch(fetchMcpTools())
          setMcpReloadTokens(prev => ({ ...prev, [reloadKey]: (prev[reloadKey] || 0) + 1 }))
        } catch (err) {
          console.error('[McpApp] Failed to load server', err)
        } finally {
          setMcpLoadState(prev => ({ ...prev, [reloadKey]: false }))
        }
      },
      [dispatch]
    )

    const undoLabel = undoState?.restored
      ? `Restored ${undoState.fileCount} file${undoState.fileCount === 1 ? '' : 's'}`
      : undoState?.restoring
        ? 'Restoring edits...'
        : undoState?.available
          ? `Undo ${undoState.fileCount} file${undoState.fileCount === 1 ? '' : 's'}`
          : undefined

    // R5: the model-output view of this message's blocks. Everything that counts, filters,
    // copies or round-trips `content_blocks` as "what the assistant produced" reads this;
    // only the RENDERER walks `contentBlocks` itself, because the bubble must still be drawn.
    // A fresh array also keeps `contentBlocksToEditableText`'s in-place `.sort()` off the prop.
    const modelOutputBlocks = useMemo(
      () => (Array.isArray(contentBlocks) ? contentBlocks.filter(b => !isExcludedFromModelOutput(b)) : undefined),
      [contentBlocks]
    )
    const hasExcludedBlocks = useMemo(
      () => Array.isArray(contentBlocks) && contentBlocks.some(isExcludedFromModelOutput),
      [contentBlocks]
    )
    // A user row only ever carries `context_injection` blocks (Chat.tsx keeps the rest out), so
    // its editable text is always the plain `content`. Assistant rows round-trip their blocks.
    const editableSourceBlocks = role === 'user' ? undefined : modelOutputBlocks
    const hasEditableBlocks = Boolean(editableSourceBlocks && editableSourceBlocks.length > 0)

    const hasContent = useMemo(() => {
      const hasSimpleContent = visibleContent && visibleContent.trim().length > 0
      // An ErrorBlock never makes a message non-empty: a row whose only block is a failure
      // explanation has no model output to copy, edit or branch from.
      const hasBlockContent =
        modelOutputBlocks &&
        modelOutputBlocks.some(
          b => (b.type === 'text' && b.content && b.content.trim().length > 0) || b.type === 'image'
        )
      return hasSimpleContent || hasBlockContent
    }, [visibleContent, modelOutputBlocks])

    /**
     * R5: the string the clipboard gets. Identical to `visibleContent` for every ordinary
     * message — the block-derived path engages ONLY when an excluded block is present, so an
     * error bubble's text can never be copied as "what the assistant said".
     */
    const copyText = useMemo(() => {
      if (!hasExcludedBlocks) return visibleContent
      const fromBlocks =
        modelOutputBlocks && modelOutputBlocks.length > 0 ? contentBlocksToEditableText(modelOutputBlocks) : ''
      const normalized = role === 'user' ? stripAttachedImagePathMetadata(fromBlocks) : fromBlocks
      return normalized.trim().length > 0 ? normalized : ''
    }, [hasExcludedBlocks, modelOutputBlocks, role, visibleContent])

    const canBranchMessage = role === 'user' || (role === 'assistant' && messageData?.parent_id == null)

    const getEditableText = () =>
      hasEditableBlocks
        ? stripAttachedImagePathMetadata(contentBlocksToEditableText(editableSourceBlocks as ContentBlock[]))
        : visibleContent

    const handleEdit = () => {
      dispatch(chatSliceActions.editingBranchSet(false))
      setEditingState(true)
      setEditContent(getEditableText())
      setEditMode('edit')
      onEditingStateChange?.(id, true, 'edit')
    }

    const handleBranch = () => {
      dispatch(chatSliceActions.editingBranchSet(true))
      setEditingState(true)
      setEditContent(getEditableText())
      setEditMode('branch')
      onEditingStateChange?.(id, true, 'branch')
    }

    const handleSave = () => {
      const trimmedContent = editContent.trim()
      if (!trimmedContent) {
        console.warn('Cannot save empty message')
        return
      }
      if (onEdit && trimmedContent !== visibleContent) {
        const newContentBlocks = hasEditableBlocks ? editableTextToContentBlocks(trimmedContent) : undefined
        onEdit(id, appendAttachedImagePathMetadata(trimmedContent, extractAttachedImagePaths(content)), newContentBlocks)
      }
      dispatch(chatSliceActions.editingBranchSet(false))
      setEditingState(false)
      onEditingStateChange?.(id, false, 'edit')
    }

    const handleSaveBranch = () => {
      if (onBranch) {
        const trimmedContent = editContent.trim()
        const newContentBlocks = hasEditableBlocks ? editableTextToContentBlocks(trimmedContent) : undefined
        onBranch(id, appendAttachedImagePathMetadata(trimmedContent, extractAttachedImagePaths(content)), newContentBlocks)
      }
      dispatch(chatSliceActions.editingBranchSet(false))
      // Clear only drafts owned by this branch edit after branching is initiated.
      dispatch(chatSliceActions.imageDraftsCleared({ target: { kind: 'branch', messageId: id } }))
      setEditingState(false)
      onEditingStateChange?.(id, false, 'branch')
    }

    const handleCancel = () => {
      setEditContent(visibleContent)
      dispatch(chatSliceActions.editingBranchSet(false))
      if (editMode === 'branch') {
        dispatch(chatSliceActions.imageDraftsCleared({ target: { kind: 'branch', messageId: id } }))
        // Restore any artifacts deleted during branch editing
        dispatch(chatSliceActions.messageArtifactsRestoreFromBackup({ messageId: id }))
      }
      setEditingState(false)
      onEditingStateChange?.(id, false, editMode)
      setEditMode('edit')
    }

    const handleCopy = async () => {
      const imageBlock = contentBlocks?.find(b => b.type === 'image')

      if (imageBlock && imageBlock.type === 'image' && imageBlock.url) {
        try {
          // Fetch image as blob to ensure download (avoids cross-origin issues with download attribute)
          const response = await fetch(imageBlock.url)
          const blob = await response.blob()
          const blobUrl = window.URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = blobUrl

          let extension = 'png'
          if (imageBlock.mimeType) {
            const mimeParts = imageBlock.mimeType.split('/')
            if (mimeParts.length > 1) extension = mimeParts[1]
          } else if (blob.type) {
            const parts = blob.type.split('/')
            if (parts.length > 1) extension = parts[1]
          }

          link.download = `generated-image-${Date.now()}.${extension}`
          document.body.appendChild(link)
          link.click()
          document.body.removeChild(link)
          window.URL.revokeObjectURL(blobUrl)

          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
          return
        } catch (err) {
          console.error('Failed to download image:', err)
          try {
            window.open(imageBlock.url, '_blank')
          } catch (e) {
            console.error('Failed to open fallback link', e)
          }
        }
      }

      // R5: nothing the model produced -> nothing to copy. Do not fall back to the raw
      // `content` string, which on an ErrorBlock row would be the failure explanation.
      if (hasExcludedBlocks && !copyText) return

      if (onCopy) onCopy(copyText)

      // Rendered HTML for rich paste support. `.prose` is only ever a rendered-markdown node, so
      // the error bubble (a sibling, never inside one) cannot leak into the rich-text flavour.
      let html: string | undefined
      const messageEl = document.getElementById(`message-${id}`)
      if (messageEl) {
        const proseEl = messageEl.querySelector('.prose')
        if (proseEl) html = proseEl.innerHTML
      }

      const ok = await copyRichText(copyText, html)
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      } else {
        console.error('Failed to copy message')
      }
    }

    const handleDelete = () => {
      if (onDelete) onDelete(id)
    }

    const handleDeleteArtifact = (index: number) => {
      dispatch(chatSliceActions.messageArtifactDeleted({ messageId: id, index }))
    }

    const handleArtifactClick = (url: string) => setSelectedArtifactUrl(url)
    const handleCloseArtifactModal = () => setSelectedArtifactUrl(null)

    const handleContextMenu = (e: React.MouseEvent) => {
      e.preventDefault()
      const selection = window.getSelection()
      const rawText = selection?.toString() || ''
      const container = messageRef.current
      const anchorNode = selection?.anchorNode ?? null
      const focusNode = selection?.focusNode ?? null
      const selectionInsideMessage =
        Boolean(rawText) &&
        Boolean(container) &&
        Boolean((anchorNode && container?.contains(anchorNode)) || (focusNode && container?.contains(focusNode)))
      const text = selectionInsideMessage ? rawText.trim() : ''

      setSelectedText(text)
      setContextMenuPosition({ x: e.clientX, y: e.clientY })
      setContextMenuOpen(true)
      explainInputPosition.current = { x: e.clientX, y: e.clientY }
    }

    const handleSendExplainInput = () => {
      if (onExplainFromSelection && selectedText && explainInputValue.trim()) {
        const branchContent = `${explainInputValue.trim()}\n\nSelected text:\n\`\`\`\n${selectedText}\n\`\`\``
        onExplainFromSelection(id, branchContent)
        setShowExplainInput(false)
        setExplainInputFixedPosition(null)
        setExplainInputValue('')
        setSelectedText('')
      }
    }

    const handleCancelExplainInput = () => {
      setShowExplainInput(false)
      setExplainInputFixedPosition(null)
      setExplainInputValue('')
      setSelectedText('')
    }

    const handleCopySelection = async () => {
      if (!selectedText) return
      const ok = await copyRichText(selectedText)
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      } else {
        console.error('Failed to copy selection')
      }
    }

    const handleExplainSelection = (position?: { x: number; y: number }) => {
      if (!selectedText || !onExplainFromSelection) return
      if (position) {
        explainInputPosition.current = { ...position }
      } else if (contextMenuPosition) {
        explainInputPosition.current = { ...contextMenuPosition }
      }
      setExplainInputValue('')
      setExplainInputFixedPosition(null)
      setShowExplainInput(true)
    }

    const handleAddSelectionToNote = () => {
      if (!selectedText || !onAddToNote) return
      onAddToNote(selectedText)
    }

    // Get adjusted position for explain input to avoid viewport overflow
    const getAdjustedExplainInputPosition = useCallback(() => {
      if (!explainInputPosition.current || !explainInputRef.current) return null

      const inputRect = explainInputRef.current.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const offset = 12
      const horizontalMargin = 6
      const chatPaneRect = messageRef.current
        ?.closest<HTMLElement>('[data-chat-pane-surface="true"]')
        ?.getBoundingClientRect()
      const availableLeft = Math.max(horizontalMargin, (chatPaneRect?.left ?? 0) + horizontalMargin)
      const availableRight = Math.min(
        viewportWidth - horizontalMargin,
        (chatPaneRect?.right ?? viewportWidth) - horizontalMargin
      )
      const width = Math.max(0, availableRight - availableLeft)

      if (isMobile) {
        return { x: availableLeft, y: (viewportHeight - inputRect.height) / 2, width }
      }

      let { x, y } = explainInputPosition.current
      x = x - width / 2
      x = Math.min(Math.max(x, availableLeft), availableRight - width)

      const aboveY = y - inputRect.height - offset
      const belowY = y + offset
      if (aboveY >= 10) {
        y = aboveY
      } else if (belowY + inputRect.height <= viewportHeight - 10) {
        y = belowY
      } else {
        y = Math.max(10, viewportHeight - inputRect.height - 10)
      }

      return { x, y: Math.max(10, y), width }
    }, [isMobile])

    useEffect(() => {
      if (!showExplainInput) {
        setExplainInputFixedPosition(null)
        return
      }
      const updatePosition = () => {
        const adjusted = getAdjustedExplainInputPosition()
        if (adjusted) setExplainInputFixedPosition(adjusted)
      }
      const frame = window.requestAnimationFrame(updatePosition)
      window.addEventListener('resize', updatePosition)
      return () => {
        window.cancelAnimationFrame(frame)
        window.removeEventListener('resize', updatePosition)
      }
    }, [showExplainInput, getAdjustedExplainInputPosition])

    // Click outside handler for explain input
    useEffect(() => {
      if (!showExplainInput) return
      const handleClickOutside = (event: MouseEvent) => {
        if (explainInputRef.current && !explainInputRef.current.contains(event.target as Node)) {
          handleCancelExplainInput()
        }
      }
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [showExplainInput])

    // Focus explain textarea without scrolling the virtual list
    useEffect(() => {
      if (!showExplainInput) return
      const focusTimer = window.setTimeout(() => {
        const textarea = explainInputRef.current?.querySelector('textarea') as HTMLTextAreaElement | null
        if (!textarea) return
        try {
          textarea.focus({ preventScroll: true })
        } catch {
          textarea.focus()
        }
      }, 0)
      return () => window.clearTimeout(focusTimer)
    }, [showExplainInput])

    const getEstimatedMoreMenuSize = useCallback(() => {
      if (typeof window === 'undefined') return { width: 320, height: 440 }
      const breakpointWidth = window.innerWidth >= 768 ? 320 : window.innerWidth >= 640 ? 288 : 256
      const maxAllowedWidth = Math.max(180, window.innerWidth - 16)
      return { width: Math.min(breakpointWidth, maxAllowedWidth), height: 440 }
    }, [])

    const computeMoreMenuPlacement = useCallback((): MoreMenuPlacement | null => {
      if (typeof window === 'undefined') return null
      const trigger = moreButtonRef.current
      if (!trigger) return null

      const rect = trigger.getBoundingClientRect()
      const { width, height } = getEstimatedMoreMenuSize()
      const margin = 8
      const minLeft = margin
      const maxLeft = Math.max(margin, window.innerWidth - width - margin)
      const left = Math.min(Math.max(rect.right - width, minLeft), maxLeft)
      const spaceBelow = window.innerHeight - rect.bottom - margin
      const spaceAbove = rect.top - margin
      const openUp = spaceBelow < height && spaceAbove > spaceBelow
      const preferredTop = openUp ? rect.top - height - 6 : rect.bottom + 6
      const minTop = margin
      const maxTop = Math.max(margin, window.innerHeight - height - margin)
      const top = Math.min(Math.max(preferredTop, minTop), maxTop)
      return { top, left, width, openUp }
    }, [getEstimatedMoreMenuSize])

    const handleMoreClick = () => {
      if (showMoreMenu) {
        setShowMoreMenu(false)
        setMoreMenuPlacement(null)
        return
      }
      const placement = computeMoreMenuPlacement()
      if (!placement) return
      setMoreMenuPlacement(placement)
      setShowMoreMenu(true)
    }

    // Click outside handler for more menu
    useEffect(() => {
      const handleClickOutside = (event: MouseEvent) => {
        const target = event.target as Node
        const clickedMenu = Boolean(moreMenuRef.current && moreMenuRef.current.contains(target))
        const clickedTrigger = Boolean(moreButtonRef.current && moreButtonRef.current.contains(target))
        if (!clickedMenu && !clickedTrigger) {
          setShowMoreMenu(false)
          setMoreMenuPlacement(null)
        }
      }
      if (showMoreMenu) document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [showMoreMenu])

    // Close More menu when context menu opens to avoid conflicts
    useEffect(() => {
      if (contextMenuOpen) {
        setShowMoreMenu(false)
        setMoreMenuPlacement(null)
      }
    }, [contextMenuOpen])

    // Click outside / Escape handler for floating MessageActions
    const closeFloatingActions = useCallback(() => setContextMenuOpen(false), [])
    useEffect(() => {
      if (!contextMenuOpen) return
      const handleClickOutside = (event: MouseEvent) => {
        if (floatingActionsRef.current && !floatingActionsRef.current.contains(event.target as Node)) {
          closeFloatingActions()
        }
      }
      const handleEscape = (event: KeyboardEvent) => {
        if (event.key === 'Escape') closeFloatingActions()
      }
      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('keydown', handleEscape)
      return () => {
        document.removeEventListener('mousedown', handleClickOutside)
        document.removeEventListener('keydown', handleEscape)
      }
    }, [contextMenuOpen, closeFloatingActions])

    // Mobile: hide inline actions when tapping outside the message
    useEffect(() => {
      if (!isMobile) return
      const handleTapOutside = (event: MouseEvent | TouchEvent) => {
        if (messageRef.current && !messageRef.current.contains(event.target as Node)) {
          setIsHovering(false)
        }
      }
      document.addEventListener('mousedown', handleTapOutside)
      document.addEventListener('touchstart', handleTapOutside)
      return () => {
        document.removeEventListener('mousedown', handleTapOutside)
        document.removeEventListener('touchstart', handleTapOutside)
      }
    }, [isMobile])

    // Keep portal menu anchored to the trigger while open
    useEffect(() => {
      if (!showMoreMenu) return
      const recomputePosition = () => {
        const placement = computeMoreMenuPlacement()
        if (placement) setMoreMenuPlacement(placement)
      }
      window.addEventListener('resize', recomputePosition)
      window.addEventListener('scroll', recomputePosition, true)
      return () => {
        window.removeEventListener('resize', recomputePosition)
        window.removeEventListener('scroll', recomputePosition, true)
      }
    }, [showMoreMenu, computeMoreMenuPlacement])

    // Tell the virtual list about disclosure changes across the whole expand transition.
    useEffect(() => {
      if (!onLayoutChange) return
      onLayoutChange()
      if (typeof window === 'undefined') return
      const rafId = window.requestAnimationFrame(() => onLayoutChange())
      const timeoutA = window.setTimeout(() => onLayoutChange(), 140)
      const timeoutB = window.setTimeout(() => onLayoutChange(), 320)
      return () => {
        window.cancelAnimationFrame(rafId)
        window.clearTimeout(timeoutA)
        window.clearTimeout(timeoutB)
      }
    }, [expandedBlocks, onLayoutChange])

    const toggleBlock = (type: 'toolCalls' | 'reasoning' | 'groupRuns', blockId: string | number) => {
      setExpandedBlocks(prev => {
        const next = { ...prev }
        const set = new Set<any>(prev[type] as Set<any>)
        if (set.has(blockId)) set.delete(blockId)
        else set.add(blockId)
        next[type] = set as any
        return next
      })
    }

    // ── Role surface ──────────────────────────────────────────────────────────────────

    const roleThemeKey = resolveRoleThemeKey(role)
    const roleTheme = customThemeEnabled ? customTheme.colors.messageRoles[roleThemeKey] : null
    const roleLabel = ROLE_LABEL[roleThemeKey] ?? 'Unknown'
    const roleLabelClass = roleTheme ? '' : (ROLE_LABEL_CLASS[roleThemeKey] ?? 'text-neutral-500')
    const roleLabelStyle: React.CSSProperties | undefined = roleTheme
      ? { color: getThemeModeColor(roleTheme.roleText, isDarkMode) }
      : undefined
    const isUserRow = role === 'user'
    const drawSurface = colored && isUserRow
    const surfaceClass = drawSurface && !roleTheme ? 'bg-neutral-100/80 dark:bg-white/[0.05]' : ''
    const surfaceStyle: React.CSSProperties | undefined =
      drawSurface && roleTheme ? { backgroundColor: getThemeModeColor(roleTheme.containerBg, isDarkMode) } : undefined

    const markdownThemeVars = getMarkdownThemeVars(
      customThemeEnabled ? customTheme : createDefaultCustomChatTheme(),
      isDarkMode
    )

    // Style object for content areas that scale with fontSizeOffset. Disclosure labels use
    // em-based sizes so they inherit it too.
    const messageContentStyle = getChatFontSizeOffsetStyle(fontSizeOffset)

    const renderMarkdownNode = ({
      key,
      markdown,
      className: markdownClassName,
      style,
      id: nodeId,
    }: {
      key: string
      markdown: string
      className: string
      style?: React.CSSProperties
      id?: string
    }) => (
      <div key={key} id={nodeId} className={markdownClassName} style={{ ...markdownThemeVars, ...style }}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }], rehypeKatex]}
          components={MARKDOWN_COMPONENTS}
        >
          {prepareMermaidMarkdown(markdown)}
        </ReactMarkdown>
      </div>
    )

    const renderImageNode = ({ key, url, onClick }: { key: string; url: string; onClick?: () => void }) => (
      <div key={key} className={MESSAGE_IMAGE_WRAPPER_CLASS}>
        <img
          src={url}
          alt='Generated image'
          className={onClick ? `${MESSAGE_IMAGE_CLASS} cursor-pointer` : MESSAGE_IMAGE_CLASS}
          onClick={onClick}
          loading='lazy'
        />
      </div>
    )

    // ── HTML viewer registry (on demand, never eager) ─────────────────────────────────

    const htmlRegistryEntriesMap = useMemo(() => {
      const entriesMap = new Map<string, { key: string; html: string; label: string; toolName?: string | null }>()
      // Only available after the message is persisted.
      if (hasStreamEvents) return entriesMap

      const normalizeHtml = (html: string) => html.trim()
      const addEntry = (key: string, html: string, label: string, toolName?: string | null) => {
        if (typeof html !== 'string') return
        const normalized = normalizeHtml(html)
        if (normalized.length > 0) entriesMap.set(key, { key, html: normalized, label, toolName: toolName ?? null })
      }

      const groupsSource = Array.isArray(contentBlocks) && contentBlocks.length > 0 ? contentToolGroupsByIndex : null
      if (groupsSource) {
        const seen = new Set<string>()
        groupsSource.forEach(group => {
          if (seen.has(group.id)) return
          seen.add(group.id)
          const htmlSeen = new Set<string>()
          const rawName = group.name || 'Tool Result'
          const toolLabel = rawName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
          const toolName = group.name ?? null
          const isHtmlRenderer = (group.name ?? '').toLowerCase() === 'html_renderer'
          if (isHtmlRenderer && typeof group.args?.html === 'string') {
            const normalized = normalizeHtml(group.args.html)
            if (normalized.length > 0) {
              htmlSeen.add(normalized)
              addEntry(`${id}-html-renderer-${group.id}`, normalized, toolLabel, toolName)
            }
          }
          group.results.forEach((result, resultIdx) => {
            const maybeHtml = extractHtmlFromToolResult(result.content)
            if (maybeHtml?.html) {
              const normalized = normalizeHtml(maybeHtml.html)
              if (normalized.length === 0 || htmlSeen.has(normalized)) return
              htmlSeen.add(normalized)
              addEntry(`${id}-${group.id}-result-${resultIdx}`, normalized, toolLabel, maybeHtml.toolName ?? toolName)
            }
          })
        })
      }
      return entriesMap
    }, [contentBlocks, contentToolGroupsByIndex, id, hasStreamEvents])

    const registerHtmlEntry = (entryKey: string) => {
      if (!htmlRegistry) return
      const entry = htmlRegistryEntriesMap.get(entryKey)
      if (entry) {
        htmlRegistry.registerEntry(entry.key, entry.html, entry.label, {
          conversationId,
          projectId,
          toolName: entry.toolName ?? null,
        })
      }
    }

    const registerAndOpenHtmlViewer = (entryKey: string) => {
      if (!htmlRegistry || !onOpenToolHtmlModal) return
      registerHtmlEntry(entryKey)
      onOpenToolHtmlModal(entryKey)
    }

    const registerAndOpenMcpViewer = (entryKey: string, payload: McpViewerPayload, label?: string | null) => {
      if (!htmlRegistry || !onOpenToolHtmlModal) return
      htmlRegistry.registerMcpEntry(entryKey, payload, label, { conversationId, projectId })
      onOpenToolHtmlModal(entryKey)
    }

    // Expanding a tool card registers its HTML entries so the viewer can open them later.
    const handleExpandToggle = (toggleKey: string, group: ToolCallRenderGroup) => {
      const isCurrentlyExpanded = expandedBlocks.toolCalls.has(toggleKey)
      if (!isCurrentlyExpanded && htmlRegistry) {
        if ((group.name ?? '').toLowerCase() === 'html_renderer' && typeof group.args?.html === 'string') {
          registerHtmlEntry(`${id}-html-renderer-${group.id}`)
        }
        group.results.forEach((result, resultIdx) => {
          if (extractHtmlFromToolResult(result.content)?.html) {
            registerHtmlEntry(`${id}-${group.id}-result-${resultIdx}`)
          }
        })
      }
      toggleBlock('toolCalls', toggleKey)
    }

    const renderToolCallGroupCard = (group: ToolCallRenderGroup, key: string) => {
      if (group.anchorIndex === -1) return null
      const toggleKey = `tool-group-${key}`
      return (
        <ToolCallGroupCard
          key={toggleKey}
          group={group}
          toggleKey={toggleKey}
          messageId={id}
          expanded={expandedBlocks.toolCalls.has(toggleKey)}
          onToggle={() => handleExpandToggle(toggleKey, group)}
          disableExpandTransition={isStreamingRender}
          onExpandTransitionEnd={handleExpandTransitionEnd}
          contentStyle={messageContentStyle}
          truncateToolOutput={truncateToolOutput}
          toolDefinitions={toolDefinitions}
          mcpLoadState={mcpLoadState}
          mcpReloadTokens={mcpReloadTokens}
          onLoadMcpApp={handleLoadMcpApp}
          canOpenViewer={Boolean(onOpenToolHtmlModal)}
          onOpenHtmlViewer={registerAndOpenHtmlViewer}
          onOpenMcpViewer={registerAndOpenMcpViewer}
          onOpenSubagentTranscript={onOpenSubagentTranscript}
          onNavigate={route => navigate(route)}
        />
      )
    }

    // ── Render items ──────────────────────────────────────────────────────────────────

    const buildReasoningRenderItem = (reasoningText: string, reasoningId: number, key: string): MessageRenderItem => {
      const isExpanded = expandedBlocks.reasoning.has(reasoningId)
      const panelId = `${id}-${key}-panel`
      return {
        key,
        kind: 'process',
        processType: 'reasoning',
        node: (
          <div key={key} className='min-w-0 max-w-full' style={messageContentStyle} data-chat-block='reasoning'>
            <DisclosureRow
              label='Reasoning'
              summary={getCollapsedReasoningSummary(reasoningText)}
              expanded={isExpanded}
              onToggle={() => toggleBlock('reasoning', reasoningId)}
              controlsId={panelId}
            />
            <DisclosurePanel
              id={panelId}
              expanded={isExpanded}
              disableTransition={isStreamingRender}
              onTransitionEnd={handleExpandTransitionEnd}
            >
              {renderMarkdownNode({
                key: `${key}-reasoning-content`,
                markdown: reasoningText,
                className: REASONING_TEXT_MARKDOWN_CLASS,
              })}
            </DisclosurePanel>
          </div>
        ),
      }
    }

    const renderItemsWithOptionalProcessGrouping = (items: MessageRenderItem[], sourceKey: string): React.ReactNode[] => {
      if (!groupToolReasoningRuns) return items.map(item => item.node)

      const rendered: React.ReactNode[] = []
      let index = 0

      while (index < items.length) {
        const current = items[index]
        if (current.kind !== 'process') {
          rendered.push(current.node)
          index += 1
          continue
        }

        let runEnd = index
        while (runEnd < items.length) {
          const candidate = items[runEnd]
          if (!candidate) break
          if (candidate.kind === 'process') {
            runEnd += 1
            continue
          }
          if (candidate.ignoreForProcessRunGrouping) {
            let lookahead = runEnd + 1
            while (lookahead < items.length && items[lookahead]?.ignoreForProcessRunGrouping) lookahead += 1
            if (lookahead < items.length && items[lookahead]?.kind === 'process') {
              runEnd += 1
              continue
            }
          }
          break
        }

        const runItems = items.slice(index, runEnd)
        const processItems = runItems.filter(item => item.kind === 'process')

        if (processItems.length >= PROCESS_RUN_GROUP_MIN_ITEMS) {
          const groupKey = `process-run-${sourceKey}-${runItems[0].key}-${runItems[runItems.length - 1].key}`
          const isExpanded = expandedBlocks.groupRuns.has(groupKey)
          const toolCount = processItems.filter(item => item.processType === 'tool').length
          const reasoningCount = processItems.filter(item => item.processType === 'reasoning').length
          const summaryParts: string[] = []
          if (toolCount > 0) summaryParts.push(`${toolCount} tool${toolCount === 1 ? '' : 's'}`)
          if (reasoningCount > 0) summaryParts.push(`${reasoningCount} reasoning`)
          const panelId = `${id}-${groupKey}-panel`

          rendered.push(
            <div key={groupKey} className='min-w-0 max-w-full' style={messageContentStyle}>
              <DisclosureRow
                label='Agent steps'
                meta={String(processItems.length)}
                summary={summaryParts.join(' · ')}
                expanded={isExpanded}
                onToggle={() => toggleBlock('groupRuns', groupKey)}
                controlsId={panelId}
              />
              <DisclosurePanel
                id={panelId}
                expanded={isExpanded}
                disableTransition={isStreamingRender}
                onTransitionEnd={handleExpandTransitionEnd}
              >
                <div className={MESSAGE_BLOCK_STACK_CLASS}>{runItems.map(item => item.node)}</div>
              </DisclosurePanel>
            </div>
          )
        } else {
          rendered.push(...runItems.map(item => item.node))
        }

        index = runEnd
      }

      return rendered
    }

    const renderHookActivityItem = (): MessageRenderItem | null => {
      if (!hookRuns?.length || role !== 'assistant') return null
      return {
        key: 'hook-activity',
        kind: 'other',
        node: <HookActivityCard key='hook-activity' initialRuns={hookRuns} messageId={id} event={hookRuns[0]?.event} fontSizeOffset={fontSizeOffset} onLayoutChange={onLayoutChange} onRunsUpdated={runs => onHookRunsUpdated?.(id, runs)} onRunsSettled={onHookRunsSettled} />,
      }
    }

    const renderTextItem = (key: string, markdown: string): MessageRenderItem => ({
      key,
      kind: 'other',
      ignoreForProcessRunGrouping: isProcessRunSeparatorText(markdown),
      node: renderMarkdownNode({ key, markdown, className: SHARED_TEXT_MARKDOWN_CLASS, style: messageContentStyle }),
    })

    const renderErrorItem = (key: string, envelope: ChatErrorEnvelope, withAction: boolean): MessageRenderItem => ({
      key,
      // `kind: 'other'` is load-bearing: it terminates any surrounding process run so the
      // failure can never be folded behind the collapsed "Agent steps" disclosure.
      kind: 'other',
      node: (
        <div key={key} className={MESSAGE_BLOCK_INSET_CLASS}>
          {/* No `onDismiss`: a persisted ErrorBlock is part of the transcript. */}
          <ChatErrorBubble
            envelope={envelope}
            style={messageContentStyle}
            onAction={withAction && onChatErrorAction ? kind => onChatErrorAction(kind, id, envelope) : undefined}
          />
        </div>
      ),
    })

    const renderContextInjectionItem = (key: string, entries: ContextInjectionCardEntry[]): MessageRenderItem => ({
      key,
      // `kind: 'other'` is load-bearing: the card must never fold into the collapsed run.
      kind: 'other',
      node: (
        <ContextInjectionCard
          key={key}
          entries={entries}
          fontSizeOffset={fontSizeOffset}
          customTheme={customTheme}
          customThemeEnabled={customThemeEnabled}
          isDarkMode={isDarkMode}
        />
      ),
    })

    const isHiddenStreamSeparator = (event: StreamEvent, index: number): boolean => {
      if (event.type !== 'text') return false
      const text = event.delta || ''
      if (!text.trim()) return true
      const prev = streamEvents?.[index - 1]
      const next = streamEvents?.[index + 1]
      return prev?.type === 'reasoning' && next?.type === 'reasoning' && isProcessRunSeparatorText(text)
    }

    const getPreviousVisibleStreamType = (index: number): StreamEvent['type'] | null => {
      if (!Array.isArray(streamEvents)) return null
      let cursor = index - 1
      while (cursor >= 0) {
        const event = streamEvents[cursor]
        if (event && !isHiddenStreamSeparator(event, cursor)) return event.type
        cursor -= 1
      }
      return null
    }

    const buildStreamRenderItems = (): MessageRenderItem[] => {
      if (!Array.isArray(streamEvents) || streamEvents.length === 0) return []

      const items: MessageRenderItem[] = []
      let idx = 0

      while (idx < streamEvents.length) {
        const event = streamEvents[idx]
        if (!event) {
          idx += 1
          continue
        }

        const groupedTool = streamToolGroupsByIndex.get(idx)
        if (groupedTool) {
          if (groupedTool.anchorIndex === idx) {
            const toolNode = renderToolCallGroupCard(groupedTool, `stream-${groupedTool.id}-${idx}`)
            if (toolNode) {
              items.push({
                key: `stream-tool-${groupedTool.id}-${idx}`,
                kind: 'process',
                processType: 'tool',
                node: toolNode,
              })
            }
          }
          idx += 1
          continue
        }

        // A non-terminal status frame ("Reconnecting…", "Trying again…", "Summarising
        // earlier turns…"). `kind: 'other'` keeps it out of the collapsed process group,
        // since the point is to be seen while it is happening.
        if (event.type === 'notice') {
          const noticeText = event.content
          if (noticeText) {
            const noticeKey = `stream-notice-${idx}`
            const counter =
              typeof event.attempt === 'number' && typeof event.maxAttempts === 'number'
                ? ` (${event.attempt} of ${event.maxAttempts})`
                : ''
            items.push({
              key: noticeKey,
              kind: 'other',
              node: (
                <div
                  key={noticeKey}
                  className={`flex h-8 items-center ${MESSAGE_BLOCK_INSET_CLASS} ${TEXT_LABEL_CLASS} italic text-neutral-500 dark:text-neutral-400`}
                  style={messageContentStyle}
                >
                  {noticeText}
                  {counter}
                </div>
              ),
            })
          }
          idx += 1
          continue
        }

        // An in-order failure on a live stream, shown where the text stopped.
        if (event.type === 'error' && event.errorEnvelope) {
          items.push(renderErrorItem(`stream-error-${idx}`, event.errorEnvelope, false))
          idx += 1
          continue
        }

        if (event.type === 'text') {
          let accumulatedText = event.delta || ''
          let nextIdx = idx + 1
          while (nextIdx < streamEvents.length) {
            const nextEvent = streamEvents[nextIdx]
            if (nextEvent?.type === 'text') {
              accumulatedText += nextEvent.delta || ''
              nextIdx += 1
            } else {
              break
            }
          }
          if (accumulatedText.trim().length > 0) {
            items.push(renderTextItem(`text-${idx}`, accumulatedText))
          }
          idx = nextIdx
          continue
        }

        if (event.type === 'reasoning' && event.delta) {
          if (getPreviousVisibleStreamType(idx) === 'reasoning') {
            idx += 1
            continue
          }
          let accumulatedReasoning = event.delta || ''
          let nextIdx = idx + 1
          while (nextIdx < streamEvents.length) {
            const nextEvent = streamEvents[nextIdx]
            if (nextEvent?.type === 'reasoning' && nextEvent.delta) {
              accumulatedReasoning += nextEvent.delta
              nextIdx += 1
            } else if (nextEvent && isHiddenStreamSeparator(nextEvent, nextIdx)) {
              nextIdx += 1
            } else {
              break
            }
          }
          items.push(buildReasoningRenderItem(accumulatedReasoning, idx, `reasoning-${idx}`))
          idx = nextIdx
          continue
        }

        if (event.type === 'tool_call' && event.toolCall && event.complete) {
          // Fallback path: if stream grouping did not produce an anchored group,
          // still render via the shared tool-group card renderer.
          const toolCall = event.toolCall
          const fallbackGroup: ToolCallRenderGroup = {
            id: toolCall.id,
            name: toolCall.name,
            args: toolCall.arguments,
            results: toolCall.result ? [{ content: toolCall.result, is_error: false }] : [],
            anchorIndex: idx,
          }
          const fallbackNode = renderToolCallGroupCard(fallbackGroup, `stream-fallback-${toolCall.id}-${idx}`)
          if (fallbackNode) {
            items.push({
              key: `stream-fallback-tool-${toolCall.id}-${idx}`,
              kind: 'process',
              processType: 'tool',
              node: fallbackNode,
            })
          }
          idx += 1
          continue
        }

        if (event.type === 'image' && event.url) {
          const imageKey = `image-${idx}`
          items.push({
            key: imageKey,
            kind: 'other',
            node: renderImageNode({ key: imageKey, url: event.url, onClick: () => handleArtifactClick(event.url) }),
          })
        }

        idx += 1
      }

      return items
    }

    const buildResponsesOutputItemsRenderItems = (responseItems: any[], baseIndex: number): MessageRenderItem[] => {
      const items: MessageRenderItem[] = []
      let localIndex = 0

      for (const item of responseItems) {
        if (!item || typeof item !== 'object') {
          localIndex += 1
          continue
        }

        if (item.type === 'message' && item.role === 'assistant') {
          for (const text of extractAssistantTextsFromResponsesOutputItems([item])) {
            items.push(renderTextItem(`responses-text-${baseIndex}-${localIndex}`, text))
            localIndex += 1
          }
          continue
        }

        if (item.type === 'reasoning') {
          for (const reasoningText of extractReasoningTextsFromResponsesOutputItems([item])) {
            items.push(
              buildReasoningRenderItem(
                reasoningText,
                900000000 + baseIndex * 100 + localIndex,
                `responses-reasoning-${baseIndex}-${localIndex}`
              )
            )
            localIndex += 1
          }
          continue
        }

        if (item.type === 'function_call') {
          const callId = typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : ''
          const name = typeof item.name === 'string' ? item.name : ''
          if (callId && name) {
            const toolNode = renderToolCallGroupCard(
              {
                id: callId,
                name,
                args: parseResponsesToolArgs(item.arguments) as Record<string, any> | null,
                results: [],
                anchorIndex: baseIndex + localIndex,
              },
              `responses-tool-${callId}-${baseIndex}-${localIndex}`
            )
            if (toolNode) {
              items.push({
                key: `responses-tool-${callId}-${baseIndex}-${localIndex}`,
                kind: 'process',
                processType: 'tool',
                node: toolNode,
              })
            }
          }
          localIndex += 1
          continue
        }

        localIndex += 1
      }

      return items
    }

    const buildContentBlockRenderItems = (blocks: ContentBlock[]): MessageRenderItem[] => {
      const items: MessageRenderItem[] = []
      const renderedReasoningSignatures = new Set<string>()
      const hasExplicitRenderableBlocks = blocks.some(
        block =>
          block.type === 'text' ||
          block.type === 'thinking' ||
          block.type === 'tool_use' ||
          block.type === 'image' ||
          block.type === 'reasoning_details' ||
          // A persisted terminal failure is a first-class renderable.
          block.type === 'error'
      )
      let idx = 0

      while (idx < blocks.length) {
        const block = blocks[idx]
        if (!block) {
          idx += 1
          continue
        }

        const groupedTool = contentToolGroupsByIndex.get(idx)
        if (groupedTool) {
          const toolNode = renderToolCallGroupCard(groupedTool, `block-${groupedTool.id}-${idx}`)
          if (toolNode) {
            items.push({
              key: `block-tool-${groupedTool.id}-${idx}`,
              kind: 'process',
              processType: 'tool',
              node: toolNode,
            })
          }
          idx += 1
          continue
        }

        if (block.type === 'context_injection') {
          // Consecutive injection blocks (one tool call can trigger several files) become ONE card.
          const entries: ContextInjectionCardEntry[] = []
          let cursor = idx
          while (cursor < blocks.length) {
            const candidate = blocks[cursor]
            if (!candidate || candidate.type !== 'context_injection') break
            entries.push({ path: candidate.path, label: candidate.label, text: candidate.text, reason: candidate.reason })
            cursor += 1
          }
          items.push(renderContextInjectionItem(`context-injection-${idx}`, entries))
          idx = cursor
          continue
        }

        if (block.type === 'error') {
          items.push(renderErrorItem(`error-${block.index}-${idx}`, block.envelope, true))
          idx += 1
          continue
        }

        if (block.type === 'text') {
          const blockText = typeof block.content === 'string' ? block.content : ''
          const rawText = role === 'user' ? stripAttachedImagePathMetadata(blockText) : blockText
          if (rawText.trim()) {
            items.push(renderTextItem(`text-${block.index}-${idx}`, rawText))
          }
          idx += 1
          continue
        }

        if (block.type === 'thinking') {
          let prevIdx = idx - 1
          while (prevIdx >= 0 && blocks[prevIdx]?.type === 'reasoning_details') prevIdx -= 1
          if (prevIdx >= 0 && blocks[prevIdx]?.type === 'thinking') {
            idx += 1
            continue
          }

          let accumulatedThinking = block.content || ''
          let nextIdx = idx + 1
          while (nextIdx < blocks.length) {
            const nextBlock = blocks[nextIdx]
            if (!nextBlock) {
              nextIdx += 1
              continue
            }
            if (nextBlock.type === 'thinking') {
              accumulatedThinking += nextBlock.content || ''
              nextIdx += 1
            } else if (nextBlock.type === 'reasoning_details') {
              nextIdx += 1
            } else {
              break
            }
          }

          const normalizedThinking = normalizeReasoningTextForComparison(accumulatedThinking)
          if (normalizedThinking) renderedReasoningSignatures.add(normalizedThinking)

          items.push(
            buildReasoningRenderItem(
              accumulatedThinking,
              typeof block.index === 'number' ? block.index : idx,
              `thinking-${block.index}-${idx}`
            )
          )
          idx = nextIdx
          continue
        }

        if ((block as any).type === 'responses_output_items' && Array.isArray((block as any).items)) {
          const responseBlock = block as any
          if (!hasExplicitRenderableBlocks) {
            const baseIndex = typeof responseBlock.index === 'number' ? responseBlock.index : idx
            items.push(...buildResponsesOutputItemsRenderItems(responseBlock.items, baseIndex))
          }
          idx += 1
          continue
        }

        if (block.type === 'image' && block.url) {
          const imageKey = `image-${block.index}-${idx}`
          items.push({
            key: imageKey,
            kind: 'other',
            node: renderImageNode({ key: imageKey, url: block.url, onClick: () => handleArtifactClick(block.url) }),
          })
          idx += 1
          continue
        }

        // reasoning_details and unknown block types draw nothing.
        idx += 1
      }

      return items
    }

    /**
     * The blocks this row draws. Priority: live `streamEvents`, then persisted `contentBlocks`.
     * A row with neither (an optimistic user message, or an old assistant row that only has a
     * `content` string) is drawn as one text block, so every message goes through one path.
     * User rows always add their `content` as the text block after any context injection cards.
     */
    const renderableBlocks = useMemo<ContentBlock[]>(() => {
      const blocks = Array.isArray(contentBlocks) ? contentBlocks : []
      if (isUserRow) {
        const injections = blocks.filter(block => block?.type === 'context_injection')
        const text = visibleContent.trim()
        return text
          ? [...injections, { type: 'text', index: injections.length, content: visibleContent } as ContentBlock]
          : injections
      }
      if (blocks.length > 0) return blocks
      const text = visibleContent.trim()
      return text ? [{ type: 'text', index: 0, content: visibleContent } as ContentBlock] : []
    }, [contentBlocks, isUserRow, visibleContent])

    /**
     * A row of pure agent work sits in the same tight run as the blocks inside it. Message rows
     * are absolutely positioned by the virtualizer, so a negative margin cannot pull them
     * together; the row's own padding is the only lever. Live rows keep the normal padding so the
     * layout does not shift as the stream turns from tool calls into an answer.
     */
    const isProcessOnlyRow = !isUserRow && !hasStreamEvents && isProcessOnlyBlockSet(renderableBlocks)

    // `contentToolGroupsByIndex` is keyed by index into `contentBlocks`. A user row never has tool
    // blocks and the fallback text block sits alone, so the map stays valid for `renderableBlocks`.
    const baseRenderedNodes = editingState
      ? null
      : hasStreamEvents
        ? renderItemsWithOptionalProcessGrouping(buildStreamRenderItems(), `stream-${id}`)
        : renderableBlocks.length > 0
          ? renderItemsWithOptionalProcessGrouping(buildContentBlockRenderItems(renderableBlocks), `blocks-${id}`)
          : null
    const hookActivityItem = renderHookActivityItem()
    const renderedNodes = hookActivityItem
      ? [...(Array.isArray(baseRenderedNodes) ? baseRenderedNodes : baseRenderedNodes ? [baseRenderedNodes] : []), hookActivityItem.node]
      : baseRenderedNodes

    const hasSelection = selectedText.length > 0
    const showActionsRow = hasContent && canBranchMessage && showInlineActions
    const contextHighlightClass = contextMenuOpen ? 'bg-black/[0.03] dark:bg-white/[0.03]' : ''

    return (
      <div
        id={`message-${id}`}
        ref={messageRef}
        className={`group ${width} px-0 sm:px-2 ${isUserRow ? 'pt-3 pb-1' : isProcessOnlyRow ? 'py-px' : 'py-1'} ${className ?? ''}`}
        onContextMenu={handleContextMenu}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
        onClick={handleMobileMessageActivate}
        onTouchStart={handleMobileMessageActivate}
      >
        <div
          className={`min-w-0 rounded-2xl ${drawSurface ? 'px-1.5 pt-2 pb-1' : ''} ${surfaceClass} ${contextHighlightClass} ${FAST_COLOR_TRANSITION_CLASS}`}
          style={surfaceStyle}
        >
          {/* Role caption. Assistant rows stay unlabelled; the surface is the label for user rows. */}
          {(isUserRow || isCompactionSummary) && (
            <div className={`flex h-7 items-center gap-2 ${MESSAGE_BLOCK_INSET_CLASS}`}>
              {isUserRow && (
                <span
                  className={`${TEXT_MICRO_CLASS} font-semibold uppercase tracking-[0.14em] ${roleLabelClass}`}
                  style={roleLabelStyle}
                >
                  {roleLabel}
                </span>
              )}
              {isCompactionSummary && (
                <Badge tone='success'>
                  <span className='mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-current' aria-hidden='true' />
                  Compaction summary
                </Badge>
              )}
            </div>
          )}

          {/* Body: edit surface or the block stack. */}
          {editingState ? (
            <div className={`${MESSAGE_BLOCK_INSET_CLASS} w-full`}>
              <TextArea
                value={editContent}
                onChange={setEditContent}
                placeholder='Edit your message...'
                minRows={2}
                maxRows={40}
                maxHeightViewportRatio={editMode === 'branch' ? 0.45 : undefined}
                maxLength={20000}
                autoFocus
                label={editMode === 'branch' ? 'Create new branch' : 'Edit message'}
                width='w-full'
                enableImageAttachments={editMode === 'branch'}
                imageDraftTarget={{ kind: 'branch', messageId: id }}
                fontSizeOffset={fontSizeOffset}
                onContextMenu={(e: React.MouseEvent<HTMLTextAreaElement>) => {
                  // Always show the default browser menu in the TextArea, never the custom menu
                  e.stopPropagation()
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    if (editMode === 'branch') handleSaveBranch()
                    else handleSave()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    handleCancel()
                  }
                }}
              />
              <div className={`flex h-7 items-center justify-end ${TEXT_MICRO_CLASS} text-neutral-500 dark:text-neutral-400`}>
                Enter to save · Shift+Enter for a new line · Escape to cancel
              </div>
            </div>
          ) : (
            renderedNodes && <div className={MESSAGE_BLOCK_STACK_CLASS}>{renderedNodes}</div>
          )}

          {/* Attachments on non-assistant rows. */}
          {Array.isArray(artifacts) && artifacts.length > 0 && role !== 'assistant' && (
            <div className={`${MESSAGE_BLOCK_INSET_CLASS} flex flex-wrap justify-end gap-2 py-2`}>
              {artifacts.map((dataUrl, idx) => (
                <div
                  key={`${id}-artifact-${idx}`}
                  className='relative h-20 w-20 overflow-hidden rounded-xl bg-black/[0.04] dark:bg-white/[0.05]'
                >
                  <img
                    src={dataUrl}
                    alt={`attachment-${idx}`}
                    className='h-full w-full cursor-pointer object-contain'
                    loading='lazy'
                    onClick={() => handleArtifactClick(dataUrl)}
                  />
                  {editingState && editMode === 'branch' && (
                    <button
                      type='button'
                      title='Remove image'
                      aria-label='Remove image'
                      onClick={() => handleDeleteArtifact(idx)}
                      className={`absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 ${FAST_COLOR_TRANSITION_CLASS} ${FOCUS_RING_CLASS}`}
                    >
                      <X size={12} strokeWidth={2.5} aria-hidden='true' />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Actions row. Always occupies its height so hover does not shift layout. */}
          {showActionsRow && (
            <div className={`flex h-10 items-center justify-between gap-3 ${MESSAGE_BLOCK_INSET_CLASS}`}>
              {isUserRow && userTurnElapsedLabel && !editingState ? (
                <div
                  className={`min-w-0 flex-1 truncate ${TEXT_NANO_CLASS} font-medium uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-400 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none ${
                    isHovering ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0 pointer-events-none'
                  }`}
                  aria-label={userTurnElapsedLabel}
                >
                  {userTurnElapsedLabel}
                </div>
              ) : (
                <div className='flex-1' />
              )}
              <div ref={moreButtonRef} className='relative shrink-0'>
                <MessageActions
                  onEdit={isUserRow ? handleEdit : undefined}
                  onBranch={handleBranch}
                  onDelete={isUserRow ? handleDelete : undefined}
                  onCopy={handleCopy}
                  onSave={handleSave}
                  onSaveBranch={handleSaveBranch}
                  onCancel={handleCancel}
                  onMore={handleMoreClick}
                  onUndoEdits={isUserRow && undoState?.available ? onUndoStreamEdits : undefined}
                  undoLabel={undoLabel}
                  undoDisabled={undoState?.restoring || undoState?.restored}
                  isEditing={editingState}
                  editMode={editMode}
                  copied={copied}
                  modelName={modelName}
                  isVisible={isHovering}
                  variant='default'
                />
                {showMoreMenu &&
                  moreMenuPlacement &&
                  createPortal(
                    <div
                      ref={moreMenuRef}
                      className={`fixed z-[200] ${FLOATING_SURFACE_CLASS} [will-change:contents] [transform:translateZ(0)]`}
                      style={{
                        top: `${moreMenuPlacement.top}px`,
                        left: `${moreMenuPlacement.left}px`,
                        width: `${moreMenuPlacement.width}px`,
                      }}
                    >
                      <div className='p-3'>
                        <h3 className={`${TEXT_LABEL_CLASS} font-semibold text-neutral-700 dark:text-neutral-200`}>Message info</h3>
                        <div className='thin-scrollbar mt-2 max-h-64 space-y-1.5 overflow-y-auto ${TEXT_DETAIL_CLASS} sm:max-h-80 md:max-h-96'>
                          {messageData ? (
                            Object.entries(messageData)
                              .filter(
                                ([key]) =>
                                  key !== 'content' &&
                                  key !== 'plain_text_content' &&
                                  key !== 'artifacts' &&
                                  key !== 'content_plain_text'
                              )
                              .map(([key, value]) => (
                                <div key={key} className='flex gap-2'>
                                  <span className='shrink-0 font-medium text-neutral-500 dark:text-neutral-400'>{key}:</span>
                                  <span className='break-all text-neutral-800 dark:text-neutral-200'>
                                    {typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}
                                  </span>
                                </div>
                              ))
                          ) : (
                            <p className='text-neutral-500 dark:text-neutral-400'>No message data found</p>
                          )}
                        </div>
                      </div>
                    </div>,
                    document.body
                  )}
              </div>
            </div>
          )}
        </div>

        {/* Floating MessageActions on right-click */}
        {contextMenuOpen &&
          contextMenuPosition &&
          createPortal(
            <div
              ref={floatingActionsRef}
              className='fixed z-[400]'
              style={{
                left: `${contextMenuPosition.x}px`,
                top: `${contextMenuPosition.y}px`,
                transform: 'translate(-50%, -50%)',
              }}
            >
              <MessageActions
                onEdit={
                  !hasSelection
                    ? () => {
                        closeFloatingActions()
                        handleEdit()
                      }
                    : undefined
                }
                onBranch={
                  !hasSelection && canBranchMessage
                    ? () => {
                        closeFloatingActions()
                        handleBranch()
                      }
                    : undefined
                }
                onDelete={
                  !hasSelection
                    ? () => {
                        closeFloatingActions()
                        handleDelete()
                      }
                    : undefined
                }
                onCopy={
                  !hasSelection
                    ? () => {
                        // Stay open so the copied state is visible.
                        void handleCopy()
                      }
                    : undefined
                }
                onCopySelection={
                  hasSelection
                    ? () => {
                        void handleCopySelection()
                      }
                    : undefined
                }
                onExplainSelection={
                  hasSelection && onExplainFromSelection
                    ? (position?: { x: number; y: number }) => {
                        closeFloatingActions()
                        handleExplainSelection(position)
                      }
                    : undefined
                }
                onAddToNoteSelection={
                  hasSelection && onAddToNote
                    ? () => {
                        closeFloatingActions()
                        handleAddSelectionToNote()
                      }
                    : undefined
                }
                onSave={
                  !hasSelection
                    ? () => {
                        closeFloatingActions()
                        handleSave()
                      }
                    : undefined
                }
                onSaveBranch={
                  !hasSelection
                    ? () => {
                        closeFloatingActions()
                        handleSaveBranch()
                      }
                    : undefined
                }
                onCancel={
                  !hasSelection
                    ? () => {
                        closeFloatingActions()
                        handleCancel()
                      }
                    : undefined
                }
                onMore={
                  !hasSelection
                    ? () => {
                        closeFloatingActions()
                        handleMoreClick()
                      }
                    : undefined
                }
                onUndoEdits={
                  !hasSelection && undoState?.available && onUndoStreamEdits
                    ? () => {
                        closeFloatingActions()
                        onUndoStreamEdits()
                      }
                    : undefined
                }
                undoLabel={undoLabel}
                undoDisabled={undoState?.restoring || undoState?.restored}
                isEditing={editingState}
                editMode={editMode}
                copied={copied}
                modelName={modelName}
                isVisible={true}
                variant={hasSelection ? 'selection' : 'default'}
                layout='menu'
              />
            </div>,
            document.body
          )}

        {/* Floating explain input. Portal escapes the transform container. */}
        {showExplainInput &&
          explainInputPosition.current &&
          createPortal(
            <div
              ref={explainInputRef}
              className={`fixed z-[100] w-[320px] p-2 sm:w-[400px] ${FLOATING_SURFACE_CLASS} [will-change:contents] [transform:translateZ(0)]`}
              style={{
                left: `${explainInputFixedPosition?.x ?? explainInputPosition.current?.x ?? 0}px`,
                top: `${explainInputFixedPosition?.y ?? explainInputPosition.current?.y ?? 0}px`,
                width: explainInputFixedPosition ? `${explainInputFixedPosition.width}px` : undefined,
              }}
            >
              <div className='thin-scrollbar mb-2 max-h-[100px] overflow-y-auto rounded-xl bg-black/[0.04] p-2 dark:bg-white/[0.05]'>
                <div className={`line-clamp-4 ${TEXT_DETAIL_CLASS} italic text-neutral-600 dark:text-neutral-400`}>“{selectedText}”</div>
              </div>
              <TextArea
                value={explainInputValue}
                onChange={setExplainInputValue}
                placeholder='Ask a question about the selected text...'
                width='w-full'
                minRows={1}
                maxRows={2}
                fontSizeOffset={fontSizeOffset}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSendExplainInput()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    handleCancelExplainInput()
                  }
                }}
              />
              <div className='mt-2 flex justify-end gap-1.5'>
                <button
                  type='button'
                  onClick={handleCancelExplainInput}
                  title='Cancel'
                  aria-label='Cancel'
                  className={`${EXPLAIN_BUTTON_CLASS} hover:bg-red-500/12 hover:text-red-600 dark:hover:text-red-300`}
                >
                  <X size={15} strokeWidth={2.25} aria-hidden='true' />
                </button>
                <button
                  type='button'
                  onClick={handleSendExplainInput}
                  disabled={!explainInputValue.trim()}
                  title='Send'
                  aria-label='Send'
                  className={`${EXPLAIN_BUTTON_CLASS} hover:bg-emerald-500/12 hover:text-emerald-600 dark:hover:text-emerald-300`}
                >
                  <Check size={15} strokeWidth={2.25} aria-hidden='true' />
                </button>
              </div>
            </div>,
            document.body
          )}

        <ImageModal
          isOpen={Boolean(selectedArtifactUrl)}
          imageUrl={selectedArtifactUrl ?? ''}
          onClose={handleCloseArtifactModal}
        />
      </div>
    )
  }
)

ChatMessage.displayName = 'ChatMessage'

export { ChatMessage }
