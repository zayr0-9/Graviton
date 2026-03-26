import React, { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useNavigate } from 'react-router-dom'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import changelogMarkdown from '../../CHANGELOG.md?raw'
import { Button, Select } from '../components'
import { useHtmlIframeRegistry } from '../components/HtmlIframeRegistry/HtmlIframeRegistry'
import {
  getThemeModeColor,
  saveCustomChatTheme,
  setCustomChatThemeEnabled,
  useCustomChatTheme,
  useHtmlDarkMode,
} from '../components/ThemeManager/themeConfig'
import { isCommunityMode, LOCAL_AUTH_USER_ID } from '../config/runtimeMode'
import { chatSliceActions, selectProviderState } from '../features/chats'
import { fetchCustomTools, fetchTools, updateToolEnabled } from '../features/chats/chatActions'
import { clearTokens as clearOpenAITokens, isOpenAIAuthenticated } from '../features/chats/openaiOAuth'
import { getAllTools } from '../features/chats/toolDefinitions'
import {
  AGENT_SETTINGS_CHANGE_EVENT,
  AgentSettings,
  loadAgentSettings,
  saveAgentSettings,
} from '../helpers/agentSettingsStorage'
import {
  CHAT_REASONING_SETTINGS_CHANGE_EVENT,
  ChatReasoningSettings,
  loadChatReasoningSettings,
  REASONING_EFFORT_OPTIONS,
  saveChatReasoningSettings,
} from '../helpers/chatReasoningSettingsStorage'
import { loadShowTokenUsageBar, saveShowTokenUsageBar } from '../helpers/chatUiSettingsStorage'
import {
  AppFontSettings,
  applyAppFontSettings,
  clearStoredLocalFont,
  FONT_SETTINGS_CHANGE_EVENT,
  hasStoredLocalFont,
  isSupportedLocalFontFile,
  loadAppFontSettings,
  MAX_FONT_UPLOAD_SIZE_BYTES,
  saveAppFontSettings,
  saveUploadedLocalFont,
  validateGoogleFontUrl,
} from '../helpers/fontSettingsStorage'
import {
  loadProviderSettings,
  MAX_OPENROUTER_TEMPERATURE,
  MIN_OPENROUTER_TEMPERATURE,
  PROVIDER_SETTINGS_CHANGE_EVENT,
  ProviderSettings,
  saveProviderSettings,
} from '../helpers/providerSettingsStorage'
import {
  buildRemoteMobileUrl,
  loadRemoteServerSettings,
  normalizeRemoteBaseUrl,
  REMOTE_SERVER_SETTINGS_CHANGE_EVENT,
  saveRemoteServerSettings,
} from '../helpers/remoteServerSettingsStorage'
import {
  loadToolExecutionSettings,
  MAX_BASH_TIMEOUT_MS,
  MAX_TOOL_CALL_TIMEOUT_MS,
  MIN_BASH_TIMEOUT_MS,
  MIN_TOOL_CALL_TIMEOUT_MS,
  saveToolExecutionSettings,
  TOOL_EXECUTION_SETTINGS_CHANGE_EVENT,
  ToolExecutionSettings,
} from '../helpers/toolExecutionSettings'
import {
  loadSubagentToolSettings,
  saveSubagentToolSettings,
  SUBAGENT_TOOL_SETTINGS_CHANGE_EVENT,
  SubagentToolSettings,
} from '../helpers/subagentToolSettings'
import {
  addCustomVideo,
  BackgroundColorSettings,
  BackgroundMode,
  clearCustomVideoLibrary,
  CustomVideoEntry,
  DEFAULT_BACKGROUND_COLORS,
  loadActiveCustomVideoId,
  loadBackgroundColors,
  loadBackgroundMode,
  loadSavedVideos,
  persistActiveCustomVideoId,
  persistBackgroundColors,
  persistBackgroundMode,
  removeCustomVideo,
  updateCustomVideoTextColorMode,
  VIDEO_BACKGROUND_CHANGE_EVENT,
} from '../helpers/videoBackgroundStorage'
import { useAppDispatch, useAppSelector } from '../hooks/redux'
import { useAuth } from '../hooks/useAuth'
import { useModels } from '../hooks/useQueries'
import { API_BASE, getLocalServerLanOrigin, getLocalServerOrigin, localApi } from '../utils/api'

const MAX_UPLOAD_SIZE_BYTES = 8 * 1024 * 1024 // 8MB
const LOCAL_FONT_ACCEPT = '.woff2,.ttf,.otf'

type StatusMessage = {
  type: 'success' | 'error' | 'info'
  text: string
}

const formatSize = (size?: number) => {
  if (!size) {
    return 'n/a'
  }

  if (size < 1024) {
    return `${size.toFixed(0)} bytes`
  }

  const kilo = size / 1024
  if (kilo < 1024) {
    return `${kilo.toFixed(1)} KB`
  }

  return `${(kilo / 1024).toFixed(1)} MB`
}

interface GoogleDriveStatus {
  connected: boolean
  connectedAt: string | null
  lastUsedAt: string | null
}

interface LocalUserSummary {
  id: string
  username: string | null
  created_at: string | null
  project_count: number
  conversation_count: number
  provider_cost_count: number
}

interface LocalMergeResult {
  success: boolean
  merged: boolean
  projects: number
  conversations: number
  providerCosts: number
  message?: string
}

