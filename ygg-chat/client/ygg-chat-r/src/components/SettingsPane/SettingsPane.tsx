import { useQueryClient } from '@tanstack/react-query'
import mammoth from 'mammoth'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AppStoreModal } from '../../containers/appStore'
import { fetchMcpTools, selectCurrentConversationId } from '../../features/chats'
import { convContextSet, systemPromptSet, updateContext, updateSystemPrompt } from '../../features/conversations'
import type { Conversation } from '../../features/conversations/conversationTypes'
import { selectSelectedProject } from '../../features/projects'
import { useAppDispatch, useAppSelector } from '../../hooks/redux'
import { useUserSystemPrompts } from '../../hooks/useUserSystemPrompts'
import { localApi } from '../../utils/api'
import { extractTextFromPdf } from '../../utils/pdfUtils'
import { InputTextArea } from '../InputTextArea/InputTextArea'
import { ThemeManager } from '../ThemeManager/ThemeManager'
import {
  getThemeModeColor,
  type CustomChatTheme,
  saveCustomChatTheme,
  setCustomChatThemeEnabled,
  useCustomChatTheme,
  useHtmlDarkMode,
} from '../ThemeManager/themeConfig'
import { ChatInputBorderAnimationSettings } from './ChatInputBorderAnimationSettings'
import { SendButtonAnimationSettings } from './SendButtonAnimationSettings'
import { useSettingsSectionThemeColors } from './settingsSectionTheme'
import { ToolsSettings } from './ToolsSettings'

type SettingsPaneProps = {
  open: boolean
  onClose: () => void
}

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

type ManagedHookListItem = {
  id: string
  event: 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'Stop'
  command: string
  timeoutMs?: number
  matcher?: string | string[]
  enabled: boolean
  sourceFile: string
  sourceFileName: string
  entryIndex: number
  handlerIndex: number
  handlerLocation: 'entry' | 'hooks'
}

type HooksListResult = {
  success?: boolean
  error?: string
  hooks?: ManagedHookListItem[]
}

type HookToggleResult = {
  success?: boolean
  error?: string
  hook?: ManagedHookListItem
}

const HOOK_EVENT_ORDER: ManagedHookListItem['event'][] = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
]

const TEXT_FILE_EXTENSIONS = [
  '.txt',
  '.md',
  '.markdown',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.json',
  '.py',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.cs',
  '.go',
  '.rs',
  '.kt',
  '.kts',
  '.sh',
  '.bash',
  '.zsh',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.cfg',
  '.sql',
  '.rb',
  '.php',
  '.swift',
  '.gradle',
  '.bat',
  '.ps1',
  '.scala',
  '.erl',
  '.ex',
  '.r',
  '.csv',
  '.log',
]

const isPdfFile = (file: File) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')

const isSupportedTextFile = (file: File) => {
  if (file.type.startsWith('text/')) {
    return true
  }
  const lowerName = file.name.toLowerCase()
  return TEXT_FILE_EXTENSIONS.some(ext => lowerName.endsWith(ext))
}

const isDocxFile = (file: File) =>
  file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
  file.name.toLowerCase().endsWith('.docx')

const extractTextFromDocx = async (file: File): Promise<string> => {
  const arrayBuffer = await file.arrayBuffer()
  const { value: text } = await mammoth.extractRawText({ arrayBuffer })
  return text.trim()
}

