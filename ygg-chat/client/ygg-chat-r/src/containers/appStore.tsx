import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { isCommunityMode } from '../config/runtimeMode'
import { reloadCustomTools } from '../features/chats/chatActions'
import { useAppDispatch } from '../hooks/redux'
import {
  AppStoreApp,
  AppStoreDescription,
  CommunityAppUploadValidation,
  fetchAppStoreApps,
  fetchInstalledCustomTools,
  fetchPublicAppStoreApps,
  installAppFromStore,
  restartDesktopApp,
  uploadCommunityApp,
  uninstallAppFromStore,
  validateCommunityAppUpload,
} from '../services/appStore'
import { environment } from '../utils/api'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../components/ThemeManager/themeConfig'

type AppStoreModalProps = {
  open: boolean
  onClose: () => void
}

type AppActionStatus = {
  type: 'idle' | 'working' | 'success' | 'error'
  message: string
  restartRequired?: boolean
}

type AppActionState = {
  appId: string
  type: 'install' | 'update' | 'uninstall'
}

type StoreTab = 'first-party' | 'community'

type UploadStatus = {
  type: 'idle' | 'validating' | 'ready' | 'uploading' | 'success' | 'error'
  message: string
}

type AppUpdateInfo = {
  appId: string
  installedId: string
  installedVersion: string
  availableVersion: string
}

const formatSize = (size?: number | string) => {
  if (!size) return 'n/a'
  if (typeof size === 'string') return size
  if (size < 1024) return `${size.toFixed(0)} bytes`
  const kilo = size / 1024
  if (kilo < 1024) return `${kilo.toFixed(1)} KB`
  return `${(kilo / 1024).toFixed(1)} MB`
}

const getAppSummary = (description?: AppStoreDescription) => {
  if (!description) return 'No description available yet.'
  return description.shortDescription || description.description || 'No description available yet.'
}

const getAppDisplayName = (app: AppStoreApp) => app.description.title || app.description.name || app.name || app.id

const normalizeToolId = (value: string) => value.trim().toLowerCase().replace(/[\s-]+/g, '_')

const parseVersionNumbers = (value: string): number[] => {
  const normalized = value.trim().replace(/^v/i, '')
  if (!normalized) return []
  return normalized.split('.').map(segment => {
    const match = segment.match(/^\d+/)
    return match ? parseInt(match[0], 10) : 0
  })
}

const compareVersions = (left: string, right: string): number => {
  const leftParts = parseVersionNumbers(left)
  const rightParts = parseVersionNumbers(right)
  const maxLength = Math.max(leftParts.length, rightParts.length)

  for (let idx = 0; idx < maxLength; idx += 1) {
    const leftPart = leftParts[idx] ?? 0
    const rightPart = rightParts[idx] ?? 0
    if (leftPart > rightPart) return 1
    if (leftPart < rightPart) return -1
  }

  return 0
}

const isVersionNewer = (candidate: string, baseline: string) => compareVersions(candidate, baseline) > 0

const collectInstalledToolIndex = (tools: Array<{ name?: string; sourcePath?: string; version?: string }>) => {
  const ids = new Set<string>()
  const map: Record<string, string> = {}
  const versions: Record<string, string> = {}

  const register = (value: string, version?: string, prefer = false) => {
    const normalized = normalizeToolId(value)
    ids.add(normalized)
    if (prefer || !map[normalized]) {
      map[normalized] = value
    }
    if (version && (prefer || !versions[normalized])) {
      versions[normalized] = version
    }
  }

  tools.forEach(tool => {
    if (tool.sourcePath) {
      const parts = tool.sourcePath.split(/[/\\]/)
      const dirName = parts[parts.length - 1]
      if (dirName) {
        register(dirName, tool.version, true)
      }
    }
    if (tool.name) {
      register(tool.name, tool.version)
    }
  })

  return { ids, map, versions }
}

