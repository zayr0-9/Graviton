import { useQueryClient } from '@tanstack/react-query'
import 'boxicons/css/boxicons.min.css'
import { Flame, ListFilter, Maximize2, Minimize2, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'
import type { JSX } from 'react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import {
  deleteSelectedNodes,
  fetchMessageTree,
  insertBulkMessages,
  // sendMessage,
  updateMessage,
} from '../../features/chats/chatActions'
import { chatSliceActions } from '../../features/chats/chatSlice'
import { buildBranchPathForMessage } from '../../features/chats/pathUtils'
import { createConversation, updateCwd } from '../../features/conversations/conversationActions'
import { makeSelectConversationById } from '../../features/conversations/conversationSelectors'
import type { Conversation } from '../../features/conversations/conversationTypes'
// import { selectSelectedProject } from '../../features/projects/projectSelectors'
import { Message } from '@/features/chats'
import { ConversationId, MessageId } from '../../../../../shared/types'
import { useIsMobile } from '../../hooks/useMediaQuery'
import { useConversations } from '../../hooks/useQueries'
import type { RootState } from '../../store/store'
import { parseId } from '../../utils/helpers'
import stripMarkdownToText from '../../utils/markdownStripper'
// import { MarkdownLink } from '../MarkdownLink/MarkdownLink'
import { environment, localApi } from '../../utils/api'
import { DeleteConfirmModal } from '../DeleteConfirmModal/DeleteConfirmModal'
import { TextArea } from '../TextArea/TextArea'
import { TextField } from '../TextField/TextField'
import {
  getThemeModeColor,
  resolveHeimdallNodeThemeKey,
  useCustomChatTheme,
  useHtmlDarkMode,
} from '../ThemeManager/themeConfig'

// Type definitions
interface ChatNode {
  id: string
  message: string
  sender: 'user' | 'assistant' | 'ex_agent'
  children: ChatNode[]
}

interface SubagentNode {
  id: string
  message?: string
  sender?: string
  content_blocks?: any[]
}

interface SubagentRun {
  id: string
  parent_message_id: string
  prompt?: string
  status?: string
  final_response?: string | null
  error?: string | null
  messages?: Array<{
    id: string
    role: string
    content?: string
    thinking_block?: string | null
    tool_calls?: any[] | null
    content_blocks?: any[] | null
  }>
}

interface Position {
  x: number
  y: number
  node: ChatNode
}

interface Bounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

interface GraphLayersProps {
  connections: JSX.Element[]
  nodes: JSX.Element[]
}

const HeimdallGraphLayers = React.memo<GraphLayersProps>(({ connections, nodes }) => {
  return (
    <>
      <g strokeLinecap='round' strokeLinejoin='round'>
        {connections}
      </g>
      {nodes}
    </>
  )
})

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const NOTE_COLOR_PRESETS = ['#ef4444', '#f97316', '#f59e0b', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899']
const HEIMDALL_NODE_SELECTED_STROKE_WIDTH = 2.75
const HEIMDALL_NODE_VISIBLE_STROKE_WIDTH = 2.25
const HEIMDALL_NODE_RADIUS = 22
const HEIMDALL_NOTE_PILL_RADIUS = 14
const HEIMDALL_COMPACT_NODE_HOVER_SCALE = 1.035

const isValidHexColor = (value?: string | null): value is string =>
  typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value)

const getReadableTextColor = (hex: string) => {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return luminance > 150 ? '#0f172a' : '#ffffff'
}

