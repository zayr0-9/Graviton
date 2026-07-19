import React, { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronDown, LogOut, Moon, RefreshCw, Star, Sun, Trash2, X } from 'lucide-react'
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
import {
  clearTokens as clearOpenAITokens,
  getOpenAIAccountEmail,
  isOpenAIAuthenticated,
  saveTokens,
} from '../features/chats/openaiOAuth'
import {
  clearOpenAIChatGPTTokensFromHeadless,
  persistOpenAIChatGPTTokensToHeadless,
} from '../features/chats/openaiHeadlessAuth'
import { getAllTools } from '../features/chats/toolDefinitions'
import {
  CHAT_REASONING_SETTINGS_CHANGE_EVENT,
  ChatReasoningSettings,
  loadChatReasoningSettings,
  REASONING_EFFORT_OPTIONS,
  saveChatReasoningSettings,
} from '../helpers/chatReasoningSettingsStorage'
import {
  loadAutoCompactionEnabled,
  loadShowAddedFilesPills,
  loadShowTokenUsageBar,
  loadShowTokenUsageHoverDetails,
  saveAutoCompactionEnabled,
  saveShowAddedFilesPills,
  saveShowTokenUsageBar,
  saveShowTokenUsageHoverDetails,
} from '../helpers/chatUiSettingsStorage'
import {
  BROWSER_SETTINGS_CHANGE_EVENT,
  BROWSER_SETTINGS_STORAGE_KEY,
  BrowserSettings,
  hydrateBrowserSettings,
  loadBrowserSettings,
  saveBrowserSettings,
} from '../helpers/browserSettingsStorage'
import {
  AppFontSettings,
  applyAppFontSettings,
  clearStoredLocalFont,
  DEFAULT_GOOGLE_FONT_FAMILY,
  DEFAULT_GOOGLE_FONT_URL,
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
  addChatModePrompt,
  DEFAULT_CHAT_MODE_PROMPT_ID,
  deleteChatModePrompt,
  getDefaultAgentModePrompt,
  getDefaultChatModePrompt,
  getDefaultSubagentModePrompt,
  loadOperationModePromptSettings,
  OPERATION_MODE_PROMPT_SETTINGS_CHANGE_EVENT,
  OperationModePromptSettings,
  resetAgentModePromptOverride,
  resetChatModePromptSelectionToDefault,
  resetSubagentModePromptOverride,
  saveAgentModePromptOverride,
  saveSubagentModePromptOverride,
  selectChatModePrompt,
  updateChatModePrompt,
} from '../helpers/operationModePromptStorage'
import {
  loadPlanModeResponseSettings,
  PLAN_MODE_RESPONSE_SETTINGS_CHANGE_EVENT,
  PlanModeResponseSettings,
  PLAN_MODE_VERBOSITY_OPTIONS,
  savePlanModeResponseSettings,
} from '../helpers/planModeResponseSettingsStorage'
import {
  DEFAULT_LMSTUDIO_BASE_URL,
  loadProviderSettings,
  MAX_OPENROUTER_TEMPERATURE,
  MIN_OPENROUTER_TEMPERATURE,
  normalizeLmStudioBaseUrl,
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
import { normalizeSubagentModelName } from '../helpers/subagentModelNames'
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

const circularControlClass =
  'group/control inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/75 text-stone-700 backdrop-blur-xl transition-all duration-200 hover:-translate-y-0.5 hover:scale-105 hover:bg-white hover:text-stone-950 active:translate-y-0 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 dark:bg-yBlack-900/75 dark:text-stone-200 dark:hover:bg-neutral-900 dark:hover:text-white dark:focus-visible:ring-orange-400/70'
const circularDangerControlClass =
  'group/control inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-rose-50/85 text-rose-500 backdrop-blur-xl transition-all duration-200 hover:-translate-y-0.5 hover:scale-105 hover:bg-rose-100 hover:text-rose-600 active:translate-y-0 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/70 dark:bg-rose-900/30 dark:text-rose-300 dark:hover:bg-rose-900/50 dark:hover:text-rose-100'
const settingsSectionClass = 'rounded-[2.5rem] bg-white/55 p-6 backdrop-blur-2xl dark:bg-black/20 sm:p-7'
const settingsInputClass =
  'rounded-full border-transparent bg-white/70 px-4 py-3 text-sm text-stone-900 outline-none backdrop-blur-xl transition focus:bg-white/85 focus:ring-2 focus:ring-emerald-400/40 dark:bg-yBlack-900/70 dark:text-stone-100 dark:focus:bg-yBlack-900/85'
const settingsTextAreaClass =
  'rounded-[1.75rem] border-transparent bg-white/70 px-4 py-3 text-sm text-stone-900 outline-none backdrop-blur-xl transition focus:bg-white/85 focus:ring-2 focus:ring-emerald-400/40 dark:bg-yBlack-900/70 dark:text-stone-100 dark:focus:bg-yBlack-900/85'
const settingsToggleClass = (enabled: boolean) =>
  `relative inline-flex h-8 w-14 shrink-0 items-center rounded-full p-1 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 active:scale-95 ${
    enabled ? 'bg-emerald-500/90 dark:bg-emerald-500/80' : 'bg-stone-300/80 dark:bg-stone-700/80'
  }`
const settingsToggleKnobClass = (enabled: boolean) =>
  `inline-block h-6 w-6 transform rounded-full bg-white transition-transform duration-200 ${enabled ? 'translate-x-6' : 'translate-x-0'}`
const SETTINGS_SECTION_PREVIEW_LIMIT = 4

type SettingsSectionProps = {
  title: string
  description: React.ReactNode
  features: string[]
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
}

const SettingsSection: React.FC<SettingsSectionProps> = ({ title, description, features, children, className = '', style }) => {
  const [expanded, setExpanded] = useState(false)
  const previewFeatures = features.slice(0, SETTINGS_SECTION_PREVIEW_LIMIT)
  const hiddenFeatureCount = Math.max(features.length - previewFeatures.length, 0)

  return (
    <section className={`${settingsSectionClass} ${className}`.trim()} style={style}>
      <button
        type='button'
        onClick={() => setExpanded(value => !value)}
        className='group flex w-full items-start justify-between gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 rounded-[2rem]'
        aria-expanded={expanded}
      >
        <span className='min-w-0 flex-1'>
          <span className='block text-xl font-semibold text-stone-900 dark:text-stone-100'>{title}</span>
          <span className='mt-1 block text-sm text-stone-500 dark:text-stone-200'>{description}</span>
          <span className='mt-4 flex flex-wrap gap-2'>
            {previewFeatures.map(feature => (
              <span
                key={feature}
                className='rounded-full bg-white/55 px-3 py-1.5 text-xs font-medium text-stone-600 backdrop-blur-xl dark:bg-white/10 dark:text-stone-300'
              >
                {feature}
              </span>
            ))}
            {hiddenFeatureCount > 0 && (
              <span className='rounded-full bg-white/35 px-3 py-1.5 text-xs font-medium text-stone-500 backdrop-blur-xl dark:bg-white/5 dark:text-stone-400'>
                +{hiddenFeatureCount} more
              </span>
            )}
          </span>
        </span>
        <span className={circularControlClass} aria-hidden='true'>
          <ChevronDown
            size={20}
            strokeWidth={2.25}
            className={`transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          />
        </span>
      </button>
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-300 ease-in-out ${
          expanded ? 'mt-5 grid-rows-[1fr] opacity-100' : 'mt-0 grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className='overflow-hidden'>{children}</div>
      </div>
    </section>
  )
}

type StatusMessage = {
  type: 'success' | 'error' | 'info'
  text: string
}

const formatSize = (size?: number | null) => {
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

const formatMemoryUpdatedAt = (value?: string | null) => {
  if (!value) return 'Not created yet'
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) return 'Updated recently'
  return timestamp.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
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

type MemoryFileKind = 'global' | 'recent' | 'project'

interface MemoryFileSummary {
  id: string
  kind: MemoryFileKind
  label: string
  description?: string
  projectName?: string | null
  exists: boolean
  path?: string | null
  sizeBytes?: number | null
  updatedAt?: string | null
}

interface MemoryFilesResponse {
  success: boolean
  files: MemoryFileSummary[]
  directory?: string
  error?: string
}

interface MemoryFileContentResponse {
  success: boolean
  file?: MemoryFileSummary | null
  content: string
  error?: string
}

const Settings: React.FC = () => {
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const { accessToken, userId, signOut } = useAuth()
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
  const [zaiApiKeyInput, setZaiApiKeyInput] = useState('')
  const [zaiApiKeyConfigured, setZaiApiKeyConfigured] = useState(false)
  const [zaiApiKeyLoading, setZaiApiKeyLoading] = useState(import.meta.env.VITE_ENVIRONMENT === 'electron')
  const [zaiApiKeySaving, setZaiApiKeySaving] = useState(false)
  const [bedrockRegionInput, setBedrockRegionInput] = useState('us-east-1')
  const [bedrockAccessKeyIdInput, setBedrockAccessKeyIdInput] = useState('')
  const [bedrockSecretAccessKeyInput, setBedrockSecretAccessKeyInput] = useState('')
  const [bedrockSessionTokenInput, setBedrockSessionTokenInput] = useState('')
  const [bedrockCredentialsConfigured, setBedrockCredentialsConfigured] = useState(false)
  const [bedrockCredentialsLoading, setBedrockCredentialsLoading] = useState(import.meta.env.VITE_ENVIRONMENT === 'electron')
  const [bedrockCredentialsSaving, setBedrockCredentialsSaving] = useState(false)
  const [openRouterTemperatureInput, setOpenRouterTemperatureInput] = useState<string>(() => {
    const configured = loadProviderSettings().openRouterTemperature
    return typeof configured === 'number' ? String(configured) : ''
  })
  const [openRouterTemperatureTouched, setOpenRouterTemperatureTouched] = useState(false)
  const [lmStudioBaseUrlInput, setLmStudioBaseUrlInput] = useState<string>(() => loadProviderSettings().lmStudioBaseUrl ?? '')
  const [lmStudioBaseUrlTouched, setLmStudioBaseUrlTouched] = useState(false)
  const [memoryBackfillRunning, setMemoryBackfillRunning] = useState(false)
  const [memoryFiles, setMemoryFiles] = useState<MemoryFileSummary[]>([])
  const [memoryFilesLoading, setMemoryFilesLoading] = useState(false)
  const [memoryFilesError, setMemoryFilesError] = useState<string | null>(null)
  const [selectedMemoryFile, setSelectedMemoryFile] = useState<MemoryFileSummary | null>(null)
  const [memoryModalOpen, setMemoryModalOpen] = useState(false)
  const [memoryContent, setMemoryContent] = useState('')
  const [memoryContentLoading, setMemoryContentLoading] = useState(false)
  const [memoryContentError, setMemoryContentError] = useState<string | null>(null)
  const [compactionSystemPromptInput, setCompactionSystemPromptInput] = useState<string>(
    () => loadProviderSettings().compactionSystemPrompt
  )
  const [compactionSystemPromptTouched, setCompactionSystemPromptTouched] = useState(false)
  const [openaiLoginModalOpen, setOpenaiLoginModalOpen] = useState(false)
  const [openaiAccountEmail, setOpenaiAccountEmail] = useState<string | null>(() => getOpenAIAccountEmail())
  const [openaiAuthFlow, setOpenaiAuthFlow] = useState<{ url: string; verifier: string; state: string } | null>(null)
  const [openaiAuthError, setOpenaiAuthError] = useState<string | null>(null)
  const [openaiAuthLoading, setOpenaiAuthLoading] = useState(false)
  const [openaiAuthPolling, setOpenaiAuthPolling] = useState(false)
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
  const [operationModePromptSettings, setOperationModePromptSettings] = useState<OperationModePromptSettings>(() =>
    loadOperationModePromptSettings()
  )
  const [planModeResponseSettings, setPlanModeResponseSettings] = useState<PlanModeResponseSettings>(() =>
    loadPlanModeResponseSettings()
  )
  const [chatModePromptNameInput, setChatModePromptNameInput] = useState('')
  const [chatModePromptInput, setChatModePromptInput] = useState('')
  const [agentModePromptInput, setAgentModePromptInput] = useState(() =>
    loadOperationModePromptSettings().agentModePromptOverride || getDefaultAgentModePrompt().prompt
  )
  const [subagentModePromptInput, setSubagentModePromptInput] = useState(() =>
    loadOperationModePromptSettings().subagentModePromptOverride || getDefaultSubagentModePrompt().prompt
  )
  const [showTokenUsageBar, setShowTokenUsageBar] = useState<boolean>(() => loadShowTokenUsageBar())
  const [showTokenUsageHoverDetails, setShowTokenUsageHoverDetails] = useState<boolean>(() =>
    loadShowTokenUsageHoverDetails()
  )
  const [autoCompactionEnabled, setAutoCompactionEnabled] = useState<boolean>(() => loadAutoCompactionEnabled())
  const [showAddedFilesPills, setShowAddedFilesPills] = useState<boolean>(() => loadShowAddedFilesPills())
  const [browserSettings, setBrowserSettings] = useState<BrowserSettings>(() => loadBrowserSettings())
  const [subagentSettings, setSubagentSettings] = useState<SubagentToolSettings>(() => loadSubagentToolSettings())
  const [subagentMaxTurnsInput, setSubagentMaxTurnsInput] = useState<string>(() =>
    String(loadSubagentToolSettings().maxTurns)
  )
  const [subagentMaxTurnsTouched, setSubagentMaxTurnsTouched] = useState(false)
  const compactionProviderForModels = providerSettings.compactionProvider || providers.currentProvider || 'OpenRouter'
  const { data: compactionModelsData } = useModels(compactionProviderForModels)
  const normalizedRemoteBaseUrlInput = normalizeRemoteBaseUrl(remoteBaseUrlInput)
  const effectiveRemoteMobileUrl =
    buildRemoteMobileUrl(normalizedRemoteBaseUrlInput) || buildRemoteMobileUrl(detectedLocalServerOrigin)
  const remoteQrCodeImageUrl = effectiveRemoteMobileUrl
    ? `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(effectiveRemoteMobileUrl)}`
    : null
  const subagentProviderForModels = subagentSettings.defaultProvider || providers.currentProvider || 'OpenRouter'
  const { data: subagentModelsData } = useModels(subagentProviderForModels)
  const selectedSubagentModel = subagentModelsData?.models?.find(
    model =>
      model.id === subagentSettings.defaultModel ||
      model.name === subagentSettings.defaultModel ||
      normalizeSubagentModelName(model.name, subagentProviderForModels) === subagentSettings.defaultModel
  )
  const selectedSubagentModelValue =
    normalizeSubagentModelName(selectedSubagentModel?.id, subagentProviderForModels) ||
    normalizeSubagentModelName(subagentSettings.defaultModel, subagentProviderForModels) ||
    ''
  const defaultChatModePrompt = getDefaultChatModePrompt()
  const selectedChatModePrompt =
    operationModePromptSettings.selectedChatPromptId === DEFAULT_CHAT_MODE_PROMPT_ID
      ? defaultChatModePrompt
      : operationModePromptSettings.chatPrompts.find(
          prompt => prompt.id === operationModePromptSettings.selectedChatPromptId
        ) ?? defaultChatModePrompt
  const isDefaultChatModePromptSelected = selectedChatModePrompt.id === DEFAULT_CHAT_MODE_PROMPT_ID
  const defaultAgentModePrompt = getDefaultAgentModePrompt()
  const defaultSubagentModePrompt = getDefaultSubagentModePrompt()
  const isAgentModePromptOverridden = operationModePromptSettings.agentModePromptOverride !== null
  const isSubagentModePromptOverridden = operationModePromptSettings.subagentModePromptOverride !== null

  const handleLogout = async () => {
    await signOut()
  }

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

    window.electronAPI?.storage
      ?.get(BROWSER_SETTINGS_STORAGE_KEY)
      .then(stored => {
        if (!active || !stored || typeof stored !== 'object') return
        const saved = hydrateBrowserSettings(stored as BrowserSettings)
        setBrowserSettings(saved)
      })
      .catch(error => {
        console.error('Failed to hydrate browser settings from Electron storage:', error)
      })

    return () => {
      active = false
    }
  }, [])

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
      if (!subagentMaxTurnsTouched) {
        setSubagentMaxTurnsInput(String(e.detail.maxTurns))
      }
    }

    window.addEventListener(SUBAGENT_TOOL_SETTINGS_CHANGE_EVENT, handleSubagentSettingsChange as EventListener)
    return () =>
      window.removeEventListener(SUBAGENT_TOOL_SETTINGS_CHANGE_EVENT, handleSubagentSettingsChange as EventListener)
  }, [subagentMaxTurnsTouched])

  useEffect(() => {
    const handleBrowserSettingsChange = (e: CustomEvent<BrowserSettings>) => {
      setBrowserSettings(e.detail)
    }

    window.addEventListener(BROWSER_SETTINGS_CHANGE_EVENT, handleBrowserSettingsChange as EventListener)
    return () =>
      window.removeEventListener(BROWSER_SETTINGS_CHANGE_EVENT, handleBrowserSettingsChange as EventListener)
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
    if (import.meta.env.VITE_ENVIRONMENT !== 'electron') {
      setZaiApiKeyLoading(false)
      return
    }

    let active = true
    const effectiveUserId = userId || LOCAL_AUTH_USER_ID

    localApi
      .get<{ success?: boolean; hasToken?: boolean }>(`/provider-auth/zai/token?userId=${encodeURIComponent(effectiveUserId)}`)
      .then(status => {
        if (!active) return
        setZaiApiKeyConfigured(Boolean(status?.hasToken))
        setZaiApiKeyInput('')
      })
      .catch(error => {
        if (active) {
          console.error('Failed to load Z.AI token status:', error)
          setZaiApiKeyConfigured(false)
        }
      })
      .finally(() => {
        if (active) setZaiApiKeyLoading(false)
      })

    return () => {
      active = false
    }
  }, [userId])

  useEffect(() => {
    if (import.meta.env.VITE_ENVIRONMENT !== 'electron') {
      setBedrockCredentialsLoading(false)
      return
    }

    let active = true
    const effectiveUserId = userId || LOCAL_AUTH_USER_ID

    localApi
      .get<{ success?: boolean; hasToken?: boolean }>(
        `/provider-auth/bedrock/token?userId=${encodeURIComponent(effectiveUserId)}`
      )
      .then(status => {
        if (!active) return
        setBedrockCredentialsConfigured(Boolean(status?.hasToken))
        setBedrockAccessKeyIdInput('')
        setBedrockSecretAccessKeyInput('')
        setBedrockSessionTokenInput('')
      })
      .catch(error => {
        if (active) {
          console.error('Failed to load Amazon Bedrock credential status:', error)
          setBedrockCredentialsConfigured(false)
        }
      })
      .finally(() => {
        if (active) setBedrockCredentialsLoading(false)
      })

    return () => {
      active = false
    }
  }, [userId])

  useEffect(() => {
    if (openRouterTemperatureTouched) return
    const configured = providerSettings.openRouterTemperature
    setOpenRouterTemperatureInput(typeof configured === 'number' ? String(configured) : '')
  }, [providerSettings.openRouterTemperature, openRouterTemperatureTouched])

  useEffect(() => {
    if (lmStudioBaseUrlTouched) return
    setLmStudioBaseUrlInput(providerSettings.lmStudioBaseUrl ?? '')
  }, [providerSettings.lmStudioBaseUrl, lmStudioBaseUrlTouched])

  useEffect(() => {
    if (compactionSystemPromptTouched) return
    setCompactionSystemPromptInput(providerSettings.compactionSystemPrompt)
  }, [providerSettings.compactionSystemPrompt, compactionSystemPromptTouched])

  useEffect(() => {
    setChatModePromptNameInput(selectedChatModePrompt.name)
    setChatModePromptInput(selectedChatModePrompt.prompt)
  }, [selectedChatModePrompt.id, selectedChatModePrompt.name, selectedChatModePrompt.prompt])

  useEffect(() => {
    setAgentModePromptInput(operationModePromptSettings.agentModePromptOverride || defaultAgentModePrompt.prompt)
  }, [operationModePromptSettings.agentModePromptOverride, defaultAgentModePrompt.prompt])

  useEffect(() => {
    setSubagentModePromptInput(operationModePromptSettings.subagentModePromptOverride || defaultSubagentModePrompt.prompt)
  }, [operationModePromptSettings.subagentModePromptOverride, defaultSubagentModePrompt.prompt])

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
    const handleOperationModePromptSettingsChange = (e: CustomEvent<OperationModePromptSettings>) => {
      setOperationModePromptSettings(e.detail)
    }

    window.addEventListener(
      OPERATION_MODE_PROMPT_SETTINGS_CHANGE_EVENT,
      handleOperationModePromptSettingsChange as EventListener
    )
    return () =>
      window.removeEventListener(
        OPERATION_MODE_PROMPT_SETTINGS_CHANGE_EVENT,
        handleOperationModePromptSettingsChange as EventListener
      )
  }, [])

  useEffect(() => {
    const handlePlanModeResponseSettingsChange = (e: CustomEvent<PlanModeResponseSettings>) => {
      setPlanModeResponseSettings(e.detail)
    }

    window.addEventListener(
      PLAN_MODE_RESPONSE_SETTINGS_CHANGE_EVENT,
      handlePlanModeResponseSettingsChange as EventListener
    )
    return () =>
      window.removeEventListener(
        PLAN_MODE_RESPONSE_SETTINGS_CHANGE_EVENT,
        handlePlanModeResponseSettingsChange as EventListener
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

  const closeOpenaiLoginModal = () => {
    setOpenaiLoginModalOpen(false)
    setOpenaiAuthFlow(null)
    setOpenaiAuthError(null)
    setOpenaiAuthLoading(false)
    setOpenaiAuthPolling(false)
  }

  const openOpenaiAuthUrl = async (url: string) => {
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

      if (!data.success || !data.accessToken || !data.refreshToken || !data.expiresAt || !data.accountId) {
        if (!options.suppressErrors) {
          setOpenaiAuthError(data.error || 'Authentication failed. Please try again.')
        }
        return 'error'
      }

      const signedInEmail = typeof data.email === 'string' && data.email.trim() ? data.email.trim() : null
      const tokens = {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: data.expiresAt,
        accountId: data.accountId,
        email: signedInEmail,
      }
      saveTokens(tokens)
      await persistOpenAIChatGPTTokensToHeadless(tokens, [userId])
      setOpenaiAccountEmail(signedInEmail)

      dispatch(chatSliceActions.providerSelected('OpenAI (ChatGPT)'))
      closeOpenaiLoginModal()
      showStatus({ type: 'success', text: 'Signed in to OpenAI ChatGPT.' })
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

  const handleOpenAIChatGPTSignIn = async () => {
    try {
      const data = await localApi.post<{ success?: boolean; authUrl?: string; state?: string; error?: string }>(
        '/openai/auth/start'
      )
      if (data.success && data.authUrl && data.state) {
        setOpenaiAuthFlow({ url: data.authUrl, verifier: '', state: data.state })
        setOpenaiAuthError(null)
        setOpenaiLoginModalOpen(true)
        void openOpenaiAuthUrl(data.authUrl)
        return
      }

      throw new Error(data.error || 'Failed to start OAuth flow')
    } catch (error) {
      console.error('Failed to create OpenAI auth flow:', error)
      showStatus({
        type: 'error',
        text: 'Failed to start ChatGPT sign-in. Make sure the app is running in Electron mode.',
      })
    }
  }

  const handleOpenaiLogin = async () => {
    if (!openaiAuthFlow) return
    await openOpenaiAuthUrl(openaiAuthFlow.url)
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
        setOpenaiAuthError('Sign-in is taking longer than expected. Finish in your browser or open the sign-in page again.')
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

  const handleOpenAIChatGPTSignOut = async () => {
    clearOpenAITokens()

    const failedHeadlessTokenDeletes: unknown[] = []
    const results = await Promise.allSettled([clearOpenAIChatGPTTokensFromHeadless([userId])])
    failedHeadlessTokenDeletes.push(...results.filter(result => result.status === 'rejected'))

    setOpenaiAccountEmail(null)
    if (providers.currentProvider === 'OpenAI (ChatGPT)') {
      dispatch(chatSliceActions.providerSelected('OpenRouter'))
    }

    if (failedHeadlessTokenDeletes.length > 0) {
      console.error('Failed to clear one or more headless OpenAI ChatGPT tokens:', failedHeadlessTokenDeletes)
      showStatus({
        type: 'error',
        text: 'Signed out locally, but failed to clear one or more headless ChatGPT tokens. Try signing out again.',
      })
      return
    }

    showStatus({ type: 'success', text: 'Signed out of OpenAI ChatGPT.' })
  }

  const handleSaveZaiApiKey = async () => {
    const normalized = zaiApiKeyInput.trim()
    if (!normalized) {
      showStatus({ type: 'error', text: 'Enter a Z.AI API key before saving.' })
      return
    }

    const effectiveUserId = userId || LOCAL_AUTH_USER_ID
    setZaiApiKeySaving(true)
    try {
      await localApi.post('/provider-auth/zai/token', {
        userId: effectiveUserId,
        accessToken: normalized,
      })
      setZaiApiKeyInput('')
      setZaiApiKeyConfigured(true)
      showStatus({ type: 'success', text: 'Z.AI API key saved locally.' })
    } catch (error) {
      console.error('Failed to save Z.AI API key:', error)
      showStatus({ type: 'error', text: error instanceof Error ? error.message : 'Failed to save Z.AI API key.' })
    } finally {
      setZaiApiKeySaving(false)
    }
  }

  const handleDeleteZaiApiKey = async () => {
    const effectiveUserId = userId || LOCAL_AUTH_USER_ID
    setZaiApiKeySaving(true)
    try {
      await localApi.delete(`/provider-auth/zai/token?userId=${encodeURIComponent(effectiveUserId)}`)
      setZaiApiKeyInput('')
      setZaiApiKeyConfigured(false)
      showStatus({ type: 'success', text: 'Z.AI API key removed.' })
    } catch (error) {
      console.error('Failed to delete Z.AI API key:', error)
      showStatus({ type: 'error', text: error instanceof Error ? error.message : 'Failed to delete Z.AI API key.' })
    } finally {
      setZaiApiKeySaving(false)
    }
  }

  const handleSaveBedrockCredentials = async () => {
    const region = bedrockRegionInput.trim()
    const accessKeyId = bedrockAccessKeyIdInput.trim()
    const secretAccessKey = bedrockSecretAccessKeyInput.trim()
    const sessionToken = bedrockSessionTokenInput.trim()

    if (!region || !accessKeyId || !secretAccessKey) {
      showStatus({
        type: 'error',
        text: 'Enter an AWS region, access key ID, and secret access key before saving Bedrock credentials.',
      })
      return
    }

    const effectiveUserId = userId || LOCAL_AUTH_USER_ID
    setBedrockCredentialsSaving(true)
    try {
      await localApi.post('/provider-auth/bedrock/token', {
        userId: effectiveUserId,
        accessToken: JSON.stringify({
          region,
          accessKeyId,
          secretAccessKey,
          ...(sessionToken ? { sessionToken } : {}),
        }),
      })
      setBedrockRegionInput(region)
      setBedrockAccessKeyIdInput('')
      setBedrockSecretAccessKeyInput('')
      setBedrockSessionTokenInput('')
      setBedrockCredentialsConfigured(true)
      showStatus({ type: 'success', text: 'Amazon Bedrock credentials saved locally.' })
    } catch (error) {
      console.error('Failed to save Amazon Bedrock credentials:', error)
      showStatus({
        type: 'error',
        text: error instanceof Error ? error.message : 'Failed to save Amazon Bedrock credentials.',
      })
    } finally {
      setBedrockCredentialsSaving(false)
    }
  }

  const handleDeleteBedrockCredentials = async () => {
    const effectiveUserId = userId || LOCAL_AUTH_USER_ID
    setBedrockCredentialsSaving(true)
    try {
      await localApi.delete(`/provider-auth/bedrock/token?userId=${encodeURIComponent(effectiveUserId)}`)
      setBedrockAccessKeyIdInput('')
      setBedrockSecretAccessKeyInput('')
      setBedrockSessionTokenInput('')
      setBedrockCredentialsConfigured(false)
      showStatus({ type: 'success', text: 'Amazon Bedrock credentials removed.' })
    } catch (error) {
      console.error('Failed to delete Amazon Bedrock credentials:', error)
      showStatus({
        type: 'error',
        text: error instanceof Error ? error.message : 'Failed to delete Amazon Bedrock credentials.',
      })
    } finally {
      setBedrockCredentialsSaving(false)
    }
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

  const handleLmStudioBaseUrlInputChange = (value: string) => {
    setLmStudioBaseUrlInput(value)
    setLmStudioBaseUrlTouched(true)
  }

  const loadMemoryFiles = async () => {
    if (import.meta.env.VITE_ENVIRONMENT !== 'electron') return

    setMemoryFilesLoading(true)
    setMemoryFilesError(null)
    try {
      const response = await localApi.get<MemoryFilesResponse>('/memory/files')
      const files = Array.isArray(response.files) ? response.files : []
      setMemoryFiles(
        [...files].sort((a, b) => {
          const rank = (file: MemoryFileSummary) => (file.kind === 'global' ? 0 : file.kind === 'recent' ? 1 : 2)
          const rankDiff = rank(a) - rank(b)
          if (rankDiff !== 0) return rankDiff
          if (a.kind === 'project' && b.kind === 'project') {
            const aUpdated = a.updatedAt ? new Date(a.updatedAt).getTime() : 0
            const bUpdated = b.updatedAt ? new Date(b.updatedAt).getTime() : 0
            if (aUpdated !== bUpdated) return bUpdated - aUpdated
          }
          return a.label.localeCompare(b.label)
        })
      )
    } catch (error) {
      console.error('Failed to load memory files:', error)
      const message = error instanceof Error ? error.message : 'Failed to load memory files.'
      setMemoryFilesError(message)
    } finally {
      setMemoryFilesLoading(false)
    }
  }

  const openMemoryFile = async (file: MemoryFileSummary) => {
    setSelectedMemoryFile(file)
    setMemoryModalOpen(true)
    setMemoryContent('')
    setMemoryContentError(null)
    setMemoryContentLoading(true)

    try {
      const response = await localApi.get<MemoryFileContentResponse>(`/memory/file?id=${encodeURIComponent(file.id)}`)
      setMemoryContent(response.content || '')
      if (response.file) {
        setSelectedMemoryFile(response.file)
      }
    } catch (error) {
      console.error('Failed to load memory file:', error)
      setMemoryContentError(error instanceof Error ? error.message : 'Failed to load memory file.')
    } finally {
      setMemoryContentLoading(false)
    }
  }

  const closeMemoryModal = () => {
    setMemoryModalOpen(false)
    setSelectedMemoryFile(null)
    setMemoryContent('')
    setMemoryContentError(null)
    setMemoryContentLoading(false)
  }

  const refreshSelectedMemoryFile = async () => {
    if (!selectedMemoryFile) return
    await openMemoryFile(selectedMemoryFile)
    await loadMemoryFiles()
  }

  const handleMemoryBackfill = async () => {
    if (import.meta.env.VITE_ENVIRONMENT !== 'electron') {
      showStatus({ type: 'info', text: 'Memory indexing is only available in the Electron app.' })
      return
    }

    const effectiveUserId = userId || LOCAL_AUTH_USER_ID
    if (!effectiveUserId) {
      showStatus({ type: 'error', text: 'No local user is available for memory indexing.' })
      return
    }

    setMemoryBackfillRunning(true)
    try {
      const response = await localApi.post<{
        success: boolean
        result?: {
          processed: number
          embedded: number
          failed: number
          skipped: number
          dimensions: number | null
          model: string | null
        }
      }>('/local/conversations/search/notes/backfill-missing', {
        userId: effectiveUserId,
        model: 'text-embedding-nomic-embed-text-v1.5',
        batchSize: 8,
        limit: 100,
        includeStatuses: ['pending', 'stale', 'error'],
      })

      const result = response?.result
      showStatus({
        type: 'success',
        text: result
          ? `Memory backfill finished. Embedded ${result.embedded}/${result.processed} notes${result.failed ? `, ${result.failed} failed` : ''}${result.skipped ? `, ${result.skipped} skipped` : ''}.`
          : 'Memory backfill finished.',
      })
      await loadMemoryFiles()
    } catch (error) {
      console.error('Failed to backfill memory embeddings:', error)
      showStatus({
        type: 'error',
        text: error instanceof Error ? error.message : 'Failed to backfill memory embeddings.',
      })
    } finally {
      setMemoryBackfillRunning(false)
    }
  }

  const commitLmStudioBaseUrlChange = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) {
      const updated = {
        ...providerSettings,
        lmStudioBaseUrl: null,
      }
      saveProviderSettings(updated)
      setProviderSettings(updated)
      setLmStudioBaseUrlTouched(false)
      setLmStudioBaseUrlInput('')
      showStatus({ type: 'success', text: `LM Studio server reset to default (${DEFAULT_LMSTUDIO_BASE_URL}).` })
      return
    }

    const normalized = normalizeLmStudioBaseUrl(trimmed)
    if (!normalized) {
      setLmStudioBaseUrlTouched(false)
      setLmStudioBaseUrlInput(providerSettings.lmStudioBaseUrl ?? '')
      showStatus({
        type: 'error',
        text: 'LM Studio server URL must start with http:// or https:// (example: http://127.0.0.1:1234).',
      })
      return
    }

    const updated = {
      ...providerSettings,
      lmStudioBaseUrl: normalized,
    }
    saveProviderSettings(updated)
    setProviderSettings(updated)
    setLmStudioBaseUrlTouched(false)
    setLmStudioBaseUrlInput(normalized)
    showStatus({ type: 'success', text: `LM Studio server URL saved: ${normalized}` })
  }

  const persistSubagentSettings = (nextSettings: SubagentToolSettings, successText: string) => {
    saveSubagentToolSettings(nextSettings)
    setSubagentSettings(nextSettings)
    showStatus({ type: 'success', text: successText })
  }

  const commitSubagentMaxTurnsChange = (value: string) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setSubagentMaxTurnsTouched(false)
      setSubagentMaxTurnsInput(String(subagentSettings.maxTurns))
      showStatus({ type: 'error', text: 'Subagent max turns must be a positive number.' })
      return
    }

    const maxTurns = Math.floor(parsed)
    persistSubagentSettings(
      {
        ...subagentSettings,
        maxTurns,
      },
      `Subagent max turns updated to ${maxTurns}.`
    )
    setSubagentMaxTurnsTouched(false)
    setSubagentMaxTurnsInput(String(maxTurns))
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

  const handleSubagentProviderChange = (providerName: string) => {
    const nextProvider = providerName || null
    persistSubagentSettings(
      {
        ...subagentSettings,
        defaultProvider: nextProvider,
        defaultModel: null,
      },
      nextProvider
        ? `Subagent provider set to "${nextProvider}".`
        : 'Subagent provider will follow the current chat provider.'
    )
  }

  const handleSubagentModelChange = (modelName: string) => {
    const nextModel = normalizeSubagentModelName(modelName, subagentProviderForModels)
    persistSubagentSettings(
      {
        ...subagentSettings,
        defaultModel: nextModel,
      },
      nextModel ? 'Subagent model updated.' : 'Subagent model will use provider selected/default model.'
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

  useEffect(() => {
    if (import.meta.env.VITE_ENVIRONMENT !== 'electron') return
    loadMemoryFiles()
  }, [])

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

  const handleTokenUsageHoverDetailsToggle = () => {
    const nextValue = !showTokenUsageHoverDetails
    saveShowTokenUsageHoverDetails(nextValue)
    setShowTokenUsageHoverDetails(nextValue)
    showStatus({
      type: 'success',
      text: nextValue
        ? 'Token usage hover details enabled in Chat.'
        : 'Token usage hover details hidden in Chat.',
    })
  }

  const handleAddedFilesPillsToggle = () => {
    const nextValue = !showAddedFilesPills
    saveShowAddedFilesPills(nextValue)
    setShowAddedFilesPills(nextValue)
    showStatus({
      type: 'success',
      text: nextValue ? 'Added file pills shown in Chat.' : 'Added file pills hidden in Chat.',
    })
  }

  const handleChatModePromptSelect = (promptId: string) => {
    const saved = selectChatModePrompt(promptId)
    setOperationModePromptSettings(saved)
    showStatus({ type: 'success', text: 'Chat Mode prompt selected.' })
  }

  const handlePlanModeVerbosityChange = (value: string) => {
    const verbosity = PLAN_MODE_VERBOSITY_OPTIONS.includes(value as PlanModeResponseSettings['verbosity'])
      ? (value as PlanModeResponseSettings['verbosity'])
      : 'concise'
    const saved = savePlanModeResponseSettings({ ...planModeResponseSettings, verbosity })
    setPlanModeResponseSettings(saved)
    showStatus({ type: 'success', text: `Plan verbosity set to ${verbosity}.` })
  }

  const handleSaveNewChatModePrompt = () => {
    const saved = addChatModePrompt(chatModePromptNameInput, chatModePromptInput)
    setOperationModePromptSettings(saved)
    showStatus({ type: 'success', text: 'Chat Mode prompt saved.' })
  }

  const handleUpdateChatModePrompt = () => {
    if (isDefaultChatModePromptSelected) {
      handleSaveNewChatModePrompt()
      return
    }
    const saved = updateChatModePrompt(selectedChatModePrompt.id, {
      name: chatModePromptNameInput,
      prompt: chatModePromptInput,
    })
    setOperationModePromptSettings(saved)
    showStatus({ type: 'success', text: 'Chat Mode prompt updated.' })
  }

  const handleDeleteChatModePrompt = (promptId: string = selectedChatModePrompt.id) => {
    if (promptId === DEFAULT_CHAT_MODE_PROMPT_ID) return
    const confirmed = window.confirm('Delete this saved Chat Mode prompt?')
    if (!confirmed) return
    const saved = deleteChatModePrompt(promptId)
    setOperationModePromptSettings(saved)
    showStatus({ type: 'success', text: 'Chat Mode prompt deleted.' })
  }

  const handleResetChatModePromptToDefault = () => {
    const saved = resetChatModePromptSelectionToDefault()
    setOperationModePromptSettings(saved)
    showStatus({ type: 'success', text: 'Chat Mode prompt reset to default.' })
  }

  const handleSaveAgentModePrompt = () => {
    const saved = saveAgentModePromptOverride(agentModePromptInput)
    setOperationModePromptSettings(saved)
    showStatus({ type: 'success', text: saved.agentModePromptOverride ? 'Agent Mode prompt saved.' : 'Agent Mode prompt reset to default.' })
  }

  const handleResetAgentModePrompt = () => {
    const saved = resetAgentModePromptOverride()
    setOperationModePromptSettings(saved)
    showStatus({ type: 'success', text: 'Agent Mode prompt reset to default.' })
  }

  const handleSaveSubagentModePrompt = () => {
    const saved = saveSubagentModePromptOverride(subagentModePromptInput)
    setOperationModePromptSettings(saved)
    showStatus({
      type: 'success',
      text: saved.subagentModePromptOverride ? 'Subagent system prompt saved.' : 'Subagent system prompt reset to default.',
    })
  }

  const handleResetSubagentModePrompt = () => {
    const saved = resetSubagentModePromptOverride()
    setOperationModePromptSettings(saved)
    showStatus({ type: 'success', text: 'Subagent system prompt reset to default.' })
  }

  const handleAutoCompactionToggle = () => {
    const nextValue = !autoCompactionEnabled
    saveAutoCompactionEnabled(nextValue)
    setAutoCompactionEnabled(nextValue)
    showStatus({
      type: 'success',
      text: nextValue ? 'Auto compaction enabled in Chat.' : 'Auto compaction disabled in Chat.',
    })
  }

  const handleBrowserGuestDevToolsToggle = () => {
    const saved = saveBrowserSettings({
      ...browserSettings,
      guestDevToolsEnabled: !browserSettings.guestDevToolsEnabled,
    })
    setBrowserSettings(saved)
    showStatus({
      type: 'success',
      text: saved.guestDevToolsEnabled
        ? 'Built-in browser DevTools enabled.'
        : 'Built-in browser DevTools disabled.',
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
      source: 'google',
      googleFontUrl: DEFAULT_GOOGLE_FONT_URL,
      googleFontFamily: DEFAULT_GOOGLE_FONT_FAMILY,
    })
    showStatus({ type: 'success', text: `App font reset to ${DEFAULT_GOOGLE_FONT_FAMILY}.` })
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
        source: fontSettings.source === 'local' ? 'google' : fontSettings.source,
        googleFontUrl: fontSettings.source === 'local' ? DEFAULT_GOOGLE_FONT_URL : fontSettings.googleFontUrl,
        googleFontFamily: fontSettings.source === 'local' ? DEFAULT_GOOGLE_FONT_FAMILY : fontSettings.googleFontFamily,
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
      : 'high'
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
    if (toolCallTimeoutTouched) return
    setToolCallTimeoutInput(String(toolExecutionSettings.toolCallTimeoutMs))
  }, [toolExecutionSettings.toolCallTimeoutMs, toolCallTimeoutTouched])

  useEffect(() => {
    if (bashTimeoutTouched) return
    setBashTimeoutInput(String(toolExecutionSettings.bashTimeoutMs))
  }, [toolExecutionSettings.bashTimeoutMs, bashTimeoutTouched])

  useEffect(() => {
    if (subagentMaxTurnsTouched) return
    setSubagentMaxTurnsInput(String(subagentSettings.maxTurns))
  }, [subagentSettings.maxTurns, subagentMaxTurnsTouched])

  useEffect(() => {
    if (!isChangelogOpen && !memoryModalOpen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsChangelogOpen(false)
        closeMemoryModal()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isChangelogOpen, memoryModalOpen])

  const handleToolCallTimeoutInputChange = (value: string) => {
    setToolCallTimeoutInput(value)
    setToolCallTimeoutTouched(true)
  }

  const handleBashTimeoutInputChange = (value: string) => {
    setBashTimeoutInput(value)
    setBashTimeoutTouched(true)
  }

  const handleSubagentMaxTurnsInputChange = (value: string) => {
    setSubagentMaxTurnsInput(value)
    setSubagentMaxTurnsTouched(true)
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
    showStatus({ type: 'success', text: 'Gallery cleared. Using the default app background.' })
  }

  const handleResetToDefault = () => {
    persistActiveCustomVideoId(null)
    persistBackgroundMode('color')
    setActiveVideoId(null)
    setBackgroundMode('color')
    showStatus({ type: 'success', text: 'Reverted to the default app background.' })
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
      <div className={`rounded-full border px-4 py-2 text-sm backdrop-blur-xl ${colors[statusMessage.type]}`}>{statusMessage.text}</div>
    )
  }

  const globalMemoryFiles = memoryFiles.filter(file => file.kind !== 'project')
  const projectMemoryFiles = memoryFiles.filter(file => file.kind === 'project')

  const renderMemoryFileButton = (file: MemoryFileSummary) => (
    <button
      key={file.id}
      type='button'
      onClick={() => openMemoryFile(file)}
      className='group flex w-full items-center justify-between gap-3 rounded-[1.75rem] bg-white/55 px-4 py-3 text-left backdrop-blur-xl transition hover:-translate-y-0.5 hover:bg-white/75 active:translate-y-0 active:scale-[0.99] dark:bg-white/5 dark:hover:bg-white/10'
      aria-label={`View ${file.label}`}
    >
      <span className='min-w-0'>
        <span className='block truncate text-sm font-medium text-stone-800 dark:text-stone-100'>{file.label}</span>
        <span className='mt-0.5 block truncate text-xs text-stone-500 dark:text-stone-400'>
          {file.description || 'memory file'} • {file.exists ? formatSize(file.sizeBytes) : 'not created'}
        </span>
      </span>
      <span className='shrink-0 text-right text-[11px] text-stone-400 transition group-hover:text-stone-600 dark:text-stone-500 dark:group-hover:text-stone-300'>
        {formatMemoryUpdatedAt(file.updatedAt)}
      </span>
    </button>
  )

  return (
    <div className='h-full overflow-y-auto thin-scrollbar bg-transparent min-h-full'>
      <div className='mx-auto flex max-w-6xl flex-col gap-5 px-4 py-8'>
        <header className='sticky top-0 z-10 flex flex-wrap items-center justify-between gap-4 rounded-[2.25rem] bg-white/35 p-3 pl-5 backdrop-blur-2xl dark:bg-black/15'>
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
              className='rounded-full bg-white/70 px-4 py-2 font-mono text-xs tracking-wide text-stone-700 backdrop-blur-xl transition hover:-translate-y-0.5 hover:bg-white active:translate-y-0 active:scale-95 dark:bg-white/10 dark:text-stone-200 dark:hover:bg-white/15'
            >
              CHANGELOG
            </button>
            <button
              type='button'
              onClick={() => navigate(-1)}
              className={circularControlClass}
              title='Home'
              aria-label='Home'
            >
              <ArrowLeft size={18} strokeWidth={2.25} aria-hidden='true' />
            </button>
            <button
              type='button'
              onClick={handleLogout}
              className={circularControlClass}
              title='Logout'
              aria-label='Logout'
            >
              <LogOut size={18} strokeWidth={2.25} aria-hidden='true' />
            </button>
          </div>
        </header>

        {renderStatus()}

        {isChangelogOpen && (
          <div
            className='fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4'
            onClick={() => setIsChangelogOpen(false)}
          >
            <div
              className='w-full max-w-4xl max-h-[85vh] overflow-hidden rounded-[2.5rem] bg-white/90 backdrop-blur-xl dark:bg-zinc-900/95'
              onClick={event => event.stopPropagation()}
            >
              <div className='flex items-center justify-between bg-white/60 px-4 py-3 backdrop-blur-xl dark:bg-zinc-900/70'>
                <p className='font-mono text-sm tracking-wide text-stone-800 dark:text-stone-100'>CHANGELOG</p>
                <button
                  type='button'
                  onClick={() => setIsChangelogOpen(false)}
                  className='rounded-full p-2 text-stone-500 transition hover:bg-white/70 hover:text-stone-900 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-stone-100'
                >
                  <X size={18} strokeWidth={2.25} aria-hidden='true' />
                </button>
              </div>
              <div className='max-h-[calc(85vh-60px)] overflow-y-auto thin-scrollbar p-4'>
                <div className='prose prose-sm max-w-none dark:prose-invert prose-headings:font-semibold prose-pre:rounded-lg'>
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeHighlight, rehypeKatex]}>
                    {changelogMarkdown}
                  </ReactMarkdown>
                </div>
              </div>
            </div>
          </div>
        )}

        {memoryModalOpen && selectedMemoryFile && (
          <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4' onClick={closeMemoryModal}>
            <div
              className='w-full max-w-4xl max-h-[85vh] overflow-hidden rounded-[2.5rem] bg-white/90 backdrop-blur-xl dark:bg-zinc-900/95'
              onClick={event => event.stopPropagation()}
            >
              <div className='flex items-start justify-between gap-4 px-5 py-4'>
                <div className='min-w-0'>
                  <p className='truncate text-sm font-semibold text-stone-900 dark:text-stone-100'>{selectedMemoryFile.label}</p>
                  <p className='mt-1 truncate text-xs text-stone-500 dark:text-stone-400'>
                    {selectedMemoryFile.description || 'memory.md'} • {selectedMemoryFile.exists ? formatSize(selectedMemoryFile.sizeBytes) : 'not created'}
                  </p>
                </div>
                <div className='flex shrink-0 items-center gap-2'>
                  <button
                    type='button'
                    onClick={refreshSelectedMemoryFile}
                    disabled={memoryContentLoading}
                    className='rounded-full bg-white/70 px-4 py-2 text-xs font-medium text-stone-600 backdrop-blur-xl transition hover:bg-white disabled:opacity-60 dark:bg-white/10 dark:text-stone-300 dark:hover:bg-white/15'
                  >
                    Refresh
                  </button>
                  <button
                    type='button'
                    onClick={closeMemoryModal}
                    aria-label='Close memory preview'
                    className='rounded-full p-2 text-stone-600 transition hover:bg-white/70 hover:text-stone-900 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-stone-100'
                  >
                    <X size={18} strokeWidth={2.25} aria-hidden='true' />
                  </button>
                </div>
              </div>
              <div className='max-h-[calc(85vh-76px)] overflow-y-auto thin-scrollbar px-5 pb-5'>
                {memoryContentLoading ? (
                  <p className='rounded-[1.75rem] bg-white/55 px-4 py-3 text-sm text-stone-500 dark:bg-stone-800/45 dark:text-stone-300'>
                    Loading memory file…
                  </p>
                ) : memoryContentError ? (
                  <p className='rounded-[1.75rem] bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-900/30 dark:text-rose-200'>
                    {memoryContentError}
                  </p>
                ) : (
                  <div className='prose prose-sm max-w-none dark:prose-invert prose-headings:font-semibold prose-pre:rounded-lg prose-pre:bg-stone-950'>
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeHighlight, rehypeKatex]}>
                      {memoryContent || '_This memory file is empty._'}
                    </ReactMarkdown>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <SettingsSection
          title='Chat Interface'
          description='Control optional chat UI elements.'
          features={['Token usage bar', 'Hover details', 'Added file pills', 'Auto compaction']}
        >
          <div className='flex flex-col gap-4'>
            <div className='flex items-center justify-between'>
              <div>
                <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Show Token Usage Bar</p>
                <p className='text-sm text-stone-500 dark:text-stone-400'>
                  Display input/output token progress and credit refresh in the chat composer.
                </p>
              </div>
              <button
                onClick={handleTokenUsageBarToggle}
                className={settingsToggleClass(showTokenUsageBar)}
              >
                <span
                  className={settingsToggleKnobClass(showTokenUsageBar)}
                />
              </button>
            </div>

            <div className='flex items-center justify-between pt-2 pt-2'>
              <div>
                <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Show Token Usage Hover Details</p>
                <p className='text-sm text-stone-500 dark:text-stone-400'>
                  Show the context, message, model window, and credits popup when hovering the token usage progress bar.
                </p>
              </div>
              <button
                onClick={handleTokenUsageHoverDetailsToggle}
                className={settingsToggleClass(showTokenUsageHoverDetails)}
              >
                <span
                  className={settingsToggleKnobClass(showTokenUsageHoverDetails)}
                />
              </button>
            </div>

            <div className='flex items-center justify-between pt-2 pt-2'>
              <div>
                <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Show Added File Pills</p>
                <p className='text-sm text-stone-500 dark:text-stone-400'>
                  Display selected @ files as removable pills below the chat input.
                </p>
              </div>
              <button
                onClick={handleAddedFilesPillsToggle}
                className={settingsToggleClass(showAddedFilesPills)}
              >
                <span
                  className={settingsToggleKnobClass(showAddedFilesPills)}
                />
              </button>
            </div>

            <div className='flex items-center justify-between pt-2 pt-2'>
              <div>
                <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Auto Compaction</p>
                <p className='text-sm text-stone-500 dark:text-stone-400'>
                  Automatically compact the visible branch before send when context usage gets near the model or credit
                  threshold.
                </p>
              </div>
              <button
                onClick={handleAutoCompactionToggle}
                className={settingsToggleClass(autoCompactionEnabled)}
              >
                <span
                  className={settingsToggleKnobClass(autoCompactionEnabled)}
                />
              </button>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          title='Chat Mode Prompt'
          description='Used when the composer is in Chat Mode. Chat Mode is read-only/planning-oriented.'
          features={['Active prompt', 'Plan verbosity', 'Prompt editor', 'Saved prompts']}
        >
          <div className='flex flex-col gap-4'>
            <div className='flex flex-col gap-2'>
              <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Active Prompt</p>
              <Select
                value={selectedChatModePrompt.id}
                onChange={handleChatModePromptSelect}
                options={[
                  { value: defaultChatModePrompt.id, label: `${defaultChatModePrompt.name} (Default)` },
                  ...operationModePromptSettings.chatPrompts.map(prompt => ({ value: prompt.id, label: prompt.name })),
                ]}
                className='max-w-xl'
              />
            </div>

            <div className='flex flex-col gap-2 pt-2 pt-2'>
              <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Plan Verbosity</p>
              <p className='text-sm text-stone-500 dark:text-stone-400'>
                Controls how much detail Plan Mode asks the model to include in implementation plans.
              </p>
              <Select
                value={planModeResponseSettings.verbosity}
                onChange={handlePlanModeVerbosityChange}
                options={PLAN_MODE_VERBOSITY_OPTIONS.map(option => ({
                  value: option,
                  label: option === 'concise' ? 'Concise' : option === 'normal' ? 'Normal' : 'Detailed',
                }))}
                className='max-w-xs'
              />
            </div>

            <div className='flex flex-col gap-2 pt-2 pt-2'>
              <label className='text-sm font-medium text-stone-700 dark:text-stone-200'>Prompt Name</label>
              <input
                type='text'
                value={chatModePromptNameInput}
                onChange={e => setChatModePromptNameInput(e.target.value)}
                className={`w-full ${settingsInputClass}`}
              />
              <label className='text-sm font-medium text-stone-700 dark:text-stone-200'>Prompt</label>
              <textarea
                value={chatModePromptInput}
                onChange={e => setChatModePromptInput(e.target.value)}
                rows={8}
                className={`w-full ${settingsTextAreaClass}`}
              />
              <div className='flex flex-wrap gap-2'>
                <Button onClick={handleSaveNewChatModePrompt}>Save as New</Button>
                <Button onClick={handleUpdateChatModePrompt}>
                  {isDefaultChatModePromptSelected ? 'Save Default as Custom' : 'Update Saved Prompt'}
                </Button>
                {!isDefaultChatModePromptSelected && (
                  <Button variant='secondary' onClick={() => handleDeleteChatModePrompt()}>
                    Delete
                  </Button>
                )}
                <Button variant='secondary' onClick={handleResetChatModePromptToDefault}>
                  Reset to Default
                </Button>
              </div>
            </div>

            <div className='flex flex-col gap-2 pt-2 pt-2'>
              <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Saved Prompts</p>
              <div className='flex flex-col gap-2'>
                <div className='flex items-center justify-between rounded-full bg-white/45 px-4 py-3 text-sm backdrop-blur-xl dark:bg-white/5'>
                  <span className='text-stone-800 dark:text-stone-100'>{defaultChatModePrompt.name}</span>
                  <span className='text-xs text-stone-500 dark:text-stone-400'>
                    {selectedChatModePrompt.id === defaultChatModePrompt.id ? 'Selected default' : 'Default'}
                  </span>
                </div>
                {operationModePromptSettings.chatPrompts.map(prompt => (
                  <div
                    key={prompt.id}
                    className='flex flex-wrap items-center justify-between gap-2 rounded-[1.75rem] bg-white/45 px-4 py-3 text-sm backdrop-blur-xl dark:bg-white/5'
                  >
                    <span className='text-stone-800 dark:text-stone-100'>{prompt.name}</span>
                    <div className='flex items-center gap-2'>
                      {selectedChatModePrompt.id === prompt.id && (
                        <span className='text-xs text-emerald-600 dark:text-emerald-400'>Selected</span>
                      )}
                      <Button variant='secondary' onClick={() => handleChatModePromptSelect(prompt.id)}>
                        Select
                      </Button>
                      <Button variant='secondary' onClick={() => handleDeleteChatModePrompt(prompt.id)}>
                        Delete
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </SettingsSection>

        {import.meta.env.VITE_ENVIRONMENT === 'electron' && (
          <SettingsSection
            title='Agent Mode Prompt'
            description='Used when the composer is in Agent Mode. A custom prompt changes the baseline instructions for all Agent Mode requests on this device.'
            features={['Editable prompt', 'Local override', 'Default reset']}
          >
          <div className='flex flex-col gap-2'>
            <div>
              <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Agent System Prompt</p>
              <p className='text-sm text-stone-500 dark:text-stone-400'>
                {isAgentModePromptOverridden ? 'Using a saved local override.' : 'Using the bundled default prompt.'}
              </p>
            </div>
            <textarea
              value={agentModePromptInput}
              onChange={e => setAgentModePromptInput(e.target.value)}
              rows={12}
              className={`w-full ${settingsTextAreaClass}`}
            />
            <div className='flex flex-wrap gap-2'>
              <Button onClick={handleSaveAgentModePrompt}>Save Agent Prompt</Button>
              <Button variant='secondary' onClick={handleResetAgentModePrompt}>
                Reset to Default
              </Button>
            </div>
          </div>
          </SettingsSection>
        )}

        <SettingsSection
          title='Chat Reasoning Defaults'
          description='These defaults are loaded every time Chat opens, then applied when the selected model supports reasoning/thinking.'
          features={['Default thinking', 'Reasoning effort']}
        >
          <div className='flex flex-col gap-4'>
            <div className='flex items-center justify-between'>
              <div>
                <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Default Thinking</p>
                <p className='text-sm text-stone-500 dark:text-stone-400'>
                  Automatically turn thinking on for models that support it.
                </p>
              </div>
              <button
                onClick={handleDefaultThinkingToggle}
                className={settingsToggleClass(chatReasoningSettings.defaultThinkingEnabled)}
              >
                <span
                  className={settingsToggleKnobClass(chatReasoningSettings.defaultThinkingEnabled)}
                />
              </button>
            </div>

            <div className='flex flex-col gap-2 pt-2 pt-2'>
              <div>
                <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Default Reasoning Effort</p>
                <p className='text-sm text-stone-500 dark:text-stone-400'>
                  Used when thinking is enabled. The model must support reasoning.
                </p>
              </div>
              <Select
                value={chatReasoningSettings.defaultReasoningEffort}
                onChange={handleDefaultReasoningEffortChange}
                options={REASONING_EFFORT_OPTIONS.map(option => {
                  const baseLabel = option === 'xhigh' ? 'X-High' : option.charAt(0).toUpperCase() + option.slice(1)
                  return {
                    value: option,
                    label:
                      option === chatReasoningSettings.defaultReasoningEffort ? `${baseLabel} (Default)` : baseLabel,
                  }
                })}
                className='max-w-xs'
              />
            </div>
          </div>
        </SettingsSection>

        {/* Provider Settings Section */}
        {import.meta.env.VITE_ENVIRONMENT === 'electron' && (
          <SettingsSection
            title='Provider Settings'
            description='Configure how providers appear in the chat interface.'
            features={['Provider selector', 'Default provider', 'Auto-compaction provider', 'LM Studio URL', 'Provider credentials', 'ChatGPT OAuth']}
          >
            <div className='flex flex-col gap-4'>
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
                  className={settingsToggleClass(providerSettings.showProviderSelector)}
                >
                  <span
                    className={settingsToggleKnobClass(providerSettings.showProviderSelector)}
                  />
                </button>
              </div>

              {/* Default Provider Selection - shown when selector is hidden */}
              {!providerSettings.showProviderSelector && (
                <div className='flex flex-col gap-2 pt-2 pt-2'>
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
              <div className='flex flex-col gap-2 pt-2 pt-2'>
                <div>
                  <p className='text-base font-medium text-stone-900 dark:text-stone-100'>OpenAI ChatGPT Account</p>
                  <p className='text-sm text-stone-500 dark:text-stone-400'>
                    Sign in or out to manage local ChatGPT OAuth tokens used by the OpenAI (ChatGPT) provider.
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
                  {isOpenAIAuthenticated() && openaiAccountEmail && (
                    <span className='max-w-full truncate rounded-full border border-stone-200 bg-stone-50 px-2 py-1 text-xs text-stone-600 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300'>
                      {openaiAccountEmail}
                    </span>
                  )}
                  <Button
                    variant='outline2'
                    size='small'
                    onClick={handleOpenAIChatGPTSignIn}
                    disabled={isOpenAIAuthenticated()}
                  >
                    Sign in to ChatGPT
                  </Button>
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
              <div className='flex flex-col gap-2 pt-2 pt-2'>
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
                    className={`w-full ${settingsTextAreaClass}`}
                  />
                </div>
              </div>

              <div className='flex flex-col gap-2 pt-2 pt-2'>
                <div>
                  <p className='text-base font-medium text-stone-900 dark:text-stone-100'>LM Studio Server URL</p>
                  <p className='text-sm text-stone-500 dark:text-stone-400'>
                    Local override for the LM Studio server address. Leave blank to use the default.
                  </p>
                </div>
                <div className='flex flex-wrap items-center gap-2'>
                  <input
                    type='url'
                    value={lmStudioBaseUrlInput}
                    placeholder={DEFAULT_LMSTUDIO_BASE_URL}
                    onChange={e => handleLmStudioBaseUrlInputChange(e.target.value)}
                    onBlur={e => commitLmStudioBaseUrlChange(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.currentTarget.blur()
                      }
                    }}
                    className={`w-full max-w-xl ${settingsInputClass}`}
                  />
                  {providerSettings.lmStudioBaseUrl && (
                    <Button
                      variant='outline2'
                      size='small'
                      onClick={() => commitLmStudioBaseUrlChange('')}
                      className='h-[36px]'
                    >
                      Reset
                    </Button>
                  )}
                </div>
                <p className='text-xs text-stone-500 dark:text-stone-400'>
                  Used for LM Studio model listing and chat requests. Current default: {DEFAULT_LMSTUDIO_BASE_URL}
                </p>
              </div>

              <div className='flex flex-col gap-2 pt-2 pt-2'>
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
                    className={`w-40 ${settingsInputClass}`}
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


              <div className='flex flex-col gap-2 pt-2 pt-2'>
                <div>
                  <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Z.AI / GLM API Key</p>
                  <p className='text-sm text-stone-500 dark:text-stone-400'>
                    Store your Z.AI BYOK key locally for the GLM headless provider. The key is kept in the local token store for this user.
                  </p>
                </div>
                <div className='flex flex-wrap items-center gap-2'>
                  <span
                    className={`text-xs px-2 py-1 rounded-full border ${
                      zaiApiKeyConfigured
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-900/30 dark:border-emerald-700 dark:text-emerald-300'
                        : 'bg-stone-100 border-stone-200 text-stone-600 dark:bg-stone-800 dark:border-stone-700 dark:text-stone-300'
                    }`}
                  >
                    {zaiApiKeyLoading ? 'Checking…' : zaiApiKeyConfigured ? 'Key saved' : 'No key'}
                  </span>
                  <input
                    type='password'
                    value={zaiApiKeyInput}
                    placeholder={zaiApiKeyConfigured ? 'Enter new key to replace' : 'Enter Z.AI API key'}
                    onChange={e => setZaiApiKeyInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        void handleSaveZaiApiKey()
                      }
                    }}
                    className={`w-full max-w-md ${settingsInputClass}`}
                  />
                  <Button variant='outline2' size='small' onClick={handleSaveZaiApiKey} disabled={zaiApiKeySaving || !zaiApiKeyInput.trim()}>
                    {zaiApiKeyConfigured ? 'Replace key' : 'Save key'}
                  </Button>
                  <Button variant='outline2' size='small' onClick={handleDeleteZaiApiKey} disabled={zaiApiKeySaving || !zaiApiKeyConfigured}>
                    Clear key
                  </Button>
                </div>
              </div>

              <div className='flex flex-col gap-2 pt-2 pt-2'>
                <div>
                  <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Amazon Bedrock Credentials</p>
                  <p className='text-sm text-stone-500 dark:text-stone-400'>
                    Store AWS Bedrock credentials locally for the Amazon Bedrock headless provider. You can also use AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and optional AWS_SESSION_TOKEN environment variables.
                  </p>
                </div>
                <div className='flex flex-wrap items-center gap-2'>
                  <span
                    className={`text-xs px-2 py-1 rounded-full border ${
                      bedrockCredentialsConfigured
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-900/30 dark:border-emerald-700 dark:text-emerald-300'
                        : 'bg-stone-100 border-stone-200 text-stone-600 dark:bg-stone-800 dark:border-stone-700 dark:text-stone-300'
                    }`}
                  >
                    {bedrockCredentialsLoading ? 'Checking…' : bedrockCredentialsConfigured ? 'Credentials saved' : 'No stored credentials'}
                  </span>
                  <input
                    type='text'
                    value={bedrockRegionInput}
                    placeholder='AWS region, e.g. us-east-1'
                    onChange={e => setBedrockRegionInput(e.target.value)}
                    className={`w-full max-w-xs ${settingsInputClass}`}
                  />
                  <input
                    type='password'
                    value={bedrockAccessKeyIdInput}
                    placeholder={bedrockCredentialsConfigured ? 'Enter new access key ID to replace' : 'AWS access key ID'}
                    onChange={e => setBedrockAccessKeyIdInput(e.target.value)}
                    className={`w-full max-w-md ${settingsInputClass}`}
                  />
                  <input
                    type='password'
                    value={bedrockSecretAccessKeyInput}
                    placeholder={bedrockCredentialsConfigured ? 'Enter new secret access key to replace' : 'AWS secret access key'}
                    onChange={e => setBedrockSecretAccessKeyInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        void handleSaveBedrockCredentials()
                      }
                    }}
                    className={`w-full max-w-md ${settingsInputClass}`}
                  />
                  <input
                    type='password'
                    value={bedrockSessionTokenInput}
                    placeholder='AWS session token (optional)'
                    onChange={e => setBedrockSessionTokenInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        void handleSaveBedrockCredentials()
                      }
                    }}
                    className={`w-full max-w-md ${settingsInputClass}`}
                  />
                  <Button
                    variant='outline2'
                    size='small'
                    onClick={handleSaveBedrockCredentials}
                    disabled={
                      bedrockCredentialsSaving ||
                      !bedrockRegionInput.trim() ||
                      !bedrockAccessKeyIdInput.trim() ||
                      !bedrockSecretAccessKeyInput.trim()
                    }
                  >
                    {bedrockCredentialsConfigured ? 'Replace credentials' : 'Save credentials'}
                  </Button>
                  <Button
                    variant='outline2'
                    size='small'
                    onClick={handleDeleteBedrockCredentials}
                    disabled={bedrockCredentialsSaving || !bedrockCredentialsConfigured}
                  >
                    Clear credentials
                  </Button>
                </div>
                <p className='text-xs text-stone-500 dark:text-stone-400'>
                  Stored credentials are saved as a JSON credential payload in the local provider token store for this user.
                </p>
              </div>

              
            </div>
          </SettingsSection>
        )}

        {import.meta.env.VITE_ENVIRONMENT === 'electron' && (
          <SettingsSection
            title='Memory'
            description='Build note embeddings for local memory search using your LM Studio embedding model. This does not run automatically.'
            features={['Manual indexing', 'Runtime memory files', 'Global memory', 'Project memory']}
          >
            <div className='flex flex-col gap-4'>
              <div className='rounded-[1.75rem] bg-white/55 px-4 py-3 text-sm text-stone-600 dark:bg-stone-800/40 dark:text-stone-300'>
                <p className='font-medium text-stone-800 dark:text-stone-100'>Manual memory indexing</p>
                <p className='mt-1'>
                  This sends note summaries to LM Studio using <code>text-embedding-nomic-embed-text-v1.5</code>, stores the returned vectors in the local sqlite-vec index, and marks indexed notes as ready for hybrid memory search.
                </p>
                <p className='mt-2 text-xs text-stone-500 dark:text-stone-400'>
                  Use this after changing note content, after enabling LM Studio embeddings, or when you want to refresh missing/stale memory vectors on demand.
                </p>
              </div>

              <div className='flex flex-wrap items-center gap-3'>
                <Button variant='primary' size='small' onClick={handleMemoryBackfill} disabled={memoryBackfillRunning}>
                  {memoryBackfillRunning ? 'Indexing Memory…' : 'Index Memory Notes'}
                </Button>
                <p className='text-xs text-stone-500 dark:text-stone-400'>
                  Uses the LM Studio server configured below. Nothing runs until you click the button.
                </p>
              </div>

              <div className='mt-2 flex flex-col gap-3'>
                <div className='flex flex-wrap items-center justify-between gap-3'>
                  <div>
                    <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Runtime memory files</p>
                    <p className='text-sm text-stone-500 dark:text-stone-400'>
                      View the markdown memory files currently used by local runtime hooks.
                    </p>
                  </div>
                  <Button variant='outline2' size='small' onClick={loadMemoryFiles} disabled={memoryFilesLoading}>
                    {memoryFilesLoading ? 'Refreshing…' : 'Refresh'}
                  </Button>
                </div>

                {memoryFilesError && (
                  <p className='rounded-[1.75rem] bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-900/30 dark:text-rose-200'>
                    {memoryFilesError}
                  </p>
                )}

                <div className='grid gap-3 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]'>
                  <div className='rounded-[1.75rem] bg-white/45 p-3 dark:bg-stone-800/25'>
                    <p className='px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400'>
                      Global
                    </p>
                    <div className='flex flex-col gap-2'>
                      {globalMemoryFiles.length > 0 ? (
                        globalMemoryFiles.map(renderMemoryFileButton)
                      ) : (
                        <p className='px-3 py-2 text-sm text-stone-500 dark:text-stone-400'>No global memory files found.</p>
                      )}
                    </div>
                  </div>

                  <div className='rounded-[1.75rem] bg-white/45 p-3 dark:bg-stone-800/25'>
                    <p className='px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400'>
                      Project memory
                    </p>
                    <div className='max-h-64 overflow-y-auto thin-scrollbar pr-1'>
                      <div className='flex flex-col gap-2'>
                        {projectMemoryFiles.length > 0 ? (
                          projectMemoryFiles.map(renderMemoryFileButton)
                        ) : (
                          <p className='px-3 py-2 text-sm text-stone-500 dark:text-stone-400'>
                            No project memory files found yet.
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </SettingsSection>
        )}

                {import.meta.env.VITE_ENVIRONMENT === 'electron' && (
          <SettingsSection
            title='Subagent'
            description={<>Configure default subagent behavior used by the <code>subagent</code> tool.</>}
            features={['Provider', 'Model', 'Max turns', 'Orchestrator tool calls']}
          >
            <div className='flex flex-col gap-4'>
              <div className='flex flex-col gap-2'>
                <div>
                  <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Subagent Provider</p>
                  <p className='text-sm text-stone-500 dark:text-stone-400'>
                    Provider used when a <code>subagent</code> tool call omits an explicit provider. Leave unset to
                    follow the current chat provider.
                  </p>
                </div>
                <Select
                  value={subagentSettings.defaultProvider || ''}
                  onChange={handleSubagentProviderChange}
                  options={[
                    { value: '', label: 'Follow current chat provider' },
                    ...providers.providers.map(p => ({ value: p.name, label: p.name })),
                  ]}
                  placeholder='Follow current chat provider'
                  disabled={providers.providers.length === 0}
                  className='max-w-xs'
                />
                {providers.providers.length === 0 && (
                  <p className='text-xs text-amber-600 dark:text-amber-400'>
                    No providers available. Open a chat first to load providers.
                  </p>
                )}
              </div>

              <div className='flex flex-col gap-2 pt-2 pt-2'>
                <div>
                  <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Subagent Model</p>
                  <p className='text-sm text-stone-500 dark:text-stone-400'>
                    Model used when a <code>subagent</code> tool call omits <code>model</code>. Leave unset to use the
                    selected/default model for the resolved provider.
                  </p>
                </div>
                <Select
                  value={selectedSubagentModelValue}
                  onChange={handleSubagentModelChange}
                  options={[
                    { value: '', label: 'Use provider selected/default model' },
                    ...((subagentModelsData?.models || []).map(model => ({
                      value:
                        normalizeSubagentModelName(model.id || model.name, subagentProviderForModels) ||
                        model.id ||
                        model.name,
                      label: model.displayName || model.name,
                    })) as any[]),
                  ]}
                  placeholder='Use provider selected/default model'
                  className='max-w-xl'
                />
                <p className='text-xs text-stone-500 dark:text-stone-400'>
                  Tool-call <code>model</code> arguments still override this setting. Current model list provider:{' '}
                  <code>{subagentProviderForModels}</code>.
                </p>
              </div>

              <div className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between pt-2 pt-2'>
                <div>
                  <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Subagent Max Turns</p>
                  <p className='text-sm text-stone-500 dark:text-stone-400'>
                    Maximum model/tool loop turns for one subagent invocation.
                  </p>
                </div>
                <input
                  type='number'
                  min={1}
                  step={1}
                  value={subagentMaxTurnsInput}
                  onChange={e => handleSubagentMaxTurnsInputChange(e.target.value)}
                  onBlur={e => commitSubagentMaxTurnsChange(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur()
                    }
                  }}
                  className={`w-32 ${settingsInputClass}`}
                />
              </div>

              <div className='flex items-center justify-between pt-2 pt-2'>
                <div>
                  <p className='text-base font-medium text-stone-900 dark:text-stone-100'>
                    Enable Orchestrator Tool Calls
                  </p>
                  <p className='text-sm text-stone-500 dark:text-stone-400'>
                    Controls whether subagents can execute tools at all.
                  </p>
                </div>
                <button
                  onClick={handleSubagentOrchestratorToggle}
                  className={settingsToggleClass(subagentSettings.orchestratorEnabled)}
                >
                  <span
                    className={settingsToggleKnobClass(subagentSettings.orchestratorEnabled)}
                  />
                </button>
              </div>

              <div className='flex flex-col gap-2 pt-2'>
                <div>
                  <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Subagent System Prompt</p>
                  <p className='text-sm text-stone-500 dark:text-stone-400'>
                    Base system prompt for every <code>subagent</code> tool invocation. A per-call <code>systemPrompt</code>{' '}
                    is appended after this prompt. {isSubagentModePromptOverridden ? 'Using a saved local override.' : 'Using the bundled default prompt.'}
                  </p>
                </div>
                <textarea
                  value={subagentModePromptInput}
                  onChange={e => setSubagentModePromptInput(e.target.value)}
                  rows={12}
                  className={`w-full ${settingsTextAreaClass}`}
                />
                <div className='flex flex-wrap gap-2'>
                  <Button onClick={handleSaveSubagentModePrompt}>Save Subagent Prompt</Button>
                  <Button variant='secondary' onClick={handleResetSubagentModePrompt}>
                    Reset to Default
                  </Button>
                </div>
              </div>

              <p className='text-xs text-stone-500 dark:text-stone-400 pt-2 pt-2'>
                Note: subagent turn/tool quota args and verbose return summary have been removed for a simpler output.
              </p>
            </div>
          </SettingsSection>
        )}

        {/* Tools Settings Section - Collapsible */}
        {import.meta.env.VITE_ENVIRONMENT === 'electron' && (
          <SettingsSection
            title='Tools Configuration'
            description='Enable or disable AI tools. Changes apply to all new conversations.'
            features={['Tool toggles', 'Tool call timeout', 'Bash timeout', 'Reload tools']}
          >
            <div>
              <div className='mb-3 space-y-3'>
                <div className='rounded-[1.75rem] bg-white/45 p-3 dark:bg-stone-800/30'>
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
                      className={`w-44 ${settingsInputClass}`}
                    />
                  </div>
                  <p className='mt-2 text-xs text-stone-500 dark:text-stone-400'>
                    Range: {MIN_TOOL_CALL_TIMEOUT_MS}ms to {MAX_TOOL_CALL_TIMEOUT_MS}ms.
                  </p>
                </div>

                <div className='rounded-[1.75rem] bg-white/45 p-3 dark:bg-stone-800/30'>
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
                      className={`w-44 ${settingsInputClass}`}
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
                  <RefreshCw size={16} strokeWidth={2.25} className={reloadingTools ? 'animate-spin' : ''} aria-hidden='true' />
                  {reloadingTools ? 'Reloading...' : 'Reload Tools'}
                </Button>
              </div>

              {/* Tools list */}
              <div className='space-y-2'>
                {tools.length === 0 ? (
                  <div className='rounded-[1.75rem] border border-dashed border-stone-200 bg-stone-50/80 p-6 text-center text-sm text-stone-500 dark:border-stone-700 dark:bg-zinc-900/60 dark:text-stone-400'>
                    No tools available. Reload to check for new tools.
                  </div>
                ) : (
                  tools.map(tool => (
                    <div
                      key={tool.name}
                      className={`flex items-center justify-between rounded-[1.75rem] p-4 ${
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
                            <span className='shrink-0 rounded-full bg-orange-100 px-2 py-0.5 text-xs text-orange-600 dark:bg-orange-900/40 dark:text-orange-300'>
                              Custom
                            </span>
                          )}
                        </div>
                        <p className='text-sm text-stone-500 dark:text-stone-400 truncate mt-0.5'>{tool.description}</p>
                      </div>
                      <button
                        onClick={() => handleToolToggle(tool.name, tool.enabled)}
                        disabled={updatingTools.has(tool.name)}
                        className={`${settingsToggleClass(tool.enabled)} ml-3 ${updatingTools.has(tool.name) ? 'cursor-wait opacity-50' : ''}`}
                      >
                        <span
                          className={settingsToggleKnobClass(tool.enabled)}
                        />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </SettingsSection>
        )}

        {/* HTML Tools Management Section - Collapsible */}
        {htmlRegistry && (
          <SettingsSection
            title='HTML Tools Cache'
            description='Manage cached HTML tool outputs. Remove problematic tools without rendering them.'
            features={['Cached outputs', 'Favorites', 'Hibernate/restore', 'Remove cache entries']}
          >
            <div>
              {/* Tools list */}
              <div className='space-y-2'>
                {htmlEntries.length === 0 ? (
                  <div className='rounded-[1.75rem] border border-dashed border-stone-200 bg-stone-50/80 p-6 text-center text-sm text-stone-500 dark:border-stone-700 dark:bg-zinc-900/60 dark:text-stone-400'>
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
                        className={`flex items-center justify-between rounded-[1.75rem] p-4 ${
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
                              <span className='shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-600 dark:bg-amber-900/40 dark:text-amber-300'>
                                ★ Favorite
                              </span>
                            )}
                            {isHibernated && (
                              <span className='shrink-0 rounded-full bg-stone-200 px-2 py-0.5 text-xs text-stone-600 dark:bg-stone-700 dark:text-stone-400'>
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
                            className={`${circularControlClass} ${
                              isFavorite
                                ? 'bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-400'
                                : ''
                            }`}
                            title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                          >
                            <Star size={18} strokeWidth={2.25} fill={isFavorite ? 'currentColor' : 'none'} aria-hidden='true' />
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
                            className={circularControlClass}
                            title={isHibernated ? 'Restore tool' : 'Hibernate tool'}
                          >
                            {isHibernated ? <Sun size={18} strokeWidth={2.25} aria-hidden='true' /> : <Moon size={18} strokeWidth={2.25} aria-hidden='true' />}
                          </button>
                          {/* Remove button */}
                          <button
                            onClick={() => {
                              htmlRegistry.removeEntry(entry.key)
                              showStatus({ type: 'info', text: 'Tool removed from cache.' })
                            }}
                            className={circularDangerControlClass}
                            title='Remove tool'
                          >
                            <Trash2 size={18} strokeWidth={2.25} aria-hidden='true' />
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
          </SettingsSection>
        )}

                {import.meta.env.VITE_ENVIRONMENT === 'electron' && (
          <SettingsSection
            title='API Keys'
            description='Store local tool credentials securely in your OS keychain via keytar.'
            features={['Brave Search key', 'Secure keychain storage', 'Save/remove credentials']}
          >
            <div className='flex flex-col gap-4'>
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
                  className={`w-full max-w-xl ${settingsInputClass}`}
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
          </SettingsSection>
        )}

        {import.meta.env.VITE_ENVIRONMENT === 'electron' && (
          <SettingsSection
            title='Built-in Browser'
            description='Control optional features for the Electron right-dock browser pane.'
            features={['Guest page DevTools', 'Browser pane setting']}
          >
            <div className='flex flex-col gap-4'>
              <div className='flex items-center justify-between'>
                <div>
                  <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Guest Page DevTools</p>
                  <p className='text-sm text-stone-500 dark:text-stone-400'>
                    Allow the built-in browser pane to open detached DevTools for the embedded page.
                  </p>
                </div>
                <button
                  onClick={handleBrowserGuestDevToolsToggle}
                  className={settingsToggleClass(browserSettings.guestDevToolsEnabled)}
                >
                  <span
                    className={settingsToggleKnobClass(browserSettings.guestDevToolsEnabled)}
                  />
                </button>
              </div>

              <div className='rounded-[1.75rem] bg-white/45 px-4 py-3 text-xs text-stone-600 dark:bg-zinc-900 dark:text-stone-300'>
                <p>
                  Current setting:{' '}
                  <code>{browserSettings.guestDevToolsEnabled ? 'enabled' : 'disabled'}</code>
                </p>
              </div>
            </div>
          </SettingsSection>
        )}

        {import.meta.env.VITE_ENVIRONMENT === 'electron' && (
          <SettingsSection
            title='Remote Mobile Access'
            description='Configure a LAN URL for your phone/tablet (same Wi-Fi), then open or scan the QR code.'
            features={['Remote server URL', 'Mobile URL actions', 'QR code', 'Detected local origin']}
          >
            <div className='grid gap-5 lg:grid-cols-[minmax(0,1fr)_240px]'>
              <div className='flex flex-col gap-3'>
                <div className='flex flex-col gap-2'>
                  <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Remote Server Base URL</p>
                  <input
                    type='url'
                    value={remoteBaseUrlInput}
                    placeholder='http://192.168.0.119:3002'
                    onChange={event => setRemoteBaseUrlInput(event.target.value)}
                    className={`w-full ${settingsInputClass}`}
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

                <div className='rounded-[1.75rem] bg-white/45 px-3 py-2 text-xs text-stone-600 dark:bg-stone-800/40 dark:text-stone-300 break-all'>
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
                    className='h-[220px] w-[220px] rounded-[1.75rem] bg-white p-3 dark:border-stone-700'
                  />
                ) : (
                  <div className='flex h-[220px] w-[220px] items-center justify-center rounded-[1.75rem] border border-dashed border-stone-300 text-xs text-stone-500 dark:border-stone-600 dark:text-stone-400'>
                    Enter or detect a URL to render QR
                  </div>
                )}
                <p className='text-[11px] text-stone-500 dark:text-stone-400'>
                  QR image is rendered via api.qrserver.com.
                </p>
              </div>
            </div>
          </SettingsSection>
        )}

        {import.meta.env.VITE_ENVIRONMENT === 'electron' && (
          <SettingsSection
            title='Local Ownership Migration'
            description='Manually move local project/conversation ownership from one user ID to another.'
            features={['Source user', 'Destination user', 'Refresh users', 'Migrate ownership']}
          >
            <div className='flex flex-col gap-4'>
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

              <div className='flex flex-wrap items-center gap-3 pt-2 pt-2'>
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
          </SettingsSection>
        )}

                <SettingsSection
          title='Typography'
          description='Set app font from a Google Fonts URL or a local font file.'
          features={['Google Fonts URL', 'Local font upload', 'Use local font', 'Reset app font']}
        >
          <div className='flex flex-col gap-5'>
            <div className='flex flex-col gap-2'>
              <p className='text-base font-medium text-stone-900 dark:text-stone-100'>Google Fonts URL</p>
              <p className='text-sm text-stone-500 dark:text-stone-400'>
                Only <code>https://fonts.googleapis.com/css</code> and <code>/css2</code> links are accepted.
              </p>
              <input
                type='url'
                value={googleFontUrlInput}
                onChange={event => setGoogleFontUrlInput(event.target.value)}
                placeholder={DEFAULT_GOOGLE_FONT_URL}
                className={`w-full ${settingsInputClass}`}
              />
              <div className='flex flex-wrap items-center gap-2'>
                <Button variant='primary' size='small' onClick={handleGoogleFontUrlApply}>
                  Apply Google Font
                </Button>
                <Button variant='outline2' size='small' onClick={handleResetAppFont}>
                  Reset to {DEFAULT_GOOGLE_FONT_FAMILY}
                </Button>
              </div>
            </div>

            <div className='pt-3 pt-2 flex flex-col gap-2'>
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
        </SettingsSection>

        <SettingsSection
          title='Custom Upload'
          description='Drag in an MP4 or WebM and keep it ready for motion wallpapers.'
          features={['MP4/WebM upload', '8MB limit', 'Wallpaper gallery']}
        >
          <div className='flex flex-col gap-4 lg:flex-row lg:items-center'>
            <div className='flex-1 space-y-1 py-2'>
              <p className='text-sm mb-4 text-stone-500 dark:text-stone-200'>
                Accepted formats: MP4, WebM · Max size 8MB.
              </p>
              <div className='rounded-[1.75rem] bg-white/45 p-4 text-sm text-stone-500 dark:bg-zinc-800/60 dark:text-stone-200'>
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
                className='group'
              >
                <p className='transition-transform duration-100 group-active:scale-95'>
                  {uploading ? 'Processing…' : 'Browse for video'}
                </p>
              </Button>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          title='Solid Color Background'
          description='Pick colors for light and dark themes.'
          features={['Video/solid mode', 'Light color', 'Dark color', 'Transparent option']}
          style={{ backgroundColor: customThemeEnabled ? settingsSolidColorSectionBackground : undefined }}
        >
          <div className='flex flex-wrap justify-end gap-2'>
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
                  className='rounded-[1.75rem] bg-white/45 p-4 transition dark:bg-zinc-900/70'
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
            Solid colors automatically switch with the theme, and you can still set either theme to transparent if you
            want. When you’re ready for motion, switch back to video wallpapers.
          </p>
        </SettingsSection>

        <SettingsSection
          title='Saved Wallpapers'
          description='Select or delete any saved clip.'
          features={['Wallpaper selection', 'Text color mode', 'Reset default', 'Clear gallery']}
        >
          <div className='flex flex-wrap justify-end gap-2'>
            <Button variant='outline2' size='small' onClick={handleResetToDefault} className='group'>
              <p className='transition-transform duration-100 group-active:scale-95'>Reset to Default</p>
            </Button>
            <Button variant='outline2' size='small' onClick={handleClearGallery} className='group'>
              <p className='transition-transform duration-100 group-active:scale-95'>Clear Gallery</p>
            </Button>
          </div>

          <div className='mt-5 grid gap-4 md:grid-cols-2'>
            {videos.length === 0 ? (
              <div className='col-span-full rounded-[1.75rem] border border-dashed border-stone-200 bg-stone-50/80 p-6 text-center text-sm text-stone-500 dark:border-stone-700 dark:bg-zinc-900/60 dark:text-stone-400'>
                No saved wallpapers yet. Upload a video to get started.
              </div>
            ) : (
              videos.map(video => {
                const isActive = video.id === activeVideoId
                return (
                  <div
                    key={video.id}
                    className={`flex flex-col gap-3 rounded-[1.75rem] p-4 transition ${
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
                              className={`rounded-full px-3 py-1.5 text-xs transition-colors ${
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
        </SettingsSection>

        {false && (
          <section className={settingsSectionClass}>
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

{openaiLoginModalOpen && (
          <div
            className='fixed inset-0 z-[100] flex items-center justify-center bg-black/50 px-4'
            onClick={closeOpenaiLoginModal}
          >
            <div
              className='w-full max-w-md rounded-[2.5rem] bg-white/90 p-6 backdrop-blur-xl dark:bg-zinc-900/95'
              onClick={e => e.stopPropagation()}
            >
              <h3 className='mb-2 text-[20px] font-semibold text-stone-900 dark:text-stone-100'>Sign in to OpenAI</h3>
              <p className='mb-4 text-[14px] text-stone-600 dark:text-stone-300'>
                Use your ChatGPT Plus or Pro subscription to access GPT-4o and GPT-5 models locally.
              </p>

              <div className='space-y-4'>
                {openaiAuthError && (
                  <div className='flex items-center gap-2 rounded-lg bg-red-50 p-3 dark:bg-red-900/20'>
                    <i className='bx bx-error-circle text-xl text-red-600 dark:text-red-400'></i>
                    <span className='text-sm text-red-700 dark:text-red-300'>{openaiAuthError}</span>
                  </div>
                )}

                <div className='rounded-2xl bg-emerald-50 p-3 dark:bg-emerald-900/20'>
                  <div className='flex items-center gap-2 text-sm text-emerald-800 dark:text-emerald-200'>
                    {(openaiAuthPolling || openaiAuthLoading) && (
                      <i className='bx bx-loader-alt animate-spin text-lg text-emerald-600 dark:text-emerald-300'></i>
                    )}
                    <span>
                      Complete the sign-in in your browser. Ygg Chat will finish automatically when OAuth completes.
                    </span>
                  </div>
                </div>

                <div className='flex justify-end gap-2'>
                  <Button variant='outline2' onClick={closeOpenaiLoginModal}>
                    Cancel
                  </Button>
                  <Button
                    variant='outline2'
                    className='border-neutral-700 bg-neutral-800 text-white hover:bg-neutral-900 active:scale-98'
                    onClick={handleOpenaiLogin}
                  >
                    Open Browser Again
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default Settings
