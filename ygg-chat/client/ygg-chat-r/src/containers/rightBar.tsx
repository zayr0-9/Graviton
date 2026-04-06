import { useQueryClient } from '@tanstack/react-query'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import { ConversationId } from '../../../../shared/types'
import {
  BrowserPane,
  Button,
  ChatMessage,
  MonacoFileEditorPane,
  MonacoGitDiffPane,
  XtermTerminalPane,
} from '../components'
import { useHtmlIframeRegistry } from '../components/HtmlIframeRegistry/HtmlIframeRegistry'
import { TextArea } from '../components/TextArea/TextArea'
import { useHtmlDarkMode } from '../components/ThemeManager/themeConfig'
import { updateResearchNote } from '../features/conversations/conversationActions'
import { makeSelectConversationById } from '../features/conversations/conversationSelectors'
import { Conversation } from '../features/conversations/conversationTypes'
import type { StreamEvent, StreamState } from '../features/chats/chatTypes'
import { setCurrentSelection, type SelectionInfo } from '../features/ideContext'
import { uiActions } from '../features/ui'
import { AGENT_SETTINGS_CHANGE_EVENT, AgentSettings, loadAgentSettings } from '../helpers/agentSettingsStorage'
import {
  loadTerminalDockState,
  saveTerminalDockState,
  type TerminalDockPreferences,
} from '../helpers/terminalDockStorage'
import {
  OPEN_WORKSPACE_MUTATION_DIFFS_EVENT,
  type OpenWorkspaceMutationDiffsDetail,
} from '../helpers/workspaceMutationDiffBridge'
import { useAuth } from '../hooks/useAuth'
import { clearGlobalAgentOptimisticMessage, setGlobalAgentOptimisticMessage } from '../hooks/useGlobalAgentCache'
import {
  DirectoryFileEntry,
  GitBranch,
  GitCommit,
  GitStatusFile,
  GlobalAgentQueuedTask,
  ResearchNoteItem,
  useDirectoryFiles,
  useDirectoryFileSearch,
  useGitCheckoutBranch,
  useGitCreateBranch,
  useGitDiff,
  useGitOverview,
  useGitStageFiles,
  useGitUnstageFiles,
  useGlobalAgentMessages,
  useGlobalAgentOptimisticMessage,
  useGlobalAgentQueuedTasks,
  useGlobalAgentStreamBuffer,
  useRemoveGlobalAgentQueuedTask,
} from '../hooks/useQueries'
import { resolveLanguageInfo } from '../lib/lsp/languageIds'
import { lspClientPool } from '../lib/lsp/lspClientPool'
import { onTrackedModelContentChange, releaseModel, retainModel, setModelContent } from '../lib/lsp/modelRegistry'
import { globalAgentLoop, GlobalAgentSchedulePreset, GlobalAgentState, GlobalAgentTaskSchedule } from '../services'
import type { RootState } from '../store/store'
import { localApi } from '../utils/api'

interface RightBarProps {
  conversationId: ConversationId | null
  notes?: ResearchNoteItem[]
  isLoadingNotes?: boolean
  className?: string
  ccCwd?: string
  onFilePathInsert?: (path: string) => void
}

type ScheduleIntervalUnit = 'seconds' | 'minutes' | 'hours'

type AgentScheduleDraft = {
  preset: GlobalAgentSchedulePreset
  repeatCount: number
  intervalValue: number
  intervalUnit: ScheduleIntervalUnit
  startDate: string
  endDate: string
  allowedWeekdays: number[]
}

type FileEditorState = {
  path: string
  relativePath: string
  content: string
  savedContent: string
  loading: boolean
  saving: boolean
  error: string | null
}

type LspResolveState = {
  available: boolean
  filePath: string
  fileUri: string
  lspLanguageId: string | null
  serverId: string | null
  sessionKey: string | null
  workspacePath: string | null
  workspaceUri: string | null
  command: string | null
  commandSource: string | null
  args: string[]
  reason?: string | null
}

type LspSessionState = {
  sessionKey: string
  serverId: string
  workspacePath: string
  workspaceUri: string
  status: 'idle' | 'starting' | 'running' | 'stopped' | 'error'
  pid: number | null
  command: string | null
  commandSource: string | null
  args: string[]
  attachedClientId: string | null
  attached: boolean
  lastActivityAt: string | null
  startedAt: string | null
  lastError: string | null
  restartCount: number
  stderrTail: string[]
}

type GitDiffTabState = {
  id: string
  path: string
  relativePath: string
  displayPath: string
  staged: boolean
  untracked: boolean
  conflicted: boolean
}

type WorkspaceMutationDiffRequest = {
  filePaths: string[]
  basePath: string | null
  focusPath: string | null
}

type TerminalDockState = {
  id: string
  sessionId: string | null
  cwd: string
  shell: string
  title: string
  history: string
  status: 'launching' | 'open' | 'closed' | 'error'
  error: string | null
  exitCode: number | null
}

type BrowserDockState = {
  id: string
  title: string
  requestedUrl: string
  currentUrl: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  lastError: string | null
}

type AgentStreamActivityKind = StreamEvent['type'] | 'idle'

type AgentStreamListItem = {
  streamId: string
  streamType: string
  conversationId: string | null
  projectId: string | null
  conversationTitle: string | null
  anchorMessageId: string | null
  hasError: boolean
  createdAt: string
  rootMessageId: string | null
  activityKind: AgentStreamActivityKind
  activityLabel: string
  completedAt: string | null
}

const getFileDockTabId = (filePath: string): string => `file:${filePath}`
const getTerminalDockTabId = (terminalId: string): string => `terminal:${terminalId}`
const getBrowserDockTabId = (browserId: string): string => `browser:${browserId}`
const getGitDiffDockTabId = (
  file: Pick<GitStatusFile, 'relativePath' | 'staged' | 'untracked' | 'conflicted'>,
  stagedView: boolean
): string =>
  `git-diff:${file.untracked ? 'untracked' : file.conflicted ? 'conflicted' : stagedView ? 'staged' : 'unstaged'}:${file.relativePath}`

const normalizePathForCompare = (value: string | null | undefined): string =>
  String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()

const normalizeRelativeGitPath = (value: string | null | undefined): string =>
  String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '')

const isLikelyAbsolutePath = (value: string | null | undefined): boolean =>
  /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(String(value || '').trim())

const getDefaultGitDiffStagedView = (
  file: Pick<GitStatusFile, 'staged' | 'unstaged' | 'untracked' | 'conflicted'>
): boolean => !file.untracked && !file.conflicted && file.staged && !file.unstaged

const buildGitDiffDockTabState = (params: {
  path: string
  relativePath: string
  displayPath: string
  staged: boolean
  untracked: boolean
  conflicted: boolean
}): GitDiffTabState => ({
  id: getGitDiffDockTabId(params, params.staged),
  path: params.path,
  relativePath: params.relativePath,
  displayPath: params.displayPath,
  staged: params.staged,
  untracked: params.untracked,
  conflicted: params.conflicted,
})