const getTranslucentCssColor = (color: string, alpha: number) => {
  const clampedAlpha = Math.max(0, Math.min(1, alpha))
  const hexMatch = color.match(/^#([0-9a-fA-F]{6})$/)

  if (hexMatch) {
    const hex = hexMatch[1]
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    return `rgba(${r}, ${g}, ${b}, ${clampedAlpha})`
  }

  return `color-mix(in srgb, ${color} ${Math.round(clampedAlpha * 100)}%, transparent)`
}

const getHeimdallNodeFallbackFillClass = (sender: ChatNode['sender'], isVisible: boolean, isDarkMode: boolean) => {
  if (isVisible) {
    return isDarkMode ? 'fill-orange-500/20' : 'fill-blue-100'
  }

  if (sender === 'user') {
    return 'fill-white dark:fill-neutral-900'
  }

  if (sender === 'ex_agent') {
    return 'fill-orange-50 dark:fill-neutral-900'
  }

  return 'fill-stone-100 dark:fill-neutral-900'
}

const getHeimdallNodeTextClass = (sender: ChatNode['sender'], isVisible: boolean) => {
  if (isVisible) {
    return 'text-blue-950 dark:text-orange-50'
  }

  if (sender === 'user') {
    return 'text-stone-900 dark:text-stone-100'
  }

  if (sender === 'ex_agent') {
    return 'text-orange-950 dark:text-orange-100'
  }

  return 'text-stone-700 dark:text-stone-300'
}

const interpolateHexColor = (from: string, to: string, progress: number) => {
  const clamped = Math.max(0, Math.min(1, progress))
  const fromR = parseInt(from.slice(1, 3), 16)
  const fromG = parseInt(from.slice(3, 5), 16)
  const fromB = parseInt(from.slice(5, 7), 16)
  const toR = parseInt(to.slice(1, 3), 16)
  const toG = parseInt(to.slice(3, 5), 16)
  const toB = parseInt(to.slice(5, 7), 16)

  const r = Math.round(fromR + (toR - fromR) * clamped)
  const g = Math.round(fromG + (toG - fromG) * clamped)
  const b = Math.round(fromB + (toB - fromB) * clamped)

  return `#${[r, g, b]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('')}`
}

const HEATMAP_COLOR_STOPS = [
  { stop: 0, color: '#1d4ed8' },
  { stop: 0.18, color: '#3b82f6' },
  { stop: 0.34, color: '#06b6d4' },
  { stop: 0.5, color: '#22c55e' },
  { stop: 0.7, color: '#eab308' },
  { stop: 0.85, color: '#f97316' },
  { stop: 1, color: '#dc2626' },
] as const

const getHeatmapColor = (progress: number) => {
  const clamped = Math.max(0, Math.min(1, progress))

  for (let i = 0; i < HEATMAP_COLOR_STOPS.length - 1; i++) {
    const current = HEATMAP_COLOR_STOPS[i]
    const next = HEATMAP_COLOR_STOPS[i + 1]

    if (clamped <= next.stop) {
      const localProgress = (clamped - current.stop) / (next.stop - current.stop)
      return interpolateHexColor(current.color, next.color, localProgress)
    }
  }

  return HEATMAP_COLOR_STOPS[HEATMAP_COLOR_STOPS.length - 1].color
}

// interface TreeStats {
//   totalNodes: number
//   maxDepth: number
//   branches: number
// }

type ConversationTransferMode = 'copy' | 'move'

type MessageToCopy = {
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
}

interface HeimdallProps {
  chatData?: ChatNode | null

  compactMode?: boolean
  loading?: boolean
  error?: string | null
  onNodeSelect?: (nodeId: string, path: string[]) => void
  conversationId?: ConversationId | null
  visibleMessageId?: MessageId | null
  storageMode?: 'local' | 'cloud'
}

export const Heimdall: React.FC<HeimdallProps> = ({
  chatData = null,

  compactMode = true,
  loading = false,
  error = null,
  onNodeSelect,
  conversationId,
  visibleMessageId = null,
  storageMode,
}) => {
  const dispatch = useDispatch()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const selectedNodes = useSelector((state: RootState) => state.chat.selectedNodes)
  const currentPathIds = useSelector((state: RootState) => state.chat.conversation.currentPath)
  const currentConversationId = useSelector((state: RootState) => state.chat.conversation.currentConversationId)
  const streamingRoot = useSelector((state: RootState) => state.chat.streaming)
  // const selectedProject = useSelector(selectSelectedProject)
  const allMessages = useSelector((state: RootState) => state.chat.conversation.messages)
  // Get current conversation to access project_id
  const currentConversation = useSelector(conversationId ? makeSelectConversationById(conversationId) : () => null)
  const [showConversationSelector, setShowConversationSelector] = useState<boolean>(false)
  const [conversationTransferMode, setConversationTransferMode] = useState<ConversationTransferMode>('copy')
  const [isAddingToConversation, setIsAddingToConversation] = useState<boolean>(false)
  const [conversationSelectorError, setConversationSelectorError] = useState<string | null>(null)
  const {
    data: conversations = [],
    isLoading: conversationsLoading,
    isError: conversationsIsError,
    refetch: refetchConversations,
  } = useConversations(showConversationSelector)
  const selectableConversations = useMemo(
    () =>
      conversations.filter(conversation => {
        const sourceConversationId = conversationId ?? currentConversationId
        return sourceConversationId == null || String(conversation.id) !== String(sourceConversationId)
      }),
    [conversations, conversationId, currentConversationId]
  )
  // Track total messages to detect a truly empty conversation
  const messagesCount = useSelector((state: RootState) => state.chat.conversation.messages.length)
  // Track if on mobile device for responsive tooltip behavior
  const isMobile = useIsMobile()

  const svgRef = useRef<SVGSVGElement>(null)
  const graphTransformRef = useRef<SVGGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState<number>(compactMode ? 1 : 1)
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState<boolean>(false)
  const [isPinching, setIsPinching] = useState<boolean>(false)
  const [isWheeling, setIsWheeling] = useState<boolean>(false)
  const [isCullingFrozen, setIsCullingFrozen] = useState<boolean>(false)
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>({ width: 0, height: 0 })
  const [selectedNode, setSelectedNode] = useState<ChatNode | null>(null)
  const messagePreviewCloseTimeoutRef = useRef<number | null>(null)
  const [subagentPanel, setSubagentPanel] = useState<{ parentId: string; x: number; y: number } | null>(null)
  const [subagentModalData, setSubagentModalData] = useState<{
    parentId: string
    nodes: SubagentNode[]
    loading: boolean
    error?: string | null
  } | null>(null)
  const [dedicatedSubagentMap, setDedicatedSubagentMap] = useState<Record<string, SubagentNode[]>>({})
  const subagentModalScrollRef = useRef<HTMLDivElement | null>(null)
  const subagentModalScrollTopRef = useRef<number>(0)
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null)
  const [mousePosition, setMousePosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [isSelecting, setIsSelecting] = useState<boolean>(false)
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [selectionEnd, setSelectionEnd] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  // Custom context menu after selection
  const [showContextMenu, setShowContextMenu] = useState<boolean>(false)
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null)
  const [confirmDeleteSelection, setConfirmDeleteSelection] = useState<boolean>(true)
  const [pendingDeleteNodeIds, setPendingDeleteNodeIds] = useState<MessageId[]>([])
  const [showDeleteConfirmModal, setShowDeleteConfirmModal] = useState<boolean>(false)
  const [dontAskDeleteAgain, setDontAskDeleteAgain] = useState<boolean>(false)
  // Note dialog state
  const [showNoteDialog, setShowNoteDialog] = useState<boolean>(false)
  const [noteDialogPos, setNoteDialogPos] = useState<{ x: number; y: number } | null>(null)
  const [noteMessageId, setNoteMessageId] = useState<MessageId | null>(null)
  const [noteText, setNoteText] = useState<string>('')
  const [noteColor, setNoteColor] = useState<string | null>(null)
  const [hoveredNote, setHoveredNote] = useState<{
    nodeId: string
    note: string
    sender: 'user' | 'assistant' | 'ex_agent'
    fallbackPosition: { x: number; y: number }
  } | null>(null)
  const notePreviewCloseTimeoutRef = useRef<number | null>(null)
  // Store message content in ref to avoid stale closures in debounced update
  const noteMessageContentRef = useRef<string>('')
  const customColorInputRef = useRef<HTMLInputElement | null>(null)
  // Track dark mode for shadows
  const isDarkMode = useHtmlDarkMode()
  const { theme: customTheme, enabled: customThemeEnabled } = useCustomChatTheme()
  // Track hover state for showing/hiding controls
  const [isHovering, setIsHovering] = useState<boolean>(false)
  // Track pointers for pinch-to-zoom gesture
  const pointerMapRef = useRef<Map<number, { clientX: number; clientY: number; pointerType: string }>>(new Map())
  const fallbackOffsetsRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const pinchStateRef = useRef<{
    initialDistance: number
    initialZoom: number
    rafId: number | null
    pending: { point: { clientX: number; clientY: number }; targetZoom: number } | null
  } | null>(null)
  const isPinchingRef = useRef<boolean>(false)

  // Filter state
  const [filterEmptyMessages, setFilterEmptyMessages] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('heimdall-filter-empty')
      return saved !== null ? JSON.parse(saved) : true
    } catch {
      return true
    }
  })

  const toggleFilterEmptyMessages = useCallback(() => {
    setFilterEmptyMessages(prev => {
      const next = !prev
      localStorage.setItem('heimdall-filter-empty', JSON.stringify(next))
      return next
    })
  }, [])

  const [heatmapMode, setHeatmapMode] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('heimdall-heatmap-mode')
      return saved !== null ? JSON.parse(saved) : false
    } catch {
      return false
    }
  })

  const toggleHeatmapMode = useCallback(() => {
    setHeatmapMode(prev => {
      const next = !prev
      localStorage.setItem('heimdall-heatmap-mode', JSON.stringify(next))
      return next
    })
  }, [])

  // Keep a stable inner offset so the whole tree does not shift when nodes are added/removed
  const offsetRef = useRef<{ x: number; y: number } | null>(null)
  // Keep last non-null tree to avoid unmount flicker during refreshes
  const lastDataRef = useRef<ChatNode | null>(null)
  // Ensure we only auto-center once per conversation load
  const hasCenteredRef = useRef<boolean>(false)
  const [isTransitioning, setIsTransitioning] = useState<boolean>(false)
  // Refs to avoid stale state in global listeners
  const isDraggingRef = useRef<boolean>(false)
  const isSelectingRef = useRef<boolean>(false)
  const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const pointerDownPosRef = useRef<{ x: number; y: number } | null>(null)
  const hasMovedRef = useRef<boolean>(false)
  const clickedNodeRef = useRef<SVGElement | null>(null)
  const skipNextNodeContextMenuRef = useRef<{ nodeId: string; expiresAt: number } | null>(null)
  // Ref to record last mouse-up position for context menu anchoring
  const lastMouseUpPosRef = useRef<{ x: number; y: number } | null>(null)
  // Refs for latest zoom and pan to avoid stale closures inside wheel listener
  const zoomRef = useRef<number>(zoom)
  const panRef = useRef<{ x: number; y: number }>(pan)
  const interactionRafRef = useRef<number | null>(null)
  const pendingPanRef = useRef<{ x: number; y: number } | null>(null)
  const pendingZoomRef = useRef<number | null>(null)
  const pendingSelectionEndRef = useRef<{ x: number; y: number } | null>(null)
  const graphTransformDirtyRef = useRef<boolean>(false)
  const graphTransformCommitRef = useRef<{ pan: { x: number; y: number }; zoom: number } | null>(null)
  const cullingSnapshotRef = useRef<{ pan: { x: number; y: number }; zoom: number } | null>(null)
  const wheelIdleTimeoutRef = useRef<number | null>(null)
  const useGlobalMoveFallbackRef = useRef<boolean>(false)
  // Focused message id from global state and flat messages for search
  const focusedChatMessageId = useSelector((state: RootState) => state.chat.conversation.focusedChatMessageId)
  const flatMessages = useSelector((state: RootState) => state.chat.conversation.messages)
  const messageById = useMemo(() => new Map(flatMessages.map(m => [String(m.id), m])), [flatMessages])
  // Get the current message from Redux state
  const getCurrentMessage = useCallback(
    (messageId: MessageId) => {
      return messageById.get(String(messageId))
    },
    [messageById]
  )

  const normalizeContentBlocks = useCallback((blocks: any): any[] => {
    if (!blocks) return []
    if (Array.isArray(blocks)) return blocks
    if (typeof blocks === 'string') {
      try {
        const parsed = JSON.parse(blocks)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    }
    return []
  }, [])

  const haveSameSubagentNodes = useCallback(
    (a: SubagentNode[], b: SubagentNode[]) => JSON.stringify(a) === JSON.stringify(b),
    []
  )

  const buildSubagentMap = useCallback(
    (messages: Message[]) => {
      // Build subagent badges from assistant messages containing "subagent" tool calls.
      // Dedicated subagent run data is fetched separately and overrides these entries
      // for the same parent when available.
      const map: Record<string, SubagentNode[]> = {}

      messages.forEach(msg => {
        const blocks = normalizeContentBlocks(msg.content_blocks)
        if (msg.role === 'assistant' && blocks.length > 0 && msg.parent_id) {
          const subagentCalls = blocks.filter((block: any) => block.type === 'tool_use' && block.name === 'subagent')

          if (subagentCalls.length > 0) {
            const parentId = String(msg.parent_id)
            if (!map[parentId]) map[parentId] = []

            subagentCalls.forEach((call: any, idx: number) => {
              // Filter content_blocks to include:
              // 1. All blocks between this subagent's tool_use and its tool_result (inclusive)
              //    This captures any tool calls the subagent made during execution
              // 2. Any thinking/text blocks that appear before this tool_use (until previous tool_result or start)
              const toolUseId = call.id
              const toolUseIndex = blocks.findIndex((b: any) => b.type === 'tool_use' && b.id === toolUseId)
              const toolResultIndex = blocks.findIndex(
                (b: any) => b.type === 'tool_result' && b.tool_use_id === toolUseId
              )

              // Find preceding thinking/text blocks (go backwards until we hit a tool_result or start)
              const precedingBlocks: any[] = []
              for (let i = toolUseIndex - 1; i >= 0; i--) {
                const block = blocks[i]
                if (block.type === 'tool_result') break // Stop at previous tool's result
                if (block.type === 'thinking' || block.type === 'text') {
                  precedingBlocks.unshift(block) // Add to front to maintain order
                }
              }

              // Get all blocks from tool_use to tool_result (inclusive)
              // This includes any intermediate tool calls the subagent made
              const endIndex = toolResultIndex >= 0 ? toolResultIndex + 1 : toolUseIndex + 1
              const subagentBlocks = blocks.slice(toolUseIndex, endIndex)

              const filteredBlocks = [...precedingBlocks, ...subagentBlocks]

              map[parentId].push({
                id: `${msg.id}_subagent_${idx}`, // Virtual ID for the badge count
                message: call.input?.prompt || 'Subagent Call',
                sender: 'ex_agent',
                content_blocks: filteredBlocks,
              })
            })
          }
        }
      })

      return map
    },
    [normalizeContentBlocks]
  )

  const buildDedicatedSubagentMap = useCallback(
    (runs: SubagentRun[]) => {
      const map: Record<string, SubagentNode[]> = {}

      runs.forEach(run => {
        const parentId = String(run.parent_message_id || '')
        if (!parentId) return
        if (!map[parentId]) map[parentId] = []

        const combinedBlocks: any[] = []
        const messages = Array.isArray(run.messages) ? run.messages : []
        messages.forEach(message => {
          const blocks = normalizeContentBlocks(message.content_blocks)
          const hasTextBlock = blocks.some((block: any) => block?.type === 'text')
          if (message.thinking_block) {
            combinedBlocks.push({ type: 'thinking', content: message.thinking_block })
          }
          if (message.content && message.content.trim() && !hasTextBlock) {
            combinedBlocks.push({ type: 'text', content: message.content })
          }
          if (blocks.length > 0) combinedBlocks.push(...blocks)
        })

        if (run.status === 'error' && run.error) {
          combinedBlocks.push({ type: 'text', content: `Subagent error: ${run.error}` })
        }

        map[parentId].push({
          id: `run_${run.id}`,
          message: run.prompt || messages[0]?.content || 'Subagent Run',
          sender: 'ex_agent',
          content_blocks: combinedBlocks,
        })
      })

      return map
    },
    [normalizeContentBlocks]
  )

  useEffect(() => {
    if (environment !== 'electron' || !conversationId) {
      setDedicatedSubagentMap({})
      return
    }

    let cancelled = false
    const fetchDedicatedSubagents = async () => {
      try {
        const result = await localApi.get<{ runs: SubagentRun[] }>(`/conversations/${conversationId}/subagents`)
        if (cancelled) return
        setDedicatedSubagentMap(buildDedicatedSubagentMap(Array.isArray(result?.runs) ? result.runs : []))
      } catch (error) {
        if (!cancelled) {
          console.warn('[Heimdall] Failed to load dedicated subagent runs:', error)
          setDedicatedSubagentMap({})
        }
      }
    }

    void fetchDedicatedSubagents()
    const pollId = window.setInterval(() => {
      void fetchDedicatedSubagents()
    }, 3000)

    return () => {
      cancelled = true
      window.clearInterval(pollId)
    }
  }, [conversationId, buildDedicatedSubagentMap])

  const legacySubagentMapByParent = useMemo(() => buildSubagentMap(allMessages), [allMessages, buildSubagentMap])
  const subagentMapByParent = useMemo(() => {
    const merged: Record<string, SubagentNode[]> = { ...legacySubagentMapByParent }
    Object.entries(dedicatedSubagentMap).forEach(([parentId, nodes]) => {
      merged[parentId] = nodes.length > 0 ? nodes : merged[parentId] || []
    })
    return merged
  }, [dedicatedSubagentMap, legacySubagentMapByParent])

  const handleSubagentBadgeClick = useCallback((event: React.MouseEvent<SVGGElement>, parentId: string) => {
    event.stopPropagation()
    const containerRect = containerRef.current?.getBoundingClientRect()
    if (!containerRect) {
      console.warn('[Heimdall] No container rect')
      return
    }
    const nextPos = {
      parentId,
      x: event.clientX - containerRect.left,
      y: event.clientY - containerRect.top,
    }
    setSubagentPanel(prev => (prev?.parentId === parentId ? null : nextPos))
  }, [])

  useEffect(() => {
    subagentModalScrollTopRef.current = 0
  }, [subagentPanel?.parentId])

  useEffect(() => {
    const parentId = subagentPanel?.parentId
    if (!parentId) {
      setSubagentModalData(null)
      return
    }

    let cancelled = false
    let pollId: number | null = null
    const initialNodes = subagentMapByParent[parentId] || []

    setSubagentModalData(prev => {
      if (prev?.parentId === parentId) return prev
      return {
        parentId,
        nodes: initialNodes,
        loading: environment === 'electron' && !!conversationId && initialNodes.length === 0,
        error: null,
      }
    })

    if (environment !== 'electron' || !conversationId) {
      setSubagentModalData({
        parentId,
        nodes: initialNodes,
        loading: false,
        error: null,
      })
      return () => {
        cancelled = true
      }
    }

    const fetchSubagentMessages = async () => {
      try {
        const dedicated = await localApi.get<{ runs: SubagentRun[] }>(`/subagents/by-parent/${parentId}`)
        if (cancelled) return
        const dedicatedMap = buildDedicatedSubagentMap(Array.isArray(dedicated?.runs) ? dedicated.runs : [])
        let nextNodes = dedicatedMap[parentId] || []

        if (nextNodes.length === 0) {
          const result = await localApi.get<{ messages: Message[] }>(`/app/conversations/${conversationId}/messages/tree`)
          if (cancelled) return
          const map = buildSubagentMap(Array.isArray(result?.messages) ? result.messages : [])
          nextNodes = map[parentId] || []
        }

        setSubagentModalData(prev => {
          const previousNodes = prev?.parentId === parentId ? prev.nodes : []
          if (prev?.parentId === parentId && haveSameSubagentNodes(previousNodes, nextNodes) && !prev.loading && !prev.error) {
            return prev
          }

          return {
            parentId,
            nodes: nextNodes,
            loading: false,
            error: null,
          }
        })
      } catch (err) {
        if (cancelled) return
        const errorMsg = err instanceof Error ? err.message : 'Failed to load subagent messages'
        setSubagentModalData(prev => ({
          parentId,
          nodes: prev?.parentId === parentId ? prev.nodes : initialNodes,
          loading: false,
          error: errorMsg,
        }))
      }
    }

    void fetchSubagentMessages()
    pollId = window.setInterval(() => {
      void fetchSubagentMessages()
    }, 1500)

    return () => {
      cancelled = true
      if (pollId !== null) {
        window.clearInterval(pollId)
      }
    }
  }, [subagentPanel?.parentId, conversationId, buildSubagentMap, buildDedicatedSubagentMap, haveSameSubagentNodes])

  useEffect(() => {
    if (!subagentPanel?.parentId) return

    const frameId = window.requestAnimationFrame(() => {
      const container = subagentModalScrollRef.current
      if (!container) return
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
      const targetScrollTop = Math.min(subagentModalScrollTopRef.current, maxScrollTop)
      if (Math.abs(container.scrollTop - targetScrollTop) > 1) {
        container.scrollTop = targetScrollTop
      }
    })

    return () => window.cancelAnimationFrame(frameId)
  }, [subagentPanel?.parentId, subagentModalData?.nodes, subagentModalData?.loading, subagentModalData?.error])

  const getSubagentBadgeMetrics = (count: number) => {
    const label = `${count} SUB-CALL${count === 1 ? '' : 'S'}`
    const width = Math.max(64, Math.round(label.length * 6.5 + 16))
    return { label, width, height: 20 }
  }

  const NOTE_PREVIEW_WIDTH = 320
  const NOTE_PREVIEW_MAX_HEIGHT = 280
  // Hover previews dock away from their graph anchors, so allow enough time to
  // reach the card and scroll it after leaving a node or note pill.
  const DOCKED_PREVIEW_CLOSE_DELAY_MS = 450

  const getNoteBadgeMetrics = (noteText?: string) => {
    const rawNote = noteText || ''
    const headingMatch = rawNote.match(/^\s*##\s+(.+)\s*$/m)
    const isHeadingTitle = !!headingMatch?.[1]
    const normalized = (headingMatch?.[1] || rawNote).replace(/\s+/g, ' ').trim()

    if (!normalized) {
      const lines = ['Note']
      const width = Math.max(44, Math.round(lines[0].length * 6.5 + 14))
      return { lines, width, height: Math.max(20, 10 + lines.length * 11), isHeadingTitle: false }
    }

    const maxLineChars = 22
    const maxLines = 3
    const words = normalized.split(' ')
    const lines: string[] = []
    let currentLine = ''
    let consumedWords = 0

    for (const word of words) {
      const candidate = currentLine ? `${currentLine} ${word}` : word
      if (candidate.length <= maxLineChars) {
        currentLine = candidate
        consumedWords += 1
        continue
      }

      if (currentLine) {
        lines.push(currentLine)
        currentLine = word
        consumedWords += 1
      } else {
        lines.push(word.slice(0, maxLineChars))
        consumedWords += 1
        currentLine = ''
      }

      if (lines.length === maxLines) break
    }

    if (lines.length < maxLines && currentLine) {
      lines.push(currentLine)
    }

    const hasMoreText = consumedWords < words.length || lines.join(' ').length < normalized.length
    if (hasMoreText && lines.length > 0) {
      const lastIndex = lines.length - 1
      const lastLine = lines[lastIndex]
      lines[lastIndex] = `${lastLine.slice(0, maxLineChars - 1).trimEnd()}…`
    }

    const longestLineLength = Math.max(...lines.map(line => line.length))
    const width = Math.min(150, Math.max(56, Math.round(longestLineLength * 6.2 + 16)))
    return { lines, width, height: Math.max(20, 10 + lines.length * 11), isHeadingTitle }
  }

  // Maintain a plain-text processed copy of messages for client-side search
  const [plainMessages, setPlainMessages] = useState<any[]>([])
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = (await stripMarkdownToText(flatMessages as any)) as any
        if (!cancelled) {
          setPlainMessages(Array.isArray(res) ? (res as any[]) : (flatMessages as any[]))
        }
      } catch {
        if (!cancelled) setPlainMessages(flatMessages as any[])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [flatMessages])

  // Search UI state
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [searchOpen, setSearchOpen] = useState<boolean>(false)
  const [searchHoverIndex, setSearchHoverIndex] = useState<number>(-1)
  const searchTokens = useMemo(() => (searchQuery || '').trim().split(/\s+/).filter(Boolean), [searchQuery])
  const searchTokensLower = useMemo(() => searchTokens.map(token => token.toLowerCase()), [searchTokens])
  const filteredResults = useMemo(() => {
    const q = (searchQuery || '').trim().toLowerCase()
    if (!q) return [] as { id: MessageId; content: string; role: string; plain: string }[]
    const res = (plainMessages as any[])
      .filter(m => {
        const plain = (m?.content_plain_text || m?.plain_text_content || m?.content || '').toLowerCase()
        return typeof plain === 'string' && plain.includes(q)
      })
      .map(m => ({
        id: parseId(m.id),
        content: m.content,
        role: m.role,
        plain: m?.content_plain_text || m?.plain_text_content || m?.content || '',
      }))
    return res
  }, [searchQuery, plainMessages])
  const renderHighlightedText = useCallback(
    (text: string) => {
      if (!searchTokens.length) return text
      const regex = new RegExp(`(${searchTokens.map(escapeRegExp).join('|')})`, 'gi')
      const parts = (text || '').split(regex)
      return parts.map((part, idx) =>
        searchTokensLower.includes(part.toLowerCase()) ? (
          <mark
            key={`hl-${idx}`}
            className='bg-amber-200/70 text-stone-900 dark:bg-amber-400/40 dark:text-amber-100 rounded px-0.5'
          >
            {part}
          </mark>
        ) : (
          <span key={`hl-${idx}`}>{part}</span>
        )
      )
    },
    [searchTokens, searchTokensLower]
  )
  const handleSelectSearchResult = useCallback(
    (item: { id: MessageId }) => {
      if (!item) return
      searchFocusPendingRef.current = true
      const path = buildBranchPathForMessage(flatMessages as any, item.id)
      if (path.length > 0) {
        dispatch(chatSliceActions.conversationPathSet(path))
      }
      dispatch(chatSliceActions.focusedChatMessageSet(item.id))
      setSearchOpen(false)
      setSearchQuery('')
      setSearchHoverIndex(-1)
    },
    [dispatch, flatMessages]
  )
  const handleSearchClose = useCallback(() => {
    setSearchOpen(false)
    setSearchHoverIndex(-1)
  }, [])
  const lastCenteredIdRef = useRef<string | null>(null)
  // Only center when focus comes from the search bar, not other sources
  const searchFocusPendingRef = useRef<boolean>(false)
  // Global text selection suppression while panning (originated in Heimdall)
  const addGlobalNoSelect = () => {
    try {
      document.body.classList.add('ygg-no-select')
    } catch {}
  }

  const removeGlobalNoSelect = () => {
    try {
      document.body.classList.remove('ygg-no-select')
    } catch {}
  }

  // Debounced update function for notes
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const debouncedUpdateNote = useCallback(
    (messageId: MessageId, content: string, note: string, note_color?: string | null) => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current)
      }

      debounceTimeoutRef.current = setTimeout(() => {
        dispatch(updateMessage({ id: messageId, content, note, note_color }) as any)
      }, 500) // 500ms debounce
    },
    [dispatch]
  )

  // Handle note dialog
  const handleOpenNoteDialog = useCallback(
    (nodeId: string, position: { x: number; y: number }) => {
      const messageId = parseId(nodeId)
      if (typeof messageId === 'number' && isNaN(messageId)) return

      const message = getCurrentMessage(messageId)
      if (!message) return

      setNoteMessageId(messageId)
      setNoteText(message.note || '')
      setNoteColor(isValidHexColor(message.note_color) ? message.note_color : null)
      noteMessageContentRef.current = message.content // Store content in ref
      setNoteDialogPos(position)
      setShowNoteDialog(true)
      setShowContextMenu(false)
    },
    [getCurrentMessage]
  )

  const handleCloseNoteDialog = useCallback(() => {
    setShowNoteDialog(false)
    setNoteDialogPos(null)
    setNoteMessageId(null)
    setNoteText('')
    setNoteColor(null)
    noteMessageContentRef.current = '' // Clear ref on close
  }, [])

  const handleNoteTextChange = useCallback(
    (newNoteText: string) => {
      setNoteText(newNoteText)

      if (noteMessageId !== null) {
        const messageContent = noteMessageContentRef.current
        if (messageContent) {
          debouncedUpdateNote(noteMessageId, messageContent, newNoteText, noteColor)
        }
      }
    },
    [noteMessageId, noteColor, debouncedUpdateNote]
  )

  const handleNoteColorChange = useCallback(
    (newColor: string | null) => {
      const sanitizedColor = isValidHexColor(newColor) ? newColor : null
      setNoteColor(sanitizedColor)

      if (noteMessageId !== null) {
        const messageContent = noteMessageContentRef.current
        if (messageContent) {
          debouncedUpdateNote(noteMessageId, messageContent, noteText, sanitizedColor)
        }
      }
    },
    [noteMessageId, noteText, debouncedUpdateNote]
  )

  const clearNotePreviewCloseTimeout = useCallback(() => {
    if (notePreviewCloseTimeoutRef.current !== null) {
      window.clearTimeout(notePreviewCloseTimeoutRef.current)
      notePreviewCloseTimeoutRef.current = null
    }
  }, [])

  const scheduleCloseHoveredNote = useCallback(() => {
    clearNotePreviewCloseTimeout()
    notePreviewCloseTimeoutRef.current = window.setTimeout(() => {
      setHoveredNote(null)
      notePreviewCloseTimeoutRef.current = null
    }, DOCKED_PREVIEW_CLOSE_DELAY_MS)
  }, [clearNotePreviewCloseTimeout])

  const handleNoteBadgeClick = useCallback(
    (event: React.MouseEvent<SVGGElement>, nodeId: string) => {
      event.stopPropagation()
      clearNotePreviewCloseTimeout()
      setHoveredNote(null)
      const containerRect = containerRef.current?.getBoundingClientRect()
      if (!containerRect) return

      handleOpenNoteDialog(nodeId, {
        x: event.clientX - containerRect.left,
        y: event.clientY - containerRect.top,
      })
    },
    [handleOpenNoteDialog, clearNotePreviewCloseTimeout]
  )

  const handleNoteBadgeHover = useCallback(
    (event: React.MouseEvent<SVGGElement>, node: ChatNode, note: string) => {
      clearNotePreviewCloseTimeout()
      const containerRect = containerRef.current?.getBoundingClientRect()
      if (!containerRect) return
      setHoveredNote({
        nodeId: node.id,
        note,
        sender: node.sender,
        fallbackPosition: {
          x: event.clientX - containerRect.left,
          y: event.clientY - containerRect.top,
        },
      })
    },
    [clearNotePreviewCloseTimeout]
  )

  const handleNoteBadgeLeave = useCallback(() => {
    scheduleCloseHoveredNote()
  }, [scheduleCloseHoveredNote])

  const handleNotePreviewEnter = useCallback(() => {
    clearNotePreviewCloseTimeout()
  }, [clearNotePreviewCloseTimeout])

  const handleNotePreviewLeave = useCallback(() => {
    scheduleCloseHoveredNote()
  }, [scheduleCloseHoveredNote])

  useEffect(() => {
    return () => {
      if (notePreviewCloseTimeoutRef.current !== null) {
        window.clearTimeout(notePreviewCloseTimeoutRef.current)
      }
      if (messagePreviewCloseTimeoutRef.current !== null) {
        window.clearTimeout(messagePreviewCloseTimeoutRef.current)
      }
    }
  }, [])

  const applyGraphTransform = useCallback(
    (nextPan: { x: number; y: number } = panRef.current, nextZoom: number = zoomRef.current) => {
      graphTransformRef.current?.setAttribute(
        'transform',
        `translate(${nextPan.x + dimensions.width / 2}, ${nextPan.y + 100}) scale(${nextZoom})`
      )
    },
    [dimensions.width]
  )

  const flushPendingInteractionFrame = useCallback(() => {
    if (interactionRafRef.current !== null) {
      cancelAnimationFrame(interactionRafRef.current)
      interactionRafRef.current = null
    }

    const nextPan = pendingPanRef.current
    const nextZoom = pendingZoomRef.current
    const nextSelectionEnd = pendingSelectionEndRef.current

    pendingPanRef.current = null
    pendingZoomRef.current = null
    pendingSelectionEndRef.current = null

    if (nextPan || nextZoom !== null) {
      const committedPan = nextPan ?? panRef.current
      const committedZoom = nextZoom ?? zoomRef.current

      panRef.current = committedPan
      zoomRef.current = committedZoom
      graphTransformCommitRef.current = { pan: committedPan, zoom: committedZoom }
      applyGraphTransform(committedPan, committedZoom)

      if (nextPan) {
        setPan(committedPan)
      }
      if (nextZoom !== null) {
        setZoom(committedZoom)
      }
    }

    if (nextSelectionEnd) {
      setSelectionEnd(nextSelectionEnd)
    }
  }, [applyGraphTransform])

  const queueInteractionFrame = useCallback(() => {
    if (interactionRafRef.current !== null) return

    interactionRafRef.current = requestAnimationFrame(() => {
      interactionRafRef.current = null

      const nextSelectionEnd = pendingSelectionEndRef.current
      pendingSelectionEndRef.current = null

      // Pan/zoom are applied imperatively to the SVG group during high-frequency
      // interactions and committed to React state on interaction end/idle. This
      // avoids regenerating all visible node/edge JSX every pointer or wheel frame.
      if (nextSelectionEnd) {
        setSelectionEnd(nextSelectionEnd)
      }
    })
  }, [])

  const queuePanUpdate = useCallback(
    (nextPan: { x: number; y: number }) => {
      graphTransformDirtyRef.current = true
      graphTransformCommitRef.current = null
      pendingPanRef.current = nextPan
      panRef.current = nextPan
      applyGraphTransform(nextPan, zoomRef.current)
      queueInteractionFrame()
    },
    [applyGraphTransform, queueInteractionFrame]
  )

  const queueSelectionEndUpdate = useCallback(
    (nextSelectionEnd: { x: number; y: number }) => {
      pendingSelectionEndRef.current = nextSelectionEnd
      queueInteractionFrame()
    },
    [queueInteractionFrame]
  )

  const onWindowPointerMove = (e: globalThis.PointerEvent): void => {
    if (isDraggingRef.current) {
      queuePanUpdate({ x: e.clientX - dragStartRef.current.x, y: e.clientY - dragStartRef.current.y })
    } else if (isSelectingRef.current) {
      const svgRect = svgRef.current?.getBoundingClientRect()
      if (svgRect) {
        const svgX = e.clientX - svgRect.left
        const svgY = e.clientY - svgRect.top
        queueSelectionEndUpdate({ x: svgX, y: svgY })
      }
    }
  }

  const onWindowTouchMove = (e: globalThis.TouchEvent): void => {
    if (e.touches.length > 1) return

    if (isDraggingRef.current || isSelectingRef.current) {
      try {
        e.preventDefault()
      } catch {}
    }
    if (!e.touches || e.touches.length === 0) return
    const t = e.touches[0]
    if (isDraggingRef.current) {
      queuePanUpdate({ x: t.clientX - dragStartRef.current.x, y: t.clientY - dragStartRef.current.y })
    } else if (isSelectingRef.current) {
      const svgRect = svgRef.current?.getBoundingClientRect()
      if (svgRect) {
        const svgX = t.clientX - svgRect.left
        const svgY = t.clientY - svgRect.top
        queueSelectionEndUpdate({ x: svgX, y: svgY })
      }
    }
  }

  const addGlobalMoveListeners = (): void => {
    window.addEventListener('pointermove', onWindowPointerMove)
    if (!(window as any).PointerEvent) {
      window.addEventListener('touchmove', onWindowTouchMove, { passive: false })
    }
  }

  const removeGlobalMoveListeners = (): void => {
    window.removeEventListener('pointermove', onWindowPointerMove)
    window.removeEventListener('touchmove', onWindowTouchMove)
  }

  const enableGlobalMoveFallback = (): void => {
    if (useGlobalMoveFallbackRef.current) return
    useGlobalMoveFallbackRef.current = true
    addGlobalMoveListeners()
  }

  const disableGlobalMoveFallback = (): void => {
    if (!useGlobalMoveFallbackRef.current) return
    useGlobalMoveFallbackRef.current = false
    removeGlobalMoveListeners()
  }

  const clampZoomValue = (value: number) => Math.max(0.1, Math.min(3, value))

  const applyZoomAtPoint = useCallback((point: { clientX: number; clientY: number }, desiredZoom: number) => {
    const svgEl = svgRef.current
    const currentZoom = zoomRef.current
    const clampedZoom = clampZoomValue(desiredZoom)

    if (!svgEl) {
      if (Math.abs(clampedZoom - currentZoom) > 0.0001) {
        setZoom(clampedZoom)
      }
      return
    }

    const rect = svgEl.getBoundingClientRect()
    const cursorX = point.clientX - rect.left
    const cursorY = point.clientY - rect.top

    const currentPan = panRef.current
    const tx = currentPan.x + rect.width / 2
    const ty = currentPan.y + 100

    const { x: ox, y: oy } = offsetRef.current ?? fallbackOffsetsRef.current

    const worldX = (cursorX - tx) / currentZoom - ox
    const worldY = (cursorY - ty) / currentZoom - oy

    const newPanX = cursorX - (worldX + ox) * clampedZoom - rect.width / 2
    const newPanY = cursorY - (worldY + oy) * clampedZoom - 100

    const nextPan = { x: newPanX, y: newPanY }
    graphTransformDirtyRef.current = true
    graphTransformCommitRef.current = null
    zoomRef.current = clampedZoom
    panRef.current = nextPan
    pendingZoomRef.current = clampedZoom
    pendingPanRef.current = nextPan
    applyGraphTransform(nextPan, clampedZoom)
  }, [applyGraphTransform])

  const queuePinchFrame = useCallback(
    (point: { clientX: number; clientY: number }, targetZoom: number) => {
      const state = pinchStateRef.current
      if (!state) return

      state.pending = { point, targetZoom }
      if (state.rafId !== null) return

      const frameOwner = state
      frameOwner.rafId = requestAnimationFrame(() => {
        const activeState = pinchStateRef.current
        const payload = frameOwner.pending
        frameOwner.pending = null
        frameOwner.rafId = null

        if (!activeState || !payload) {
          return
        }

        applyZoomAtPoint(payload.point, payload.targetZoom)
      })
    },
    [applyZoomAtPoint]
  )

  const beginPinch = useCallback(() => {
    const touchPointers = Array.from(pointerMapRef.current.values()).filter(ptr => ptr.pointerType === 'touch')
    if (touchPointers.length < 2) return false

    const [first, second] = touchPointers
    const initialDistance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY)
    if (!initialDistance) return false

    pinchStateRef.current = {
      initialDistance,
      initialZoom: zoomRef.current,
      rafId: null,
      pending: null,
    }
    isPinchingRef.current = true
    setIsPinching(true)

    setIsDragging(false)
    isDraggingRef.current = false
    setIsSelecting(false)
    isSelectingRef.current = false
    // These are stable utility functions defined outside hooks, safe to call directly
    removeGlobalNoSelect()
    disableGlobalMoveFallback()
    return true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const endPinch = useCallback(() => {
    const state = pinchStateRef.current
    if (state && state.rafId !== null) {
      cancelAnimationFrame(state.rafId)
    }
    pinchStateRef.current = null
    isPinchingRef.current = false
    setIsPinching(false)
  }, [])

  const openNodeContextMenu = useCallback(
    (params: { nodeId: string; clientX: number; clientY: number; ctrlKey?: boolean; metaKey?: boolean }): void => {
      const { nodeId, clientX, clientY, ctrlKey = false, metaKey = false } = params
      const nodeIdParsed = parseId(nodeId)
      const isAlreadySelected = selectedNodes.includes(nodeIdParsed)

      let newSelectedNodes: MessageId[]

      if (ctrlKey || metaKey) {
        newSelectedNodes = isAlreadySelected
          ? selectedNodes.filter(id => id !== nodeIdParsed)
          : [...selectedNodes, nodeIdParsed]
      } else {
        newSelectedNodes = isAlreadySelected ? selectedNodes.filter(id => id !== nodeIdParsed) : [nodeIdParsed]
      }

      dispatch(chatSliceActions.nodesSelected(newSelectedNodes))

      const rect = containerRef.current?.getBoundingClientRect()
      if (rect && newSelectedNodes.length > 0) {
        setContextMenuPos({ x: clientX - rect.left, y: clientY - rect.top })
        setShowContextMenu(true)
      } else {
        setShowContextMenu(false)
      }
    },
    [dispatch, selectedNodes]
  )

  // Pointer Events with pointer capture for robust drag outside element
  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    pointerMapRef.current.set(e.pointerId, {
      clientX: e.clientX,
      clientY: e.clientY,
      pointerType: e.pointerType,
    })

    const touchPointers = Array.from(pointerMapRef.current.values()).filter(ptr => ptr.pointerType === 'touch')
    if (!isPinchingRef.current && touchPointers.length >= 2 && beginPinch()) {
      return
    }

    if (isPinchingRef.current) {
      return
    }

    const isRightButton = e.button === 2 && e.pointerType !== 'touch'
    const isPrimaryLike = e.button === 0 || e.pointerType === 'touch' || e.buttons === 1
    const target = e.target as EventTarget | null
    const pointerDownNodeId = target instanceof Element ? target.closest('[data-node-id]')?.getAttribute('data-node-id') : null
    const isClickingNode = !!pointerDownNodeId

    if (isRightButton && pointerDownNodeId) {
      // Linux Chromium/Electron can fail to deliver a usable SVG contextmenu event
      // after pointer capture/default suppression. Handle node right-click directly
      // on pointerdown and suppress the follow-up contextmenu if one still arrives.
      try {
        e.preventDefault()
        e.stopPropagation()
      } catch {}
      skipNextNodeContextMenuRef.current = { nodeId: pointerDownNodeId, expiresAt: Date.now() + 750 }
      openNodeContextMenu({
        nodeId: pointerDownNodeId,
        clientX: e.clientX,
        clientY: e.clientY,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
      })
      return
    }

    try {
      e.preventDefault()
    } catch {}
    // Hide any open custom context menu upon new interaction
    setShowContextMenu(false)
    // Capture pointer so we continue to receive move/up events outside
    let hasPointerCapture = false
    try {
      ;(e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId)
      hasPointerCapture = true
    } catch {}

    if (isRightButton) {
      // Only start drag-to-select if clicking on empty space (not on a node)
      if (!isClickingNode) {
        const svgRect = svgRef.current?.getBoundingClientRect()
        if (svgRect) {
          const svgX = e.clientX - svgRect.left
          const svgY = e.clientY - svgRect.top
          dispatch(chatSliceActions.nodesSelected([]))
          setIsSelecting(true)
          isSelectingRef.current = true
          setSelectionStart({ x: svgX, y: svgY })
          setSelectionEnd({ x: svgX, y: svgY })
          addGlobalNoSelect()
          if (!hasPointerCapture) {
            // Fallback only when pointer capture is unavailable
            enableGlobalMoveFallback()
            const onEnd = () => {
              removeGlobalNoSelect()
              disableGlobalMoveFallback()
              window.removeEventListener('mouseup', onEnd)
              window.removeEventListener('touchend', onEnd)
              window.removeEventListener('blur', onEnd)
              isSelectingRef.current = false
              isDraggingRef.current = false
            }
            window.addEventListener('mouseup', onEnd)
            window.addEventListener('touchend', onEnd)
            window.addEventListener('blur', onEnd)
          }
        }
      }
      // If clicking on a node, do nothing here - let the node's onContextMenu handler take over
    } else if (isPrimaryLike) {
      // Store initial pointer position and check if clicking on a node
      pointerDownPosRef.current = { x: e.clientX, y: e.clientY }
      hasMovedRef.current = false
      const target = e.target as unknown as SVGElement
      clickedNodeRef.current = target && (target.tagName === 'rect' || target.tagName === 'circle') ? target : null

      // Don't start dragging immediately - wait for movement in handlePointerMove
      dragStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }
      addGlobalNoSelect()
      if (!hasPointerCapture) {
        // Fallback only when pointer capture is unavailable
        enableGlobalMoveFallback()
        const onEnd = () => {
          removeGlobalNoSelect()
          disableGlobalMoveFallback()
          window.removeEventListener('mouseup', onEnd)
          window.removeEventListener('touchend', onEnd)
          window.removeEventListener('blur', onEnd)
          isDraggingRef.current = false
          isSelectingRef.current = false
        }
        window.addEventListener('mouseup', onEnd)
        window.addEventListener('touchend', onEnd)
        window.addEventListener('blur', onEnd)
      }
    }
  }

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (pointerMapRef.current.has(e.pointerId)) {
      pointerMapRef.current.set(e.pointerId, {
        clientX: e.clientX,
        clientY: e.clientY,
        pointerType: e.pointerType,
      })
    }

    if (isPinchingRef.current && pinchStateRef.current) {
      const touchPointers = Array.from(pointerMapRef.current.values()).filter(ptr => ptr.pointerType === 'touch')
      if (touchPointers.length >= 2) {
        const [first, second] = touchPointers
        const currentDistance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY)
        const state = pinchStateRef.current

        if (state && state.initialDistance > 0 && currentDistance > 0) {
          const ratio = currentDistance / state.initialDistance
          const targetZoom = clampZoomValue(state.initialZoom * ratio)
          const midpoint = {
            clientX: (first.clientX + second.clientX) / 2,
            clientY: (first.clientY + second.clientY) / 2,
          }
          queuePinchFrame(midpoint, targetZoom)
        }
      }
      try {
        e.preventDefault()
      } catch {}
      return // Don't process dragging/selecting while pinching
    }

    // Check if we should start dragging based on movement threshold
    if (!isDraggingRef.current && !isSelectingRef.current && pointerDownPosRef.current) {
      const dx = e.clientX - pointerDownPosRef.current.x
      const dy = e.clientY - pointerDownPosRef.current.y
      const distance = Math.sqrt(dx * dx + dy * dy)
      const DRAG_THRESHOLD = 5 // pixels

      if (distance > DRAG_THRESHOLD) {
        hasMovedRef.current = true
        setIsDragging(true)
        isDraggingRef.current = true
      }
    }

    if (isDraggingRef.current) {
      queuePanUpdate({ x: e.clientX - dragStartRef.current.x, y: e.clientY - dragStartRef.current.y })
    } else if (isSelectingRef.current) {
      const svgRect = svgRef.current?.getBoundingClientRect()
      if (svgRect) {
        const svgX = e.clientX - svgRect.left
        const svgY = e.clientY - svgRect.top
        queueSelectionEndUpdate({ x: svgX, y: svgY })
      }
    }
  }

  const handlePointerUp = (e: React.PointerEvent<SVGSVGElement>): void => {
    pointerMapRef.current.delete(e.pointerId)

    if (isPinchingRef.current) {
      const touchPointers = Array.from(pointerMapRef.current.values()).filter(ptr => ptr.pointerType === 'touch')
      if (touchPointers.length < 2) {
        endPinch()
      }
    }

    try {
      ;(e.currentTarget as SVGSVGElement).releasePointerCapture(e.pointerId)
    } catch {}

    // Handle click on node (when user didn't drag)
    if (!hasMovedRef.current && clickedNodeRef.current && onNodeSelect) {
      const nodeId = clickedNodeRef.current.getAttribute('data-node-id')
      if (nodeId) {
        const nodeIdParsed = parseId(nodeId)
        // If clicked node is already in current path, keep branch selection stable.
        // But when the same focused node is clicked again, route through onNodeSelect
        // so Chat can force a re-scroll to that message.
        if (currentPathIds && currentPathIds.includes(nodeIdParsed)) {
          const isSameFocusedNode =
            focusedChatMessageId != null && String(focusedChatMessageId) === String(nodeIdParsed)

          if (isSameFocusedNode) {
            const currentPath = (currentPathIds ?? []).map(id => String(id))
            onNodeSelect(nodeId, currentPath.length > 0 ? currentPath : getPathWithDescendants(nodeId))
          } else {
            dispatch(chatSliceActions.focusedChatMessageSet(nodeIdParsed))
          }
        } else {
          const path = getPathWithDescendants(nodeId)
          onNodeSelect(nodeId, path)
        }
      }
    }

    // Reset refs
    pointerDownPosRef.current = null
    hasMovedRef.current = false
    clickedNodeRef.current = null

    if (isSelectingRef.current) {
      const rect = containerRef.current?.getBoundingClientRect()
      if (rect) {
        const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top }
        lastMouseUpPosRef.current = pos
        setContextMenuPos(pos)
      }
    }

    handleMouseUp()
  }

  const handlePointerCancel = (e: React.PointerEvent<SVGSVGElement>): void => {
    pointerMapRef.current.delete(e.pointerId)

    if (isPinchingRef.current) {
      const touchPointers = Array.from(pointerMapRef.current.values()).filter(ptr => ptr.pointerType === 'touch')
      if (touchPointers.length < 2) {
        endPinch()
      }
    }

    try {
      ;(e.currentTarget as SVGSVGElement).releasePointerCapture(e.pointerId)
    } catch {}

    handleMouseUp()
  }

  useEffect(() => {
    const pointerMap = pointerMapRef.current
    return () => {
      removeGlobalNoSelect()
      disableGlobalMoveFallback()
      const state = pinchStateRef.current
      if (state && state.rafId !== null) {
        cancelAnimationFrame(state.rafId)
      }
      if (interactionRafRef.current !== null) {
        cancelAnimationFrame(interactionRafRef.current)
        interactionRafRef.current = null
      }
      pendingPanRef.current = null
      pendingZoomRef.current = null
      pendingSelectionEndRef.current = null
      graphTransformDirtyRef.current = false
      graphTransformCommitRef.current = null
      pinchStateRef.current = null
      if (wheelIdleTimeoutRef.current !== null) {
        window.clearTimeout(wheelIdleTimeoutRef.current)
        wheelIdleTimeoutRef.current = null
      }
      setIsPinching(false)
      setIsWheeling(false)
      useGlobalMoveFallbackRef.current = false
      pointerMap.clear()
    }
    // These are stable utility functions, not hook-created, so no dependencies needed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Dedicated cleanup for note debounce timer (only on unmount)
  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current)
      }
    }
  }, [])

  // Keep refs in sync with committed React state for out-of-react listeners.
  // During wheel/pan/pinch, the SVG transform is updated imperatively first and
  // React state is committed on idle/end. Do not let effects from intermediate
  // renders overwrite the live refs with stale state, or culling can briefly use
  // a transform that no longer matches the mounted SVG tree.
  useEffect(() => {
    const commit = graphTransformCommitRef.current

    if (graphTransformDirtyRef.current) {
      const hasCommittedImperativeTransform =
        !!commit &&
        Math.abs(zoom - commit.zoom) < 0.0001 &&
        Math.abs(pan.x - commit.pan.x) < 0.0001 &&
        Math.abs(pan.y - commit.pan.y) < 0.0001

      if (!hasCommittedImperativeTransform) {
        return
      }

      graphTransformDirtyRef.current = false
      graphTransformCommitRef.current = null
    }

    zoomRef.current = zoom
    panRef.current = pan
    applyGraphTransform(pan, zoom)
  }, [zoom, pan, applyGraphTransform])

  useEffect(() => {
    if (!isDragging && !isPinching && !isWheeling && isCullingFrozen) {
      cullingSnapshotRef.current = null
      setIsCullingFrozen(false)
    }
  }, [isDragging, isPinching, isWheeling, isCullingFrozen])

  // When switching conversations, drop any cached tree so a blank/new conversation
  // does not render the previous conversation's tree.
  // useEffect(() => {
  //   console.log('chatData', chatData)
  //   lastDataRef.current = null
  //   seenNodeIdsRef.current.clear()
  //   chatData = null
  //   offsetRef.current = null
  //   hasCenteredRef.current = false
  //   setSelectedNode(null)
  //   setFocusedNodeId(null)
  //   console.log('chatData 2', chatData)
  // }, [conversationId])

  useEffect(() => {
    setSubagentPanel(null)
    setHoveredNote(null)
  }, [conversationId])

  const nodeWidth = 250
  const nodeHeight = 80
  const circleRadius = 20
  const verticalSpacing = compactMode ? 80 : 120
  const horizontalSpacing = compactMode ? 100 : 350

  // Store last non-null data so we can keep rendering while loading
  useEffect(() => {
    if (chatData) lastDataRef.current = chatData
    // console.log('chatData 3', chatData)
  }, [chatData])

  // When the conversation is truly empty (no messages) and we're not loading,
  // clear the cached lastDataRef so the tree renders as empty instead of
  // persisting the last non-null tree.
  useEffect(() => {
    if (!loading && messagesCount === 0 && chatData == null) {
      lastDataRef.current = null
      // Also reset layout/selection state so a future conversation starts fresh
      offsetRef.current = null
      hasCenteredRef.current = false
      setSelectedNode(null)
      setFocusedNodeId(null)
    }
  }, [loading, messagesCount, chatData])

  useEffect(() => {
    if (chatData !== lastDataRef.current) {
      setIsTransitioning(true)

      // Clear the blur after React has time to complete all updates
      const timeoutId = setTimeout(() => {
        setIsTransitioning(false)
      }, 150) // Adjust timing as needed - 150ms is usually enough

      return () => clearTimeout(timeoutId)
    }
  }, [chatData])

  // Helper to recursively filter and flatten empty visual nodes
  const filterEmptyNodes = (node: ChatNode, hasSiblings = false): ChatNode[] => {
    // Look up full message to check for structured content (blocks, tools, etc.)
    const fullMsg = messageById.get(String(node.id))

    const hasContent =
      (node.message && node.message.trim().length > 0) ||
      (fullMsg &&
        ((fullMsg.content && fullMsg.content.trim().length > 0) ||
          (Array.isArray(fullMsg.content_blocks) &&
            fullMsg.content_blocks.some((b: any) => b.type === 'text' && b.text && b.text.trim().length > 0))))

    // 1. Process children first using flatMap to flatten the results
    let filteredChildren: ChatNode[] = []
    if (node.children && node.children.length > 0) {
      const childrenHaveSiblings = node.children.length > 1
      filteredChildren = node.children.flatMap(child => filterEmptyNodes(child, childrenHaveSiblings))
    }

    // 2. If node is empty, skip it and return its children (promotion)
    // Exception: Keep nodes that have siblings (parallel branches)
    if (!hasContent && !hasSiblings) {
      return filteredChildren
    }

    // 3. Otherwise, keep the node with updated children
    return [{ ...node, children: filteredChildren }]
  }

  // Use provided data or fallback to last known (prevents flash on refresh). Do NOT show a fake empty node.
  const currentChatData = useMemo(() => {
    const rawData = chatData ?? lastDataRef.current ?? null
    if (!rawData) return null

    if (filterEmptyMessages) {
      const result = filterEmptyNodes(rawData, false) // Root node has no siblings

      if (result.length === 0) return null

      // If we have exactly one root, use it
      if (result.length === 1) return result[0]

      // If the root was filtered out but left multiple children,
      // we must keep the root to maintain a single tree structure.
      return { ...rawData, children: result }
    }

    return rawData
  }, [chatData, messageById, filterEmptyMessages])

  // Get the complete branch path for a selected node
  // Uses unfiltered flatMessages to ensure filtered nodes are included in the path
  const getPathWithDescendants = (targetNodeId: string): string[] => {
    const nodeIdParsed = parseId(targetNodeId)
    if (typeof nodeIdParsed === 'number' && isNaN(nodeIdParsed)) return []

    // Build path from unfiltered message list (not filtered tree)
    // This ensures all messages on the branch are included, even if filtered from tree view
    const path = buildBranchPathForMessage(flatMessages as any, nodeIdParsed)
    return path.map(id => String(id))
  }

  // Reset view when data changes
  // useEffect(() => {
  //   if (chatData) {
  //     setZoom(compactMode ? 1 : 0.6)
  //     setPan({ x: 0, y: 0 })
  //     setFocusedNodeId(null)
  //     setSelectedNode(null)
  //   }
  // }, [chatData, compactMode])

  // Calculate tree statistics
  // const getTreeStats = (node: ChatNode): TreeStats => {
  //   let totalNodes = 0
  //   let maxDepth = 0
  //   let branches = 0

  //   const traverse = (n: ChatNode, depth: number = 0): void => {
  //     totalNodes++
  //     maxDepth = Math.max(maxDepth, depth)
  //     if (n.children && n.children.length > 1) branches++
  //     n.children?.forEach(child => traverse(child, depth + 1))
  //   }

  //   traverse(node)
  //   return { totalNodes, maxDepth, branches }
  // }

  // const stats = useMemo(
  //   () => (currentChatData ? getTreeStats(currentChatData) : { totalNodes: 0, maxDepth: 0, branches: 0 }),
  //   [currentChatData]
  // )

  // Calculate tree layout in two linear passes. The previous implementation
  // recalculated subtree widths recursively for each sibling and ancestor, which
  // becomes very expensive on large/deep image-heavy trees.
  const calculateTreeLayout = (node: ChatNode): Record<string, Position> => {
    const positions: Record<string, Position> = {}
    const subtreeWidths = new Map<string, number>()

    const calculateSubtreeWidth = (current: ChatNode): number => {
      const children = current.children || []
      if (children.length === 0) {
        subtreeWidths.set(current.id, 1)
        return 1
      }

      const width = children.reduce((sum, child) => sum + calculateSubtreeWidth(child), 0)
      subtreeWidths.set(current.id, width)
      return width
    }

    const layoutNode = (current: ChatNode, x: number, y: number): void => {
      positions[current.id] = { x, y, node: current }

      const children = current.children || []
      if (children.length === 0) return

      const totalWidth = subtreeWidths.get(current.id) ?? 1
      let currentX = x - ((totalWidth - 1) * horizontalSpacing) / 2

      children.forEach(child => {
        const childWidth = subtreeWidths.get(child.id) ?? 1
        const childX = currentX + ((childWidth - 1) * horizontalSpacing) / 2
        layoutNode(child, childX, y + verticalSpacing)
        currentX += childWidth * horizontalSpacing
      })
    }

    calculateSubtreeWidth(node)
    layoutNode(node, 0, 0)
    return positions
  }

  // Memoize layout so it only recomputes when inputs actually change (e.g., data or spacings)
  const positions = useMemo(
    () => (currentChatData ? calculateTreeLayout(currentChatData) : {}),
    [currentChatData, horizontalSpacing, verticalSpacing]
  )
  const positionEntries = useMemo(() => Object.entries(positions), [positions])
  const positionValues = useMemo(() => positionEntries.map(([, pos]) => pos), [positionEntries])

  // Memoized set for quick membership checks of nodes on the current conversation path
  const currentPathSet = useMemo(() => new Set(currentPathIds ?? []), [currentPathIds])
  const selectedNodeSet = useMemo(() => new Set((selectedNodes ?? []).map(id => String(id))), [selectedNodes])

  // Calculate SVG bounds (memoized)
  const bounds = useMemo(() => {
    const values = positionValues
    if (values.length === 0) {
      return { minX: 0, maxX: 0, minY: 0, maxY: 0 }
    }
    return values.reduce<Bounds>(
      (acc, pos) => {
        const isExpanded = !compactMode || pos.node.id === focusedNodeId
        const halfWidth = isExpanded ? nodeWidth / 2 : circleRadius
        const height = isExpanded ? nodeHeight : circleRadius * 2

        return {
          minX: Math.min(acc.minX, pos.x - halfWidth),
          maxX: Math.max(acc.maxX, pos.x + halfWidth),
          minY: Math.min(acc.minY, pos.y),
          maxY: Math.max(acc.maxY, pos.y + height),
        }
      },
      { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
    )
  }, [positionValues, compactMode, focusedNodeId])

  // Initialize offsets once (when we have real data) so the tree doesn't jump when nodes change
  useEffect(() => {
    if (!offsetRef.current && chatData) {
      offsetRef.current = { x: -bounds.minX + 50, y: -bounds.minY + 50 }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds, chatData])

  const hasPositions = Object.keys(positions).length > 0
  const offsetX = hasPositions ? (offsetRef.current ? offsetRef.current.x : -bounds.minX + 50) : 0
  const offsetY = hasPositions ? (offsetRef.current ? offsetRef.current.y : -bounds.minY + 50) : 0

  useEffect(() => {
    fallbackOffsetsRef.current = { x: offsetX, y: offsetY }
  }, [offsetX, offsetY])

  // Center the viewport on a specific node id (string) without altering zoom
  const centerOnNode = (targetNodeId: string): void => {
    const pos = positions[targetNodeId]
    if (!pos) return
    const s = zoomRef.current
    const ox = offsetRef.current ? offsetRef.current.x : offsetX
    const oy = offsetRef.current ? offsetRef.current.y : offsetY
    // Measure container size to compute true center
    const w = dimensions.width || containerRef.current?.offsetWidth || 0
    const h = dimensions.height || containerRef.current?.offsetHeight || 0
    const px = w / 2 - (pos.x + ox) * s - w / 2 // simplifies to -(pos.x + ox) * s
    const py = h / 2 - (pos.y + oy) * s - 100 // account for top translate(+, 100)
    setPan({ x: px, y: py })
  }

  // React to focusedChatMessageId changes by centering the corresponding node when present
  useEffect(() => {
    if (!focusedChatMessageId) return
    const idStr = String(focusedChatMessageId)
    if (!positions[idStr]) return
    // Only auto-center if this focus was initiated by the search bar
    if (!searchFocusPendingRef.current) return
    if (lastCenteredIdRef.current === idStr) return
    centerOnNode(idStr)
    lastCenteredIdRef.current = idStr
    searchFocusPendingRef.current = false
  }, [focusedChatMessageId, positions, dimensions.width, dimensions.height, offsetX, offsetY])

  // Center the view on the root node once, after layout and container dimensions are ready
  useEffect(() => {
    // Need real data and container dimensions
    if (!chatData) return
    if (!dimensions.width || !dimensions.height) return
    // Ensure positions are available and we haven't centered yet
    const id = currentChatData?.id
    if (!id) return
    const root = positions[id]
    if (!root) return
    if (hasCenteredRef.current) return

    // Compute a zoom that fits the current tree bounds into the available viewport
    const contentW = Math.max(1, bounds.maxX - bounds.minX + 100) // add some horizontal padding
    const contentH = Math.max(1, bounds.maxY - bounds.minY + 140) // add some vertical padding
    const availW = Math.max(1, dimensions.width - 120)
    const availH = Math.max(1, dimensions.height - 180) // account for top controls/help
    const fitZoom = Math.min(availW / contentW, availH / contentH)
    const preferredMaxInitialZoom = 0.8
    const targetZoom = Math.max(0.1, Math.min(3, Math.min(fitZoom, preferredMaxInitialZoom)))

    setZoom(targetZoom)

    // Center the root node with the computed zoom
    const s = targetZoom
    const centerX = dimensions.width / 2
    const centerY = dimensions.height / 2
    const px = centerX - (root.x + offsetX) * s - centerX
    const py = centerY - (root.y + offsetY) * s - 300
    setPan({ x: px, y: py })
    hasCenteredRef.current = true
  }, [positions, bounds, dimensions.width, dimensions.height, zoom, offsetX, offsetY, chatData, currentChatData?.id])

  useEffect(() => {
    const updateDimensions = (): void => {
      if (containerRef.current) {
        const { offsetWidth, offsetHeight } = containerRef.current
        setDimensions({ width: offsetWidth, height: offsetHeight })
      }
    }

    updateDimensions()
    window.addEventListener('resize', updateDimensions)
    return () => window.removeEventListener('resize', updateDimensions)
  }, [])

  // When compact mode changes, re-fit the view using the updated bounds/layout.
  useEffect(() => {
    // Ensure we have data and measured dimensions before resetting
    if (!currentChatData) return
    if (!dimensions.width || !dimensions.height) return
    if (Object.keys(positions).length === 0) return

    const raf = requestAnimationFrame(() => {
      resetView()
    })
    return () => cancelAnimationFrame(raf)
  }, [compactMode])

  // Prevent body scroll when mouse is over the component
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleWheel = (e: globalThis.WheelEvent) => {
      // If the wheel event originates inside an element that should allow native scrolling
      // (e.g., the search dropdown list), do NOT hijack it for zooming.
      const cont = containerRef.current
      if (cont) {
        let el = e.target as Node | null
        while (el && el !== cont) {
          if (el instanceof HTMLElement && el.dataset?.heimdallWheelExempt === 'true') {
            // Let the inner element handle its own scrolling
            return
          }
          el = (el as HTMLElement).parentElement
        }
      }

      // Prevent default scrolling behavior and handle zoom instead
      try {
        e.preventDefault()
      } catch {}
      try {
        e.stopPropagation()
      } catch {}

      // Freeze culling during active wheel bursts; unfreeze shortly after wheel idle.
      const WHEEL_IDLE_MS = 100
      if (wheelIdleTimeoutRef.current !== null) {
        window.clearTimeout(wheelIdleTimeoutRef.current)
      }
      setIsWheeling(prev => (prev ? prev : true))
      wheelIdleTimeoutRef.current = window.setTimeout(() => {
        wheelIdleTimeoutRef.current = null
        flushPendingInteractionFrame()
        setIsWheeling(false)
      }, WHEEL_IDLE_MS)

      // Handle zoom centered at the cursor position
      // Normalize delta to pixels across browsers/devices
      const LINE_HEIGHT = 16
      const PAGE_HEIGHT = 800
      const normalizeDeltaPx = (dy: number, mode: number, pageH: number): number => {
        if (mode === 1) return dy * LINE_HEIGHT // lines -> px
        if (mode === 2) return dy * pageH // pages -> px
        return dy // already in px
      }
      const currentZoom = zoomRef.current
      const svgHeight = svgRef.current?.getBoundingClientRect().height ?? PAGE_HEIGHT
      const deltaYPx = normalizeDeltaPx(e.deltaY, e.deltaMode, svgHeight)
      const scale = Math.exp(-deltaYPx * 0.001)
      const targetZoom = clampZoomValue(currentZoom * scale)

      if (Math.abs(targetZoom - currentZoom) < 0.0001) return

      applyZoomAtPoint({ clientX: e.clientX, clientY: e.clientY }, targetZoom)
    }

    // Add wheel listener with passive: false to allow preventDefault
    container.addEventListener('wheel', handleWheel, { passive: false })

    return () => {
      container.removeEventListener('wheel', handleWheel)
      if (wheelIdleTimeoutRef.current !== null) {
        window.clearTimeout(wheelIdleTimeoutRef.current)
        wheelIdleTimeoutRef.current = null
      }
    }
  }, [applyZoomAtPoint, flushPendingInteractionFrame])

  // Expand a visual selection to include hidden messages that sit between selected visible nodes.
  // This keeps filtering as a rendering-only concern: tool-only/empty nodes can be hidden,
  // but actions on a selected branch still receive the complete message chain.
  const expandSelectionToHiddenBranchMessages = (selectedVisibleIds: MessageId[]): MessageId[] => {
    if (selectedVisibleIds.length <= 1 || !Array.isArray(allMessages) || allMessages.length === 0) {
      return selectedVisibleIds
    }

    const selectedSet = new Set(selectedVisibleIds.map(id => String(id)))
    const expandedSet = new Set<string>(selectedSet)
    const messageByIdForSelection = new Map(allMessages.map(message => [String(message.id), message]))

    selectedVisibleIds.forEach(id => {
      const pathToSelectedAncestor: string[] = []
      let cursorId: string | null = String(id)
      const visited = new Set<string>()

      while (cursorId && !visited.has(cursorId)) {
        visited.add(cursorId)
        pathToSelectedAncestor.push(cursorId)

        const parentId = messageByIdForSelection.get(cursorId)?.parent_id
        if (parentId == null) break

        const parentKey = String(parentId)
        if (selectedSet.has(parentKey)) {
          pathToSelectedAncestor.push(parentKey)
          pathToSelectedAncestor.forEach(pathId => expandedSet.add(pathId))
          break
        }

        cursorId = parentKey
      }
    })

    const expandedIds: MessageId[] = []
    allMessages.forEach(message => {
      if (expandedSet.has(String(message.id))) {
        expandedIds.push(message.id)
      }
    })

    return expandedIds
  }

  // Function to determine which nodes are within the selection rectangle
  const getNodesInSelectionRectangle = (): MessageId[] => {
    const selectedNodeIds: MessageId[] = []

    // Calculate selection rectangle bounds
    const minX = Math.min(selectionStart.x, selectionEnd.x)
    const maxX = Math.max(selectionStart.x, selectionEnd.x)
    const minY = Math.min(selectionStart.y, selectionEnd.y)
    const maxY = Math.max(selectionStart.y, selectionEnd.y)

    // Outer group transform (pan + zoom) in screen coordinates
    const tx = pan.x + dimensions.width / 2
    const ty = pan.y + 100
    const s = zoom

    // Account for inner group offset used to keep the tree in view
    Object.values(positions).forEach(({ x, y, node }) => {
      const x0 = x + offsetX
      const y0 = y + offsetY

      const isExpanded = !compactMode || node.id === focusedNodeId

      // Compute node bounds in screen space (after all transforms)
      let left: number, right: number, top: number, bottom: number

      if (isExpanded) {
        // Expanded nodes are rendered as a rectangle with top-left at (x - nodeWidth/2, y)
        left = (x0 - nodeWidth / 2) * s + tx
        right = (x0 + nodeWidth / 2) * s + tx
        top = y0 * s + ty
        bottom = (y0 + nodeHeight) * s + ty
      } else {
        // Compact nodes are rendered as a circle centered at (x, y + circleRadius),
        // but the top of the bounding box is y and height is 2 * circleRadius.
        left = (x0 - circleRadius) * s + tx
        right = (x0 + circleRadius) * s + tx
        top = y0 * s + ty
        bottom = (y0 + circleRadius * 2) * s + ty
      }

      // Intersect test between node bounds and selection rectangle (all in screen space)
      const intersects = right >= minX && left <= maxX && bottom >= minY && top <= maxY
      if (intersects) {
        const nodeIdParsed = parseId(node.id)
        if ((typeof nodeIdParsed === 'number' && !isNaN(nodeIdParsed)) || typeof nodeIdParsed === 'string') {
          selectedNodeIds.push(nodeIdParsed)
        }
      }
    })

    return selectedNodeIds
  }

  // Removed dominant-branch filtering to allow selecting nodes across multiple branches

  // (legacy mouse handlers removed in favor of pointer events)

  const handleMouseUp = (): void => {
    flushPendingInteractionFrame()

    if (isSelecting) {
      // Calculate visible nodes within the selection rectangle, then include hidden
      // messages that are between those visible nodes in the real message tree.
      const selectedNodeIds = expandSelectionToHiddenBranchMessages(getNodesInSelectionRectangle())
      // Replace selection with nodes from this drag (no branch filtering)
      dispatch(chatSliceActions.nodesSelected(selectedNodeIds))
      setIsSelecting(false)
      isSelectingRef.current = false
      // If any nodes were selected, open custom context menu at last mouse-up position
      if (selectedNodeIds.length > 0 && lastMouseUpPosRef.current) {
        setShowContextMenu(true)
      } else {
        setShowContextMenu(false)
      }
    }
    setIsDragging(false)
    isDraggingRef.current = false
    // Extra safety in case global listeners missed it
    removeGlobalNoSelect()
    disableGlobalMoveFallback()
  }

  // Handle right-click context menu events
  const handleContextMenu = useCallback(
    (e: React.MouseEvent<SVGElement>, nodeId: string): void => {
      e.preventDefault() // Prevent default browser context menu
      e.stopPropagation()

      openNodeContextMenu({
        nodeId,
        clientX: e.clientX,
        clientY: e.clientY,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
      })
    },
    [openNodeContextMenu]
  )

  const getNodeIdFromTarget = useCallback((target: EventTarget | null): string | null => {
    if (!(target instanceof Element)) return null
    const nodeEl = target.closest('[data-node-id]')
    if (!nodeEl) return null
    const nodeId = nodeEl.getAttribute('data-node-id')
    return nodeId || null
  }, [])

  const isContextMenuExemptTarget = useCallback((target: EventTarget | null): boolean => {
    let el = target as Node | null
    while (el && el !== containerRef.current) {
      if (el instanceof HTMLElement && el.dataset?.heimdallContextmenuExempt === 'true') {
        return true
      }
      el = (el as HTMLElement).parentElement
    }
    return false
  }, [])

  const handleSvgClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const target = e.target as SVGElement
      if (target === e.currentTarget || target.tagName === 'svg') {
        setFocusedNodeId(null)
        // Clear selection when clicking on empty space
        if (onNodeSelect) {
          onNodeSelect('', [])
        }
      }
    },
    [onNodeSelect]
  )

  const handleSvgContextMenu = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (isContextMenuExemptTarget(e.target)) {
        return
      }

      const nodeId = getNodeIdFromTarget(e.target)
      if (nodeId) {
        const skipped = skipNextNodeContextMenuRef.current
        if (skipped?.nodeId === nodeId && skipped.expiresAt > Date.now()) {
          e.preventDefault()
          e.stopPropagation()
          skipNextNodeContextMenuRef.current = null
          return
        }

        handleContextMenu(e as unknown as React.MouseEvent<SVGElement>, nodeId)
        return
      }

      e.preventDefault()
    },
    [getNodeIdFromTarget, handleContextMenu, isContextMenuExemptTarget]
  )

  const performDeleteNodes = useCallback(
    async (idsToDelete: MessageId[]): Promise<void> => {
      try {
        if (idsToDelete.length === 0 || !conversationId) {
          return
        }

        // Dispatch the delete action with conversationId and storageMode
        await (dispatch as any)(deleteSelectedNodes({ ids: idsToDelete, conversationId, storageMode })).unwrap()

        // Clear selection after successful delete
        dispatch(chatSliceActions.nodesSelected([]))

        // Refresh the message tree (now fetches both tree and messages in one call)
        await (dispatch as any)(fetchMessageTree({ conversationId, storageMode }))
      } catch (error) {
        console.error('Failed to delete nodes:', error)
      }
    },
    [dispatch, conversationId, storageMode]
  )

  const closeDeleteNodesModal = useCallback(() => {
    setShowDeleteConfirmModal(false)
    setPendingDeleteNodeIds([])
    setDontAskDeleteAgain(false)
  }, [])

  const confirmDeleteNodesModal = useCallback(async () => {
    if (dontAskDeleteAgain) {
      setConfirmDeleteSelection(false)
    }
    const idsToDelete = pendingDeleteNodeIds
    closeDeleteNodesModal()
    await performDeleteNodes(idsToDelete)
  }, [dontAskDeleteAgain, pendingDeleteNodeIds, closeDeleteNodesModal, performDeleteNodes])

  // Delete selected nodes using their message IDs
  const handleDeleteNodes = async (): Promise<void> => {
    const ids = selectedNodes || []
    if (ids.length === 0 || !conversationId) {
      setShowContextMenu(false)
      return
    }

    setShowContextMenu(false)

    if (!confirmDeleteSelection) {
      await performDeleteNodes(ids)
      return
    }

    setPendingDeleteNodeIds(ids)
    setDontAskDeleteAgain(false)
    setShowDeleteConfirmModal(true)
  }

  // Copy messages along the union of root->selected-node paths
  const handleCopySelectedPaths = async (): Promise<void> => {
    try {
      const ids = selectedNodes || []
      if (!currentChatData || ids.length === 0) {
        setShowContextMenu(false)
        return
      }
      // Build id -> message map from the current tree
      const messagesById = new Map<string, string>()
      const visit = (node: ChatNode | null): void => {
        if (!node) return
        messagesById.set(node.id, node.message)
        node.children?.forEach(visit)
      }
      visit(currentChatData)

      // Collect only selected nodes' messages, preserving the selectedNodes order
      const messages: string[] = []
      const seen = new Set<string>()
      for (const idNum of ids) {
        const idStr = String(idNum)
        if (seen.has(idStr)) continue
        seen.add(idStr)
        const msg = messagesById.get(idStr)
        if (typeof msg === 'string') messages.push(msg)
      }

      const text = messages.join('\n\n')
      if (text.trim().length > 0) {
        try {
          await navigator.clipboard.writeText(text)
        } catch (err) {
          // Fallback if clipboard API fails
          const ta = document.createElement('textarea')
          ta.value = text
          ta.style.position = 'fixed'
          ta.style.left = '-9999px'
          document.body.appendChild(ta)
          ta.focus()
          ta.select()
          try {
            document.execCommand('copy')
          } finally {
            document.body.removeChild(ta)
          }
        }
      }
    } finally {
      setShowContextMenu(false)
      // Clear selection after copy
      dispatch(chatSliceActions.nodesSelected([]))
    }
  }

  const buildMessagesToCopyFromSelection = (): MessageToCopy[] => {
    const ids = selectedNodes || []
    if (ids.length === 0) return []

    const selectedSet = new Set(ids.map(id => String(id)))
    const childrenByParent = new Map<string, Message[]>()

    allMessages.forEach(msg => {
      if (msg.parent_id != null) {
        const parentId = String(msg.parent_id)
        const siblings = childrenByParent.get(parentId) || []
        siblings.push(msg)
        childrenByParent.set(parentId, siblings)
      }
    })

    const orderedMessages: Message[] = []
    const visited = new Set<string>()

    const visitSelectedSubtree = (msg: Message): void => {
      const id = String(msg.id)
      if (visited.has(id) || !selectedSet.has(id)) return

      visited.add(id)
      orderedMessages.push(msg)

      const children = childrenByParent.get(id) || []
      children.forEach(child => {
        if (selectedSet.has(String(child.id))) {
          visitSelectedSubtree(child)
        }
      })
    }

    // Start at selected roots so copied branches keep their original parent/child
    // shape. A selected message becomes a top-level root only when its original
    // parent is outside the selection.
    allMessages.forEach(msg => {
      const id = String(msg.id)
      if (!selectedSet.has(id)) return
      const parentId = msg.parent_id == null ? null : String(msg.parent_id)
      if (parentId == null || !selectedSet.has(parentId)) {
        visitSelectedSubtree(msg)
      }
    })

    // Defensive fallback for malformed/cyclic data or stale selections.
    allMessages.forEach(msg => {
      const id = String(msg.id)
      if (selectedSet.has(id) && !visited.has(id)) {
        visitSelectedSubtree(msg)
      }
    })

    return orderedMessages.map(msg => {
      const sourceId = String(msg.id)
      const parentSourceId = msg.parent_id != null && selectedSet.has(String(msg.parent_id)) ? String(msg.parent_id) : null

      return {
        source_id: sourceId,
        parent_source_id: parentSourceId,
        role: msg.role,
        content: msg.content,
        thinking_block: msg.thinking_block || '',
        model_name: msg.model_name || 'unknown',
        tool_calls: msg.tool_calls || undefined,
        note: msg.note || undefined,
        note_color: msg.note_color || null,
        content_blocks: msg.content_blocks || undefined,
      }
    })
  }

  const handleOpenConversationSelector = (mode: ConversationTransferMode): void => {
    if (!selectedNodes || selectedNodes.length === 0) {
      setShowContextMenu(false)
      return
    }

    setShowContextMenu(false)
    setConversationTransferMode(mode)
    setConversationSelectorError(null)
    setShowConversationSelector(true)
    void refetchConversations()
  }

  const handleCloseConversationSelector = useCallback(() => {
    if (isAddingToConversation) return
    setShowConversationSelector(false)
    setConversationSelectorError(null)
  }, [isAddingToConversation])

  const handleAddSelectionToConversation = async (targetConversation: Conversation): Promise<void> => {
    if (isAddingToConversation) return

    try {
      setConversationSelectorError(null)
      const messagesToCopy = buildMessagesToCopyFromSelection()
      const idsToTransfer = [...(selectedNodes || [])]

      if (messagesToCopy.length === 0 || idsToTransfer.length === 0) {
        setConversationSelectorError('No selected messages could be transferred.')
        return
      }

      if (conversationTransferMode === 'move' && !conversationId) {
        setConversationSelectorError('Cannot move messages because the source chat is unknown.')
        return
      }

      setIsAddingToConversation(true)
      const targetStorageMode = (targetConversation.storage_mode || storageMode || 'cloud') as 'cloud' | 'local'

      await (dispatch as any)(
        insertBulkMessages({
          conversationId: targetConversation.id,
          messages: messagesToCopy,
          storageMode: targetStorageMode,
        })
      ).unwrap()

      if (conversationTransferMode === 'move' && conversationId) {
        await (dispatch as any)(
          deleteSelectedNodes({ ids: idsToTransfer, conversationId, storageMode })
        ).unwrap()
        await (dispatch as any)(fetchMessageTree({ conversationId, storageMode })).unwrap()
        queryClient.invalidateQueries({ queryKey: ['conversations', conversationId, 'messages'] })
      }

      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      queryClient.invalidateQueries({ queryKey: ['conversations', targetConversation.id, 'messages'] })
      if (targetConversation.project_id) {
        queryClient.invalidateQueries({ queryKey: ['conversations', 'project', targetConversation.project_id] })
      }

      setShowConversationSelector(false)
      dispatch(chatSliceActions.nodesSelected([]))
    } catch (error) {
      console.error('Failed to transfer selection to existing chat:', error)
      setConversationSelectorError(
        error instanceof Error
          ? error.message
          : `Failed to ${conversationTransferMode === 'move' ? 'move' : 'copy'} messages to selected chat.`
      )
    } finally {
      setIsAddingToConversation(false)
    }
  }

  // Create new chat from selected nodes
  const handleCreateNewChat = async (): Promise<void> => {
    try {
      const messagesToCopy = buildMessagesToCopyFromSelection()

      if (messagesToCopy.length === 0) {
        setShowContextMenu(false)
        return
      }

      // Generate title from first message content
      const firstContent = messagesToCopy[0].content
      const title = firstContent.slice(0, 100) + (firstContent.length > 100 ? '...' : '')

      // Create new conversation using the current project context and copy
      // system prompt, context, and cwd
      const projectId = currentConversation?.project_id || null
      const systemPrompt = currentConversation?.system_prompt || null
      const conversationContext = currentConversation?.conversation_context || null
      const sourceCwd = typeof currentConversation?.cwd === 'string' ? currentConversation.cwd : null
      const newConversation = await (dispatch as any)(
        createConversation({ title, projectId, systemPrompt, conversationContext, storageMode })
      ).unwrap()

      if (!newConversation?.id) {
        console.error('Failed to create new conversation')
        return
      }

      const inheritedCwd = sourceCwd?.trim()
      if (inheritedCwd) {
        const nextStorageMode = (newConversation.storage_mode || storageMode || 'cloud') as 'cloud' | 'local'
        try {
          await (dispatch as any)(
            updateCwd({
              id: newConversation.id,
              cwd: inheritedCwd,
              storageMode: nextStorageMode,
            })
          ).unwrap()
        } catch (cwdError) {
          console.error('Failed to copy cwd to new conversation:', cwdError)
        }
      }

      const nextStorageMode = (newConversation.storage_mode || storageMode || 'cloud') as 'cloud' | 'local'

      // Insert messages as a chain preserving their structure
      await (dispatch as any)(
        insertBulkMessages({
          conversationId: newConversation.id,
          messages: messagesToCopy,
          storageMode: nextStorageMode, // Pass storage mode explicitly since new conversation isn't in cache yet
        })
      ).unwrap()

      // Fetch messages and tree to populate the new conversation before navigation
      await (dispatch as any)(fetchMessageTree({ conversationId: newConversation.id, storageMode: nextStorageMode })).unwrap()

      // Invalidate React Query cache to update conversations list in sidebar/dropdowns
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      if (projectId) {
        queryClient.invalidateQueries({ queryKey: ['conversations', 'project', projectId] })
      }

      // Navigate to the new chat with storageMode in state for immediate API routing
      navigate(`/chat/${newConversation.project_id || 'unknown'}/${newConversation.id}`, {
        state: { storageMode: newConversation.storage_mode || storageMode },
      })
    } catch (error) {
      console.error('Failed to create new chat from selection:', error)
    } finally {
      setShowContextMenu(false)
      // Clear selection after creating new chat
      dispatch(chatSliceActions.nodesSelected([]))
    }
  }

  // Close context menu on outside click
  useEffect(() => {
    if (!showContextMenu) return
    const onDown = () => {
      setShowContextMenu(false)
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setShowContextMenu(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [showContextMenu])

  useEffect(() => {
    if (!showConversationSelector) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') handleCloseConversationSelector()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [showConversationSelector, handleCloseConversationSelector])

  // Close note dialog only on escape key (not on outside click)
  useEffect(() => {
    if (!showNoteDialog) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') handleCloseNoteDialog()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [showNoteDialog, handleCloseNoteDialog])

  const resetView = (): void => {
    // Compute bounds for fitting that ignore focusedNodeId so fit is consistent
    // across calls regardless of previous focus state.
    const fitBounds = (() => {
      const values = Object.values(positions)
      if (values.length === 0) {
        return { minX: 0, maxX: 0, minY: 0, maxY: 0 }
      }
      return values.reduce<Bounds>(
        (acc, pos) => {
          // For fitting, treat nodes as expanded only when not in compactMode
          const isExpandedForFit = !compactMode
          const halfWidth = isExpandedForFit ? nodeWidth / 2 : circleRadius
          const height = isExpandedForFit ? nodeHeight : circleRadius * 2

          return {
            minX: Math.min(acc.minX, pos.x - halfWidth),
            maxX: Math.max(acc.maxX, pos.x + halfWidth),
            minY: Math.min(acc.minY, pos.y),
            maxY: Math.max(acc.maxY, pos.y + height),
          }
        },
        { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
      )
    })()

    // Fit-to-screen zoom based on local fitBounds and container dimensions
    const contentW = Math.max(1, fitBounds.maxX - fitBounds.minX + 100)
    const contentH = Math.max(1, fitBounds.maxY - fitBounds.minY + 140)
    const availW = Math.max(1, dimensions.width - 120)
    const availH = Math.max(1, dimensions.height - 180)
    const fitZoom = Math.min(availW / contentW, availH / contentH)
    const preferredMaxInitialZoom = 1
    const newZoom = Math.max(0.1, Math.min(3, Math.min(fitZoom, preferredMaxInitialZoom)))
    setZoom(newZoom)
    setFocusedNodeId(null)

    // Recompute base offset based on local fitBounds
    offsetRef.current = { x: -fitBounds.minX + 50, y: -fitBounds.minY + 50 }

    // Center the root node in the viewport using the new zoom
    const id = currentChatData?.id
    if (!id) return
    const root = positions[id]
    if (!root) return
    const s = newZoom
    const ox = offsetRef.current.x
    const oy = offsetRef.current.y
    const centerX = dimensions.width / 2
    const centerY = dimensions.height / 2
    const px = centerX - ((root.x ?? 0) + ox) * s - centerX
    const py = centerY - ((root.y ?? 0) + oy) * s - 440
    setPan({ x: px, y: py })

    // We've just centered explicitly
    hasCenteredRef.current = true
  }

  const zoomIn = (): void => setZoom(prev => Math.min(3, prev * 1.2))
  const zoomOut = (): void => setZoom(prev => Math.max(0.1, prev / 1.2))

  // Calculate viewport bounds for culling off-screen nodes
  const viewportBounds = useMemo(() => {
    if (!dimensions.width || !dimensions.height) {
      return null
    }

    // Add padding to include nodes slightly outside viewport for smooth scrolling
    const padding = Math.max(nodeWidth, nodeHeight)

    return {
      minX: -padding,
      maxX: dimensions.width + padding,
      minY: -padding,
      maxY: dimensions.height + padding,
    }
  }, [dimensions.width, dimensions.height])

  const cullingPan = isCullingFrozen ? (cullingSnapshotRef.current?.pan ?? pan) : pan
  const cullingZoom = isCullingFrozen ? (cullingSnapshotRef.current?.zoom ?? zoom) : zoom

  // Filter visible positions based on viewport bounds
  const visiblePositions = useMemo(() => {
    if (!viewportBounds) {
      return positions
    }

    // Transform from tree coordinates to screen coordinates
    // Transform chain: translate(offsetX, offsetY) -> scale(zoom) -> translate(pan.x + width/2, pan.y + 100)
    const tx = cullingPan.x + dimensions.width / 2
    const ty = cullingPan.y + 100

    const visible: Record<string, Position> = {}

    positionEntries.forEach(([id, pos]) => {
      const { x, y, node } = pos
      const isExpanded = !compactMode || node.id === focusedNodeId
      const width = isExpanded ? nodeWidth : circleRadius * 2
      const height = isExpanded ? nodeHeight : circleRadius * 2

      // Convert tree coordinates to screen coordinates
      const screenX = (x + offsetX) * cullingZoom + tx
      const screenY = (y + offsetY) * cullingZoom + ty

      // Node bounds in screen space
      const left = screenX - (width / 2) * cullingZoom
      const right = screenX + (width / 2) * cullingZoom
      const top = screenY
      const bottom = screenY + height * cullingZoom

      // Check if node intersects viewport
      if (
        right >= viewportBounds.minX &&
        left <= viewportBounds.maxX &&
        bottom >= viewportBounds.minY &&
        top <= viewportBounds.maxY
      ) {
        visible[id] = pos
      }
    })

    return visible
  }, [
    positionEntries,
    viewportBounds,
    compactMode,
    focusedNodeId,
    cullingPan.x,
    cullingPan.y,
    cullingZoom,
    offsetX,
    offsetY,
    dimensions.width,
  ])

  const parentByChildId = useMemo(() => {
    const parentMap = new Map<string, string>()
    positionValues.forEach(({ node }) => {
      node.children?.forEach(child => {
        parentMap.set(child.id, node.id)
      })
    })
    return parentMap
  }, [positionValues])

  const heimdallNodeIdSet = useMemo(() => new Set(positionEntries.map(([id]) => id)), [positionEntries])
  const visiblePositionEntries = useMemo(() => Object.entries(visiblePositions), [visiblePositions])
  const visiblePositionValues = useMemo(() => visiblePositionEntries.map(([, pos]) => pos), [visiblePositionEntries])
  const visiblePositionIdSet = useMemo(() => new Set(visiblePositionEntries.map(([id]) => id)), [visiblePositionEntries])

  const getDockedPreviewLayout = (
    anchorNodeId: string,
    preferredWidth: number,
    maxHeight: number,
    fallbackPosition: { x: number; y: number }
  ) => {
    // Dock on the panel half opposite the graph anchor so the preview never
    // covers the interactive node or note pill that opened it.
    const dockMargin = 12
    const halfWidth = dimensions.width / 2
    const width = Math.min(preferredWidth, Math.max(220, halfWidth - dockMargin * 2))
    const nodePos = positions[anchorNodeId]
    const screenTx = cullingPan.x + dimensions.width / 2
    const screenTy = cullingPan.y + 100
    const anchorCenterX = nodePos ? (nodePos.x + offsetX) * cullingZoom + screenTx : fallbackPosition.x
    const anchorTopY = nodePos ? (nodePos.y + offsetY) * cullingZoom + screenTy : fallbackPosition.y
    const dockRight = anchorCenterX < halfWidth

    return {
      left: dockRight ? dimensions.width - width - dockMargin : dockMargin,
      top: Math.max(10, Math.min(anchorTopY, dimensions.height - maxHeight - 10)),
      width,
    }
  }

  const clearMessagePreviewCloseTimeout = useCallback(() => {
    if (messagePreviewCloseTimeoutRef.current !== null) {
      window.clearTimeout(messagePreviewCloseTimeoutRef.current)
      messagePreviewCloseTimeoutRef.current = null
    }
  }, [])

  const scheduleCloseMessagePreview = useCallback(() => {
    clearMessagePreviewCloseTimeout()
    messagePreviewCloseTimeoutRef.current = window.setTimeout(() => {
      setSelectedNode(null)
      messagePreviewCloseTimeoutRef.current = null
    }, DOCKED_PREVIEW_CLOSE_DELAY_MS)
  }, [clearMessagePreviewCloseTimeout])

  const handleNodeMouseEnter = useCallback(
    (e: React.MouseEvent<SVGElement>) => {
      clearMessagePreviewCloseTimeout()
      const nodeId = getNodeIdFromTarget(e.target)
      if (!nodeId) return
      const pos = positions[nodeId]
      if (pos?.node) {
        setSelectedNode(pos.node)
      }

      const containerRect = containerRef.current?.getBoundingClientRect()
      if (containerRect) {
        setMousePosition({
          x: e.clientX - containerRect.left,
          y: e.clientY - containerRect.top,
        })
      }
    },
    [clearMessagePreviewCloseTimeout, getNodeIdFromTarget, positions]
  )

  // Moving off the node starts the close timer; entering the docked card cancels it
  // (so it can be scrolled), and leaving the card restarts it. A new node-hover
  // replaces the content via handleNodeMouseEnter.
  const handleNodeMouseLeave = useCallback(() => {
    scheduleCloseMessagePreview()
  }, [scheduleCloseMessagePreview])

  const handleMessagePreviewEnter = useCallback(() => {
    clearMessagePreviewCloseTimeout()
  }, [clearMessagePreviewCloseTimeout])

  const handleMessagePreviewLeave = useCallback(() => {
    scheduleCloseMessagePreview()
  }, [scheduleCloseMessagePreview])

  const renderConnections = (): JSX.Element[] => {
    const connections: JSX.Element[] = []
    const drawnConnections = new Set<string>() // Track to avoid duplicates
    const tx = cullingPan.x + dimensions.width / 2
    const ty = cullingPan.y + 100

    const toScreenPoint = (x: number, y: number) => ({
      x: (x + offsetX) * cullingZoom + tx,
      y: (y + offsetY) * cullingZoom + ty,
    })

    const segmentIntersectsViewport = (...points: Array<{ x: number; y: number }>) => {
      if (!viewportBounds) return true
      const xs = points.map(point => point.x)
      const ys = points.map(point => point.y)
      const minX = Math.min(...xs)
      const maxX = Math.max(...xs)
      const minY = Math.min(...ys)
      const maxY = Math.max(...ys)

      return (
        maxX >= viewportBounds.minX &&
        minX <= viewportBounds.maxX &&
        maxY >= viewportBounds.minY &&
        minY <= viewportBounds.maxY
      )
    }

    // Helper to draw connection from parent to child
    const drawConnection = (parentPos: Position, childPos: Position, childNode: ChatNode) => {
      const { x: parentX, y: parentY, node: parent } = parentPos
      const { x: childX, y: childY } = childPos

      const isParentExpanded = !compactMode || parent.id === focusedNodeId
      const parentBottomY = parentY + (isParentExpanded ? nodeHeight : circleRadius * 2)

      const parentNodeIdParsed = parseId(parent.id)
      const isParentOnPath =
        ((typeof parentNodeIdParsed === 'number' && !isNaN(parentNodeIdParsed)) ||
          typeof parentNodeIdParsed === 'string') &&
        currentPathSet.has(parentNodeIdParsed)

      const childNodeIdParsed = parseId(childNode.id)
      const isChildOnPath =
        ((typeof childNodeIdParsed === 'number' && !isNaN(childNodeIdParsed)) ||
          typeof childNodeIdParsed === 'string') &&
        currentPathSet.has(childNodeIdParsed)
      const isOnCurrentPath = isParentOnPath && isChildOnPath

      const connectionKey = `${parent.id}-${childNode.id}`
      if (drawnConnections.has(connectionKey)) return
      drawnConnections.add(connectionKey)

      if (parent.children.length === 1) {
        const screenParent = toScreenPoint(parentX, parentBottomY)
        const screenChild = toScreenPoint(childX, childY)
        if (!segmentIntersectsViewport(screenParent, screenChild)) return

        // Single child - straight line
        connections.push(
          <line
            key={connectionKey}
            x1={parentX}
            y1={parentBottomY}
            x2={childX}
            y2={childY}
            className={
              isOnCurrentPath
                ? 'stroke-blue-400/80 dark:stroke-orange-300/80'
                : 'stroke-stone-300/70 dark:stroke-white/10'
            }
            strokeWidth={isOnCurrentPath ? '2.4' : '1.6'}
          />
        )
      } else {
        // Multiple children - branching structure. Keep the branch rail inside the
        // vertical gap between parent and child so it never overshoots above/through
        // top-level nodes when compact/full heights differ.
        const availableGap = Math.max(1, childY - parentBottomY)
        const branchY = parentBottomY + availableGap * 0.55
        const curveOffset = Math.max(6, Math.min(18, availableGap * 0.3))

        const screenParent = toScreenPoint(parentX, parentBottomY)
        const screenBranch = toScreenPoint(childX, branchY)
        const screenChild = toScreenPoint(childX, childY)

        if (!segmentIntersectsViewport(screenParent, screenBranch, screenChild)) return

        const path = `
          M ${parentX} ${parentBottomY}
          C ${parentX} ${parentBottomY + curveOffset}, ${parentX} ${branchY}, ${parentX} ${branchY}
          C ${parentX} ${branchY}, ${childX} ${branchY}, ${childX} ${branchY}
          C ${childX} ${branchY}, ${childX} ${childY - curveOffset}, ${childX} ${childY}
        `

        connections.push(
          <path
            key={`${connectionKey}-path`}
            d={path}
            fill='none'
            className={
              isOnCurrentPath
                ? 'stroke-blue-400/80 dark:stroke-orange-300/80'
                : 'stroke-stone-300/70 dark:stroke-white/10'
            }
            strokeWidth={isOnCurrentPath ? '2.4' : '1.6'}
          />
        )

        // Keep the graph minimal: branching is communicated by the softened connector path,
        // without extra junction dots around the nodes.
      }
    }

    // First pass: Draw connections from visible parent nodes to all their children
    visiblePositionValues.forEach(pos => {
      const { node } = pos
      if (node.children && node.children.length > 0) {
        const parentPos = positions[node.id]
        if (!parentPos) return

        const verticalDropHeight = verticalSpacing * 0.4
        const isParentExpanded = !compactMode || node.id === focusedNodeId
        const parentBottomY = parentPos.y + (isParentExpanded ? nodeHeight : circleRadius * 2)
        const branchY = parentBottomY + verticalDropHeight

        // Draw vertical drop and junction for multi-child nodes when visible
        if (node.children.length > 1) {
          const screenParent = toScreenPoint(parentPos.x, parentBottomY)
          const screenBranch = toScreenPoint(parentPos.x, branchY)
          if (segmentIntersectsViewport(screenParent, screenBranch)) {
            // No standalone drop or junction marker in the minimal tree style.
            // Child connector paths carry the branch shape without extra visual noise.
          }
        }

        // Draw connections to each child
        node.children.forEach(child => {
          const childPos = positions[child.id]
          if (childPos) {
            drawConnection(parentPos, childPos, child)
          }
        })
      }
    })

    // Second pass: Draw connections from visible children to their culled parents
    visiblePositionValues.forEach(pos => {
      const { node } = pos
      const parentId = parentByChildId.get(node.id)
      if (!parentId) return

      // Only draw if parent exists but is NOT visible (culled)
      if (visiblePositionIdSet.has(parentId)) return

      const parentPos = positions[parentId]
      if (parentPos) {
        drawConnection(parentPos, pos, node)
      }
    })

    return connections
  }

  const getNodeThemeColors = useCallback(
    (sender: ChatNode['sender'], isVisible: boolean) => {
      if (!customThemeEnabled) {
        return null
      }

      const senderKey = resolveHeimdallNodeThemeKey(sender)
      const nodeTheme = customTheme.colors.heimdallNodes[senderKey]

      return {
        fill: getThemeModeColor(isVisible ? nodeTheme.visibleFill : nodeTheme.fill, isDarkMode),
        stroke: getThemeModeColor(isVisible ? nodeTheme.visibleStroke : nodeTheme.stroke, isDarkMode),
      }
    },
    [customTheme, customThemeEnabled, isDarkMode]
  )

  const heimdallNodeTimestamps = useMemo(() => {
    if (!heatmapMode) {
      return {
        byNodeId: new Map<string, number>(),
        progressByNodeId: new Map<string, number>(),
      }
    }

    const entries = positionEntries
      .map(([nodeId]) => {
        const createdAt = messageById.get(String(nodeId))?.created_at
        const timestamp = createdAt ? new Date(createdAt).getTime() : Number.NaN
        return Number.isFinite(timestamp) ? [String(nodeId), timestamp] : null
      })
      .filter((entry): entry is [string, number] => entry !== null)

    const sortedEntries = [...entries].sort((a, b) => {
      if (a[1] !== b[1]) {
        return a[1] - b[1]
      }
      return a[0].localeCompare(b[0])
    })

    const progressByNodeId = new Map<string, number>()
    const denominator = Math.max(sortedEntries.length - 1, 1)

    sortedEntries.forEach(([nodeId], index) => {
      progressByNodeId.set(nodeId, sortedEntries.length <= 1 ? 1 : index / denominator)
    })

    return {
      byNodeId: new Map(entries),
      progressByNodeId,
    }
  }, [heatmapMode, messageById, positionEntries])

  const getHeatmapNodeColors = useCallback(
    (nodeId: string, isVisible: boolean) => {
      if (!heatmapMode) {
        return null
      }

      const progress = heimdallNodeTimestamps.progressByNodeId.get(String(nodeId))
      if (progress == null) {
        return null
      }

      const fill = getHeatmapColor(progress)

      return {
        fill,
        stroke: isVisible ? (isDarkMode ? '#fb923c' : '#10b981') : 'rgba(15,23,42,0.45)',
        text: getReadableTextColor(fill),
      }
    },
    [heatmapMode, heimdallNodeTimestamps, isDarkMode]
  )

  const heimdallPanelBackgroundColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.heimdallPanelBg, isDarkMode)
    : undefined
  const heimdallNotePillBackgroundColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.heimdallNotePillBg, isDarkMode)
    : isDarkMode
      ? '#f59e0b'
      : '#3b82f6'
  const heimdallNotePillTextColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.heimdallNotePillText, isDarkMode)
    : isDarkMode
      ? '#0c0a09'
      : '#ffffff'
  const heimdallNotePillBorderColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.heimdallNotePillBorder, isDarkMode)
    : 'rgba(0,0,0,0.18)'
  const heimdallNodeHoverModalTextColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.heimdallNodeHoverModalText, isDarkMode)
    : isDarkMode
      ? '#e7e5e4'
      : '#292524'
  const heimdallNodeHoverModalTitleTextColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.heimdallNodeHoverModalTitleText, isDarkMode)
    : heimdallNodeHoverModalTextColor
  const heimdallNoteDialogBackgroundColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.heimdallNoteDialogBg, isDarkMode)
    : isDarkMode
      ? '#09090b'
      : '#fafafa'
  const heimdallNoteDialogBorderColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.heimdallNoteDialogBorder, isDarkMode)
    : isDarkMode
      ? '#404040'
      : '#e7e5e4'
  const heimdallNoteDialogTitleTextColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.heimdallNoteDialogTitleText, isDarkMode)
    : isDarkMode
      ? '#e7e5e4'
      : '#292524'
  const heimdallNoteDialogButtonBackgroundColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.heimdallNoteDialogButtonBg, isDarkMode)
    : 'transparent'
  const heimdallNoteDialogButtonBorderColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.heimdallNoteDialogButtonBorder, isDarkMode)
    : isDarkMode
      ? '#57534e'
      : '#d6d3d1'
  const heimdallNoteDialogButtonTextColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.heimdallNoteDialogButtonText, isDarkMode)
    : isDarkMode
      ? '#d6d3d1'
      : '#57534e'
  const heimdallNoteDialogCloseButtonTextColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.heimdallNoteDialogCloseButtonText, isDarkMode)
    : '#a8a29e'
  const heimdallGlassSurfaceBaseBackgroundColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.settingsCustomThemesCardBg, isDarkMode)
    : undefined
  const heimdallGlassSurfaceBorderColor = customThemeEnabled
    ? getTranslucentCssColor(getThemeModeColor(customTheme.colors.heimdallNoteDialogBorder, isDarkMode), isDarkMode ? 0.22 : 0.45)
    : undefined
  const heimdallContextMenuBaseBackgroundColor = heimdallGlassSurfaceBaseBackgroundColor
  const heimdallContextMenuBackgroundColor = heimdallContextMenuBaseBackgroundColor
    ? getTranslucentCssColor(heimdallContextMenuBaseBackgroundColor, 0.78)
    : undefined
  const heimdallContextMenuTextColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolJobsPrimaryText, isDarkMode)
    : undefined
  const heimdallContextMenuMutedTextColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolJobsMutedText, isDarkMode)
    : undefined
  const heimdallContextMenuBorderColor = heimdallGlassSurfaceBorderColor
  const heimdallContextMenuDividerColor = customThemeEnabled
    ? getTranslucentCssColor(getThemeModeColor(customTheme.colors.heimdallNoteDialogBorder, isDarkMode), 0.35)
    : undefined
  const heimdallContextMenuItemHoverColor = customThemeEnabled
    ? getTranslucentCssColor(getThemeModeColor(customTheme.colors.settingsCustomThemesInnerCardBg, isDarkMode), 0.72)
    : undefined
  const heimdallContextMenuDestructiveHoverColor = customThemeEnabled
    ? getTranslucentCssColor('#dc2626', isDarkMode ? 0.24 : 0.12)
    : undefined
  const heimdallContextMenuStyle: React.CSSProperties = {
    left: Math.max(8, Math.min(contextMenuPos?.x ?? 0, Math.max(0, dimensions.width - 260))),
    top: Math.max(8, Math.min(contextMenuPos?.y ?? 0, Math.max(0, dimensions.height - 270))),
    ...(customThemeEnabled
      ? {
          backgroundColor: heimdallContextMenuBackgroundColor,
          borderColor: heimdallContextMenuBorderColor,
          color: heimdallContextMenuTextColor,
        }
      : {}),
  }
  const heimdallContextMenuHeaderStyle: React.CSSProperties | undefined = customThemeEnabled
    ? { color: heimdallContextMenuMutedTextColor }
    : undefined
  const heimdallHoverPreviewStyle: React.CSSProperties | undefined = customThemeEnabled
    ? {
        backgroundColor: heimdallContextMenuBackgroundColor,
        borderColor: heimdallContextMenuBorderColor,
        color: heimdallContextMenuTextColor,
      }
    : undefined
  const heimdallContextMenuDividerStyle: React.CSSProperties | undefined = customThemeEnabled
    ? { backgroundColor: heimdallContextMenuDividerColor }
    : undefined
  const getHeimdallContextMenuItemStyle = useCallback(
    (destructive = false): React.CSSProperties | undefined =>
      customThemeEnabled
        ? ({
            '--heimdall-context-menu-item-hover-bg': destructive
              ? heimdallContextMenuDestructiveHoverColor
              : heimdallContextMenuItemHoverColor,
            '--heimdall-context-menu-item-hover-text': destructive ? '#ef4444' : heimdallContextMenuTextColor,
            color: heimdallContextMenuMutedTextColor,
          } as React.CSSProperties)
        : undefined,
    [
      customThemeEnabled,
      heimdallContextMenuDestructiveHoverColor,
      heimdallContextMenuItemHoverColor,
      heimdallContextMenuMutedTextColor,
      heimdallContextMenuTextColor,
    ]
  )

  const getNotePillColors = useCallback(
    (noteColor?: string | null) => {
      if (isValidHexColor(noteColor)) {
        return {
          fill: noteColor,
          stroke: 'rgba(0,0,0,0.28)',
          text: getReadableTextColor(noteColor),
        }
      }

      return {
        fill: heimdallNotePillBackgroundColor,
        stroke: heimdallNotePillBorderColor,
        text: heimdallNotePillTextColor,
      }
    },
    [heimdallNotePillBackgroundColor, heimdallNotePillBorderColor, heimdallNotePillTextColor]
  )

  const activeBranchIndicatorsByNodeId = useMemo(() => {
    const targetConversationId = conversationId ?? currentConversationId
    const targetConversationKey = targetConversationId != null ? String(targetConversationId) : null

    const parentToChildren = new Map<string, Message[]>()
    for (const message of messageById.values()) {
      const parentId = message.parent_id == null ? null : String(message.parent_id)
      if (parentId == null) continue
      const children = parentToChildren.get(parentId) || []
      children.push(message)
      parentToChildren.set(parentId, children)
    }

    parentToChildren.forEach(children => {
      children.sort((a, b) => {
        const aTime = new Date(a.created_at || 0).getTime()
        const bTime = new Date(b.created_at || 0).getTime()
        if (aTime !== bTime) return aTime - bTime
        return String(a.id).localeCompare(String(b.id))
      })
    })

    const buildPathToRoot = (messageId: MessageId | string | number | null | undefined): string[] => {
      if (messageId == null) return []

      const path: string[] = []
      const visited = new Set<string>()
      let cursorId: string | null = String(messageId)

      while (cursorId && !visited.has(cursorId)) {
        visited.add(cursorId)
        const message = messageById.get(cursorId)
        if (!message) break
        path.unshift(cursorId)
        cursorId = message.parent_id == null ? null : String(message.parent_id)
      }

      return path
    }

    const resolveDeepestVisiblePathNode = (path: string[]): string | null => {
      for (let index = path.length - 1; index >= 0; index -= 1) {
        const id = path[index]
        if (heimdallNodeIdSet.has(id)) return id
      }
      return null
    }

    const resolveVisibleAnchorNodeId = (messageId: MessageId | string | number | null | undefined): string | null => {
      return resolveDeepestVisiblePathNode(buildPathToRoot(messageId))
    }

    const resolveDeepestVisibleDescendant = (rootId: MessageId | string | number | null | undefined): string | null => {
      if (rootId == null) return null

      const rootKey = String(rootId)
      let best: { id: string; depth: number; createdAt: number } | null = null
      const visited = new Set<string>()
      const stack: Array<{ id: string; depth: number }> = [{ id: rootKey, depth: 0 }]

      while (stack.length > 0) {
        const item = stack.pop()!
        if (visited.has(item.id)) continue
        visited.add(item.id)

        const message = messageById.get(item.id)
        if (!message) continue

        if (heimdallNodeIdSet.has(item.id)) {
          const createdAt = new Date(message.created_at || 0).getTime()
          if (!best || item.depth > best.depth || (item.depth === best.depth && createdAt >= best.createdAt)) {
            best = { id: item.id, depth: item.depth, createdAt }
          }
        }

        const children = parentToChildren.get(item.id) || []
        for (let index = children.length - 1; index >= 0; index -= 1) {
          stack.push({ id: String(children[index].id), depth: item.depth + 1 })
        }
      }

      return best?.id ?? null
    }

    const resolveStreamBranchNodeId = (stream: (typeof streamingRoot.byId)[string]): string | null => {
      const branchIdentityId =
        stream.triggerUserMessageId ??
        stream.lineage.originMessageId ??
        stream.currentBranchAnchorMessageId ??
        stream.lineage.rootMessageId ??
        stream.messageId ??
        stream.streamingMessageId ??
        null
      const branchIdentityKey = branchIdentityId == null ? null : String(branchIdentityId)

      const currentAnchorCandidates = [
        stream.liveMessageId,
        stream.streamingMessageId,
        stream.currentBranchAnchorMessageId,
        stream.lastCompletedMessageId,
        stream.finalMessageId,
        stream.messageId,
        stream.branchAnchorMessageId,
        stream.lineage.originMessageId,
        stream.lineage.rootMessageId,
        stream.triggerUserMessageId,
      ]

      for (const candidate of currentAnchorCandidates) {
        const path = buildPathToRoot(candidate)
        if (path.length === 0) continue
        if (branchIdentityKey != null && !path.includes(branchIdentityKey)) continue

        const visibleNodeId = resolveDeepestVisiblePathNode(path)
        if (visibleNodeId) return visibleNodeId
      }

      if (branchIdentityId != null) {
        return resolveDeepestVisibleDescendant(branchIdentityId) ?? resolveVisibleAnchorNodeId(branchIdentityId)
      }

      return null
    }

    const latestByBranch = new Map<string, { streamId: string; createdAt: string; anchorNodeId: string }>()

    for (const streamId of streamingRoot.activeIds) {
      const stream = streamingRoot.byId[streamId]
      if (!stream?.active) continue

      if (targetConversationKey != null) {
        if (stream.conversationId == null || String(stream.conversationId) !== targetConversationKey) {
          continue
        }
      }

      const anchorNodeId = resolveStreamBranchNodeId(stream)
      if (!anchorNodeId) continue

      const branchKey = String(
        stream.triggerUserMessageId ??
          stream.lineage.originMessageId ??
          stream.currentBranchAnchorMessageId ??
          stream.lineage.rootMessageId ??
          stream.messageId ??
          stream.streamingMessageId ??
          streamId
      )
      const nextItem = {
        streamId,
        createdAt: stream.createdAt,
        anchorNodeId,
      }

      const existing = latestByBranch.get(branchKey)
      if (!existing || nextItem.createdAt > existing.createdAt) {
        latestByBranch.set(branchKey, nextItem)
      }
    }

    const byNodeId = new Map<string, Array<{ branchKey: string; streamId: string }>>()

    latestByBranch.forEach((item, branchKey) => {
      const existingForNode = byNodeId.get(item.anchorNodeId) || []
      existingForNode.push({ branchKey, streamId: item.streamId })
      byNodeId.set(item.anchorNodeId, existingForNode)
    })

    byNodeId.forEach(indicators => {
      indicators.sort((a, b) => a.streamId.localeCompare(b.streamId))
    })

    return byNodeId
  }, [conversationId, currentConversationId, heimdallNodeIdSet, messageById, streamingRoot.activeIds, streamingRoot.byId])

  const activeBranchIndicatorColors = useMemo(() => getNotePillColors(), [getNotePillColors])

  const renderNodes = (): JSX.Element[] => {
    return visiblePositionValues.map(({ x, y, node }) => {
      const isExpanded = !compactMode || node.id === focusedNodeId
      const nodeIdParsed = parseId(node.id)
      const isNodeSelected =
        ((typeof nodeIdParsed === 'number' && !isNaN(nodeIdParsed)) || typeof nodeIdParsed === 'string') &&
        selectedNodeSet.has(String(nodeIdParsed))
      // const isOnCurrentPath =
      //   ((typeof nodeIdParsed === 'number' && !isNaN(nodeIdParsed)) || typeof nodeIdParsed === 'string') &&
      //   currentPathSet.has(nodeIdParsed)
      const isVisible =
        ((typeof nodeIdParsed === 'number' && !isNaN(nodeIdParsed)) || typeof nodeIdParsed === 'string') &&
        visibleMessageId === nodeIdParsed
      const themedNodeColors = getNodeThemeColors(node.sender, isVisible)
      const heatmapNodeColors = getHeatmapNodeColors(String(node.id), isVisible)
      const effectiveNodeColors = heatmapNodeColors ?? themedNodeColors
      const subagentNodes = subagentMapByParent[String(node.id)] || []
      const subagentCount = subagentNodes.length
      const showSubagentBadge = subagentCount > 0 && node.sender === 'user'
      const activeBranchIndicators = activeBranchIndicatorsByNodeId.get(String(node.id)) || []
      const hasActiveBranchIndicator = activeBranchIndicators.length > 0
      const nodeOutlineStroke = effectiveNodeColors?.stroke

      if (isExpanded) {
        // Render full node
        return (
          <g key={node.id} transform={`translate(${x - nodeWidth / 2}, ${y})`}>
            {/* Current path highlight (rendered first so selection can appear above) */}
            {/* {isOnCurrentPath && (
             
              <line
                x1='72'
                y1={nodeHeight + 14}
                x2={nodeWidth - 72}
                y2={nodeHeight + 14}
                strokeWidth='5'
                className={`animate-pulse-slow transition-colors duration-200 ${
                  isVisible ? 'stroke-emerald-400 dark:stroke-orange-500' : 'stroke-indigo-200 dark:stroke-yPurple-50'
                }`}
              />
            )} */}
            {/* Selected/current highlight: the only visible node outline in the minimal style. */}
            {(isNodeSelected || isVisible) && (
              <rect
                width={nodeWidth + 12}
                height={nodeHeight + 12}
                x={-6}
                y={-6}
                rx={HEIMDALL_NODE_RADIUS + 6}
                fill='none'
                stroke={nodeOutlineStroke || 'currentColor'}
                strokeWidth={isNodeSelected ? HEIMDALL_NODE_SELECTED_STROKE_WIDTH : HEIMDALL_NODE_VISIBLE_STROKE_WIDTH}
                className={`transition-colors duration-200 ${
                  nodeOutlineStroke
                    ? ''
                    : isNodeSelected
                      ? 'stroke-blue-500 dark:stroke-orange-300'
                      : 'stroke-blue-300/80 dark:stroke-orange-400/70'
                }`}
              />
            )}
            <rect
              data-node-id={node.id}
              width={nodeWidth}
              height={nodeHeight}
              rx={HEIMDALL_NODE_RADIUS}
              strokeWidth='0'
              className={`cursor-pointer transition-[background-color,color,opacity,transform] duration-150 hover:opacity-95 ${
                effectiveNodeColors ? '' : getHeimdallNodeFallbackFillClass(node.sender, isVisible, isDarkMode)
              }`}
              style={{
                stroke: 'transparent',
                ...(effectiveNodeColors
                  ? {
                      fill: effectiveNodeColors.fill,
                    }
                  : {}),
              }}
              onMouseEnter={handleNodeMouseEnter}
              onMouseLeave={handleNodeMouseLeave}
            />
            {showSubagentBadge &&
              (() => {
                const badge = getSubagentBadgeMetrics(subagentCount)
                const badgeX = nodeWidth - badge.width - 8
                const badgeY = -12
                return (
                  <g
                    transform={`translate(${badgeX}, ${badgeY})`}
                    className='cursor-pointer'
                    onPointerDown={e => e.stopPropagation()}
                    onClick={e => handleSubagentBadgeClick(e, String(node.id))}
                  >
                    <rect
                      width={badge.width}
                      height={badge.height}
                      rx='9'
                      className='fill-blue-500 dark:fill-orange-600'
                      stroke='rgba(0,0,0,0.15)'
                      strokeWidth='1'
                    />
                    <text
                      x={badge.width / 2}
                      y={badge.height / 2 + 4}
                      textAnchor='middle'
                      className='fill-white text-[10px] font-semibold tracking-wide'
                    >
                      {badge.label}
                    </text>
                  </g>
                )
              })()}
            {/* Bottom border line */}
            {/* <line
              x1='0'
              y1={nodeHeight}
              x2={nodeWidth}
              y2={nodeHeight}
              strokeWidth='2'
              className={`${node.sender === 'user' ? 'stroke-neutral-200 dark:stroke-yPurple-400' : 'stroke-neutral-200 dark:stroke-yBrown-400'}`}
            /> */}
            <foreignObject width={nodeWidth} height={nodeHeight} style={{ pointerEvents: 'none', userSelect: 'none' }}>
              <div
                className={`relative h-full flex items-center px-4 py-3 text-sm leading-5 ${getHeimdallNodeTextClass(node.sender, isVisible)}`}
                style={heatmapNodeColors ? { color: heatmapNodeColors.text } : undefined}
              >
                {(() => {
                  const nodeIdParsed = parseId(node.id)
                  if (typeof nodeIdParsed === 'number' && isNaN(nodeIdParsed)) {
                    return <p className='line-clamp-3'>...</p>
                  }
                  const msg = getCurrentMessage(nodeIdParsed)

                  // Check for image blocks in content_blocks
                  if (msg?.content_blocks && Array.isArray(msg.content_blocks)) {
                    const imageBlocks = msg.content_blocks.filter(
                      block => block.type === 'image' && 'url' in block && !!block.url
                    ) as Array<{ type: 'image'; url: string }>
                    if (imageBlocks.length > 0) {
                      // Display the first image as a thumbnail
                      const firstImage = imageBlocks[0]
                      return (
                        <div className='w-full h-full flex items-center justify-center overflow-hidden'>
                          <img
                            src={firstImage.url}
                            alt='Generated image'
                            className='max-w-full max-h-full object-contain rounded'
                            style={{ maxHeight: nodeHeight - 24 }}
                          />
                          {imageBlocks.length > 1 && (
                            <span className='absolute bottom-1 right-1 bg-black/50 text-white text-xs px-1.5 py-0.5 rounded'>
                              +{imageBlocks.length - 1}
                            </span>
                          )}
                        </div>
                      )
                    }
                  }

                  // Show text content if available
                  if (node.message && node.message.trim().length > 0) {
                    return <p className='line-clamp-3'>{node.message}</p>
                  }

                  // Check for tool calls
                  if (msg?.tool_calls && msg.tool_calls.length > 0) {
                    const toolNames = msg.tool_calls.map((tc: any) => tc.name).join(', ')
                    return <p className='line-clamp-3'>{toolNames || 'Tool Call'}</p>
                  }

                  // Check content_blocks for tool_use
                  if (msg?.content_blocks && Array.isArray(msg.content_blocks)) {
                    const toolUses = msg.content_blocks.filter((block: any) => block.type === 'tool_use')
                    if (toolUses.length > 0) {
                      const toolNames = toolUses.map((tc: any) => tc.name).join(', ')
                      return <p className='line-clamp-3'>{toolNames || 'Tool Call'}</p>
                    }
                  }

                  return <p className='line-clamp-3'>...</p>
                })()}
              </div>
            </foreignObject>
            {/* Note indicator for expanded view */}
            {(() => {
              const nodeIdParsed = parseId(node.id)
              if (typeof nodeIdParsed === 'number' && isNaN(nodeIdParsed)) return null
              const message = getCurrentMessage(nodeIdParsed)
              const hasNote = message?.note && message.note.trim().length > 0
              if (!hasNote) return null

              const badge = getNoteBadgeMetrics(message?.note)
              const pillColors = getNotePillColors(message?.note_color)
              const badgeX = nodeWidth - badge.width - 8
              const badgeY = nodeHeight - badge.height + 10
              return (
                <g
                  transform={`translate(${badgeX}, ${badgeY})`}
                  className='cursor-pointer'
                  onPointerDown={e => e.stopPropagation()}
                  onMouseEnter={e => handleNoteBadgeHover(e, node, message.note || '')}
                  onMouseMove={e => handleNoteBadgeHover(e, node, message.note || '')}
                  onMouseLeave={handleNoteBadgeLeave}
                  onClick={e => handleNoteBadgeClick(e, String(node.id))}
                >
                  <rect
                    width={badge.width}
                    height={badge.height}
                    rx={HEIMDALL_NOTE_PILL_RADIUS}
                    style={{ fill: pillColors.fill }}
                    stroke={pillColors.stroke}
                    strokeWidth='1'
                  />
                  <text
                    x={8}
                    y={(badge.height - (badge.lines.length - 1) * 11) / 2 + 5}
                    textAnchor='start'
                    className={`text-[10px] ${badge.isHeadingTitle ? 'font-bold' : 'font-semibold'}`}
                    style={{ fill: pillColors.text }}
                  >
                    {badge.lines.map((line, index) => (
                      <tspan key={`${line}-${index}`} x={8} dy={index === 0 ? 0 : 11}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                </g>
              )
            })()}
            {hasActiveBranchIndicator && (
              <g style={{ pointerEvents: 'none', userSelect: 'none' }}>
                {activeBranchIndicators.map((indicator, index) => {
                  const indicatorRadius = 8
                  const gap = 4
                  const totalWidth =
                    activeBranchIndicators.length * indicatorRadius * 2 + (activeBranchIndicators.length - 1) * gap
                  const rightPadding = 10
                  const startX = nodeWidth - rightPadding - totalWidth
                  const cx = startX + indicatorRadius + index * (indicatorRadius * 2 + gap)
                  const cy = nodeHeight + 8

                  return (
                    <g key={indicator.branchKey}>
                      <circle
                        cx={cx}
                        cy={cy}
                        r={indicatorRadius + 1.5}
                        fill='none'
                        stroke={activeBranchIndicatorColors.stroke}
                        strokeWidth='1'
                        className='animate-pulse opacity-60'
                      />
                      <circle
                        cx={cx}
                        cy={cy}
                        r={indicatorRadius}
                        style={{ fill: activeBranchIndicatorColors.fill }}
                        stroke={activeBranchIndicatorColors.stroke}
                        strokeWidth='1'
                        className='animate-pulse-slow'
                      />
                    </g>
                  )
                })}
              </g>
            )}
          </g>
        )
      } else {
        // Render compact circle
        return (
          <g key={node.id}>
            {/* Current path highlight for compact mode */}
            {/* {isOnCurrentPath && (
              <circle
                cx={x}
                cy={y + circleRadius}
                r={circleRadius + 8}
                fill='none'
                // stroke='rgba(16, 185, 129, 0.9)'
                strokeWidth='3'
                className={`animate-pulse-slow transition-colors duration-200 ${
                  isVisible ? 'stroke-rose-300' : 'stroke-indigo-200 dark:stroke-yPurple-50'
                }`}
              />
            )} */}
            {/* Visible message highlight for compact mode */}
            {/* {isVisible && (
              <circle
                cx={x}
                cy={y + circleRadius}
                r={circleRadius + 6}
                fill='none'
                stroke='currentColor'
                strokeWidth='2'
                className='stroke-cyan-400 dark:stroke-amber-300'
              />
            )} */}
            {/* Selected/current highlight: the only visible node outline in compact mode. */}
            {(isNodeSelected || isVisible) && (
              <circle
                cx={x}
                cy={y + circleRadius}
                r={circleRadius + 7}
                fill='none'
                stroke={nodeOutlineStroke || 'currentColor'}
                strokeWidth={isNodeSelected ? HEIMDALL_NODE_SELECTED_STROKE_WIDTH : HEIMDALL_NODE_VISIBLE_STROKE_WIDTH}
                className={`transition-colors duration-200 ${
                  nodeOutlineStroke
                    ? ''
                    : isNodeSelected
                      ? 'stroke-blue-500 dark:stroke-orange-300'
                      : 'stroke-blue-300/80 dark:stroke-orange-400/70'
                }`}
              />
            )}
            <circle
              data-node-id={node.id}
              cx={x}
              cy={y + circleRadius}
              r={circleRadius}
              strokeWidth='0'
              className={`cursor-pointer transition-[fill,stroke,opacity,transform] duration-150 ${
                effectiveNodeColors ? '' : getHeimdallNodeFallbackFillClass(node.sender, isVisible, isDarkMode)
              }`}
              style={{
                transform:
                  selectedNode?.id === node.id ? `scale(${HEIMDALL_COMPACT_NODE_HOVER_SCALE})` : 'scale(1)',
                transformOrigin: `${x}px ${y + circleRadius}px`,
                stroke: 'transparent',
                ...(effectiveNodeColors
                  ? {
                      fill: effectiveNodeColors.fill,
                    }
                  : {}),
              }}
              onMouseEnter={handleNodeMouseEnter}
              onMouseLeave={handleNodeMouseLeave}
            />
            {showSubagentBadge &&
              (() => {
                const badge = getSubagentBadgeMetrics(subagentCount)
                const badgeX = x + circleRadius + 6
                const badgeY = y - 12
                return (
                  <g
                    transform={`translate(${badgeX}, ${badgeY})`}
                    className='cursor-pointer'
                    onPointerDown={e => e.stopPropagation()}
                    onClick={e => handleSubagentBadgeClick(e, String(node.id))}
                  >
                    <rect
                      width={badge.width}
                      height={badge.height}
                      rx='9'
                      className='fill-orange-500 dark:fill-orange-600'
                      stroke='rgba(0,0,0,0.15)'
                      strokeWidth='1'
                    />
                    <text
                      x={badge.width / 2}
                      y={badge.height / 2 + 4}
                      textAnchor='middle'
                      className='fill-white text-[10px] font-semibold tracking-wide'
                    >
                      {badge.label}
                    </text>
                  </g>
                )
              })()}
            {/* Note indicator for compact view */}
            {(() => {
              const nodeIdParsed = parseId(node.id)
              if (typeof nodeIdParsed === 'number' && isNaN(nodeIdParsed)) return null
              const message = getCurrentMessage(nodeIdParsed)
              const hasNote = message?.note && message.note.trim().length > 0
              if (!hasNote) return null

              const badge = getNoteBadgeMetrics(message?.note)
              const pillColors = getNotePillColors(message?.note_color)
              const badgeX = x + circleRadius + 6
              const badgeY = y + circleRadius + 8
              return (
                <g
                  transform={`translate(${badgeX}, ${badgeY})`}
                  className='cursor-pointer'
                  onPointerDown={e => e.stopPropagation()}
                  onMouseEnter={e => handleNoteBadgeHover(e, node, message.note || '')}
                  onMouseMove={e => handleNoteBadgeHover(e, node, message.note || '')}
                  onMouseLeave={handleNoteBadgeLeave}
                  onClick={e => handleNoteBadgeClick(e, String(node.id))}
                >
                  <rect
                    width={badge.width}
                    height={badge.height}
                    rx={HEIMDALL_NOTE_PILL_RADIUS}
                    style={{ fill: pillColors.fill }}
                    stroke={pillColors.stroke}
                    strokeWidth='1'
                  />
                  <text
                    x={8}
                    y={(badge.height - (badge.lines.length - 1) * 11) / 2 + 5}
                    textAnchor='start'
                    className={`text-[10px] ${badge.isHeadingTitle ? 'font-bold' : 'font-semibold'}`}
                    style={{ fill: pillColors.text }}
                  >
                    {badge.lines.map((line, index) => (
                      <tspan key={`${line}-${index}`} x={8} dy={index === 0 ? 0 : 11}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                </g>
              )
            })()}
            {hasActiveBranchIndicator && (
              <g style={{ pointerEvents: 'none', userSelect: 'none' }}>
                {activeBranchIndicators.map((indicator, index) => {
                  const indicatorRadius = 3.5
                  const gap = 3
                  const totalWidth =
                    activeBranchIndicators.length * indicatorRadius * 2 + (activeBranchIndicators.length - 1) * gap
                  const startX = x - totalWidth / 2
                  const cx = startX + indicatorRadius + index * (indicatorRadius * 2 + gap)
                  const cy = y + circleRadius * 2 + 9

                  return (
                    <g key={indicator.branchKey}>
                      <circle
                        cx={cx}
                        cy={cy}
                        r={indicatorRadius + 1.5}
                        fill='none'
                        stroke={activeBranchIndicatorColors.stroke}
                        strokeWidth='1'
                        className='animate-pulse opacity-60'
                      />
                      <circle
                        cx={cx}
                        cy={cy}
                        r={indicatorRadius}
                        style={{ fill: activeBranchIndicatorColors.fill }}
                        stroke={activeBranchIndicatorColors.stroke}
                        strokeWidth='1'
                        className='animate-pulse-slow'
                      />
                    </g>
                  )
                })}
              </g>
            )}
            {/* Add a small indicator for branch nodes */}
            {/* {node.children && node.children.length > 1 && (
              <circle
                cx={x}
                cy={y + circleRadius}
                r='6'
                fill='white'
                opacity='0.4'
                className='animate-pulse'
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              />
            )} */}
          </g>
        )
      }
    })
  }

  const connectionElements = useMemo(
    () => renderConnections(),
    [
      visiblePositionValues,
      positions,
      parentByChildId,
      visiblePositionIdSet,
      compactMode,
      focusedNodeId,
      currentPathSet,
      cullingPan.x,
      cullingPan.y,
      cullingZoom,
      dimensions.width,
      viewportBounds,
      offsetX,
      offsetY,
      verticalSpacing,
    ]
  )

  const nodeElements = useMemo(
    () => renderNodes(),
    [
      visiblePositionValues,
      compactMode,
      focusedNodeId,
      selectedNodeSet,
      visibleMessageId,
      subagentMapByParent,
      selectedNode?.id,
      isDarkMode,
      customThemeEnabled,
      getNodeThemeColors,
      getHeatmapNodeColors,
      handleNodeMouseEnter,
      handleNodeMouseLeave,
      handleSubagentBadgeClick,
      handleNoteBadgeHover,
      handleNoteBadgeLeave,
      handleNoteBadgeClick,
      getCurrentMessage,
    ]
  )

  // Note: loading overlay is handled within main render to avoid unmounting the tree

  // Note: error overlay is handled within main render to avoid unmounting the tree

  // Note: empty-state overlay is handled within main render to avoid unmounting the tree

  const heimdallControlButtonClass =
    'group/control relative flex h-11 w-11 items-center justify-center rounded-full border border-stone-200/80 bg-white/85 text-stone-700 shadow-[0_18px_42px_-24px_rgba(15,23,42,0.65),0_4px_14px_-10px_rgba(15,23,42,0.45)] backdrop-blur-xl transition-all duration-200 hover:-translate-y-0.5 hover:scale-105 hover:border-stone-300 hover:bg-white hover:text-stone-950 hover:shadow-[0_22px_46px_-22px_rgba(15,23,42,0.7)] active:translate-y-0 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-50 dark:border-white/10 dark:bg-yBlack-900/85 dark:text-stone-200 dark:shadow-[0_20px_52px_-24px_rgba(0,0,0,0.9)] dark:hover:border-white/20 dark:hover:bg-neutral-900 dark:hover:text-white dark:focus-visible:ring-orange-400/70 dark:focus-visible:ring-offset-yBlack-900'
  const heimdallControlButtonActiveClass =
    'border-blue-300 bg-blue-50 text-blue-700 shadow-[0_18px_42px_-22px_rgba(37,99,235,0.55)] hover:border-blue-300 hover:bg-blue-100 hover:text-blue-800 dark:border-orange-400/40 dark:bg-orange-500/15 dark:text-orange-100 dark:shadow-[0_20px_52px_-24px_rgba(249,115,22,0.65)] dark:hover:border-orange-300/60 dark:hover:bg-orange-500/25 dark:hover:text-orange-50'
  const heimdallControlPanelBackgroundColor = heimdallGlassSurfaceBaseBackgroundColor
    ? getTranslucentCssColor(heimdallGlassSurfaceBaseBackgroundColor, 0.6)
    : undefined
  const heimdallControlPanelStyle: React.CSSProperties | undefined = customThemeEnabled
    ? {
        backgroundColor: heimdallControlPanelBackgroundColor,
        borderColor: heimdallGlassSurfaceBorderColor,
      }
    : undefined
  const heimdallControlButtonStyle: React.CSSProperties | undefined = customThemeEnabled
    ? {
        backgroundColor: getTranslucentCssColor(
          getThemeModeColor(customTheme.colors.settingsCustomThemesButtonBg, isDarkMode),
          0.82
        ),
        borderColor: getTranslucentCssColor(getThemeModeColor(customTheme.colors.settingsCustomThemesButtonBorder, isDarkMode), 0.5),
        color: getThemeModeColor(customTheme.colors.settingsCustomThemesButtonText, isDarkMode),
      }
    : undefined
  const getHeimdallControlButtonStyle = useCallback(
    (active = false): React.CSSProperties | undefined =>
      customThemeEnabled
        ? active
          ? {
              backgroundColor: getTranslucentCssColor(
                getThemeModeColor(customTheme.colors.composerToggleActiveBg, isDarkMode),
                0.84
              ),
              borderColor: getTranslucentCssColor(
                getThemeModeColor(customTheme.colors.composerToggleActiveBorder, isDarkMode),
                0.65
              ),
              color: getThemeModeColor(customTheme.colors.composerToggleActiveText, isDarkMode),
            }
          : heimdallControlButtonStyle
        : undefined,
    [customTheme, customThemeEnabled, heimdallControlButtonStyle, isDarkMode]
  )
  const heimdallContextMenuItemClass = `w-full flex items-center gap-3 px-3 py-2.5 rounded-[14px] text-sm font-medium cursor-pointer transition-[background-color,color,opacity,transform] duration-150 hover:pl-4 group ${
    customThemeEnabled
      ? 'text-stone-500 hover:bg-[var(--heimdall-context-menu-item-hover-bg)] hover:text-[var(--heimdall-context-menu-item-hover-text)] dark:text-neutral-400 dark:hover:bg-[var(--heimdall-context-menu-item-hover-bg)] dark:hover:text-[var(--heimdall-context-menu-item-hover-text)]'
      : 'text-stone-500 hover:bg-stone-100 hover:text-stone-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white'
  }`
  const heimdallContextMenuDestructiveItemClass = `w-full flex items-center gap-3 px-3 py-2.5 rounded-[14px] text-sm font-medium cursor-pointer transition-[background-color,color,opacity,transform] duration-150 hover:pl-4 group ${
    customThemeEnabled
      ? 'text-stone-500 hover:bg-[var(--heimdall-context-menu-item-hover-bg)] hover:text-[var(--heimdall-context-menu-item-hover-text)] dark:text-neutral-400 dark:hover:bg-[var(--heimdall-context-menu-item-hover-bg)] dark:hover:text-[var(--heimdall-context-menu-item-hover-text)]'
      : 'text-stone-500 hover:bg-red-50 hover:text-red-600 dark:text-neutral-400 dark:hover:bg-red-950 dark:hover:text-red-400'
  }`

  return (
    <div
      ref={containerRef}
      className='group w-full h-full rounded-xl dark:border-neutral-800 border-neutral-200 bg-neutral-50 relative overflow-hidden dark:bg-yBlack-900'
      onContextMenu={e => {
        if (isContextMenuExemptTarget(e.target)) {
          return
        }
        e.preventDefault()
      }}
      style={{
        filter: isTransitioning ? 'none' : 'none',
        transition: 'filter 100ms ease-in-out',
        backgroundColor: heimdallPanelBackgroundColor,
      }}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      {/* Overlays: loading, error, empty-state (non-destructive, do not unmount SVG) */}
      {error && (
        <div className='absolute inset-0 z-20 flex items-center justify-center bg-slate-50 text-stone-800 dark:text-stone-200'>
          <div className='text-white text-center max-w-md'>
            <div className='text-red-400 text-6xl mb-4'>⚠️</div>
            <p className='text-lg mb-2'>Failed to load conversation</p>
            <p className='text-sm text-gray-400'>{error}</p>
          </div>
        </div>
      )}
      {!error && !loading && !lastDataRef.current && (
        <div className='absolute inset-0 z-10 flex items-center justify-center bg-slate-50 text-stone-800 dark:bg-neutral-900 dark:text-stone-200'>
          <div className='mx-auto flex max-w-sm flex-col items-center px-6 text-center'>
            <div className='mb-5 rounded-[28px] border border-stone-200/80 bg-white/75 p-5 shadow-[0_16px_40px_-24px_rgba(0,0,0,0.35)] backdrop-blur-xl dark:border-white/10 dark:bg-neutral-900/70'>
              <svg
                aria-hidden='true'
                viewBox='0 0 180 128'
                className='h-28 w-40 text-stone-700 dark:text-stone-200'
                fill='none'
                xmlns='http://www.w3.org/2000/svg'
              >
                <circle cx='40' cy='28' r='11' fill='currentColor' opacity='0.08' />
                <circle cx='146' cy='96' r='13' fill='currentColor' opacity='0.08' />
                <path
                  d='M90 28V44M90 44C90 44 69 44 60 53C51 62 51 75 51 75M90 44C90 44 111 44 120 53C129 62 129 75 129 75M51 75C51 75 51 86 43 93C35 100 24 100 24 100M51 75C51 75 51 86 59 93C67 100 78 100 78 100M129 75C129 75 129 86 121 93C113 100 102 100 102 100M129 75C129 75 129 86 137 93C145 100 156 100 156 100'
                  stroke='currentColor'
                  strokeWidth='4'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  opacity='0.18'
                />
                <circle cx='90' cy='24' r='16' fill='currentColor' opacity='0.12' />
                <path d='M82 24H98' stroke='currentColor' strokeWidth='5' strokeLinecap='round' opacity='0.6' />
                <circle cx='51' cy='75' r='13' fill='currentColor' opacity='0.12' />
                <path d='M45 75H57' stroke='currentColor' strokeWidth='4.5' strokeLinecap='round' opacity='0.55' />
                <circle cx='129' cy='75' r='13' fill='currentColor' opacity='0.12' />
                <path d='M123 75H135' stroke='currentColor' strokeWidth='4.5' strokeLinecap='round' opacity='0.55' />
                <circle cx='24' cy='100' r='10' fill='currentColor' opacity='0.16' />
                <circle cx='78' cy='100' r='10' fill='currentColor' opacity='0.16' />
                <circle cx='102' cy='100' r='10' fill='currentColor' opacity='0.16' />
                <circle cx='156' cy='100' r='10' fill='currentColor' opacity='0.16' />
                <path
                  d='M141 27L145 35L153 39L145 43L141 51L137 43L129 39L137 35L141 27Z'
                  fill='currentColor'
                  opacity='0.24'
                />
              </svg>
            </div>
            <p className='mb-2 text-lg font-medium text-stone-900 dark:text-stone-100'>
              Conversation tree will appear here
            </p>
            <p className='text-sm leading-6 text-stone-600 dark:text-stone-400'>
              Start chatting with the agent and Heimdall will build a visual overview of the conversation as your
              messages and branches grow.
            </p>
          </div>
        </div>
      )}
      <div
        className={`absolute bottom-12 left-4 z-10 flex items-center gap-2 rounded-full border border-stone-200/55 bg-white/30 p-1.5 shadow-[0_24px_56px_-30px_rgba(15,23,42,0.65)] backdrop-blur-2xl transition-all duration-200 dark:border-white/[0.04] dark:bg-black/20 ${isHovering ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'}`}
        style={heimdallControlPanelStyle}
      >
        <button
          type='button'
          onClick={zoomIn}
          className={heimdallControlButtonClass}
          style={getHeimdallControlButtonStyle()}
          title='Zoom In'
          aria-label='Zoom in'
        >
          <ZoomIn size={18} strokeWidth={2.25} />
        </button>
        <button
          type='button'
          onClick={zoomOut}
          className={heimdallControlButtonClass}
          style={getHeimdallControlButtonStyle()}
          title='Zoom Out'
          aria-label='Zoom out'
        >
          <ZoomOut size={18} strokeWidth={2.25} />
        </button>
        <button
          type='button'
          onClick={resetView}
          className={heimdallControlButtonClass}
          style={getHeimdallControlButtonStyle()}
          title='Reset View'
          aria-label='Reset view'
        >
          <RotateCcw size={18} strokeWidth={2.25} />
        </button>
        <button
          type='button'
          onClick={toggleFilterEmptyMessages}
          className={`${heimdallControlButtonClass} ${filterEmptyMessages ? heimdallControlButtonActiveClass : ''}`}
          style={getHeimdallControlButtonStyle(filterEmptyMessages)}
          title={filterEmptyMessages ? 'Show Empty Messages' : 'Hide Empty Messages'}
          aria-label={filterEmptyMessages ? 'Show empty messages' : 'Hide empty messages'}
          aria-pressed={filterEmptyMessages}
        >
          <ListFilter size={18} strokeWidth={2.25} />
        </button>
        <button
          type='button'
          onClick={toggleHeatmapMode}
          className={`${heimdallControlButtonClass} ${
            heatmapMode
              ? 'border-transparent bg-gradient-to-br from-sky-500 via-emerald-500 to-orange-500 text-white shadow-[0_18px_44px_-20px_rgba(249,115,22,0.75)] hover:border-transparent hover:text-white dark:border-transparent dark:bg-gradient-to-br dark:from-sky-500 dark:via-emerald-500 dark:to-orange-500 dark:text-white'
              : ''
          }`}
          style={getHeimdallControlButtonStyle(heatmapMode)}
          title={heatmapMode ? 'Disable Heatmap Mode' : 'Enable Heatmap Mode'}
          aria-label={heatmapMode ? 'Disable heatmap mode' : 'Enable heatmap mode'}
          aria-pressed={heatmapMode}
        >
          <Flame size={18} strokeWidth={2.25} fill={heatmapMode ? 'currentColor' : 'none'} />
        </button>
        <button
          type='button'
          onClick={() => {
            dispatch(chatSliceActions.heimdallCompactModeToggled())
          }}
          className={heimdallControlButtonClass}
          style={getHeimdallControlButtonStyle()}
          title={compactMode ? 'Switch to Full Mode' : 'Switch to Compact Mode'}
          aria-label={compactMode ? 'Switch to full mode' : 'Switch to compact mode'}
        >
          {compactMode ? <Maximize2 size={18} strokeWidth={2.25} /> : <Minimize2 size={18} strokeWidth={2.25} />}
        </button>
      </div>
      <div className='absolute top-4 right-8 ml-100 z-10 flex flex-col gap-2 items-end'>
        <button
          type='button'
          onClick={() => setSearchOpen(true)}
          className='flex items-center gap-2 px-3 py-2 rounded-xl text-stone-800 dark:text-stone-200 shadow-[0_0px_8px_-4px_rgba(0,0,0,0.2)] dark:shadow-[0_-12px_28px_-6px_rgba(0,0,0,0.65)] hover:bg-neutral-100 dark:hover:bg-neutral-800 active:scale-95 transition'
        >
          <i className='bx bx-search text-lg' />
          <span className='text-sm font-medium'>Search Messages</span>
        </button>
        {/* <div className='bg-neutral-100 text-stone-800 dark:text-stone-200 px-3 py-1 rounded-lg text-sm border-2 border-stone-300 dark:border-stone-700 drop-shadow-xl shadow-[0_0px_6px_-12px_rgba(0,0,0,0.05)] dark:shadow-[0_-12px_28px_-6px_rgba(0,0,0,0.65)] dark:bg-yBlack-900'>
          Zoom: {Math.round(zoom * 100)}%
        </div> */}

        {/* <div className='bg-neutral-50 text-stone-800 dark:text-stone-200 px-3 py-1 rounded-lg text-sm border-2 border-stone-300 dark:border-stone-700 shadow-[0_0px_8px_-4px_rgba(0,0,0,0.1)] dark:shadow-[0_-12px_28px_-6px_rgba(0,0,0,0.65)]  dark:bg-yBlack-900 opacity-0 group-hover:opacity-100 transition-opacity duration-200'>
          <div className='flex items-center gap-2'>
            <div className='w-3 h-3 bg-neutral-50 border-2 dark:border-yPurple-400 rounded dark:bg-neutral-900 border-stone-400'></div>
            <span>User messages</span>
          </div>
          <div className='flex items-center gap-2'>
            <div className='w-3 h-3 bg-slate-50 dark:bg-yBlack-900 dark:border-yBrown-500 rounded border-2 border-slate-400'></div>
            <span>Assistant messages</span>
          </div>
          <div className='flex items-center gap-2'>
            <div className='w-3 h-3 bg-slate-50 dark:bg-yBlack-900 dark:border-orange-600 rounded border-2 border-orange-300'></div>
            <span>Ex-agent messages</span>
          </div>
        </div> */}
      </div>
      <svg
        ref={svgRef}
        className='w-full h-full cursor-move'
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onContextMenu={handleSvgContextMenu}
        onClick={handleSvgClick}
        style={{ cursor: isDragging ? 'grabbing' : isSelecting ? 'crosshair' : 'grab', touchAction: 'none' }}
      >
        <g ref={graphTransformRef} transform={`translate(${pan.x + dimensions.width / 2}, ${pan.y + 100}) scale(${zoom})`}>
          <g transform={`translate(${offsetX}, ${offsetY})`}>
            <HeimdallGraphLayers connections={connectionElements} nodes={nodeElements} />
          </g>
        </g>
        {/* Viewport bounds debug overlay - uncomment to visualize culling area */}
        {/* {viewportBounds && (
          <rect
            x={viewportBounds.minX}
            y={viewportBounds.minY}
            width={viewportBounds.maxX - viewportBounds.minX}
            height={viewportBounds.maxY - viewportBounds.minY}
            fill='rgba(255, 0, 0, 0.1)'
            stroke='rgba(255, 0, 0, 0.5)'
            strokeWidth='3'
            strokeDasharray='10,5'
            style={{ pointerEvents: 'none' }}
          />
        )} */}
        {/* Selection rectangle */}
        {isSelecting && (
          <rect
            x={Math.min(selectionStart.x, selectionEnd.x)}
            y={Math.min(selectionStart.y, selectionEnd.y)}
            width={Math.abs(selectionEnd.x - selectionStart.x)}
            height={Math.abs(selectionEnd.y - selectionStart.y)}
            fill='rgba(59, 130, 246, 0.2)'
            stroke='rgba(59, 130, 246, 0.8)'
            strokeWidth='2'
            strokeDasharray='5,5'
            style={{ pointerEvents: 'none' }}
          />
        )}
      </svg>
      {searchOpen && (
        <div
          className='absolute inset-0 z-30 flex items-center justify-center  bg-black/20 backdrop-blur-[2px] '
          onClick={handleSearchClose}
        >
          <div
            className='bg-white/65 dark:bg-neutral-950/65 backdrop-blur-3xl rounded-2xl shadow-xl flex flex-col max-h-[85vh] w-[95%] sm:w-[90%] max-w-6xl'
            onClick={e => e.stopPropagation()}
            data-heimdall-wheel-exempt='true'
          >
            <div className='flex items-center justify-between px-5 py-4 shrink-0'>
              <div>
                <h3 className='text-base font-semibold text-stone-800 dark:text-stone-100'>Search Messages</h3>
                <p className='text-xs text-stone-500 dark:text-stone-400'>Search across this conversation.</p>
              </div>
              <button
                onClick={handleSearchClose}
                className='p-1.5 hover:bg-black/5 dark:hover:bg-white/10 rounded-full transition-colors'
                aria-label='Close search'
              >
                <svg className='w-5 h-5 text-stone-500' fill='none' viewBox='0 0 24 24' stroke='currentColor'>
                  <path strokeLinecap='round' strokeLinejoin='round' strokeWidth={2} d='M6 18L18 6M6 6l12 12' />
                </svg>
              </button>
            </div>
            <div className='px-5 pb-4'>
              <TextField
                placeholder='Search for words or phrases'
                value={searchQuery}
                onChange={val => {
                  setSearchQuery(val)
                  setSearchHoverIndex(-1)
                }}
                onKeyDown={e => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setSearchHoverIndex(prev => Math.min(prev + 1, Math.max(0, filteredResults.length - 1)))
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setSearchHoverIndex(prev => Math.max(-1, prev - 1))
                  } else if (e.key === 'Enter') {
                    const item = filteredResults[searchHoverIndex >= 0 ? searchHoverIndex : 0]
                    if (item) {
                      handleSelectSearchResult(item)
                    }
                  } else if (e.key === 'Escape') {
                    handleSearchClose()
                  }
                }}
                size='small'
                autoFocus
                className='bg-white/55 dark:bg-white/10'
              />
              <div className='mt-2 text-xs text-stone-500 dark:text-stone-400'>
                {searchQuery.trim()
                  ? `${filteredResults.length} result${filteredResults.length === 1 ? '' : 's'}`
                  : 'Start typing to see matching messages.'}
              </div>
            </div>
            <div className='overflow-y-auto flex-1 thin-scrollbar px-5 py-4' data-heimdall-wheel-exempt='true'>
              {!searchQuery.trim() && (
                <div className='text-sm text-stone-500 dark:text-stone-400'>Enter a search term to begin.</div>
              )}
              {searchQuery.trim() && filteredResults.length === 0 && (
                <div className='text-sm text-stone-500 dark:text-stone-400'>No matches found.</div>
              )}
              {searchQuery.trim() && filteredResults.length > 0 && (
                <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3'>
                  {filteredResults.map((item, idx) => {
                    const messageText = (item.plain || item.content || '').trim() || '(empty message)'
                    return (
                      <button
                        key={item.id}
                        type='button'
                        onClick={() => handleSelectSearchResult(item)}
                        onMouseEnter={() => setSearchHoverIndex(idx)}
                        className={`flex flex-col justify-start text-left rounded-xl bg-white/55 dark:bg-white/10 p-3 min-h-[320px] shadow-sm hover:bg-white/75 dark:hover:bg-white/15 transition-[background-color,color,opacity,transform] duration-150 ${
                          idx === searchHoverIndex ? 'ring-2 ring-amber-300/70 dark:ring-amber-400/50' : ''
                        }`}
                      >
                        <div className='flex items-center justify-between text-[11px] uppercase tracking-wide text-stone-500 dark:text-stone-400'>
                          <span className='font-semibold'>{item.role}</span>
                          <span>#{idx + 1}</span>
                        </div>
                        <div className='mt-2 text-sm text-stone-700 dark:text-stone-200 max-h-48 sm:max-h-52 md:max-h-60 lg:max-h-64 overflow-y-auto thin-scrollbar whitespace-pre-wrap'>
                          {renderHighlightedText(messageText)}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {showConversationSelector && (
        <div
          className='absolute inset-0 z-30 flex items-center justify-center bg-black/30 backdrop-blur-[2px]'
          onClick={handleCloseConversationSelector}
        >
          <div
            className='bg-white dark:bg-neutral-900 border border-stone-200 dark:border-neutral-700 rounded-2xl shadow-2xl flex flex-col max-h-[80vh] w-[92%] max-w-lg'
            onClick={e => e.stopPropagation()}
            data-heimdall-wheel-exempt='true'
          >
            <div className='flex items-center justify-between px-5 py-4 border-b border-stone-200 dark:border-neutral-800 shrink-0'>
              <div>
                <h3 className='text-base font-semibold text-stone-800 dark:text-stone-100'>
                  {conversationTransferMode === 'move' ? 'Move to Existing Chat' : 'Copy to Existing Chat'}
                </h3>
                <p className='text-xs text-stone-500 dark:text-stone-400'>
                  Choose a chat. Messages will be inserted preserving the selected branch structure{conversationTransferMode === 'move' ? ' and removed from this chat.' : '.'}
                </p>
              </div>
              <button
                onClick={handleCloseConversationSelector}
                disabled={isAddingToConversation}
                className='p-1.5 hover:bg-stone-200 dark:hover:bg-neutral-800 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
                aria-label='Close conversation selector'
              >
                <svg className='w-5 h-5 text-stone-500' fill='none' viewBox='0 0 24 24' stroke='currentColor'>
                  <path strokeLinecap='round' strokeLinejoin='round' strokeWidth={2} d='M6 18L18 6M6 6l12 12' />
                </svg>
              </button>
            </div>

            {conversationSelectorError && (
              <div className='mx-5 mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300'>
                {conversationSelectorError}
              </div>
            )}

            <div className='overflow-y-auto flex-1 thin-scrollbar px-3 py-3' data-heimdall-wheel-exempt='true'>
              {conversationsLoading && (
                <div className='px-2 py-8 text-center text-sm text-stone-500 dark:text-stone-400'>Loading chats...</div>
              )}

              {!conversationsLoading && conversationsIsError && (
                <div className='px-2 py-8 text-center text-sm text-red-600 dark:text-red-400'>
                  Failed to load chats. Close and try again.
                </div>
              )}

              {!conversationsLoading && !conversationsIsError && selectableConversations.length === 0 && (
                <div className='px-2 py-8 text-center text-sm text-stone-500 dark:text-stone-400'>
                  No other chats found.
                </div>
              )}

              {!conversationsLoading && !conversationsIsError && selectableConversations.length > 0 && (
                <div className='space-y-1'>
                  {selectableConversations.map(conversation => {
                    const title = conversation.title?.trim() || 'Untitled conversation'
                    const updatedAt = conversation.updated_at ? new Date(conversation.updated_at) : null
                    const updatedLabel = updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt.toLocaleDateString() : null
                    return (
                      <button
                        key={String(conversation.id)}
                        type='button'
                        disabled={isAddingToConversation}
                        onClick={() => handleAddSelectionToConversation(conversation)}
                        className='w-full text-left rounded-xl px-3 py-3 transition-colors hover:bg-stone-100 dark:hover:bg-neutral-800 disabled:opacity-60 disabled:cursor-wait'
                      >
                        <div className='flex items-center gap-3'>
                          <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-stone-100 text-stone-500 dark:bg-neutral-800 dark:text-neutral-300'>
                            <i className='bx bx-message-rounded-dots text-lg' />
                          </div>
                          <div className='min-w-0 flex-1'>
                            <div className='truncate text-sm font-medium text-stone-800 dark:text-stone-100'>{title}</div>
                            <div className='mt-0.5 flex items-center gap-2 text-[11px] text-stone-500 dark:text-stone-400'>
                              {updatedLabel && <span>{updatedLabel}</span>}
                              {conversation.storage_mode && (
                                <span className='rounded-full bg-stone-100 px-1.5 py-0.5 uppercase dark:bg-neutral-800'>
                                  {conversation.storage_mode}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            <div className='flex items-center justify-between gap-3 border-t border-stone-200 px-5 py-3 text-xs text-stone-500 dark:border-neutral-800 dark:text-stone-400'>
              <span>{selectedNodes.length} selected message{selectedNodes.length === 1 ? '' : 's'}</span>
              {isAddingToConversation && (
                <span>{conversationTransferMode === 'move' ? 'Moving messages...' : 'Copying messages...'}</span>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Custom context menu after selection */}
      {showContextMenu && contextMenuPos && (
        <div
          className='absolute z-30 w-[240px] rounded-[20px] border border-stone-200/55 bg-white/75 p-1.5 shadow-[0_18px_36px_-22px_rgba(0,0,0,0.18)] backdrop-blur-2xl animate-menuEntrance dark:border-neutral-700/55 dark:bg-neutral-900/75 dark:shadow-[0_30px_60px_-12px_rgba(0,0,0,0.6)]'
          style={heimdallContextMenuStyle}
          onMouseDown={e => e.stopPropagation()}
        >
          <div
            className='font-mono text-[9px] uppercase tracking-[0.1em] text-stone-400 dark:text-neutral-500 px-3 py-2'
            style={heimdallContextMenuHeaderStyle}
          >
            Message Actions
          </div>

          <button
            className={heimdallContextMenuItemClass}
            style={getHeimdallContextMenuItemStyle()}
            onClick={handleCopySelectedPaths}
          >
            <svg
              className='w-4 h-4 opacity-50 group-hover:opacity-100 transition-opacity'
              fill='none'
              viewBox='0 0 24 24'
              stroke='currentColor'
              strokeWidth={2}
            >
              <path d='M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z' />
            </svg>
            <span>Copy Text</span>
            <span className='ml-auto font-mono text-[10px] tracking-[0.05em] text-stone-400 dark:text-neutral-500'>
              ⌘C
            </span>
          </button>

          {selectedNodes.length === 1 && (
            <button
              className={heimdallContextMenuItemClass}
              style={getHeimdallContextMenuItemStyle()}
              onClick={() => {
                const nodeId = String(selectedNodes[0])
                if (contextMenuPos) {
                  handleOpenNoteDialog(nodeId, contextMenuPos)
                }
              }}
            >
              <svg
                className='w-4 h-4 opacity-50 group-hover:opacity-100 transition-opacity'
                fill='none'
                viewBox='0 0 24 24'
                stroke='currentColor'
                strokeWidth={2}
              >
                <path d='M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z' />
              </svg>
              <span>
                {(() => {
                  const message = getCurrentMessage(selectedNodes[0])
                  const hasNote = message?.note && message.note.trim().length > 0
                  return hasNote ? 'View Note' : 'Add Note'
                })()}
              </span>
              <span className='ml-auto font-mono text-[10px] tracking-[0.05em] text-stone-400 dark:text-neutral-500'>
                N
              </span>
            </button>
          )}

          <div
            className='h-px bg-stone-200 dark:bg-neutral-700 mx-2 my-1.5'
            style={heimdallContextMenuDividerStyle}
          />

          <button
            className={heimdallContextMenuItemClass}
            style={getHeimdallContextMenuItemStyle()}
            onClick={handleCreateNewChat}
          >
            <svg
              className='w-4 h-4 opacity-50 group-hover:opacity-100 transition-opacity'
              fill='none'
              viewBox='0 0 24 24'
              stroke='currentColor'
              strokeWidth={2}
            >
              <path d='M12 4v16m8-8H4' />
            </svg>
            <span>New Chat From Here</span>
          </button>

          <button
            className={heimdallContextMenuItemClass}
            style={getHeimdallContextMenuItemStyle()}
            onClick={() => handleOpenConversationSelector('copy')}
          >
            <svg
              className='w-4 h-4 opacity-50 group-hover:opacity-100 transition-opacity'
              fill='none'
              viewBox='0 0 24 24'
              stroke='currentColor'
              strokeWidth={2}
            >
              <path d='M9 12h11m-5-5 5 5-5 5M4 5h4v14H4z' />
            </svg>
            <span>Copy to Existing Chat</span>
          </button>

          <button
            className={heimdallContextMenuItemClass}
            style={getHeimdallContextMenuItemStyle()}
            onClick={() => handleOpenConversationSelector('move')}
          >
            <svg
              className='w-4 h-4 opacity-50 group-hover:opacity-100 transition-opacity'
              fill='none'
              viewBox='0 0 24 24'
              stroke='currentColor'
              strokeWidth={2}
            >
              <path d='M7 7h10v10M17 7 7 17' />
            </svg>
            <span>Move to Existing Chat</span>
          </button>

          <div
            className='h-px bg-stone-200 dark:bg-neutral-700 mx-2 my-1.5'
            style={heimdallContextMenuDividerStyle}
          />

          <button
            className={heimdallContextMenuDestructiveItemClass}
            style={getHeimdallContextMenuItemStyle(true)}
            onClick={handleDeleteNodes}
          >
            <svg
              className='w-4 h-4 opacity-50 group-hover:opacity-100 transition-opacity'
              fill='none'
              viewBox='0 0 24 24'
              stroke='currentColor'
              strokeWidth={2}
            >
              <path d='M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16' />
            </svg>
            <span>Delete Permanently</span>
            <span className='ml-auto font-mono text-[10px] tracking-[0.05em] text-stone-400 dark:text-neutral-500'>
              DEL
            </span>
          </button>
        </div>
      )}

      <DeleteConfirmModal
        isOpen={showDeleteConfirmModal && pendingDeleteNodeIds.length > 0}
        title={pendingDeleteNodeIds.length > 1 ? `Delete ${pendingDeleteNodeIds.length} messages?` : 'Delete message?'}
        description='This action cannot be undone.'
        backgroundColor={heimdallNoteDialogBackgroundColor}
        borderColor={heimdallNoteDialogBorderColor}
        titleTextColor={heimdallNoteDialogTitleTextColor}
        bodyTextColor={heimdallNodeHoverModalTextColor}
        checkboxTextColor={heimdallNodeHoverModalTextColor}
        cancelButtonBackgroundColor={heimdallNoteDialogButtonBackgroundColor}
        cancelButtonBorderColor={heimdallNoteDialogButtonBorderColor}
        cancelButtonTextColor={heimdallNoteDialogButtonTextColor}
        confirmButtonBackgroundColor={customThemeEnabled ? heimdallNoteDialogButtonBackgroundColor : '#dc2626'}
        confirmButtonBorderColor={customThemeEnabled ? heimdallNoteDialogButtonBorderColor : '#b91c1c'}
        confirmButtonTextColor={customThemeEnabled ? heimdallNoteDialogButtonTextColor : '#ffffff'}
        dontAskAgain={dontAskDeleteAgain}
        onDontAskAgainChange={setDontAskDeleteAgain}
        onCancel={closeDeleteNodesModal}
        onConfirm={confirmDeleteNodesModal}
      />
      {selectedNode &&
        !hoveredNote &&
        (() => {
          const nodeIdParsed = parseId(selectedNode.id)
          const msg =
            (typeof nodeIdParsed === 'number' && !isNaN(nodeIdParsed)) || typeof nodeIdParsed === 'string'
              ? getCurrentMessage(nodeIdParsed)
              : null

          const contentBlocks = msg?.content_blocks || []
          const hasImage =
            Array.isArray(contentBlocks) && contentBlocks.some((block: any) => block.type === 'image' && block.url)

          const popupWidth = hasImage ? 800 : 320
          const popupMaxHeight = hasImage ? 600 : 450

          const dockedPreview = getDockedPreviewLayout(selectedNode.id, popupWidth, popupMaxHeight, mousePosition)

          return (
            <div
              className='pointer-events-none absolute z-20'
              style={{ left: dockedPreview.left, top: dockedPreview.top }}
            >
              <div
                className='pointer-events-auto rounded-[20px] border border-stone-200/55 bg-white/75 p-4 shadow-[0_18px_36px_-22px_rgba(0,0,0,0.18)] backdrop-blur-2xl no-scrollbar dark:border-neutral-700/55 dark:bg-neutral-900/75 dark:shadow-[0_30px_60px_-12px_rgba(0,0,0,0.6)]'
                data-heimdall-wheel-exempt='true'
                onMouseEnter={handleMessagePreviewEnter}
                onMouseLeave={handleMessagePreviewLeave}
                style={{
                  width: `${dockedPreview.width}px`,
                  maxHeight: `${popupMaxHeight}px`,
                  overflow: 'auto',
                  ...heimdallHoverPreviewStyle,
                }}
              >
              <div className='text-sm mb-2 font-medium' style={{ color: heimdallNodeHoverModalTitleTextColor }}>
                {selectedNode.sender === 'user' ? 'User' : selectedNode.sender === 'ex_agent' ? 'Agent' : 'Assistant'}
              </div>
              {(() => {
                const hasContentBlocks = Array.isArray(contentBlocks) && contentBlocks.length > 0

                // If we have content_blocks, render them
                if (hasContentBlocks) {
                  return (
                    <div className='space-y-2'>
                      {contentBlocks.map((block: any, idx: number) => {
                        // Image block
                        if (block.type === 'image' && block.url) {
                          return (
                            <div key={`img-${idx}`} className='rounded overflow-hidden'>
                              <img
                                src={block.url}
                                alt={`Generated image ${idx + 1}`}
                                className={`max-w-full object-contain rounded ${
                                  hasImage ? 'max-h-[600px]' : 'max-h-48'
                                }`}
                              />
                            </div>
                          )
                        }

                        // Text block
                        if (block.type === 'text' && block.text) {
                          return (
                            <div
                              key={`text-${idx}`}
                              className='prose prose-sm dark:prose-invert max-w-none text-sm break-words overflow-hidden ygg-line-clamp-8'
                            >
                              <ReactMarkdown
                                remarkPlugins={[remarkGfm]}
                                rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
                              >
                                {block.text}
                              </ReactMarkdown>
                            </div>
                          )
                        }

                        // Tool use block
                        if (block.type === 'tool_use' && block.name) {
                          return (
                            <div
                              key={`tool-${idx}`}
                              className='bg-amber-50 dark:bg-neutral-900/30 border border-amber-200 dark:border-neutral-900 rounded-lg p-2'
                            >
                              <div className='flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300 mb-1'>
                                <span>🔧</span>
                                {block.name}
                              </div>
                              {block.input && (
                                <pre className='text-xs bg-amber-100/50 dark:bg-neutral-900/20 rounded p-1.5 overflow-x-auto no-scrollbar max-h-24 overflow-y-auto'>
                                  {typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2)}
                                </pre>
                              )}
                            </div>
                          )
                        }

                        // Tool result block
                        if (block.type === 'tool_result') {
                          const resultContent =
                            typeof block.content === 'string' ? block.content : JSON.stringify(block.content, null, 2)
                          return (
                            <div
                              key={`result-${idx}`}
                              className='bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-700 rounded-lg p-2'
                            >
                              <div className='flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300 mb-1'>
                                <span>✓</span>
                                Tool Result
                              </div>
                              <pre className='text-xs bg-emerald-100/50 dark:bg-emerald-900/20 rounded p-1.5 overflow-x-auto no-scrollbar max-h-24 overflow-y-auto whitespace-pre-wrap break-words'>
                                {resultContent?.slice(0, 500)}
                                {resultContent?.length > 500 ? '...' : ''}
                              </pre>
                            </div>
                          )
                        }

                        // Thinking block
                        if (block.type === 'thinking' && block.thinking) {
                          return (
                            <div
                              key={`think-${idx}`}
                              className='bg-purple-50 dark:bg-purple-900/30 border border-purple-200 dark:border-purple-700 rounded-lg p-2'
                            >
                              <div className='flex items-center gap-1.5 text-xs font-medium text-purple-700 dark:text-purple-300 mb-1'>
                                <span>💭</span>
                                Thinking
                              </div>
                              <p className='text-xs text-purple-600 dark:text-purple-300 line-clamp-4'>
                                {block.thinking}
                              </p>
                            </div>
                          )
                        }

                        return null
                      })}
                      {/* Also show message content if present and no text blocks were rendered */}
                      {selectedNode.message &&
                        selectedNode.message.trim().length > 0 &&
                        !contentBlocks.some((b: any) => b.type === 'text' && b.text) && (
                          <div className='prose prose-sm dark:prose-invert max-w-none text-sm break-words overflow-hidden ygg-line-clamp-8'>
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
                            >
                              {selectedNode.message}
                            </ReactMarkdown>
                          </div>
                        )}
                    </div>
                  )
                }

                // Fallback to message content
                return (
                  <div
                    className={`prose prose-sm dark:prose-invert max-w-none text-sm break-words ${
                      isMobile
                        ? 'max-h-80 overflow-y-auto overflow-x-hidden thin-scrollbar'
                        : 'overflow-hidden overflow-x-hidden ygg-line-clamp-15'
                    }`}
                  >
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
                    >
                      {selectedNode.message || '...'}
                    </ReactMarkdown>
                  </div>
                )
              })()}
              </div>
            </div>
          )
        })()}
      {hoveredNote &&
        (() => {
          const dockedPreview = getDockedPreviewLayout(
            hoveredNote.nodeId,
            NOTE_PREVIEW_WIDTH,
            NOTE_PREVIEW_MAX_HEIGHT,
            hoveredNote.fallbackPosition
          )

          return (
            <div
              className='pointer-events-none absolute z-30'
              style={{ left: dockedPreview.left, top: dockedPreview.top }}
            >
          <div
            className='pointer-events-auto rounded-[20px] border border-stone-200/55 bg-white/75 p-4 shadow-[0_18px_36px_-22px_rgba(0,0,0,0.18)] backdrop-blur-2xl no-scrollbar dark:border-neutral-700/55 dark:bg-neutral-900/75 dark:shadow-[0_30px_60px_-12px_rgba(0,0,0,0.6)]'
            data-heimdall-wheel-exempt='true'
            onMouseEnter={handleNotePreviewEnter}
            onMouseLeave={handleNotePreviewLeave}
            style={{
              width: `${dockedPreview.width}px`,
              maxHeight: `${NOTE_PREVIEW_MAX_HEIGHT}px`,
              overflow: 'auto',
              ...heimdallHoverPreviewStyle,
            }}
          >
            <div className='text-sm font-medium mb-2' style={{ color: heimdallNodeHoverModalTitleTextColor }}>
              {hoveredNote.sender === 'user'
                ? 'User Note'
                : hoveredNote.sender === 'ex_agent'
                  ? 'Agent Note'
                  : 'Assistant Note'}
            </div>
            <div className='prose prose-sm dark:prose-invert max-w-none text-sm break-words overflow-y-auto thin-scrollbar'>
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}>
                {hoveredNote.note}
              </ReactMarkdown>
            </div>
          </div>
        </div>
          )
        })()}
      {/* Note dialog */}
      {/* Subagent Calls Modal */}
      {subagentPanel &&
        (() => {
          const parentId = subagentPanel.parentId
          const subagentNodes =
            subagentModalData?.parentId === parentId ? subagentModalData.nodes : subagentMapByParent[parentId] || []
          const isSubagentLoading = subagentModalData?.parentId === parentId && subagentModalData.loading
          const subagentError = subagentModalData?.parentId === parentId ? subagentModalData.error : null

          // Find parent node message to display
          const parentMessage = messageById.get(parentId)

          return (
            <div
              className='absolute inset-0 z-10 flex items-center justify-center bg-black/40 backdrop-blur-[2px]'
              onClick={() => setSubagentPanel(null)}
            >
              <div
                className='bg-neutral-50 dark:bg-zinc-900 border border-stone-200 dark:border-neutral-700 rounded-2xl shadow-2xl flex flex-col max-h-[85vh] w-[90%] max-w-2xl'
                onClick={e => e.stopPropagation()}
              >
                {/* Header */}
                <div className='flex justify-between items-center px-5 py-4 border-b border-stone-200 dark:border-neutral-800 shrink-0'>
                  <h3 className='text-base font-semibold text-stone-800 dark:text-stone-100'>
                    Subagent Calls ({subagentNodes.length})
                  </h3>
                  <button
                    onClick={() => setSubagentPanel(null)}
                    className='p-1.5 hover:bg-stone-200 dark:hover:bg-neutral-800 rounded-full transition-colors'
                  >
                    <svg className='w-5 h-5 text-stone-500' fill='none' viewBox='0 0 24 24' stroke='currentColor'>
                      <path strokeLinecap='round' strokeLinejoin='round' strokeWidth={2} d='M6 18L18 6M6 6l12 12' />
                    </svg>
                  </button>
                </div>

                {/* Scrollable content */}
                <div
                  ref={subagentModalScrollRef}
                  className='overflow-y-auto flex-1 thin-scrollbar'
                  data-heimdall-wheel-exempt='true'
                  onScroll={event => {
                    subagentModalScrollTopRef.current = event.currentTarget.scrollTop
                  }}
                >
                  {isSubagentLoading && (
                    <div className='px-5 py-3 text-xs text-stone-500 dark:text-stone-400'>Loading subagent data...</div>
                  )}
                  {!isSubagentLoading && subagentError && (
                    <div className='px-5 py-3 text-xs text-red-600 dark:text-red-400'>{subagentError}</div>
                  )}
                  {/* Parent task context */}
                  <div className='px-5 py-4 border-b border-stone-100 dark:border-neutral-800 bg-stone-50 dark:bg-neutral-900/50'>
                    <div className='text-xs font-medium text-stone-500 dark:text-stone-400 uppercase tracking-wider mb-2'>
                      Parent Task
                    </div>
                    <div className='prose prose-sm dark:prose-invert max-w-none text-stone-700 dark:text-stone-300 prose-p:my-1 prose-headings:my-2 prose-pre:my-2 prose-pre:bg-stone-100 dark:prose-pre:bg-neutral-800 prose-code:text-orange-600 dark:prose-code:text-orange-400'>
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                        {parentMessage?.content || 'Parent Task'}
                      </ReactMarkdown>
                    </div>
                  </div>

                  {/* Subagent calls list */}
                  <div className='divide-y divide-stone-100 dark:divide-neutral-800'>
                    {subagentNodes.map((node, i) => {
                      // Parse content_blocks if available
                      const blocks = Array.isArray(node.content_blocks) ? node.content_blocks : []
                      const hasBlocks = blocks.length > 0
                      const normalizedNodeMessage = node.message?.trim().replace(/\s+/g, ' ')
                      const hasDuplicatePromptInBlocks =
                        !!normalizedNodeMessage &&
                        blocks.some((block: any) => {
                          if (block.type === 'text') {
                            const textContent = (block.content ?? block.text)?.trim().replace(/\s+/g, ' ')
                            return textContent === normalizedNodeMessage
                          }

                          if (block.type === 'tool_use') {
                            const prompt = block.input?.prompt
                            return typeof prompt === 'string' && prompt.trim().replace(/\s+/g, ' ') === normalizedNodeMessage
                          }

                          return false
                        })
                      const shouldRenderNodeMessage = !!node.message && !hasDuplicatePromptInBlocks

                      return (
                        <div key={node.id} className='px-5 py-4'>
                          <div className='flex items-center gap-2 mb-3'>
                            <span className='inline-flex items-center justify-center w-6 h-6 rounded-full bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 text-xs font-bold'>
                              {i + 1}
                            </span>
                            <span className='text-xs font-semibold text-orange-600 dark:text-orange-400 uppercase tracking-wider'>
                              Subagent Call
                            </span>
                          </div>

                          {/* Show prompt/message first when it is not already present in content blocks */}
                          {shouldRenderNodeMessage && (
                            <div className='prose prose-sm dark:prose-invert max-w-none text-stone-800 dark:text-stone-200 prose-p:my-1 prose-headings:my-2 prose-pre:my-2 prose-pre:bg-stone-100 dark:prose-pre:bg-neutral-800 prose-code:text-orange-600 dark:prose-code:text-orange-400 prose-pre:text-xs prose-pre:overflow-x-auto mb-3'>
                              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                                {node.message}
                              </ReactMarkdown>
                            </div>
                          )}

                          {/* Render content_blocks */}
                          {hasBlocks && (
                            <div className='space-y-3 mt-3'>
                              {blocks.map((block: any, blockIdx: number) => {
                                // Text block
                                if (block.type === 'text') {
                                  const textContent = block.content ?? block.text
                                  if (!textContent) return null
                                  return (
                                    <div
                                      key={blockIdx}
                                      className='prose prose-sm dark:prose-invert max-w-none text-stone-700 dark:text-stone-300 prose-p:my-1 prose-pre:my-2 prose-pre:bg-stone-100 dark:prose-pre:bg-neutral-800 prose-code:text-orange-600 dark:prose-code:text-orange-400 prose-pre:text-xs prose-pre:overflow-x-auto'
                                    >
                                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                                        {textContent}
                                      </ReactMarkdown>
                                    </div>
                                  )
                                }

                                // Tool use block
                                if (block.type === 'tool_use') {
                                  return (
                                    <details
                                      key={blockIdx}
                                      className='group border-l-2 border-blue-400 dark:border-blue-600 pl-3 py-2'
                                    >
                                      <summary className='flex cursor-pointer list-none items-center gap-2 mb-1 select-none [&::-webkit-details-marker]:hidden'>
                                        <svg
                                          className='h-3 w-3 text-blue-600 dark:text-blue-400 transition-transform group-open:rotate-90'
                                          fill='none'
                                          viewBox='0 0 24 24'
                                          stroke='currentColor'
                                        >
                                          <path strokeLinecap='round' strokeLinejoin='round' strokeWidth={2} d='M9 5l7 7-7 7' />
                                        </svg>
                                        <span className='text-[10px] font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wider'>
                                          Tool: {block.name}
                                        </span>
                                      </summary>
                                      {block.input && (
                                        <pre className='mt-2 text-[11px] text-stone-600 dark:text-stone-400 bg-stone-100 dark:bg-neutral-800 p-2 rounded overflow-x-auto max-h-40 thin-scrollbar'>
                                          {typeof block.input === 'string'
                                            ? block.input
                                            : JSON.stringify(block.input, null, 2)}
                                        </pre>
                                      )}
                                    </details>
                                  )
                                }

                                // Tool result block
                                if (block.type === 'tool_result') {
                                  const isError = block.is_error
                                  const content =
                                    typeof block.content === 'string'
                                      ? block.content
                                      : JSON.stringify(block.content, null, 2)
                                  return (
                                    <details
                                      key={blockIdx}
                                      className={`group border-l-2 ${isError ? 'border-red-400 dark:border-red-600' : 'border-emerald-400 dark:border-emerald-600'} pl-3 py-2`}
                                    >
                                      <summary className='flex cursor-pointer list-none items-center gap-2 mb-1 select-none [&::-webkit-details-marker]:hidden'>
                                        <svg
                                          className={`h-3 w-3 transition-transform group-open:rotate-90 ${isError ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}
                                          fill='none'
                                          viewBox='0 0 24 24'
                                          stroke='currentColor'
                                        >
                                          <path strokeLinecap='round' strokeLinejoin='round' strokeWidth={2} d='M9 5l7 7-7 7' />
                                        </svg>
                                        <span
                                          className={`text-[10px] font-semibold uppercase tracking-wider ${isError ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}
                                        >
                                          {isError ? 'Error' : 'Result'}
                                        </span>
                                      </summary>
                                      <pre className='mt-2 text-[11px] text-stone-600 dark:text-stone-400 bg-stone-100 dark:bg-neutral-800 p-2 rounded overflow-x-auto max-h-60 whitespace-pre-wrap break-words thin-scrollbar'>
                                        {content}
                                      </pre>
                                    </details>
                                  )
                                }

                                // Thinking block
                                if (block.type === 'thinking' && block.content) {
                                  return (
                                    <details
                                      key={blockIdx}
                                      className='group border-l-2 border-purple-400 dark:border-purple-600 pl-3 py-2 bg-purple-50/50 dark:bg-purple-900/10 rounded-r'
                                    >
                                      <summary className='flex cursor-pointer list-none items-center gap-2 mb-1 select-none [&::-webkit-details-marker]:hidden'>
                                        <svg
                                          className='h-3 w-3 text-purple-600 dark:text-purple-400 transition-transform group-open:rotate-90'
                                          fill='none'
                                          viewBox='0 0 24 24'
                                          stroke='currentColor'
                                        >
                                          <path strokeLinecap='round' strokeLinejoin='round' strokeWidth={2} d='M9 5l7 7-7 7' />
                                        </svg>
                                        <span className='text-[10px] font-semibold text-purple-600 dark:text-purple-400 uppercase tracking-wider'>
                                          Thinking
                                        </span>
                                      </summary>
                                      <div className='mt-2 prose prose-sm dark:prose-invert max-w-none text-stone-600 dark:text-stone-400 prose-p:my-1'>
                                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.content}</ReactMarkdown>
                                      </div>
                                    </details>
                                  )
                                }

                                return null
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          )
        })()}

      {showNoteDialog && noteDialogPos && noteMessageId !== null && (
        <div
          className='note-dialog-container absolute z-40 w-96 border rounded-2xl no-scrollbar shadow-lg'
          style={{
            left: Math.max(8, Math.min(noteDialogPos.x, Math.max(0, dimensions.width - 400))),
            top: Math.max(8, Math.min(noteDialogPos.y, Math.max(0, dimensions.height - 300))),
            backgroundColor: heimdallNoteDialogBackgroundColor,
            borderColor: heimdallNoteDialogBorderColor,
            color: heimdallNoteDialogButtonTextColor,
          }}
          onMouseDown={e => e.stopPropagation()}
          data-heimdall-wheel-exempt='true'
        >
          <div className='px-2 py-2'>
            <div className='flex justify-between items-start mb-2 mx-1 gap-2'>
              <div className='flex flex-col gap-2 min-w-0'>
                <h3 className='text-sm font-medium' style={{ color: heimdallNoteDialogTitleTextColor }}>
                  {(() => {
                    const message = getCurrentMessage(noteMessageId)
                    const hasNote = message?.note && message.note.trim().length > 0
                    return hasNote ? 'Edit Note' : 'Add Note'
                  })()}
                </h3>
                <div className='flex items-center gap-2 flex-wrap'>
                  {NOTE_COLOR_PRESETS.map(color => {
                    const isSelected = noteColor?.toLowerCase() === color.toLowerCase()
                    return (
                      <button
                        key={color}
                        type='button'
                        onClick={() => handleNoteColorChange(color)}
                        className={`w-5 h-5 rounded-full border transition-transform ${isSelected ? 'scale-110 ring-2 ring-offset-1 ring-blue-500 dark:ring-blue-300' : 'hover:scale-105'}`}
                        style={{ backgroundColor: color, borderColor: 'rgba(0,0,0,0.3)' }}
                        title={`Set note color ${color}`}
                        aria-label={`Set note color ${color}`}
                      />
                    )
                  })}
                  <button
                    type='button'
                    onClick={() => customColorInputRef.current?.click()}
                    className='w-5 h-5 rounded-full border text-[10px] leading-none flex items-center justify-center bg-gradient-to-r from-red-500 via-yellow-400 to-blue-500'
                    style={{ borderColor: heimdallNoteDialogButtonBorderColor }}
                    title='Pick custom color'
                    aria-label='Pick custom color'
                  >
                    🌈
                  </button>
                  <button
                    type='button'
                    onClick={() => handleNoteColorChange(null)}
                    className='text-[11px] px-2 py-0.5 rounded-full border hover:bg-stone-100 dark:hover:bg-neutral-800'
                    style={{
                      backgroundColor: heimdallNoteDialogButtonBackgroundColor,
                      borderColor: heimdallNoteDialogButtonBorderColor,
                      color: heimdallNoteDialogButtonTextColor,
                    }}
                    title='Use default note pill color'
                  >
                    Default
                  </button>
                  <input
                    ref={customColorInputRef}
                    type='color'
                    value={noteColor || '#3b82f6'}
                    onChange={e => handleNoteColorChange(e.target.value)}
                    className='sr-only'
                    aria-label='Custom note color picker'
                  />
                </div>
              </div>
              <button
                onClick={handleCloseNoteDialog}
                className='active:scale-95'
                style={{ color: heimdallNoteDialogCloseButtonTextColor }}
                title='Close'
              >
                ✕
              </button>
            </div>
            <div className=''>
              <TextArea
                placeholder='Enter your note...'
                value={noteText}
                onChange={handleNoteTextChange}
                minRows={3}
                maxRows={16}
                autoFocus
                className='w-full thin-scrollbar rounded-2xl'
                width='w-full'
              />
            </div>
          </div>
        </div>
      )}
      {/* LowBar for conversation research notes with tabbed interface */}
      {/* {__IS_ELECTRON__ && (
        <LowBar
          conversationId={conversationId}
          enableTabs={true}
          notes={researchNotes}
          isLoadingNotes={isLoadingNotes}
        />
      )}{' '} */}
    </div>
  )
}

export default React.memo(Heimdall)