export const AppStoreModal: React.FC<AppStoreModalProps> = ({ open, onClose }) => {
  const isElectron = environment === 'electron'
  const { theme: customTheme, enabled: customThemeEnabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()
  const navigate = useNavigate()
  const uploadRequiresCloudLogin = isCommunityMode
  const dispatch = useAppDispatch()
  const [storeTab, setStoreTab] = useState<StoreTab>('first-party')
  const [firstPartyApps, setFirstPartyApps] = useState<AppStoreApp[]>([])
  const [communityApps, setCommunityApps] = useState<AppStoreApp[]>([])
  const [selectedAppIds, setSelectedAppIds] = useState<Record<StoreTab, string | null>>({
    'first-party': null,
    community: null,
  })
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list')
  const [firstPartyLoading, setFirstPartyLoading] = useState(false)
  const [firstPartyError, setFirstPartyError] = useState<string | null>(null)
  const [communityLoading, setCommunityLoading] = useState(false)
  const [communityError, setCommunityError] = useState<string | null>(null)
  const [installedToolIds, setInstalledToolIds] = useState<Set<string>>(new Set())
  const [installedToolIndex, setInstalledToolIndex] = useState<Record<string, string>>({})
  const [installedToolVersions, setInstalledToolVersions] = useState<Record<string, string>>({})
  const [installedLoading, setInstalledLoading] = useState(false)
  const [installedError, setInstalledError] = useState<string | null>(null)
  const [actionState, setActionState] = useState<AppActionState | null>(null)
  const [actionStatus, setActionStatus] = useState<AppActionStatus | null>(null)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadValidation, setUploadValidation] = useState<CommunityAppUploadValidation | null>(null)
  const [uploadStatus, setUploadStatus] = useState<UploadStatus | null>(null)
  const uploadInputRef = useRef<HTMLInputElement | null>(null)

  const activeApps = useMemo(
    () => (storeTab === 'first-party' ? firstPartyApps : communityApps),
    [communityApps, firstPartyApps, storeTab]
  )

  const selectedAppId = selectedAppIds[storeTab]

  const selectedApp = useMemo(() => {
    if (!activeApps.length) return null
    const found = activeApps.find(app => app.id === selectedAppId)
    return found || activeApps[0]
  }, [activeApps, selectedAppId])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    let cancelled = false

    setActionStatus(null)

    const loadFirstParty = async () => {
      setFirstPartyLoading(true)
      setFirstPartyError(null)
      try {
        const data = await fetchAppStoreApps()
        if (!cancelled) {
          setFirstPartyApps(data)
        }
      } catch (err) {
        if (!cancelled) {
          setFirstPartyError(err instanceof Error ? err.message : 'Failed to load apps')
        }
      } finally {
        if (!cancelled) {
          setFirstPartyLoading(false)
        }
      }
    }

    const loadCommunity = async () => {
      setCommunityLoading(true)
      setCommunityError(null)
      try {
        const data = await fetchPublicAppStoreApps()
        if (!cancelled) {
          setCommunityApps(data)
        }
      } catch (err) {
        if (!cancelled) {
          setCommunityError(err instanceof Error ? err.message : 'Failed to load community apps')
        }
      } finally {
        if (!cancelled) {
          setCommunityLoading(false)
        }
      }
    }

    void loadFirstParty()
    void loadCommunity()

    return () => {
      cancelled = true
    }
  }, [open])

  const reloadInstalledTools = useCallback(async () => {
    if (!isElectron) {
      setInstalledToolIds(new Set())
      setInstalledToolIndex({})
      setInstalledToolVersions({})
      setInstalledLoading(false)
      setInstalledError(null)
      return
    }

    setInstalledLoading(true)
    setInstalledError(null)

    try {
      const tools = await fetchInstalledCustomTools()
      const { ids, map, versions } = collectInstalledToolIndex(tools)
      setInstalledToolIds(ids)
      setInstalledToolIndex(map)
      setInstalledToolVersions(versions)
    } catch (err) {
      setInstalledError(err instanceof Error ? err.message : 'Failed to load installed tools')
    } finally {
      setInstalledLoading(false)
    }
  }, [isElectron])

  const reloadCommunityApps = useCallback(async () => {
    setCommunityLoading(true)
    setCommunityError(null)
    try {
      const data = await fetchPublicAppStoreApps()
      setCommunityApps(data)
    } catch (err) {
      setCommunityError(err instanceof Error ? err.message : 'Failed to load community apps')
    } finally {
      setCommunityLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void reloadInstalledTools()
  }, [open, reloadInstalledTools])

  useEffect(() => {
    if (!open) return
    const list = storeTab === 'first-party' ? firstPartyApps : communityApps
    setSelectedAppIds(prev => {
      const current = prev[storeTab]
      if (current && list.some(app => app.id === current)) {
        return prev
      }
      return { ...prev, [storeTab]: list[0]?.id || null }
    })
  }, [communityApps, firstPartyApps, open, storeTab])

  const handleSelectApp = useCallback(
    (appId: string) => {
      setSelectedAppIds(prev => ({ ...prev, [storeTab]: appId }))
    },
    [storeTab]
  )

  const resolveInstalledAppInfo = useCallback(
    (app: AppStoreApp) => {
      const candidates = [app.id, app.description.name, app.name].filter(Boolean) as string[]
      for (const candidate of candidates) {
        const normalized = normalizeToolId(candidate)
        const installedId = installedToolIndex[normalized]
        const installedVersion = installedToolVersions[normalized]
        if (installedId || installedToolIds.has(normalized)) {
          return {
            normalized,
            installedId: installedId || candidate,
            installedVersion,
          }
        }
      }
      return null
    },
    [installedToolIds, installedToolIndex, installedToolVersions]
  )

  const isAppInstalled = useCallback(
    (app: AppStoreApp) => Boolean(resolveInstalledAppInfo(app)),
    [resolveInstalledAppInfo]
  )

  const resolveInstalledAppId = useCallback(
    (app: AppStoreApp) => resolveInstalledAppInfo(app)?.installedId || app.id,
    [resolveInstalledAppInfo]
  )

  const getAppUpdateInfo = useCallback(
    (app: AppStoreApp): AppUpdateInfo | null => {
      const installed = resolveInstalledAppInfo(app)
      if (!installed?.installedVersion || !app.description.version) {
        return null
      }

      if (!isVersionNewer(app.description.version, installed.installedVersion)) {
        return null
      }

      return {
        appId: app.id,
        installedId: installed.installedId,
        installedVersion: installed.installedVersion,
        availableVersion: app.description.version,
      }
    },
    [resolveInstalledAppInfo]
  )

  const activeTabUpdates = useMemo(
    () => activeApps.map(app => ({ app, update: getAppUpdateInfo(app) })).filter(item => Boolean(item.update)),
    [activeApps, getAppUpdateInfo]
  )

  const handleInstall = useCallback(
    async (targetApp?: AppStoreApp, mode: 'install' | 'update' = 'install') => {
      const app = targetApp || selectedApp
      if (!app || !app.zipUrl) {
        setActionStatus({
          type: 'error',
          message: 'No download available for this app yet.',
        })
        return
      }

      if (!isElectron) {
        setActionStatus({
          type: 'error',
          message: 'App installs are only available in the desktop app.',
        })
        return
      }

      const resolvedInstallTarget = mode === 'update' ? resolveInstalledAppId(app) : app.id
      const actionType = mode === 'update' ? 'update' : 'install'
      setActionState({ appId: app.id, type: actionType })
      setActionStatus({
        type: 'working',
        message: mode === 'update' ? 'Downloading and applying update...' : 'Downloading and installing app...',
      })

      try {
        const result = await installAppFromStore({
          appId: resolvedInstallTarget,
          appName: app.name,
          zipUrl: app.zipUrl,
          mode,
        })

        if (!result.success) {
          throw new Error(result.error || `${mode === 'update' ? 'Update' : 'Install'} failed`)
        }

        setActionStatus({
          type: 'success',
          message:
            result.message ||
            (mode === 'update'
              ? 'Updated successfully. Existing resources were preserved.'
              : 'Installed successfully. Restart recommended.'),
          restartRequired: result.restartRequired ?? false,
        })
        await reloadInstalledTools()
        await dispatch(reloadCustomTools())
      } catch (err) {
        setActionStatus({
          type: 'error',
          message: err instanceof Error ? err.message : `${mode === 'update' ? 'Update' : 'Install'} failed`,
        })
      } finally {
        setActionState(null)
      }
    },
    [dispatch, isElectron, reloadInstalledTools, resolveInstalledAppId, selectedApp]
  )

  const handleUninstall = useCallback(async () => {
    if (!selectedApp) {
      return
    }

    if (!isElectron) {
      setActionStatus({
        type: 'error',
        message: 'App uninstalls are only available in the desktop app.',
      })
      return
    }

    setActionState({ appId: selectedApp.id, type: 'uninstall' })
    setActionStatus({ type: 'working', message: 'Uninstalling app...' })

    try {
      const targetAppId = resolveInstalledAppId(selectedApp)
      const result = await uninstallAppFromStore({ appId: targetAppId })

      if (!result.success) {
        throw new Error(result.error || 'Uninstall failed')
      }

      setActionStatus({
        type: 'success',
        message: result.message || 'Uninstalled successfully.',
        restartRequired: result.restartRequired ?? false,
      })
      await reloadInstalledTools()
      await dispatch(reloadCustomTools())
    } catch (err) {
      setActionStatus({
        type: 'error',
        message: err instanceof Error ? err.message : 'Uninstall failed',
      })
    } finally {
      setActionState(null)
    }
  }, [dispatch, isElectron, reloadInstalledTools, resolveInstalledAppId, selectedApp])

  const handleRestart = useCallback(async () => {
    const result = await restartDesktopApp()
    if (!result.success) {
      setActionStatus({
        type: 'error',
        message: result.error || 'Failed to restart app.',
      })
    }
  }, [])

  const resetUploadState = useCallback(() => {
    setUploadFile(null)
    setUploadValidation(null)
    if (uploadInputRef.current) {
      uploadInputRef.current.value = ''
    }
  }, [])

  const handleUploadLoginRequired = useCallback(() => {
    navigate('/login?required=cloud')
  }, [navigate])

  const handleUploadFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] || null
      setUploadStatus(null)
      setUploadValidation(null)
      setUploadFile(file)

      if (!file) {
        return
      }

      if (!isElectron) {
        setUploadStatus({
          type: 'error',
          message: 'Uploads are only available in the desktop app.',
        })
        return
      }

      if (!file.name.toLowerCase().endsWith('.zip')) {
        setUploadStatus({
          type: 'error',
          message: 'Please choose a .zip file.',
        })
        return
      }

      setUploadStatus({ type: 'validating', message: 'Validating zip contents...' })

      try {
        const validation = await validateCommunityAppUpload(file)
        setUploadValidation(validation)
        setUploadStatus({ type: 'ready', message: 'Zip validated. Ready to upload.' })
      } catch (err) {
        setUploadStatus({
          type: 'error',
          message: err instanceof Error ? err.message : 'Failed to validate zip',
        })
      }
    },
    [isElectron]
  )

  const handleUploadSubmit = useCallback(async () => {
    if (uploadRequiresCloudLogin) {
      setUploadStatus({
        type: 'error',
        message: 'You must be signed in to upload apps.',
      })
      handleUploadLoginRequired()
      return
    }

    if (!uploadFile || !uploadValidation) {
      setUploadStatus({
        type: 'error',
        message: 'Select a zip file and validate it before uploading.',
      })
      return
    }

    setUploadStatus({ type: 'uploading', message: 'Uploading to community store...' })

    try {
      await uploadCommunityApp(uploadFile)
      setUploadStatus({ type: 'success', message: 'Uploaded successfully. Your app is now live.' })
      resetUploadState()
      await reloadCommunityApps()
    } catch (err) {
      setUploadStatus({
        type: 'error',
        message: err instanceof Error ? err.message : 'Upload failed',
      })
    }
  }, [handleUploadLoginRequired, reloadCommunityApps, resetUploadState, uploadFile, uploadValidation, uploadRequiresCloudLogin])

  useEffect(() => {
    if (!open) {
      setActionState(null)
      setActionStatus(null)
      setUploadStatus(null)
      resetUploadState()
    }
  }, [open, resetUploadState])

  const selectedAppInstalled = useMemo(() => {
    if (!selectedApp) return false
    return isAppInstalled(selectedApp)
  }, [isAppInstalled, selectedApp])

  const selectedAppUpdateInfo = useMemo(() => {
    if (!selectedApp) return null
    return getAppUpdateInfo(selectedApp)
  }, [getAppUpdateInfo, selectedApp])

  const selectedAppHasUpdate = Boolean(selectedAppUpdateInfo)

  const isActionInProgress = selectedApp ? actionState?.appId === selectedApp.id : false
  const isInstalling = isActionInProgress && actionState?.type === 'install'
  const isUpdating = isActionInProgress && actionState?.type === 'update'
  const isUninstalling = isActionInProgress && actionState?.type === 'uninstall'
  const activeLoading = storeTab === 'first-party' ? firstPartyLoading : communityLoading
  const activeError = storeTab === 'first-party' ? firstPartyError : communityError

  const themedAppStoreStyles = customThemeEnabled
    ? {
        backdrop: getThemeModeColor(customTheme.colors.authModalBackdrop, isDarkMode),
        modalBg: getThemeModeColor(customTheme.colors.settingsPaneBodyBg, isDarkMode),
        modalBorder: getThemeModeColor(customTheme.colors.settingsCustomThemesCardBorder, isDarkMode),
        titleText: getThemeModeColor(customTheme.colors.settingsCustomThemesTitleText, isDarkMode),
        bodyText: getThemeModeColor(customTheme.colors.settingsCustomThemesBodyText, isDarkMode),
        panelBg: getThemeModeColor(customTheme.colors.settingsCustomThemesCardBg, isDarkMode),
        panelBorder: getThemeModeColor(customTheme.colors.settingsCustomThemesCardBorder, isDarkMode),
        innerPanelBg: getThemeModeColor(customTheme.colors.settingsCustomThemesInnerCardBg, isDarkMode),
        innerPanelBorder: getThemeModeColor(customTheme.colors.settingsCustomThemesInnerCardBorder, isDarkMode),
        badgeBg: getThemeModeColor(customTheme.colors.settingsCustomThemesBadgeBg, isDarkMode),
        badgeText: getThemeModeColor(customTheme.colors.settingsCustomThemesBadgeText, isDarkMode),
        codeBg: getThemeModeColor(customTheme.colors.settingsCustomThemesCodeBg, isDarkMode),
        codeText: getThemeModeColor(customTheme.colors.settingsCustomThemesCodeText, isDarkMode),
        buttonBg: getThemeModeColor(customTheme.colors.settingsCustomThemesButtonBg, isDarkMode),
        buttonBorder: getThemeModeColor(customTheme.colors.settingsCustomThemesButtonBorder, isDarkMode),
        buttonText: getThemeModeColor(customTheme.colors.settingsCustomThemesButtonText, isDarkMode),
        primaryButtonBg: getThemeModeColor(customTheme.colors.settingsCustomThemesPrimaryButtonBg, isDarkMode),
        primaryButtonText: getThemeModeColor(customTheme.colors.settingsCustomThemesPrimaryButtonText, isDarkMode),
        tabActiveBg: getThemeModeColor(customTheme.colors.composerToggleActiveBg, isDarkMode),
        tabActiveBorder: getThemeModeColor(customTheme.colors.composerToggleActiveBorder, isDarkMode),
        tabActiveText: getThemeModeColor(customTheme.colors.composerToggleActiveText, isDarkMode),
        emptyStateBg: getThemeModeColor(customTheme.colors.settingsCustomThemesEmptyStateBg, isDarkMode),
        emptyStateBorder: getThemeModeColor(customTheme.colors.settingsCustomThemesEmptyStateBorder, isDarkMode),
        selectedCardBg: getThemeModeColor(customTheme.colors.ideContextPillBg, isDarkMode),
        selectedCardBorder: getThemeModeColor(customTheme.colors.ideContextPillBorder, isDarkMode),
        selectedCardText: getThemeModeColor(customTheme.colors.ideContextPillText, isDarkMode),
        listBg: getThemeModeColor(customTheme.colors.settingsCustomThemesListBg, isDarkMode),
        listBorder: getThemeModeColor(customTheme.colors.settingsCustomThemesListBorder, isDarkMode),
        listItemTitleText: getThemeModeColor(customTheme.colors.settingsCustomThemesListItemTitleText, isDarkMode),
        listItemMetaText: getThemeModeColor(customTheme.colors.settingsCustomThemesListItemMetaText, isDarkMode),
        errorBg: getThemeModeColor(customTheme.colors.toolJobsErrorBg, isDarkMode),
        errorBorder: getThemeModeColor(customTheme.colors.toolJobsErrorBorder, isDarkMode),
        errorText: getThemeModeColor(customTheme.colors.toolJobsErrorText, isDarkMode),
        successBg: getThemeModeColor(customTheme.colors.toolJobsStatusCompletedBg, isDarkMode),
        successText: getThemeModeColor(customTheme.colors.toolJobsStatusCompletedText, isDarkMode),
        warningBg: getThemeModeColor(customTheme.colors.toolJobsStatusPendingBg, isDarkMode),
        warningText: getThemeModeColor(customTheme.colors.toolJobsStatusPendingText, isDarkMode),
        infoBg: getThemeModeColor(customTheme.colors.toolJobsStatusRunningBg, isDarkMode),
        infoText: getThemeModeColor(customTheme.colors.toolJobsStatusRunningText, isDarkMode),
        linkText: getThemeModeColor(customTheme.colors.toolPermissionDialogToolNameText, isDarkMode),
        primaryText: getThemeModeColor(customTheme.colors.toolJobsPrimaryText, isDarkMode),
        secondaryText: getThemeModeColor(customTheme.colors.toolJobsSecondaryText, isDarkMode),
        mutedText: getThemeModeColor(customTheme.colors.toolJobsMutedText, isDarkMode),
        primaryButtonBorder: getThemeModeColor(customTheme.colors.authModalPrimaryButtonBorder, isDarkMode),
        secondaryButtonBg: getThemeModeColor(customTheme.colors.authModalSecondaryButtonBg, isDarkMode),
        secondaryButtonBorder: getThemeModeColor(customTheme.colors.authModalSecondaryButtonBorder, isDarkMode),
        secondaryButtonText: getThemeModeColor(customTheme.colors.authModalSecondaryButtonText, isDarkMode),
        dangerButtonBg: getThemeModeColor(customTheme.colors.authModalDangerButtonBg, isDarkMode),
        dangerButtonBorder: getThemeModeColor(customTheme.colors.authModalDangerButtonBorder, isDarkMode),
        dangerButtonText: getThemeModeColor(customTheme.colors.authModalDangerButtonText, isDarkMode),
      }
    : null

  if (!open) return null

  return (
    <div className='fixed inset-0 z-[60] flex items-center justify-center'>
      <div
        className='fixed inset-0 z-[60] bg-neutral-300/50 dark:bg-neutral-900/20 bg-opacity-50 backdrop-blur-sm'
        onClick={onClose}
        style={themedAppStoreStyles ? { backgroundColor: themedAppStoreStyles.backdrop } : undefined}
      />

      <div className='py-2 w-full max-w-6xl'>
        <div
          className='relative z-[70] mx-4 rounded-3xl px-8 lg:px-10 py-4 lg:py-6 dark:border-1 dark:border-neutral-900 bg-neutral-100 dark:bg-yBlack-900 shadow-lg overflow-y-scroll no-scrollbar transition-all duration-300 ease-in-out h-[80vh]'
          onClick={e => e.stopPropagation()}
          style={{
            scrollbarGutter: 'stable',
            ...(themedAppStoreStyles
              ? {
                  backgroundColor: themedAppStoreStyles.modalBg,
                  borderColor: themedAppStoreStyles.modalBorder,
                }
              : {}),
          }}
        >
          <div className='flex flex-wrap items-center justify-between gap-4 mb-3 py-4'>
            <div>
              <h2
                className='text-2xl font-semibold text-stone-800 dark:text-stone-200'
                style={themedAppStoreStyles ? { color: themedAppStoreStyles.titleText } : undefined}
              >
                App Store
              </h2>
              <p
                className='text-sm text-neutral-500 dark:text-neutral-400'
                style={themedAppStoreStyles ? { color: themedAppStoreStyles.bodyText } : undefined}
              >
                {storeTab === 'first-party'
                  ? 'Browse and install first-party tools.'
                  : 'Explore community apps shared by other creators.'}
              </p>
              <div
                className='mt-3 inline-flex items-center gap-1 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white/70 dark:bg-neutral-900/60 p-1'
                style={
                  themedAppStoreStyles
                    ? {
                        backgroundColor: themedAppStoreStyles.innerPanelBg,
                        borderColor: themedAppStoreStyles.innerPanelBorder,
                      }
                    : undefined
                }
              >
                <button
                  onClick={() => setStoreTab('first-party')}
                  className={`px-3 py-1 rounded-md text-xs font-semibold uppercase tracking-wide transition-colors ${
                    storeTab === 'first-party'
                      ? 'bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100'
                      : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200'
                  }`}
                  style={
                    themedAppStoreStyles
                      ? storeTab === 'first-party'
                        ? {
                            backgroundColor: themedAppStoreStyles.tabActiveBg,
                            borderColor: themedAppStoreStyles.tabActiveBorder,
                            color: themedAppStoreStyles.tabActiveText,
                          }
                        : { color: themedAppStoreStyles.bodyText }
                      : undefined
                  }
                >
                  First-party
                </button>
                <button
                  onClick={() => setStoreTab('community')}
                  className={`px-3 py-1 rounded-md text-xs font-semibold uppercase tracking-wide transition-colors ${
                    storeTab === 'community'
                      ? 'bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100'
                      : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200'
                  }`}
                  style={
                    themedAppStoreStyles
                      ? storeTab === 'community'
                        ? {
                            backgroundColor: themedAppStoreStyles.tabActiveBg,
                            borderColor: themedAppStoreStyles.tabActiveBorder,
                            color: themedAppStoreStyles.tabActiveText,
                          }
                        : { color: themedAppStoreStyles.bodyText }
                      : undefined
                  }
                >
                  Community
                </button>
              </div>
            </div>
            <div className='flex items-center gap-2'>
              <div
                className='flex items-center gap-1 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white/70 dark:bg-neutral-900/60 p-1'
                style={
                  themedAppStoreStyles
                    ? {
                        backgroundColor: themedAppStoreStyles.innerPanelBg,
                        borderColor: themedAppStoreStyles.innerPanelBorder,
                      }
                    : undefined
                }
              >
                <button
                  onClick={() => setViewMode('grid')}
                  className={`px-2 py-1 rounded-md text-sm transition-colors ${
                    viewMode === 'grid'
                      ? 'bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100'
                      : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200'
                  }`}
                  style={
                    themedAppStoreStyles
                      ? viewMode === 'grid'
                        ? {
                            backgroundColor: themedAppStoreStyles.tabActiveBg,
                            borderColor: themedAppStoreStyles.tabActiveBorder,
                            color: themedAppStoreStyles.tabActiveText,
                          }
                        : { color: themedAppStoreStyles.bodyText }
                      : undefined
                  }
                  aria-label='Grid view'
                >
                  <i className='bx bxs-grid-alt text-lg'></i>
                </button>
                <button
                  onClick={() => setViewMode('list')}
                  className={`px-2 py-1 rounded-md text-sm transition-colors ${
                    viewMode === 'list'
                      ? 'bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100'
                      : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200'
                  }`}
                  style={
                    themedAppStoreStyles
                      ? viewMode === 'list'
                        ? {
                            backgroundColor: themedAppStoreStyles.tabActiveBg,
                            borderColor: themedAppStoreStyles.tabActiveBorder,
                            color: themedAppStoreStyles.tabActiveText,
                          }
                        : { color: themedAppStoreStyles.bodyText }
                      : undefined
                  }
                  aria-label='List view'
                >
                  <i className='bx bx-list-ul text-lg'></i>
                </button>
              </div>
              <button
                onClick={onClose}
                className='p-1 rounded-md transition-colors'
                aria-label='Close app store'
                style={themedAppStoreStyles ? { color: themedAppStoreStyles.bodyText } : undefined}
              >
                <i className='bx bx-x text-2xl text-gray-600 dark:text-gray-400 active:scale-95'></i>
              </button>
            </div>
          </div>

          <div className='grid grid-cols-1 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] gap-6'>
            <div className='flex flex-col gap-4 min-h-0'>
              {!isElectron && (
                <div className='rounded-xl border border-amber-200/70 bg-amber-50/70 px-4 py-3 text-sm text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'>
                  App installs are available in the desktop app. You can still browse the catalog here.
                </div>
              )}

              {storeTab === 'community' && (
                <div
                  className='rounded-xl border border-neutral-200/70 bg-white/70 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-300'
                  style={
                    themedAppStoreStyles
                      ? {
                          backgroundColor: themedAppStoreStyles.panelBg,
                          borderColor: themedAppStoreStyles.panelBorder,
                          color: themedAppStoreStyles.bodyText,
                        }
                      : undefined
                  }
                >
                  Community apps are user-submitted and not reviewed. Install only what you trust.
                </div>
              )}

              {storeTab === 'community' && (
                <div
                  className='rounded-2xl border border-neutral-200/70 dark:border-neutral-700 bg-white/70 dark:bg-neutral-900/60 p-4 space-y-3'
                  style={
                    themedAppStoreStyles
                      ? {
                          backgroundColor: themedAppStoreStyles.panelBg,
                          borderColor: themedAppStoreStyles.panelBorder,
                        }
                      : undefined
                  }
                >
                  <div>
                    <h3
                      className='text-sm font-semibold text-neutral-800 dark:text-neutral-100'
                      style={themedAppStoreStyles ? { color: themedAppStoreStyles.titleText } : undefined}
                    >
                      Upload a community app
                    </h3>
                    <p
                      className='text-xs text-neutral-500 dark:text-neutral-400'
                      style={themedAppStoreStyles ? { color: themedAppStoreStyles.bodyText } : undefined}
                    >
                      Zip must contain a single top-level tool folder with definition.json, description.json, and
                      index.js.
                    </p>
                  </div>

                  <input
                    ref={uploadInputRef}
                    type='file'
                    accept='.zip'
                    onChange={handleUploadFileChange}
                    className='block w-full text-xs text-neutral-600 dark:text-neutral-300 file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-200/70 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-neutral-700 dark:file:bg-neutral-800 dark:file:text-neutral-200'
                    disabled={!isElectron}
                  />
                  {!isElectron && (
                    <p className='text-[11px] text-amber-700 dark:text-amber-200'>
                      Uploads are available in the desktop app only.
                    </p>
                  )}

                  {uploadValidation && (
                    <div
                      className='rounded-lg border border-neutral-200/70 dark:border-neutral-700 bg-neutral-50/80 dark:bg-neutral-950/30 p-3 text-xs text-neutral-600 dark:text-neutral-300 space-y-2'
                      style={
                        themedAppStoreStyles
                          ? {
                              backgroundColor: themedAppStoreStyles.innerPanelBg,
                              borderColor: themedAppStoreStyles.innerPanelBorder,
                              color: themedAppStoreStyles.bodyText,
                            }
                          : undefined
                      }
                    >
                      <div className='flex items-center justify-between gap-3'>
                        <span className='uppercase tracking-[0.12em] text-[10px] text-neutral-400'>Tool ID</span>
                        <span className='font-mono text-xs text-neutral-700 dark:text-neutral-200'>
                          {uploadValidation.appId || 'n/a'}
                        </span>
                      </div>
                      <div>
                        <span className='uppercase tracking-[0.12em] text-[10px] text-neutral-400'>Name</span>
                        <p className='text-sm text-neutral-800 dark:text-neutral-100'>
                          {uploadValidation.description?.title || uploadValidation.description?.name}
                        </p>
                      </div>
                      {uploadValidation.description?.gitLink && (
                        <a
                          href={uploadValidation.description.gitLink}
                          target='_blank'
                          rel='noreferrer'
                          className='text-xs text-blue-600 dark:text-blue-400 hover:underline'
                        >
                          View repository
                        </a>
                      )}
                      {uploadValidation.containsExecutables && (
                        <div className='rounded-lg bg-amber-50/80 dark:bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-200'>
                          This zip contains executable files (.exe/.bat/.sh). A warning will be shown on install.
                        </div>
                      )}
                      {uploadValidation.warnings && uploadValidation.warnings.length > 0 && (
                        <ul className='text-[11px] text-amber-700 dark:text-amber-200 space-y-1'>
                          {uploadValidation.warnings.map(warning => (
                            <li key={warning}>• {warning}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  <div className='flex items-center gap-2 flex-wrap'>
                    <button
                      onClick={handleUploadSubmit}
                      disabled={!isElectron || uploadRequiresCloudLogin || !uploadValidation || uploadStatus?.type === 'uploading'}
                      className='px-4 py-2 text-xs bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
                      style={
                        themedAppStoreStyles
                          ? {
                              backgroundColor: themedAppStoreStyles.primaryButtonBg,
                              borderColor: themedAppStoreStyles.primaryButtonBorder,
                              color: themedAppStoreStyles.primaryButtonText,
                            }
                          : undefined
                      }
                    >
                      {uploadStatus?.type === 'uploading' ? 'Uploading...' : 'Upload to Community'}
                    </button>
                    {uploadRequiresCloudLogin && (
                      <button
                        type='button'
                        onClick={handleUploadLoginRequired}
                        className='text-[11px] text-amber-700 dark:text-amber-200 hover:underline text-left'
                      >
                        you need to sign in to upload apps to the store
                      </button>
                    )}
                    {uploadFile && (
                      <button
                        onClick={() => {
                          setUploadStatus(null)
                          resetUploadState()
                        }}
                        className='px-3 py-2 text-xs rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:border-neutral-300 dark:hover:border-neutral-500 transition-colors'
                        style={
                          themedAppStoreStyles
                            ? {
                                backgroundColor: themedAppStoreStyles.buttonBg,
                                borderColor: themedAppStoreStyles.buttonBorder,
                                color: themedAppStoreStyles.buttonText,
                              }
                            : undefined
                        }
                      >
                        Clear
                      </button>
                    )}
                  </div>

                  {uploadStatus && (
                    <div
                      className={`text-xs ${
                        uploadStatus.type === 'error'
                          ? 'text-red-500'
                          : uploadStatus.type === 'success'
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-neutral-500 dark:text-neutral-400'
                      }`}
                    >
                      {uploadStatus.message}
                    </div>
                  )}
                </div>
              )}

              {installedLoading && (
                <div className='flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400'>
                  <i className='bx bx-loader-alt animate-spin'></i>
                  Checking installed apps...
                </div>
              )}

              {installedError && (
                <div className='rounded-xl border border-amber-200/70 bg-amber-50/70 px-4 py-3 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'>
                  {installedError}
                </div>
              )}

              {isElectron && activeTabUpdates.length > 0 && (
                <div className='rounded-xl border border-blue-200/70 bg-blue-50/70 px-4 py-3 text-sm text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200 space-y-2'>
                  <p className='font-medium'>
                    {activeTabUpdates.length} update{activeTabUpdates.length === 1 ? '' : 's'} available
                  </p>
                  <p className='text-xs text-blue-700/90 dark:text-blue-200/90'>
                    Updates preserve each app’s <code>resources/</code> and <code>resource/</code> folders.
                  </p>
                  <div className='flex flex-wrap gap-2'>
                    {activeTabUpdates.slice(0, 4).map(({ app, update }) =>
                      update ? (
                        <button
                          key={`update-${app.id}`}
                          onClick={() => void handleInstall(app, 'update')}
                          disabled={Boolean(actionState)}
                          className='px-2.5 py-1 text-xs rounded-lg border border-blue-300/70 dark:border-blue-400/40 bg-white/70 dark:bg-blue-500/10 hover:bg-blue-100 dark:hover:bg-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
                        >
                          Update {getAppDisplayName(app)} ({update.installedVersion} → {update.availableVersion})
                        </button>
                      ) : null
                    )}
                    {activeTabUpdates.length > 4 && (
                      <span className='text-xs text-blue-700 dark:text-blue-300 self-center'>
                        +{activeTabUpdates.length - 4} more
                      </span>
                    )}
                  </div>
                </div>
              )}

              {activeLoading && (
                <div className='flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400'>
                  <i className='bx bx-loader-alt animate-spin'></i>
                  Loading apps...
                </div>
              )}

              {activeError && (
                <div className='rounded-xl border border-red-200/70 bg-red-50/70 px-4 py-3 text-sm text-red-600 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300'>
                  {activeError}
                </div>
              )}

              {!activeLoading && !activeError && activeApps.length === 0 && (
                <div
                  className='rounded-xl border border-neutral-200/70 bg-white/70 px-4 py-6 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-400'
                  style={
                    themedAppStoreStyles
                      ? {
                          backgroundColor: themedAppStoreStyles.emptyStateBg,
                          borderColor: themedAppStoreStyles.emptyStateBorder,
                          color: themedAppStoreStyles.bodyText,
                        }
                      : undefined
                  }
                >
                  No apps published yet.
                </div>
              )}

              <div className='flex-1 min-h-0 max-h-[52vh] overflow-y-auto thin-scrollbar pr-1'>
                <div
                  className={
                    viewMode === 'grid'
                      ? 'grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5'
                      : 'flex flex-col gap-4'
                  }
                >
                  {activeApps.map(app => {
                    const displayName = getAppDisplayName(app)
                    const summary = getAppSummary(app.description)
                    const publisher =
                      app.source === 'community'
                        ? app.uploader?.username || app.uploader?.id || 'Community uploader'
                        : app.description.publisher || 'Unknown publisher'
                    const version = app.description.version ? `v${app.description.version}` : null
                    const isSelected = selectedApp?.id === app.id
                    const iconUrl = app.description.iconUrl || app.description.icon
                    const isInstalled = isAppInstalled(app)
                    const updateInfo = getAppUpdateInfo(app)

                    return (
                      <button
                        key={app.id}
                        onClick={() => handleSelectApp(app.id)}
                        className={`text-left rounded-2xl border p-5 overflow-hidden transition-all duration-200 hover:border-blue-300/60 dark:hover:border-blue-400/50 ${
                          isSelected
                            ? 'border-blue-400 bg-blue-50/60 dark:bg-blue-500/10 shadow-sm'
                            : 'border-neutral-200/70 dark:border-neutral-700 bg-white/70 dark:bg-neutral-900/60'
                        } ${viewMode === 'list' ? 'w-full flex flex-col gap-4 min-h-[120px]' : 'flex flex-col gap-4 min-h-[150px]'}`}
                        style={
                          themedAppStoreStyles
                            ? isSelected
                              ? {
                                  backgroundColor: themedAppStoreStyles.selectedCardBg,
                                  borderColor: themedAppStoreStyles.selectedCardBorder,
                                  color: themedAppStoreStyles.selectedCardText,
                                }
                              : {
                                  backgroundColor: themedAppStoreStyles.listBg,
                                  borderColor: themedAppStoreStyles.listBorder,
                                }
                            : undefined
                        }
                      >
                        <div className='flex items-start gap-4 min-w-0'>
                          {iconUrl ? (
                            <img
                              src={iconUrl}
                              alt={`${displayName} icon`}
                              className='h-12 w-12 rounded-full object-cover border border-neutral-200 dark:border-neutral-700 flex-shrink-0'
                            />
                          ) : (
                            <div className='h-12 w-12 rounded-full bg-neutral-200 dark:bg-neutral-700 flex items-center justify-center text-sm font-semibold text-neutral-700 dark:text-neutral-200 flex-shrink-0'>
                              {displayName.slice(0, 1).toUpperCase()}
                            </div>
                          )}
                          <div className='min-w-0 flex-1'>
                            <p
                              className={`text-sm font-semibold text-neutral-900 dark:text-neutral-100 ${
                                viewMode === 'grid' ? 'line-clamp-2 break-words' : 'truncate'
                              }`}
                              style={
                                themedAppStoreStyles
                                  ? {
                                      color: isSelected
                                        ? themedAppStoreStyles.selectedCardText
                                        : themedAppStoreStyles.listItemTitleText,
                                    }
                                  : undefined
                              }
                            >
                              {displayName}
                            </p>
                            <p
                              className='text-xs text-neutral-500 dark:text-neutral-400 line-clamp-2'
                              style={
                                themedAppStoreStyles
                                  ? {
                                      color: isSelected
                                        ? themedAppStoreStyles.selectedCardText
                                        : themedAppStoreStyles.listItemMetaText,
                                    }
                                  : undefined
                              }
                            >
                              {summary}
                            </p>
                          </div>
                        </div>
                        <div
                          className='mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-400 dark:text-neutral-500'
                          style={
                            themedAppStoreStyles
                              ? {
                                  color: isSelected
                                    ? themedAppStoreStyles.selectedCardText
                                    : themedAppStoreStyles.listItemMetaText,
                                }
                              : undefined
                          }
                        >
                          <span className='truncate flex-1 min-w-0'>{publisher}</span>
                          <span className='flex items-center flex-wrap gap-2 ml-auto'>
                            {app.source === 'community' && (
                              <span
                                className='px-2 py-0.5 rounded-full bg-indigo-100/70 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 text-[10px] font-semibold uppercase tracking-wide'
                                style={
                                  themedAppStoreStyles
                                    ? {
                                        backgroundColor: themedAppStoreStyles.badgeBg,
                                        color: themedAppStoreStyles.badgeText,
                                      }
                                    : undefined
                                }
                              >
                                Community
                              </span>
                            )}
                            {app.containsExecutables && (
                              <span className='px-2 py-0.5 rounded-full bg-amber-100/70 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 text-[10px] font-semibold uppercase tracking-wide'>
                                Executable
                              </span>
                            )}
                            {isInstalled && (
                              <span className='px-2 py-0.5 rounded-full bg-emerald-100/70 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-[10px] font-semibold uppercase tracking-wide'>
                                Installed
                              </span>
                            )}
                            {updateInfo && (
                              <span className='px-2 py-0.5 rounded-full bg-blue-100/70 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300 text-[10px] font-semibold uppercase tracking-wide'>
                                Update Available
                              </span>
                            )}
                            {version && <span>{version}</span>}
                          </span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>

            <div
              className='rounded-2xl border border-neutral-200/70 dark:border-neutral-700 bg-white/70 dark:bg-neutral-900/60 p-5 h-fit'
              style={
                themedAppStoreStyles
                  ? {
                      backgroundColor: themedAppStoreStyles.panelBg,
                      borderColor: themedAppStoreStyles.panelBorder,
                    }
                  : undefined
              }
            >
              {selectedApp ? (
                <>
                  <div className='flex items-start justify-between gap-4'>
                    <div>
                      <h3
                        className='text-xl font-semibold text-neutral-900 dark:text-neutral-100'
                        style={themedAppStoreStyles ? { color: themedAppStoreStyles.titleText } : undefined}
                      >
                        {getAppDisplayName(selectedApp)}
                      </h3>
                      <p
                        className='text-sm text-neutral-500 dark:text-neutral-400'
                        style={themedAppStoreStyles ? { color: themedAppStoreStyles.bodyText } : undefined}
                      >
                        {selectedApp.source === 'community'
                          ? selectedApp.uploader?.username || selectedApp.uploader?.id || 'Uploader not listed'
                          : selectedApp.description.publisher || 'Publisher not listed'}
                      </p>
                    </div>
                    <span
                      className='text-xs font-mono uppercase tracking-[0.15em] text-neutral-400'
                      style={themedAppStoreStyles ? { color: themedAppStoreStyles.mutedText } : undefined}
                    >
                      {selectedApp.source === 'community'
                        ? 'Community'
                        : selectedApp.description.category || 'Tool'}
                    </span>
                  </div>

                  <p
                    className='mt-4 text-sm text-neutral-600 dark:text-neutral-300'
                    style={themedAppStoreStyles ? { color: themedAppStoreStyles.secondaryText } : undefined}
                  >
                    {getAppSummary(selectedApp.description)}
                  </p>

                  <div
                    className='mt-4 grid grid-cols-2 gap-3 text-xs text-neutral-500 dark:text-neutral-400'
                    style={themedAppStoreStyles ? { color: themedAppStoreStyles.bodyText } : undefined}
                  >
                    <div>
                      <p className='uppercase tracking-[0.12em] text-[10px]'>Version</p>
                      <p className='text-sm text-neutral-700 dark:text-neutral-200'>{selectedApp.description.version || 'n/a'}</p>
                      {selectedAppUpdateInfo && (
                        <p className='text-[11px] text-blue-600 dark:text-blue-300'>
                          Installed: {selectedAppUpdateInfo.installedVersion}
                        </p>
                      )}
                    </div>
                    <div>
                      <p className='uppercase tracking-[0.12em] text-[10px]'>Size</p>
                      <p className='text-sm text-neutral-700 dark:text-neutral-200'>{formatSize(selectedApp.description.size)}</p>
                    </div>
                    <div>
                      <p className='uppercase tracking-[0.12em] text-[10px]'>Package</p>
                      <p className='text-sm text-neutral-700 dark:text-neutral-200 truncate'>{selectedApp.zipName || 'default'}</p>
                    </div>
                    <div>
                      <p className='uppercase tracking-[0.12em] text-[10px]'>Updated</p>
                      <p className='text-sm text-neutral-700 dark:text-neutral-200'>
                        {selectedApp.updatedAt ? new Date(selectedApp.updatedAt).toLocaleDateString() : 'n/a'}
                      </p>
                    </div>
                    {selectedApp.source === 'community' && (
                      <div>
                        <p className='uppercase tracking-[0.12em] text-[10px]'>Uploader</p>
                        <p className='text-sm text-neutral-700 dark:text-neutral-200 truncate'>
                          {selectedApp.uploader?.username || selectedApp.uploader?.id || 'n/a'}
                        </p>
                      </div>
                    )}
                    {selectedApp.description.gitLink && (
                      <div>
                        <p className='uppercase tracking-[0.12em] text-[10px]'>Repo</p>
                        <a
                          href={selectedApp.description.gitLink}
                          target='_blank'
                          rel='noreferrer'
                          className='text-sm text-blue-600 dark:text-blue-400 hover:underline truncate block'
                          style={themedAppStoreStyles ? { color: themedAppStoreStyles.linkText } : undefined}
                        >
                          View repository
                        </a>
                      </div>
                    )}
                  </div>

                  {selectedApp.description.tags && selectedApp.description.tags.length > 0 && (
                    <div className='mt-4 flex flex-wrap gap-2'>
                      {selectedApp.description.tags.map(tag => (
                        <span
                          key={tag}
                          className='px-2 py-1 text-xs rounded-full bg-neutral-200/70 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300'
                          style={
                            themedAppStoreStyles
                              ? {
                                  backgroundColor: themedAppStoreStyles.badgeBg,
                                  color: themedAppStoreStyles.badgeText,
                                }
                              : undefined
                          }
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}

                  {selectedApp.source === 'community' && selectedApp.containsExecutables && (
                    <div className='mt-4 rounded-xl border border-amber-200/70 bg-amber-50/70 px-4 py-3 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'>
                      This community app contains executable files (.exe/.bat/.sh). Install only if you trust the
                      source.
                    </div>
                  )}

                  <div className='mt-6 flex flex-wrap items-center gap-3'>
                    {selectedAppInstalled ? (
                      <>
                        {selectedAppHasUpdate ? (
                          <button
                            onClick={() => void handleInstall(selectedApp, 'update')}
                            disabled={!isElectron || isActionInProgress}
                            className='px-4 py-2 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2'
                            style={
                              themedAppStoreStyles
                                ? {
                                    backgroundColor: themedAppStoreStyles.primaryButtonBg,
                                    borderColor: themedAppStoreStyles.primaryButtonBorder,
                                    color: themedAppStoreStyles.primaryButtonText,
                                  }
                                : undefined
                            }
                          >
                            {isUpdating ? (
                              <>
                                <i className='bx bx-loader-alt animate-spin text-base'></i>
                                Updating...
                              </>
                            ) : (
                              <>
                                <i className='bx bx-refresh text-base'></i>
                                Update
                              </>
                            )}
                          </button>
                        ) : (
                          <span className='text-xs text-emerald-700 dark:text-emerald-300 rounded-lg bg-emerald-100/70 dark:bg-emerald-500/10 px-3 py-2'>
                            Installed and up to date
                          </span>
                        )}
                        <button
                          onClick={handleUninstall}
                          disabled={!isElectron || isActionInProgress}
                          className={`px-4 py-2 text-sm rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2 ${
                            selectedAppHasUpdate
                              ? 'border border-red-300 dark:border-red-500/40 text-red-600 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-500/10'
                              : 'bg-red-500 text-white hover:bg-red-600'
                          }`}
                          style={
                            themedAppStoreStyles
                              ? selectedAppHasUpdate
                                ? {
                                    backgroundColor: themedAppStoreStyles.secondaryButtonBg,
                                    borderColor: themedAppStoreStyles.dangerButtonBorder,
                                    color: themedAppStoreStyles.dangerButtonText,
                                  }
                                : {
                                    backgroundColor: themedAppStoreStyles.dangerButtonBg,
                                    borderColor: themedAppStoreStyles.dangerButtonBorder,
                                    color: themedAppStoreStyles.dangerButtonText,
                                  }
                              : undefined
                          }
                        >
                          {isUninstalling ? (
                            <>
                              <i className='bx bx-loader-alt animate-spin text-base'></i>
                              Uninstalling...
                            </>
                          ) : (
                            <>
                              <i className='bx bx-trash text-base'></i>
                              Uninstall
                            </>
                          )}
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => void handleInstall()}
                        disabled={!isElectron || isActionInProgress}
                        className='px-4 py-2 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2'
                        style={
                          themedAppStoreStyles
                            ? {
                                backgroundColor: themedAppStoreStyles.primaryButtonBg,
                                borderColor: themedAppStoreStyles.primaryButtonBorder,
                                color: themedAppStoreStyles.primaryButtonText,
                              }
                            : undefined
                        }
                      >
                        {isInstalling ? (
                          <>
                            <i className='bx bx-loader-alt animate-spin text-base'></i>
                            Installing...
                          </>
                        ) : (
                          <>
                            <i className='bx bx-download text-base'></i>
                            Download & Install
                          </>
                        )}
                      </button>
                    )}
                    {selectedApp.descriptionUrl && (
                      <a
                        href={selectedApp.descriptionUrl}
                        target='_blank'
                        rel='noreferrer'
                        className='text-sm text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 transition-colors'
                        style={themedAppStoreStyles ? { color: themedAppStoreStyles.bodyText } : undefined}
                      >
                        View description
                      </a>
                    )}
                  </div>

                  {actionStatus && (
                    <div
                      className={`mt-4 flex items-center gap-2 text-sm ${
                        actionStatus.type === 'error'
                          ? 'text-red-500'
                          : actionStatus.type === 'success'
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-neutral-500 dark:text-neutral-400'
                      }`}
                      style={
                        themedAppStoreStyles
                          ? actionStatus.type === 'error'
                            ? { color: themedAppStoreStyles.errorText }
                            : actionStatus.type === 'success'
                            ? { color: themedAppStoreStyles.successText }
                            : { color: themedAppStoreStyles.bodyText }
                          : undefined
                      }
                    >
                      {actionStatus.type === 'working' && <i className='bx bx-loader-alt animate-spin'></i>}
                      {actionStatus.type === 'success' && <i className='bx bx-check-circle'></i>}
                      {actionStatus.type === 'error' && <i className='bx bx-error-circle'></i>}
                      <span>{actionStatus.message}</span>
                    </div>
                  )}

                  {actionStatus?.restartRequired && (
                    <div
                      className='mt-3 flex flex-wrap items-center gap-3 text-xs text-neutral-500 dark:text-neutral-400'
                      style={themedAppStoreStyles ? { color: themedAppStoreStyles.bodyText } : undefined}
                    >
                      <span>Restart Yggdrasil to finish installation.</span>
                      <button
                        onClick={handleRestart}
                        className='px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 text-xs text-neutral-700 dark:text-neutral-200 hover:border-blue-300 hover:text-blue-600 transition-colors'
                        style={
                          themedAppStoreStyles
                            ? {
                                backgroundColor: themedAppStoreStyles.buttonBg,
                                borderColor: themedAppStoreStyles.buttonBorder,
                                color: themedAppStoreStyles.buttonText,
                              }
                            : undefined
                        }
                      >
                        Restart now
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div
                  className='text-sm text-neutral-500 dark:text-neutral-400'
                  style={themedAppStoreStyles ? { color: themedAppStoreStyles.bodyText } : undefined}
                >
                  Select an app to see details.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