const inferGitRepoRootFromStatusFiles = (statusFiles: GitStatusFile[]): string | null => {
  for (const file of statusFiles) {
    const normalizedAbsolutePath = String(file.path || '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
    const normalizedRelativePath = normalizeRelativeGitPath(file.relativePath)

    if (!normalizedAbsolutePath || !normalizedRelativePath) continue

    const absoluteLower = normalizedAbsolutePath.toLowerCase()
    const relativeLower = normalizedRelativePath.toLowerCase()
    const suffix = `/${relativeLower}`

    if (!absoluteLower.endsWith(suffix)) continue

    return normalizedAbsolutePath.slice(0, normalizedAbsolutePath.length - normalizedRelativePath.length - 1)
  }

  return null
}

const resolveWorkspaceMutationDiffTabs = (
  request: WorkspaceMutationDiffRequest,
  statusFiles: GitStatusFile[]
): GitDiffTabState[] => {
  const absoluteStatusMap = new Map<string, GitStatusFile>()
  const relativeStatusMap = new Map<string, GitStatusFile>()

  for (const file of statusFiles) {
    const absoluteKey = normalizePathForCompare(file.path)
    if (absoluteKey && !absoluteStatusMap.has(absoluteKey)) {
      absoluteStatusMap.set(absoluteKey, file)
    }

    const relativeKeys = [normalizeRelativeGitPath(file.relativePath), normalizeRelativeGitPath(file.displayPath)]
    for (const key of relativeKeys) {
      const normalizedKey = key.toLowerCase()
      if (normalizedKey && !relativeStatusMap.has(normalizedKey)) {
        relativeStatusMap.set(normalizedKey, file)
      }
    }
  }

  const normalizedBasePath = String(request.basePath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  const normalizedBasePathLower = normalizedBasePath.toLowerCase()
  const inferredRepoRoot = inferGitRepoRootFromStatusFiles(statusFiles)
  const inferredRepoRootLower = inferredRepoRoot?.toLowerCase() || ''
  const tabs: GitDiffTabState[] = []
  const seenTabIds = new Set<string>()

  for (const rawFilePath of request.filePaths) {
    const trimmedFilePath = String(rawFilePath || '').trim()
    if (!trimmedFilePath) continue

    const matchedStatusFile =
      absoluteStatusMap.get(normalizePathForCompare(trimmedFilePath)) ||
      relativeStatusMap.get(normalizeRelativeGitPath(trimmedFilePath).toLowerCase())

    if (matchedStatusFile) {
      const nextTab = buildGitDiffDockTabState({
        path: matchedStatusFile.path,
        relativePath: matchedStatusFile.relativePath,
        displayPath: matchedStatusFile.displayPath,
        staged: getDefaultGitDiffStagedView(matchedStatusFile),
        untracked: matchedStatusFile.untracked,
        conflicted: matchedStatusFile.conflicted,
      })

      if (!seenTabIds.has(nextTab.id)) {
        seenTabIds.add(nextTab.id)
        tabs.push(nextTab)
      }
      continue
    }

    const normalizedOriginalPath = trimmedFilePath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '')
    const normalizedOriginalLower = normalizedOriginalPath.toLowerCase()

    let relativePath = ''
    if (!isLikelyAbsolutePath(trimmedFilePath)) {
      relativePath = normalizeRelativeGitPath(trimmedFilePath)
    } else if (
      inferredRepoRoot &&
      normalizedOriginalLower.startsWith(`${inferredRepoRootLower}/`) &&
      normalizedOriginalPath.length > inferredRepoRoot.length + 1
    ) {
      relativePath = normalizedOriginalPath.slice(inferredRepoRoot.length + 1)
    } else if (
      normalizedBasePath &&
      normalizedOriginalLower.startsWith(`${normalizedBasePathLower}/`) &&
      normalizedOriginalPath.length > normalizedBasePath.length + 1
    ) {
      relativePath = normalizedOriginalPath.slice(normalizedBasePath.length + 1)
    }

    const normalizedRelativePath = normalizeRelativeGitPath(relativePath)
    if (!normalizedRelativePath) continue

    const absolutePathForTab = isLikelyAbsolutePath(trimmedFilePath)
      ? trimmedFilePath
      : normalizedBasePath
        ? `${normalizedBasePath}/${normalizedRelativePath}`
        : ''

    const nextTab = buildGitDiffDockTabState({
      path: absolutePathForTab,
      relativePath: normalizedRelativePath,
      displayPath: normalizedRelativePath,
      staged: false,
      untracked: false,
      conflicted: false,
    })

    if (!seenTabIds.has(nextTab.id)) {
      seenTabIds.add(nextTab.id)
      tabs.push(nextTab)
    }
  }

  return tabs
}

const ALL_WEEKDAYS: number[] = [0, 1, 2, 3, 4, 5, 6]
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const TERMINAL_HISTORY_LIMIT = 200000
const DEFAULT_BROWSER_HOME_URL = 'https://example.com'
const RIGHT_BAR_DEFAULT_WIDTH_PX = 360
const RIGHT_BAR_COLLAPSED_WIDTH_PX = 44
const RIGHT_BAR_MIN_WIDTH_PX = 280
const RIGHT_BAR_MAX_WIDTH_PX = 720
const RIGHT_BAR_RESIZE_HANDLE_WIDTH_PX = 12
const DOCKED_EDITOR_MIN_WIDTH_PX = 260
const DOCKED_EDITOR_DEFAULT_WIDTH_PX = 720
const DOCKED_TOTAL_WIDTH_RATIO = 0.9
const DOCKED_LAYOUT_GAP_PX = 8
const DOCKED_CHAT_MIN_WIDTH_PX = 580

const PRESET_CONFIGS: Array<{
  key: GlobalAgentSchedulePreset
  label: string
  intervalValue: number
  intervalUnit: ScheduleIntervalUnit
}> = [
  { key: 'hourly', label: 'Every Hour', intervalValue: 1, intervalUnit: 'hours' },
  { key: 'every_4_hours', label: 'Every 4 Hours', intervalValue: 4, intervalUnit: 'hours' },
  { key: 'every_6_hours', label: 'Every 6 Hours', intervalValue: 6, intervalUnit: 'hours' },
  { key: 'daily', label: 'Every Day', intervalValue: 24, intervalUnit: 'hours' },
]

const intervalUnitToMs = (value: number, unit: ScheduleIntervalUnit): number => {
  const safeValue = Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1
  if (unit === 'hours') return safeValue * 60 * 60 * 1000
  if (unit === 'minutes') return safeValue * 60 * 1000
  return safeValue * 1000
}

const RightBar: React.FC<RightBarProps> = ({
  conversationId,
  notes = [],
  className = '',
  ccCwd = '',
  onFilePathInsert,
}) => {
  const dispatch = useDispatch()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { userId } = useAuth()
  const isWeb = import.meta.env.VITE_ENVIRONMENT === 'web'
  const htmlRegistry = useHtmlIframeRegistry()

  // File browser state
  const [currentPath, setCurrentPath] = useState<string>(ccCwd)
  const [pathHistory, setPathHistory] = useState<string[]>([])
  const [fileSearchQuery, setFileSearchQuery] = useState('')
  const [debouncedFileSearchQuery, setDebouncedFileSearchQuery] = useState('')
  const [followGitignore, setFollowGitignore] = useState(true)
  const { data: directoryData, isLoading: isLoadingFiles, error: filesError } = useDirectoryFiles(currentPath || null)
  const fileSearchBasePath = ccCwd || currentPath || null
  const activeFileSearchQuery = debouncedFileSearchQuery.trim()
  const isFileSearchMode = activeFileSearchQuery.length > 0
  const {
    data: fileSearchData,
    isLoading: isLoadingFileSearch,
    isFetching: isFetchingFileSearch,
    error: fileSearchError,
  } = useDirectoryFileSearch(fileSearchBasePath, activeFileSearchQuery, followGitignore, 200)
  const displayedDirectoryFiles = isFileSearchMode ? fileSearchData?.files || [] : directoryData?.files || []
  const isSearchingFiles = isLoadingFileSearch || isFetchingFileSearch
  const initialTerminalDockState = useMemo(() => loadTerminalDockState(), [])
  const isCollapsed = useSelector((state: RootState) => state.ui.rightBarCollapsed)
  const rightBarWidth = useSelector((state: RootState) => state.ui.rightBarWidth)
  const extensionConnected = useSelector((state: RootState) => state.ideContext.extensionConnected)
  const hasConnectedIdeExtensions = useSelector((state: RootState) =>
    state.ideContext.extensions.some(extension => extension.isConnected)
  )
  const isDarkMode = useHtmlDarkMode()
  const [openFileEditors, setOpenFileEditors] = useState<FileEditorState[]>([])
  const [openGitDiffTabs, setOpenGitDiffTabs] = useState<GitDiffTabState[]>([])
  const [openTerminalTabs, setOpenTerminalTabs] = useState<TerminalDockState[]>(() =>
    initialTerminalDockState.sessions.map(session => ({
      ...session,
      sessionId: null,
      status: 'closed',
      error: null,
      exitCode: null,
    }))
  )
  const [openBrowserTabs, setOpenBrowserTabs] = useState<BrowserDockState[]>([])
  const [terminalPreferences, setTerminalPreferences] = useState<TerminalDockPreferences>(
    () => initialTerminalDockState.preferences
  )
  const [activeDockTabId, setActiveDockTabId] = useState<string | null>(() =>
    initialTerminalDockState.activeTerminalTabId
      ? getTerminalDockTabId(initialTerminalDockState.activeTerminalTabId)
      : null
  )
  const [activeFileEditorPath, setActiveFileEditorPath] = useState<string | null>(null)
  const [isLspStatusPanelOpen, setIsLspStatusPanelOpen] = useState(false)
  const [lspResolveState, setLspResolveState] = useState<LspResolveState | null>(null)
  const [lspSessionsState, setLspSessionsState] = useState<LspSessionState[]>([])
  const [lspStatusLoading, setLspStatusLoading] = useState(false)
  const [lspStatusError, setLspStatusError] = useState<string | null>(null)
  const [lspStatusRefreshNonce, setLspStatusRefreshNonce] = useState(0)
  const openFileEditorsRef = useRef<FileEditorState[]>([])
  const fileEditorRequestIdRef = useRef<Record<string, number>>({})
  const terminalLaunchRequestIdRef = useRef<Record<string, number>>({})
  const restoredTerminalTabsRef = useRef<Set<string>>(new Set())
  const asideRef = useRef<HTMLElement | null>(null)
  const parentContainerRef = useRef<HTMLElement | null>(null)
  const [isResizingSidebar, setIsResizingSidebar] = useState(false)
  const [isResizingDock, setIsResizingDock] = useState(false)
  const [parentContainerWidth, setParentContainerWidth] = useState<number | null>(null)
  const [dockedLayoutWidth, setDockedLayoutWidth] = useState<number | null>(null)
  const activeFileEditor = useMemo(
    () =>
      activeDockTabId?.startsWith('file:')
        ? (openFileEditors.find(editor => getFileDockTabId(editor.path) === activeDockTabId) ?? null)
        : null,
    [activeDockTabId, openFileEditors]
  )
  const activeGitDiffTab = useMemo(
    () =>
      activeDockTabId?.startsWith('git-diff:')
        ? (openGitDiffTabs.find(tab => tab.id === activeDockTabId) ?? null)
        : null,
    [activeDockTabId, openGitDiffTabs]
  )
  const activeTerminalDock = useMemo(
    () =>
      activeDockTabId?.startsWith('terminal:')
        ? (openTerminalTabs.find(tab => getTerminalDockTabId(tab.id) === activeDockTabId) ?? null)
        : null,
    [activeDockTabId, openTerminalTabs]
  )
  const activeBrowserDock = useMemo(
    () =>
      activeDockTabId?.startsWith('browser:')
        ? (openBrowserTabs.find(tab => getBrowserDockTabId(tab.id) === activeDockTabId) ?? null)
        : null,
    [activeDockTabId, openBrowserTabs]
  )
  const activeLspSession = useMemo(
    () =>
      lspResolveState?.sessionKey
        ? (lspSessionsState.find(session => session.sessionKey === lspResolveState.sessionKey) ?? null)
        : null,
    [lspResolveState?.sessionKey, lspSessionsState]
  )
  const isEditorDirty = activeFileEditor ? activeFileEditor.content !== activeFileEditor.savedContent : false
  const hasAnyDirtyEditors = openFileEditors.some(editor => editor.content !== editor.savedContent)
  const hasDockTabs =
    openFileEditors.length > 0 ||
    openGitDiffTabs.length > 0 ||
    openTerminalTabs.length > 0 ||
    openBrowserTabs.length > 0
  const isEditorDockOpen = !isCollapsed && hasDockTabs && !!activeDockTabId
  const monacoTheme = isDarkMode ? 'vs-dark' : 'vs'

  useEffect(() => {
    openFileEditorsRef.current = openFileEditors
  }, [openFileEditors])

  useEffect(() => {
    if (isWeb || !isLspStatusPanelOpen || !activeFileEditor?.path) {
      if (!isLspStatusPanelOpen) {
        setLspStatusLoading(false)
        setLspStatusError(null)
      }
      return
    }

    let cancelled = false

    const loadLspStatus = async () => {
      setLspStatusLoading(true)
      setLspStatusError(null)

      try {
        const [resolveResponse, sessionsResponse] = await Promise.all([
          localApi.get<LspResolveState>(`/lsp/resolve?path=${encodeURIComponent(activeFileEditor.path)}`, {
            cache: 'no-store',
          }),
          localApi.get<{ sessions?: LspSessionState[] }>('/lsp/sessions', {
            cache: 'no-store',
          }),
        ])

        if (cancelled) return
        setLspResolveState(resolveResponse)
        setLspSessionsState(Array.isArray(sessionsResponse?.sessions) ? sessionsResponse.sessions : [])
      } catch (error) {
        if (cancelled) return
        setLspStatusError(error instanceof Error ? error.message : 'Failed to load LSP status.')
      } finally {
        if (!cancelled) {
          setLspStatusLoading(false)
        }
      }
    }

    void loadLspStatus()
    const intervalId = window.setInterval(() => {
      void loadLspStatus()
    }, 5000)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [activeFileEditor?.path, isLspStatusPanelOpen, isWeb, lspStatusRefreshNonce])

  useEffect(() => {
    const subscription = onTrackedModelContentChange(({ filePath, content }) => {
      setOpenFileEditors(prev => {
        let changed = false
        const nextEditors = prev.map(editor => {
          if (editor.path !== filePath || editor.content === content) {
            return editor
          }
          changed = true
          return {
            ...editor,
            content,
          }
        })

        return changed ? nextEditors : prev
      })
    })

    return () => {
      subscription.dispose()
    }
  }, [])

  useEffect(() => {
    return () => {
      for (const editor of openFileEditorsRef.current) {
        releaseModel(editor.path)
        void lspClientPool.didCloseDocument(editor.path)
      }
    }
  }, [])

  const maxResizableSidebarWidth = useMemo(() => {
    if (parentContainerWidth == null || parentContainerWidth <= 0) return RIGHT_BAR_MAX_WIDTH_PX

    return Math.max(
      RIGHT_BAR_MIN_WIDTH_PX,
      Math.min(RIGHT_BAR_MAX_WIDTH_PX, parentContainerWidth - DOCKED_CHAT_MIN_WIDTH_PX)
    )
  }, [parentContainerWidth])
  const resolvedRightBarWidth = useMemo(
    () =>
      Math.min(maxResizableSidebarWidth, Math.max(RIGHT_BAR_MIN_WIDTH_PX, rightBarWidth || RIGHT_BAR_DEFAULT_WIDTH_PX)),
    [maxResizableSidebarWidth, rightBarWidth]
  )
  const dockedSidebarPanelWidth = resolvedRightBarWidth
  const maxDockOverlayWidth = useMemo(() => {
    if (parentContainerWidth == null || parentContainerWidth <= 0) return 0

    return Math.max(
      0,
      Math.min(
        parentContainerWidth - resolvedRightBarWidth - DOCKED_LAYOUT_GAP_PX,
        Math.round(parentContainerWidth * DOCKED_TOTAL_WIDTH_RATIO) - resolvedRightBarWidth - DOCKED_LAYOUT_GAP_PX
      )
    )
  }, [parentContainerWidth, resolvedRightBarWidth])
  const minDockOverlayWidth = useMemo(
    () => Math.min(DOCKED_EDITOR_MIN_WIDTH_PX, maxDockOverlayWidth),
    [maxDockOverlayWidth]
  )
  const defaultDockOverlayWidth = useMemo(() => {
    if (maxDockOverlayWidth <= 0) return 0
    return Math.max(minDockOverlayWidth, Math.min(DOCKED_EDITOR_DEFAULT_WIDTH_PX, maxDockOverlayWidth))
  }, [maxDockOverlayWidth, minDockOverlayWidth])
  const shouldMountDockOverlay = hasDockTabs && maxDockOverlayWidth > 0
  const dockOverlayWidthPx = useMemo(() => {
    if (!shouldMountDockOverlay) return 0
    const baseWidth = dockedLayoutWidth == null ? defaultDockOverlayWidth : dockedLayoutWidth
    return Math.max(minDockOverlayWidth, Math.min(maxDockOverlayWidth, Math.round(baseWidth)))
  }, [defaultDockOverlayWidth, dockedLayoutWidth, maxDockOverlayWidth, minDockOverlayWidth, shouldMountDockOverlay])
  const isDockOverlayVisible = isEditorDockOpen && dockOverlayWidthPx > 0
  const asideWidthPx = useMemo(
    () => (isCollapsed ? RIGHT_BAR_COLLAPSED_WIDTH_PX : resolvedRightBarWidth),
    [isCollapsed, resolvedRightBarWidth]
  )

  useEffect(() => {
    const asideElement = asideRef.current
    const parentElement = asideElement?.parentElement
    if (!parentElement) return

    parentContainerRef.current = parentElement

    const updateParentWidth = () => {
      const nextWidth = parentElement.clientWidth || 0
      if (nextWidth <= 0) return
      setParentContainerWidth(currentWidth => (currentWidth === nextWidth ? currentWidth : nextWidth))
    }

    updateParentWidth()

    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => updateParentWidth()) : null

    resizeObserver?.observe(parentElement)
    window.addEventListener('resize', updateParentWidth)

    return () => {
      if (parentContainerRef.current === parentElement) {
        parentContainerRef.current = null
      }
      resizeObserver?.disconnect()
      window.removeEventListener('resize', updateParentWidth)
    }
  }, [])

  useEffect(() => {
    if (!isEditorDockOpen || maxDockOverlayWidth <= 0) return

    setDockedLayoutWidth(currentWidth => {
      const baseWidth = currentWidth == null ? defaultDockOverlayWidth : currentWidth
      const nextWidth = Math.max(minDockOverlayWidth, Math.min(maxDockOverlayWidth, Math.round(baseWidth)))
      return currentWidth === nextWidth ? currentWidth : nextWidth
    })
  }, [defaultDockOverlayWidth, isEditorDockOpen, maxDockOverlayWidth, minDockOverlayWidth])

  useEffect(() => {
    if (!isResizingSidebar) return

    const clampSidebarWidth = (width: number) =>
      Math.max(RIGHT_BAR_MIN_WIDTH_PX, Math.min(maxResizableSidebarWidth, Math.round(width)))

    const handleMove = (clientX: number) => {
      const parentElement = parentContainerRef.current ?? asideRef.current?.parentElement
      if (!parentElement) return

      const rect = parentElement.getBoundingClientRect()
      const nextWidth = clampSidebarWidth(rect.right - clientX)
      dispatch(uiActions.rightBarWidthSet(nextWidth))
    }

    const stopResizing = () => setIsResizingSidebar(false)
    const onMouseMove = (event: MouseEvent) => handleMove(event.clientX)
    const onMouseUp = stopResizing
    const onTouchMove = (event: TouchEvent) => {
      if (!event.touches?.[0]) return
      event.preventDefault()
      handleMove(event.touches[0].clientX)
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
  }, [dispatch, isResizingSidebar, maxResizableSidebarWidth])

  useEffect(() => {
    if (!isResizingDock || maxDockOverlayWidth <= 0) return

    const clampDockWidth = (width: number) =>
      Math.max(minDockOverlayWidth, Math.min(maxDockOverlayWidth, Math.round(width)))

    const handleMove = (clientX: number) => {
      const asideElement = asideRef.current
      if (!asideElement) return

      const asideRect = asideElement.getBoundingClientRect()
      const dockRightEdge = asideRect.left - DOCKED_LAYOUT_GAP_PX
      const nextWidth = clampDockWidth(dockRightEdge - clientX)
      setDockedLayoutWidth(currentWidth => (currentWidth === nextWidth ? currentWidth : nextWidth))
    }

    const stopResizing = () => setIsResizingDock(false)
    const onMouseMove = (event: MouseEvent) => handleMove(event.clientX)
    const onMouseUp = stopResizing
    const onTouchMove = (event: TouchEvent) => {
      if (!event.touches?.[0]) return
      event.preventDefault()
      handleMove(event.touches[0].clientX)
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
  }, [isResizingDock, maxDockOverlayWidth, minDockOverlayWidth])

  // Sync currentPath with ccCwd only when the actual cwd prop changes
  useEffect(() => {
    if (ccCwd && ccCwd !== currentPath) {
      setCurrentPath(ccCwd)
      setPathHistory([])
      setFileSearchQuery('')
      setDebouncedFileSearchQuery('')
    }
    // Intentionally keyed only to ccCwd so folder navigation inside the browser
    // does not get reset back to the root cwd on every currentPath update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ccCwd])

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedFileSearchQuery(fileSearchQuery)
    }, 220)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [fileSearchQuery])

  // Tab state: 'git' for repository tools, 'note' for single conversation note,
  // 'terminal' for terminal management, 'agents' for active stream overview, 'global' for agent (hidden)
  const [activeTab, setActiveTab] = useState<'git' | 'note' | 'terminal' | 'agents' | 'global'>('note')
  const gitBasePath = currentPath || ccCwd || null
  const isGitTabAvailable = !isWeb
  const [selectedGitDiff, setSelectedGitDiff] = useState<{
    relativePath: string
    staged: boolean
    untracked: boolean
  } | null>(null)
  const [pendingWorkspaceMutationDiffRequest, setPendingWorkspaceMutationDiffRequest] =
    useState<WorkspaceMutationDiffRequest | null>(null)
  const [gitActionFeedback, setGitActionFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(
    null
  )
  const [newGitBranchName, setNewGitBranchName] = useState('')
  const {
    data: gitOverviewData,
    isLoading: isLoadingGitOverview,
    isFetching: isFetchingGitOverview,
    refetch: refetchGitOverview,
  } = useGitOverview(gitBasePath, isGitTabAvailable && activeTab === 'git' && !isCollapsed)
  const selectedGitStatusFile = useMemo(
    () => gitOverviewData?.status.all.find(file => file.relativePath === selectedGitDiff?.relativePath) ?? null,
    [gitOverviewData?.status.all, selectedGitDiff?.relativePath]
  )
  const shouldLoadGitDiff =
    isGitTabAvailable && !isCollapsed && !!gitBasePath && !!activeGitDiffTab?.relativePath && !!activeDockTabId
  const {
    data: gitDiffData,
    isLoading: isLoadingGitDiff,
    isFetching: isFetchingGitDiff,
  } = useGitDiff(gitBasePath, activeGitDiffTab?.relativePath, Boolean(activeGitDiffTab?.staged), shouldLoadGitDiff)
  const gitStageFilesMutation = useGitStageFiles()
  const gitUnstageFilesMutation = useGitUnstageFiles()
  const gitCheckoutBranchMutation = useGitCheckoutBranch()
  const gitCreateBranchMutation = useGitCreateBranch()

  // Local note state for debounced updates
  const [localNote, setLocalNote] = useState('')
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Global agent state
  const [agentState, setAgentState] = useState<GlobalAgentState>(globalAgentLoop.getState())
  const [agentSettingsName, setAgentSettingsName] = useState<string>('Global Agent')
  const [agentWorkDirectory, setAgentWorkDirectory] = useState<string | null>(null)
  const [agentInput, setAgentInput] = useState<string>('')
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false)
  const [scheduleModalTab, setScheduleModalTab] = useState<'schedule' | 'queue'>('schedule')
  const [removingTaskId, setRemovingTaskId] = useState<string | null>(null)
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [scheduleDraft, setScheduleDraft] = useState<AgentScheduleDraft>({
    preset: 'hourly',
    repeatCount: 1,
    intervalValue: 1,
    intervalUnit: 'hours',
    startDate: '',
    endDate: '',
    allowedWeekdays: [...ALL_WEEKDAYS],
  })
  const [streamHistory, setStreamHistory] = useState<AgentStreamListItem[]>([])
  const previousActiveStreamIdsRef = useRef<Set<string>>(new Set())

  // Use React Query hooks for agent messages
  const { data: agentData } = useGlobalAgentMessages()
  const agentMessages = agentData?.messages || []
  const agentConversationDate = agentData?.conversationDate
    ? new Date(agentData.conversationDate).toLocaleDateString()
    : null

  // Subscribe to live streaming updates (triggers re-render on stream buffer changes)
  const agentStreamBuffer = useGlobalAgentStreamBuffer()
  const optimisticMessage = useGlobalAgentOptimisticMessage()
  const isAgentStreaming = Boolean(agentStreamBuffer) || Boolean(agentState.streamId)
  const scheduleModalVisible = scheduleModalOpen && !isCollapsed && activeTab === 'global'
  const {
    data: queuedTasksData,
    isLoading: isLoadingQueuedTasks,
    isFetching: isFetchingQueuedTasks,
  } = useGlobalAgentQueuedTasks(scheduleModalVisible)
  const removeQueuedTaskMutation = useRemoveGlobalAgentQueuedTask()
  const queuedTasks = queuedTasksData?.tasks || []

  const parseJsonSafe = useCallback(<T,>(value: any, fallback: T): T => {
    if (!value) return fallback
    if (typeof value === 'object') return value as T
    if (typeof value !== 'string') return fallback
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }, [])

  // Normalize content blocks to handle both old format (text) and new format (content)
  const normalizeContentBlocks = useCallback((blocks: any[]): any[] => {
    return blocks.map((block, idx) => {
      if (block.type === 'text') {
        return {
          ...block,
          index: block.index ?? idx,
          content: block.content ?? block.text ?? '', // Handle both formats
        }
      }
      return { ...block, index: block.index ?? idx }
    })
  }, [])

  const mergedAgentMessages = useMemo(() => {
    if (!agentMessages.length) return []

    const merged: any[] = []
    const toolUseIndex = new Map<string, number>()

    const parseBlocks = (value: any): any[] => {
      const parsed = parseJsonSafe<any[]>(value, [])
      return Array.isArray(parsed) ? parsed : []
    }

    const registerToolUses = (blocks: any[], index: number) => {
      blocks.forEach(block => {
        if (block?.type === 'tool_use') {
          const id = block.id || block.tool_use_id
          if (typeof id === 'string' && id.length > 0) {
            toolUseIndex.set(id, index)
          }
        }
      })
    }

    const registerToolCalls = (toolCallsValue: any, index: number) => {
      const toolCalls = parseJsonSafe<any[]>(toolCallsValue, [])
      if (!Array.isArray(toolCalls)) return
      toolCalls.forEach(call => {
        if (typeof call?.id === 'string' && call.id.length > 0) {
          toolUseIndex.set(call.id, index)
        }
      })
    }

    agentMessages.forEach(message => {
      const role = message.role
      const contentBlocks = parseBlocks(message.content_blocks)

      if (role === 'tool') {
        const toolCallId =
          typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0
            ? message.tool_call_id
            : contentBlocks.find(block => block?.type === 'tool_result' && block.tool_use_id)?.tool_use_id

        if (toolCallId && toolUseIndex.has(toolCallId)) {
          const targetIndex = toolUseIndex.get(toolCallId)!
          const target = merged[targetIndex]
          if (target) {
            const targetBlocks = parseBlocks(target.content_blocks)
            const mergedBlocks = [...targetBlocks, ...contentBlocks]
            target.content_blocks = mergedBlocks
          }
          return
        }
      }

      const nextMessage = { ...message, content_blocks: contentBlocks }
      merged.push(nextMessage)

      const mergedIndex = merged.length - 1
      registerToolUses(contentBlocks, mergedIndex)
      registerToolCalls(message.tool_calls, mergedIndex)
    })

    return merged
  }, [agentMessages, parseJsonSafe])

  const handleOpenToolHtmlModal = useCallback(
    (key?: string) => {
      htmlRegistry?.openModal(key)
    },
    [htmlRegistry]
  )
  const openToolHtmlModal = htmlRegistry ? handleOpenToolHtmlModal : undefined

  // Get conversation data using selector
  const conversation = useSelector(conversationId ? makeSelectConversationById(conversationId) : () => null)
  const conversations = useSelector((state: RootState) => state.conversations.items)
  const streamingRoot = useSelector((state: RootState) => state.chat.streaming)

  const summarizeId = useCallback((value: string | null | undefined) => {
    if (!value) return '—'
    return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value
  }, [])

  const getActivityBadgeClasses = useCallback((kind: AgentStreamActivityKind): string => {
    if (kind === 'tool_call' || kind === 'tool_result') {
      return 'rounded-full border border-violet-300/70 dark:border-violet-500/50 bg-violet-50 dark:bg-violet-500/10 text-violet-700 dark:text-violet-200 px-2 py-0.5'
    }
    if (kind === 'reasoning') {
      return 'rounded-full border border-sky-300/70 dark:border-sky-500/50 bg-sky-50 dark:bg-sky-500/10 text-sky-700 dark:text-sky-200 px-2 py-0.5'
    }
    if (kind === 'text') {
      return 'rounded-full border border-emerald-300/70 dark:border-emerald-500/50 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-200 px-2 py-0.5'
    }
    if (kind === 'image') {
      return 'rounded-full border border-fuchsia-300/70 dark:border-fuchsia-500/50 bg-fuchsia-50 dark:bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-200 px-2 py-0.5'
    }
    return 'rounded-full border border-neutral-200 dark:border-neutral-700 px-2 py-0.5'
  }, [])

  const notesByConversationId = useMemo(() => {
    const map = new Map<string, ResearchNoteItem>()
    for (const note of notes) {
      map.set(String(note.id), note)
    }
    return map
  }, [notes])

  const conversationsById = useMemo(() => {
    const map = new Map<string, Conversation>()
    for (const item of conversations) {
      map.set(String(item.id), item)
    }
    return map
  }, [conversations])

  const getStreamActivity = useCallback(
    (stream: StreamState): { activityKind: AgentStreamActivityKind; activityLabel: string } => {
      if (Array.isArray(stream.events) && stream.events.length > 0) {
        for (let index = stream.events.length - 1; index >= 0; index -= 1) {
          const event = stream.events[index]
          if (!event) continue

          if (event.type === 'tool_call') {
            const toolName = event.toolCall?.name || stream.toolCalls[stream.toolCalls.length - 1]?.name || 'tool'
            return {
              activityKind: 'tool_call',
              activityLabel: `tool: ${toolName}`,
            }
          }

          if (event.type === 'tool_result') {
            const matchingTool = stream.toolCalls.find(toolCall => toolCall.id === event.toolResult?.tool_use_id)
            return {
              activityKind: 'tool_result',
              activityLabel: matchingTool?.name ? `result: ${matchingTool.name}` : 'tool result',
            }
          }

          if (event.type === 'reasoning') {
            return { activityKind: 'reasoning', activityLabel: 'reasoning' }
          }

          if (event.type === 'text') {
            return { activityKind: 'text', activityLabel: 'text' }
          }

          if (event.type === 'image') {
            return { activityKind: 'image', activityLabel: 'image' }
          }
        }
      }

      if (stream.toolCalls.length > 0) {
        const latestTool = stream.toolCalls[stream.toolCalls.length - 1]
        return {
          activityKind: 'tool_call',
          activityLabel: `tool: ${latestTool?.name || 'tool'}`,
        }
      }

      if (stream.thinkingBuffer.trim().length > 0) {
        return { activityKind: 'reasoning', activityLabel: 'reasoning' }
      }

      if (stream.buffer.trim().length > 0) {
        return { activityKind: 'text', activityLabel: 'text' }
      }

      return { activityKind: 'idle', activityLabel: 'starting' }
    },
    []
  )

  const buildAgentStreamListItem = useCallback(
    (streamId: string, stream: StreamState, completedAt: string | null = null): AgentStreamListItem => {
      const streamConversationId = stream.conversationId ? String(stream.conversationId) : null
      const convo = streamConversationId ? conversationsById.get(streamConversationId) : null
      const note = streamConversationId ? notesByConversationId.get(streamConversationId) : null
      const anchorMessageId =
        stream.streamingMessageId ||
        stream.messageId ||
        stream.lineage.originMessageId ||
        stream.lineage.rootMessageId ||
        null
      const { activityKind, activityLabel } = getStreamActivity(stream)

      return {
        streamId,
        streamType: stream.streamType,
        conversationId: streamConversationId,
        projectId: convo?.project_id ? String(convo.project_id) : note?.project_id ? String(note.project_id) : null,
        conversationTitle:
          convo?.title || note?.title || (streamConversationId ? `Conversation ${streamConversationId}` : null),
        anchorMessageId: anchorMessageId ? String(anchorMessageId) : null,
        hasError: Boolean(stream.error),
        createdAt: stream.createdAt,
        rootMessageId: stream.lineage.rootMessageId ? String(stream.lineage.rootMessageId) : null,
        activityKind,
        activityLabel,
        completedAt,
      }
    },
    [conversationsById, getStreamActivity, notesByConversationId]
  )

  const activeStreams = useMemo(() => {
    const items: AgentStreamListItem[] = []

    for (const streamId of streamingRoot.activeIds) {
      const stream = streamingRoot.byId[streamId]
      if (!stream || !stream.active) continue
      items.push(buildAgentStreamListItem(streamId, stream, null))
    }

    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }, [buildAgentStreamListItem, streamingRoot.activeIds, streamingRoot.byId])

  useEffect(() => {
    const currentActiveIds = new Set<string>()

    for (const streamId of streamingRoot.activeIds) {
      const stream = streamingRoot.byId[streamId]
      if (stream?.active) {
        currentActiveIds.add(streamId)
      }
    }

    const completedItems: AgentStreamListItem[] = []

    previousActiveStreamIdsRef.current.forEach(streamId => {
      if (currentActiveIds.has(streamId)) return
      const stream = streamingRoot.byId[streamId]
      if (!stream) return
      completedItems.push(buildAgentStreamListItem(streamId, stream, new Date().toISOString()))
    })

    if (completedItems.length > 0) {
      setStreamHistory(previous => {
        const incomingById = new Map(completedItems.map(item => [item.streamId, item]))
        const merged = [...completedItems, ...previous.filter(item => !incomingById.has(item.streamId))]
        return merged
          .sort((a, b) => (b.completedAt || b.createdAt).localeCompare(a.completedAt || a.createdAt))
          .slice(0, 40)
      })
    }

    previousActiveStreamIdsRef.current = currentActiveIds
  }, [buildAgentStreamListItem, streamingRoot.activeIds, streamingRoot.byId])

  const handleActiveStreamClick = useCallback(
    (item: (typeof activeStreams)[number]) => {
      if (!item.conversationId) return
      const projectSegment = item.projectId ? String(item.projectId) : 'unknown'
      const hash = item.anchorMessageId ? `#${item.anchorMessageId}` : ''
      navigate(`/chat/${projectSegment}/${item.conversationId}${hash}`)
    },
    [navigate]
  )

  // Initialize local note from conversation data
  useEffect(() => {
    if (conversation?.research_note !== undefined) {
      setLocalNote(conversation.research_note || '')
    }
  }, [conversation?.research_note])

  useEffect(() => {
    if (isWeb) return
    let mounted = true

    loadAgentSettings()
      .then(settings => {
        if (!mounted) return
        setAgentSettingsName(settings.agentName || 'Global Agent')
        setAgentWorkDirectory(settings.workDirectory || null)
      })
      .catch(error => {
        console.error('Failed to load agent settings:', error)
      })

    const handleAgentSettingsChange = (event: CustomEvent<AgentSettings>) => {
      if (!mounted) return
      setAgentSettingsName(event.detail.agentName || 'Global Agent')
      setAgentWorkDirectory(event.detail.workDirectory || null)
    }

    window.addEventListener(AGENT_SETTINGS_CHANGE_EVENT, handleAgentSettingsChange as EventListener)

    // Subscribe to agent state changes only
    // Stream and message events now update React Query cache directly in GlobalAgentLoop
    const unsubscribe = globalAgentLoop.on(event => {
      if (!mounted) return
      if (event.type === 'state') {
        setAgentState(event.state)
      }
      // Note: stream and message events are handled by GlobalAgentLoop updating the cache
      // No need to manually refetch or update state here
    })

    return () => {
      mounted = false
      window.removeEventListener(AGENT_SETTINGS_CHANGE_EVENT, handleAgentSettingsChange as EventListener)
      unsubscribe()
    }
  }, [])

  // Debounced update function
  const debouncedUpdate = useCallback(
    (note: string) => {
      if (!conversationId) return

      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current)
      }

      debounceTimeoutRef.current = setTimeout(() => {
        dispatch(updateResearchNote({ id: conversationId, researchNote: note }) as any)
          .unwrap()
          .then(() => {
            const projectId = conversation?.project_id

            // Update all conversations cache
            const conversationsCache = queryClient.getQueryData<Conversation[]>(['conversations'])
            if (conversationsCache) {
              queryClient.setQueryData(
                ['conversations'],
                conversationsCache.map(conv => (conv.id === conversationId ? { ...conv, research_note: note } : conv))
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
                    conv.id === conversationId ? { ...conv, research_note: note } : conv
                  )
                )
              }
            }

            // Update recent conversations cache
            const recentCache = queryClient.getQueryData<Conversation[]>(['conversations', 'recent'])
            if (recentCache) {
              queryClient.setQueryData(
                ['conversations', 'recent'],
                recentCache.map(conv => (conv.id === conversationId ? { ...conv, research_note: note } : conv))
              )
            }

            // Update research notes cache
            const researchNotesCache = queryClient.getQueryData<ResearchNoteItem[]>(['research-notes', userId])
            if (researchNotesCache) {
              if (!note || note.trim().length === 0) {
                queryClient.setQueryData(
                  ['research-notes', userId],
                  researchNotesCache.filter(item => item.id !== conversationId)
                )
              } else {
                const existingIndex = researchNotesCache.findIndex(item => item.id === conversationId)
                if (existingIndex >= 0) {
                  queryClient.setQueryData(
                    ['research-notes', userId],
                    researchNotesCache.map(item =>
                      item.id === conversationId
                        ? {
                            ...item,
                            research_note: note,
                            updated_at: new Date().toISOString(),
                          }
                        : item
                    )
                  )
                } else {
                  queryClient.setQueryData(
                    ['research-notes', userId],
                    [
                      {
                        id: conversationId,
                        title: conversation?.title || `Conversation ${conversationId}`,
                        research_note: note,
                        updated_at: new Date().toISOString(),
                        project_id: conversation?.project_id || null,
                      },
                      ...researchNotesCache,
                    ]
                  )
                }
              }
            }
          })
          .catch((error: unknown) => {
            console.error('Failed to update research note:', error)
          })
      }, 1000)
    },
    [conversationId, conversation?.project_id, conversation?.title, dispatch, queryClient, userId]
  )

  // Handle text change
  const handleNoteChange = useCallback(
    (value: string) => {
      setLocalNote(value)
      debouncedUpdate(value)
    },
    [debouncedUpdate]
  )

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current)
      }
    }
  }, [])

  const toggleCollapse = () => {
    if (!isCollapsed && !confirmCollapseDirtyEditors()) return
    dispatch(uiActions.rightBarToggled())
  }

  const beginSidebarResize = useCallback(() => {
    if (isCollapsed) {
      dispatch(uiActions.rightBarWidthSet(resolvedRightBarWidth))
      dispatch(uiActions.rightBarExpanded())
    }

    setIsResizingSidebar(true)
  }, [dispatch, isCollapsed, resolvedRightBarWidth])

  const handleSidebarResizeMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()
      beginSidebarResize()
    },
    [beginSidebarResize]
  )

  const handleSidebarResizeTouchStart = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()
      beginSidebarResize()
    },
    [beginSidebarResize]
  )

  const beginDockResize = useCallback(() => {
    if (!isEditorDockOpen || maxDockOverlayWidth <= 0) return
    setIsResizingDock(true)
  }, [isEditorDockOpen, maxDockOverlayWidth])

  const handleDockResizeMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()
      beginDockResize()
    },
    [beginDockResize]
  )

  const handleDockResizeTouchStart = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()
      beginDockResize()
    },
    [beginDockResize]
  )

  // const handleNoteClick = (noteItem: ResearchNoteItem) => {
  //   navigate(`/chat/${noteItem.project_id || 'unknown'}/${noteItem.id}`)
  // }

  // File browser navigation
  const handleFileClick = (file: DirectoryFileEntry) => {
    if (!file.isDirectory) return

    setPathHistory(prev => (currentPath && currentPath !== file.path ? [...prev, currentPath] : prev))
    setCurrentPath(file.path)
    setFileSearchQuery('')
    setDebouncedFileSearchQuery('')
  }

  const handleGoBack = () => {
    if (pathHistory.length > 0) {
      const previousPath = pathHistory[pathHistory.length - 1]
      setPathHistory(prev => prev.slice(0, -1))
      setCurrentPath(previousPath)
    } else if (ccCwd) {
      setCurrentPath(ccCwd)
    }
  }

  const handleGoToRoot = () => {
    if (ccCwd) {
      setCurrentPath(ccCwd)
      setPathHistory([])
    }
  }

  const handleClearFileSearch = () => {
    setFileSearchQuery('')
    setDebouncedFileSearchQuery('')
  }

  const getFileName = useCallback((filePath: string) => {
    const normalized = filePath.replace(/\\/g, '/')
    const lastSlash = normalized.lastIndexOf('/')
    return lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized
  }, [])

  const getBrowserDisplayLabel = useCallback((url: string) => {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./i, '').trim()
      return hostname || 'Browser'
    } catch {
      return 'Browser'
    }
  }, [])

  const deriveEditorRelativePath = useCallback(
    (filePath: string, fallbackRelativePath?: string | null) => {
      const normalizedFilePath = filePath.replace(/\\/g, '/')
      const normalizedFallback = (fallbackRelativePath || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\//, '')

      const preferredBasePath = (ccCwd || '').trim()
      if (preferredBasePath) {
        const normalizedBasePath = preferredBasePath.replace(/\\/g, '/').replace(/\/+$/, '')
        const lowerFilePath = normalizedFilePath.toLowerCase()
        const lowerBasePath = normalizedBasePath.toLowerCase()

        if (lowerFilePath === lowerBasePath) {
          return getFileName(normalizedFilePath)
        }

        if (lowerFilePath.startsWith(`${lowerBasePath}/`)) {
          return normalizedFilePath.slice(normalizedBasePath.length + 1)
        }
      }

      if (normalizedFallback) {
        return normalizedFallback
      }

      const currentBasePath = (currentPath || '').trim()
      if (currentBasePath) {
        const normalizedBasePath = currentBasePath.replace(/\\/g, '/').replace(/\/+$/, '')
        const lowerFilePath = normalizedFilePath.toLowerCase()
        const lowerBasePath = normalizedBasePath.toLowerCase()

        if (lowerFilePath === lowerBasePath) {
          return getFileName(normalizedFilePath)
        }

        if (lowerFilePath.startsWith(`${lowerBasePath}/`)) {
          return normalizedFilePath.slice(normalizedBasePath.length + 1)
        }
      }

      return getFileName(normalizedFilePath)
    },
    [ccCwd, currentPath, getFileName]
  )

  const handleMonacoSelectionChange = useCallback(
    (selection: SelectionInfo | null) => {
      console.log('[MonacoIdeSelection][RightBar] selection callback', {
        extensionConnected,
        hasConnectedIdeExtensions,
        hasSelection: Boolean(selection?.selectedText?.trim()),
        filePath: selection?.filePath ?? null,
        relativePath: selection?.relativePath ?? null,
        startLine: selection?.startLine ?? null,
        endLine: selection?.endLine ?? null,
        preview: selection?.selectedText?.slice(0, 120) ?? null,
      })

      if (extensionConnected || hasConnectedIdeExtensions) {
        console.log('[MonacoIdeSelection][RightBar] blocked dispatch because IDE extension is considered connected', {
          extensionConnected,
          hasConnectedIdeExtensions,
        })
        return
      }

      console.log('[MonacoIdeSelection][RightBar] dispatch setCurrentSelection', {
        hasSelection: Boolean(selection),
        filePath: selection?.filePath ?? null,
      })
      dispatch(setCurrentSelection(selection))
    },
    [dispatch, extensionConnected, hasConnectedIdeExtensions]
  )

  const appendTerminalHistory = useCallback((existingHistory: string, nextChunk: string) => {
    if (!nextChunk) return existingHistory
    const merged = existingHistory + nextChunk
    return merged.length > TERMINAL_HISTORY_LIMIT ? merged.slice(-TERMINAL_HISTORY_LIMIT) : merged
  }, [])

  useEffect(() => {
    if (isWeb || !window.electronAPI?.terminal) return

    const unsubscribeData = window.electronAPI.terminal.onData(payload => {
      if (!payload?.sessionId || typeof payload.data !== 'string') return
      setOpenTerminalTabs(current =>
        current.map(tab =>
          tab.sessionId !== payload.sessionId
            ? tab
            : {
                ...tab,
                history: appendTerminalHistory(tab.history, payload.data),
                status: tab.status === 'launching' ? 'open' : tab.status,
                error: null,
              }
        )
      )
    })

    const unsubscribeExit = window.electronAPI.terminal.onExit(payload => {
      if (!payload?.sessionId) return
      setOpenTerminalTabs(current =>
        current.map(tab =>
          tab.sessionId !== payload.sessionId
            ? tab
            : {
                ...tab,
                sessionId: null,
                cwd: payload.cwd || tab.cwd,
                shell: payload.shell || tab.shell,
                status: tab.status === 'error' ? 'error' : 'closed',
                exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : null,
              }
        )
      )
    })

    return () => {
      unsubscribeData()
      unsubscribeExit()
    }
  }, [appendTerminalHistory, isWeb])

  useEffect(() => {
    const persistedSessions = openTerminalTabs.map(tab => ({
      id: tab.id,
      cwd: tab.cwd,
      title: tab.title,
      shell: tab.shell,
      history: terminalPreferences.persistHistory ? tab.history : '',
    }))

    saveTerminalDockState({
      preferences: terminalPreferences,
      sessions: persistedSessions,
      activeTerminalTabId: activeDockTabId?.startsWith('terminal:') ? activeDockTabId.slice('terminal:'.length) : null,
    })
  }, [activeDockTabId, openTerminalTabs, terminalPreferences])

  const dockTabs = useMemo(
    () => [
      ...openFileEditors.map(editor => ({
        id: getFileDockTabId(editor.path),
        label: getFileName(editor.path),
        title: editor.path,
        kind: 'file' as const,
        isDirty: editor.content !== editor.savedContent,
        isSaving: editor.saving,
      })),
      ...openGitDiffTabs.map(tab => ({
        id: tab.id,
        label: `${getFileName(tab.path)}${tab.staged ? ' (staged)' : tab.untracked ? ' (new)' : ''}`,
        title: tab.displayPath,
        kind: 'diff' as const,
        isDirty: false,
        isSaving: false,
      })),
      ...openTerminalTabs.map(tab => ({
        id: getTerminalDockTabId(tab.id),
        label: tab.title,
        title: tab.cwd,
        kind: 'terminal' as const,
        isDirty: false,
        isSaving: false,
      })),
      ...openBrowserTabs.map(tab => ({
        id: getBrowserDockTabId(tab.id),
        label: tab.title || getBrowserDisplayLabel(tab.currentUrl || tab.requestedUrl),
        title: tab.currentUrl || tab.requestedUrl,
        kind: 'browser' as const,
        isDirty: false,
        isSaving: false,
      })),
    ],
    [getBrowserDisplayLabel, getFileName, openBrowserTabs, openFileEditors, openGitDiffTabs, openTerminalTabs]
  )

  const buildDockTabIds = useCallback(
    (
      editors: FileEditorState[] = openFileEditors,
      diffTabs: GitDiffTabState[] = openGitDiffTabs,
      terminalTabs: TerminalDockState[] = openTerminalTabs,
      browserTabs: BrowserDockState[] = openBrowserTabs
    ) => [
      ...editors.map(editor => getFileDockTabId(editor.path)),
      ...diffTabs.map(tab => tab.id),
      ...terminalTabs.map(tab => getTerminalDockTabId(tab.id)),
      ...browserTabs.map(tab => getBrowserDockTabId(tab.id)),
    ],
    [openBrowserTabs, openFileEditors, openGitDiffTabs, openTerminalTabs]
  )

  useEffect(() => {
    if (activeDockTabId) return
    if (dockTabs.length === 0) return
    setActiveDockTabId(dockTabs[0].id)
  }, [activeDockTabId, dockTabs])

  useEffect(() => {
    if (!activeDockTabId?.startsWith('file:')) return
    setActiveFileEditorPath(activeDockTabId.slice('file:'.length))
  }, [activeDockTabId])

  const updateOpenFileEditor = useCallback(
    (filePath: string, updater: (editor: FileEditorState) => FileEditorState) => {
      setOpenFileEditors(prev => prev.map(editor => (editor.path === filePath ? updater(editor) : editor)))
    },
    []
  )

  const closeFileEditorResources = useCallback((filePath: string) => {
    releaseModel(filePath)
    void lspClientPool.didCloseDocument(filePath)
  }, [])

  const confirmDiscardSingleEditor = useCallback(
    (filePath: string) => {
      const editor = openFileEditors.find(item => item.path === filePath)
      if (!editor || editor.content === editor.savedContent) return true
      return window.confirm(`Discard unsaved changes in ${getFileName(filePath)}?`)
    },
    [getFileName, openFileEditors]
  )

  const confirmCollapseDirtyEditors = useCallback(() => {
    if (!hasAnyDirtyEditors) return true
    return window.confirm('Collapse the right sidebar while keeping unsaved editor tabs open?')
  }, [hasAnyDirtyEditors])

  const openFileEditor = useCallback(
    async (filePath: string, options?: { relativePath?: string | null }) => {
      if (isWeb || !filePath) return

      const relativePath = deriveEditorRelativePath(filePath, options?.relativePath)
      const existingEditor = openFileEditors.find(editor => editor.path === filePath)
      const languageInfo = resolveLanguageInfo(filePath)
      dispatch(uiActions.rightBarExpanded())
      setActiveFileEditorPath(filePath)
      setActiveDockTabId(getFileDockTabId(filePath))

      if (existingEditor?.relativePath !== relativePath) {
        updateOpenFileEditor(filePath, editor => ({ ...editor, relativePath }))
      }

      if (existingEditor && !existingEditor.loading && !existingEditor.error) {
        return
      }

      if (!existingEditor) {
        retainModel(filePath, '', languageInfo.monacoLanguageId)
        setOpenFileEditors(prev => [
          ...prev,
          {
            path: filePath,
            relativePath,
            content: '',
            savedContent: '',
            loading: true,
            saving: false,
            error: null,
          },
        ])
      } else {
        updateOpenFileEditor(filePath, editor => ({ ...editor, relativePath, loading: true, error: null }))
      }

      const requestId = (fileEditorRequestIdRef.current[filePath] || 0) + 1
      fileEditorRequestIdRef.current[filePath] = requestId

      try {
        const params = new URLSearchParams({ path: filePath })
        const result = await localApi.get<{ path?: string; content?: string; size?: number }>(
          `/local/file-content?${params}`
        )
        if (fileEditorRequestIdRef.current[filePath] !== requestId) return
        const content = typeof result?.content === 'string' ? result.content : ''
        updateOpenFileEditor(filePath, editor => ({
          ...editor,
          content,
          savedContent: content,
          loading: false,
          saving: false,
          error: null,
        }))
        setModelContent(filePath, content)
        void lspClientPool.didOpenDocument(filePath, content)
      } catch (error) {
        if (fileEditorRequestIdRef.current[filePath] !== requestId) return
        updateOpenFileEditor(filePath, editor => ({
          ...editor,
          content: '',
          savedContent: '',
          loading: false,
          saving: false,
          error: error instanceof Error ? error.message : 'Failed to load file',
        }))
      }
    },
    [deriveEditorRelativePath, dispatch, isWeb, openFileEditors, updateOpenFileEditor]
  )

  const handleFileEditorChange = useCallback(
    (nextValue: string) => {
      if (!activeFileEditorPath) return
      updateOpenFileEditor(activeFileEditorPath, editor => ({ ...editor, content: nextValue }))
      void lspClientPool.didChangeDocument(activeFileEditorPath, nextValue)
    },
    [activeFileEditorPath, updateOpenFileEditor]
  )

  const openGitDiffTab = useCallback(
    (file: GitStatusFile, stagedView: boolean) => {
      const nextTab = buildGitDiffDockTabState({
        path: file.path,
        relativePath: file.relativePath,
        displayPath: file.displayPath,
        staged: !file.untracked && stagedView,
        untracked: file.untracked,
        conflicted: file.conflicted,
      })

      dispatch(uiActions.rightBarExpanded())
      setOpenGitDiffTabs(prev => (prev.some(tab => tab.id === nextTab.id) ? prev : [...prev, nextTab]))
      setActiveDockTabId(nextTab.id)
    },
    [dispatch]
  )

  useEffect(() => {
    const handleOpenWorkspaceMutationDiffs = (event: CustomEvent<OpenWorkspaceMutationDiffsDetail>) => {
      if (isWeb) return

      const filePaths = Array.isArray(event.detail?.filePaths)
        ? event.detail.filePaths.map(path => String(path || '').trim()).filter(Boolean)
        : []
      if (filePaths.length === 0) return

      const nextBasePath =
        typeof event.detail?.basePath === 'string' && event.detail.basePath.trim().length > 0
          ? event.detail.basePath.trim()
          : null

      if (nextBasePath && nextBasePath !== currentPath) {
        setCurrentPath(nextBasePath)
        setPathHistory([])
        setFileSearchQuery('')
        setDebouncedFileSearchQuery('')
      }

      setGitActionFeedback(null)
      setActiveTab('git')
      dispatch(uiActions.rightBarExpanded())
      setPendingWorkspaceMutationDiffRequest({
        filePaths,
        basePath: nextBasePath,
        focusPath:
          typeof event.detail?.focusPath === 'string' && event.detail.focusPath.trim().length > 0
            ? event.detail.focusPath.trim()
            : filePaths[0] || null,
      })
    }

    window.addEventListener(OPEN_WORKSPACE_MUTATION_DIFFS_EVENT, handleOpenWorkspaceMutationDiffs as EventListener)
    return () => {
      window.removeEventListener(OPEN_WORKSPACE_MUTATION_DIFFS_EVENT, handleOpenWorkspaceMutationDiffs as EventListener)
    }
  }, [currentPath, dispatch, isWeb])

  useEffect(() => {
    if (!pendingWorkspaceMutationDiffRequest) return
    if (isWeb || isCollapsed || activeTab !== 'git') return
    if (isLoadingGitOverview || isFetchingGitOverview) return

    const tabsToOpen = resolveWorkspaceMutationDiffTabs(
      pendingWorkspaceMutationDiffRequest,
      gitOverviewData?.status.all || []
    )

    if (tabsToOpen.length === 0) {
      setGitActionFeedback({
        type: 'error',
        message: 'No Git diffs were available for the branch-modified files.',
      })
      setPendingWorkspaceMutationDiffRequest(null)
      return
    }

    const focusKey = pendingWorkspaceMutationDiffRequest.focusPath
      ? normalizePathForCompare(pendingWorkspaceMutationDiffRequest.focusPath)
      : ''
    const focusRelativeKey = pendingWorkspaceMutationDiffRequest.focusPath
      ? normalizeRelativeGitPath(pendingWorkspaceMutationDiffRequest.focusPath).toLowerCase()
      : ''
    const focusedTab =
      tabsToOpen.find(
        tab =>
          normalizePathForCompare(tab.path) === focusKey ||
          normalizeRelativeGitPath(tab.relativePath).toLowerCase() === focusRelativeKey ||
          normalizeRelativeGitPath(tab.displayPath).toLowerCase() === focusRelativeKey
      ) || tabsToOpen[0]

    setOpenGitDiffTabs(prev => {
      const nextTabs = [...prev]
      const existingTabIds = new Set(prev.map(tab => tab.id))
      for (const tab of tabsToOpen) {
        if (existingTabIds.has(tab.id)) continue
        existingTabIds.add(tab.id)
        nextTabs.push(tab)
      }
      return nextTabs
    })
    setActiveDockTabId(focusedTab.id)
    setPendingWorkspaceMutationDiffRequest(null)
  }, [
    activeTab,
    gitOverviewData?.status.all,
    isCollapsed,
    isFetchingGitOverview,
    isLoadingGitOverview,
    isWeb,
    pendingWorkspaceMutationDiffRequest,
  ])

  const getTerminalLaunchCwd = useCallback(() => (currentPath || ccCwd || '').trim(), [ccCwd, currentPath])

  const createTerminalStateId = useCallback(
    () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    []
  )

  const createBrowserStateId = useCallback(
    () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    []
  )

  const updateBrowserDock = useCallback((browserId: string, updates: Partial<BrowserDockState>) => {
    setOpenBrowserTabs(current => current.map(tab => (tab.id === browserId ? { ...tab, ...updates } : tab)))
  }, [])

  const openBrowserDock = useCallback(
    (initialUrl: string = DEFAULT_BROWSER_HOME_URL) => {
      if (isWeb) return

      const browserId = createBrowserStateId()
      const nextTab: BrowserDockState = {
        id: browserId,
        title: getBrowserDisplayLabel(initialUrl),
        requestedUrl: initialUrl,
        currentUrl: initialUrl,
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        lastError: null,
      }

      setOpenBrowserTabs(current => [...current, nextTab])
      dispatch(uiActions.rightBarExpanded())
      setActiveDockTabId(getBrowserDockTabId(browserId))
    },
    [createBrowserStateId, dispatch, getBrowserDisplayLabel, isWeb]
  )

  const launchTerminalDock = useCallback(
    async (
      targetCwd?: string,
      options?: {
        terminalId?: string
        activate?: boolean
        preservedHistory?: string
        title?: string
      }
    ) => {
      if (isWeb || !window.electronAPI?.terminal) return

      const cwd = (targetCwd || currentPath || ccCwd || '').trim()
      const terminalId = options?.terminalId || createTerminalStateId()
      const activate = options?.activate ?? true
      const existingTab = openTerminalTabs.find(tab => tab.id === terminalId) ?? null

      if (!cwd) {
        const errorTab: TerminalDockState = {
          id: terminalId,
          sessionId: null,
          cwd: '',
          shell: '',
          title: options?.title || existingTab?.title || 'Terminal',
          history: options?.preservedHistory || existingTab?.history || '',
          status: 'error',
          error: 'No working directory selected for terminal',
          exitCode: null,
        }
        setOpenTerminalTabs(current =>
          current.some(tab => tab.id === terminalId)
            ? current.map(tab => (tab.id === terminalId ? errorTab : tab))
            : [...current, errorTab]
        )
        if (activate) {
          dispatch(uiActions.rightBarExpanded())
          setActiveDockTabId(getTerminalDockTabId(terminalId))
        }
        return
      }

      if (existingTab?.sessionId && existingTab.cwd === cwd && existingTab.status === 'open') {
        if (activate) {
          dispatch(uiActions.rightBarExpanded())
          setActiveDockTabId(getTerminalDockTabId(terminalId))
        }
        return
      }

      const title = options?.title || existingTab?.title || getFileName(cwd) || 'Terminal'
      const requestId = (terminalLaunchRequestIdRef.current[terminalId] || 0) + 1
      terminalLaunchRequestIdRef.current[terminalId] = requestId

      const nextTab: TerminalDockState = {
        id: terminalId,
        sessionId: null,
        cwd,
        shell: existingTab?.shell || '',
        title,
        history: options?.preservedHistory ?? existingTab?.history ?? '',
        status: 'launching',
        error: null,
        exitCode: null,
      }

      setOpenTerminalTabs(current =>
        current.some(tab => tab.id === terminalId)
          ? current.map(tab => (tab.id === terminalId ? nextTab : tab))
          : [...current, nextTab]
      )

      if (activate) {
        dispatch(uiActions.rightBarExpanded())
        setActiveDockTabId(getTerminalDockTabId(terminalId))
      }

      if (existingTab?.sessionId) {
        try {
          await window.electronAPI.terminal.kill(existingTab.sessionId)
        } catch {
          // Ignore stale-session kill failures during restart.
        }
      }

      try {
        const result = await window.electronAPI.terminal.create({
          cwd,
          cols: 120,
          rows: 32,
          title,
        })

        if (terminalLaunchRequestIdRef.current[terminalId] !== requestId) {
          if (result?.sessionId) {
            void window.electronAPI.terminal.kill(result.sessionId)
          }
          return
        }

        if (!result?.success || !result.sessionId) {
          throw new Error(result?.error || 'Failed to start terminal session')
        }

        setOpenTerminalTabs(current =>
          current.map(tab =>
            tab.id !== terminalId
              ? tab
              : {
                  ...tab,
                  sessionId: result.sessionId,
                  cwd: result.cwd || cwd,
                  shell: result.shell || '',
                  title: result.title || title,
                  status: 'open',
                  error: null,
                  exitCode: null,
                }
          )
        )
      } catch (error) {
        if (terminalLaunchRequestIdRef.current[terminalId] !== requestId) return
        setOpenTerminalTabs(current =>
          current.map(tab =>
            tab.id !== terminalId
              ? tab
              : {
                  ...tab,
                  sessionId: null,
                  cwd,
                  shell: tab.shell || '',
                  title,
                  status: 'error',
                  error: error instanceof Error ? error.message : 'Failed to start terminal session',
                  exitCode: null,
                }
          )
        )
      }
    },
    [ccCwd, createTerminalStateId, currentPath, dispatch, getFileName, isWeb, openTerminalTabs]
  )

  useEffect(() => {
    if (isWeb || !terminalPreferences.restoreSessionsOnLaunch || !window.electronAPI?.terminal) return

    for (const tab of openTerminalTabs) {
      if (!initialTerminalDockState.sessions.some(session => session.id === tab.id)) continue
      if (restoredTerminalTabsRef.current.has(tab.id)) continue
      restoredTerminalTabsRef.current.add(tab.id)
      void launchTerminalDock(tab.cwd, {
        terminalId: tab.id,
        activate: activeDockTabId === getTerminalDockTabId(tab.id),
        preservedHistory: terminalPreferences.persistHistory ? tab.history : '',
        title: tab.title,
      })
    }
  }, [
    activeDockTabId,
    initialTerminalDockState.sessions,
    isWeb,
    launchTerminalDock,
    openTerminalTabs,
    terminalPreferences,
  ])

  const handleTerminalInput = useCallback(
    (data: string) => {
      if (isWeb || !activeTerminalDock?.sessionId || !window.electronAPI?.terminal) return
      void window.electronAPI.terminal.write(activeTerminalDock.sessionId, data)
    },
    [activeTerminalDock?.sessionId, isWeb]
  )

  const handleTerminalResize = useCallback(
    (cols: number, rows: number) => {
      if (isWeb || !activeTerminalDock?.sessionId || !window.electronAPI?.terminal) return
      void window.electronAPI.terminal.resize(activeTerminalDock.sessionId, cols, rows)
    },
    [activeTerminalDock?.sessionId, isWeb]
  )

  const clearTerminalDockBuffer = useCallback((terminalId: string) => {
    setOpenTerminalTabs(current => current.map(tab => (tab.id === terminalId ? { ...tab, history: '' } : tab)))
  }, [])

  const restartTerminalDock = useCallback(
    (terminalId: string) => {
      const target = openTerminalTabs.find(tab => tab.id === terminalId)
      void launchTerminalDock(target?.cwd || getTerminalLaunchCwd(), {
        terminalId,
        preservedHistory: terminalPreferences.persistHistory ? target?.history || '' : '',
        title: target?.title,
      })
    },
    [getTerminalLaunchCwd, launchTerminalDock, openTerminalTabs, terminalPreferences.persistHistory]
  )

  const openNewTerminalDock = useCallback(
    (targetCwd?: string) => {
      setActiveTab('terminal')
      void launchTerminalDock(targetCwd || getTerminalLaunchCwd())
    },
    [getTerminalLaunchCwd, launchTerminalDock]
  )

  const selectDockTab = useCallback((tabId: string) => {
    setActiveDockTabId(tabId)
    if (tabId.startsWith('file:')) {
      const nextPath = tabId.slice('file:'.length)
      setActiveFileEditorPath(nextPath)
      return
    }
    if (tabId.startsWith('terminal:')) {
      setActiveTab('terminal')
    }
  }, [])

  const closeFileEditorTab = useCallback(
    (filePath: string) => {
      const tabIndex = openFileEditors.findIndex(editor => editor.path === filePath)
      if (tabIndex === -1) return
      if (!confirmDiscardSingleEditor(filePath)) return

      fileEditorRequestIdRef.current[filePath] = (fileEditorRequestIdRef.current[filePath] || 0) + 1
      closeFileEditorResources(filePath)
      const remainingEditors = openFileEditors.filter(editor => editor.path !== filePath)
      const removedTabId = getFileDockTabId(filePath)
      setOpenFileEditors(remainingEditors)
      setActiveFileEditorPath(currentActive => {
        if (currentActive !== filePath) return currentActive
        const fallbackIndex = Math.min(tabIndex, remainingEditors.length - 1)
        return fallbackIndex >= 0 ? (remainingEditors[fallbackIndex]?.path ?? null) : null
      })
      setActiveDockTabId(currentActive => {
        if (currentActive !== removedTabId) return currentActive
        const remainingDockTabs = buildDockTabIds(remainingEditors, openGitDiffTabs, openTerminalTabs, openBrowserTabs)
        const fallbackIndex = Math.min(tabIndex, remainingDockTabs.length - 1)
        return fallbackIndex >= 0 ? (remainingDockTabs[fallbackIndex] ?? null) : null
      })
    },
    [
      buildDockTabIds,
      closeFileEditorResources,
      confirmDiscardSingleEditor,
      openBrowserTabs,
      openFileEditors,
      openGitDiffTabs,
      openTerminalTabs,
    ]
  )

  const closeGitDiffTab = useCallback(
    (tabId: string) => {
      const tabIndex = openGitDiffTabs.findIndex(tab => tab.id === tabId)
      if (tabIndex === -1) return
      const remainingDiffTabs = openGitDiffTabs.filter(tab => tab.id !== tabId)
      setOpenGitDiffTabs(remainingDiffTabs)
      setActiveDockTabId(currentActive => {
        if (currentActive !== tabId) return currentActive
        const remainingDockTabs = buildDockTabIds(openFileEditors, remainingDiffTabs, openTerminalTabs, openBrowserTabs)
        const fallbackIndex = Math.min(openFileEditors.length + tabIndex, remainingDockTabs.length - 1)
        return fallbackIndex >= 0 ? (remainingDockTabs[fallbackIndex] ?? null) : null
      })
    },
    [buildDockTabIds, openBrowserTabs, openFileEditors, openGitDiffTabs, openTerminalTabs]
  )

  const closeTerminalDock = useCallback(
    (terminalId: string) => {
      terminalLaunchRequestIdRef.current[terminalId] = (terminalLaunchRequestIdRef.current[terminalId] || 0) + 1
      const target = openTerminalTabs.find(tab => tab.id === terminalId)
      if (target?.sessionId && window.electronAPI?.terminal) {
        void window.electronAPI.terminal.kill(target.sessionId)
      }

      const removedTabId = getTerminalDockTabId(terminalId)
      const remainingTerminals = openTerminalTabs.filter(tab => tab.id !== terminalId)
      setOpenTerminalTabs(remainingTerminals)
      setActiveDockTabId(currentActive => {
        if (currentActive !== removedTabId) return currentActive
        const remainingDockTabs = buildDockTabIds(openFileEditors, openGitDiffTabs, remainingTerminals, openBrowserTabs)
        return remainingDockTabs[0] ?? null
      })
    },
    [buildDockTabIds, openBrowserTabs, openFileEditors, openGitDiffTabs, openTerminalTabs]
  )

  const closeBrowserDock = useCallback(
    (browserId: string) => {
      const tabIndex = openBrowserTabs.findIndex(tab => tab.id === browserId)
      if (tabIndex === -1) return

      const removedTabId = getBrowserDockTabId(browserId)
      const remainingBrowsers = openBrowserTabs.filter(tab => tab.id !== browserId)
      setOpenBrowserTabs(remainingBrowsers)
      setActiveDockTabId(currentActive => {
        if (currentActive !== removedTabId) return currentActive
        const remainingDockTabs = buildDockTabIds(openFileEditors, openGitDiffTabs, openTerminalTabs, remainingBrowsers)
        const browserStartIndex = openFileEditors.length + openGitDiffTabs.length + openTerminalTabs.length + tabIndex
        const fallbackIndex = Math.min(browserStartIndex, remainingDockTabs.length - 1)
        return fallbackIndex >= 0 ? (remainingDockTabs[fallbackIndex] ?? null) : null
      })
    },
    [buildDockTabIds, openBrowserTabs, openFileEditors, openGitDiffTabs, openTerminalTabs]
  )

  const closeDockTab = useCallback(
    (tabId: string) => {
      if (tabId.startsWith('file:')) {
        closeFileEditorTab(tabId.slice('file:'.length))
        return
      }
      if (tabId.startsWith('terminal:')) {
        closeTerminalDock(tabId.slice('terminal:'.length))
        return
      }
      if (tabId.startsWith('browser:')) {
        closeBrowserDock(tabId.slice('browser:'.length))
        return
      }
      closeGitDiffTab(tabId)
    },
    [closeBrowserDock, closeFileEditorTab, closeGitDiffTab, closeTerminalDock]
  )

  const closeMonacoDock = useCallback(() => {
    if (!confirmCollapseDirtyEditors()) return
    Object.keys(terminalLaunchRequestIdRef.current).forEach(terminalId => {
      terminalLaunchRequestIdRef.current[terminalId] += 1
    })
    openTerminalTabs.forEach(tab => {
      if (tab.sessionId && window.electronAPI?.terminal) {
        void window.electronAPI.terminal.kill(tab.sessionId)
      }
    })
    fileEditorRequestIdRef.current = {}
    openFileEditors.forEach(editor => closeFileEditorResources(editor.path))
    setOpenFileEditors([])
    setOpenGitDiffTabs([])
    setOpenTerminalTabs([])
    setOpenBrowserTabs([])
    setActiveFileEditorPath(null)
    setActiveDockTabId(null)
  }, [closeFileEditorResources, confirmCollapseDirtyEditors, openFileEditors, openTerminalTabs])

  const saveFileEditor = useCallback(async () => {
    if (
      isWeb ||
      !activeFileEditor ||
      activeFileEditor.loading ||
      activeFileEditor.saving ||
      activeFileEditor.content === activeFileEditor.savedContent
    ) {
      return
    }

    updateOpenFileEditor(activeFileEditor.path, editor => ({ ...editor, saving: true, error: null }))

    try {
      const result = await localApi.post<{ path?: string; size?: number; saved?: boolean }>('/local/file-content', {
        path: activeFileEditor.path,
        content: activeFileEditor.content,
      })

      if (result?.saved === false) {
        throw new Error('Save failed')
      }

      updateOpenFileEditor(activeFileEditor.path, editor => ({
        ...editor,
        savedContent: editor.content,
        saving: false,
        error: null,
      }))
      void lspClientPool.didSaveDocument(activeFileEditor.path, activeFileEditor.content)
    } catch (error) {
      updateOpenFileEditor(activeFileEditor.path, editor => ({
        ...editor,
        saving: false,
        error: error instanceof Error ? error.message : 'Failed to save file',
      }))
    }
  }, [activeFileEditor, isWeb, updateOpenFileEditor])

  const refreshLspStatusPanel = useCallback(() => {
    setLspStatusRefreshNonce(prev => prev + 1)
  }, [])

  const restartActiveLspSession = useCallback(async () => {
    if (isWeb || !lspResolveState?.serverId || !lspResolveState.workspacePath) return

    setLspStatusLoading(true)
    setLspStatusError(null)
    try {
      await localApi.post('/lsp/restart', {
        serverId: lspResolveState.serverId,
        workspacePath: lspResolveState.workspacePath,
      })
      refreshLspStatusPanel()
    } catch (error) {
      setLspStatusError(error instanceof Error ? error.message : 'Failed to restart LSP session.')
      setLspStatusLoading(false)
    }
  }, [isWeb, lspResolveState?.serverId, lspResolveState?.workspacePath, refreshLspStatusPanel])

  const shutdownActiveLspSession = useCallback(async () => {
    if (isWeb || !lspResolveState?.serverId || !lspResolveState.workspacePath) return

    setLspStatusLoading(true)
    setLspStatusError(null)
    try {
      await localApi.post('/lsp/shutdown', {
        serverId: lspResolveState.serverId,
        workspacePath: lspResolveState.workspacePath,
      })
      refreshLspStatusPanel()
    } catch (error) {
      setLspStatusError(error instanceof Error ? error.message : 'Failed to stop LSP session.')
      setLspStatusLoading(false)
    }
  }, [isWeb, lspResolveState?.serverId, lspResolveState?.workspacePath, refreshLspStatusPanel])

  const activeLspStatusTone = !lspResolveState?.available
    ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200'
    : activeLspSession?.status === 'running'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200'
      : activeLspSession?.status === 'error'
        ? 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200'
        : 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-200'

  const activeLspStatusLabel = !activeFileEditor
    ? 'LSP'
    : !lspResolveState
      ? 'LSP idle'
      : !lspResolveState.available
        ? 'LSP unavailable'
        : activeLspSession?.status
          ? `LSP ${activeLspSession.status}`
          : 'LSP ready'

  const activeLspStatusPanel = activeFileEditor ? (
    <div className='space-y-3 px-4 py-3 text-xs text-neutral-700 dark:text-neutral-200'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div>
          <div className='text-sm font-semibold text-neutral-800 dark:text-neutral-100'>Language Server</div>
          <div className='mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400'>
            {activeFileEditor.relativePath || activeFileEditor.path}
          </div>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <span className={`rounded-full border px-2.5 py-1 font-medium ${activeLspStatusTone}`}>
            {activeLspStatusLabel}
          </span>
          <Button variant='outline2' size='small' onClick={refreshLspStatusPanel} disabled={lspStatusLoading}>
            Refresh
          </Button>
          <Button
            variant='outline2'
            size='small'
            onClick={() => setIsLspStatusPanelOpen(false)}
            disabled={lspStatusLoading}
          >
            Hide
          </Button>
        </div>
      </div>

      {lspStatusError ? (
        <div className='rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200'>
          {lspStatusError}
        </div>
      ) : null}

      <dl className='grid grid-cols-1 gap-x-4 gap-y-2 md:grid-cols-2'>
        <div>
          <dt className='text-[11px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400'>Server</dt>
          <dd className='mt-0.5 break-all'>{lspResolveState?.serverId || 'N/A'}</dd>
        </div>
        <div>
          <dt className='text-[11px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400'>Language</dt>
          <dd className='mt-0.5 break-all'>{lspResolveState?.lspLanguageId || 'N/A'}</dd>
        </div>
        <div>
          <dt className='text-[11px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400'>Workspace</dt>
          <dd className='mt-0.5 break-all'>{lspResolveState?.workspacePath || 'N/A'}</dd>
        </div>
        <div>
          <dt className='text-[11px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400'>Command</dt>
          <dd className='mt-0.5 break-all'>
            {activeLspSession?.command || lspResolveState?.command || 'Unavailable'}
            {activeLspSession?.pid ? ` (pid ${activeLspSession.pid})` : ''}
          </dd>
        </div>
        <div>
          <dt className='text-[11px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400'>Session</dt>
          <dd className='mt-0.5 break-all'>{activeLspSession?.sessionKey || lspResolveState?.sessionKey || 'N/A'}</dd>
        </div>
        <div>
          <dt className='text-[11px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400'>Attached</dt>
          <dd className='mt-0.5'>{activeLspSession ? (activeLspSession.attached ? 'Yes' : 'No') : 'N/A'}</dd>
        </div>
      </dl>

      {lspResolveState?.reason ? (
        <div className='rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200'>
          {lspResolveState.reason}
        </div>
      ) : null}

      {activeLspSession ? (
        <div className='flex flex-wrap items-center gap-2'>
          <Button
            variant='outline2'
            size='small'
            onClick={() => void restartActiveLspSession()}
            disabled={lspStatusLoading}
          >
            Restart session
          </Button>
          <Button
            variant='outline2'
            size='small'
            onClick={() => void shutdownActiveLspSession()}
            disabled={lspStatusLoading}
          >
            Stop session
          </Button>
          <span className='text-[11px] text-neutral-500 dark:text-neutral-400'>
            {activeLspSession.lastActivityAt ? `Last activity: ${activeLspSession.lastActivityAt}` : 'No activity yet'}
          </span>
        </div>
      ) : null}

      {activeLspSession?.lastError ? (
        <div className='rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200'>
          {activeLspSession.lastError}
        </div>
      ) : null}

      {Array.isArray(activeLspSession?.stderrTail) && activeLspSession.stderrTail.length > 0 ? (
        <div>
          <div className='mb-1 text-[11px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400'>
            stderr tail
          </div>
          <pre className='max-h-40 overflow-auto rounded-lg bg-neutral-950 px-3 py-2 text-[11px] text-neutral-100'>
            {activeLspSession.stderrTail.slice(-12).join('\n')}
          </pre>
        </div>
      ) : null}
    </div>
  ) : null

  const activeFileEditorTabToolbar = activeFileEditor ? (
    <div className='flex items-center gap-2'>
      <span className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${activeLspStatusTone}`}>
        {activeLspStatusLabel}
      </span>
      <Button variant='outline2' size='small' onClick={() => setIsLspStatusPanelOpen(prev => !prev)}>
        {isLspStatusPanelOpen ? 'Hide LSP' : 'LSP'}
      </Button>
    </div>
  ) : null

  const scheduleSummary = useMemo(() => {
    if (!scheduleEnabled) return 'Schedule: Off'
    const repeats = Math.max(1, Math.floor(scheduleDraft.repeatCount || 1))
    const every = Math.max(1, Math.floor(scheduleDraft.intervalValue || 1))
    const unitLabel =
      scheduleDraft.intervalUnit === 'hours'
        ? every === 1
          ? 'hour'
          : 'hours'
        : scheduleDraft.intervalUnit === 'minutes'
          ? every === 1
            ? 'minute'
            : 'minutes'
          : every === 1
            ? 'second'
            : 'seconds'
    const weekdaySummary =
      scheduleDraft.allowedWeekdays.length === 7
        ? 'all days'
        : scheduleDraft.allowedWeekdays
            .slice()
            .sort((a, b) => a - b)
            .map(day => WEEKDAY_LABELS[day])
            .join(', ')
    const rangeLabel =
      scheduleDraft.startDate || scheduleDraft.endDate
        ? ` | ${scheduleDraft.startDate || 'any'} -> ${scheduleDraft.endDate || 'any'}`
        : ''
    return `${repeats} run${repeats > 1 ? 's' : ''}, every ${every} ${unitLabel}, ${weekdaySummary}${rangeLabel}`
  }, [scheduleDraft, scheduleEnabled])

  const handlePresetSelect = (presetKey: GlobalAgentSchedulePreset) => {
    if (presetKey === 'custom') {
      setScheduleDraft(prev => ({ ...prev, preset: 'custom' }))
      return
    }
    const preset = PRESET_CONFIGS.find(item => item.key === presetKey)
    if (!preset) return
    setScheduleDraft(prev => ({
      ...prev,
      preset: preset.key,
      intervalValue: preset.intervalValue,
      intervalUnit: preset.intervalUnit,
    }))
  }

  const toggleScheduleWeekday = (day: number) => {
    setScheduleDraft(prev => {
      const exists = prev.allowedWeekdays.includes(day)
      const nextDays = exists ? prev.allowedWeekdays.filter(value => value !== day) : [...prev.allowedWeekdays, day]
      return {
        ...prev,
        allowedWeekdays: nextDays.length > 0 ? nextDays : [day],
      }
    })
  }

  const buildScheduleConfig = useCallback((): GlobalAgentTaskSchedule | undefined => {
    if (!scheduleEnabled) return undefined
    const repeatCount = Math.max(1, Math.floor(scheduleDraft.repeatCount || 1))
    const intervalValue = Math.max(1, Math.floor(scheduleDraft.intervalValue || 1))
    return {
      repeatCount,
      intervalMs: intervalUnitToMs(intervalValue, scheduleDraft.intervalUnit),
      preset: scheduleDraft.preset,
      startDate: scheduleDraft.startDate || null,
      endDate: scheduleDraft.endDate || null,
      allowedWeekdays: scheduleDraft.allowedWeekdays,
    }
  }, [scheduleDraft, scheduleEnabled])

  const getQueuedTaskRunAtLabel = useCallback(
    (task: GlobalAgentQueuedTask): string | null => {
      const payload = parseJsonSafe<any>(task.payload, null)
      const runAt = payload?.__globalSchedule?.runAt
      if (typeof runAt !== 'string' || runAt.trim().length === 0) return null
      const timestamp = Date.parse(runAt)
      if (Number.isNaN(timestamp)) return null
      return new Date(timestamp).toLocaleString()
    },
    [parseJsonSafe]
  )

  const handleRemoveQueuedTask = useCallback(
    async (taskId: string) => {
      if (isWeb || !taskId) return
      try {
        setRemovingTaskId(taskId)
        await removeQueuedTaskMutation.mutateAsync(taskId)
      } catch (error) {
        console.error('Failed to remove queued task:', error)
      } finally {
        setRemovingTaskId(null)
      }
    },
    [isWeb, removeQueuedTaskMutation]
  )

  const handleAgentSend = async () => {
    if (isWeb) return
    const trimmed = agentInput.trim()
    if (!trimmed) return

    const scheduleConfig = buildScheduleConfig()

    try {
      if (!scheduleConfig) {
        // Create optimistic message for instant UI feedback
        const optimisticUserMessage = {
          id: `temp-${Date.now()}`,
          role: 'user',
          content: trimmed,
          created_at: new Date().toISOString(),
          _optimistic: true, // Flag for styling
        }

        // Add to cache immediately for instant UI update
        setGlobalAgentOptimisticMessage(queryClient, optimisticUserMessage)
      } else {
        clearGlobalAgentOptimisticMessage(queryClient)
      }

      // Clear input
      setAgentInput('')

      // Enqueue task (async) - GlobalAgentLoop will clear optimistic message when real message is persisted
      await globalAgentLoop.enqueueTask(trimmed, undefined, undefined, scheduleConfig)

      // Reset schedule toggle after a successful send
      setScheduleEnabled(false)
    } catch (error) {
      console.error('Failed to enqueue agent task:', error)
      // Clear optimistic message on error
      clearGlobalAgentOptimisticMessage(queryClient)
    }
  }

  const handleAgentAbort = async () => {
    if (isWeb) return
    try {
      await globalAgentLoop.abortCurrentGeneration()
    } catch (error) {
      console.error('Failed to abort agent generation:', error)
    }
  }

  // Get the display name for current path (relative to ccCwd)
  const getDisplayPath = () => {
    if (!currentPath || !ccCwd) return ''
    if (currentPath === ccCwd) return '/'
    return currentPath.replace(ccCwd, '') || '/'
  }

  const fileSearchStatusText = useMemo(() => {
    if (!fileSearchBasePath) {
      return 'Set conversation/project cwd first'
    }

    if (!followGitignore) {
      return `Searching in: ${fileSearchBasePath} (ignoring .gitignore)`
    }

    if (fileSearchData?.respectingGitignore) {
      return `Searching in: ${fileSearchBasePath} (respects .gitignore)`
    }

    return `Searching in: ${fileSearchBasePath} (git repo not detected; fallback search)`
  }, [fileSearchBasePath, followGitignore, fileSearchData?.respectingGitignore])

  useEffect(() => {
    if (activeTab !== 'git') return

    const selected = selectedGitDiff
    const isSelectionStillValid =
      !!selected &&
      !!gitOverviewData?.status.all.some(file => {
        if (file.relativePath !== selected.relativePath) return false
        if (selected.untracked) return file.untracked
        if (selected.staged) return file.staged || file.conflicted
        return file.unstaged || file.untracked || file.conflicted
      })

    if (isSelectionStillValid) return

    const fallbackFile =
      gitOverviewData?.status.conflicted[0] ||
      gitOverviewData?.status.staged[0] ||
      gitOverviewData?.status.unstaged[0] ||
      gitOverviewData?.status.untracked[0] ||
      null

    setSelectedGitDiff(
      fallbackFile
        ? {
            relativePath: fallbackFile.relativePath,
            staged: fallbackFile.staged,
            untracked: fallbackFile.untracked,
          }
        : null
    )
  }, [activeTab, gitOverviewData, selectedGitDiff])

  const gitSummary = gitOverviewData?.summary ?? null
  const gitStatusSections = useMemo(
    () => [
      {
        key: 'conflicted' as const,
        label: 'Conflicted',
        files: gitOverviewData?.status.conflicted || [],
        badgeClass:
          'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200',
      },
      {
        key: 'staged' as const,
        label: 'Staged',
        files: gitOverviewData?.status.staged || [],
        badgeClass:
          'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200',
      },
      {
        key: 'unstaged' as const,
        label: 'Unstaged',
        files: gitOverviewData?.status.unstaged || [],
        badgeClass:
          'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200',
      },
      {
        key: 'untracked' as const,
        label: 'Untracked',
        files: gitOverviewData?.status.untracked || [],
        badgeClass: 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-200',
      },
    ],
    [gitOverviewData]
  )
  const displayedGitCommits = useMemo(() => (gitOverviewData?.commits || []).slice(0, 8), [gitOverviewData?.commits])
  const displayedCommitGraphLines = useMemo(
    () => (gitOverviewData?.commitGraphLines || []).slice(0, 18),
    [gitOverviewData?.commitGraphLines]
  )
  const displayedLocalBranches = useMemo(
    () => (gitOverviewData?.branches.local || []).slice(0, 8),
    [gitOverviewData?.branches.local]
  )
  const displayedRemoteBranches = useMemo(
    () => (gitOverviewData?.branches.remote || []).slice(0, 4),
    [gitOverviewData?.branches.remote]
  )
  const isGitBusy =
    gitStageFilesMutation.isPending ||
    gitUnstageFilesMutation.isPending ||
    gitCheckoutBranchMutation.isPending ||
    gitCreateBranchMutation.isPending

  const handleSelectGitDiff = useCallback(
    (file: GitStatusFile, staged: boolean, openInDock = true) => {
      setSelectedGitDiff({
        relativePath: file.relativePath,
        staged: !file.untracked && staged,
        untracked: file.untracked,
      })
      if (openInDock) {
        openGitDiffTab(file, staged)
      }
    },
    [openGitDiffTab]
  )

  const handleGitStageAll = useCallback(async () => {
    if (!gitBasePath) return
    try {
      const result = await gitStageFilesMutation.mutateAsync({ path: gitBasePath })
      setGitActionFeedback({ type: 'success', message: result.message })
      await refetchGitOverview()
    } catch (error) {
      setGitActionFeedback({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to stage all changes',
      })
    }
  }, [gitBasePath, gitStageFilesMutation, refetchGitOverview])

  const handleGitStageFile = useCallback(
    async (file: GitStatusFile) => {
      if (!gitBasePath) return
      try {
        const result = await gitStageFilesMutation.mutateAsync({
          path: gitBasePath,
          files: [file.relativePath],
        })
        setGitActionFeedback({ type: 'success', message: result.message })
        setSelectedGitDiff({ relativePath: file.relativePath, staged: true, untracked: false })
        await refetchGitOverview()
      } catch (error) {
        setGitActionFeedback({
          type: 'error',
          message: error instanceof Error ? error.message : `Failed to stage ${file.relativePath}`,
        })
      }
    },
    [gitBasePath, gitStageFilesMutation, refetchGitOverview]
  )

  const handleGitUnstageFile = useCallback(
    async (file: GitStatusFile) => {
      if (!gitBasePath) return
      try {
        const result = await gitUnstageFilesMutation.mutateAsync({
          path: gitBasePath,
          files: [file.relativePath],
        })
        setGitActionFeedback({ type: 'success', message: result.message })
        setSelectedGitDiff({ relativePath: file.relativePath, staged: false, untracked: false })
        await refetchGitOverview()
      } catch (error) {
        setGitActionFeedback({
          type: 'error',
          message: error instanceof Error ? error.message : `Failed to unstage ${file.relativePath}`,
        })
      }
    },
    [gitBasePath, gitUnstageFilesMutation, refetchGitOverview]
  )

  const handleGitCheckoutBranch = useCallback(
    async (branch: GitBranch) => {
      if (!gitBasePath || !branch.name || branch.current) return
      try {
        const result = await gitCheckoutBranchMutation.mutateAsync({ path: gitBasePath, branch: branch.name })
        setGitActionFeedback({ type: 'success', message: result.message })
        await refetchGitOverview()
      } catch (error) {
        setGitActionFeedback({
          type: 'error',
          message: error instanceof Error ? error.message : `Failed to checkout ${branch.name}`,
        })
      }
    },
    [gitBasePath, gitCheckoutBranchMutation, refetchGitOverview]
  )

  const handleGitCreateBranch = useCallback(async () => {
    const nextBranch = newGitBranchName.trim()
    if (!gitBasePath || !nextBranch) return
    try {
      const result = await gitCreateBranchMutation.mutateAsync({
        path: gitBasePath,
        branch: nextBranch,
        checkout: true,
      })
      setGitActionFeedback({ type: 'success', message: result.message })
      setNewGitBranchName('')
      await refetchGitOverview()
    } catch (error) {
      setGitActionFeedback({
        type: 'error',
        message: error instanceof Error ? error.message : `Failed to create branch ${nextBranch}`,
      })
    }
  }, [gitBasePath, gitCreateBranchMutation, newGitBranchName, refetchGitOverview])

  const dockTabToolbar = isEditorDockOpen ? (
    <div className='flex mt-2 py-2 flex-wrap items-center gap-2 px-2 rounded-t-2xl pb-2 bg-white/70 shadow-sm dark:bg-neutral-950/60 backdrop-blur-sm'>
      <Button
        variant='outline2'
        size='circle'
        rounded='full'
        onClick={toggleCollapse}
        className='h-9 w-9 transition-transform duration-200 hover:scale-103 acrylic-ultra-light-nb-3'
        aria-label='Collapse sidebar'
      >
        <i className='bx bx-chevron-right text-xl' aria-hidden='true'></i>
      </Button>
      <span className='leading-none rounded-[18px] py-2 px-3.5 bg-neutral-50 font-semibold text-[22px] text-neutral-600 dark:text-neutral-200 acrylic-ultra-light-nb-3'>
        Dock
      </span>
      <Button variant='outline2' size='small' onClick={() => openBrowserDock()} disabled={isWeb}>
        New browser
      </Button>
    </div>
  ) : null

  return (
    <aside
      ref={asideRef}
      className={`relative z-10 ${isWeb ? 'h-[100vh]' : 'h-full'} flex flex-col ${isEditorDockOpen ? 'overflow-visible' : 'overflow-hidden'} bg-transparent dark:bg-transparent flex-shrink-0 ${isResizingSidebar ? 'transition-none' : 'transition-all duration-300 ease-in-out'} ${className}`}
      style={{
        width: `${asideWidthPx}px`,
        maxWidth: '100%',
        flexBasis: `${asideWidthPx}px`,
      }}
      aria-label='Research Notes'
    >
      {!isEditorDockOpen && (
        <div
          className='group absolute inset-y-0 left-0 z-30 flex cursor-col-resize select-none items-center justify-center'
          style={{ width: `${RIGHT_BAR_RESIZE_HANDLE_WIDTH_PX}px` }}
          role='separator'
          aria-orientation='vertical'
          aria-label={isCollapsed ? 'Drag to expand right sidebar' : 'Drag to resize right sidebar'}
          aria-valuemin={RIGHT_BAR_MIN_WIDTH_PX}
          aria-valuemax={maxResizableSidebarWidth}
          aria-valuenow={resolvedRightBarWidth}
          onMouseDown={handleSidebarResizeMouseDown}
          onTouchStart={handleSidebarResizeTouchStart}
          title={isCollapsed ? 'Drag to expand sidebar' : 'Drag to resize sidebar'}
        >
          <div
            className={`h-full w-px transition-colors ${
              isResizingSidebar
                ? 'bg-neutral-400/80 dark:bg-neutral-500/80'
                : 'bg-transparent group-hover:bg-neutral-300 dark:group-hover:bg-neutral-700'
            }`}
          />
        </div>
      )}

      {(isResizingSidebar || isResizingDock) && (
        <div
          className='fixed inset-0 z-[2000] cursor-col-resize select-none bg-transparent'
          aria-hidden='true'
          onMouseUp={() => {
            setIsResizingSidebar(false)
            setIsResizingDock(false)
          }}
          onTouchEnd={() => {
            setIsResizingSidebar(false)
            setIsResizingDock(false)
          }}
        />
      )}

      {!isEditorDockOpen && (
        <>
          {/* Toggle Button */}
          <div className='flex items-center justify-between py-3 my-1 md:py-2.5 lg:p-1 xl:p-1 2xl:px-1 2xl:py-2'>
            <div className={`flex items-center gap-2 ${isCollapsed ? 'mx-auto' : 'mx-1'}`}>
              <Button
                variant='outline2'
                size='circle'
                rounded='full'
                onClick={toggleCollapse}
                className={`${isCollapsed ? 'mx-auto' : 'ml-0'} mb-2 transition-transform duration-200 hover:scale-103 px-2 py-2 bg-white shadow-[inset_0_0px_3px_rgba(0,0,0,0.16)]`}
                aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              >
                <i
                  className={`bx ${isCollapsed ? 'bx-chevron-left' : 'bx-chevron-right'} text-xl`}
                  aria-hidden='true'
                ></i>
              </Button>

              {!isCollapsed && !isEditorDockOpen && (
                <div className='flex flex-wrap items-center gap-2'>
                  {hasDockTabs ? (
                    <span className='leading-none rounded-[18px] py-2 px-3.5 bg-neutral-50 font-semibold text-[22px] text-neutral-600 dark:text-neutral-200 acrylic-ultra-light-nb-3'>
                      Dock
                    </span>
                  ) : null}
                  <Button variant='outline2' size='small' onClick={() => openBrowserDock()} disabled={isWeb}>
                    New browser
                  </Button>
                </div>
              )}
            </div>

            {/* {!isCollapsed && (
          <h2 className='leading-none text-[14px] md:text-[16px] lg:text-[16px] xl:text-[16px] 2xl:text-[18px] 3xl:text-[20px] 4xl:text-[22px] rounded-[18px] py-2 px-2.5 font-semibold text-neutral-700 dark:text-neutral-200 truncate bg-neutral-50 acrylic-ultra-light-nb-3'>
            Explorer
          </h2>
        )} */}
          </div>
        </>
      )}

      {/* Main content wrapper - compact sidebar with floating dock overlay */}
      <div
        className={`relative flex-1 ${isCollapsed ? 'flex flex-col' : 'flex min-h-0'} ${isEditorDockOpen ? 'overflow-visible' : ''}`}
      >
        {shouldMountDockOverlay && (
          <div
            className={`absolute inset-y-0 z-20 flex min-h-0 min-w-0 flex-col pb-2 transition-opacity duration-200 ${
              isDockOverlayVisible ? 'visible opacity-100' : 'pointer-events-none invisible opacity-0'
            }`}
            style={{
              width: `${dockOverlayWidthPx}px`,
              right: `calc(100% + ${DOCKED_LAYOUT_GAP_PX}px)`,
            }}
            aria-hidden={!isDockOverlayVisible}
          >
            {dockTabToolbar}
            <div className='relative min-h-0 min-w-0 flex-1'>
              <div
                className='group absolute inset-y-0 left-0 z-30 flex cursor-col-resize select-none items-center justify-center'
                style={{ width: `${RIGHT_BAR_RESIZE_HANDLE_WIDTH_PX}px` }}
                role='separator'
                aria-orientation='vertical'
                aria-label='Drag to resize dock'
                aria-valuemin={minDockOverlayWidth}
                aria-valuemax={maxDockOverlayWidth}
                aria-valuenow={dockOverlayWidthPx}
                onMouseDown={handleDockResizeMouseDown}
                onTouchStart={handleDockResizeTouchStart}
                title='Drag to resize dock'
              >
                <div
                  className={`h-full w-px transition-colors ${
                    isResizingDock
                      ? 'bg-neutral-400/80 dark:bg-neutral-500/80'
                      : 'bg-transparent group-hover:bg-neutral-300 dark:group-hover:bg-neutral-700'
                  }`}
                />
              </div>

              {activeFileEditor ? (
                <MonacoFileEditorPane
                  filePath={activeFileEditor.path}
                  relativePath={activeFileEditor.relativePath}
                  value={activeFileEditor.content}
                  loading={activeFileEditor.loading}
                  error={activeFileEditor.error}
                  isDirty={isEditorDirty}
                  isSaving={activeFileEditor.saving}
                  theme={monacoTheme}
                  tabs={dockTabs}
                  activeTabId={activeDockTabId}
                  onChange={handleFileEditorChange}
                  onSave={() => {
                    void saveFileEditor()
                  }}
                  onClose={closeMonacoDock}
                  onSelectTab={selectDockTab}
                  onCloseTab={closeDockTab}
                  tabToolbar={activeFileEditorTabToolbar}
                  statusPanel={isLspStatusPanelOpen ? activeLspStatusPanel : null}
                  onSelectionChange={handleMonacoSelectionChange}
                />
              ) : activeGitDiffTab ? (
                <MonacoGitDiffPane
                  title={activeGitDiffTab.displayPath}
                  filePath={activeGitDiffTab.path}
                  originalValue={gitDiffData?.original?.content ?? ''}
                  modifiedValue={gitDiffData?.modified?.content ?? ''}
                  originalLabel={gitDiffData?.original?.label ?? 'Original'}
                  modifiedLabel={gitDiffData?.modified?.label ?? 'Modified'}
                  loading={isLoadingGitDiff || isFetchingGitDiff}
                  error={null}
                  theme={monacoTheme}
                  language={gitDiffData?.languageHint || 'plaintext'}
                  message={gitDiffData?.message ?? null}
                  patch={gitDiffData?.diff ?? ''}
                  preferPatch={Boolean(gitDiffData?.preferPatch || (!gitDiffData?.original && !gitDiffData?.modified))}
                  tabs={dockTabs}
                  activeTabId={activeDockTabId}
                  onClose={closeMonacoDock}
                  onOpenFile={
                    activeGitDiffTab.path
                      ? () =>
                          void openFileEditor(activeGitDiffTab.path, { relativePath: activeGitDiffTab.relativePath })
                      : null
                  }
                  onSelectTab={selectDockTab}
                  onCloseTab={closeDockTab}
                />
              ) : activeTerminalDock ? (
                <XtermTerminalPane
                  tabId={getTerminalDockTabId(activeTerminalDock.id)}
                  title={activeTerminalDock.title}
                  cwd={activeTerminalDock.cwd}
                  shell={activeTerminalDock.shell}
                  sessionId={activeTerminalDock.sessionId}
                  history={activeTerminalDock.history}
                  status={activeTerminalDock.status}
                  error={activeTerminalDock.error}
                  exitCode={activeTerminalDock.exitCode}
                  theme={monacoTheme}
                  tabs={dockTabs}
                  activeTabId={activeDockTabId}
                  onInput={handleTerminalInput}
                  onResize={handleTerminalResize}
                  onRestart={() => restartTerminalDock(activeTerminalDock.id)}
                  onClear={() => clearTerminalDockBuffer(activeTerminalDock.id)}
                  onClose={() => closeTerminalDock(activeTerminalDock.id)}
                  onSelectTab={selectDockTab}
                  onCloseTab={closeDockTab}
                />
              ) : null}
              {openBrowserTabs.length > 0 ? (
                <div className={activeBrowserDock ? 'h-full' : 'hidden'}>
                  <BrowserPane
                    browserTabs={openBrowserTabs}
                    activeBrowserTabId={activeBrowserDock?.id ?? null}
                    theme={monacoTheme}
                    tabs={dockTabs}
                    activeTabId={activeDockTabId}
                    onUpdateTab={updateBrowserDock}
                    onOpenNewTab={() => openBrowserDock()}
                    onClose={() => {
                      if (activeBrowserDock) {
                        closeBrowserDock(activeBrowserDock.id)
                      }
                    }}
                    onSelectTab={selectDockTab}
                    onCloseTab={closeDockTab}
                  />
                </div>
              ) : null}
            </div>
          </div>
        )}
        <div
          className={`min-w-0 overflow-hidden flex ${isCollapsed ? 'flex-col' : 'min-h-0 flex-1 flex-col'} ${
            isEditorDockOpen ? 'flex-shrink-0  ' : 'flex-1'
          }`}
          style={
            isEditorDockOpen
              ? {
                  width: `${dockedSidebarPanelWidth}px`,
                  minWidth: `${dockedSidebarPanelWidth}px`,
                  maxWidth: `${dockedSidebarPanelWidth}px`,
                  flexBasis: `${dockedSidebarPanelWidth}px`,
                }
              : undefined
          }
        >
          {/* File browser - show when ccCwd is set and expanded */}
          {!isCollapsed && ccCwd && (
            <div className='min-w-0 flex-1 min-h-0 flex flex-col overflow-hidden px-2 pb-2 border-b border-neutral-200 dark:border-neutral-800'>
              {/* Path header with navigation */}
              <div className='flex min-w-0 items-center gap-2 mb-2 flex-shrink-0 overflow-hidden'>
                <button
                  onClick={handleGoToRoot}
                  className='w-7 h-7 flex items-center justify-center rounded-full hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors bg-neutral-50 acrylic-ultra-light-nb-3 '
                  title='Go to root'
                  disabled={currentPath === ccCwd}
                >
                  <i className='bx bx-home text-sm leading-none text-neutral-600 dark:text-neutral-100' />
                </button>
                <button
                  onClick={handleGoBack}
                  className='w-7 h-7 flex items-center justify-center rounded-full hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors bg-neutral-50 acrylic-ultra-light-nb-3'
                  title='Go back'
                  disabled={pathHistory.length === 0}
                >
                  <i className='bx bx-arrow-back text-sm leading-none text-neutral-600 dark:text-neutral-100' />
                </button>
                {onFilePathInsert && currentPath && (
                  <button
                    onClick={() => onFilePathInsert(currentPath)}
                    className='w-7 h-7 flex items-center justify-center rounded-full hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors bg-neutral-50 acrylic-ultra-light-nb-3'
                    title='Insert current directory path'
                  >
                    <i className='bx bx-folder-plus text-sm leading-none text-neutral-600 dark:text-neutral-100' />
                  </button>
                )}
                {!isWeb && (currentPath || ccCwd) && (
                  <button
                    onClick={() => {
                      openNewTerminalDock(currentPath || ccCwd)
                    }}
                    className='w-7 h-7 flex items-center justify-center rounded-full hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors bg-neutral-50 acrylic-ultra-light-nb-3'
                    title='Open terminal here'
                  >
                    <i className='bx bx-terminal text-sm leading-none text-neutral-600 dark:text-neutral-100' />
                  </button>
                )}
                <span
                  className='text-[10px] text-neutral-500 dark:text-neutral-400 truncate flex-1'
                  title={currentPath}
                >
                  {getDisplayPath()}
                </span>
              </div>

              <div className='flex min-w-0 items-center gap-1 mb-1 flex-shrink-0 overflow-hidden'>
                <input
                  type='search'
                  value={fileSearchQuery}
                  onChange={event => setFileSearchQuery(event.target.value)}
                  placeholder='Find Files..'
                  disabled={!fileSearchBasePath}
                  className='flex-1 min-w-0 rounded-[12px] placeholder-neutral-800  dark:placeholder-neutral-100 bg-neutral-50 acrylic-ultra-light-nb-3 dark:bg-neutral-800 px-2 py-1 text-[13px] text-neutral-700 dark:text-neutral-100 outline-none'
                />
                <button
                  onClick={handleClearFileSearch}
                  className='shrink-0 whitespace-nowrap px-1.5 py-1 rounded-[10px] text-[11px] hover:bg-neutral-200/70 dark:hover:bg-neutral-300/80 dark:text-neutral-100 dark:hover:text-neutral-900 transition-colors disabled:opacity-50'
                  disabled={fileSearchQuery.length === 0}
                  title='Clear search'
                >
                  Clear
                </button>
                <button
                  onClick={() => setFollowGitignore(value => !value)}
                  className='shrink-0 max-w-[8.5rem] truncate px-1.5 py-1 rounded-[10px] text-[11px] hover:bg-neutral-200/70 dark:hover:bg-neutral-300/80 dark:text-neutral-100 dark:hover:text-neutral-900 transition-colors'
                  title='Toggle .gitignore-aware search'
                >
                  {followGitignore ? '.gitignore on' : '.gitignore off'}
                </button>
              </div>

              <div className='mb-2 text-[10px] text-neutral-500 dark:text-neutral-200 flex-shrink-0'>
                {fileSearchStatusText}
                {isFileSearchMode && fileSearchData?.truncated ? ' - Results limited' : ''}
              </div>

              {/* File list */}
              <div className='flex-1 overflow-y-auto no-scrollbar'>
                {!isFileSearchMode && isLoadingFiles && (
                  <div className='text-[10px] text-neutral-500 dark:text-neutral-400 py-1'>Loading files...</div>
                )}
                {!isFileSearchMode && filesError && (
                  <div className='text-[10px] text-red-500 dark:text-red-400 py-1'>
                    {filesError instanceof Error ? filesError.message : 'Failed to load files'}
                  </div>
                )}
                {!isFileSearchMode && directoryData?.files && directoryData.files.length === 0 && !isLoadingFiles && (
                  <div className='text-[10px] text-neutral-500 dark:text-neutral-400 py-1'>Empty directory</div>
                )}

                {isFileSearchMode && isSearchingFiles && (
                  <div className='text-[10px] text-neutral-500 dark:text-neutral-400 py-1'>
                    Searching subdirectories...
                  </div>
                )}
                {isFileSearchMode && fileSearchError && (
                  <div className='text-[10px] text-red-500 dark:text-red-400 py-1'>
                    {fileSearchError instanceof Error ? fileSearchError.message : 'Failed to search files'}
                  </div>
                )}
                {isFileSearchMode && !isSearchingFiles && !fileSearchError && displayedDirectoryFiles.length === 0 && (
                  <div className='text-[10px] text-neutral-500 dark:text-neutral-400 py-1'>No matches</div>
                )}

                {displayedDirectoryFiles.map(file => (
                  <div
                    key={`${isFileSearchMode ? 'search' : 'list'}-${file.path}`}
                    className='flex items-center gap-1.5 rounded-[10px] my-1.5 bg-neutral-50 acrylic-ultra-light-nb-3 px-1.5 py-0.5 rounded text-[13px] transition-colors group'
                  >
                    <div
                      role='button'
                      tabIndex={0}
                      onClick={() => handleFileClick(file)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          handleFileClick(file)
                        }
                      }}
                      className={`flex items-center gap-1.5 flex-1 min-w-0 ${
                        file.isDirectory
                          ? 'cursor-pointer hover:bg-neutral-200 dark:hover:bg-neutral-700 rounded px-1 -mx-1'
                          : 'cursor-default text-neutral-500 dark:text-neutral-400'
                      }`}
                      title={file.path}
                    >
                      <i
                        className={`bx ${file.isDirectory ? 'bx-folder text-amber-500' : 'bx-file text-neutral-400'} text-sm flex-shrink-0`}
                      />
                      <div className='min-w-0 flex-1'>
                        <div className='truncate text-neutral-700 dark:text-neutral-300'>{file.name}</div>
                        {isFileSearchMode && file.relativePath && file.relativePath !== file.name && (
                          <div className='truncate text-[10px] text-neutral-500 dark:text-neutral-400'>
                            {file.relativePath}
                          </div>
                        )}
                      </div>
                    </div>
                    {!file.isDirectory && !isWeb && (
                      <button
                        onClick={e => {
                          e.stopPropagation()
                          void openFileEditor(file.path, { relativePath: file.relativePath })
                        }}
                        className={`p-1 rounded-full hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors flex-shrink-0 ${
                          activeFileEditorPath === file.path
                            ? 'opacity-100 bg-neutral-200 dark:bg-neutral-700/60'
                            : 'opacity-0 group-hover:opacity-100'
                        }`}
                        title='Open in editor'
                      >
                        <i className='bx bx-pencil text-sm text-neutral-600 dark:text-neutral-300' />
                      </button>
                    )}
                    {onFilePathInsert && (
                      <button
                        onClick={e => {
                          e.stopPropagation()
                          onFilePathInsert(file.path)
                        }}
                        className='p-0.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0'
                        title='Insert path to input'
                      >
                        <i className='bx bx-plus text-sm text-neutral-600 dark:text-neutral-400' />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tab buttons - only show when expanded */}
          {!isCollapsed && (
            <div className='flex min-w-0 gap-2 overflow-hidden px-3 py-2 flex-shrink-0'>
              {!isWeb && (
                <button
                  onClick={() => setActiveTab('git')}
                  className={`flex-1 px-2 py-2 text-sm font-medium rounded-xl transition-all duration-200 ${
                    activeTab === 'git'
                      ? 'bg-neutral-50 acrylic-ultra-light-nb-3 text-stone-800 dark:text-stone-200 scale-102 dark:border-transparent shadow-[0px_0.5px_3px_1px_rgba(0,0,0,0.05)] dark:shadow-[0px_0.5px_3px_2px_rgba(0,0,0,0.05)]'
                      : 'bg-transparent text-stone-600 dark:text-stone-300 hover:scale-101 hover:bg-neutral-50 dark:hover:bg-neutral-900/50 '
                  }`}
                >
                  GIT
                </button>
              )}
              <button
                onClick={() => setActiveTab('note')}
                className={`flex-1 px-2 py-2 text-sm font-medium rounded-xl transition-all duration-200 ${
                  activeTab === 'note'
                    ? 'bg-neutral-50 acrylic-ultra-light-nb-3 text-stone-800 dark:text-stone-200 scale-102 dark:border-transparent shadow-[0px_0.5px_3px_1px_rgba(0,0,0,0.05)] dark:shadow-[0px_0.5px_3px_2px_rgba(0,0,0,0.05)]'
                    : 'bg-transparent text-stone-600 dark:text-stone-300 hover:scale-101 hover:bg-neutral-50 dark:hover:bg-neutral-900/50 '
                }`}
              >
                Note
              </button>
              {!isWeb && (
                <button
                  onClick={() => setActiveTab('terminal')}
                  className={`flex-1 px-2 py-2 text-sm font-medium rounded-xl transition-all duration-200 ${
                    activeTab === 'terminal'
                      ? 'bg-neutral-50 acrylic-ultra-light-nb-3 text-stone-800 dark:text-stone-200 scale-102 dark:border-transparent shadow-[0px_0.5px_3px_-0.5px_rgba(0,0,0,0.05)] dark:shadow-[0px_0.5px_3px_2px_rgba(0,0,0,0.05)]'
                      : 'bg-transparent hover:scale-101 text-stone-600 dark:text-stone-300 hover:bg-neutral-50 dark:hover:bg-neutral-900/50 '
                  }`}
                  title='Terminal sessions'
                >
                  Terminal {openTerminalTabs.length > 0 ? `(${openTerminalTabs.length})` : ''}
                </button>
              )}
              <button
                onClick={() => setActiveTab('agents')}
                className={`flex-1 px-2 py-2 text-sm font-medium rounded-xl transition-all duration-200 ${
                  activeTab === 'agents'
                    ? 'bg-neutral-50 acrylic-ultra-light-nb-3 text-stone-800 dark:text-stone-200 scale-102 dark:border-transparent shadow-[0px_0.5px_3px_-0.5px_rgba(0,0,0,0.05)] dark:shadow-[0px_0.5px_3px_2px_rgba(0,0,0,0.05)]'
                    : 'bg-transparent hover:scale-101 text-stone-600 dark:text-stone-300 hover:bg-neutral-50 dark:hover:bg-neutral-900/50 '
                }`}
                title='Active streaming branches'
              >
                Agents {activeStreams.length > 0 ? `(${activeStreams.length})` : ''}
              </button>
              {/* Global tab intentionally hidden.
            <button
              onClick={() => setActiveTab('global')}
              className={`flex-1 px-2 py-2 text-sm font-medium rounded-xl transition-all duration-200 ${
                activeTab === 'global'
                  ? 'bg-neutral-100 dark:bg-neutral-900 text-stone-800 dark:text-stone-200 border-1 border-neutral-300 scale-102 dark:border-neutral-600 shadow-[0px_0.5px_3px_-0.5px_rgba(0,0,0,0.05)] dark:shadow-[0px_0.5px_3px_2px_rgba(0,0,0,0.35)]'
                  : 'bg-transparent hover:scale-101 text-stone-600 dark:text-stone-400 hover:bg-neutral-50 dark:hover:bg-neutral-900/50 border-1 border-neutral-300 dark:border-neutral-800'
              }`}
            >
              Global
            </button>
            */}
            </div>
          )}

          {/* Content Area */}
          <div
            className={`${!isCollapsed && ccCwd ? 'flex-1' : 'flex-1'} min-w-0 min-h-0 overflow-y-auto overflow-x-hidden p-2 pt-2 2xl:pt-2 no-scrollbar scroll-fade dark:border-neutral-800 rounded-xl border-t-0`}
            data-heimdall-wheel-exempt='true'
            data-heimdall-contextmenu-exempt='true'
          >
            {isCollapsed ? (
              // Collapsed state - show icons only
              <div className='flex flex-col items-center gap-2'>
                {ccCwd && (
                  <Button
                    variant='outline2'
                    size='circle'
                    rounded='full'
                    className='h-10 w-10 transition-transform duration-200 hover:scale-103 '
                    onClick={toggleCollapse}
                    title='Expand to view files'
                  >
                    <i className='bx bx-folder text-lg' aria-hidden='true'></i>
                  </Button>
                )}
                <Button
                  variant='outline2'
                  size='circle'
                  rounded='full'
                  className='h-10 w-10 transition-transform duration-200 hover:scale-103 '
                  onClick={toggleCollapse}
                  title='Expand to view notes'
                >
                  <i className='bx bx-note text-lg' aria-hidden='true'></i>
                </Button>
                {!isWeb && (currentPath || ccCwd) && (
                  <Button
                    variant='outline2'
                    size='circle'
                    rounded='full'
                    className='h-10 w-10 transition-transform duration-200 hover:scale-103 '
                    onClick={() => {
                      dispatch(uiActions.rightBarExpanded())
                      setActiveTab('terminal')
                      openNewTerminalDock(currentPath || ccCwd)
                    }}
                    title='Open terminal'
                  >
                    <i className='bx bx-terminal text-lg' aria-hidden='true'></i>
                  </Button>
                )}
              </div>
            ) : activeTab === 'git' ? (
              !gitBasePath ? (
                <div className='text-xs text-neutral-500 dark:text-neutral-400 px-2 py-1'>
                  Set conversation/project cwd first to inspect repository state.
                </div>
              ) : isLoadingGitOverview && !gitOverviewData ? (
                <div className='text-xs text-neutral-500 dark:text-neutral-400 px-2 py-1'>Loading repository...</div>
              ) : !gitOverviewData?.isGitRepo || !gitSummary ? (
                <div className='space-y-2 px-2 py-1'>
                  <div className='text-xs text-neutral-500 dark:text-neutral-400'>
                    No git repository detected for this path.
                  </div>
                  <div className='text-[11px] text-neutral-500 dark:text-neutral-400 break-all'>{gitBasePath}</div>
                  <Button variant='outline2' size='small' onClick={() => void refetchGitOverview()}>
                    Retry
                  </Button>
                </div>
              ) : (
                <div className='space-y-4'>
                  {gitActionFeedback && (
                    <div
                      className={`px-2 py-1 text-xs ${
                        gitActionFeedback.type === 'success'
                          ? 'text-emerald-700 dark:text-emerald-200'
                          : 'text-rose-700 dark:text-rose-200'
                      }`}
                    >
                      <div className='flex items-start justify-between gap-2'>
                        <span>{gitActionFeedback.message}</span>
                        <button
                          onClick={() => setGitActionFeedback(null)}
                          className='text-current opacity-60 transition-opacity hover:opacity-100'
                          title='Dismiss'
                        >
                          <i className='bx bx-x text-sm' />
                        </button>
                      </div>
                    </div>
                  )}

                  <div className='min-w-0 px-2 py-1'>
                    <div className='flex flex-wrap items-start justify-between gap-3'>
                      <div className='min-w-0 flex-1'>
                        <div className='flex min-w-0 flex-wrap items-center gap-2'>
                          <i className='bx bx-git-repo-forked shrink-0 text-sm text-neutral-500 dark:text-neutral-400' />
                          <span className='min-w-0 truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100'>
                            {gitSummary.repoName}
                          </span>
                          <span
                            className={`shrink-0 text-[10px] font-medium ${
                              gitSummary.isClean
                                ? 'text-emerald-600 dark:text-emerald-300'
                                : 'text-amber-600 dark:text-amber-300'
                            }`}
                          >
                            {gitSummary.isClean ? 'Clean' : 'Changes'}
                          </span>
                        </div>
                        <div className='mt-1 break-all text-[11px] text-neutral-500 dark:text-neutral-400'>
                          {gitSummary.repoRoot}
                        </div>
                        <div className='mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-neutral-500 dark:text-neutral-400'>
                          <span className='max-w-full truncate'>
                            branch: {gitSummary.currentBranch || 'detached HEAD'}
                          </span>
                          {gitSummary.headShortSha && <span className='shrink-0'>{gitSummary.headShortSha}</span>}
                          {gitSummary.upstreamBranch && (
                            <span className='max-w-full truncate'>{gitSummary.upstreamBranch}</span>
                          )}
                          {(gitSummary.ahead > 0 || gitSummary.behind > 0) && (
                            <span className='shrink-0'>
                              ↑{gitSummary.ahead} ↓{gitSummary.behind}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className='flex shrink-0 items-center gap-2'>
                        <button
                          type='button'
                          onClick={() => void refetchGitOverview()}
                          disabled={isFetchingGitOverview || isGitBusy}
                          className='inline-flex h-7 w-7 items-center justify-center rounded-md border border-neutral-200 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 disabled:opacity-50 dark:border-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-neutral-200'
                          aria-label={
                            isFetchingGitOverview ? 'Refreshing repository overview' : 'Refresh repository overview'
                          }
                          title={
                            isFetchingGitOverview ? 'Refreshing repository overview' : 'Refresh repository overview'
                          }
                        >
                          <i
                            className={`bx ${isFetchingGitOverview ? 'bx-loader-circle animate-spin' : 'bx-refresh'} text-sm`}
                            aria-hidden='true'
                          />
                        </button>
                        <button
                          type='button'
                          onClick={() => void handleGitStageAll()}
                          disabled={gitSummary.changedFilesCount === 0 || gitStageFilesMutation.isPending}
                          className='inline-flex h-7 w-7 items-center justify-center rounded-md border border-neutral-200 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 disabled:opacity-50 dark:border-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-neutral-200'
                          aria-label={
                            gitStageFilesMutation.isPending ? 'Staging all changed files' : 'Stage all changed files'
                          }
                          title={
                            gitStageFilesMutation.isPending ? 'Staging all changed files' : 'Stage all changed files'
                          }
                        >
                          <i
                            className={`bx ${gitStageFilesMutation.isPending ? 'bx-loader-circle animate-spin' : 'bx-upload'} text-sm`}
                            aria-hidden='true'
                          />
                        </button>
                      </div>
                    </div>

                    <div className='mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px]'>
                      <span className='text-neutral-500 dark:text-neutral-400'>
                        Changed{' '}
                        <span className='font-semibold text-neutral-900 dark:text-neutral-100'>
                          {gitSummary.changedFilesCount}
                        </span>
                      </span>
                      <span className='text-neutral-500 dark:text-neutral-400'>
                        Staged{' '}
                        <span className='font-semibold text-neutral-900 dark:text-neutral-100'>
                          {gitSummary.stagedCount}
                        </span>
                      </span>
                      <span className='text-neutral-500 dark:text-neutral-400'>
                        Unstaged{' '}
                        <span className='font-semibold text-neutral-900 dark:text-neutral-100'>
                          {gitSummary.unstagedCount}
                        </span>
                      </span>
                      <span className='text-neutral-500 dark:text-neutral-400'>
                        Untracked{' '}
                        <span className='font-semibold text-neutral-900 dark:text-neutral-100'>
                          {gitSummary.untrackedCount}
                        </span>
                      </span>
                    </div>

                    {gitSummary.remoteUrl && (
                      <div className='mt-3 break-all text-[11px] text-neutral-500 dark:text-neutral-400'>
                        remote: {gitSummary.remoteUrl}
                      </div>
                    )}
                  </div>

                  <div className='border-t border-neutral-200/70 px-2 pt-4 dark:border-neutral-800/70'>
                    <div className='mb-2 flex items-center justify-between gap-2'>
                      <h3 className='text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-500 dark:text-neutral-400'>
                        Changes
                      </h3>
                      <span className='text-[11px] text-neutral-500 dark:text-neutral-400'>
                        {gitSummary.changedFilesCount} file{gitSummary.changedFilesCount === 1 ? '' : 's'}
                      </span>
                    </div>

                    {gitStatusSections.every(section => section.files.length === 0) ? (
                      <div className='text-xs text-neutral-500 dark:text-neutral-400'>Working tree is clean.</div>
                    ) : (
                      <div className='space-y-3'>
                        {gitStatusSections.map(section => (
                          <div key={section.key}>
                            <div className='mb-1 flex items-center justify-between gap-2'>
                              <div className='flex items-center gap-2'>
                                <span className='text-xs font-medium text-neutral-800 dark:text-neutral-200'>
                                  {section.label}
                                </span>
                                <span
                                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${section.badgeClass}`}
                                >
                                  {section.files.length}
                                </span>
                              </div>
                              {section.key === 'unstaged' && (
                                <button
                                  type='button'
                                  onClick={() => void handleGitStageAll()}
                                  disabled={
                                    (gitSummary.unstagedCount === 0 && gitSummary.untrackedCount === 0) ||
                                    gitStageFilesMutation.isPending
                                  }
                                  className='inline-flex h-6 w-6 items-center justify-center rounded-md border border-neutral-200 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 disabled:opacity-50 dark:border-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-neutral-200'
                                  title={
                                    gitStageFilesMutation.isPending
                                      ? 'Staging all changed files'
                                      : 'Stage all changed files'
                                  }
                                  aria-label={
                                    gitStageFilesMutation.isPending
                                      ? 'Staging all changed files'
                                      : 'Stage all changed files'
                                  }
                                >
                                  <i
                                    className={`bx ${gitStageFilesMutation.isPending ? 'bx-loader-circle animate-spin' : 'bx-upload'} text-[12px]`}
                                    aria-hidden='true'
                                  />
                                </button>
                              )}
                            </div>

                            {section.files.length === 0 ? (
                              <div className='text-[11px] text-neutral-500 dark:text-neutral-400'>No files</div>
                            ) : (
                              <div
                                className={
                                  section.key === 'staged' || section.key === 'unstaged' || section.key === 'untracked'
                                    ? 'max-h-56 space-y-1 overflow-y-auto pr-1 thin-scrollbar'
                                    : 'space-y-1.5'
                                }
                              >
                                {section.files.map(file => {
                                  const isSelected =
                                    selectedGitDiff?.relativePath === file.relativePath &&
                                    (section.key === 'staged'
                                      ? Boolean(selectedGitDiff?.staged) && !selectedGitDiff?.untracked
                                      : section.key === 'untracked'
                                        ? Boolean(selectedGitDiff?.untracked)
                                        : !selectedGitDiff?.staged && !selectedGitDiff?.untracked)
                                  const fileStatusDescription = file.isDeleted
                                    ? 'Deleted'
                                    : file.isRenamed
                                      ? 'Renamed'
                                      : file.untracked
                                        ? 'Untracked'
                                        : file.conflicted
                                          ? 'Conflict requires resolution'
                                          : section.key === 'staged'
                                            ? 'Staged'
                                            : 'Modified in working tree'
                                  const normalizedRelativePath = normalizeRelativeGitPath(
                                    file.relativePath || file.displayPath || file.path
                                  )
                                  const fileName = getFileName(normalizedRelativePath || file.displayPath || file.path)
                                  const fileDirectoryPath = normalizedRelativePath.replace(/\/?[^/]+$/, '') || '.'

                                  return (
                                    <div
                                      key={`${section.key}-${file.relativePath}`}
                                      className={`group relative min-w-0 rounded-lg px-1 py-1 transition-colors ${
                                        isSelected
                                          ? 'bg-sky-50/60 dark:bg-sky-500/10'
                                          : 'hover:bg-neutral-100/60 dark:hover:bg-neutral-900/40'
                                      }`}
                                    >
                                      <div className='flex items-start gap-2'>
                                        <span className='mt-0.5 inline-flex h-5 shrink-0 items-center rounded-full bg-neutral-100 px-1.5 text-[9px] font-semibold leading-none text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'>
                                          {file.code}
                                        </span>
                                        <div className='min-w-0 flex-1 pr-28'>
                                          <button
                                            onClick={() => handleSelectGitDiff(file, section.key === 'staged')}
                                            className='w-full min-w-0 text-left'
                                            title={normalizedRelativePath || file.displayPath}
                                          >
                                            <div className='flex min-w-0 items-center gap-1.5'>
                                              <span
                                                className={`truncate text-xs font-medium ${
                                                  isSelected
                                                    ? 'text-sky-700 dark:text-sky-200'
                                                    : 'text-neutral-800 dark:text-neutral-200'
                                                }`}
                                              >
                                                {fileName}
                                              </span>
                                              <span className='truncate text-[10px] text-neutral-500 dark:text-neutral-400'>
                                                {fileDirectoryPath}
                                              </span>
                                            </div>
                                            <div className='mt-0.5 truncate text-[10px] text-neutral-500 dark:text-neutral-400'>
                                              {fileStatusDescription}
                                            </div>
                                          </button>
                                        </div>
                                        <div className='pointer-events-none absolute inset-y-0 right-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100'>
                                          <button
                                            type='button'
                                            onClick={() => openGitDiffTab(file, section.key === 'staged')}
                                            className='pointer-events-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800/70 dark:hover:text-neutral-200'
                                            aria-label='Open diff'
                                            title='Open diff'
                                          >
                                            <i className='bx bx-git-compare text-[12px]' aria-hidden='true' />
                                          </button>
                                          {!file.isDeleted && !isWeb && (
                                            <button
                                              type='button'
                                              onClick={() =>
                                                void openFileEditor(file.path, { relativePath: file.relativePath })
                                              }
                                              className='pointer-events-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800/70 dark:hover:text-neutral-200'
                                              aria-label='Open file'
                                              title='Open file'
                                            >
                                              <i className='bx bx-file text-[12px]' aria-hidden='true' />
                                            </button>
                                          )}
                                          {onFilePathInsert && (
                                            <button
                                              type='button'
                                              onClick={() => onFilePathInsert(file.path)}
                                              className='pointer-events-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800/70 dark:hover:text-neutral-200'
                                              aria-label='Insert path'
                                              title='Insert path'
                                            >
                                              <i className='bx bx-export text-[12px]' aria-hidden='true' />
                                            </button>
                                          )}
                                          {section.key === 'staged' ? (
                                            <button
                                              type='button'
                                              onClick={() => void handleGitUnstageFile(file)}
                                              disabled={gitUnstageFilesMutation.isPending}
                                              className='pointer-events-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-800 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800/70 dark:hover:text-neutral-200'
                                              aria-label='Unstage file'
                                              title='Unstage file'
                                            >
                                              <i className='bx bx-download text-[12px]' aria-hidden='true' />
                                            </button>
                                          ) : (
                                            <button
                                              type='button'
                                              onClick={() => void handleGitStageFile(file)}
                                              disabled={gitStageFilesMutation.isPending}
                                              className='pointer-events-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-800 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800/70 dark:hover:text-neutral-200'
                                              aria-label='Stage file'
                                              title='Stage file'
                                            >
                                              <i className='bx bx-upload text-[12px]' aria-hidden='true' />
                                            </button>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className='border-t border-neutral-200/70 px-2 pt-4 dark:border-neutral-800/70'>
                    <div className='mb-2 flex items-center justify-between gap-2'>
                      <h3 className='text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-500 dark:text-neutral-400'>
                        Diff Preview
                      </h3>
                      {selectedGitDiff && (
                        <span className='text-[11px] text-neutral-500 dark:text-neutral-400'>
                          {selectedGitDiff.staged ? 'staged' : selectedGitDiff.untracked ? 'untracked' : 'working tree'}
                        </span>
                      )}
                    </div>

                    {!selectedGitDiff || !selectedGitStatusFile ? (
                      <div className='text-xs text-neutral-500 dark:text-neutral-400'>
                        Select a changed file, then open its diff in the Monaco dock.
                      </div>
                    ) : (
                      <div className='space-y-1.5'>
                        <div className='text-xs font-medium text-neutral-700 dark:text-neutral-200'>
                          {selectedGitStatusFile.displayPath}
                        </div>
                        <div className='text-[11px] text-neutral-500 dark:text-neutral-400'>
                          Monaco diff opens in the shared editor dock so file editing and git inspection stay in one
                          place.
                        </div>
                        <div className='flex flex-wrap gap-2'>
                          <button
                            type='button'
                            onClick={() => openGitDiffTab(selectedGitStatusFile, Boolean(selectedGitDiff.staged))}
                            className='inline-flex h-7 w-7 items-center justify-center rounded-md border border-neutral-200 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:border-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-neutral-200'
                            title='Open diff'
                            aria-label='Open diff'
                          >
                            <i className='bx bx-git-compare text-sm' aria-hidden='true' />
                          </button>
                          {!selectedGitStatusFile.isDeleted && !isWeb && (
                            <button
                              type='button'
                              onClick={() =>
                                void openFileEditor(selectedGitStatusFile.path, {
                                  relativePath: selectedGitStatusFile.relativePath,
                                })
                              }
                              className='inline-flex h-7 w-7 items-center justify-center rounded-md border border-neutral-200 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:border-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-neutral-200'
                              title='Open file'
                              aria-label='Open file'
                            >
                              <i className='bx bx-file text-sm' aria-hidden='true' />
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className='border-t border-neutral-200/70 px-2 pt-4 dark:border-neutral-800/70'>
                    <div className='mb-2 flex items-center justify-between gap-2'>
                      <h3 className='text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-500 dark:text-neutral-400'>
                        Branches
                      </h3>
                      <span className='text-[11px] text-neutral-500 dark:text-neutral-400'>
                        {gitOverviewData?.branches.local.length || 0} local
                      </span>
                    </div>

                    <div className='mb-3 flex gap-2'>
                      <input
                        value={newGitBranchName}
                        onChange={e => setNewGitBranchName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            void handleGitCreateBranch()
                          }
                        }}
                        placeholder='new-branch-name'
                        className='flex-1 rounded-md border border-transparent bg-neutral-100/70 px-2 py-1.5 text-sm text-neutral-900 focus:border-neutral-300 focus:bg-white dark:bg-neutral-900/60 dark:text-neutral-100 dark:focus:border-neutral-700 dark:focus:bg-neutral-900'
                      />
                      <button
                        type='button'
                        onClick={() => void handleGitCreateBranch()}
                        disabled={!newGitBranchName.trim() || gitCreateBranchMutation.isPending}
                        className='inline-flex h-8 w-8 items-center justify-center rounded-md border border-neutral-200 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 disabled:opacity-50 dark:border-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-neutral-200'
                        title={gitCreateBranchMutation.isPending ? 'Creating branch' : 'Create branch'}
                        aria-label={gitCreateBranchMutation.isPending ? 'Creating branch' : 'Create branch'}
                      >
                        <i
                          className={`bx ${gitCreateBranchMutation.isPending ? 'bx-loader-circle animate-spin' : 'bx-git-branch'} text-sm`}
                          aria-hidden='true'
                        />
                      </button>
                    </div>

                    <div className='space-y-1.5'>
                      {displayedLocalBranches.length === 0 ? (
                        <div className='text-xs text-neutral-500 dark:text-neutral-400'>No local branches.</div>
                      ) : (
                        displayedLocalBranches.map(branch => (
                          <div key={branch.name} className='flex items-center justify-between gap-3 px-1 py-1.5'>
                            <div className='min-w-0 flex-1'>
                              <div className='flex items-center gap-2'>
                                <span className='truncate text-xs font-medium text-neutral-800 dark:text-neutral-200'>
                                  {branch.name}
                                </span>
                                {branch.current && (
                                  <span className='text-[10px] font-medium text-sky-600 dark:text-sky-300'>
                                    current
                                  </span>
                                )}
                              </div>
                              <div className='mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400'>
                                {branch.shortHash || '----'} {branch.relativeDate ? `• ${branch.relativeDate}` : ''}
                              </div>
                            </div>
                            <button
                              type='button'
                              onClick={() => void handleGitCheckoutBranch(branch)}
                              disabled={branch.current || gitCheckoutBranchMutation.isPending}
                              className='shrink-0 text-[11px] font-medium text-neutral-500 transition-colors hover:text-neutral-800 disabled:opacity-50 dark:text-neutral-400 dark:hover:text-neutral-200'
                            >
                              {branch.current ? 'Current' : 'Checkout'}
                            </button>
                          </div>
                        ))
                      )}
                    </div>

                    {displayedRemoteBranches.length > 0 && (
                      <div className='mt-3'>
                        <div className='mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-400'>
                          Remote
                        </div>
                        <div className='space-y-1'>
                          {displayedRemoteBranches.map(branch => (
                            <div key={branch.name} className='text-[11px] text-neutral-600 dark:text-neutral-300'>
                              {branch.name}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className='border-t border-neutral-200/70 px-2 pt-4 dark:border-neutral-800/70'>
                    <div className='mb-2 flex items-center justify-between gap-2'>
                      <h3 className='text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-500 dark:text-neutral-400'>
                        Commit Graph
                      </h3>
                      <span className='text-[11px] text-neutral-500 dark:text-neutral-400'>
                        last {displayedCommitGraphLines.length}
                      </span>
                    </div>
                    {displayedCommitGraphLines.length === 0 ? (
                      <div className='text-xs text-neutral-500 dark:text-neutral-400'>No commit graph available.</div>
                    ) : (
                      <div className='overflow-hidden rounded-lg bg-neutral-950/95'>
                        <pre className='max-h-72 overflow-auto px-3 py-3 font-mono text-[11px] leading-5 text-emerald-100 no-scrollbar whitespace-pre-wrap break-words'>
                          {displayedCommitGraphLines.join('\n')}
                        </pre>
                      </div>
                    )}
                  </div>

                  <div className='border-t border-neutral-200/70 px-2 pt-4 dark:border-neutral-800/70'>
                    <div className='mb-2 flex items-center justify-between gap-2'>
                      <h3 className='text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-500 dark:text-neutral-400'>
                        Recent Commits
                      </h3>
                      <span className='text-[11px] text-neutral-500 dark:text-neutral-400'>
                        last {displayedGitCommits.length}
                      </span>
                    </div>
                    {displayedGitCommits.length === 0 ? (
                      <div className='text-xs text-neutral-500 dark:text-neutral-400'>No commits available.</div>
                    ) : (
                      <div className='space-y-1.5'>
                        {displayedGitCommits.map((commit: GitCommit) => (
                          <div key={commit.hash} className='px-1 py-1.5'>
                            <div className='flex items-center gap-2'>
                              <span className='font-mono text-[10px] font-semibold text-neutral-500 dark:text-neutral-400'>
                                {commit.shortHash}
                              </span>
                              <span className='truncate text-xs font-medium text-neutral-800 dark:text-neutral-200'>
                                {commit.subject}
                              </span>
                            </div>
                            <div className='mt-0.5 text-[10px] text-neutral-500 dark:text-neutral-400'>
                              {commit.author} • {commit.relativeDate}
                              {commit.decorations ? ` • ${commit.decorations}` : ''}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            ) : activeTab === 'terminal' ? (
              <div className='space-y-3'>
                <div className='px-2 py-1'>
                  <div className='flex items-start justify-between gap-3'>
                    <div className='min-w-0 flex-1'>
                      <h3 className='text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-500 dark:text-neutral-400'>
                        Terminal
                      </h3>
                      <div className='mt-1 text-sm font-semibold text-neutral-900 dark:text-neutral-100'>
                        {openTerminalTabs.length} tab{openTerminalTabs.length === 1 ? '' : 's'} •{' '}
                        {openTerminalTabs.filter(tab => tab.status === 'open' || tab.status === 'launching').length}{' '}
                        running
                      </div>
                      <div className='mt-1 text-[11px] text-neutral-500 dark:text-neutral-400'>
                        Launch local shells and reopen them on next app launch.
                      </div>
                    </div>
                    <button
                      type='button'
                      onClick={() => openNewTerminalDock()}
                      disabled={isWeb || !(currentPath || ccCwd)}
                      className='text-[11px] font-medium text-neutral-500 transition-colors hover:text-neutral-800 disabled:opacity-50 dark:text-neutral-400 dark:hover:text-neutral-200'
                    >
                      New
                    </button>
                  </div>

                  <div className='mt-2 flex flex-wrap gap-x-3 gap-y-1'>
                    <button
                      type='button'
                      onClick={() => openNewTerminalDock(currentPath || ccCwd)}
                      disabled={isWeb || !(currentPath || ccCwd)}
                      className='text-[11px] font-medium text-neutral-500 transition-colors hover:text-neutral-800 disabled:opacity-50 dark:text-neutral-400 dark:hover:text-neutral-200'
                    >
                      Current path
                    </button>
                    {ccCwd && currentPath && currentPath !== ccCwd && (
                      <button
                        type='button'
                        onClick={() => openNewTerminalDock(ccCwd)}
                        className='text-[11px] font-medium text-neutral-500 transition-colors hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200'
                      >
                        Root
                      </button>
                    )}
                    {activeTerminalDock && (
                      <button
                        type='button'
                        onClick={() => setActiveDockTabId(getTerminalDockTabId(activeTerminalDock.id))}
                        className='text-[11px] font-medium text-neutral-500 transition-colors hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200'
                      >
                        Focus active
                      </button>
                    )}
                  </div>
                </div>

                <div className='border-t border-neutral-200/70 px-2 pt-4 dark:border-neutral-800/70'>
                  <h3 className='text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-500 dark:text-neutral-400'>
                    Preferences
                  </h3>
                  <div className='mt-2 divide-y divide-neutral-200/70 dark:divide-neutral-800/70'>
                    <button
                      type='button'
                      onClick={() =>
                        setTerminalPreferences(current => ({
                          ...current,
                          restoreSessionsOnLaunch: !current.restoreSessionsOnLaunch,
                        }))
                      }
                      className='group flex w-full items-start justify-between gap-3 py-1.5 text-left'
                    >
                      <div className='min-w-0'>
                        <div className='text-[11px] font-medium text-neutral-900 dark:text-neutral-100'>
                          Restore sessions on launch
                        </div>
                        <div className='mt-0.5 text-[10px] text-neutral-500 dark:text-neutral-400'>
                          Reopen saved terminal tabs after restarting Electron.
                        </div>
                      </div>
                      <span className='inline-flex shrink-0 items-center justify-center rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500 transition-transform duration-150 group-hover:scale-110 group-focus-visible:scale-110 dark:bg-neutral-800 dark:text-neutral-400'>
                        {terminalPreferences.restoreSessionsOnLaunch ? 'On' : 'Off'}
                      </span>
                    </button>
                    <button
                      type='button'
                      onClick={() =>
                        setTerminalPreferences(current => ({
                          ...current,
                          persistHistory: !current.persistHistory,
                        }))
                      }
                      className='group flex w-full items-start justify-between gap-3 py-1.5 text-left'
                    >
                      <div className='min-w-0'>
                        <div className='text-[11px] font-medium text-neutral-900 dark:text-neutral-100'>
                          Persist shell history
                        </div>
                        <div className='mt-0.5 text-[10px] text-neutral-500 dark:text-neutral-400'>
                          Save each terminal buffer so restored tabs show previous output.
                        </div>
                      </div>
                      <span className='inline-flex shrink-0 items-center justify-center rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500 transition-transform duration-150 group-hover:scale-110 group-focus-visible:scale-110 dark:bg-neutral-800 dark:text-neutral-400'>
                        {terminalPreferences.persistHistory ? 'On' : 'Off'}
                      </span>
                    </button>
                  </div>
                </div>

                <div className='border-t border-neutral-200/70 px-2 pt-4 dark:border-neutral-800/70'>
                  <div className='mb-2 flex items-center justify-between gap-2'>
                    <h3 className='text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-500 dark:text-neutral-400'>
                      Open Tabs
                    </h3>
                    <span className='text-[11px] text-neutral-500 dark:text-neutral-400'>
                      {openTerminalTabs.length === 0 ? 'None' : `${openTerminalTabs.length} available`}
                    </span>
                  </div>

                  {openTerminalTabs.length === 0 ? (
                    <div className='text-xs text-neutral-500 dark:text-neutral-400'>
                      No terminal tabs yet. Launch one from above.
                    </div>
                  ) : (
                    <div className='divide-y divide-neutral-200/70 dark:divide-neutral-800/70'>
                      {openTerminalTabs.map(tab => {
                        const tabDockId = getTerminalDockTabId(tab.id)
                        const isFocused = activeDockTabId === tabDockId
                        const statusLabel =
                          tab.status === 'open'
                            ? 'running'
                            : tab.status === 'launching'
                              ? 'launching'
                              : tab.status === 'error'
                                ? 'error'
                                : tab.exitCode == null
                                  ? 'closed'
                                  : `exit ${tab.exitCode}`
                        const statusClassName =
                          tab.status === 'open'
                            ? 'text-emerald-600 dark:text-emerald-300'
                            : tab.status === 'launching'
                              ? 'text-amber-600 dark:text-amber-300'
                              : tab.status === 'error'
                                ? 'text-rose-600 dark:text-rose-300'
                                : 'text-neutral-500 dark:text-neutral-400'

                        return (
                          <div
                            key={tab.id}
                            className={`px-1 py-1.5 transition-colors ${
                              isFocused
                                ? 'rounded-lg bg-violet-50/60 dark:bg-violet-500/10'
                                : 'hover:bg-neutral-100/60 dark:hover:bg-neutral-900/40'
                            }`}
                          >
                            <div className='flex items-start justify-between gap-3'>
                              <button
                                type='button'
                                onClick={() => {
                                  dispatch(uiActions.rightBarExpanded())
                                  setActiveDockTabId(tabDockId)
                                }}
                                className='min-w-0 flex-1 text-left'
                              >
                                <div className='flex min-w-0 items-center gap-2'>
                                  <span className='truncate text-[11px] font-medium text-neutral-900 dark:text-neutral-100'>
                                    {tab.title}
                                  </span>
                                  <span className={`shrink-0 text-[10px] font-medium ${statusClassName}`}>
                                    {statusLabel}
                                  </span>
                                  {isFocused && (
                                    <span className='shrink-0 text-[10px] font-medium text-violet-600 dark:text-violet-300'>
                                      focused
                                    </span>
                                  )}
                                </div>
                                <div
                                  className='mt-0.5 truncate text-[10px] text-neutral-500 dark:text-neutral-400'
                                  title={tab.cwd}
                                >
                                  {tab.cwd}
                                  {tab.history
                                    ? ` • ${Math.min(tab.history.length, TERMINAL_HISTORY_LIMIT).toLocaleString()} chars`
                                    : ''}
                                </div>
                              </button>
                              <div className='mt-0.5 flex shrink-0 flex-wrap items-center justify-end gap-x-2 gap-y-1'>
                                <button
                                  type='button'
                                  onClick={() => {
                                    dispatch(uiActions.rightBarExpanded())
                                    setActiveDockTabId(tabDockId)
                                  }}
                                  className='text-[10px] font-medium text-neutral-500 transition-colors hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200'
                                >
                                  Focus
                                </button>
                                <button
                                  type='button'
                                  onClick={() => restartTerminalDock(tab.id)}
                                  className='text-[10px] font-medium text-neutral-500 transition-colors hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200'
                                >
                                  Restart
                                </button>
                                <button
                                  type='button'
                                  onClick={() => clearTerminalDockBuffer(tab.id)}
                                  className='text-[10px] font-medium text-neutral-500 transition-colors hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200'
                                >
                                  Clear
                                </button>
                                <button
                                  type='button'
                                  onClick={() => closeTerminalDock(tab.id)}
                                  className='text-[10px] font-medium text-neutral-500 transition-colors hover:text-rose-600 dark:text-neutral-400 dark:hover:text-rose-300'
                                >
                                  Close
                                </button>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            ) : activeTab === 'agents' ? (
              <div className='space-y-3'>
                <div>
                  <div className='px-2 pb-1 text-[11px] uppercase tracking-[0.16em] text-neutral-500 dark:text-neutral-400'>
                    Running
                  </div>
                  {activeStreams.length === 0 ? (
                    <div className='text-xs text-neutral-500 dark:text-neutral-400 px-2 py-1'>
                      No active chat streams right now.
                    </div>
                  ) : (
                    <div className='space-y-2'>
                      {activeStreams.map(stream => (
                        <div key={stream.streamId} className='group relative'>
                          <div
                            role='button'
                            tabIndex={0}
                            onClick={() => handleActiveStreamClick(stream)}
                            onKeyDown={event => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                handleActiveStreamClick(stream)
                              }
                            }}
                            className='w-full text-left rounded-lg transition-all duration-200 cursor-pointer border border-transparent hover:border-neutral-200 hover:bg-stone-100/40 dark:hover:border-neutral-700 dark:hover:bg-yBlack-900/20 px-2 py-2'
                          >
                            <div className='flex items-start justify-between gap-2'>
                              <div className='min-w-0 flex-1'>
                                <div className='text-[12px] font-medium text-neutral-900 dark:text-stone-200 truncate'>
                                  {stream.conversationTitle || `Conversation ${stream.conversationId || 'Unknown'}`}
                                </div>
                                <div className='mt-1 text-[11px] text-neutral-500 dark:text-neutral-400 flex flex-wrap gap-2'>
                                  <span className='rounded-full border border-neutral-200 dark:border-neutral-700 px-2 py-0.5'>
                                    {stream.streamType}
                                  </span>
                                  <span className={getActivityBadgeClasses(stream.activityKind)}>
                                    {stream.activityLabel}
                                  </span>
                                  <span className='rounded-full border border-neutral-200 dark:border-neutral-700 px-2 py-0.5'>
                                    stream {summarizeId(stream.streamId)}
                                  </span>
                                  <span className='rounded-full border border-neutral-200 dark:border-neutral-700 px-2 py-0.5'>
                                    anchor {summarizeId(stream.anchorMessageId)}
                                  </span>
                                </div>
                                <div className='mt-1 text-[10px] text-neutral-500 dark:text-neutral-400'>
                                  conversation {summarizeId(stream.conversationId)}
                                </div>
                              </div>
                              <div className='flex flex-col items-end gap-1'>
                                <span className='text-[10px] text-neutral-500 dark:text-neutral-400'>
                                  {new Date(stream.createdAt).toLocaleTimeString()}
                                </span>
                                {stream.hasError && (
                                  <span className='text-[10px] rounded-full border border-rose-300 dark:border-rose-500/40 bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-200 px-2 py-0.5'>
                                    error
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className='border-t border-neutral-200 dark:border-neutral-800' />

                <div>
                  <div className='px-2 pb-1 text-[11px] uppercase tracking-[0.16em] text-neutral-500 dark:text-neutral-400'>
                    History
                  </div>
                  {streamHistory.length === 0 ? (
                    <div className='text-xs text-neutral-500 dark:text-neutral-400 px-2 py-1'>
                      No completed streams yet.
                    </div>
                  ) : (
                    <div className='space-y-2'>
                      {streamHistory.map(stream => (
                        <div key={`history-${stream.streamId}`} className='group relative'>
                          <div
                            role='button'
                            tabIndex={0}
                            onClick={() => handleActiveStreamClick(stream)}
                            onKeyDown={event => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                handleActiveStreamClick(stream)
                              }
                            }}
                            className='w-full text-left rounded-lg transition-all duration-200 cursor-pointer border border-neutral-200/80 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700 bg-stone-50/40 dark:bg-yBlack-900/20 px-2 py-2'
                          >
                            <div className='flex items-start justify-between gap-2'>
                              <div className='min-w-0 flex-1'>
                                <div className='text-[12px] font-medium text-neutral-800 dark:text-stone-200 truncate'>
                                  {stream.conversationTitle || `Conversation ${stream.conversationId || 'Unknown'}`}
                                </div>
                                <div className='mt-1 text-[11px] text-neutral-500 dark:text-neutral-400 flex flex-wrap gap-2'>
                                  <span className='rounded-full border border-neutral-200 dark:border-neutral-700 px-2 py-0.5'>
                                    {stream.streamType}
                                  </span>
                                  <span className={getActivityBadgeClasses(stream.activityKind)}>
                                    {stream.activityLabel}
                                  </span>
                                  <span className='rounded-full border border-neutral-200 dark:border-neutral-700 px-2 py-0.5'>
                                    stream {summarizeId(stream.streamId)}
                                  </span>
                                  {stream.hasError ? (
                                    <span className='text-[10px] rounded-full border border-rose-300 dark:border-rose-500/40 bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-200 px-2 py-0.5'>
                                      ended with error
                                    </span>
                                  ) : (
                                    <span className='text-[10px] rounded-full border border-neutral-200 dark:border-neutral-700 px-2 py-0.5'>
                                      completed
                                    </span>
                                  )}
                                </div>
                              </div>
                              <div className='text-[10px] text-neutral-500 dark:text-neutral-400 whitespace-nowrap'>
                                {new Date(stream.completedAt || stream.createdAt).toLocaleTimeString()}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : activeTab === 'global' ? (
              <div className='flex flex-col h-full'>
                <div className='mb-2 flex flex-col gap-2'>
                  <div className='flex items-start justify-between gap-2'>
                    <div className='flex flex-col flex-1 min-w-0'>
                      <span className='text-xs text-neutral-500 dark:text-neutral-400 uppercase tracking-[0.2em] truncate'>
                        {agentConversationDate ? `${agentSettingsName} - ${agentConversationDate}` : agentSettingsName}
                      </span>
                      <span className='text-sm font-semibold text-neutral-800 dark:text-neutral-100 truncate'>
                        Status: {agentState.status}
                      </span>
                    </div>
                    <div className='flex gap-1 flex-shrink-0 flex-wrap justify-end'>
                      <Button
                        variant='outline2'
                        size='small'
                        onClick={() => globalAgentLoop.start()}
                        disabled={isWeb}
                        className='text-xs'
                        aria-label='Start'
                        title='Start'
                      >
                        🟢
                      </Button>
                      <Button
                        variant='outline2'
                        size='small'
                        onClick={() => globalAgentLoop.pause()}
                        disabled={isWeb}
                        className='text-xs'
                        aria-label='Pause'
                        title='Pause'
                      >
                        🟡
                      </Button>
                      <Button
                        variant='outline2'
                        size='small'
                        onClick={() => globalAgentLoop.startNewSession()}
                        disabled={isWeb}
                        className='text-xs'
                        aria-label='New Session'
                        title='New Session'
                      >
                        🔵
                      </Button>
                      <Button
                        variant='outline2'
                        size='small'
                        onClick={() => globalAgentLoop.stop()}
                        disabled={isWeb}
                        className='text-xs'
                        aria-label='Stop'
                        title='Stop'
                      >
                        🔴
                      </Button>
                    </div>
                  </div>
                  {agentWorkDirectory && (
                    <span
                      className='text-[11px] text-neutral-500 dark:text-neutral-400 truncate'
                      title={agentWorkDirectory}
                    >
                      cwd: {agentWorkDirectory}
                    </span>
                  )}
                </div>

                <div className='flex-1 overflow-y-auto no-scrollbar space-y-2 pr-1'>
                  {agentMessages.length === 0 && !optimisticMessage && (
                    <div className='text-xs text-neutral-500 dark:text-neutral-400'>No global agent messages yet.</div>
                  )}

                  {/* Persisted messages from React Query cache */}
                  {mergedAgentMessages.map(message => (
                    <ChatMessage
                      key={message.id}
                      id={message.id}
                      role={message.role}
                      content={message.content || ''}
                      thinking={message.thinking_block || undefined}
                      toolCalls={parseJsonSafe(message.tool_calls, [])}
                      contentBlocks={normalizeContentBlocks(parseJsonSafe(message.content_blocks, []))}
                      timestamp={message.created_at}
                      width='w-full'
                      colored={false}
                      showInlineActions={false}
                      modelName={message.model_name}
                      onOpenToolHtmlModal={openToolHtmlModal}
                    />
                  ))}

                  {/* Optimistic user message (shown while task is enqueued) */}
                  {optimisticMessage && (
                    <ChatMessage
                      key={optimisticMessage.id}
                      id={optimisticMessage.id}
                      role={optimisticMessage.role}
                      content={optimisticMessage.content}
                      timestamp={optimisticMessage.created_at}
                      width='w-full'
                      colored={false}
                      showInlineActions={false}
                      className='opacity-70' // Visual feedback for optimistic state
                      onOpenToolHtmlModal={openToolHtmlModal}
                    />
                  )}

                  {/* Streaming assistant response from React Query cache */}
                  {agentStreamBuffer && (
                    <ChatMessage
                      id='global-agent-streaming'
                      role='assistant'
                      content={agentStreamBuffer}
                      contentBlocks={[{ type: 'text', index: 0, content: agentStreamBuffer }]}
                      width='w-full'
                      colored={false}
                      showInlineActions={false}
                      onOpenToolHtmlModal={openToolHtmlModal}
                    />
                  )}
                </div>

                <div className='mt-2 flex flex-col gap-2'>
                  <TextArea
                    value={agentInput}
                    onChange={setAgentInput}
                    placeholder='Queue a task for the global agent...'
                    className='w-full resize-none'
                    minRows={2}
                    maxRows={4}
                    fallbackFileSearchRoot={agentWorkDirectory || currentPath || ccCwd || null}
                  />
                  <div className='flex items-center gap-2'>
                    <Button
                      variant='outline2'
                      size='small'
                      onClick={() => {
                        setScheduleModalTab('schedule')
                        setScheduleModalOpen(true)
                      }}
                      className={scheduleEnabled ? 'border-sky-500 text-sky-100 bg-sky-600 hover:bg-sky-700' : ''}
                    >
                      Schedule
                    </Button>
                    <Button variant='outline2' size='small' onClick={handleAgentSend}>
                      Send
                    </Button>
                    <Button
                      variant='outline2'
                      size='small'
                      onClick={handleAgentAbort}
                      disabled={!isAgentStreaming}
                      className={
                        isAgentStreaming
                          ? 'border-rose-500 text-rose-100 bg-rose-600 hover:bg-rose-700 dark:border-rose-500/70'
                          : 'opacity-60'
                      }
                      title={isAgentStreaming ? 'Stop current agent generation' : 'No active generation'}
                    >
                      Stop
                    </Button>
                  </div>
                  <span className='text-[11px] text-neutral-500 dark:text-neutral-400'>{scheduleSummary}</span>
                </div>
              </div>
            ) : (
              // Note tab - show current conversation note editor
              <>
                {!conversationId ? (
                  <div className='text-xs text-neutral-500 dark:text-neutral-400 px-2 py-1'>
                    Select a conversation to add notes
                  </div>
                ) : (
                  <div className='h-full flex flex-col'>
                    <TextArea
                      value={localNote}
                      onChange={handleNoteChange}
                      placeholder='Enter research notes for this conversation...'
                      className='w-full resize-none flex-1'
                      minRows={undefined}
                      maxRows={undefined}
                      fillAvailableHeight={true}
                      autoFocus={false}
                      fallbackFileSearchRoot={currentPath || ccCwd || null}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {scheduleModalVisible && (
        <div className='absolute mb-15 inset-0 z-50 flex items-end bg-black/30 p-2'>
          <div className='w-full max-h-full overflow-y-auto no-scrollbar rounded-xl border border-stone-300 bg-stone-50 p-3 shadow-xl dark:border-stone-700 dark:bg-zinc-900'>
            <div className='mb-2 flex items-center justify-between'>
              <p className='text-sm font-semibold text-stone-900 dark:text-stone-100'>Schedule Task</p>
              <button
                onClick={() => setScheduleModalOpen(false)}
                className='rounded p-1 text-stone-500 transition-colors hover:bg-stone-200 hover:text-stone-900 dark:text-stone-300 dark:hover:bg-zinc-800 dark:hover:text-stone-100'
                title='Close'
              >
                <i className='bx bx-x text-lg' />
              </button>
            </div>

            <div className='mb-3 flex gap-2 rounded-lg border border-stone-200 bg-white p-1 dark:border-stone-700 dark:bg-zinc-800'>
              <button
                onClick={() => setScheduleModalTab('schedule')}
                className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                  scheduleModalTab === 'schedule'
                    ? 'bg-stone-200 text-stone-900 dark:bg-zinc-700 dark:text-stone-100'
                    : 'text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-zinc-700/60'
                }`}
              >
                Schedule
              </button>
              <button
                onClick={() => setScheduleModalTab('queue')}
                className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                  scheduleModalTab === 'queue'
                    ? 'bg-stone-200 text-stone-900 dark:bg-zinc-700 dark:text-stone-100'
                    : 'text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-zinc-700/60'
                }`}
              >
                Queue ({queuedTasks.length})
              </button>
            </div>

            {scheduleModalTab === 'schedule' ? (
              <>
                <div className='mb-3 flex items-center justify-between rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-700'>
                  <div>
                    <p className='text-sm font-medium text-stone-900 dark:text-stone-100'>Enable Schedule</p>
                    <p className='text-xs text-stone-500 dark:text-stone-400'>
                      Send once now, then repeat based on this plan.
                    </p>
                  </div>
                  <button
                    onClick={() => setScheduleEnabled(prev => !prev)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      scheduleEnabled ? 'bg-emerald-500 dark:bg-emerald-600' : 'bg-stone-300 dark:bg-stone-600'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        scheduleEnabled ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                <div className='grid grid-cols-2 gap-2 mb-3'>
                  <label className='flex flex-col gap-1'>
                    <span className='text-xs text-stone-600 dark:text-stone-300'>Repeat Count</span>
                    <input
                      type='number'
                      min={1}
                      step={1}
                      value={scheduleDraft.repeatCount}
                      onChange={e =>
                        setScheduleDraft(prev => ({
                          ...prev,
                          repeatCount: Math.max(1, Number(e.target.value) || 1),
                        }))
                      }
                      className='w-full rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-sm text-stone-900 dark:border-stone-700 dark:bg-zinc-800 dark:text-stone-100'
                    />
                  </label>
                  <label className='flex flex-col gap-1'>
                    <span className='text-xs text-stone-600 dark:text-stone-300'>Every (number)</span>
                    <input
                      type='number'
                      min={1}
                      step={1}
                      value={scheduleDraft.intervalValue}
                      onChange={e =>
                        setScheduleDraft(prev => ({
                          ...prev,
                          preset: 'custom',
                          intervalValue: Math.max(1, Number(e.target.value) || 1),
                        }))
                      }
                      className='w-full rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-sm text-stone-900 dark:border-stone-700 dark:bg-zinc-800 dark:text-stone-100'
                    />
                  </label>
                </div>

                <div className='mb-3 flex gap-2'>
                  <button
                    onClick={() => setScheduleDraft(prev => ({ ...prev, preset: 'custom', intervalUnit: 'seconds' }))}
                    className={`rounded-lg border px-2 py-1 text-xs ${
                      scheduleDraft.intervalUnit === 'seconds'
                        ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200'
                        : 'border-stone-200 text-stone-600 dark:border-stone-700 dark:text-stone-300'
                    }`}
                  >
                    Seconds
                  </button>
                  <button
                    onClick={() => setScheduleDraft(prev => ({ ...prev, preset: 'custom', intervalUnit: 'minutes' }))}
                    className={`rounded-lg border px-2 py-1 text-xs ${
                      scheduleDraft.intervalUnit === 'minutes'
                        ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200'
                        : 'border-stone-200 text-stone-600 dark:border-stone-700 dark:text-stone-300'
                    }`}
                  >
                    Minutes
                  </button>
                  <button
                    onClick={() => setScheduleDraft(prev => ({ ...prev, preset: 'custom', intervalUnit: 'hours' }))}
                    className={`rounded-lg border px-2 py-1 text-xs ${
                      scheduleDraft.intervalUnit === 'hours'
                        ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200'
                        : 'border-stone-200 text-stone-600 dark:border-stone-700 dark:text-stone-300'
                    }`}
                  >
                    Hours
                  </button>
                </div>

                <div className='mb-3'>
                  <p className='mb-1 text-xs text-stone-600 dark:text-stone-300'>Presets</p>
                  <div className='flex flex-wrap gap-2'>
                    {PRESET_CONFIGS.map(preset => (
                      <button
                        key={preset.key}
                        onClick={() => handlePresetSelect(preset.key)}
                        className={`rounded-lg border px-2 py-1 text-xs ${
                          scheduleDraft.preset === preset.key
                            ? 'border-sky-500 bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-200'
                            : 'border-stone-200 text-stone-600 dark:border-stone-700 dark:text-stone-300'
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                    <button
                      onClick={() => handlePresetSelect('custom')}
                      className={`rounded-lg border px-2 py-1 text-xs ${
                        scheduleDraft.preset === 'custom'
                          ? 'border-sky-500 bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-200'
                          : 'border-stone-200 text-stone-600 dark:border-stone-700 dark:text-stone-300'
                      }`}
                    >
                      Custom
                    </button>
                  </div>
                </div>

                <div className='mb-3 grid grid-cols-2 gap-2'>
                  <label className='flex flex-col gap-1'>
                    <span className='text-xs text-stone-600 dark:text-stone-300'>Start Date</span>
                    <input
                      type='date'
                      value={scheduleDraft.startDate}
                      onChange={e => setScheduleDraft(prev => ({ ...prev, startDate: e.target.value }))}
                      className='w-full rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-sm text-stone-900 dark:border-stone-700 dark:bg-zinc-800 dark:text-stone-100'
                    />
                  </label>
                  <label className='flex flex-col gap-1'>
                    <span className='text-xs text-stone-600 dark:text-stone-300'>End Date</span>
                    <input
                      type='date'
                      value={scheduleDraft.endDate}
                      onChange={e => setScheduleDraft(prev => ({ ...prev, endDate: e.target.value }))}
                      className='w-full rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-sm text-stone-900 dark:border-stone-700 dark:bg-zinc-800 dark:text-stone-100'
                    />
                  </label>
                </div>

                <div className='mb-3'>
                  <p className='mb-1 text-xs text-stone-600 dark:text-stone-300'>Allowed Weekdays</p>
                  <div className='flex flex-wrap gap-1'>
                    {WEEKDAY_LABELS.map((label, index) => {
                      const selected = scheduleDraft.allowedWeekdays.includes(index)
                      return (
                        <button
                          key={label}
                          onClick={() => toggleScheduleWeekday(index)}
                          className={`rounded-md border px-2 py-1 text-[11px] ${
                            selected
                              ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200'
                              : 'border-stone-200 text-stone-600 dark:border-stone-700 dark:text-stone-300'
                          }`}
                        >
                          {label}
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className='flex items-center justify-between'>
                  <span className='text-[11px] text-stone-500 dark:text-stone-400'>{scheduleSummary}</span>
                  <div className='flex gap-2'>
                    <Button
                      variant='outline2'
                      size='small'
                      onClick={() => {
                        setScheduleEnabled(false)
                        setScheduleModalOpen(false)
                      }}
                    >
                      Disable
                    </Button>
                    <Button variant='outline2' size='small' onClick={() => setScheduleModalOpen(false)}>
                      Done
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <div className='space-y-3'>
                <div className='flex items-center justify-between'>
                  <p className='text-xs text-stone-600 dark:text-stone-300'>
                    Pending and scheduled tasks are shown here.
                  </p>
                  <span className='text-[11px] text-stone-500 dark:text-stone-400'>
                    {isFetchingQueuedTasks ? 'Refreshing...' : `${queuedTasks.length} queued`}
                  </span>
                </div>

                {isLoadingQueuedTasks ? (
                  <div className='text-xs text-stone-500 dark:text-stone-400'>Loading queued tasks...</div>
                ) : queuedTasks.length === 0 ? (
                  <div className='text-xs text-stone-500 dark:text-stone-400'>No queued tasks.</div>
                ) : (
                  <div className='space-y-2 max-h-80 overflow-y-auto pr-1 no-scrollbar'>
                    {queuedTasks.map(task => {
                      const runAtLabel = getQueuedTaskRunAtLabel(task)
                      const createdAtLabel = task.created_at
                        ? Number.isNaN(Date.parse(task.created_at))
                          ? task.created_at
                          : new Date(task.created_at).toLocaleString()
                        : 'Unknown time'
                      return (
                        <div
                          key={task.id}
                          className='rounded-lg border border-stone-200 bg-white p-2 dark:border-stone-700 dark:bg-zinc-800'
                        >
                          <div className='flex items-start gap-2'>
                            <div className='min-w-0 flex-1'>
                              <p className='text-sm text-stone-900 dark:text-stone-100 break-words'>
                                {task.description}
                              </p>
                              <div className='mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-stone-500 dark:text-stone-400'>
                                <span>Status: {task.status}</span>
                                <span>Queued: {createdAtLabel}</span>
                                {runAtLabel && <span>Run at: {runAtLabel}</span>}
                              </div>
                            </div>
                            <Button
                              variant='outline2'
                              size='small'
                              onClick={() => handleRemoveQueuedTask(task.id)}
                              disabled={removingTaskId === task.id || removeQueuedTaskMutation.isPending}
                              className='text-xs'
                              title='Remove from queue'
                            >
                              {removingTaskId === task.id ? 'Removing...' : 'Remove'}
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                <div className='flex justify-end'>
                  <Button variant='outline2' size='small' onClick={() => setScheduleModalOpen(false)}>
                    Close
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  )
}

export default RightBar