const Settings: React.FC = () => {
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const { accessToken, userId } = useAuth()
  const providers = useAppSelector(selectProviderState)
  const htmlRegistry = useHtmlIframeRegistry()
  const htmlEntries = htmlRegistry?.entries.filter(entry => entry.kind === 'html') ?? []
  const { theme: customTheme, enabled: customThemeEnabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()
  const settingsSolidColorSectionBackground = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.settingsSolidColorSectionBg, isDarkMode)
    : undefined

  // Tools state
  const tools = getAllTools()
  const [toolsExpanded, setToolsExpanded] = useState(false)
  const [htmlToolsExpanded, setHtmlToolsExpanded] = useState(false)
  const [agentToolsExpanded, setAgentToolsExpanded] = useState(false)
  const [updatingTools, setUpdatingTools] = useState<Set<string>>(new Set())
  const [reloadingTools, setReloadingTools] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const fontFileInputRef = useRef<HTMLInputElement | null>(null)
  const timeoutRef = useRef<number | null>(null)
  const [fontUploading, setFontUploading] = useState(false)
  const [fontSettings, setFontSettings] = useState<AppFontSettings>(() => loadAppFontSettings())
  const [googleFontUrlInput, setGoogleFontUrlInput] = useState<string>(() => loadAppFontSettings().googleFontUrl ?? '')
  const [hasLocalFontSaved, setHasLocalFontSaved] = useState(false)
  const [videos, setVideos] = useState<CustomVideoEntry[]>(() => loadSavedVideos())
  const [activeVideoId, setActiveVideoId] = useState<string | null>(() => loadActiveCustomVideoId())
  const [backgroundMode, setBackgroundMode] = useState<BackgroundMode>(() => loadBackgroundMode())
  const [backgroundColors, setBackgroundColors] = useState<BackgroundColorSettings>(() => loadBackgroundColors())
  const effectiveBackgroundColors = customThemeEnabled ? customTheme.colors.appBackgroundColor : backgroundColors
  const [uploading, setUploading] = useState(false)
  const [googleConnecting, setGoogleConnecting] = useState(false)
  const [googleDisconnecting, setGoogleDisconnecting] = useState(false)
  const [googleDriveStatus, setGoogleDriveStatus] = useState<GoogleDriveStatus | null>(null)
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null)
  const [remoteBaseUrlInput, setRemoteBaseUrlInput] = useState<string>(
    () => loadRemoteServerSettings().remoteBaseUrl ?? ''
  )
  const [detectedLocalServerOrigin, setDetectedLocalServerOrigin] = useState<string>('')
  const [localUsers, setLocalUsers] = useState<LocalUserSummary[]>([])
  const [localUsersLoading, setLocalUsersLoading] = useState(false)
  const [migratingOwnership, setMigratingOwnership] = useState(false)
  const [fromUserId, setFromUserId] = useState('')
  const [toUserId, setToUserId] = useState('')
  const [isChangelogOpen, setIsChangelogOpen] = useState(false)
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>(() => loadProviderSettings())
  const [braveApiKeyInput, setBraveApiKeyInput] = useState('')
  const [braveApiKeyConfigured, setBraveApiKeyConfigured] = useState(false)
  const [braveApiKeyLoading, setBraveApiKeyLoading] = useState(import.meta.env.VITE_ENVIRONMENT === 'electron')
  const [braveApiKeySaving, setBraveApiKeySaving] = useState(false)
  const [openRouterTemperatureInput, setOpenRouterTemperatureInput] = useState<string>(() => {
    const configured = loadProviderSettings().openRouterTemperature
    return typeof configured === 'number' ? String(configured) : ''
  })
  const [openRouterTemperatureTouched, setOpenRouterTemperatureTouched] = useState(false)
  const [compactionSystemPromptInput, setCompactionSystemPromptInput] = useState<string>(
    () => loadProviderSettings().compactionSystemPrompt
  )
  const [compactionSystemPromptTouched, setCompactionSystemPromptTouched] = useState(false)
  const [toolExecutionSettings, setToolExecutionSettings] = useState<ToolExecutionSettings>(() =>
    loadToolExecutionSettings()
  )
  const [toolCallTimeoutInput, setToolCallTimeoutInput] = useState<string>(() =>
    String(loadToolExecutionSettings().toolCallTimeoutMs)
  )
  const [toolCallTimeoutTouched, setToolCallTimeoutTouched] = useState(false)
  const [bashTimeoutInput, setBashTimeoutInput] = useState<string>(() =>
    String(loadToolExecutionSettings().bashTimeoutMs)
  )
  const [bashTimeoutTouched, setBashTimeoutTouched] = useState(false)
  const [chatReasoningSettings, setChatReasoningSettings] = useState<ChatReasoningSettings>(() =>
    loadChatReasoningSettings()
  )
  const [showTokenUsageBar, setShowTokenUsageBar] = useState<boolean>(() => loadShowTokenUsageBar())
  const [agentSettings, setAgentSettings] = useState<AgentSettings>({
    heartbeatTime: null,
    agentName: 'Global Agent',
    model: null,
    modelContextLength: null,
    loopIntervalMs: 60000,
    autoResume: true,
    toolAllowlist: null,
    workDirectory: null,
  })
  const [workDirectoryInput, setWorkDirectoryInput] = useState('')
  const [workDirectoryTouched, setWorkDirectoryTouched] = useState(false)
  const [loopIntervalInput, setLoopIntervalInput] = useState('60000')
  const [loopIntervalTouched, setLoopIntervalTouched] = useState(false)
  const [agentSettingsLoading, setAgentSettingsLoading] = useState(true)
  const [agentSettingsSaving, setAgentSettingsSaving] = useState(false)
  const [subagentSettings, setSubagentSettings] = useState<SubagentToolSettings>(() => loadSubagentToolSettings())
  const { data: openRouterModelsData } = useModels('OpenRouter')
  const compactionProviderForModels = providerSettings.compactionProvider || providers.currentProvider || 'OpenRouter'
  const { data: compactionModelsData } = useModels(compactionProviderForModels)
  const normalizedRemoteBaseUrlInput = normalizeRemoteBaseUrl(remoteBaseUrlInput)
  const effectiveRemoteMobileUrl =
    buildRemoteMobileUrl(normalizedRemoteBaseUrlInput) || buildRemoteMobileUrl(detectedLocalServerOrigin)
  const remoteQrCodeImageUrl = effectiveRemoteMobileUrl
    ? `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(effectiveRemoteMobileUrl)}`
    : null
  const subagentDefaultModelPreview =
    typeof agentSettings.model === 'string' && agentSettings.model.trim().length > 0
      ? agentSettings.model.trim()
      : 'openai/gpt-5.1-codex-mini'

  const readBraveApiKeyFromSecureStore = async (): Promise<string | null> => {
    const braveSecretsApi = window.electronAPI?.secrets?.braveSearch
    if (!braveSecretsApi?.get) {
      throw new Error('Secure credential storage is unavailable in this build.')
    }

    const result = await braveSecretsApi.get()
    if (!result?.success) {
      throw new Error(result?.error || 'Failed to load Brave Search API key from secure storage.')
    }

    const value = typeof result.value === 'string' ? result.value.trim() : ''
    return value || null
  }

  // Fetch Google Drive connection status
  const fetchGoogleDriveStatus = async () => {
    if (isCommunityMode) {
      setGoogleDriveStatus(null)
      return
    }
    if (!accessToken) return
    try {
      const response = await fetch(`${API_BASE}/oauth/google-drive/status`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (response.ok) {
        const status = await response.json()
        setGoogleDriveStatus(status)
      }
    } catch (error) {
      console.error('Failed to fetch Google Drive status:', error)
    }
  }

  useEffect(() => {
    fetchGoogleDriveStatus()
  }, [accessToken])

  useEffect(() => {
    if (import.meta.env.VITE_ENVIRONMENT !== 'electron') return

    let active = true

    Promise.all([getLocalServerLanOrigin(), getLocalServerOrigin()])
      .then(([lanOrigin, fallbackOrigin]) => {
        if (!active) return

        const preferredOrigin = lanOrigin || fallbackOrigin
        setDetectedLocalServerOrigin(preferredOrigin)

        const saved = loadRemoteServerSettings()
        if (!saved.remoteBaseUrl && lanOrigin) {
          const autoSaved = saveRemoteServerSettings({ remoteBaseUrl: lanOrigin })
          setRemoteBaseUrlInput(autoSaved.remoteBaseUrl ?? '')
        }
      })
      .catch(error => {
        console.error('Failed to resolve local server origin for remote access settings:', error)
      })

    const handleRemoteSettingsChanged = () => {
      const saved = loadRemoteServerSettings()
      setRemoteBaseUrlInput(saved.remoteBaseUrl ?? '')
    }

    window.addEventListener(REMOTE_SERVER_SETTINGS_CHANGE_EVENT, handleRemoteSettingsChanged as EventListener)
    return () => {
      active = false
      window.removeEventListener(REMOTE_SERVER_SETTINGS_CHANGE_EVENT, handleRemoteSettingsChanged as EventListener)
    }
  }, [])

  useEffect(() => {
    const handleBackgroundChange = () => {
      setVideos(loadSavedVideos())
      setActiveVideoId(loadActiveCustomVideoId())
      setBackgroundMode(loadBackgroundMode())
      setBackgroundColors(loadBackgroundColors())
    }

    window.addEventListener(VIDEO_BACKGROUND_CHANGE_EVENT, handleBackgroundChange)
    return () => window.removeEventListener(VIDEO_BACKGROUND_CHANGE_EVENT, handleBackgroundChange)
  }, [])

  useEffect(() => {
    const handleProviderSettingsChange = (e: CustomEvent<ProviderSettings>) => {
      setProviderSettings(e.detail)
    }

    window.addEventListener(PROVIDER_SETTINGS_CHANGE_EVENT, handleProviderSettingsChange as EventListener)
    return () =>
      window.removeEventListener(PROVIDER_SETTINGS_CHANGE_EVENT, handleProviderSettingsChange as EventListener)
  }, [])

  useEffect(() => {
    const handleSubagentSettingsChange = (e: CustomEvent<SubagentToolSettings>) => {
      setSubagentSettings(e.detail)
    }

    window.addEventListener(SUBAGENT_TOOL_SETTINGS_CHANGE_EVENT, handleSubagentSettingsChange as EventListener)
    return () =>
      window.removeEventListener(SUBAGENT_TOOL_SETTINGS_CHANGE_EVENT, handleSubagentSettingsChange as EventListener)
  }, [])

  useEffect(() => {
    if (import.meta.env.VITE_ENVIRONMENT !== 'electron') {
      setBraveApiKeyLoading(false)
      return
    }

    let active = true

    const loadBraveApiKey = async () => {
      const maxAttempts = 3
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const value = await readBraveApiKeyFromSecureStore()
          if (!active) return

          setBraveApiKeyInput(value ?? '')
          setBraveApiKeyConfigured(Boolean(value))
          return
        } catch (error) {
          if (attempt >= maxAttempts) {
            if (active) {
              console.error('Failed to load Brave API key:', error)
            }
            return
          }
          await new Promise(resolve => setTimeout(resolve, attempt * 200))
        }
      }
    }

    void loadBraveApiKey().finally(() => {
      if (active) {
        setBraveApiKeyLoading(false)
      }
    })

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (openRouterTemperatureTouched) return
    const configured = providerSettings.openRouterTemperature
    setOpenRouterTemperatureInput(typeof configured === 'number' ? String(configured) : '')
  }, [providerSettings.openRouterTemperature, openRouterTemperatureTouched])

  useEffect(() => {
    if (compactionSystemPromptTouched) return
    setCompactionSystemPromptInput(providerSettings.compactionSystemPrompt)
  }, [providerSettings.compactionSystemPrompt, compactionSystemPromptTouched])

  useEffect(() => {
    const handleToolExecutionSettingsChange = (e: CustomEvent<ToolExecutionSettings>) => {
      setToolExecutionSettings(e.detail)
    }

    window.addEventListener(TOOL_EXECUTION_SETTINGS_CHANGE_EVENT, handleToolExecutionSettingsChange as EventListener)
    return () =>
      window.removeEventListener(
        TOOL_EXECUTION_SETTINGS_CHANGE_EVENT,
        handleToolExecutionSettingsChange as EventListener
      )
  }, [])

  useEffect(() => {
    const handleChatReasoningSettingsChange = (e: CustomEvent<ChatReasoningSettings>) => {
      setChatReasoningSettings(e.detail)
    }

    window.addEventListener(CHAT_REASONING_SETTINGS_CHANGE_EVENT, handleChatReasoningSettingsChange as EventListener)
    return () =>
      window.removeEventListener(
        CHAT_REASONING_SETTINGS_CHANGE_EVENT,
        handleChatReasoningSettingsChange as EventListener
      )
  }, [])

  useEffect(() => {
    let active = true

    hasStoredLocalFont()
      .then(hasLocal => {
        if (active) {
          setHasLocalFontSaved(hasLocal)
        }
      })
      .catch(error => {
        console.error('Failed to check local font availability:', error)
      })

    const handleFontSettingsChange = (event: CustomEvent<AppFontSettings>) => {
      if (!active) return
      setFontSettings(event.detail)
      setGoogleFontUrlInput(event.detail.googleFontUrl ?? '')
    }

    window.addEventListener(FONT_SETTINGS_CHANGE_EVENT, handleFontSettingsChange as EventListener)

    return () => {
      active = false
      window.removeEventListener(FONT_SETTINGS_CHANGE_EVENT, handleFontSettingsChange as EventListener)
    }
  }, [])

  const handleProviderVisibilityToggle = () => {
    const updated = {
      ...providerSettings,
      showProviderSelector: !providerSettings.showProviderSelector,
    }
    saveProviderSettings(updated)
    setProviderSettings(updated)
    showStatus({
      type: 'success',
      text: updated.showProviderSelector ? 'Provider selector will be visible.' : 'Provider selector hidden.',
    })
  }

  const handleDefaultProviderChange = (providerName: string) => {
    const updated = {
      ...providerSettings,
      defaultProvider: providerName || null,
    }
    saveProviderSettings(updated)
    setProviderSettings(updated)
    showStatus({
      type: 'success',
      text: providerName ? `Default provider set to "${providerName}".` : 'Default provider cleared.',
    })
  }

  const handleCompactionProviderChange = (providerName: string) => {
    const updated = {
      ...providerSettings,
      compactionProvider: providerName || null,
      compactionModel: null,
    }
    saveProviderSettings(updated)
    setProviderSettings(updated)
    showStatus({
      type: 'success',
      text: providerName
        ? `Compaction provider set to "${providerName}".`
        : 'Compaction provider will follow the current chat provider.',
    })
  }

  const handleCompactionModelChange = (modelName: string) => {
    const updated = {
      ...providerSettings,
      compactionModel: modelName || null,
    }
    saveProviderSettings(updated)
    setProviderSettings(updated)
    showStatus({
      type: 'success',
      text: modelName ? 'Compaction model updated.' : 'Compaction model will use provider default/current model.',
    })
  }

  const handleCompactionSystemPromptInputChange = (value: string) => {
    setCompactionSystemPromptInput(value)
    setCompactionSystemPromptTouched(true)
  }

  const commitCompactionSystemPromptChange = (value: string) => {
    const normalized = value.trim()
    const fallback = loadProviderSettings().compactionSystemPrompt
    const nextPrompt = normalized || fallback

    const updated = {
      ...providerSettings,
      compactionSystemPrompt: nextPrompt,
    }
    saveProviderSettings(updated)
    setProviderSettings(updated)
    setCompactionSystemPromptTouched(false)
    setCompactionSystemPromptInput(nextPrompt)
    showStatus({ type: 'success', text: 'Compaction system prompt updated.' })
  }

  const handleOpenAIChatGPTSignOut = () => {
    clearOpenAITokens()
    if (providers.currentProvider === 'OpenAI (ChatGPT)') {
      dispatch(chatSliceActions.providerSelected('OpenRouter'))
    }
    showStatus({ type: 'success', text: 'Signed out of OpenAI ChatGPT. You can sign in again from Chat.' })
  }

  const handleSaveBraveApiKey = async () => {
    const normalized = braveApiKeyInput.trim()
    if (!normalized) {
      showStatus({ type: 'error', text: 'Enter a Brave Search API key before saving.' })
      return
    }

    if (!window.electronAPI?.secrets?.braveSearch?.set) {
      showStatus({ type: 'error', text: 'Secure credential storage is unavailable in this build.' })
      return
    }

    setBraveApiKeySaving(true)
    try {
      const result = await window.electronAPI.secrets.braveSearch.set(normalized)
      if (!result?.success) {
        throw new Error(result?.error || 'Failed to save Brave API key.')
      }

      // Verify persistence by reading it back from secure storage.
      const persistedValue = await readBraveApiKeyFromSecureStore()
      if (!persistedValue) {
        throw new Error('Brave Search API key could not be verified after save.')
      }

      setBraveApiKeyInput(persistedValue)
      setBraveApiKeyConfigured(true)
      showStatus({ type: 'success', text: 'Brave Search API key saved securely.' })
    } catch (error) {
      console.error('Failed to save Brave API key:', error)
      showStatus({
        type: 'error',
        text: error instanceof Error ? error.message : 'Failed to save Brave Search API key.',
      })
    } finally {
      setBraveApiKeySaving(false)
    }
  }

  const handleDeleteBraveApiKey = async () => {
    if (!window.electronAPI?.secrets?.braveSearch?.delete) {
      showStatus({ type: 'error', text: 'Secure credential storage is unavailable in this build.' })
      return
    }

    setBraveApiKeySaving(true)
    try {
      const result = await window.electronAPI.secrets.braveSearch.delete()
      if (!result?.success) {
        throw new Error(result?.error || 'Failed to delete Brave API key.')
      }

      const persistedValue = await readBraveApiKeyFromSecureStore().catch(() => null)
      if (persistedValue) {
        throw new Error('Brave Search API key still appears configured after delete.')
      }

      setBraveApiKeyInput('')
      setBraveApiKeyConfigured(false)
      showStatus({ type: 'success', text: 'Brave Search API key removed.' })
    } catch (error) {
      console.error('Failed to delete Brave API key:', error)
      showStatus({
        type: 'error',
        text: error instanceof Error ? error.message : 'Failed to delete Brave Search API key.',
      })
    } finally {
      setBraveApiKeySaving(false)
    }
  }

  const handleSaveRemoteBaseUrl = () => {
    const trimmed = remoteBaseUrlInput.trim()
    if (!trimmed) {
      const saved = saveRemoteServerSettings({ remoteBaseUrl: null })
      setRemoteBaseUrlInput(saved.remoteBaseUrl ?? '')
      showStatus({
        type: 'info',
        text: 'Remote server URL cleared. The app will fall back to local server origin (usually 127.0.0.1).',
      })
      return
    }

    const normalized = normalizeRemoteBaseUrl(trimmed)
    if (!normalized) {
      showStatus({
        type: 'error',
        text: 'Remote server URL must start with http:// or https:// (example: http://192.168.0.119:3002).',
      })
      return
    }

    const saved = saveRemoteServerSettings({ remoteBaseUrl: normalized })
    setRemoteBaseUrlInput(saved.remoteBaseUrl ?? '')
    showStatus({ type: 'success', text: `Remote server URL saved: ${saved.remoteBaseUrl}` })
  }

  const handleOpenRemoteMobileUi = async () => {
    if (!effectiveRemoteMobileUrl) {
      showStatus({ type: 'error', text: 'No remote mobile URL available.' })
      return
    }

    try {
      if (window.electronAPI?.auth?.openExternal) {
        const result = await window.electronAPI.auth.openExternal(effectiveRemoteMobileUrl)
        if (!result?.success) {
          window.open(effectiveRemoteMobileUrl, '_blank', 'noopener,noreferrer')
        }
      } else {
        window.open(effectiveRemoteMobileUrl, '_blank', 'noopener,noreferrer')
      }
    } catch (error) {
      console.error('Failed to open remote mobile UI:', error)
      showStatus({ type: 'error', text: 'Failed to open remote mobile URL in browser.' })
    }
  }

  const handleCopyRemoteMobileUi = async () => {
    if (!effectiveRemoteMobileUrl) {
      showStatus({ type: 'error', text: 'No remote mobile URL to copy.' })
      return
    }

    try {
      await navigator.clipboard.writeText(effectiveRemoteMobileUrl)
      showStatus({ type: 'success', text: 'Remote mobile URL copied to clipboard.' })
    } catch (error) {
      console.error('Failed to copy remote mobile URL:', error)
      showStatus({ type: 'error', text: 'Failed to copy remote mobile URL. Copy it manually from the field.' })
    }
  }

  const handleOpenRouterTemperatureInputChange = (value: string) => {
    setOpenRouterTemperatureInput(value)
    setOpenRouterTemperatureTouched(true)
  }

  const commitOpenRouterTemperatureChange = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) {
      const updated = {
        ...providerSettings,
        openRouterTemperature: null,
      }
      saveProviderSettings(updated)
      setProviderSettings(updated)
      setOpenRouterTemperatureTouched(false)
      setOpenRouterTemperatureInput('')
      showStatus({ type: 'success', text: 'OpenRouter temperature reset to model default.' })
      return
    }

    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) {
      setOpenRouterTemperatureTouched(false)
      setOpenRouterTemperatureInput(
        typeof providerSettings.openRouterTemperature === 'number' ? String(providerSettings.openRouterTemperature) : ''
      )
      showStatus({ type: 'error', text: 'OpenRouter temperature must be a number between 0 and 2.' })
      return
    }

    const clamped = Math.max(MIN_OPENROUTER_TEMPERATURE, Math.min(MAX_OPENROUTER_TEMPERATURE, parsed))
    const normalized = Math.round(clamped * 100) / 100
    const updated = {
      ...providerSettings,
      openRouterTemperature: normalized,
    }
    saveProviderSettings(updated)
    setProviderSettings(updated)
    setOpenRouterTemperatureTouched(false)
    setOpenRouterTemperatureInput(String(normalized))

    if (normalized !== parsed) {
      showStatus({
        type: 'info',
        text: `OpenRouter temperature adjusted to ${normalized} (allowed range ${MIN_OPENROUTER_TEMPERATURE}-${MAX_OPENROUTER_TEMPERATURE}).`,
      })
      return
    }

    showStatus({ type: 'success', text: 'OpenRouter temperature updated.' })
  }

  const persistSubagentSettings = (nextSettings: SubagentToolSettings, successText: string) => {
    saveSubagentToolSettings(nextSettings)
    setSubagentSettings(nextSettings)
    showStatus({ type: 'success', text: successText })
  }

  const handleSubagentOrchestratorToggle = () => {
    persistSubagentSettings(
      {
        ...subagentSettings,
        orchestratorEnabled: !subagentSettings.orchestratorEnabled,
      },
      subagentSettings.orchestratorEnabled
        ? 'Subagent orchestrator disabled (tool calls off).'
        : 'Subagent orchestrator enabled (tool calls on).'
    )
  }

  const handleSubagentForceOpenAIToggle = () => {
    persistSubagentSettings(
      {
        ...subagentSettings,
        forceOpenAIProviderWhenChatGPTSelected: !subagentSettings.forceOpenAIProviderWhenChatGPTSelected,
      },
      !subagentSettings.forceOpenAIProviderWhenChatGPTSelected
        ? 'Subagent now forces OpenAI provider when chat provider is OpenAI (ChatGPT).'
        : 'Subagent no longer forces OpenAI provider from chat provider state.'
    )
  }

  const handleSubagentUseGlobalModelToggle = () => {
    persistSubagentSettings(
      {
        ...subagentSettings,
        useGlobalAgentModelAsDefault: !subagentSettings.useGlobalAgentModelAsDefault,
      },
      !subagentSettings.useGlobalAgentModelAsDefault
        ? 'Subagent now defaults to Global Agent model when tool call omits model.'
        : 'Subagent will no longer default to Global Agent model when model is omitted.'
    )
  }

  // Tool handlers
  const handleToolToggle = async (toolName: string, currentEnabled: boolean) => {
    setUpdatingTools(prev => new Set(prev).add(toolName))
    try {
      await dispatch(updateToolEnabled({ toolName, enabled: !currentEnabled })).unwrap()
      showStatus({ type: 'success', text: `${toolName} ${!currentEnabled ? 'enabled' : 'disabled'}.` })
    } catch (error) {
      console.error('Failed to update tool:', error)
      showStatus({ type: 'error', text: `Failed to update ${toolName}.` })
    } finally {
      setUpdatingTools(prev => {
        const newSet = new Set(prev)
        newSet.delete(toolName)
        return newSet
      })
    }
  }

  const handleReloadTools = async () => {
    setReloadingTools(true)
    try {
      await dispatch(fetchCustomTools())
      await dispatch(fetchTools())
      showStatus({ type: 'success', text: 'Tools reloaded.' })
    } catch (err) {
      console.error('Failed to reload tools:', err)
      showStatus({ type: 'error', text: 'Failed to reload tools.' })
    } finally {
      setReloadingTools(false)
    }
  }

  const showStatus = (message: StatusMessage) => {
    setStatusMessage(message)
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current)
    }

    timeoutRef.current = window.setTimeout(() => setStatusMessage(null), 4000)
  }

  const formatLocalUserOptionLabel = (user: LocalUserSummary) => {
    const baseName = user.username?.trim() || 'unnamed-user'
    const isDefaultLocal = user.id === LOCAL_AUTH_USER_ID
    const suffix = isDefaultLocal ? ' (default local)' : ''
    return `${baseName}${suffix} • ${user.conversation_count} conv • ${user.project_count} proj`
  }

  const fetchLocalUsers = async () => {
    if (import.meta.env.VITE_ENVIRONMENT !== 'electron') return

    setLocalUsersLoading(true)
    try {
      const users = await localApi.get<LocalUserSummary[]>('/local/users')
      setLocalUsers(users)

      setFromUserId(prev => {
        if (prev && users.some(user => user.id === prev)) return prev
        return users[0]?.id || ''
      })

      setToUserId(prev => {
        if (prev && users.some(user => user.id === prev)) return prev

        if (userId && users.some(user => user.id === userId)) {
          return userId
        }

        const first = users[0]?.id || ''
        const second = users.find(user => user.id !== first)?.id
        return second || first
      })
    } catch (error) {
      console.error('Failed to fetch local users:', error)
      showStatus({ type: 'error', text: 'Failed to load local users for migration.' })
    } finally {
      setLocalUsersLoading(false)
    }
  }

  const handleManualOwnershipMigration = async () => {
    if (!fromUserId || !toUserId) {
      showStatus({ type: 'error', text: 'Select both source and destination users.' })
      return
    }

    if (fromUserId === toUserId) {
      showStatus({ type: 'info', text: 'Source and destination users are the same.' })
      return
    }

    const source = localUsers.find(user => user.id === fromUserId)
    const destination = localUsers.find(user => user.id === toUserId)

    const sourceName = source?.username?.trim() || fromUserId
    const destinationName = destination?.username?.trim() || toUserId

    const confirmed = window.confirm(
      `Migrate local ownership from "${sourceName}" to "${destinationName}"?\n\nThis reassigns local projects, conversations, and provider costs.`
    )

    if (!confirmed) return

    setMigratingOwnership(true)
    try {
      const result = await localApi.post<LocalMergeResult>('/local/users/merge', {
        fromUserId,
        toUserId,
        toUsername: destination?.username || 'user',
        toCreatedAt: destination?.created_at || new Date().toISOString(),
      })

      if (!result?.merged) {
        showStatus({ type: 'info', text: result?.message || 'No migration was needed.' })
      } else {
        showStatus({
          type: 'success',
          text: `Migration complete: ${result.projects} projects, ${result.conversations} conversations, ${result.providerCosts} provider-cost rows moved.`,
        })
      }

      await fetchLocalUsers()
    } catch (error) {
      console.error('Failed to migrate local ownership:', error)
      showStatus({ type: 'error', text: 'Failed to migrate local ownership.' })
    } finally {
      setMigratingOwnership(false)
    }
  }

  useEffect(() => {
    if (import.meta.env.VITE_ENVIRONMENT !== 'electron') return
    fetchLocalUsers()
  }, [userId])

  const handleDefaultThinkingToggle = () => {
    const updated: ChatReasoningSettings = {
      ...chatReasoningSettings,
      defaultThinkingEnabled: !chatReasoningSettings.defaultThinkingEnabled,
    }
    saveChatReasoningSettings(updated)
    setChatReasoningSettings(updated)
    showStatus({
      type: 'success',
      text: updated.defaultThinkingEnabled
        ? 'Default thinking enabled for reasoning-capable models.'
        : 'Default thinking disabled.',
    })
  }

  const handleTokenUsageBarToggle = () => {
    const nextValue = !showTokenUsageBar
    saveShowTokenUsageBar(nextValue)
    setShowTokenUsageBar(nextValue)
    showStatus({
      type: 'success',
      text: nextValue ? 'Token usage bar enabled in Chat.' : 'Token usage bar hidden in Chat.',
    })
  }

  const persistAndApplyFontSettings = async (nextSettings: AppFontSettings) => {
    const saved = saveAppFontSettings(nextSettings)
    setFontSettings(saved)
    await applyAppFontSettings(saved)
  }

  const handleGoogleFontUrlApply = async () => {
    const validation = validateGoogleFontUrl(googleFontUrlInput)
    if (!validation.valid || !validation.normalizedUrl || !validation.family) {
      showStatus({ type: 'error', text: validation.error ?? 'Invalid Google Font URL.' })
      return
    }

    await persistAndApplyFontSettings({
      ...fontSettings,
      source: 'google',
      googleFontUrl: validation.normalizedUrl,
      googleFontFamily: validation.family,
    })

    showStatus({ type: 'success', text: `Google Font "${validation.family}" applied.` })
  }

  const handleResetAppFont = async () => {
    await persistAndApplyFontSettings({
      ...fontSettings,
      source: 'default',
    })
    showStatus({ type: 'success', text: 'App font reset to DM Sans.' })
  }

  const handleLocalFontUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    if (!isSupportedLocalFontFile(file)) {
      showStatus({ type: 'error', text: 'Only .woff2, .ttf, or .otf files are supported.' })
      if (fontFileInputRef.current) {
        fontFileInputRef.current.value = ''
      }
      return
    }

    if (file.size > MAX_FONT_UPLOAD_SIZE_BYTES) {
      showStatus({
        type: 'error',
        text: `Font file must be under ${formatSize(MAX_FONT_UPLOAD_SIZE_BYTES)}.`,
      })
      if (fontFileInputRef.current) {
        fontFileInputRef.current.value = ''
      }
      return
    }

    setFontUploading(true)

    try {
      await saveUploadedLocalFont(file)
      setHasLocalFontSaved(true)

      await persistAndApplyFontSettings({
        ...fontSettings,
        source: 'local',
      })

      showStatus({ type: 'success', text: `Local font "${file.name}" uploaded and applied.` })
    } catch (error) {
      console.error('Failed to upload local font:', error)
      showStatus({ type: 'error', text: 'Unable to upload local font.' })
    } finally {
      setFontUploading(false)
      if (fontFileInputRef.current) {
        fontFileInputRef.current.value = ''
      }
    }
  }

  const handleUseLocalFont = async () => {
    if (!hasLocalFontSaved) {
      showStatus({ type: 'error', text: 'Upload a local font first.' })
      return
    }

    await persistAndApplyFontSettings({
      ...fontSettings,
      source: 'local',
    })

    showStatus({ type: 'success', text: 'Local font applied.' })
  }

  const handleRemoveLocalFont = async () => {
    try {
      await clearStoredLocalFont()
      setHasLocalFontSaved(false)

      const nextSettings: AppFontSettings = {
        ...fontSettings,
        source: fontSettings.source === 'local' ? 'default' : fontSettings.source,
      }

      await persistAndApplyFontSettings(nextSettings)
      showStatus({ type: 'success', text: 'Stored local font removed.' })
    } catch (error) {
      console.error('Failed to remove local font:', error)
      showStatus({ type: 'error', text: 'Failed to remove local font.' })
    }
  }

  const handleDefaultReasoningEffortChange = (value: string) => {
    const effort = REASONING_EFFORT_OPTIONS.includes(value as (typeof REASONING_EFFORT_OPTIONS)[number])
      ? (value as ChatReasoningSettings['defaultReasoningEffort'])
      : 'medium'
    const updated: ChatReasoningSettings = {
      ...chatReasoningSettings,
      defaultReasoningEffort: effort,
    }
    saveChatReasoningSettings(updated)
    setChatReasoningSettings(updated)
    showStatus({
      type: 'success',
      text: `Default reasoning effort set to ${effort}.`,
    })
  }

  useEffect(() => {
    if (import.meta.env.VITE_ENVIRONMENT !== 'electron') {
      setAgentSettingsLoading(false)
      return
    }

    let isActive = true

    loadAgentSettings()
      .then(settings => {
        if (!isActive) return
        setAgentSettings(settings)
      })
      .catch(error => {
        console.error('Failed to load agent settings:', error)
        if (isActive) {
          showStatus({ type: 'error', text: 'Failed to load global agent settings.' })
        }
      })
      .finally(() => {
        if (isActive) {
          setAgentSettingsLoading(false)
        }
      })

    const handleAgentSettingsChange = (e: CustomEvent<AgentSettings>) => {
      if (!isActive) return
      setAgentSettings(e.detail)
    }

    window.addEventListener(AGENT_SETTINGS_CHANGE_EVENT, handleAgentSettingsChange as EventListener)
    return () => {
      isActive = false
      window.removeEventListener(AGENT_SETTINGS_CHANGE_EVENT, handleAgentSettingsChange as EventListener)
    }
  }, [])

  useEffect(() => {
    if (agentSettingsLoading || import.meta.env.VITE_ENVIRONMENT !== 'electron') return
    if (agentSettings.toolAllowlist && agentSettings.toolAllowlist.length > 0) return

    const defaultAllowlist = tools.filter(tool => tool.enabled || tool.name === 'bash').map(tool => tool.name)

    if (defaultAllowlist.length === 0) return

    const nextSettings = { ...agentSettings, toolAllowlist: defaultAllowlist }
    setAgentSettings(nextSettings)
    saveAgentSettings(nextSettings).catch(error => {
      console.error('Failed to persist default global agent tools:', error)
    })
  }, [agentSettings, agentSettingsLoading, tools])

  useEffect(() => {
    if (workDirectoryTouched) return
    setWorkDirectoryInput(agentSettings.workDirectory ?? '')
  }, [agentSettings.workDirectory, workDirectoryTouched])

  useEffect(() => {
    if (loopIntervalTouched) return
    setLoopIntervalInput(String(agentSettings.loopIntervalMs ?? 60000))
  }, [agentSettings.loopIntervalMs, loopIntervalTouched])

  useEffect(() => {
    if (toolCallTimeoutTouched) return
    setToolCallTimeoutInput(String(toolExecutionSettings.toolCallTimeoutMs))
  }, [toolExecutionSettings.toolCallTimeoutMs, toolCallTimeoutTouched])

  useEffect(() => {
    if (bashTimeoutTouched) return
    setBashTimeoutInput(String(toolExecutionSettings.bashTimeoutMs))
  }, [toolExecutionSettings.bashTimeoutMs, bashTimeoutTouched])

  useEffect(() => {
    if (!isChangelogOpen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsChangelogOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isChangelogOpen])

  const persistAgentSettings = async (nextSettings: AgentSettings, successText: string, errorText: string) => {
    setAgentSettings(nextSettings)

    if (import.meta.env.VITE_ENVIRONMENT !== 'electron') {
      return
    }

    setAgentSettingsSaving(true)
    try {
      const saved = await saveAgentSettings(nextSettings)
      setAgentSettings(saved)
      showStatus({ type: 'success', text: successText })
    } catch (error) {
      console.error('Failed to save agent settings:', error)
      showStatus({ type: 'error', text: errorText })
      try {
        const refreshed = await loadAgentSettings()
        setAgentSettings(refreshed)
      } catch (refreshError) {
        console.error('Failed to reload agent settings:', refreshError)
      }
    } finally {
      setAgentSettingsSaving(false)
    }
  }

  const handleHeartbeatTimeChange = async (value: string) => {
    const nextHeartbeat = value.trim().length > 0 ? value : null
    const nextSettings = { ...agentSettings, heartbeatTime: nextHeartbeat }
    await persistAgentSettings(
      nextSettings,
      nextHeartbeat ? 'Heartbeat time updated.' : 'Heartbeat disabled.',
      'Failed to update heartbeat time.'
    )
  }

  const handleAgentNameChange = async (value: string) => {
    const nextName = value.trim().length > 0 ? value.trim() : 'Global Agent'
    await persistAgentSettings(
      { ...agentSettings, agentName: nextName },
      'Global agent name updated.',
      'Failed to update agent name.'
    )
  }

  const handleModelChange = async (value: string) => {
    const trimmed = value.trim()
    const modelEntry = openRouterModelsData?.models?.find(model => model.name === trimmed)
    const contextLength = modelEntry?.contextLength ?? agentSettings.modelContextLength ?? null
    await persistAgentSettings(
      { ...agentSettings, model: trimmed || null, modelContextLength: contextLength },
      'Global agent model updated.',
      'Failed to update agent model.'
    )
  }

  const handleLoopIntervalInputChange = (value: string) => {
    setLoopIntervalInput(value)
    setLoopIntervalTouched(true)
  }

  const handleToolCallTimeoutInputChange = (value: string) => {
    setToolCallTimeoutInput(value)
    setToolCallTimeoutTouched(true)
  }

  const handleBashTimeoutInputChange = (value: string) => {
    setBashTimeoutInput(value)
    setBashTimeoutTouched(true)
  }

  const handleWorkDirectoryInputChange = (value: string) => {
    setWorkDirectoryInput(value)
    setWorkDirectoryTouched(true)
  }

  const commitWorkDirectoryChange = async (value: string) => {
    const nextWorkDirectory = value.trim().length > 0 ? value.trim() : null
    setWorkDirectoryTouched(false)
    setWorkDirectoryInput(nextWorkDirectory ?? '')
    await persistAgentSettings(
      { ...agentSettings, workDirectory: nextWorkDirectory },
      nextWorkDirectory ? 'Global agent work directory updated.' : 'Global agent work directory cleared.',
      'Failed to update global agent work directory.'
    )
  }

  const commitLoopIntervalChange = async (value: string) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setLoopIntervalTouched(false)
      setLoopIntervalInput(String(agentSettings.loopIntervalMs ?? 60000))
      return
    }

    const nextInterval = Math.floor(parsed)
    setLoopIntervalTouched(false)
    await persistAgentSettings(
      { ...agentSettings, loopIntervalMs: nextInterval },
      'Loop cadence updated.',
      'Failed to update loop cadence.'
    )
  }

  const commitToolCallTimeoutChange = (value: string) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setToolCallTimeoutTouched(false)
      setToolCallTimeoutInput(String(toolExecutionSettings.toolCallTimeoutMs))
      showStatus({ type: 'error', text: 'Tool call timeout must be a positive number of milliseconds.' })
      return
    }

    const clamped = Math.max(MIN_TOOL_CALL_TIMEOUT_MS, Math.min(MAX_TOOL_CALL_TIMEOUT_MS, Math.floor(parsed)))
    const nextSettings: ToolExecutionSettings = {
      ...toolExecutionSettings,
      toolCallTimeoutMs: clamped,
    }
    saveToolExecutionSettings(nextSettings)
    setToolExecutionSettings(nextSettings)
    setToolCallTimeoutTouched(false)
    setToolCallTimeoutInput(String(clamped))

    if (clamped !== Math.floor(parsed)) {
      showStatus({
        type: 'info',
        text: `Tool call timeout adjusted to ${clamped}ms (allowed range ${MIN_TOOL_CALL_TIMEOUT_MS}-${MAX_TOOL_CALL_TIMEOUT_MS}ms).`,
      })
      return
    }

    showStatus({ type: 'success', text: 'Default tool call timeout updated.' })
  }

  const commitBashTimeoutChange = (value: string) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setBashTimeoutTouched(false)
      setBashTimeoutInput(String(toolExecutionSettings.bashTimeoutMs))
      showStatus({ type: 'error', text: 'Bash timeout must be a positive number of milliseconds.' })
      return
    }

    const clamped = Math.max(MIN_BASH_TIMEOUT_MS, Math.min(MAX_BASH_TIMEOUT_MS, Math.floor(parsed)))
    const nextSettings: ToolExecutionSettings = {
      ...toolExecutionSettings,
      bashTimeoutMs: clamped,
    }
    saveToolExecutionSettings(nextSettings)
    setToolExecutionSettings(nextSettings)
    setBashTimeoutTouched(false)
    setBashTimeoutInput(String(clamped))

    if (clamped !== Math.floor(parsed)) {
      showStatus({
        type: 'info',
        text: `Bash timeout adjusted to ${clamped}ms (allowed range ${MIN_BASH_TIMEOUT_MS}-${MAX_BASH_TIMEOUT_MS}ms).`,
      })
      return
    }

    showStatus({ type: 'success', text: 'Default bash timeout updated.' })
  }

  const handleAutoResumeToggle = async () => {
    await persistAgentSettings(
      { ...agentSettings, autoResume: !agentSettings.autoResume },
      'Auto-resume updated.',
      'Failed to update auto-resume.'
    )
  }

  const handleAgentToolToggle = async (toolName: string) => {
    const current = agentSettings.toolAllowlist ?? []
    const next = current.includes(toolName) ? current.filter(name => name !== toolName) : [...current, toolName]
    await persistAgentSettings(
      { ...agentSettings, toolAllowlist: next },
      'Global agent tools updated.',
      'Failed to update global agent tools.'
    )
  }

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    if (!['video/mp4', 'video/webm'].includes(file.type)) {
      showStatus({ type: 'error', text: 'Video must be in MP4 or WebM format.' })
      return
    }

    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
      showStatus({ type: 'error', text: 'File must be smaller than 8MB to keep localStorage responsive.' })
      return
    }

    setUploading(true)

    try {
      const entry = await addCustomVideo({
        mimeType: file.type,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        blob: file,
      })

      persistActiveCustomVideoId(entry.id)
      setVideos(loadSavedVideos())
      setActiveVideoId(entry.id)
      showStatus({ type: 'success', text: 'Custom video saved and activated.' })
    } catch (error) {
      console.error(error)
      showStatus({ type: 'error', text: 'Unable to save the custom video. Try again.' })
    } finally {
      setUploading(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  const handleSelectVideo = (id: string) => {
    persistActiveCustomVideoId(id)
    persistBackgroundMode('video')
    setActiveVideoId(id)
    setBackgroundMode('video')
    showStatus({ type: 'success', text: 'Active background updated.' })
  }

  const handleRemoveVideo = (id: string) => {
    removeCustomVideo(id)
    setVideos(loadSavedVideos())
    if (activeVideoId === id) {
      setActiveVideoId(null)
    }
    showStatus({ type: 'info', text: 'Video removed from gallery.' })
  }

  const handleClearGallery = () => {
    clearCustomVideoLibrary()
    setVideos([])
    setActiveVideoId(null)
    showStatus({ type: 'success', text: 'Gallery cleared. Default wallpapers will be used.' })
  }

  const handleResetToDefault = () => {
    persistActiveCustomVideoId(null)
    persistBackgroundMode('video')
    setActiveVideoId(null)
    setBackgroundMode('video')
    showStatus({ type: 'success', text: 'Reverted to the built-in defaults.' })
  }

  const handleTextColorModeChange = (id: string, mode: 'light' | 'dark' | 'auto') => {
    updateCustomVideoTextColorMode(id, mode)
    setVideos(loadSavedVideos())
    showStatus({ type: 'success', text: `Text color mode set to "${mode}".` })
  }

  const handleBackgroundModeChange = (mode: BackgroundMode) => {
    persistBackgroundMode(mode, backgroundColors)
    setBackgroundMode(mode)
    showStatus({
      type: 'success',
      text: mode === 'color' ? 'Solid color background enabled.' : 'Video wallpaper enabled.',
    })
  }

  const handleBackgroundColorChange = (variant: 'light' | 'dark', value: string) => {
    if (customThemeEnabled) {
      const nextTheme = {
        ...customTheme,
        colors: {
          ...customTheme.colors,
          appBackgroundColor: {
            ...customTheme.colors.appBackgroundColor,
            [variant]: value,
          },
        },
      }
      saveCustomChatTheme(nextTheme)
      setCustomChatThemeEnabled(true)
      return
    }

    const nextColors = { ...backgroundColors, [variant]: value }
    persistBackgroundColors(nextColors)
    setBackgroundColors(loadBackgroundColors())
  }

  const handleGoogleDriveConnect = async () => {
    if (isCommunityMode) {
      showStatus({ type: 'info', text: 'Google Drive is disabled in community mode.' })
      return
    }

    if (!accessToken) {
      showStatus({ type: 'error', text: 'Sign in required to connect Google Drive.' })
      return
    }

    setGoogleConnecting(true)
    try {
      const response = await fetch(`${API_BASE}/oauth/google-drive/start`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      })

      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(payload?.error || 'Unable to start Google Drive connection.')
      }

      if (!payload?.authUrl) {
        throw new Error('No Google authorization URL returned.')
      }

      if (window.electronAPI?.auth?.openExternal) {
        const result = await window.electronAPI.auth.openExternal(payload.authUrl)
        if (!result?.success) {
          window.open(payload.authUrl, '_blank', 'noopener,noreferrer')
        }
      } else {
        window.open(payload.authUrl, '_blank', 'noopener,noreferrer')
      }

      showStatus({
        type: 'info',
        text: 'Google Drive sign-in opened in your browser. Refresh this page after signing in.',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to open Google Drive sign-in.'
      showStatus({ type: 'error', text: message })
    } finally {
      setGoogleConnecting(false)
    }
  }

  const handleGoogleDriveDisconnect = async () => {
    if (isCommunityMode) {
      showStatus({ type: 'info', text: 'Google Drive is disabled in community mode.' })
      return
    }
    if (!accessToken) return

    setGoogleDisconnecting(true)
    try {
      const response = await fetch(`${API_BASE}/oauth/google-drive/disconnect`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      })

      if (!response.ok) {
        throw new Error('Failed to disconnect Google Drive.')
      }

      setGoogleDriveStatus({ connected: false, connectedAt: null, lastUsedAt: null })
      showStatus({ type: 'success', text: 'Google Drive disconnected.' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to disconnect Google Drive.'
      showStatus({ type: 'error', text: message })
    } finally {
      setGoogleDisconnecting(false)
    }
  }

  const renderStatus = () => {
    if (!statusMessage) return null

    const colors = {
      success:
        'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-900/40 dark:border-emerald-800 dark:text-emerald-200',
      error: 'bg-rose-50 text-rose-800 border-rose-200 dark:bg-rose-900/40 dark:border-rose-800 dark:text-rose-200',
      info: 'bg-sky-50 text-sky-800 border-sky-200 dark:bg-sky-900/40 dark:border-sky-800 dark:text-sky-200',
    }

    return (
      <div className={`rounded-lg border px-4 py-2 text-sm ${colors[statusMessage.type]}`}>{statusMessage.text}</div>
    )
  }

  return (
    <div className='h-full overflow-y-auto thin-scrollbar bg-transparent min-h-full'>
      <div className='mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8'>
        <header className='flex flex-wrap items-center justify-between gap-4'>
          <div>
            {/* <p className='text-sm uppercase tracking-[0.3em] video-light:text-neutral-100 video-dark:text-neutral-900'>
              Config
            </p> */}
            <h1 className='text-3xl font-semibold video-light:text-neutral-100 video-dark:text-neutral-900 '>
              Settings
            </h1>
          </div>
          <div className='flex items-center gap-3'>
            <button
              type='button'
              onClick={() => setIsChangelogOpen(true)}
              className='rounded-full border border-stone-300 bg-stone-100 px-3 py-1 font-mono text-xs tracking-wide text-stone-700 transition hover:bg-stone-200 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-200 dark:hover:bg-stone-700'
            >
              CHANGELOG
            </button>
            <Button variant='acrylic' onClick={() => navigate(-1)} className='group'>
              <p className='transition-transform duration-100 group-active:scale-95'>Back</p>
            </Button>
          </div>
        </header>

        {renderStatus()}

        {isChangelogOpen && (
          <div
            className='fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4'
            onClick={() => setIsChangelogOpen(false)}
          >
            <div
              className='w-full max-w-4xl max-h-[85vh] overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-2xl dark:border-stone-700 dark:bg-zinc-900'
              onClick={event => event.stopPropagation()}
            >
              <div className='flex items-center justify-between border-b border-stone-200 px-4 py-3 dark:border-stone-700'>
                <p className='font-mono text-sm tracking-wide text-stone-800 dark:text-stone-100'>CHANGELOG</p>
                <button
                  type='button'
                  onClick={() => setIsChangelogOpen(false)}
                  className='rounded-md px-2 py-1 text-stone-600 transition hover:bg-stone-100 hover:text-stone-900 dark:text-stone-300 dark:hover:bg-stone-800 dark:hover:text-stone-100'
                >
                  ✕
                </button>
              </div>
              <div className='max-h-[calc(85vh-60px)] overflow-y-auto thin-scrollbar p-4'>
                <div className='prose prose-sm max-w-none dark:prose-invert prose-headings:font-semibold prose-pre:rounded-lg prose-pre:border prose-pre:border-stone-300 dark:prose-pre:border-stone-700'>
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeHighlight, rehypeKatex]}>
                    {changelogMarkdown}
                  </ReactMarkdown>
                </div>
              </div>
            </div>
          </div>
        )}

        <section className='rounded-2xl border border-neutral-200 mica p-6 shadow-lg shadow-neutral-200/30 dark:border-neutral-800 dark:shadow-black/20'>
          <div className='flex flex-col gap-1'>
            <h2 className='text-xl font-semibold text-stone-900 dark:text-stone-100 mb-2'>Chat Reasoning Defaults</h2>
            <p className='text-sm text-stone-500 dark:text-stone-200'>
              These defaults are loaded every time Chat opens, then applied when the selected model supports
              reasoning/thinking.
            </p>
          </div>

          <div className='mt-4 flex flex-col gap-4'>
            <div className='flex items-center justify-between'>
              <div>
                <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Default Thinking</p>
                <p className='text-sm text-stone-500 dark:text-stone-400'>
                  Automatically turn thinking on for models that support it.
                </p>
              </div>
              <button
                onClick={handleDefaultThinkingToggle}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  chatReasoningSettings.defaultThinkingEnabled
                    ? 'bg-emerald-500 dark:bg-emerald-600'
                    : 'bg-stone-300 dark:bg-stone-600'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    chatReasoningSettings.defaultThinkingEnabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            <div className='flex flex-col gap-2 pt-2 border-t border-stone-200 dark:border-stone-700'>
              <div>
                <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Default Reasoning Effort</p>
                <p className='text-sm text-stone-500 dark:text-stone-400'>
                  Used when thinking is enabled. The model must support reasoning.
                </p>
              </div>
              <Select
                value={chatReasoningSettings.defaultReasoningEffort}
                onChange={handleDefaultReasoningEffortChange}
                options={REASONING_EFFORT_OPTIONS.map(option => ({
                  value: option,
                  label:
                    option === 'medium'
                      ? 'Medium (Default)'
                      : option === 'xhigh'
                        ? 'X-High'
                        : option.charAt(0).toUpperCase() + option.slice(1),
                }))}
                className='max-w-xs'
              />
            </div>
          </div>
        </section>

        <section className='rounded-2xl border border-neutral-200 mica p-6 shadow-lg shadow-neutral-200/30 dark:border-neutral-800 dark:shadow-black/20'>
          <div className='flex flex-col gap-1'>
            <h2 className='text-xl font-semibold text-stone-900 dark:text-stone-100 mb-2'>Chat Interface</h2>
            <p className='text-sm text-stone-500 dark:text-stone-200'>Control optional chat UI elements.</p>
          </div>

          <div className='mt-4 flex flex-col gap-4'>
            <div className='flex items-center justify-between'>
              <div>
                <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Show Token Usage Bar</p>
                <p className='text-sm text-stone-500 dark:text-stone-400'>
                  Display input/output token progress and credit refresh in the chat composer.
                </p>
              </div>
              <button
                onClick={handleTokenUsageBarToggle}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  showTokenUsageBar ? 'bg-emerald-500 dark:bg-emerald-600' : 'bg-stone-300 dark:bg-stone-600'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    showTokenUsageBar ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </div>
        </section>

        <section className='rounded-2xl border border-neutral-200 mica p-6 shadow-lg shadow-neutral-200/30 dark:border-neutral-800 dark:shadow-black/20'>
          <div className='flex flex-col gap-1'>
            <h2 className='text-xl font-semibold text-stone-900 dark:text-stone-100 mb-2'>Typography</h2>
            <p className='text-sm text-stone-500 dark:text-stone-200'>
              Set app font from a Google Fonts URL or a local font file.
            </p>
          </div>

          <div className='mt-4 flex flex-col gap-5'>
            <div className='flex flex-col gap-2'>
              <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Google Fonts URL</p>
              <p className='text-sm text-stone-500 dark:text-stone-400'>
                Only <code>https://fonts.googleapis.com/css</code> and <code>/css2</code> links are accepted.
              </p>
              <input
                type='url'
                value={googleFontUrlInput}
                onChange={event => setGoogleFontUrlInput(event.target.value)}
                placeholder='https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap'
                className='w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 dark:border-stone-700 dark:bg-zinc-900 dark:text-stone-100'
              />
              <div className='flex flex-wrap items-center gap-2'>
                <Button variant='primary' size='small' onClick={handleGoogleFontUrlApply}>
                  Apply Google Font
                </Button>
                <Button variant='outline2' size='small' onClick={handleResetAppFont}>
                  Reset to DM Sans
                </Button>
              </div>
            </div>

            <div className='pt-3 border-t border-stone-200 dark:border-stone-700 flex flex-col gap-2'>
              <input
                ref={fontFileInputRef}
                type='file'
                accept={LOCAL_FONT_ACCEPT}
                className='hidden'
                onChange={handleLocalFontUpload}
              />
              <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Local Font Upload</p>
              <p className='text-sm text-stone-500 dark:text-stone-400'>
                Upload <code>.woff2</code>, <code>.ttf</code>, or <code>.otf</code> (max{' '}
                {formatSize(MAX_FONT_UPLOAD_SIZE_BYTES)}).
              </p>
              <div className='flex flex-wrap items-center gap-2'>
                <Button
                  variant='acrylic'
                  size='small'
                  onClick={() => fontFileInputRef.current?.click()}
                  disabled={fontUploading}
                >
                  {fontUploading ? 'Uploading…' : 'Upload Local Font'}
                </Button>
                <Button variant='outline2' size='small' onClick={handleUseLocalFont} disabled={!hasLocalFontSaved}>
                  Use Local Font
                </Button>
                <Button variant='outline2' size='small' onClick={handleRemoveLocalFont} disabled={!hasLocalFontSaved}>
                  Remove Local Font
                </Button>
              </div>
              <p className='text-xs text-stone-500 dark:text-stone-400'>
                Active source:{' '}
                <span className='font-mono'>
                  {fontSettings.source === 'google'
                    ? `google (${fontSettings.googleFontFamily ?? 'unknown'})`
                    : fontSettings.source}
                </span>
              </p>
            </div>
          </div>
        </section>

        {import.meta.env.VITE_ENVIRONMENT === 'electron' && (
          <section className='rounded-2xl border border-neutral-200 mica p-6 shadow-lg shadow-neutral-200/30 dark:border-neutral-800 dark:shadow-black/20'>
            <div className='flex flex-col gap-1'>
              <h2 className='text-xl font-semibold text-stone-900 dark:text-stone-100 mb-2'>Remote Mobile Access</h2>
              <p className='text-sm text-stone-500 dark:text-stone-200'>
                Configure a LAN URL for your phone/tablet (same Wi-Fi), then open or scan the QR code.
              </p>
            </div>

            <div className='mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_240px]'>
              <div className='flex flex-col gap-3'>
                <div className='flex flex-col gap-2'>
                  <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Remote Server Base URL</p>
                  <input
                    type='url'
                    value={remoteBaseUrlInput}
                    placeholder='http://192.168.0.119:3002'
                    onChange={event => setRemoteBaseUrlInput(event.target.value)}
                    className='w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 dark:border-stone-700 dark:bg-zinc-900 dark:text-stone-100'
                  />
                  <p className='text-xs text-stone-500 dark:text-stone-400'>
                    Leave blank to use detected local origin: {detectedLocalServerOrigin || 'resolving...'}
                  </p>
                </div>

                <div className='flex flex-wrap items-center gap-2'>
                  <Button variant='primary' size='small' onClick={handleSaveRemoteBaseUrl}>
                    Save Remote URL
                  </Button>
                  <Button
                    variant='outline2'
                    size='small'
                    onClick={() => {
                      setRemoteBaseUrlInput('')
                      saveRemoteServerSettings({ remoteBaseUrl: null })
                      showStatus({
                        type: 'info',
                        text: 'Remote server URL cleared. Using detected local origin as fallback.',
                      })
                    }}
                  >
                    Clear
                  </Button>
                  <Button
                    variant='outline2'
                    size='small'
                    onClick={handleOpenRemoteMobileUi}
                    disabled={!effectiveRemoteMobileUrl}
                  >
                    Open Mobile UI
                  </Button>
                  <Button
                    variant='outline2'
                    size='small'
                    onClick={handleCopyRemoteMobileUi}
                    disabled={!effectiveRemoteMobileUrl}
                  >
                    Copy URL
                  </Button>
                </div>

                <div className='rounded-lg border border-stone-200 bg-stone-50/70 px-3 py-2 text-xs text-stone-600 dark:border-stone-700 dark:bg-stone-800/40 dark:text-stone-300 break-all'>
                  <p className='font-medium mb-1 text-stone-700 dark:text-stone-200'>Effective mobile URL</p>
                  <p>{effectiveRemoteMobileUrl || 'Unavailable'}</p>
                </div>
              </div>

              <div className='flex flex-col items-start gap-2'>
                <p className='text-sm font-medium text-stone-900 dark:text-stone-100'>Scan QR (phone)</p>
                {remoteQrCodeImageUrl ? (
                  <img
                    src={remoteQrCodeImageUrl}
                    alt='QR code for remote mobile URL'
                    className='h-[220px] w-[220px] rounded-lg border border-stone-200 bg-white p-2 dark:border-stone-700'
                  />
                ) : (
                  <div className='flex h-[220px] w-[220px] items-center justify-center rounded-lg border border-dashed border-stone-300 text-xs text-stone-500 dark:border-stone-600 dark:text-stone-400'>
                    Enter or detect a URL to render QR
                  </div>
                )}
                <p className='text-[11px] text-stone-500 dark:text-stone-400'>
                  QR image is rendered via api.qrserver.com.
                </p>
              </div>
            </div>
          </section>
        )}

        {/* Provider Settings Section */}
        {import.meta.env.VITE_ENVIRONMENT === 'electron' && (
          <section className='rounded-2xl border border-neutral-200 mica p-6 shadow-lg shadow-neutral-200/30 dark:border-neutral-800 dark:shadow-black/20'>
            <div className='flex flex-col gap-1'>
              <h2 className='text-xl font-semibold text-stone-900 dark:text-stone-100 mb-2'>Provider Settings</h2>
              <p className='text-sm text-stone-500 dark:text-stone-200'>
                Configure how providers appear in the chat interface.
              </p>
            </div>

            <div className='mt-4 flex flex-col gap-4'>
              {/* Visibility Toggle */}
              <div className='flex items-center justify-between'>
                <div>
                  <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Show Provider Selector</p>
                  <p className='text-sm text-stone-500 dark:text-stone-400'>
                    Toggle visibility of the provider dropdown in the chat.
                  </p>
                </div>
                <button
                  onClick={handleProviderVisibilityToggle}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    providerSettings.showProviderSelector
                      ? 'bg-emerald-500 dark:bg-emerald-600'
                      : 'bg-stone-300 dark:bg-stone-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      providerSettings.showProviderSelector ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              {/* Default Provider Selection - shown when selector is hidden */}
              {!providerSettings.showProviderSelector && (
                <div className='flex flex-col gap-2 pt-2 border-t border-stone-200 dark:border-stone-700'>
                  <div>
                    <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Default Provider</p>
                    <p className='text-sm text-stone-500 dark:text-stone-400'>
                      This provider will be used automatically when the selector is hidden.
                    </p>
                  </div>
                  <Select
                    value={providerSettings.defaultProvider || ''}
                    onChange={handleDefaultProviderChange}
                    options={providers.providers.map(p => p.name)}
                    placeholder='Select a default provider...'
                    disabled={providers.providers.length === 0}
                    className='max-w-xs'
                  />
                  {providers.providers.length === 0 && (
                    <p className='text-xs text-amber-600 dark:text-amber-400'>
                      No providers available. Open a chat first to load providers.
                    </p>
                  )}
                </div>
              )}

              <div className='flex flex-col gap-2 pt-2 border-t border-stone-200 dark:border-stone-700'>
                <div>
                  <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Auto-Compaction Provider</p>
                  <p className='text-sm text-stone-500 dark:text-stone-400'>
                    Provider/model used when chat auto-compacts context near the token limit.
                  </p>
                </div>
                <Select
                  value={providerSettings.compactionProvider || ''}
                  onChange={handleCompactionProviderChange}
                  options={[
                    { value: '', label: 'Follow current chat provider' },
                    ...providers.providers.map(p => ({ value: p.name, label: p.name })),
                  ]}
                  placeholder='Follow current chat provider'
                  className='max-w-xs'
                />
                <Select
                  value={providerSettings.compactionModel || ''}
                  onChange={handleCompactionModelChange}
                  options={[
                    { value: '', label: 'Use provider default/current model' },
                    ...((compactionModelsData?.models || []).map(model => ({
                      value: model.name,
                      label: model.name,
                    })) as any[]),
                  ]}
                  placeholder='Use provider default/current model'
                  className='max-w-xl'
                />
                <div className='flex flex-col gap-2 pt-2'>
                  <div>
                    <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Compaction System Prompt</p>
                    <p className='text-sm text-stone-500 dark:text-stone-400'>
                      Used when generating auto-compaction summaries before continued conversation.
                    </p>
                  </div>
                  <textarea
                    value={compactionSystemPromptInput}
                    onChange={e => handleCompactionSystemPromptInputChange(e.target.value)}
                    onBlur={e => commitCompactionSystemPromptChange(e.target.value)}
                    rows={6}
                    className='w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 dark:border-stone-700 dark:bg-zinc-900 dark:text-stone-100'
                  />
                </div>
              </div>

              <div className='flex flex-col gap-2 pt-2 border-t border-stone-200 dark:border-stone-700'>
                <div>
                  <p className='text-base font-medium text-stone-900 dark:text-stone-100'>OpenRouter Temperature</p>
                  <p className='text-sm text-stone-500 dark:text-stone-400'>
                    Optional default for OpenRouter requests. Leave blank to use each model&apos;s default.
                  </p>
                </div>
                <div className='flex items-center gap-2'>
                  <input
                    type='number'
                    min={MIN_OPENROUTER_TEMPERATURE}
                    max={MAX_OPENROUTER_TEMPERATURE}
                    step={0.1}
                    value={openRouterTemperatureInput}
                    placeholder='model default'
                    onChange={e => handleOpenRouterTemperatureInputChange(e.target.value)}
                    onBlur={e => commitOpenRouterTemperatureChange(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.currentTarget.blur()
                      }
                    }}
                    className='w-40 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 dark:border-stone-700 dark:bg-zinc-900 dark:text-stone-100'
                  />
                  {providerSettings.openRouterTemperature !== null && (
                    <Button
                      variant='outline2'
                      size='small'
                      onClick={() => commitOpenRouterTemperatureChange('')}
                      className='h-[36px]'
                    >
                      Reset
                    </Button>
                  )}
                </div>
                <p className='text-xs text-stone-500 dark:text-stone-400'>
                  Range: {MIN_OPENROUTER_TEMPERATURE} to {MAX_OPENROUTER_TEMPERATURE}.
                </p>
              </div>

              <div className='flex flex-col gap-2 pt-2 border-t border-stone-200 dark:border-stone-700'>
                <div>
                  <p className='text-base font-medium text-stone-900 dark:text-stone-100'>OpenAI ChatGPT Account</p>
                  <p className='text-sm text-stone-500 dark:text-stone-400'>
                    Sign out to clear local ChatGPT OAuth tokens. You can sign in again from Chat when selecting OpenAI
                    (ChatGPT).
                  </p>
                </div>
                <div className='flex flex-wrap items-center gap-3'>
                  <span
                    className={`text-xs px-2 py-1 rounded-full border ${
                      isOpenAIAuthenticated()
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-900/30 dark:border-emerald-700 dark:text-emerald-300'
                        : 'bg-stone-100 border-stone-200 text-stone-600 dark:bg-stone-800 dark:border-stone-700 dark:text-stone-300'
                    }`}
                  >
                    {isOpenAIAuthenticated() ? 'Signed in' : 'Signed out'}
                  </span>
                  <Button
                    variant='outline2'
                    size='small'
                    onClick={handleOpenAIChatGPTSignOut}
                    disabled={!isOpenAIAuthenticated()}
                  >
                    Sign out of ChatGPT
                  </Button>
                </div>
              </div>
            </div>
          </section>
        )}

        {import.meta.env.VITE_ENVIRONMENT === 'electron' && (
          <section className='rounded-2xl border border-neutral-200 mica p-6 shadow-lg shadow-neutral-200/30 dark:border-neutral-800 dark:shadow-black/20'>
            <div className='flex flex-col gap-1'>
              <h2 className='text-xl font-semibold text-stone-900 dark:text-stone-100 mb-2'>Subagent</h2>
              <p className='text-sm text-stone-500 dark:text-stone-200'>
                Configure default subagent behavior used by the <code>subagent</code> tool.
              </p>
            </div>

            <div className='mt-4 flex flex-col gap-4'>
              <div className='flex items-center justify-between'>
                <div>
                  <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Enable Orchestrator Tool Calls</p>
                  <p className='text-sm text-stone-500 dark:text-stone-400'>
                    Controls whether subagents can execute tools at all.
                  </p>
                </div>
                <button
                  onClick={handleSubagentOrchestratorToggle}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    subagentSettings.orchestratorEnabled
                      ? 'bg-emerald-500 dark:bg-emerald-600'
                      : 'bg-stone-300 dark:bg-stone-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      subagentSettings.orchestratorEnabled ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              <div className='flex items-center justify-between pt-2 border-t border-stone-200 dark:border-stone-700'>
                <div>
                  <p className='text-base font-medium text-stone-900 dark:text-stone-100'>
                    Force OpenAI Provider for ChatGPT Parent
                  </p>
                  <p className='text-sm text-stone-500 dark:text-stone-400'>
                    When current chat provider is <code>OpenAI (ChatGPT)</code>, subagent calls set provider to OpenAI.
                  </p>
                </div>
                <button
                  onClick={handleSubagentForceOpenAIToggle}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    subagentSettings.forceOpenAIProviderWhenChatGPTSelected
                      ? 'bg-emerald-500 dark:bg-emerald-600'
                      : 'bg-stone-300 dark:bg-stone-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      subagentSettings.forceOpenAIProviderWhenChatGPTSelected ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              <div className='flex items-center justify-between pt-2 border-t border-stone-200 dark:border-stone-700'>
                <div>
                  <p className='text-base font-medium text-stone-900 dark:text-stone-100'>
                    Default to Global Agent Model
                  </p>
                  <p className='text-sm text-stone-500 dark:text-stone-400'>
                    If subagent tool call omits <code>model</code>, use Global Agent model from Settings.
                  </p>
                  <p className='text-xs text-stone-500 dark:text-stone-400 mt-1'>
                    Current fallback model: <code>{subagentDefaultModelPreview}</code>
                  </p>
                </div>
                <button
                  onClick={handleSubagentUseGlobalModelToggle}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    subagentSettings.useGlobalAgentModelAsDefault
                      ? 'bg-emerald-500 dark:bg-emerald-600'
                      : 'bg-stone-300 dark:bg-stone-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      subagentSettings.useGlobalAgentModelAsDefault ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              <p className='text-xs text-stone-500 dark:text-stone-400 pt-2 border-t border-stone-200 dark:border-stone-700'>
                Note: subagent turn/tool quota args and verbose return summary have been removed for a simpler output.
              </p>
            </div>
          </section>
        )}

        {import.meta.env.VITE_ENVIRONMENT === 'electron' && (
          <section className='rounded-2xl border border-neutral-200 mica p-6 shadow-lg shadow-neutral-200/30 dark:border-neutral-800 dark:shadow-black/20'>
            <div className='flex flex-col gap-1'>
              <h2 className='text-xl font-semibold text-stone-900 dark:text-stone-100 mb-2'>API Keys</h2>
              <p className='text-sm text-stone-500 dark:text-stone-200'>
                Store local tool credentials securely in your OS keychain via keytar.
              </p>
            </div>

            <div className='mt-4 flex flex-col gap-4'>
              <div className='flex flex-col gap-2'>
                <div className='flex flex-wrap items-center gap-3'>
                  <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Brave Search API Key</p>
                  <span
                    className={`text-xs px-2 py-1 rounded-full border ${
                      braveApiKeyConfigured
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-900/30 dark:border-emerald-700 dark:text-emerald-300'
                        : 'bg-stone-100 border-stone-200 text-stone-600 dark:bg-stone-800 dark:border-stone-700 dark:text-stone-300'
                    }`}
                  >
                    {braveApiKeyLoading ? 'Loading…' : braveApiKeyConfigured ? 'Configured' : 'Not configured'}
                  </span>
                </div>
                <p className='text-sm text-stone-500 dark:text-stone-400'>
                  Used by the local <code>brave_search</code> tool when running in Electron.
                </p>
                <input
                  type='password'
                  value={braveApiKeyInput}
                  placeholder='Enter Brave Search API key'
                  onChange={e => setBraveApiKeyInput(e.target.value)}
                  className='w-full max-w-xl rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 dark:border-stone-700 dark:bg-zinc-900 dark:text-stone-100'
                />
                <div className='flex flex-wrap items-center gap-2'>
                  <Button
                    variant='primary'
                    size='small'
                    onClick={handleSaveBraveApiKey}
                    disabled={braveApiKeySaving || braveApiKeyLoading || !braveApiKeyInput.trim()}
                  >
                    {braveApiKeySaving ? 'Saving…' : 'Save Brave API Key'}
                  </Button>
                  <Button
                    variant='outline2'
                    size='small'
                    onClick={handleDeleteBraveApiKey}
                    disabled={braveApiKeySaving || braveApiKeyLoading || !braveApiKeyConfigured}
                  >
                    Remove
                  </Button>
                </div>
                <p className='text-xs text-stone-500 dark:text-stone-400'>
                  Saved in the desktop app only. The key is not stored in browser localStorage.
                </p>
              </div>
            </div>
          </section>
        )}

        {import.meta.env.VITE_ENVIRONMENT === 'electron' && (
          <section className='rounded-2xl border border-neutral-200 mica p-6 shadow-lg shadow-neutral-200/30 dark:border-neutral-800 dark:shadow-black/20'>
            <div className='flex flex-col gap-1'>
              <h2 className='text-xl font-semibold text-stone-900 dark:text-stone-100 mb-2'>
                Local Ownership Migration
              </h2>
              <p className='text-sm text-stone-500 dark:text-stone-200'>
                Manually move local project/conversation ownership from one user ID to another.
              </p>
            </div>

            <div className='mt-4 flex flex-col gap-4'>
              <div className='flex flex-col gap-2'>
                <p className='text-base font-medium text-stone-900 dark:text-stone-100'>From User</p>
                <Select
                  value={fromUserId}
                  onChange={setFromUserId}
                  options={localUsers.map(user => ({ value: user.id, label: formatLocalUserOptionLabel(user) }))}
                  placeholder={localUsersLoading ? 'Loading users...' : 'Select source user'}
                  disabled={localUsersLoading || localUsers.length === 0 || migratingOwnership}
                  className='max-w-2xl'
                />
                <p className='text-xs text-stone-500 dark:text-stone-400 break-all'>Source ID: {fromUserId || '—'}</p>
              </div>

              <div className='flex flex-col gap-2'>
                <p className='text-base font-medium text-stone-900 dark:text-stone-100'>To User</p>
                <Select
                  value={toUserId}
                  onChange={setToUserId}
                  options={localUsers.map(user => ({ value: user.id, label: formatLocalUserOptionLabel(user) }))}
                  placeholder={localUsersLoading ? 'Loading users...' : 'Select destination user'}
                  disabled={localUsersLoading || localUsers.length === 0 || migratingOwnership}
                  className='max-w-2xl'
                />
                <p className='text-xs text-stone-500 dark:text-stone-400 break-all'>
                  Destination ID: {toUserId || '—'}
                </p>
              </div>

              <div className='flex flex-wrap items-center gap-3 pt-2 border-t border-stone-200 dark:border-stone-700'>
                <Button
                  variant='outline2'
                  size='small'
                  onClick={fetchLocalUsers}
                  disabled={localUsersLoading || migratingOwnership}
                >
                  {localUsersLoading ? 'Refreshing users...' : 'Refresh user list'}
                </Button>

                <Button
                  variant='outline2'
                  size='small'
                  onClick={handleManualOwnershipMigration}
                  disabled={
                    localUsersLoading ||
                    migratingOwnership ||
                    localUsers.length < 2 ||
                    !fromUserId ||
                    !toUserId ||
                    fromUserId === toUserId
                  }
                >
                  {migratingOwnership ? 'Migrating...' : 'Migrate local ownership'}
                </Button>
              </div>

              <p className='text-xs text-amber-700 dark:text-amber-300'>
                This only updates local SQLite ownership (projects, conversations, provider costs).
              </p>
            </div>
          </section>
        )}

        {/* Global Agent Settings Section */}
        {import.meta.env.VITE_ENVIRONMENT === 'electron' && (
          <section className='rounded-2xl border border-neutral-200 mica p-6 shadow-lg shadow-neutral-200/30 dark:border-neutral-800 dark:shadow-black/20'>
            <div className='flex flex-col gap-1'>
              <h2 className='text-xl font-semibold text-stone-900 dark:text-stone-100 mb-2'>Global Agent</h2>
              <p className='text-sm text-stone-500 dark:text-stone-200'>
                Configure the background agent loop, model, and heartbeat schedule.
              </p>
            </div>

            <div className='mt-4 flex flex-col gap-5'>
              <div className='flex flex-col gap-2'>
                <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Agent Name</p>
                <input
                  type='text'
                  value={agentSettings.agentName ?? ''}
                  onChange={e => handleAgentNameChange(e.target.value)}
                  disabled={agentSettingsLoading || agentSettingsSaving}
                  className='w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 dark:border-stone-700 dark:bg-zinc-900 dark:text-stone-100'
                />
              </div>

              <div className='flex flex-col gap-2'>
                <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Model (OpenRouter)</p>
                <Select
                  value={agentSettings.model || ''}
                  onChange={handleModelChange}
                  options={(openRouterModelsData?.models || []).map(model => model.name)}
                  placeholder='Select a model...'
                  disabled={agentSettingsLoading || agentSettingsSaving}
                  className='max-w-full'
                />
                <p className='text-xs text-stone-500 dark:text-stone-400'>
                  Non-OpenRouter models can be set later. TODO: add provider-aware context limits.
                </p>
              </div>

              <div className='flex flex-col gap-2'>
                <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Work Directory</p>
                <input
                  type='text'
                  value={workDirectoryInput}
                  placeholder='/path/to/project'
                  onChange={e => handleWorkDirectoryInputChange(e.target.value)}
                  onBlur={e => commitWorkDirectoryChange(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur()
                    }
                  }}
                  disabled={agentSettingsLoading || agentSettingsSaving}
                  className='w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 dark:border-stone-700 dark:bg-zinc-900 dark:text-stone-100'
                />
                <p className='text-xs text-stone-500 dark:text-stone-400'>
                  Used as the working directory root when the global agent runs local tools.
                </p>
              </div>

              <div className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'>
                <div>
                  <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Loop Cadence (ms)</p>
                  <p className='text-sm text-stone-500 dark:text-stone-400'>How often the agent checks its queue.</p>
                </div>
                <input
                  type='number'
                  min={1000}
                  step={1000}
                  value={loopIntervalInput}
                  onChange={e => handleLoopIntervalInputChange(e.target.value)}
                  onBlur={e => commitLoopIntervalChange(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur()
                    }
                  }}
                  disabled={agentSettingsLoading || agentSettingsSaving}
                  className='w-40 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 dark:border-stone-700 dark:bg-zinc-900 dark:text-stone-100'
                />
              </div>

              <div className='flex items-center justify-between'>
                <div>
                  <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Auto Resume</p>
                  <p className='text-sm text-stone-500 dark:text-stone-400'>
                    Resume the global agent after app restart.
                  </p>
                </div>
                <button
                  onClick={handleAutoResumeToggle}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    agentSettings.autoResume ? 'bg-emerald-500 dark:bg-emerald-600' : 'bg-stone-300 dark:bg-stone-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      agentSettings.autoResume ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              <div className='flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
                <div>
                  <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Daily Heartbeat Time</p>
                  <p className='text-sm text-stone-500 dark:text-stone-400'>
                    Uses your local time zone. Leave blank to disable.
                  </p>
                </div>
                <div className='flex items-center gap-2'>
                  <input
                    type='time'
                    value={agentSettings.heartbeatTime ?? ''}
                    onChange={e => handleHeartbeatTimeChange(e.target.value)}
                    disabled={agentSettingsLoading || agentSettingsSaving}
                    className='rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 dark:border-stone-700 dark:bg-zinc-900 dark:text-stone-100'
                  />
                  {agentSettings.heartbeatTime && (
                    <Button
                      variant='outline2'
                      size='small'
                      onClick={() => handleHeartbeatTimeChange('')}
                      disabled={agentSettingsLoading || agentSettingsSaving}
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </div>

              {agentSettingsLoading && (
                <p className='text-xs text-stone-500 dark:text-stone-400'>Loading agent settings…</p>
              )}
            </div>

            <div className='mt-6 border-t border-stone-200 dark:border-stone-700 pt-4'>
              <button
                onClick={() => setAgentToolsExpanded(!agentToolsExpanded)}
                className='w-full flex items-center justify-between text-left'
              >
                <div className='flex flex-col gap-1'>
                  <h3 className='text-lg font-semibold text-stone-900 dark:text-stone-100'>Global Agent Tools</h3>
                  <p className='text-sm text-stone-500 dark:text-stone-200'>
                    Select which tools the global agent can call.
                  </p>
                </div>
                <div className='flex items-center gap-2'>
                  <span className='text-sm text-stone-500 dark:text-stone-400'>
                    {agentSettings.toolAllowlist?.length || 0}/{tools.length} enabled
                  </span>
                  <i
                    className={`bx bx-chevron-down text-2xl text-stone-500 dark:text-stone-400 transition-transform duration-200 ${
                      agentToolsExpanded ? 'rotate-180' : ''
                    }`}
                  ></i>
                </div>
              </button>

              <div
                className={`transition-all duration-300 ease-in-out overflow-hidden ${
                  agentToolsExpanded ? ' opacity-100 my-4' : 'max-h-0 opacity-0'
                }`}
              >
                <div className='space-y-2'>
                  {tools.map(tool => {
                    const enabled = agentSettings.toolAllowlist?.includes(tool.name) ?? false
                    return (
                      <div
                        key={tool.name}
                        className={`flex items-center justify-between p-3 rounded-lg border ${
                          tool.isCustom
                            ? 'border-orange-300 dark:border-orange-600/50 bg-orange-50/50 dark:bg-orange-900/10'
                            : 'border-stone-200 dark:border-stone-700 bg-stone-50/50 dark:bg-stone-800/30'
                        }`}
                      >
                        <div className='flex-1 min-w-0'>
                          <div className='flex items-center gap-2'>
                            <span className='font-medium text-stone-800 dark:text-stone-200 truncate'>
                              {tool.name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                            </span>
                            {tool.isCustom && (
                              <span className='text-xs px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-900/40 text-orange-600 dark:text-orange-300 flex-shrink-0'>
                                Custom
                              </span>
                            )}
                            {tool.isMcp && (
                              <span className='text-xs px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-300 flex-shrink-0'>
                                MCP
                              </span>
                            )}
                          </div>
                          <p className='text-sm text-stone-500 dark:text-stone-400 truncate mt-0.5'>
                            {tool.description}
                          </p>
                        </div>
                        <button
                          onClick={() => handleAgentToolToggle(tool.name)}
                          disabled={agentSettingsSaving || agentSettingsLoading}
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ml-3 flex-shrink-0 ${
                            enabled ? 'bg-emerald-500 dark:bg-emerald-600' : 'bg-stone-300 dark:bg-stone-600'
                          } ${agentSettingsSaving ? 'opacity-50 cursor-wait' : ''}`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                              enabled ? 'translate-x-6' : 'translate-x-1'
                            }`}
                          />
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Tools Settings Section - Collapsible */}
        {import.meta.env.VITE_ENVIRONMENT === 'electron' && (
          <section className='rounded-2xl border border-neutral-200 mica p-6 shadow-lg shadow-neutral-200/30 dark:border-neutral-800 dark:shadow-black/20'>
            <button
              onClick={() => setToolsExpanded(!toolsExpanded)}
              className='w-full flex items-center justify-between text-left'
            >
              <div className='flex flex-col gap-1'>
                <h2 className='text-xl font-semibold text-stone-900 dark:text-stone-100'>Tools Configuration</h2>
                <p className='text-sm text-stone-500 dark:text-stone-200'>
                  Enable or disable AI tools. Changes apply to all new conversations.
                </p>
              </div>
              <div className='flex items-center gap-2'>
                <span className='text-sm text-stone-500 dark:text-stone-400'>
                  {tools.filter(t => t.enabled).length}/{tools.length} enabled
                </span>
                <i
                  className={`bx bx-chevron-down text-2xl text-stone-500 dark:text-stone-400 transition-transform duration-200 ${
                    toolsExpanded ? 'rotate-180' : ''
                  }`}
                ></i>
              </div>
            </button>

            {/* Collapsible content */}
            <div
              className={`transition-all duration-300 ease-in-out overflow-hidden ${
                toolsExpanded ? ' opacity-100 my-4' : 'max-h-0 opacity-0'
              }`}
            >
              <div className='mb-3 space-y-3'>
                <div className='rounded-lg border border-stone-200 bg-stone-50/60 p-3 dark:border-stone-700 dark:bg-stone-800/30'>
                  <div className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'>
                    <div>
                      <p className='text-base font-medium text-stone-900 dark:text-stone-100'>
                        Default Tool Call Timeout (ms)
                      </p>
                      <p className='text-xs text-stone-500 dark:text-stone-400'>
                        Global timeout used for all tool calls unless a tool explicitly sets `timeoutMs`.
                      </p>
                    </div>
                    <input
                      type='number'
                      min={MIN_TOOL_CALL_TIMEOUT_MS}
                      max={MAX_TOOL_CALL_TIMEOUT_MS}
                      step={1000}
                      value={toolCallTimeoutInput}
                      onChange={e => handleToolCallTimeoutInputChange(e.target.value)}
                      onBlur={e => commitToolCallTimeoutChange(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.currentTarget.blur()
                        }
                      }}
                      className='w-44 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 dark:border-stone-700 dark:bg-zinc-900 dark:text-stone-100'
                    />
                  </div>
                  <p className='mt-2 text-xs text-stone-500 dark:text-stone-400'>
                    Range: {MIN_TOOL_CALL_TIMEOUT_MS}ms to {MAX_TOOL_CALL_TIMEOUT_MS}ms.
                  </p>
                </div>

                <div className='rounded-lg border border-stone-200 bg-stone-50/60 p-3 dark:border-stone-700 dark:bg-stone-800/30'>
                  <div className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'>
                    <div>
                      <p className='text-base font-medium text-stone-900 dark:text-stone-100'>
                        Default Bash Process Timeout (ms)
                      </p>
                      <p className='text-xs text-stone-500 dark:text-stone-400'>
                        Used by `bash` when that tool call omits `timeoutMs`.
                      </p>
                    </div>
                    <input
                      type='number'
                      min={MIN_BASH_TIMEOUT_MS}
                      max={MAX_BASH_TIMEOUT_MS}
                      step={1000}
                      value={bashTimeoutInput}
                      onChange={e => handleBashTimeoutInputChange(e.target.value)}
                      onBlur={e => commitBashTimeoutChange(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.currentTarget.blur()
                        }
                      }}
                      className='w-44 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 dark:border-stone-700 dark:bg-zinc-900 dark:text-stone-100'
                    />
                  </div>
                  <p className='mt-2 text-xs text-stone-500 dark:text-stone-400'>
                    Range: {MIN_BASH_TIMEOUT_MS}ms to {MAX_BASH_TIMEOUT_MS}ms.
                  </p>
                </div>
              </div>

              {/* Reload button */}
              <div className='flex justify-end mb-3'>
                <Button
                  variant='outline2'
                  size='small'
                  onClick={handleReloadTools}
                  disabled={reloadingTools}
                  className='flex items-center gap-1.5'
                >
                  <i className={`bx bx-refresh text-base ${reloadingTools ? 'animate-spin' : ''}`}></i>
                  {reloadingTools ? 'Reloading...' : 'Reload Tools'}
                </Button>
              </div>

              {/* Tools list */}
              <div className='space-y-2'>
                {tools.length === 0 ? (
                  <div className='rounded-xl border-2 border-dashed border-stone-200 bg-stone-50/80 p-6 text-center text-sm text-stone-500 dark:border-stone-700 dark:bg-zinc-900/60 dark:text-stone-400'>
                    No tools available. Reload to check for new tools.
                  </div>
                ) : (
                  tools.map(tool => (
                    <div
                      key={tool.name}
                      className={`flex items-center justify-between p-3 rounded-lg border ${
                        tool.isCustom
                          ? 'border-orange-300 dark:border-orange-600/50 bg-orange-50/50 dark:bg-orange-900/10'
                          : 'border-stone-200 dark:border-stone-700 bg-stone-50/50 dark:bg-stone-800/30'
                      }`}
                    >
                      <div className='flex-1 min-w-0'>
                        <div className='flex items-center gap-2'>
                          <span className='font-medium text-stone-800 dark:text-stone-200 truncate'>
                            {tool.name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                          </span>
                          {tool.isCustom && (
                            <span className='text-xs px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-900/40 text-orange-600 dark:text-orange-300 flex-shrink-0'>
                              Custom
                            </span>
                          )}
                        </div>
                        <p className='text-sm text-stone-500 dark:text-stone-400 truncate mt-0.5'>{tool.description}</p>
                      </div>
                      <button
                        onClick={() => handleToolToggle(tool.name, tool.enabled)}
                        disabled={updatingTools.has(tool.name)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ml-3 flex-shrink-0 ${
                          tool.enabled ? 'bg-emerald-500 dark:bg-emerald-600' : 'bg-stone-300 dark:bg-stone-600'
                        } ${updatingTools.has(tool.name) ? 'opacity-50 cursor-wait' : ''}`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            tool.enabled ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>
        )}

        {/* HTML Tools Management Section - Collapsible */}
        {htmlRegistry && (
          <section className='rounded-2xl border border-neutral-200 mica p-6 shadow-lg shadow-neutral-200/30 dark:border-neutral-800 dark:shadow-black/20'>
            <button
              onClick={() => setHtmlToolsExpanded(!htmlToolsExpanded)}
              className='w-full flex items-center justify-between text-left'
            >
              <div className='flex flex-col gap-1'>
                <h2 className='text-xl font-semibold text-stone-900 dark:text-stone-100'>HTML Tools Cache</h2>
                <p className='text-sm text-stone-500 dark:text-stone-200'>
                  Manage cached HTML tool outputs. Remove problematic tools without rendering them.
                </p>
              </div>
              <div className='flex items-center gap-2'>
                <span className='text-sm text-stone-500 dark:text-stone-400'>{htmlEntries.length} cached</span>
                <i
                  className={`bx bx-chevron-down text-2xl text-stone-500 dark:text-stone-400 transition-transform duration-200 ${
                    htmlToolsExpanded ? 'rotate-180' : ''
                  }`}
                ></i>
              </div>
            </button>

            {/* Collapsible content */}
            <div
              className={`transition-all duration-300 ease-in-out overflow-hidden ${
                htmlToolsExpanded ? 'max-h-[2000px] opacity-100 mt-4' : 'max-h-0 opacity-0'
              }`}
            >
              {/* Tools list */}
              <div className='space-y-2'>
                {htmlEntries.length === 0 ? (
                  <div className='rounded-xl border-2 border-dashed border-stone-200 bg-stone-50/80 p-6 text-center text-sm text-stone-500 dark:border-stone-700 dark:bg-zinc-900/60 dark:text-stone-400'>
                    No HTML tools cached. Tools will appear here when AI generates interactive outputs.
                  </div>
                ) : (
                  htmlEntries.map(entry => {
                    const isHibernated = entry.status === 'hibernated'
                    const isFavorite = entry.favorite
                    const sizeKb = Math.round(entry.sizeBytes / 1024)
                    const truncatedKey =
                      entry.key.length > 20 ? `${entry.key.slice(0, 10)}...${entry.key.slice(-6)}` : entry.key

                    return (
                      <div
                        key={entry.key}
                        className={`flex items-center justify-between p-3 rounded-lg border ${
                          isHibernated
                            ? 'border-stone-300 dark:border-stone-600 bg-stone-100/50 dark:bg-stone-800/50 opacity-60'
                            : isFavorite
                              ? 'border-amber-300 dark:border-amber-600/50 bg-amber-50/50 dark:bg-amber-900/10'
                              : 'border-stone-200 dark:border-stone-700 bg-stone-50/50 dark:bg-stone-800/30'
                        }`}
                      >
                        <div className='flex-1 min-w-0'>
                          <div className='flex items-center gap-2'>
                            <span className='font-medium text-stone-800 dark:text-stone-200 truncate'>
                              {entry.label || 'Unnamed Tool'}
                            </span>
                            {isFavorite && (
                              <span className='text-xs px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-300 flex-shrink-0'>
                                ★ Favorite
                              </span>
                            )}
                            {isHibernated && (
                              <span className='text-xs px-1.5 py-0.5 rounded bg-stone-200 dark:bg-stone-700 text-stone-600 dark:text-stone-400 flex-shrink-0'>
                                Hibernated
                              </span>
                            )}
                          </div>
                          <p className='text-xs text-stone-500 dark:text-stone-400 mt-0.5'>
                            Key: {truncatedKey} · {sizeKb} KB · Updated {new Date(entry.updatedAt).toLocaleDateString()}
                          </p>
                        </div>
                        <div className='flex items-center gap-1.5 ml-3 flex-shrink-0'>
                          {/* Favorite toggle */}
                          <button
                            onClick={() => {
                              htmlRegistry.toggleFavorite(entry.key)
                              showStatus({
                                type: 'success',
                                text: entry.favorite ? 'Removed from favorites.' : 'Added to favorites.',
                              })
                            }}
                            className={`p-2 rounded-lg transition-colors ${
                              isFavorite
                                ? 'bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-400'
                                : 'bg-stone-100 text-stone-500 hover:bg-stone-200 dark:bg-stone-700 dark:text-stone-400 dark:hover:bg-stone-600'
                            }`}
                            title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                          >
                            <i className={`bx ${isFavorite ? 'bxs-star' : 'bx-star'} text-base`}></i>
                          </button>
                          {/* Hibernate/Restore toggle */}
                          <button
                            onClick={() => {
                              if (isHibernated) {
                                htmlRegistry.restoreEntry(entry.key)
                                showStatus({ type: 'success', text: 'Tool restored.' })
                              } else {
                                htmlRegistry.hibernateEntry(entry.key)
                                showStatus({ type: 'info', text: 'Tool hibernated.' })
                              }
                            }}
                            className='p-2 rounded-lg bg-stone-100 text-stone-500 hover:bg-stone-200 dark:bg-stone-700 dark:text-stone-400 dark:hover:bg-stone-600 transition-colors'
                            title={isHibernated ? 'Restore tool' : 'Hibernate tool'}
                          >
                            <i className={`bx ${isHibernated ? 'bx-sun' : 'bx-moon'} text-base`}></i>
                          </button>
                          {/* Remove button */}
                          <button
                            onClick={() => {
                              htmlRegistry.removeEntry(entry.key)
                              showStatus({ type: 'info', text: 'Tool removed from cache.' })
                            }}
                            className='p-2 rounded-lg bg-rose-50 text-rose-500 hover:bg-rose-100 dark:bg-rose-900/30 dark:text-rose-400 dark:hover:bg-rose-900/50 transition-colors'
                            title='Remove tool'
                          >
                            <i className='bx bx-trash text-base'></i>
                          </button>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>

              {/* Clear all button */}
              {htmlEntries.length > 0 && (
                <div className='mt-4 pt-3 flex justify-end'>
                  <Button
                    variant='outline2'
                    size='small'
                    onClick={() => {
                      htmlEntries.forEach(entry => htmlRegistry.removeEntry(entry.key))
                      showStatus({ type: 'success', text: 'All HTML tools cleared.' })
                    }}
                    className='text-rose-600 hover:text-rose-700 dark:text-rose-400'
                  >
                    Clear All Tools
                  </Button>
                </div>
              )}
            </div>
          </section>
        )}

        {false && (
          <section className='rounded-2xl border border-neutral-200 mica p-6 shadow-lg shadow-neutral-200/30 dark:border-neutral-800 dark:shadow-black/20'>
            <div className='flex flex-col gap-1'>
              <h2 className='text-xl font-semibold text-stone-900 dark:text-stone-100 mb-2'>Services</h2>
              <p className='text-sm text-stone-500 dark:text-stone-200'>
                Connect third-party services so tools can access them through the proxy.
              </p>
            </div>
            <div className='mt-4 flex flex-col gap-4 md:flex-row md:items-center md:justify-between'>
              <div className='flex items-center gap-3'>
                <div>
                  <div className='flex items-center gap-2'>
                    <p className='text-base font-semibold text-stone-900 dark:text-stone-100'>Google Drive</p>
                    {googleDriveStatus?.connected && (
                      <span className='rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300'>
                        Connected
                      </span>
                    )}
                  </div>
                  <p className='text-sm text-stone-500 dark:text-stone-400'>
                    {googleDriveStatus?.connected
                      ? `Connected ${googleDriveStatus.connectedAt ? new Date(googleDriveStatus.connectedAt).toLocaleDateString() : ''}`
                      : 'Sign in once to enable Drive-powered tools.'}
                  </p>
                </div>
              </div>
              <div className='flex gap-2'>
                {googleDriveStatus?.connected ? (
                  <>
                    <Button
                      variant='outline2'
                      size='large'
                      onClick={handleGoogleDriveConnect}
                      disabled={googleConnecting}
                      className='group'
                    >
                      <p className='transition-transform duration-100 group-active:scale-95'>
                        {googleConnecting ? 'Opening…' : 'Reconnect'}
                      </p>
                    </Button>
                    <Button
                      variant='outline2'
                      size='large'
                      onClick={handleGoogleDriveDisconnect}
                      disabled={googleDisconnecting}
                      className='group text-rose-600 hover:text-rose-700 dark:text-rose-400'
                    >
                      <p className='transition-transform duration-100 group-active:scale-95'>
                        {googleDisconnecting ? 'Disconnecting…' : 'Disconnect'}
                      </p>
                    </Button>
                  </>
                ) : (
                  <Button
                    variant='outline2'
                    size='large'
                    onClick={handleGoogleDriveConnect}
                    disabled={googleConnecting}
                    className='group'
                  >
                    <p className='transition-transform duration-100 group-active:scale-95'>
                      {googleConnecting ? 'Opening…' : 'Connect Google Drive'}
                    </p>
                  </Button>
                )}
              </div>
            </div>
          </section>
        )}

        <section className='rounded-2xl border border-neutral-200 mica p-6 shadow-lg shadow-neutral-200/30 dark:border-neutral-800 dark:shadow-black/20'>
          <div className='flex flex-col gap-1'>
            <h2 className='text-xl font-semibold text-stone-900 dark:text-stone-100 mb-2'>Custom Upload</h2>
            <p className='text-sm text-stone-500 dark:text-stone-200'>
              Drag in an MP4 or WebM and we’ll keep it ready for whenever you want that motion.
            </p>
            <p className='mt-1 text-sm video-light:text-neutral-100 video-dark:text-neutral-900'>
              Upload up to 8MB MP4/WebM clips and switch between them in one place.
            </p>
          </div>

          <div className='mt-2 flex flex-col gap-4 lg:flex-row lg:items-center'>
            <div className='flex-1 space-y-1 py-2'>
              <p className='text-sm mb-4 text-stone-500 dark:text-stone-200'>
                Accepted formats: MP4, WebM · Max size 8MB.
              </p>
              <div className='rounded-xl border border-dashed border-stone-200 bg-stone-50/80 p-4 text-sm text-stone-500 dark:border-stone-700 dark:bg-zinc-800/60 dark:text-stone-200'>
                <p>Uploaded wallpapers appear below. You can switch between them at any time.</p>
              </div>
            </div>

            <div className='flex gap-3 lg:pt-8'>
              <input
                ref={fileInputRef}
                type='file'
                accept='video/mp4,video/webm'
                className='hidden'
                onChange={handleFileChange}
              />
              <Button
                variant='outline2'
                size='large'
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className='group shadow-md'
              >
                <p className='transition-transform duration-100 group-active:scale-95'>
                  {uploading ? 'Processing…' : 'Browse for video'}
                </p>
              </Button>
            </div>
          </div>
        </section>

        <section
          className={`rounded-2xl border border-neutral-200 p-6 shadow-lg shadow-neutral-200/30 dark:border-neutral-800 dark:shadow-black/20 ${customThemeEnabled ? '' : 'mica dark:bg-zinc-900/60'}`}
          style={{ backgroundColor: customThemeEnabled ? settingsSolidColorSectionBackground : undefined }}
        >
          <div className='flex flex-col gap-1'>
            <div className='flex flex-wrap items-center justify-between gap-3'>
              <div>
                <h2 className='text-xl font-semibold text-stone-900 dark:text-stone-100'>Solid Color Background</h2>
                <p className='text-sm text-stone-500 dark:text-stone-400'>Pick colors for light and dark themes.</p>
              </div>
              <div className='flex flex-wrap gap-2'>
                <Button
                  variant={backgroundMode === 'video' ? 'primary' : 'outline2'}
                  size='small'
                  onClick={() => handleBackgroundModeChange('video')}
                  className='group'
                >
                  <p className='transition-transform duration-100 group-active:scale-95'>Video wallpaper</p>
                </Button>
                <Button
                  variant={backgroundMode === 'color' ? 'primary' : 'outline2'}
                  size='small'
                  onClick={() => handleBackgroundModeChange('color')}
                  className='group'
                >
                  <p className='transition-transform duration-100 group-active:scale-95'>Solid colors</p>
                </Button>
              </div>
            </div>
          </div>
          <div className='mt-5 grid gap-4 md:grid-cols-2'>
            {(['light', 'dark'] as const).map(mode => {
              const label = mode === 'light' ? 'Light mode color' : 'Dark mode color'
              const description =
                mode === 'light'
                  ? 'Used when the interface is in light theme.'
                  : 'Used when the interface is in dark theme.'
              const colorValue = effectiveBackgroundColors[mode]
              const isTransparentColor = colorValue.trim().toLowerCase() === 'transparent'
              const colorPickerValue = isTransparentColor ? DEFAULT_BACKGROUND_COLORS[mode] : colorValue
              return (
                <div
                  key={mode}
                  className='rounded-xl border border-stone-200 bg-stone-50/70 p-4 transition dark:border-stone-700 dark:bg-zinc-900/70'
                >
                  <div className='flex items-start justify-between gap-3'>
                    <div>
                      <p className='text-base font-semibold text-stone-900 dark:text-stone-100'>{label}</p>
                      <p className='text-xs text-stone-500 dark:text-stone-400'>{description}</p>
                    </div>
                    <span
                      className='h-10 w-10 rounded-full border border-stone-200 dark:border-stone-600'
                      style={{
                        backgroundColor: colorValue,
                        backgroundImage: isTransparentColor
                          ? 'linear-gradient(45deg, rgba(120,120,120,0.18) 25%, transparent 25%, transparent 75%, rgba(120,120,120,0.18) 75%, rgba(120,120,120,0.18)), linear-gradient(45deg, rgba(120,120,120,0.18) 25%, transparent 25%, transparent 75%, rgba(120,120,120,0.18) 75%, rgba(120,120,120,0.18))'
                          : 'none',
                        backgroundPosition: isTransparentColor ? '0 0, 6px 6px' : undefined,
                        backgroundSize: isTransparentColor ? '12px 12px' : undefined,
                      }}
                      aria-hidden='true'
                    ></span>
                  </div>
                  <div className='mt-4 flex flex-wrap items-center gap-3'>
                    <input
                      type='color'
                      value={colorPickerValue}
                      onChange={event => handleBackgroundColorChange(mode, event.target.value)}
                      aria-label={`${label} picker`}
                      className='h-10 w-10 rounded-full border border-stone-200 bg-white p-0 dark:border-stone-600'
                    />
                    <Button
                      variant={isTransparentColor ? 'primary' : 'outline2'}
                      size='small'
                      onClick={() => handleBackgroundColorChange(mode, 'transparent')}
                      className='group'
                    >
                      <p className='transition-transform duration-100 group-active:scale-95'>Transparent</p>
                    </Button>
                    <p className='text-xs font-mono text-stone-500 dark:text-stone-300'>{colorValue}</p>
                  </div>
                </div>
              )
            })}
          </div>
          <p className='mt-4 text-xs text-stone-500 dark:text-stone-400'>
            Solid colors automatically switch with the theme, and you can set either theme to transparent. When you’re
            ready for motion, switch back to video wallpapers.
          </p>
        </section>

        <section className='rounded-2xl border border-neutral-200 mica p-6 shadow-lg shadow-neutral-200/30 dark:border-neutral-800 dark:bg-zinc-900 dark:shadow-black/20'>
          <div className='flex flex-col gap-1'>
            <div className='flex flex-wrap items-center justify-between gap-3'>
              <div>
                <h2 className='text-xl font-semibold text-stone-900 dark:text-stone-100'>Saved Wallpapers</h2>
                <p className='text-sm text-stone-500 dark:text-stone-400'>Select or delete any saved clip.</p>
              </div>
              <div className='flex flex-wrap gap-2'>
                <Button variant='outline2' size='small' onClick={handleResetToDefault} className='group'>
                  <p className='transition-transform duration-100 group-active:scale-95'>Reset to Default</p>
                </Button>
                <Button variant='outline2' size='small' onClick={handleClearGallery} className='group'>
                  <p className='transition-transform duration-100 group-active:scale-95'>Clear Gallery</p>
                </Button>
              </div>
            </div>
          </div>

          <div className='mt-5 grid gap-4 md:grid-cols-2'>
            {videos.length === 0 ? (
              <div className='col-span-full rounded-xl border-2 border-dashed border-stone-200 bg-stone-50/80 p-6 text-center text-sm text-stone-500 dark:border-stone-700 dark:bg-zinc-900/60 dark:text-stone-400'>
                No saved wallpapers yet. Upload a video to get started.
              </div>
            ) : (
              videos.map(video => {
                const isActive = video.id === activeVideoId
                return (
                  <div
                    key={video.id}
                    className={`flex flex-col gap-3 rounded-xl border p-4 transition ${
                      isActive
                        ? 'border-emerald-300 bg-emerald-50/40 dark:border-emerald-500/60 dark:bg-emerald-900/40'
                        : 'border-stone-200 bg-stone-50/70 hover:border-indigo-400 dark:hover:bg-neutral-700/40 dark:border-stone-700 dark:bg-zinc-900/70 dark:hover:border-sky-600'
                    }`}
                  >
                    <div className='flex items-start justify-between gap-3'>
                      <div>
                        <p className='text-base font-semibold text-stone-900 dark:text-stone-100'>
                          {video.name || 'Uploaded wallpaper'}
                        </p>
                        <p className='text-xs text-stone-500 dark:text-stone-400'>
                          {video.mimeType} · {formatSize(video.size)}
                        </p>
                        <p className='text-xs text-stone-400 dark:text-stone-500'>
                          Added {new Date(video.createdAt).toLocaleString()}
                        </p>
                      </div>
                      {isActive && (
                        <span className='rounded-full border border-emerald-300 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:border-emerald-500/60 dark:text-emerald-200'>
                          Active
                        </span>
                      )}
                    </div>
                    <div className='flex flex-wrap items-center gap-2'>
                      <Button
                        variant={isActive ? 'primary' : 'outline2'}
                        size='small'
                        onClick={() => handleSelectVideo(video.id)}
                        className='group'
                      >
                        <p className='transition-transform duration-100 group-active:scale-95'>
                          {isActive ? 'Selected' : 'Use this wallpaper'}
                        </p>
                      </Button>
                      <Button
                        variant='outline2'
                        size='small'
                        onClick={() => handleRemoveVideo(video.id)}
                        className='group'
                      >
                        <p className='transition-transform duration-100 group-active:scale-95'>Remove</p>
                      </Button>
                      <div className='ml-auto flex items-center gap-1'>
                        <span className='text-xs text-stone-500 dark:text-stone-400 mr-1'>Text:</span>
                        {(['auto', 'light', 'dark'] as const).map(mode => {
                          const currentMode = video.textColorMode ?? 'auto'
                          const isSelected = currentMode === mode
                          return (
                            <button
                              key={mode}
                              onClick={() => handleTextColorModeChange(video.id, mode)}
                              className={`px-2 py-1 text-xs rounded-md transition-colors ${
                                isSelected
                                  ? 'bg-indigo-500 text-white dark:bg-indigo-600'
                                  : 'bg-stone-200 text-stone-600 hover:bg-stone-300 dark:bg-zinc-700 dark:text-stone-300 dark:hover:bg-zinc-600'
                              }`}
                              title={
                                mode === 'auto'
                                  ? 'Follow system theme'
                                  : mode === 'light'
                                    ? 'Light text (for dark videos)'
                                    : 'Dark text (for light videos)'
                              }
                            >
                              {mode === 'auto' ? 'Auto' : mode === 'light' ? 'Light' : 'Dark'}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

export default Settings