export const SettingsPane: React.FC<SettingsPaneProps> = ({ open, onClose }) => {
  const dispatch = useAppDispatch()
  const queryClient = useQueryClient()
  const systemPrompt = useAppSelector(state => state.conversations.systemPrompt ?? '')
  const context = useAppSelector(state => state.conversations.convContext ?? '')
  const conversationId = useAppSelector(selectCurrentConversationId)
  const selectedProject = useAppSelector(selectSelectedProject)
  const conversations = useAppSelector(state => state.conversations.items)
  const tools = useAppSelector(state => state.chat.tools ?? [])
  const { theme: customTheme, enabled: customThemeEnabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()
  const settingsPaneBodyBackgroundColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.settingsPaneBodyBg, isDarkMode)
    : undefined
  const savedCustomThemesColors = useSettingsSectionThemeColors()
  const isWebMode = import.meta.env.VITE_ENVIRONMENT === 'web'

  const [attachmentTarget, setAttachmentTarget] = useState<'system' | 'context'>('system')
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const [promptContextExpanded, setPromptContextExpanded] = useState(false)
  const [appStoreOpen, setAppStoreOpen] = useState(false)

  // Saved custom themes state
  const [savedThemes, setSavedThemes] = useState<ThemeListItem[]>([])
  const [savedThemesLoading, setSavedThemesLoading] = useState(false)
  const [savedThemesExpanded, setSavedThemesExpanded] = useState(false)
  const [savedThemesError, setSavedThemesError] = useState('')
  const [applyingThemeId, setApplyingThemeId] = useState<string | null>(null)

  // Skills section state
  const [skillsExpanded, setSkillsExpanded] = useState(false)
  const [skillUrl, setSkillUrl] = useState('')
  const [hooksExpanded, setHooksExpanded] = useState(false)
  const [managedHooks, setManagedHooks] = useState<ManagedHookListItem[]>([])
  const [hooksLoading, setHooksLoading] = useState(false)
  const [updatingHooks, setUpdatingHooks] = useState<Set<string>>(new Set())
  const [hookActionStatus, setHookActionStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [skillInstallStatus, setSkillInstallStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [skillInstallMessage, setSkillInstallMessage] = useState('')
  const [installedSkills, setInstalledSkills] = useState<
    Array<{ name: string; description: string; enabled: boolean }>
  >([])
  const [skillsLoading, setSkillsLoading] = useState(false)

  // MCP Servers section state
  const [mcpExpanded, setMcpExpanded] = useState(false)
  const [mcpServers, setMcpServers] = useState<
    Array<{
      name: string
      transport?: 'stdio' | 'http'
      type?: 'stdio' | 'http'
      command?: string
      args?: string[]
      url?: string
      headers?: Record<string, string>
      oauth?: {
        tokenEndpointAuthMethod?: 'client_secret_post' | 'none'
        hasClientId?: boolean
        hasAccessToken?: boolean
        hasRefreshToken?: boolean
        expiresAt?: number
      }
      enabled: boolean
      status: 'disconnected' | 'connecting' | 'connected' | 'error'
      error?: string
      toolCount: number
    }>
  >([])
  const [mcpLazyStart, setMcpLazyStart] = useState(true)
  const [mcpLoading, setMcpLoading] = useState(false)
  const [mcpRefreshing, setMcpRefreshing] = useState(false)
  const [mcpAddMode, setMcpAddMode] = useState(false)
  const [newServerName, setNewServerName] = useState('')
  const [newServerTransport, setNewServerTransport] = useState<'stdio' | 'http'>('stdio')
  const [newServerCommand, setNewServerCommand] = useState('')
  const [newServerArgs, setNewServerArgs] = useState('')
  const [newServerUrl, setNewServerUrl] = useState('')
  const [newServerHeadersText, setNewServerHeadersText] = useState('')
  const [newServerOauthClientId, setNewServerOauthClientId] = useState('')
  const [newServerOauthClientSecret, setNewServerOauthClientSecret] = useState('')
  const [newServerOauthScopes, setNewServerOauthScopes] = useState('')
  const [newServerOauthTokenAuthMethod, setNewServerOauthTokenAuthMethod] = useState<'client_secret_post' | 'none'>(
    'client_secret_post'
  )
  const [mcpActionStatus, setMcpActionStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  // Font size offset state (persisted to localStorage)
  const [fontSizeOffset, setFontSizeOffset] = useState<number>(() => {
    try {
      const stored = localStorage.getItem('chat:fontSizeOffset')
      return stored ? parseInt(stored, 10) : 0
    } catch {
      return 0
    }
  })

  const [groupToolReasoningRuns, setGroupToolReasoningRuns] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem('chat:groupToolReasoningRuns')
      return stored === null ? false : stored === 'true'
    } catch {
      return false
    }
  })

  const handleFontSizeChange = useCallback((value: number) => {
    const next = Math.max(-8, Math.min(16, value)) // Clamp between -8 and +16
    setFontSizeOffset(next)
    try {
      localStorage.setItem('chat:fontSizeOffset', String(next))
      window.dispatchEvent(new CustomEvent('fontSizeOffsetChange', { detail: next }))
    } catch {
      // Ignore localStorage errors
    }
  }, [])

  const handleGroupToolReasoningRunsChange = useCallback((enabled: boolean) => {
    setGroupToolReasoningRuns(enabled)
    try {
      localStorage.setItem('chat:groupToolReasoningRuns', String(enabled))
      window.dispatchEvent(new CustomEvent('groupToolReasoningRunsChange', { detail: enabled }))
    } catch {
      // Ignore localStorage errors
    }
  }, [])

  // Use the custom hook for system prompt management
  const {
    prompts: userSystemPrompts,
    loading: promptsLoading,
    selectedPromptId,
    setSelectedPromptId,
    showSavePromptInput,
    setShowSavePromptInput,
    savePromptName,
    setSavePromptName,
    savingPrompt,
    saveError,
    isExistingPrompt,
    matchingPrompt,
    makingDefault,
    handleSelectPrompt,
    handleSaveAsPrompt,
    handleMakeDefault,
    handleRemoveDefault,
    removingDefault,
    resetSaveUI,
  } = useUserSystemPrompts({
    currentPromptContent: systemPrompt,
    isOpen: open,
    onPromptSelect: content => dispatch(systemPromptSet(content)),
  })

  // Track initial values when modal opens to detect changes
  const initialSystemPromptRef = useRef<string | null>(null)
  const initialContextRef = useRef<string | null>(null)
  const prevOpenRef = useRef<boolean>(false)

  const handleChange = useCallback(
    (value: string) => {
      // Only update Redux state for instant UI feedback
      dispatch(systemPromptSet(value))
    },
    [dispatch]
  )

  const handleContextChange = useCallback(
    (value: string) => {
      // Only update Redux state for instant UI feedback
      dispatch(convContextSet(value))
    },
    [dispatch]
  )

  const fetchSavedThemes = useCallback(async () => {
    setSavedThemesLoading(true)
    setSavedThemesError('')

    try {
      const data = await localApi.post<{ result?: ThemeManagerListResult }>('/tools/execute', {
        toolName: 'theme_manager',
        args: {
          action: 'list',
        },
      })

      const result = data?.result
      if (!result?.success) {
        setSavedThemes([])
        setSavedThemesError(result?.error || 'Failed to load saved themes')
        return
      }

      setSavedThemes(result.themes || [])
    } catch (error) {
      setSavedThemes([])
      setSavedThemesError(error instanceof Error ? error.message : 'Failed to load saved themes')
    } finally {
      setSavedThemesLoading(false)
    }
  }, [])

  const handleApplySavedTheme = useCallback(async (themeId: string) => {
    setApplyingThemeId(themeId)
    setSavedThemesError('')

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
        setSavedThemesError(result?.error || 'Theme file could not be read')
        return
      }

      saveCustomChatTheme(result.theme)
      setCustomChatThemeEnabled(true)
    } catch (error) {
      setSavedThemesError(error instanceof Error ? error.message : 'Failed to apply theme')
    } finally {
      setApplyingThemeId(null)
    }
  }, [])

  const fetchManagedHooks = useCallback(async () => {
    setHooksLoading(true)
    try {
      const data = await localApi.get<HooksListResult>('/hooks')
      if (data.success) {
        setManagedHooks(data.hooks || [])
        setHookActionStatus(null)
      } else {
        setManagedHooks([])
        setHookActionStatus({ type: 'error', message: data.error || 'Failed to load hooks' })
      }
    } catch (error) {
      setManagedHooks([])
      setHookActionStatus({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to load hooks',
      })
    } finally {
      setHooksLoading(false)
    }
  }, [])

  const handleToggleHook = useCallback(async (hook: ManagedHookListItem) => {
    const nextEnabled = !hook.enabled
    setUpdatingHooks(prev => new Set(prev).add(hook.id))

    try {
      const data = await localApi.post<HookToggleResult>('/hooks/toggle', {
        sourceFile: hook.sourceFile,
        event: hook.event,
        entryIndex: hook.entryIndex,
        handlerIndex: hook.handlerIndex,
        handlerLocation: hook.handlerLocation,
        enabled: nextEnabled,
      })

      if (data.success && data.hook) {
        setManagedHooks(prev => prev.map(item => (item.id === hook.id ? data.hook! : item)))
        setHookActionStatus({
          type: 'success',
          message: `${nextEnabled ? 'Enabled' : 'Disabled'} hook for ${hook.event}`,
        })
      } else {
        setHookActionStatus({ type: 'error', message: data.error || 'Failed to update hook' })
      }
    } catch (error) {
      setHookActionStatus({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to update hook',
      })
    } finally {
      setUpdatingHooks(prev => {
        const next = new Set(prev)
        next.delete(hook.id)
        return next
      })
      setTimeout(() => setHookActionStatus(null), 3000)
    }
  }, [])

  // Fetch installed skills
  const fetchInstalledSkills = useCallback(async () => {
    setSkillsLoading(true)
    try {
      const data = await localApi.get<{
        success?: boolean
        skills?: Array<{ name: string; description: string; enabled: boolean }>
      }>('/skills')
      if (data.success && data.skills) {
        setInstalledSkills(data.skills)
      }
    } catch (error) {
      console.error('Failed to fetch installed skills:', error)
    } finally {
      setSkillsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (hooksExpanded && !isWebMode) {
      fetchManagedHooks()
    }
  }, [hooksExpanded, fetchManagedHooks, isWebMode])

  // Fetch skills when section is expanded
  useEffect(() => {
    if (skillsExpanded) {
      fetchInstalledSkills()
    }
  }, [skillsExpanded, fetchInstalledSkills])

  // Fetch saved themes when custom theme library section is opened
  useEffect(() => {
    if (open && savedThemesExpanded) {
      fetchSavedThemes()
    }
  }, [open, savedThemesExpanded, fetchSavedThemes])

  // Handle skill installation from URL
  const handleInstallSkill = useCallback(async () => {
    const url = skillUrl.trim()
    if (!url) return

    setSkillInstallStatus('loading')
    setSkillInstallMessage('Downloading and installing skill...')

    try {
      const data = await localApi.post<{ success?: boolean; skillName?: string; error?: string }>(
        '/skills/install/url',
        {
          url,
        }
      )

      if (data.success) {
        setSkillInstallStatus('success')
        setSkillInstallMessage(`Successfully installed "${data.skillName}"`)
        setSkillUrl('')
        // Refresh skills list
        fetchInstalledSkills()
        // Auto-clear success message after 5 seconds
        setTimeout(() => {
          setSkillInstallStatus('idle')
          setSkillInstallMessage('')
        }, 5000)
      } else {
        setSkillInstallStatus('error')
        setSkillInstallMessage(data.error || 'Installation failed')
      }
    } catch (error) {
      setSkillInstallStatus('error')
      setSkillInstallMessage(error instanceof Error ? error.message : 'Network error - is the local server running?')
    }
  }, [skillUrl, fetchInstalledSkills])

  // Handle skill enable/disable toggle
  const handleToggleSkill = useCallback(async (skillName: string, currentEnabled: boolean) => {
    const action = currentEnabled ? 'disable' : 'enable'
    try {
      const data = await localApi.post<{ success?: boolean }>(`/skills/${encodeURIComponent(skillName)}/${action}`)
      if (data.success) {
        // Update local state
        setInstalledSkills(prev => prev.map(s => (s.name === skillName ? { ...s, enabled: !currentEnabled } : s)))
      }
    } catch (error) {
      console.error(`Failed to ${action} skill:`, error)
    }
  }, [])

  // Handle skill uninstall
  const handleUninstallSkill = useCallback(async (skillName: string) => {
    if (!confirm(`Are you sure you want to uninstall "${skillName}"?`)) return

    try {
      const data = await localApi.delete<{ success?: boolean }>(`/skills/${encodeURIComponent(skillName)}`)
      if (data.success) {
        // Remove from local state
        setInstalledSkills(prev => prev.filter(s => s.name !== skillName))
      }
    } catch (error) {
      console.error('Failed to uninstall skill:', error)
    }
  }, [])

  // Fetch MCP servers
  const fetchMcpServers = useCallback(async () => {
    setMcpLoading(true)
    try {
      const data = await localApi.get<{ success?: boolean; servers?: typeof mcpServers }>('/mcp/servers')
      if (data.success && data.servers) {
        setMcpServers(data.servers)
      }
    } catch (error) {
      console.error('Failed to fetch MCP servers:', error)
    } finally {
      setMcpLoading(false)
    }
  }, [])

  const fetchMcpSettings = useCallback(async () => {
    try {
      const data = await localApi.get<{ success?: boolean; settings?: { lazyStart?: boolean } }>('/mcp/settings')
      if (data.success && data.settings) {
        setMcpLazyStart(Boolean(data.settings.lazyStart))
      }
    } catch (error) {
      console.error('Failed to fetch MCP settings:', error)
    }
  }, [])

  // Fetch MCP servers when section is expanded
  useEffect(() => {
    if (mcpExpanded) {
      fetchMcpServers()
      fetchMcpSettings()
    }
  }, [mcpExpanded, fetchMcpServers, fetchMcpSettings])

  // Handle MCP server start/stop
  const handleToggleMcpServer = useCallback(
    async (serverName: string, currentStatus: string) => {
      const action = currentStatus === 'connected' ? 'stop' : 'start'
      try {
        const data = await localApi.post<{ success?: boolean; error?: string }>(
          `/mcp/servers/${encodeURIComponent(serverName)}/${action}`
        )
        if (data.success) {
          setMcpActionStatus({ type: 'success', message: `Server ${action}ed successfully` })
          fetchMcpServers()
          // Refresh MCP tools with orchestrator and Redux after server state change
          if (action === 'start') {
            setTimeout(async () => {
              // First refresh with orchestrator (backend registers tools)
              await localApi.post('/mcp/refresh-tools')
              // Then refresh Redux state (frontend gets tool definitions)
              dispatch(fetchMcpTools())
            }, 1000) // Small delay to let server fully connect
          } else {
            dispatch(fetchMcpTools())
          }
          setTimeout(() => setMcpActionStatus(null), 3000)
        } else {
          setMcpActionStatus({ type: 'error', message: data.error || `Failed to ${action} server` })
        }
      } catch (error) {
        setMcpActionStatus({ type: 'error', message: `Failed to ${action} server` })
      }
    },
    [fetchMcpServers, dispatch]
  )

  // Handle MCP server removal
  const handleRemoveMcpServer = useCallback(async (serverName: string) => {
    if (!confirm(`Are you sure you want to remove "${serverName}"?`)) return

    try {
      const data = await localApi.delete<{ success?: boolean }>(`/mcp/servers/${encodeURIComponent(serverName)}`)
      if (data.success) {
        setMcpServers(prev => prev.filter(s => s.name !== serverName))
        setMcpActionStatus({ type: 'success', message: 'Server removed' })
        setTimeout(() => setMcpActionStatus(null), 3000)
      }
    } catch (error) {
      console.error('Failed to remove MCP server:', error)
    }
  }, [])

  // Handle adding new MCP server
  const handleAddMcpServer = useCallback(async () => {
    const name = newServerName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
    const command = newServerCommand.trim()
    const args = newServerArgs.trim().split(/\s+/).filter(Boolean)
    const url = newServerUrl.trim()
    const oauthClientId = newServerOauthClientId.trim()
    const oauthClientSecret = newServerOauthClientSecret.trim()
    const oauthScopes = newServerOauthScopes
      .split(/[,\s]+/)
      .map(scope => scope.trim())
      .filter(Boolean)

    let parsedHeaders: Record<string, string> | undefined
    const headersText = newServerHeadersText.trim()

    if (headersText) {
      try {
        const parsed = JSON.parse(headersText)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setMcpActionStatus({
            type: 'error',
            message: 'Headers must be a JSON object, e.g. {"Authorization":"Bearer ..."}',
          })
          return
        }

        parsedHeaders = Object.fromEntries(
          Object.entries(parsed).map(([key, value]) => [key, typeof value === 'string' ? value : String(value)])
        )
      } catch {
        setMcpActionStatus({
          type: 'error',
          message: 'Invalid headers JSON. Example: {"Authorization":"Bearer <token>"}',
        })
        return
      }
    }

    if (!name) {
      setMcpActionStatus({ type: 'error', message: 'Server name is required' })
      return
    }

    if (newServerTransport === 'stdio' && !command) {
      setMcpActionStatus({ type: 'error', message: 'Command is required for stdio MCP servers' })
      return
    }

    if (newServerTransport === 'http' && !url) {
      setMcpActionStatus({ type: 'error', message: 'URL is required for remote MCP servers' })
      return
    }

    if (
      newServerTransport === 'http' &&
      oauthClientId &&
      newServerOauthTokenAuthMethod === 'client_secret_post' &&
      !oauthClientSecret
    ) {
      setMcpActionStatus({
        type: 'error',
        message: 'OAuth client secret is required when using client_secret_post auth',
      })
      return
    }

    const parsedOAuth =
      newServerTransport === 'http' && (oauthClientId || oauthClientSecret || oauthScopes.length > 0)
        ? {
            clientId: oauthClientId || undefined,
            clientSecret: oauthClientSecret || undefined,
            scopes: oauthScopes.length > 0 ? oauthScopes : undefined,
            tokenEndpointAuthMethod: newServerOauthTokenAuthMethod,
          }
        : undefined

    try {
      const payload =
        newServerTransport === 'http'
          ? {
              name,
              transport: 'http' as const,
              type: 'http' as const,
              url,
              headers: parsedHeaders,
              oauth: parsedOAuth,
              enabled: true,
            }
          : {
              name,
              transport: 'stdio' as const,
              type: 'stdio' as const,
              command,
              args,
              enabled: true,
            }

      const data = await localApi.post<{ success?: boolean; error?: string }>('/mcp/servers', payload)
      if (data.success) {
        setMcpActionStatus({ type: 'success', message: `Server "${name}" added` })
        setNewServerName('')
        setNewServerCommand('')
        setNewServerArgs('')
        setNewServerUrl('')
        setNewServerHeadersText('')
        setNewServerOauthClientId('')
        setNewServerOauthClientSecret('')
        setNewServerOauthScopes('')
        setNewServerOauthTokenAuthMethod('client_secret_post')
        setNewServerTransport('stdio')
        setMcpAddMode(false)
        fetchMcpServers()
        // Refresh MCP tools after adding server (backend auto-registers, then update Redux)
        setTimeout(async () => {
          await localApi.post('/mcp/refresh-tools')
          dispatch(fetchMcpTools())
        }, 1500)
        setTimeout(() => setMcpActionStatus(null), 3000)
      } else {
        setMcpActionStatus({ type: 'error', message: data.error || 'Failed to add server' })
      }
    } catch (error) {
      setMcpActionStatus({ type: 'error', message: 'Network error' })
    }
  }, [
    newServerName,
    newServerTransport,
    newServerCommand,
    newServerArgs,
    newServerUrl,
    newServerHeadersText,
    newServerOauthClientId,
    newServerOauthClientSecret,
    newServerOauthScopes,
    newServerOauthTokenAuthMethod,
    fetchMcpServers,
    dispatch,
  ])

  const handleRefreshMcpTools = useCallback(async () => {
    setMcpRefreshing(true)
    try {
      const data = await localApi.post<{ success?: boolean; error?: string }>('/mcp/refresh-tools')
      if (data.success) {
        dispatch(fetchMcpTools())
        fetchMcpServers()
        setMcpActionStatus({ type: 'success', message: 'MCP tools refreshed' })
      } else {
        setMcpActionStatus({ type: 'error', message: data.error || 'Failed to refresh MCP tools' })
      }
    } catch (error) {
      setMcpActionStatus({ type: 'error', message: 'Failed to refresh MCP tools' })
    } finally {
      setMcpRefreshing(false)
      setTimeout(() => setMcpActionStatus(null), 3000)
    }
  }, [dispatch, fetchMcpServers])

  const handleToggleMcpLazyStart = useCallback(async () => {
    const nextValue = !mcpLazyStart
    setMcpLazyStart(nextValue)
    try {
      const data = await localApi.put<{ success?: boolean; error?: string }>('/mcp/settings', { lazyStart: nextValue })
      if (data.success) {
        setMcpActionStatus({
          type: 'success',
          message: nextValue
            ? 'Lazy start enabled (servers won’t auto-start)'
            : 'Auto-start enabled (restart app to start servers)',
        })
      } else {
        setMcpActionStatus({ type: 'error', message: data.error || 'Failed to update MCP settings' })
        setMcpLazyStart(!nextValue)
      }
    } catch (error) {
      setMcpActionStatus({ type: 'error', message: 'Failed to update MCP settings' })
      setMcpLazyStart(!nextValue)
    } finally {
      setTimeout(() => setMcpActionStatus(null), 3000)
    }
  }, [mcpLazyStart])

  const handleAttachmentInputChange = useCallback(
    (target: 'system' | 'context') => async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || [])
      if (files.length === 0) return

      const pdfFiles = files.filter(isPdfFile)
      const docxFiles = files.filter(isDocxFile)
      const textFiles = files.filter(file => !isPdfFile(file) && !isDocxFile(file) && isSupportedTextFile(file))
      if (pdfFiles.length === 0 && docxFiles.length === 0 && textFiles.length === 0) {
        e.target.value = ''
        return
      }

      const collected: string[] = []

      if (pdfFiles.length > 0) {
        try {
          const pdfTexts = await Promise.all(
            pdfFiles.map(
              async file => `[Pdf Content for ${file.name}]:
${await extractTextFromPdf(file)}`
            )
          )
          collected.push(...pdfTexts)
        } catch (err) {
          console.error('Failed to extract PDF text(s)', err)
        }
      }

      if (textFiles.length > 0) {
        const textBlocks = await Promise.all(
          textFiles.map(async file => {
            try {
              const text = await file.text()
              return `[Text Content for ${file.name}]:
${text}`
            } catch (err) {
              console.error(`Failed to read text file ${file.name}`, err)
              return null
            }
          })
        )
        collected.push(...textBlocks.filter((block): block is string => Boolean(block)))
      }

      if (docxFiles.length > 0) {
        const docxBlocks = await Promise.all(
          docxFiles.map(async file => {
            try {
              const text = await extractTextFromDocx(file)
              return `[Docx Content for ${file.name}]:
${text}`
            } catch (err) {
              console.error(`Failed to extract DOCX text for ${file.name}`, err)
              return null
            }
          })
        )
        collected.push(...docxBlocks.filter((block): block is string => Boolean(block)))
      }

      if (collected.length === 0) {
        e.target.value = ''
        return
      }

      const block = `\`\`\`
${collected.join('')}
\`\`\`

`

      if (target === 'system') {
        const next = systemPrompt
          ? `${systemPrompt}

${block}`
          : block
        dispatch(systemPromptSet(next))
      } else {
        const next = context
          ? `${context}

${block}`
          : block
        dispatch(convContextSet(next))
      }

      e.target.value = ''
    },
    [context, dispatch, systemPrompt]
  )

  // Capture initial values when modal opens and save changes when it closes
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      initialSystemPromptRef.current = systemPrompt
      initialContextRef.current = context
    }

    if (!open && prevOpenRef.current) {
      if (conversationId) {
        const currentSystemPrompt = systemPrompt.trim() === '' ? null : systemPrompt
        const currentContext = context.trim() === '' ? null : context
        const initialSystemPrompt =
          initialSystemPromptRef.current?.trim() === '' ? null : initialSystemPromptRef.current
        const initialContext = initialContextRef.current?.trim() === '' ? null : initialContextRef.current

        const systemPromptChanged = currentSystemPrompt !== initialSystemPrompt
        const contextChanged = currentContext !== initialContext

        const currentConversation = conversations.find(conv => conv.id === conversationId) || null
        const projectId = currentConversation?.project_id || selectedProject?.id || null

        const updateSystemPromptInCache = (items: Conversation[] | undefined) => {
          if (!items) return items
          return items.map(conv =>
            conv.id === conversationId ? { ...conv, system_prompt: currentSystemPrompt } : conv
          )
        }

        const updateContextInCache = (items: Conversation[] | undefined) => {
          if (!items) return items
          return items.map(conv =>
            conv.id === conversationId ? { ...conv, conversation_context: currentContext } : conv
          )
        }

        if (systemPromptChanged) {
          dispatch(updateSystemPrompt({ id: conversationId, systemPrompt: currentSystemPrompt }))
            .unwrap()
            .then(() => {
              queryClient.setQueryData<Conversation[]>(['conversations'], updateSystemPromptInCache)
              if (projectId) {
                queryClient.setQueryData<Conversation[]>(
                  ['conversations', 'project', projectId],
                  updateSystemPromptInCache
                )
              }
              queryClient.setQueryData<Conversation[]>(['conversations', 'recent'], updateSystemPromptInCache)
              queryClient.setQueryData(['conversations', conversationId, 'data'], (prev: any) =>
                prev ? { ...prev, systemPrompt: currentSystemPrompt } : prev
              )
            })
            .catch(error => {
              console.error('Failed to update system prompt:', error)
            })
        }

        if (contextChanged) {
          dispatch(updateContext({ id: conversationId, context: currentContext }))
            .unwrap()
            .then(() => {
              queryClient.setQueryData<Conversation[]>(['conversations'], updateContextInCache)
              if (projectId) {
                queryClient.setQueryData<Conversation[]>(['conversations', 'project', projectId], updateContextInCache)
              }
              queryClient.setQueryData<Conversation[]>(['conversations', 'recent'], updateContextInCache)
              queryClient.setQueryData(['conversations', conversationId, 'data'], (prev: any) =>
                prev ? { ...prev, context: currentContext } : prev
              )
            })
            .catch(error => {
              console.error('Failed to update context:', error)
            })
        }
      }

      initialSystemPromptRef.current = null
      initialContextRef.current = null
    }

    prevOpenRef.current = open
  }, [open, conversationId, systemPrompt, context, conversations, dispatch, queryClient, selectedProject])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (!open) {
      setAppStoreOpen(false)
    }
  }, [open])

  if (!open) return null

  const hooksByEvent = HOOK_EVENT_ORDER.map(event => ({
    event,
    hooks: managedHooks.filter(hook => hook.event === event),
  })).filter(group => group.hooks.length > 0)

  return (
    <div className='fixed inset-0 z-400 flex items-center justify-center'>
      {/* Overlay */}
      <div
        className='fixed inset-0 bg-neutral-300/50 dark:bg-neutral-900/20 bg-opacity-50 backdrop-blur-sm'
        onClick={onClose}
      />

      {/* Modal */}
      <div className='py-2 w-full max-w-5xl'>
        <div
          className={`relative z-50 mx-4 rounded-3xl px-12 py-4 lg:py-6 dark:border-1 dark:border-neutral-900 bg-neutral-100 dark:bg-yBlack-900 shadow-lg overflow-y-scroll no-scrollbar transition-all duration-300 ease-in-out ${
            tools.some(tool => tool.enabled) ? 'h-[80vh]' : 'h-[58vh]'
          }`}
          onClick={e => e.stopPropagation()}
          style={{
            scrollbarGutter: 'stable',
            backgroundColor: settingsPaneBodyBackgroundColor,
          }}
        >
          <div className='flex justify-between items-center mb-3 py-4'>
            <h2 className='text-2xl font-semibold text-stone-800 dark:text-stone-200'>Chat Settings</h2>
            <div className='flex items-center gap-2'>
              <button
                onClick={() => setAppStoreOpen(true)}
                className='p-1 rounded-md transition-all duration-200 hover:scale-95 active:scale-100'
                aria-label='Open App Store'
                title='App Store'
              >
                <span className='relative text-xl font-semibold leading-none text-gray-600 dark:text-neutral-200'>
                  {' '}
                  APP STORE{' '}
                </span>
              </button>
              <button
                onClick={onClose}
                className='p-1 rounded-md leading-none transition-colors'
                aria-label='Close settings'
              >
                <i className='bx bx-x text-3xl text-gray-600 dark:text-gray-400 active:scale-95'></i>
              </button>
            </div>
          </div>

          <div className='space-y-6'>
            {/* Hidden attachment input used for both system prompt + context */}
            <input
              ref={attachmentInputRef}
              type='file'
              accept='application/pdf,text/plain,text/markdown,text/javascript,text/typescript,text/json,.md,.markdown,.js,.jsx,.ts,.tsx,.json,.py,.java,.c,.cpp,.h,.cs,.go,.rs,.kt,.kts,.sh,.bash,.zsh,.yml,.yaml,.toml,.ini,.cfg,.sql,.rb,.php,.swift,.gradle,.bat,.ps1,.scala,.erl,.ex,.r,.csv,.log,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx'
              multiple
              onChange={handleAttachmentInputChange(attachmentTarget)}
              className='hidden'
              aria-hidden='true'
            />

            {/* System Prompt and Context Collapsible Section */}
            <div className='space-y-2'>
              <button
                type='button'
                onClick={() => setPromptContextExpanded(!promptContextExpanded)}
                className='flex items-center justify-between w-full text-left'
              >
                <span className='text-[16px] font-medium text-stone-700 dark:text-stone-200'>
                  System Prompt and Context
                </span>
                <i
                  className={`bx bx-chevron-down text-xl text-neutral-500 dark:text-neutral-400 transition-transform duration-200 ${promptContextExpanded ? 'rotate-180' : ''}`}
                />
              </button>

              {promptContextExpanded && (
                <div className='space-y-6 pl-1 pt-2'>
                  {/* System Prompt Section */}
                  <div className='space-y-2'>
                    <div className='flex items-center justify-between'>
                      <span className='text-sm font-medium text-stone-700 dark:text-stone-200'>System prompt</span>
                      <button
                        type='button'
                        onClick={() => {
                          setAttachmentTarget('system')
                          attachmentInputRef.current?.click()
                        }}
                        className='flex items-center gap-1 text-sm text-blue-600 dark:text-blue-300 hover:underline'
                      >
                        <i className='bx bx-paperclip text-lg' aria-hidden='true'></i>
                        Attach File
                      </button>
                    </div>

                    {/* User System Prompts horizontal scrolling list */}
                    {userSystemPrompts.length > 0 && (
                      <div className='mb-2'>
                        <p className='text-sm text-neutral-600 dark:text-neutral-400 mb-2'>Select a saved prompt:</p>
                        <div className='flex gap-2 overflow-x-auto pb-2 thin-scrollbar'>
                          {userSystemPrompts.map(prompt => (
                            <button
                              key={prompt.id}
                              onClick={() => handleSelectPrompt(prompt)}
                              className={`flex items-center justify-center gap-2 flex-shrink-0 h-10 px-4 rounded-xl border transition-all duration-150 ${
                                selectedPromptId === prompt.id
                                  ? 'bg-sky-600/70 text-white border-transparent'
                                  : 'bg-neutral-50 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 border-transparent dark:border-transparent hover:bg-neutral-100 dark:hover:bg-neutral-700'
                              }`}
                              title={prompt.description || prompt.content.substring(0, 100)}
                            >
                              <span className='font-medium text-sm whitespace-nowrap'>{prompt.name}</span>
                              {prompt.is_default && (
                                <span className=' pt-0.5 text-xs opacity-70'>
                                  <i className='bx bxs-star text-base'></i>
                                </span>
                              )}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {promptsLoading && (
                      <div className='mb-2 text-sm text-neutral-500 dark:text-neutral-400'>
                        Loading saved prompts...
                      </div>
                    )}

                    <InputTextArea
                      placeholder='Enter a system prompt to guide the assistant...'
                      value={systemPrompt}
                      onChange={value => {
                        handleChange(value)
                        // Clear selection if user manually edits the prompt
                        if (selectedPromptId) setSelectedPromptId(null)
                      }}
                      minRows={10}
                      maxRows={16}
                      width='w-full'
                      showCharCount
                      outline={true}
                      showHelp={false}
                      variant='outline'
                      className='drop-shadow-xl shadow-[0_0px_12px_3px_rgba(0,0,0,0.05),0_0px_2px_0px_rgba(0,0,0,0.1)] dark:shadow-[0_0px_24px_2px_rgba(0,0,0,0.5),0_0px_2px_2px_rgba(0,0,0,0)]'
                    />

                    {/* Save as Prompt / Make Default button */}
                    {systemPrompt.trim() && (
                      <div className='mt-3'>
                        {isExistingPrompt ? (
                          // Show "Make Default" or "Remove Default" button when prompt already exists
                          matchingPrompt &&
                          (matchingPrompt.is_default ? (
                            <button
                              type='button'
                              onClick={handleRemoveDefault}
                              disabled={removingDefault}
                              className='flex items-center gap-2 text-sm text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 transition-colors disabled:opacity-50'
                            >
                              <i className='bx bxs-star text-base'></i>
                              {removingDefault ? 'Removing...' : 'Remove Default'}
                            </button>
                          ) : (
                            <button
                              type='button'
                              onClick={handleMakeDefault}
                              disabled={makingDefault}
                              className='flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 transition-colors disabled:opacity-50'
                            >
                              <i className='bx bx-star text-base'></i>
                              {makingDefault ? 'Setting...' : 'Make Default'}
                            </button>
                          ))
                        ) : (
                          // Show "Save as Prompt" when content doesn't match existing prompt
                          <>
                            {!showSavePromptInput ? (
                              <button
                                type='button'
                                onClick={() => setShowSavePromptInput(true)}
                                className='flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors'
                              >
                                <i className='bx bx-save text-base'></i>
                                Save as Prompt
                              </button>
                            ) : (
                              <div className='space-y-2'>
                                <div className='flex items-center gap-2'>
                                  <input
                                    type='text'
                                    value={savePromptName}
                                    onChange={e => setSavePromptName(e.target.value)}
                                    placeholder='Enter prompt name...'
                                    maxLength={100}
                                    className='flex-1 px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-transparent'
                                    autoFocus
                                    onKeyDown={e => {
                                      if (e.key === 'Enter') handleSaveAsPrompt()
                                      if (e.key === 'Escape') resetSaveUI()
                                    }}
                                  />
                                  <button
                                    type='button'
                                    onClick={handleSaveAsPrompt}
                                    disabled={!savePromptName.trim() || savingPrompt}
                                    className='px-3 py-2 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
                                  >
                                    {savingPrompt ? 'Saving...' : 'Save'}
                                  </button>
                                  <button
                                    type='button'
                                    onClick={resetSaveUI}
                                    className='px-2 py-2 text-sm text-neutral-600 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 transition-colors'
                                  >
                                    <i className='bx bx-x text-lg'></i>
                                  </button>
                                </div>
                                {saveError && <p className='text-sm text-red-500 dark:text-red-400'>{saveError}</p>}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Context Section */}
                  <div className='space-y-2'>
                    <div className='flex items-center justify-between'>
                      <span className='text-sm font-medium text-stone-700 dark:text-stone-200'>Context</span>
                      <button
                        type='button'
                        onClick={() => {
                          setAttachmentTarget('context')
                          attachmentInputRef.current?.click()
                        }}
                        className='flex items-center gap-1 text-sm text-blue-600 dark:text-blue-300 hover:underline'
                      >
                        <i className='bx bx-paperclip text-lg' aria-hidden='true'></i>
                        Attach File
                      </button>
                    </div>
                    <InputTextArea
                      placeholder='Enter a context to augment your chat...'
                      value={context}
                      onChange={handleContextChange}
                      minRows={10}
                      maxRows={16}
                      width='w-full'
                      variant='outline'
                      outline={true}
                      showHelp={false}
                      showCharCount={true}
                      className='drop-shadow-xl shadow-[0_0px_12px_3px_rgba(0,0,0,0.05),0_0px_2px_0px_rgba(0,0,0,0.1)] dark:shadow-[0_0px_24px_2px_rgba(0,0,0,0.5),0_0px_2px_2px_rgba(0,0,0,0)]'
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Font Size Section */}
            <div className='space-y-2'>
              <div
                className='overflow-hidden rounded-2xl bg-neutral-50/70 dark:bg-neutral-900/10'
                style={
                  savedCustomThemesColors
                    ? {
                        backgroundColor: savedCustomThemesColors.cardBg,
                        borderColor: savedCustomThemesColors.cardBorder,
                      }
                    : undefined
                }
              >
                <div className='flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-start sm:justify-between'>
                  <div className='flex min-w-0 items-start gap-3'>
                    <div
                      className='mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300'
                      style={
                        savedCustomThemesColors
                          ? {
                              backgroundColor: savedCustomThemesColors.accentBg,
                              color: savedCustomThemesColors.accentText,
                            }
                          : undefined
                      }
                    >
                      <i className='bx bx-text text-lg' />
                    </div>
                    <div className='min-w-0'>
                      <p
                        className='text-sm font-medium text-stone-700 dark:text-neutral-100'
                        style={savedCustomThemesColors ? { color: savedCustomThemesColors.titleText } : undefined}
                      >
                        Message font size
                      </p>
                      <p
                        className='mt-0.5 text-xs text-neutral-500 dark:text-neutral-100'
                        style={savedCustomThemesColors ? { color: savedCustomThemesColors.bodyText } : undefined}
                      >
                        Adjust the base font size used for chat messages.
                      </p>
                    </div>
                  </div>
                  <span
                    className='inline-flex w-fit shrink-0 rounded-full bg-neutral-200/80 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.08em] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-100'
                    style={
                      savedCustomThemesColors
                        ? {
                            backgroundColor: savedCustomThemesColors.badgeBg,
                            color: savedCustomThemesColors.badgeText,
                          }
                        : undefined
                    }
                  >
                    {fontSizeOffset === 0 ? 'Default' : `${fontSizeOffset > 0 ? '+' : ''}${fontSizeOffset}px`}
                  </span>
                </div>

                <div className='px-3 pb-3 pt-1'>
                  <div
                    className='flex items-center gap-3 rounded-xl bg-neutral-100/70 px-3 py-3 dark:bg-neutral-900/25'
                    style={
                      savedCustomThemesColors
                        ? {
                            backgroundColor: savedCustomThemesColors.innerCardBg,
                            borderColor: savedCustomThemesColors.innerCardBorder,
                          }
                        : undefined
                    }
                  >
                    <span
                      className='w-7 shrink-0 text-xs text-neutral-500 dark:text-neutral-100'
                      style={savedCustomThemesColors ? { color: savedCustomThemesColors.bodyText } : undefined}
                    >
                      -8
                    </span>
                    <input
                      type='range'
                      min={-8}
                      max={16}
                      step={1}
                      value={fontSizeOffset}
                      onChange={e => handleFontSizeChange(parseInt(e.target.value, 10))}
                      className='h-2 flex-1 cursor-pointer appearance-none rounded-lg bg-neutral-200 dark:bg-neutral-700'
                      style={
                        savedCustomThemesColors
                          ? {
                              backgroundColor: savedCustomThemesColors.codeBg,
                              accentColor: savedCustomThemesColors.primaryButtonBg,
                            }
                          : undefined
                      }
                    />
                    <span
                      className='w-8 shrink-0 text-xs text-neutral-500 dark:text-neutral-100'
                      style={savedCustomThemesColors ? { color: savedCustomThemesColors.bodyText } : undefined}
                    >
                      +16
                    </span>
                    <button
                      type='button'
                      onClick={() => handleFontSizeChange(0)}
                      className={`inline-flex shrink-0 items-center rounded-lg px-3 py-1.5 text-sm font-medium text-neutral-700 dark:text-neutral-100 transition-all duration-150 hover:bg-neutral-200 active:scale-[0.98] active:bg-neutral-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 dark:hover:bg-neutral-700 dark:active:bg-neutral-700/90 dark:focus-visible:ring-violet-500/40 ${fontSizeOffset === 0 ? 'invisible' : ''}`}
                      style={
                        savedCustomThemesColors
                          ? {
                              backgroundColor: savedCustomThemesColors.buttonBg,
                              color: savedCustomThemesColors.buttonText,
                            }
                          : undefined
                      }
                      title='Reset to default'
                    >
                      Reset
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Process Step Grouping Section */}
            <div className='space-y-2'>
              <div
                className='overflow-hidden rounded-2xl bg-neutral-50/70 dark:bg-neutral-900/10'
                style={
                  savedCustomThemesColors
                    ? {
                        backgroundColor: savedCustomThemesColors.cardBg,
                        borderColor: savedCustomThemesColors.cardBorder,
                      }
                    : undefined
                }
              >
                <div className='flex items-start justify-between gap-3 px-3 py-3'>
                  <div className='flex min-w-0 items-start gap-3'>
                    <div
                      className='mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300'
                      style={
                        savedCustomThemesColors
                          ? {
                              backgroundColor: savedCustomThemesColors.accentBg,
                              color: savedCustomThemesColors.accentText,
                            }
                          : undefined
                      }
                    >
                      <i className='bx bx-git-branch text-lg' />
                    </div>
                    <div className='min-w-0 pr-3'>
                      <p
                        className='text-sm font-medium text-stone-700 dark:text-neutral-100'
                        style={savedCustomThemesColors ? { color: savedCustomThemesColors.titleText } : undefined}
                      >
                        Group continuous reasoning/tool steps
                      </p>
                      <p
                        className='mt-0.5 text-xs text-neutral-500 dark:text-neutral-100'
                        style={savedCustomThemesColors ? { color: savedCustomThemesColors.bodyText } : undefined}
                      >
                        Collapse long chains of agent reasoning and tool calls into one expandable section.
                      </p>
                    </div>
                  </div>
                  <button
                    type='button'
                    onClick={() => handleGroupToolReasoningRunsChange(!groupToolReasoningRuns)}
                    className='rounded-lg p-1.5 text-neutral-500 dark:text-neutral-100 transition-all duration-150 hover:bg-neutral-200/90 active:scale-95 active:bg-neutral-300/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 dark:hover:bg-neutral-700/80 dark:active:bg-neutral-700 dark:focus-visible:ring-violet-500/40'
                    style={
                      savedCustomThemesColors
                        ? {
                            backgroundColor: savedCustomThemesColors.buttonBg,
                            color: savedCustomThemesColors.buttonText,
                          }
                        : undefined
                    }
                    title={groupToolReasoningRuns ? 'Disable grouping' : 'Enable grouping'}
                    aria-pressed={groupToolReasoningRuns}
                  >
                    <i
                      className={`bx ${groupToolReasoningRuns ? 'bx-toggle-right' : 'bx-toggle-left'} text-2xl`}
                      style={
                        groupToolReasoningRuns && savedCustomThemesColors
                          ? { color: savedCustomThemesColors.primaryButtonBg }
                          : undefined
                      }
                    ></i>
                  </button>
                </div>
              </div>
            </div>

            {/* Send Button Animation Section */}
            <div className='space-y-2'>
              <SendButtonAnimationSettings sectionThemeColors={savedCustomThemesColors} />
            </div>

            {/* Chat Input Border Animation Section */}
            <div className='space-y-2'>
              <ChatInputBorderAnimationSettings sectionThemeColors={savedCustomThemesColors} />
            </div>

            {/* Custom Theme Section */}
            <div className='space-y-2'>
              <div
                className='overflow-hidden rounded-2xl bg-neutral-50/70 dark:bg-neutral-900/10'
                style={
                  savedCustomThemesColors
                    ? {
                        backgroundColor: savedCustomThemesColors.cardBg,
                        borderColor: savedCustomThemesColors.cardBorder,
                      }
                    : undefined
                }
              >
                <button
                  type='button'
                  onClick={() => setSavedThemesExpanded(prev => !prev)}
                  className='group flex w-full items-start justify-between gap-3 rounded-2xl px-3 py-3 text-left transition-all duration-150 hover:bg-neutral-100/80 active:scale-[0.99] active:bg-neutral-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 dark:hover:bg-black/10 dark:active:bg-neutral-800/60 dark:focus-visible:ring-violet-500/40'
                >
                  <div className='flex min-w-0 items-start gap-3'>
                    <div
                      className='mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300'
                      style={
                        savedCustomThemesColors
                          ? {
                              backgroundColor: savedCustomThemesColors.accentBg,
                              color: savedCustomThemesColors.accentText,
                            }
                          : undefined
                      }
                    >
                      <i className='bx bx-palette text-lg' />
                    </div>
                    <div className='min-w-0'>
                      <p
                        className='text-sm font-medium text-stone-700 dark:text-stone-200'
                        style={savedCustomThemesColors ? { color: savedCustomThemesColors.titleText } : undefined}
                      >
                        Saved custom themes
                      </p>
                      <p
                        className='mt-0.5 text-xs text-neutral-500 dark:text-neutral-400'
                        style={savedCustomThemesColors ? { color: savedCustomThemesColors.bodyText } : undefined}
                      >
                        Browse and apply theme files from{' '}
                        <code
                          className='rounded bg-neutral-200/70 px-1 py-0.5 font-mono text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
                          style={
                            savedCustomThemesColors
                              ? {
                                  backgroundColor: savedCustomThemesColors.codeBg,
                                  color: savedCustomThemesColors.codeText,
                                }
                              : undefined
                          }
                        >
                          .ygg/custom-themes
                        </code>
                        .
                      </p>
                    </div>
                  </div>
                  <i
                    className={`bx bx-chevron-down mt-2 shrink-0 text-2xl text-neutral-500 dark:text-neutral-400 transition-transform duration-200 ${savedThemesExpanded ? 'rotate-180' : ''}`}
                    style={savedCustomThemesColors ? { color: savedCustomThemesColors.bodyText } : undefined}
                  />
                </button>

                {savedThemesExpanded && (
                  <div
                    className='space-y-3 px-3 pb-3 pt-1'
                    style={savedCustomThemesColors ? { borderColor: savedCustomThemesColors.panelBorder } : undefined}
                  >
                    <div
                      className='flex flex-wrap items-center justify-between gap-3 rounded-xl bg-neutral-100/70 px-3 py-3 dark:bg-neutral-900/25'
                      style={
                        savedCustomThemesColors
                          ? {
                              backgroundColor: savedCustomThemesColors.innerCardBg,
                              borderColor: savedCustomThemesColors.innerCardBorder,
                            }
                          : undefined
                      }
                    >
                      <div className='min-w-0'>
                        <div className='flex flex-wrap items-center gap-2'>
                          <p
                            className='text-sm font-medium text-stone-700 dark:text-stone-200'
                            style={savedCustomThemesColors ? { color: savedCustomThemesColors.titleText } : undefined}
                          >
                            Enable custom theme
                          </p>
                          <span
                            className='rounded-full bg-neutral-200/80 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'
                            style={
                              savedCustomThemesColors
                                ? {
                                    backgroundColor: savedCustomThemesColors.badgeBg,
                                    color: savedCustomThemesColors.badgeText,
                                  }
                                : undefined
                            }
                          >
                            {customTheme.name || 'Current theme'}
                          </span>
                        </div>
                        <p
                          className='mt-1 text-xs text-neutral-500 dark:text-neutral-400'
                          style={savedCustomThemesColors ? { color: savedCustomThemesColors.bodyText } : undefined}
                        >
                          Apply your current edited or selected theme across chat and Heimdall.
                        </p>
                      </div>
                      <button
                        type='button'
                        onClick={() => setCustomChatThemeEnabled(!customThemeEnabled)}
                        className='rounded-lg p-1.5 transition-all duration-150 hover:bg-neutral-200/90 active:scale-95 active:bg-neutral-300/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 dark:hover:bg-neutral-700/80 dark:active:bg-neutral-700 dark:focus-visible:ring-violet-500/40'
                        title={customThemeEnabled ? 'Disable custom theme' : 'Enable custom theme'}
                        aria-pressed={customThemeEnabled}
                      >
                        <i
                          className={`bx ${customThemeEnabled ? 'bx-toggle-right text-green-500' : 'bx-toggle-left text-neutral-400'} text-2xl`}
                        />
                      </button>
                    </div>

                    <div className='flex flex-wrap items-center justify-between gap-3'>
                      <p
                        className='text-xs text-neutral-500 dark:text-neutral-400'
                        style={savedCustomThemesColors ? { color: savedCustomThemesColors.bodyText } : undefined}
                      >
                        {savedThemesLoading && savedThemes.length === 0
                          ? 'Loading saved themes…'
                          : `${savedThemes.length} saved theme${savedThemes.length === 1 ? '' : 's'} available`}
                      </p>
                      <button
                        type='button'
                        onClick={fetchSavedThemes}
                        disabled={savedThemesLoading}
                        className='inline-flex items-center gap-1.5 rounded-lg bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-700 transition-all duration-150 hover:bg-neutral-200 active:scale-[0.98] active:bg-neutral-300 disabled:opacity-50 dark:bg-neutral-800/80 dark:text-neutral-200 dark:hover:bg-neutral-700 dark:active:bg-neutral-700/90'
                        style={
                          savedCustomThemesColors
                            ? {
                                backgroundColor: savedCustomThemesColors.buttonBg,
                                borderColor: savedCustomThemesColors.buttonBorder,
                                color: savedCustomThemesColors.buttonText,
                              }
                            : undefined
                        }
                      >
                        <i
                          className={`bx ${savedThemesLoading ? 'bx-loader-alt animate-spin' : 'bx-refresh'} text-sm`}
                        />
                        {savedThemesLoading ? 'Refreshing…' : 'Refresh'}
                      </button>
                    </div>

                    {savedThemesError && (
                      <div className='rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/30 dark:text-rose-300'>
                        {savedThemesError}
                      </div>
                    )}

                    {savedThemesLoading && savedThemes.length === 0 && !savedThemesError ? (
                      <div className='flex items-center gap-2 rounded-lg bg-neutral-100/80 px-3 py-3 text-sm text-neutral-500 dark:bg-neutral-900/30 dark:text-neutral-400'>
                        <i className='bx bx-loader-alt animate-spin text-base' />
                        Loading saved themes...
                      </div>
                    ) : savedThemes.length === 0 && !savedThemesError ? (
                      <div
                        className='rounded-xl bg-neutral-100/70 px-4 py-6 text-center dark:bg-neutral-900/25'
                        style={
                          savedCustomThemesColors
                            ? {
                                backgroundColor: savedCustomThemesColors.emptyStateBg,
                                borderColor: savedCustomThemesColors.emptyStateBorder,
                              }
                            : undefined
                        }
                      >
                        <div className='mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-neutral-200/80 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'>
                          <i className='bx bx-folder-open text-lg' />
                        </div>
                        <p
                          className='text-sm font-medium text-neutral-700 dark:text-neutral-200'
                          style={savedCustomThemesColors ? { color: savedCustomThemesColors.titleText } : undefined}
                        >
                          No saved themes yet
                        </p>
                        <p
                          className='mt-1 text-xs text-neutral-500 dark:text-neutral-400'
                          style={savedCustomThemesColors ? { color: savedCustomThemesColors.bodyText } : undefined}
                        >
                          Theme JSON files saved to .ygg/custom-themes will appear here.
                        </p>
                      </div>
                    ) : (
                      <div
                        className='max-h-60 overflow-y-auto rounded-xl bg-neutral-100/60 pr-1 dark:bg-neutral-950/20 thin-scrollbar'
                        style={
                          savedCustomThemesColors
                            ? {
                                backgroundColor: savedCustomThemesColors.listBg,
                                borderColor: savedCustomThemesColors.listBorder,
                              }
                            : undefined
                        }
                      >
                        <div className='divide-y divide-neutral-200 dark:divide-neutral-800'>
                          {savedThemes.map(themeItem => (
                            <div
                              key={themeItem.id}
                              className='flex flex-col gap-3 rounded-xl px-3 py-3 transition-all duration-150 hover:bg-white/80 active:bg-white/90 dark:hover:bg-neutral-900/50 dark:active:bg-neutral-900/60 sm:flex-row sm:items-center sm:justify-between'
                            >
                              <div className='min-w-0 flex-1'>
                                <div className='flex items-start gap-3'>
                                  <div className='mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/80 text-neutral-500 dark:bg-neutral-900/70 dark:text-neutral-300'>
                                    <i className='bx bx-file-blank text-lg' />
                                  </div>
                                  <div className='min-w-0 flex-1'>
                                    <div className='flex flex-wrap items-center gap-2'>
                                      <p
                                        className='truncate text-sm font-medium text-neutral-900 dark:text-neutral-100'
                                        style={
                                          savedCustomThemesColors
                                            ? { color: savedCustomThemesColors.listItemTitleText }
                                            : undefined
                                        }
                                      >
                                        {themeItem.name}
                                      </p>
                                      <span
                                        className='rounded-full bg-neutral-200/80 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'
                                        style={
                                          savedCustomThemesColors
                                            ? {
                                                backgroundColor: savedCustomThemesColors.badgeBg,
                                                color: savedCustomThemesColors.badgeText,
                                              }
                                            : undefined
                                        }
                                      >
                                        JSON
                                      </span>
                                    </div>
                                    <div
                                      className='mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-neutral-500 dark:text-neutral-400'
                                      style={
                                        savedCustomThemesColors
                                          ? { color: savedCustomThemesColors.listItemMetaText }
                                          : undefined
                                      }
                                    >
                                      <span className='max-w-full truncate'>{themeItem.fileName}</span>
                                      <span className='hidden text-neutral-300 dark:text-neutral-600 sm:inline'>•</span>
                                      <span>{new Date(themeItem.modifiedAt).toLocaleString()}</span>
                                    </div>
                                  </div>
                                </div>
                              </div>
                              <button
                                type='button'
                                onClick={() => handleApplySavedTheme(themeItem.id)}
                                disabled={applyingThemeId === themeItem.id}
                                className='inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-blue-500 px-3 py-2 text-xs font-medium text-white transition-all duration-150 hover:bg-blue-600 active:scale-[0.98] active:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 disabled:opacity-50 dark:focus-visible:ring-blue-500/40'
                                style={
                                  savedCustomThemesColors
                                    ? {
                                        backgroundColor: savedCustomThemesColors.primaryButtonBg,
                                        color: savedCustomThemesColors.primaryButtonText,
                                      }
                                    : undefined
                                }
                              >
                                <i
                                  className={`bx ${applyingThemeId === themeItem.id ? 'bx-loader-alt animate-spin' : 'bx-check'} text-sm`}
                                />
                                {applyingThemeId === themeItem.id ? 'Applying…' : 'Apply'}
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <ThemeManager />
            </div>

            {/* Tools Section */}
            <div>
              <ToolsSettings />
            </div>

            {!isWebMode && (
              <div className='space-y-2'>
                <button
                  type='button'
                  onClick={() => setHooksExpanded(!hooksExpanded)}
                  className='flex items-center justify-between w-full text-left'
                >
                  <span className='text-[16px] font-medium text-stone-700 dark:text-stone-200'>Hooks</span>
                  <i
                    className={`bx bx-chevron-down text-xl text-neutral-500 dark:text-neutral-400 transition-transform duration-200 ${hooksExpanded ? 'rotate-180' : ''}`}
                  />
                </button>

                {hooksExpanded && (
                  <div className='space-y-4 pl-1 pt-2'>
                    <div className='flex items-center justify-between gap-3'>
                      <p className='text-sm text-neutral-600 dark:text-neutral-400'>
                        Enable or disable individual managed hooks from your .ygg settings files.
                      </p>
                      <button
                        type='button'
                        onClick={fetchManagedHooks}
                        disabled={hooksLoading}
                        className='px-2.5 py-1.5 rounded-md text-xs border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-50'
                      >
                        {hooksLoading ? 'Refreshing…' : 'Refresh'}
                      </button>
                    </div>

                    {hookActionStatus && (
                      <div
                        className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg ${
                          hookActionStatus.type === 'success'
                            ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                            : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
                        }`}
                      >
                        <i
                          className={`bx ${hookActionStatus.type === 'success' ? 'bx-check-circle' : 'bx-error-circle'} text-base`}
                        ></i>
                        {hookActionStatus.message}
                      </div>
                    )}

                    {hooksLoading ? (
                      <div className='flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400'>
                        <i className='bx bx-loader-alt animate-spin'></i>
                        Loading hooks...
                      </div>
                    ) : managedHooks.length === 0 ? (
                      <p className='text-sm text-neutral-500 dark:text-neutral-400'>
                        No managed hooks found in settings.json or settings.local.json.
                      </p>
                    ) : (
                      <div className='space-y-4'>
                        {hooksByEvent.map(group => (
                          <div key={group.event} className='space-y-2'>
                            <h4 className='text-sm font-medium text-stone-700 dark:text-stone-200'>{group.event}</h4>
                            <div className='space-y-2'>
                              {group.hooks.map(hook => (
                                <div
                                  key={hook.id}
                                  className='flex items-center justify-between p-3 rounded-lg bg-neutral-50 dark:bg-neutral-800/50 border border-neutral-200 dark:border-neutral-700 gap-3'
                                >
                                  <div className='flex-1 min-w-0'>
                                    <div className='flex items-center gap-2 flex-wrap'>
                                      <span className='font-medium text-sm text-neutral-900 dark:text-neutral-100 break-all'>
                                        {hook.command}
                                      </span>
                                      <span
                                        className={`text-xs px-1.5 py-0.5 rounded ${
                                          hook.enabled
                                            ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                                            : 'bg-neutral-200 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400'
                                        }`}
                                      >
                                        {hook.enabled ? 'Enabled' : 'Disabled'}
                                      </span>
                                    </div>
                                    <p className='text-xs text-neutral-500 dark:text-neutral-400 mt-1 break-all'>
                                      {hook.sourceFileName}
                                      {hook.matcher
                                        ? ` · Matcher: ${Array.isArray(hook.matcher) ? hook.matcher.join(', ') : hook.matcher}`
                                        : ''}
                                      {typeof hook.timeoutMs === 'number' ? ` · Timeout: ${hook.timeoutMs}ms` : ''}
                                    </p>
                                  </div>
                                  <button
                                    type='button'
                                    onClick={() => handleToggleHook(hook)}
                                    disabled={updatingHooks.has(hook.id)}
                                    className='p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors disabled:opacity-50'
                                    title={hook.enabled ? 'Disable hook' : 'Enable hook'}
                                  >
                                    <i
                                      className={`bx ${hook.enabled ? 'bx-toggle-right text-green-500' : 'bx-toggle-left text-neutral-400'} text-xl`}
                                    ></i>
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Skills Section */}
            <div className='space-y-2'>
              <button
                type='button'
                onClick={() => setSkillsExpanded(!skillsExpanded)}
                className='flex items-center justify-between w-full text-left'
              >
                <span className='text-[16px] font-medium text-stone-700 dark:text-stone-200'>Skills</span>
                <i
                  className={`bx bx-chevron-down text-xl text-neutral-500 dark:text-neutral-400 transition-transform duration-200 ${skillsExpanded ? 'rotate-180' : ''}`}
                />
              </button>

              {skillsExpanded && (
                <div className='space-y-4 pl-1 pt-2'>
                  <p className='text-sm text-neutral-600 dark:text-neutral-400'>
                    Install skills from{' '}
                    <a
                      href='https://clawdhub.com/skills'
                      target='_blank'
                      rel='noopener noreferrer'
                      className='text-blue-600 dark:text-blue-400 hover:underline'
                    >
                      ClawdHub
                    </a>{' '}
                    or GitHub. Paste the skill page URL below.
                  </p>

                  {/* URL Input and Install Button */}
                  <div className='flex items-center gap-2'>
                    <input
                      type='text'
                      value={skillUrl}
                      onChange={e => setSkillUrl(e.target.value)}
                      placeholder='https://clawdhub.com/owner/skill-name'
                      className='flex-1 px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-blue-500'
                      disabled={skillInstallStatus === 'loading'}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && skillUrl.trim()) {
                          handleInstallSkill()
                        }
                      }}
                    />
                    <button
                      type='button'
                      onClick={handleInstallSkill}
                      disabled={!skillUrl.trim() || skillInstallStatus === 'loading'}
                      className='px-4 py-2 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2'
                    >
                      {skillInstallStatus === 'loading' ? (
                        <>
                          <i className='bx bx-loader-alt animate-spin text-base'></i>
                          Installing...
                        </>
                      ) : (
                        <>
                          <i className='bx bx-download text-base'></i>
                          Install
                        </>
                      )}
                    </button>
                  </div>

                  {/* Status Message */}
                  {skillInstallMessage && (
                    <div
                      className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg ${
                        skillInstallStatus === 'success'
                          ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                          : skillInstallStatus === 'error'
                            ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
                            : 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
                      }`}
                    >
                      <i
                        className={`bx ${
                          skillInstallStatus === 'success'
                            ? 'bx-check-circle'
                            : skillInstallStatus === 'error'
                              ? 'bx-error-circle'
                              : 'bx-loader-alt animate-spin'
                        } text-base`}
                      ></i>
                      {skillInstallMessage}
                    </div>
                  )}

                  {/* Help text */}
                  <p className='text-xs text-neutral-500 dark:text-neutral-500'>
                    Supported URLs: ClawdHub pages (clawdhub.com/owner/skill), GitHub repos
                  </p>

                  {/* Installed Skills List */}
                  <div className='mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700'>
                    <h4 className='text-sm font-medium text-stone-700 dark:text-stone-200 mb-3'>
                      Installed Skills {!skillsLoading && `(${installedSkills.length})`}
                    </h4>

                    {skillsLoading ? (
                      <div className='flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400'>
                        <i className='bx bx-loader-alt animate-spin'></i>
                        Loading skills...
                      </div>
                    ) : installedSkills.length === 0 ? (
                      <p className='text-sm text-neutral-500 dark:text-neutral-400'>
                        No skills installed yet. Install one from ClawdHub or GitHub above.
                      </p>
                    ) : (
                      <div className='space-y-2'>
                        {installedSkills.map(skill => (
                          <div
                            key={skill.name}
                            className='flex items-center justify-between p-3 rounded-lg bg-neutral-50 dark:bg-neutral-800/50 border border-neutral-200 dark:border-neutral-700'
                          >
                            <div className='flex-1 min-w-0'>
                              <div className='flex items-center gap-2'>
                                <span className='font-medium text-sm text-neutral-900 dark:text-neutral-100'>
                                  {skill.name}
                                </span>
                                <span
                                  className={`text-xs px-1.5 py-0.5 rounded ${
                                    skill.enabled
                                      ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                                      : 'bg-neutral-200 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400'
                                  }`}
                                >
                                  {skill.enabled ? 'Enabled' : 'Disabled'}
                                </span>
                              </div>
                              <p className='text-xs text-neutral-500 dark:text-neutral-400 truncate mt-0.5'>
                                {skill.description}
                              </p>
                            </div>
                            <div className='flex items-center gap-1 ml-2'>
                              <button
                                type='button'
                                onClick={() => handleToggleSkill(skill.name, skill.enabled)}
                                className='p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors'
                                title={skill.enabled ? 'Disable skill' : 'Enable skill'}
                              >
                                <i
                                  className={`bx ${skill.enabled ? 'bx-toggle-right text-green-500' : 'bx-toggle-left text-neutral-400'} text-xl`}
                                ></i>
                              </button>
                              <button
                                type='button'
                                onClick={() => handleUninstallSkill(skill.name)}
                                className='p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors text-neutral-400 hover:text-red-500'
                                title='Uninstall skill'
                              >
                                <i className='bx bx-trash text-lg'></i>
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* MCP Servers Section */}
            <div className='space-y-2'>
              <button
                type='button'
                onClick={() => setMcpExpanded(!mcpExpanded)}
                className='flex items-center justify-between w-full text-left'
              >
                <span className='text-[16px] font-medium text-stone-700 dark:text-stone-200'>MCP Servers</span>
                <i
                  className={`bx bx-chevron-down text-xl text-neutral-500 dark:text-neutral-400 transition-transform duration-200 ${mcpExpanded ? 'rotate-180' : ''}`}
                />
              </button>

              {mcpExpanded && (
                <div className='space-y-4 pl-1 pt-2'>
                  <p className='text-sm text-neutral-600 dark:text-neutral-400'>
                    Connect to MCP (Model Context Protocol) servers to add external tools. MCP servers provide tools
                    that the AI can use directly.
                  </p>

                  <div className='flex items-center justify-between rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50 px-3 py-2'>
                    <div>
                      <p className='text-sm font-medium text-neutral-700 dark:text-neutral-200'>
                        Lazy start MCP servers
                      </p>
                      <p className='text-xs text-neutral-500 dark:text-neutral-400'>
                        When enabled, servers won’t auto-start on launch.
                      </p>
                    </div>
                    <button
                      type='button'
                      onClick={handleToggleMcpLazyStart}
                      className='p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors'
                      title={mcpLazyStart ? 'Disable lazy start' : 'Enable lazy start'}
                    >
                      <i
                        className={`bx ${mcpLazyStart ? 'bx-toggle-right text-green-500' : 'bx-toggle-left text-neutral-400'} text-xl`}
                      ></i>
                    </button>
                  </div>

                  {/* Status Message */}
                  {mcpActionStatus && (
                    <div
                      className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg ${
                        mcpActionStatus.type === 'success'
                          ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                          : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
                      }`}
                    >
                      <i
                        className={`bx ${mcpActionStatus.type === 'success' ? 'bx-check-circle' : 'bx-error-circle'} text-base`}
                      ></i>
                      {mcpActionStatus.message}
                    </div>
                  )}

                  {/* Add Server Button / Form */}
                  {!mcpAddMode ? (
                    <div className='flex flex-wrap items-center gap-3'>
                      <button
                        type='button'
                        onClick={() => setMcpAddMode(true)}
                        className='flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors'
                      >
                        <i className='bx bx-plus text-base'></i>
                        Add MCP Server
                      </button>
                      <button
                        type='button'
                        onClick={handleRefreshMcpTools}
                        disabled={mcpRefreshing}
                        className='flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300 hover:text-neutral-800 dark:hover:text-neutral-100 transition-colors disabled:opacity-60'
                      >
                        <i
                          className={`bx ${mcpRefreshing ? 'bx-loader-circle animate-spin' : 'bx-refresh'} text-base`}
                        />
                        Refresh MCP Tools
                      </button>
                    </div>
                  ) : (
                    <div className='space-y-3 p-3 rounded-lg bg-neutral-50 dark:bg-neutral-800/50 border border-neutral-200 dark:border-neutral-700'>
                      <div className='space-y-2'>
                        <label className='text-xs font-medium text-neutral-600 dark:text-neutral-400'>
                          Server Name
                        </label>
                        <input
                          type='text'
                          value={newServerName}
                          onChange={e => setNewServerName(e.target.value)}
                          placeholder='my-server'
                          className='w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-blue-500'
                        />
                      </div>

                      <div className='space-y-2'>
                        <label className='text-xs font-medium text-neutral-600 dark:text-neutral-400'>Transport</label>
                        <div className='flex items-center gap-2'>
                          <button
                            type='button'
                            onClick={() => setNewServerTransport('stdio')}
                            className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${
                              newServerTransport === 'stdio'
                                ? 'bg-blue-500 text-white border-blue-500'
                                : 'bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 border-neutral-300 dark:border-neutral-600'
                            }`}
                          >
                            Local (stdio)
                          </button>
                          <button
                            type='button'
                            onClick={() => setNewServerTransport('http')}
                            className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${
                              newServerTransport === 'http'
                                ? 'bg-blue-500 text-white border-blue-500'
                                : 'bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 border-neutral-300 dark:border-neutral-600'
                            }`}
                          >
                            Remote (HTTP)
                          </button>
                        </div>
                      </div>

                      {newServerTransport === 'stdio' ? (
                        <>
                          <div className='space-y-2'>
                            <label className='text-xs font-medium text-neutral-600 dark:text-neutral-400'>
                              Command
                            </label>
                            <input
                              type='text'
                              value={newServerCommand}
                              onChange={e => setNewServerCommand(e.target.value)}
                              placeholder='npx'
                              className='w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-blue-500'
                            />
                          </div>
                          <div className='space-y-2'>
                            <label className='text-xs font-medium text-neutral-600 dark:text-neutral-400'>
                              Arguments (space-separated)
                            </label>
                            <input
                              type='text'
                              value={newServerArgs}
                              onChange={e => setNewServerArgs(e.target.value)}
                              placeholder='-y @anthropic/mcp-server-filesystem /path/to/dir'
                              className='w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-blue-500'
                            />
                          </div>
                        </>
                      ) : (
                        <>
                          <div className='space-y-2'>
                            <label className='text-xs font-medium text-neutral-600 dark:text-neutral-400'>
                              Remote URL
                            </label>
                            <input
                              type='text'
                              value={newServerUrl}
                              onChange={e => setNewServerUrl(e.target.value)}
                              placeholder='https://mcp.example.com/mcp'
                              className='w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-blue-500'
                            />
                          </div>
                          <div className='space-y-2'>
                            <label className='text-xs font-medium text-neutral-600 dark:text-neutral-400'>
                              Headers (JSON, optional)
                            </label>
                            <textarea
                              value={newServerHeadersText}
                              onChange={e => setNewServerHeadersText(e.target.value)}
                              placeholder='{"Authorization":"Bearer <token>"}'
                              rows={3}
                              className='w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-blue-500'
                            />
                            <p className='text-[11px] text-neutral-500 dark:text-neutral-400'>
                              Example: {`{"Authorization":"Bearer <token>","x-api-key":"abc123"}`}
                            </p>
                          </div>

                          <div className='space-y-2'>
                            <label className='text-xs font-medium text-neutral-600 dark:text-neutral-400'>
                              OAuth Client ID (optional)
                            </label>
                            <input
                              type='text'
                              value={newServerOauthClientId}
                              onChange={e => setNewServerOauthClientId(e.target.value)}
                              placeholder='github-oauth-client-id'
                              className='w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-blue-500'
                            />
                          </div>

                          <div className='space-y-2'>
                            <label className='text-xs font-medium text-neutral-600 dark:text-neutral-400'>
                              OAuth Client Secret (optional)
                            </label>
                            <input
                              type='password'
                              value={newServerOauthClientSecret}
                              onChange={e => setNewServerOauthClientSecret(e.target.value)}
                              placeholder='Only needed for client_secret_post'
                              className='w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-blue-500'
                            />
                          </div>

                          <div className='space-y-2'>
                            <label className='text-xs font-medium text-neutral-600 dark:text-neutral-400'>
                              OAuth Scopes (optional)
                            </label>
                            <input
                              type='text'
                              value={newServerOauthScopes}
                              onChange={e => setNewServerOauthScopes(e.target.value)}
                              placeholder='repo read:user user:email'
                              className='w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-blue-500'
                            />
                            <p className='text-[11px] text-neutral-500 dark:text-neutral-400'>
                              Space or comma separated. Leave blank to use server defaults/challenges.
                            </p>
                          </div>

                          <div className='space-y-2'>
                            <label className='text-xs font-medium text-neutral-600 dark:text-neutral-400'>
                              Token Endpoint Auth Method
                            </label>
                            <select
                              value={newServerOauthTokenAuthMethod}
                              onChange={e =>
                                setNewServerOauthTokenAuthMethod(e.target.value as 'client_secret_post' | 'none')
                              }
                              className='w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-blue-500'
                            >
                              <option value='client_secret_post'>client_secret_post</option>
                              <option value='none'>none (public client)</option>
                            </select>
                          </div>
                        </>
                      )}

                      <div className='flex items-center gap-2'>
                        <button
                          type='button'
                          onClick={handleAddMcpServer}
                          disabled={
                            !newServerName.trim() ||
                            (newServerTransport === 'stdio' ? !newServerCommand.trim() : !newServerUrl.trim())
                          }
                          className='px-3 py-1.5 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
                        >
                          Add Server
                        </button>
                        <button
                          type='button'
                          onClick={() => {
                            setMcpAddMode(false)
                            setNewServerName('')
                            setNewServerTransport('stdio')
                            setNewServerCommand('')
                            setNewServerArgs('')
                            setNewServerUrl('')
                            setNewServerHeadersText('')
                            setNewServerOauthClientId('')
                            setNewServerOauthClientSecret('')
                            setNewServerOauthScopes('')
                            setNewServerOauthTokenAuthMethod('client_secret_post')
                          }}
                          className='px-3 py-1.5 text-sm text-neutral-600 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 transition-colors'
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Help text */}
                  <p className='text-xs text-neutral-500 dark:text-neutral-500'>
                    Examples: Local stdio → Command "npx" + args "-y @modelcontextprotocol/server-filesystem
                    /home/user/projects". Remote HTTP → URL "https://mcp.example.com/mcp" + optional headers JSON
                    (Authorization, API keys, etc.).
                  </p>

                  {/* Connected Servers List */}
                  <div className='mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700'>
                    <h4 className='text-sm font-medium text-stone-700 dark:text-stone-200 mb-3'>
                      Configured Servers {!mcpLoading && `(${mcpServers.length})`}
                    </h4>

                    {mcpLoading ? (
                      <div className='flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400'>
                        <i className='bx bx-loader-alt animate-spin'></i>
                        Loading servers...
                      </div>
                    ) : mcpServers.length === 0 ? (
                      <p className='text-sm text-neutral-500 dark:text-neutral-400'>
                        No MCP servers configured. Add one above to get started.
                      </p>
                    ) : (
                      <div className='space-y-2'>
                        {mcpServers.map(server => (
                          <div
                            key={server.name}
                            className='flex items-center justify-between p-3 rounded-lg bg-neutral-50 dark:bg-neutral-800/50 border border-neutral-200 dark:border-neutral-700'
                          >
                            <div className='flex-1 min-w-0'>
                              <div className='flex items-center gap-2'>
                                <span className='font-medium text-sm text-neutral-900 dark:text-neutral-100'>
                                  {server.name}
                                </span>
                                <span className='text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'>
                                  {(server.transport || server.type || (server.url ? 'http' : 'stdio')).toUpperCase()}
                                </span>
                                <span
                                  className={`text-xs px-1.5 py-0.5 rounded ${
                                    server.status === 'connected'
                                      ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                                      : server.status === 'connecting'
                                        ? 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400'
                                        : server.status === 'error'
                                          ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
                                          : 'bg-neutral-200 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400'
                                  }`}
                                >
                                  {server.status}
                                </span>
                                {server.status === 'connected' && server.toolCount > 0 && (
                                  <span className='text-xs text-neutral-500 dark:text-neutral-400'>
                                    {server.toolCount} tools
                                  </span>
                                )}
                              </div>
                              <p className='text-xs text-neutral-500 dark:text-neutral-400 truncate mt-0.5'>
                                {server.url || `${server.command || ''} ${(server.args || []).join(' ')}`.trim()}
                              </p>
                              {server.headers && Object.keys(server.headers).length > 0 && (
                                <p className='text-xs text-neutral-500 dark:text-neutral-400 mt-0.5'>
                                  Headers: {Object.keys(server.headers).join(', ')}
                                </p>
                              )}
                              {server.oauth && (
                                <p className='text-xs text-neutral-500 dark:text-neutral-400 mt-0.5'>
                                  OAuth: {server.oauth.hasAccessToken ? 'token' : 'no token'}
                                  {server.oauth.hasRefreshToken ? ', refresh token' : ''}
                                  {server.oauth.tokenEndpointAuthMethod
                                    ? `, ${server.oauth.tokenEndpointAuthMethod}`
                                    : ''}
                                </p>
                              )}
                              {server.error && (
                                <p className='text-xs text-red-500 dark:text-red-400 mt-0.5'>{server.error}</p>
                              )}
                            </div>
                            <div className='flex items-center gap-1 ml-2'>
                              <button
                                type='button'
                                onClick={() => handleToggleMcpServer(server.name, server.status)}
                                className='p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors'
                                title={server.status === 'connected' ? 'Stop server' : 'Start server'}
                              >
                                <i
                                  className={`bx ${
                                    server.status === 'connected'
                                      ? 'bx-stop text-red-500'
                                      : server.status === 'connecting'
                                        ? 'bx-loader-alt animate-spin text-yellow-500'
                                        : 'bx-play text-green-500'
                                  } text-xl`}
                                ></i>
                              </button>
                              <button
                                type='button'
                                onClick={() => handleRemoveMcpServer(server.name)}
                                className='p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors text-neutral-400 hover:text-red-500'
                                title='Remove server'
                              >
                                <i className='bx bx-trash text-lg'></i>
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <AppStoreModal open={appStoreOpen} onClose={() => setAppStoreOpen(false)} />
    </div>
  )
}
