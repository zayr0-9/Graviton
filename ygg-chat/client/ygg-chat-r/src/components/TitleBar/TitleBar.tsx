import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { matchPath, useLocation, useNavigate } from 'react-router-dom'
import './TitleBar.css'

import { chatSliceActions, selectCcCwd, selectCurrentConversationId } from '../../features/chats'
import { selectSelectedProject } from '../../features/projects'
import { buildRemoteMobileUrl, loadRemoteServerSettings } from '../../helpers/remoteServerSettingsStorage'
import { useAppDispatch, useAppSelector } from '../../hooks/redux'
import { useProjects } from '../../hooks/useQueries'
import { getLocalServerLanOrigin, getLocalServerOrigin } from '../../utils/api'

export const TitleBar = () => {
  const dispatch = useAppDispatch()
  const location = useLocation()
  const navigate = useNavigate()
  const [platform, setPlatform] = useState<string>('')
  const [isElectron, setIsElectron] = useState(false)
  const [isCompact, setIsCompact] = useState(false)
  const [isCompactLoading, setIsCompactLoading] = useState(false)

  const currentCwd = useAppSelector(selectCcCwd)
  const currentConversationId = useAppSelector(selectCurrentConversationId)
  const selectedProject = useAppSelector(selectSelectedProject)
  const currentConversation = useAppSelector(state => {
    if (!currentConversationId) return null
    return state.conversations.items.find(conversation => String(conversation.id) === String(currentConversationId)) ?? null
  })
  const { data: allProjects = [] } = useProjects()

  const chatRouteMatch = matchPath('/chat/:projectId/:conversationId', location.pathname)
  const projectIdFromRoute = chatRouteMatch?.params.projectId && chatRouteMatch.params.projectId !== 'unknown'
    ? chatRouteMatch.params.projectId
    : null

  const currentProjectName = useMemo(() => {
    const currentProjectId = currentConversation?.project_id || projectIdFromRoute || selectedProject?.id
    if (!currentProjectId) return null

    if (selectedProject && String(selectedProject.id) === String(currentProjectId)) {
      return selectedProject.name
    }

    return allProjects.find(project => String(project.id) === String(currentProjectId))?.name ?? null
  }, [allProjects, currentConversation?.project_id, projectIdFromRoute, selectedProject])

  useEffect(() => {
    const detectPlatform = async () => {
      if (window.electronAPI?.platformInfo?.get) {
        const info = await window.electronAPI.platformInfo.get()
        setPlatform(info.platform)
        setIsElectron(info.isElectron)

        // Add padding to app content when we render an in-app title bar.
        if (info.isElectron && (info.platform === 'win32' || info.platform === 'darwin' || info.platform === 'linux')) {
          document.body.classList.add('has-titlebar')
        }

        // Check initial compact mode state
        if (window.electronAPI?.window?.isCompact) {
          const compact = await window.electronAPI.window.isCompact()
          setIsCompact(compact)
        }
      }
    }
    detectPlatform()

    // Cleanup
    return () => {
      document.body.classList.remove('has-titlebar')
    }
  }, [])

  const isWindows = platform === 'win32'
  const isMac = platform === 'darwin'
  const isLinux = platform === 'linux'

  // Render custom title bar content on desktop Electron platforms.
  // macOS and Linux keep native window controls; Windows uses custom controls.
  if (!isElectron || (!isWindows && !isMac && !isLinux)) {
    return null
  }

  const handleToggleCompact = async () => {
    if (!window.electronAPI?.window?.toggleCompact) return
    setIsCompactLoading(true)
    try {
      const result = await window.electronAPI.window.toggleCompact()
      if (result.success) {
        setIsCompact(result.compact)
      }
    } catch (err) {
      console.error('Failed to toggle compact mode:', err)
    } finally {
      setIsCompactLoading(false)
    }
  }

  const handleMinimize = () => {
    window.electronAPI?.window?.minimize()
  }

  const handleMaximize = () => {
    window.electronAPI?.window?.maximize()
  }

  const handleClose = () => {
    window.electronAPI?.window?.close()
  }

  const isChatPage = location.pathname.startsWith('/chat/')
  const canPickCwd = isChatPage && Boolean(currentConversationId) && Boolean(window.electronAPI?.dialog?.selectFolder)

  const handlePickCwd = async () => {
    if (!canPickCwd) return
    try {
      const result = await window.electronAPI?.dialog?.selectFolder()
      if (result?.success && result.path) {
        dispatch(chatSliceActions.ccCwdSet(result.path))
      }
    } catch (err) {
      console.error('Failed to select working directory from title bar:', err)
    }
  }

  const handleOpenRemoteServerUi = async () => {
    try {
      const configuredRemoteBaseUrl = loadRemoteServerSettings().remoteBaseUrl
      const configuredMobileUrl = buildRemoteMobileUrl(configuredRemoteBaseUrl)

      const lanOrigin = await getLocalServerLanOrigin()
      const lanMobileUrl = buildRemoteMobileUrl(lanOrigin)
      const fallbackOrigin = await getLocalServerOrigin()
      const fallbackMobileUrl = buildRemoteMobileUrl(fallbackOrigin)
      const url = lanMobileUrl || configuredMobileUrl || fallbackMobileUrl

      if (!url) {
        throw new Error('Unable to resolve remote server URL')
      }

      if (window.electronAPI?.auth?.openExternal) {
        const result = await window.electronAPI.auth.openExternal(url)
        if (!result?.success) {
          window.open(url, '_blank', 'noopener,noreferrer')
        }
      } else {
        window.open(url, '_blank', 'noopener,noreferrer')
      }
    } catch (err) {
      console.error('Failed to open remote server UI from title bar:', err)
    }
  }

  return (
    <div
      className={`titlebar ${isMac ? 'titlebar-mac' : isLinux ? 'titlebar-linux' : 'titlebar-windows'} ${
        isChatPage ? 'titlebar-chat' : ''
      }`}
    >
      <div className='titlebar-drag-region'>
        <div className='titlebar-nav-controls'>
          <button className='titlebar-control-button titlebar-nav-button' onClick={() => navigate(-1)} title='Go Back'>
            <span className='titlebar-control-icon-shell titlebar-nav-icon-shell acrylic-ultra-light-nb-3'>
              <ChevronLeft size={32} strokeWidth={2} />
            </span>
          </button>
          <button
            className='titlebar-control-button titlebar-nav-button'
            onClick={() => navigate(1)}
            title='Go Forward'
          >
            <span className='titlebar-control-icon-shell titlebar-nav-icon-shell acrylic-ultra-light-nb-3'>
              <ChevronRight size={16} strokeWidth={2} />
            </span>
          </button>
        </div>
        {isChatPage && currentProjectName ? (
          <div className='titlebar-project-name' title={currentProjectName}>
            {currentProjectName}
          </div>
        ) : null}
      </div>
      <div className='titlebar-controls'>
        <button
          type='button'
          className='titlebar-pill titlebar-remote-pill acrylic-light'
          onClick={handleOpenRemoteServerUi}
          title='Open remote server UI (/mobile) in default browser'
        >
          <span className='titlebar-pill-label'>remote</span>
        </button>
        <button
          type='button'
          className='titlebar-pill cwd-pill acrylic-light'
          onClick={handlePickCwd}
          disabled={!canPickCwd}
          title={
            canPickCwd
              ? currentCwd
                ? `${currentCwd} (click to change)`
                : 'Click to select a work folder'
              : currentCwd || 'Open a chat conversation to set work folder'
          }
        >
          {currentCwd ? (
            <span className='cwd-pill-text cwd-pill-text-scroll titlebar-pill-mono'>{currentCwd}</span>
          ) : (
            <span className='cwd-pill-text titlebar-pill-empty'>Select a work folder</span>
          )}
        </button>
        <button
          className={`titlebar-control-button titlebar-compact ${isCompact ? 'titlebar-compact-active' : ''}`}
          onClick={handleToggleCompact}
          disabled={isCompactLoading}
          aria-label={isCompact ? 'Disable Floating Mode' : 'Enable Floating Mode'}
          title={isCompact ? 'Disable Floating Mode' : 'Enable Floating Mode'}
        >
          <span className='titlebar-control-icon-shell acrylic-subtle'>
            {isCompactLoading ? (
              <svg width='10' height='10' viewBox='0 0 10 10' className='animate-spin'>
                <circle cx='5' cy='5' r='4' fill='none' stroke='currentColor' strokeWidth='1' strokeDasharray='12 6' />
              </svg>
            ) : (
              <svg width='10' height='10' viewBox='0 0 10 10' aria-hidden='true'>
                <path
                  fill='currentColor'
                  d='M2.5 1A1.5 1.5 0 0 0 1 2.5v3A1.5 1.5 0 0 0 2.5 7H3V6h-.5a.5.5 0 0 1-.5-.5v-3a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V3h1v-.5A1.5 1.5 0 0 0 6.5 1h-4zm2 3A1.5 1.5 0 0 0 3 5.5v2A1.5 1.5 0 0 0 4.5 9h3A1.5 1.5 0 0 0 9 7.5v-2A1.5 1.5 0 0 0 7.5 4h-3zm0 1h3a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-2a.5.5 0 0 1 .5-.5z'
                />
              </svg>
            )}
          </span>
        </button>
        {isWindows ? (
          <>
            <button
              className='titlebar-control-button titlebar-minimize'
              onClick={handleMinimize}
              aria-label='Minimize'
              title='Minimize'
            >
              <span className='titlebar-control-icon-shell acrylic-subtle'>
                <svg width='10' height='1' viewBox='0 0 10 1'>
                  <rect fill='currentColor' width='10' height='1' />
                </svg>
              </span>
            </button>
            <button
              className='titlebar-control-button titlebar-maximize'
              onClick={handleMaximize}
              aria-label='Maximize'
              title='Maximize'
            >
              <span className='titlebar-control-icon-shell acrylic-subtle'>
                <svg width='10' height='10' viewBox='0 0 10 10'>
                  <path fill='currentColor' d='M0 0v10h10V0H0zm1 1h8v8H1V1z' />
                </svg>
              </span>
            </button>
            <button
              className='titlebar-control-button titlebar-close'
              onClick={handleClose}
              aria-label='Close'
              title='Close'
            >
              <span className='titlebar-control-icon-shell acrylic-subtle'>
                <svg width='10' height='10' viewBox='0 0 10 10'>
                  <path
                    fill='currentColor'
                    d='M1.207.293l-.914.914L4.086 5 .293 8.793l.914.914L5 5.914l3.793 3.793.914-.914L5.914 5l3.793-3.793-.914-.914L5 4.086 1.207.293z'
                  />
                </svg>
              </span>
            </button>
          </>
        ) : null}
      </div>
    </div>
  )
}
