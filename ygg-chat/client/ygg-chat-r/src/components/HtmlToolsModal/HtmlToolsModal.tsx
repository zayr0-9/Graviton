import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { HtmlIframeSlot, McpAppIframeSlot, useHtmlIframeRegistry } from '../HtmlIframeRegistry/HtmlIframeRegistry'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'

// Ghost Pill Button Component
const GhostPill: React.FC<{
  children: React.ReactNode
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  danger?: boolean
  className?: string
  style?: React.CSSProperties
  'aria-label'?: string
  'aria-pressed'?: boolean
}> = ({ children, onClick, active, disabled, danger, className = '', ...props }) => (
  <button
    type='button'
    onClick={onClick}
    disabled={disabled}
    className={`
      font-mono text-[11px] px-3 py-1.5 rounded-full
      transition-all duration-200 cursor-pointer
      border flex items-center justify-center gap-1.5
      disabled:opacity-40 disabled:cursor-not-allowed
      ${
        active
          ? 'bg-neutral-200 border-neutral-300 text-neutral-900 dark:bg-white/[0.08] dark:border-white/[0.1] dark:text-white'
          : danger
            ? 'bg-neutral-100 border-neutral-200 text-neutral-600 hover:bg-red-50 hover:text-red-600 hover:border-red-200 dark:bg-white/[0.02] dark:border-white/[0.05] dark:text-neutral-500 dark:hover:bg-red-500/10 dark:hover:text-red-400 dark:hover:border-red-500/20'
            : 'bg-neutral-100 border-neutral-200 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900 dark:bg-white/[0.02] dark:border-white/[0.05] dark:text-neutral-500 dark:hover:bg-white/[0.05] dark:hover:text-white'
      }
      ${className}
    `}
    {...props}
  >
    {children}
  </button>
)

// Icon-only Ghost Pill variant
const GhostPillIcon: React.FC<{
  children: React.ReactNode
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  danger?: boolean
  className?: string
  style?: React.CSSProperties
  'aria-label'?: string
  'aria-pressed'?: boolean
}> = ({ children, onClick, active, disabled, danger, className = '', ...props }) => (
  <button
    type='button'
    onClick={onClick}
    disabled={disabled}
    className={`
      w-8 h-8 rounded-full flex items-center justify-center
      transition-all duration-200 cursor-pointer border
      disabled:opacity-40 disabled:cursor-not-allowed
      ${
        active
          ? 'bg-neutral-200 border-neutral-300 text-neutral-900 dark:bg-white/[0.08] dark:border-white/[0.1] dark:text-white'
          : danger
            ? 'bg-neutral-100 border-neutral-200 text-neutral-600 hover:bg-red-50 hover:text-red-600 hover:border-red-200 dark:bg-white/[0.02] dark:border-white/[0.05] dark:text-neutral-500 dark:hover:bg-red-500/10 dark:hover:text-red-400 dark:hover:border-red-500/20'
            : 'bg-neutral-100 border-neutral-200 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900 dark:bg-white/[0.02] dark:border-white/[0.05] dark:text-neutral-500 dark:hover:bg-white/[0.05] dark:hover:text-white'
      }
      ${className}
    `}
    {...props}
  >
    {children}
  </button>
)

const CUSTOM_TOOL_MANAGER_LABEL_REGEX = /^custom[\s_]+tool[\s_]+manager(?:\s+result\s+\d+)?$/i

const humanizeToolName = (toolName: string): string => {
  const normalized = toolName
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return ''

  return normalized
    .split(' ')
    .map(token => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
    .join(' ')
}

export const HtmlToolsModal: React.FC = () => {
  const registry = useHtmlIframeRegistry()
  if (!registry) return null

  const isOpen = registry.isModalOpen
  const isHomepageFullscreen = registry.isHomepageFullscreen
  const focusKey = registry.focusKey
  const onClose = registry.closeModal
  const closeHomepageFullscreen = () => registry.setHomepageFullscreen(false)
  const [collapsedTools, setCollapsedTools] = useState<Record<string, boolean>>({})
  const [viewMode, _setViewMode] = useState<'list' | 'tabs'>('tabs')
  const [activeTab, setActiveTab] = useState<string | null>(null)
  const [showLimits, setShowLimits] = useState(false)
  const [showFavorites, setShowFavorites] = useState(false)
  const [showHibernated, setShowHibernated] = useState(false)
  const [isRightDocked, setIsRightDocked] = useState(false)
  const [dockWidthPx, setDockWidthPx] = useState<number | null>(null)
  const [isDockResizing, setIsDockResizing] = useState(false)
  const [fullscreenKey, setFullscreenKey] = useState<string | null>(null)
  const { theme: customTheme, enabled: customThemeEnabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()
  const [showFullscreenSettings, setShowFullscreenSettings] = useState(false)
  const [showFullscreenTabMenu, setShowFullscreenTabMenu] = useState<string | null>(null)
  const [tabMenuPosition, setTabMenuPosition] = useState<{ top: number; left: number } | null>(null)
  const settingsRef = useRef<HTMLDivElement | null>(null)
  const settingsDropdownRef = useRef<HTMLDivElement | null>(null)
  const tabMenuRef = useRef<HTMLDivElement | null>(null)
  const lastFocusKeyRef = useRef<string | null>(null)
  const lastFocusModeRef = useRef<'list' | 'tabs' | null>(null)
  const isDockResizingRef = useRef(false)
  const isRightDockedLayout = isRightDocked && !isHomepageFullscreen
  const clampDockWidth = useCallback((width: number) => {
    if (typeof window === 'undefined') return width
    const minWidth = Math.round(window.innerWidth * 0.3)
    const maxWidth = Math.max(minWidth, window.innerWidth - 320)
    return Math.min(Math.max(width, minWidth), maxWidth)
  }, [])

  const htmlToolsModalSurfaceBg = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.htmlToolsModalSurfaceBg, isDarkMode)
    : undefined
  const htmlToolsModalSurfaceBorder = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.htmlToolsModalSurfaceBorder, isDarkMode)
    : undefined
  const htmlToolsModalPanelMutedBg = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.htmlToolsModalPanelMutedBg, isDarkMode)
    : undefined
  const htmlToolsModalButtonBg = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.htmlToolsModalButtonBg, isDarkMode)
    : undefined
  const htmlToolsModalButtonBorder = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.htmlToolsModalButtonBorder, isDarkMode)
    : undefined
  const htmlToolsModalButtonText = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.htmlToolsModalButtonText, isDarkMode)
    : undefined
  const htmlToolsModalButtonActiveBg = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.htmlToolsModalButtonActiveBg, isDarkMode)
    : undefined
  const htmlToolsModalButtonActiveBorder = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.htmlToolsModalButtonActiveBorder, isDarkMode)
    : undefined
  const htmlToolsModalButtonActiveText = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.htmlToolsModalButtonActiveText, isDarkMode)
    : undefined

  const buttonStyle = customThemeEnabled
    ? {
        backgroundColor: htmlToolsModalButtonBg,
        borderColor: htmlToolsModalButtonBorder,
        color: htmlToolsModalButtonText,
      }
    : undefined

  const activeButtonStyle = customThemeEnabled
    ? {
        backgroundColor: htmlToolsModalButtonActiveBg,
        borderColor: htmlToolsModalButtonActiveBorder,
        color: htmlToolsModalButtonActiveText,
      }
    : undefined

  const entries = registry.entries
  const activeEntries = useMemo(() => entries.filter(entry => entry.status === 'active'), [entries])
  const hibernatedEntries = useMemo(() => entries.filter(entry => entry.status === 'hibernated'), [entries])
  const favoriteEntries = useMemo(() => entries.filter(entry => entry.favorite), [entries])
  const activeKey = activeTab ?? activeEntries[0]?.key ?? null
  const maxBytesMb = useMemo(() => Math.round(registry.settings.maxBytes / (1024 * 1024)), [registry.settings.maxBytes])
  const resolveEntryLabel = useCallback((entry: (typeof entries)[number]) => {
    if (entry.kind === 'html') {
      const currentLabel = entry.label?.trim() ?? ''
      const toolName = entry.toolName ?? ''
      const shouldUseInvokedToolName =
        currentLabel.length > 0 && CUSTOM_TOOL_MANAGER_LABEL_REGEX.test(currentLabel) && toolName.length > 0

      if (shouldUseInvokedToolName) {
        const invokedLabel = humanizeToolName(toolName)
        if (invokedLabel) {
          return invokedLabel
        }
      }
    }

    return entry.label || (entry.kind === 'mcp' ? 'MCP App' : 'HTML Tool Output')
  }, [])

  const displayLabels = useMemo(() => {
    const labelCounts = new Map<string, number>()
    const labelIndices = new Map<string, number>()
    activeEntries.forEach(entry => {
      const label = resolveEntryLabel(entry)
      labelCounts.set(label, (labelCounts.get(label) || 0) + 1)
    })
    const result = new Map<string, string>()
    activeEntries.forEach(entry => {
      const label = resolveEntryLabel(entry)
      const count = labelCounts.get(label) || 1
      if (count > 1) {
        const idx = (labelIndices.get(label) || 0) + 1
        labelIndices.set(label, idx)
        result.set(entry.key, `${label} (${idx})`)
      } else {
        result.set(entry.key, label)
      }
    })
    return result
  }, [activeEntries, resolveEntryLabel])

  const toggleFullscreen = (entryKey: string) => {
    const isExiting = fullscreenKey === entryKey
    setFullscreenKey(isExiting ? null : entryKey)
  }

  const isVisible = isOpen || isHomepageFullscreen

  useEffect(() => {
    if (!isVisible || !focusKey) {
      lastFocusKeyRef.current = null
      lastFocusModeRef.current = null
      return
    }
    if (lastFocusKeyRef.current === focusKey && lastFocusModeRef.current === viewMode) {
      return
    }
    if (viewMode === 'tabs') {
      const exists = activeEntries.some(entry => entry.key === focusKey)
      if (exists) {
        setActiveTab(focusKey)
        lastFocusKeyRef.current = focusKey
        lastFocusModeRef.current = viewMode
      }
      return
    }
    const target = document.getElementById(`html-tool-${focusKey}`)
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      lastFocusKeyRef.current = focusKey
      lastFocusModeRef.current = viewMode
    }
  }, [activeEntries, focusKey, isVisible, viewMode])

  useEffect(() => {
    if (!isVisible) {
      if (fullscreenKey) setFullscreenKey(null)
    }
  }, [fullscreenKey, isVisible])

  useEffect(() => {
    if (isRightDocked && fullscreenKey) {
      setFullscreenKey(null)
    }
  }, [fullscreenKey, isRightDocked])

  useEffect(() => {
    if (!fullscreenKey) return
    const exists = entries.some(entry => entry.key === fullscreenKey && entry.status === 'active')
    if (!exists) {
      setFullscreenKey(null)
    }
  }, [entries, fullscreenKey])

  useEffect(() => {
    if (activeEntries.length === 0) {
      if (activeTab !== null) setActiveTab(null)
      return
    }
    if (!activeTab || !activeEntries.some(entry => entry.key === activeTab)) {
      setActiveTab(activeEntries[0].key)
    }
  }, [activeEntries, activeTab])

  // Close fullscreen dropdowns on outside click
  useEffect(() => {
    if (!showFullscreenSettings && !showFullscreenTabMenu) return
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      const isInsideSettingsTrigger = settingsRef.current?.contains(target)
      const isInsideSettingsDropdown = settingsDropdownRef.current?.contains(target)
      if (!isInsideSettingsTrigger && !isInsideSettingsDropdown) {
        setShowFullscreenSettings(false)
      }
      if (tabMenuRef.current && !tabMenuRef.current.contains(target)) {
        setShowFullscreenTabMenu(null)
        setTabMenuPosition(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showFullscreenSettings, showFullscreenTabMenu])

  const stopDockResize = useCallback(() => {
    isDockResizingRef.current = false
    setIsDockResizing(false)
    if (typeof document !== 'undefined') {
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [])

  const handleDockMouseMove = useCallback(
    (clientX: number) => {
      if (!isDockResizingRef.current || typeof window === 'undefined') return
      setDockWidthPx(clampDockWidth(window.innerWidth - clientX))
    },
    [clampDockWidth]
  )

  const startDockResize = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!isRightDockedLayout || typeof window === 'undefined') return
      event.preventDefault()
      isDockResizingRef.current = true
      setIsDockResizing(true)
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
      handleDockMouseMove(event.clientX)
    },
    [handleDockMouseMove, isRightDockedLayout]
  )

  useEffect(() => {
    if (!isRightDockedLayout || typeof window === 'undefined') {
      stopDockResize()
      return
    }

    const handleMouseMove = (event: MouseEvent) => handleDockMouseMove(event.clientX)
    const handleMouseUp = () => stopDockResize()
    const handleWindowBlur = () => stopDockResize()

    const handleResize = () => {
      setDockWidthPx(prev => (prev == null ? prev : clampDockWidth(prev)))
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('blur', handleWindowBlur)
      window.removeEventListener('resize', handleResize)
      stopDockResize()
    }
  }, [clampDockWidth, handleDockMouseMove, isRightDockedLayout, stopDockResize])

  const renderEntry = (
    entry: (typeof entries)[number],
    options?: { fillHeight?: boolean; compactView?: boolean; showLabel?: boolean }
  ) => {
    const isCollapsed = collapsedTools[entry.key] ?? false
    const isHibernated = entry.status === 'hibernated'
    const isFavorite = entry.favorite
    const isFullscreen = fullscreenKey === entry.key
    const mcpEntry = entry.kind === 'mcp' ? entry : null
    const isCompact = options?.compactView === true
    const shouldShowLabel = options?.showLabel === true
    const entryLabel = displayLabels.get(entry.key) ?? resolveEntryLabel(entry)
    const dockEdgeInsetClass = isRightDockedLayout ? 'pl-2' : ''
    const iframeHeightClass = isCollapsed
      ? 'h-0 overflow-hidden opacity-0 pointer-events-none'
      : isFullscreen
        ? 'flex-1 min-h-0'
        : options?.fillHeight
          ? 'flex-1 min-h-0'
          : 'h-[50vh]'
    const cardClassName = isFullscreen
      ? 'fixed inset-0 z-[1501] flex flex-col min-h-0 rounded-none border-0 bg-white dark:bg-[rgba(15,15,15,0.95)] shadow-none'
      : options?.fillHeight
        ? 'flex-1 flex flex-col min-h-0 rounded-2xl border border-neutral-200 dark:border-white/[0.05] bg-neutral-50 dark:bg-black/20'
        : isCompact
          ? 'rounded-2xl border border-neutral-200 dark:border-white/[0.05] bg-neutral-50 dark:bg-black/20 cursor-pointer hover:bg-neutral-100 dark:hover:bg-white/[0.03] hover:border-neutral-300 dark:hover:border-white/[0.08] transition-all duration-200'
          : 'rounded-2xl border border-neutral-200 dark:border-white/[0.05] bg-neutral-50 dark:bg-black/20'
    const cardStyle = isFullscreen ? { paddingTop: 'var(--titlebar-height, 0px)' } : undefined

    const handleCompactClick = () => {
      if (!isCompact) return
      setActiveTab(entry.key)
      registry.touchEntry(entry.key)
      setShowFavorites(false)
    }

    // Truncate key for display
    const truncatedKey = entry.key.length > 12 ? `${entry.key.slice(0, 8)}...${entry.key.slice(-4)}` : entry.key

    return (
      <div
        id={`html-tool-${entry.key}`}
        className={`${cardClassName} px-0 py-1`}
        style={cardStyle}
        onClick={handleCompactClick}
      >
        <div className={`flex items-center gap-3 px-3 ${isCompact ? '' : 'mb-1'}`}>
          <div className='flex items-center gap-3 min-w-0 flex-1'>
            {mcpEntry && (
              <span className='text-[10px] uppercase tracking-[0.15em] text-emerald-600 dark:text-emerald-400'>
                MCP App
              </span>
            )}
            {shouldShowLabel && (
              <span className='min-w-0 truncate text-[13px] font-medium text-neutral-800 dark:text-neutral-200'>
                {entryLabel}
              </span>
            )}
            <span className='font-mono text-[10px] px-2 py-0 rounded bg-blue-100 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-500/20'>
              ID: {truncatedKey}
            </span>
          </div>
          <div className='flex items-center gap-2' onClick={e => e.stopPropagation()}>
            <GhostPillIcon
              onClick={() => registry.toggleFavorite(entry.key)}
              active={isFavorite}
              aria-pressed={isFavorite}
              aria-label={isFavorite ? 'Unfavorite tool output' : 'Favorite tool output'}
              style={isFavorite ? activeButtonStyle : buttonStyle}
            >
              <i
                className={`bx ${isFavorite ? 'bxs-star text-amber-500 dark:text-amber-400' : 'bx-star'} text-sm`}
                aria-hidden='true'
              />
            </GhostPillIcon>
            <GhostPillIcon
              onClick={() => (isHibernated ? registry.restoreEntry(entry.key) : registry.hibernateEntry(entry.key))}
              aria-label={isHibernated ? 'Restore tool output' : 'Hibernate tool output'}
              style={buttonStyle}
            >
              <i className={`bx ${isHibernated ? 'bx-play' : 'bx-moon'} text-sm`} aria-hidden='true' />
            </GhostPillIcon>
            <GhostPillIcon
              disabled={isHibernated || isRightDocked}
              onClick={() => toggleFullscreen(entry.key)}
              aria-label={
                isRightDocked
                  ? 'Fullscreen is unavailable while right docked'
                  : isFullscreen
                    ? 'Exit fullscreen tool output'
                    : 'Enter fullscreen tool output'
              }
              style={isFullscreen ? activeButtonStyle : buttonStyle}
            >
              <i className={`bx ${isFullscreen ? 'bx-exit-fullscreen' : 'bx-fullscreen'} text-sm`} aria-hidden='true' />
            </GhostPillIcon>
            {!isCompact && (
              <GhostPillIcon
                disabled={isHibernated}
                onClick={() =>
                  setCollapsedTools(prev => ({
                    ...prev,
                    [entry.key]: !prev[entry.key],
                  }))
                }
                aria-label={isCollapsed ? 'Expand tool output' : 'Collapse tool output'}
                style={isCollapsed ? buttonStyle : activeButtonStyle}
              >
                <i className={`bx ${isCollapsed ? 'bx-chevron-down' : 'bx-chevron-up'} text-sm`} aria-hidden='true' />
              </GhostPillIcon>
            )}
          </div>
        </div>
        {isCompact ? null : isHibernated ? (
          <div className='font-mono text-xs text-neutral-500 dark:text-neutral-600'>
            Hibernated to save resources. Restore to reload.
          </div>
        ) : (
          <>
            {isCollapsed && (
              <div className='font-mono text-xs text-neutral-500 dark:text-neutral-600'>Output collapsed.</div>
            )}
            <div className={`w-full ${iframeHeightClass} ${dockEdgeInsetClass}`} aria-hidden={isCollapsed}>
              {entry.kind === 'mcp' ? (
                <McpAppIframeSlot
                  iframeKey={entry.key}
                  serverName={entry.serverName}
                  qualifiedToolName={entry.qualifiedToolName}
                  resourceUri={entry.resourceUri}
                  toolArgs={entry.toolArgs ?? undefined}
                  toolResult={entry.toolResult ?? undefined}
                  toolDefinition={entry.toolDefinition}
                  reloadToken={entry.reloadToken}
                  className='h-full w-full overflow-hidden'
                  priority={1}
                />
              ) : (
                <HtmlIframeSlot
                  iframeKey={entry.key}
                  html={entry.html}
                  toolName={entry.toolName ?? null}
                  fullHeight
                  className='h-full w-full overflow-hidden'
                  priority={1}
                />
              )}
            </div>
          </>
        )}
      </div>
    )
  }

  const handleClose = isHomepageFullscreen ? closeHomepageFullscreen : onClose
  const resolvedDockWidthPx = isRightDockedLayout
    ? clampDockWidth(dockWidthPx ?? (typeof window !== 'undefined' ? Math.round(window.innerWidth * 0.5) : 720))
    : null
  const modalWrapperClassName = isRightDockedLayout
    ? 'fixed inset-y-0 right-0 z-[1400] flex max-w-full flex-col'
    : 'fixed inset-0 z-[1400] flex flex-col'
  const modalWrapperStyle = isRightDockedLayout
    ? {
        paddingTop: 'var(--titlebar-height, 0px)',
        paddingLeft: '0.5rem',
        boxSizing: 'border-box' as const,
        width: resolvedDockWidthPx ?? undefined,
      }
    : { paddingTop: 'var(--titlebar-height, 0px)', boxSizing: 'border-box' as const }
  const modalPanelClassName = isRightDockedLayout
    ? 'relative w-full h-full bg-white dark:bg-[rgba(15,15,15,1)] flex flex-col overflow-hidden border-l border-neutral-200 dark:border-white/[0.06] shadow-[-24px_0_60px_-32px_rgba(0,0,0,0.45)]'
    : 'relative w-full h-full bg-white/98 dark:bg-[rgba(15,15,15,0.98)] backdrop-blur-[32px] flex flex-col overflow-hidden'

  const useIconOnlyHeaderButtons = isRightDockedLayout && (resolvedDockWidthPx ?? 0) < 760

  const dockResizeShield =
    isRightDockedLayout && isDockResizing
      ? createPortal(
          <div
            className='fixed inset-x-0 bottom-0 z-[3000] cursor-col-resize select-none bg-transparent'
            style={{ top: 'var(--titlebar-height, 0px)' }}
            aria-hidden='true'
            onMouseMove={event => handleDockMouseMove(event.clientX)}
            onMouseUp={stopDockResize}
            onMouseLeave={stopDockResize}
          />,
          document.body
        )
      : null

  const headerContent = (
    <header
      className='flex items-center justify-between px-4 py-3 border-b border-neutral-200 dark:border-white/[0.03] relative z-[1451]'
      style={
        customThemeEnabled
          ? {
              borderColor: htmlToolsModalSurfaceBorder,
              backgroundColor: htmlToolsModalPanelMutedBg,
            }
          : undefined
      }
    >
      <div className='min-w-0'>
        <h2 className='text-lg font-medium text-neutral-900 dark:text-white tracking-tight leading-none truncate'>Task Manager</h2>
        {!useIconOnlyHeaderButtons && (
          <p className='font-mono text-[10px] text-neutral-500 uppercase tracking-[0.15em] mt-1'>Running Apps</p>
        )}
      </div>
      <div className={`flex items-center ${useIconOnlyHeaderButtons ? 'gap-1' : 'gap-2'} shrink-0`}>
        {useIconOnlyHeaderButtons ? (
          <GhostPillIcon
            onClick={() => setShowFavorites(prev => !prev)}
            active={showFavorites}
            aria-pressed={showFavorites}
            aria-label={showFavorites ? 'Hide favorite tools' : 'Show favorite tools'}
            style={showFavorites ? activeButtonStyle : buttonStyle}
          >
            <i
              className={`bx ${showFavorites ? 'bxs-star text-amber-500 dark:text-amber-400' : 'bx-star'}`}
              aria-hidden='true'
            />
          </GhostPillIcon>
        ) : (
          <GhostPill
            onClick={() => setShowFavorites(prev => !prev)}
            active={showFavorites}
            aria-pressed={showFavorites}
            aria-label={showFavorites ? 'Hide favorite tools' : 'Show favorite tools'}
            style={showFavorites ? activeButtonStyle : buttonStyle}
          >
            <i
              className={`bx ${showFavorites ? 'bxs-star text-amber-500 dark:text-amber-400' : 'bx-star'}`}
              aria-hidden='true'
            />
            Favorites{favoriteEntries.length > 0 ? ` (${favoriteEntries.length})` : ''}
          </GhostPill>
        )}

        {useIconOnlyHeaderButtons ? (
          <GhostPillIcon
            onClick={() => setShowHibernated(prev => !prev)}
            active={showHibernated}
            aria-pressed={showHibernated}
            aria-label={showHibernated ? 'Hide hibernated tools' : 'Show hibernated tools'}
            style={showHibernated ? activeButtonStyle : buttonStyle}
          >
            <i className='bx bx-moon' aria-hidden='true' />
          </GhostPillIcon>
        ) : (
          <GhostPill
            onClick={() => setShowHibernated(prev => !prev)}
            active={showHibernated}
            aria-pressed={showHibernated}
            aria-label={showHibernated ? 'Hide hibernated tools' : 'Show hibernated tools'}
            style={showHibernated ? activeButtonStyle : buttonStyle}
          >
            <i className='bx bx-moon' aria-hidden='true' />
            Hibernated{hibernatedEntries.length > 0 ? ` (${hibernatedEntries.length})` : ''}
          </GhostPill>
        )}

        {/* Divider */}
        <div className={`w-px h-4 bg-neutral-300 dark:bg-white/10 ${useIconOnlyHeaderButtons ? 'mx-0.5' : 'mx-1'}`} />

        {useIconOnlyHeaderButtons ? (
          <GhostPillIcon
            onClick={() => setIsRightDocked(prev => !prev)}
            active={isRightDocked}
            aria-pressed={isRightDocked}
            aria-label={isRightDocked ? 'Undock tool viewer' : 'Dock tool viewer to right half'}
            style={isRightDocked ? activeButtonStyle : buttonStyle}
          >
            <i className={`bx ${isRightDocked ? 'bx-exit-fullscreen' : 'bx-sidebar'} text-sm`} aria-hidden='true' />
          </GhostPillIcon>
        ) : (
          <GhostPill
            onClick={() => setIsRightDocked(prev => !prev)}
            active={isRightDocked}
            aria-pressed={isRightDocked}
            aria-label={isRightDocked ? 'Undock tool viewer' : 'Dock tool viewer to right half'}
            style={isRightDocked ? activeButtonStyle : buttonStyle}
          >
            <i className={`bx ${isRightDocked ? 'bx-exit-fullscreen' : 'bx-sidebar'} text-sm`} aria-hidden='true' />
            {isRightDocked ? 'Undock' : 'Dock Right'}
          </GhostPill>
        )}

        <GhostPillIcon
          onClick={() => setShowLimits(prev => !prev)}
          active={showLimits}
          aria-pressed={showLimits}
          aria-label={showLimits ? 'Hide tool limits' : 'Show tool limits'}
          style={showLimits ? activeButtonStyle : buttonStyle}
        >
          <i className='bx bx-slider-alt text-sm' aria-hidden='true' />
        </GhostPillIcon>
        <GhostPillIcon onClick={handleClose} danger aria-label='Close tool viewer' style={buttonStyle}>
          <i className='bx bx-x text-lg' aria-hidden='true' />
        </GhostPillIcon>
      </div>
    </header>
  )

  const limitsContent = showLimits && (
    <div
      className='border-b border-neutral-200 dark:border-white/[0.03] px-4 py-3 relative z-[1451] bg-neutral-50 dark:bg-black/20'
      style={
        customThemeEnabled
          ? {
              borderColor: htmlToolsModalSurfaceBorder,
              backgroundColor: htmlToolsModalPanelMutedBg,
            }
          : undefined
      }
    >
      <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3 text-xs'>
        <label className='flex flex-col gap-1.5'>
          <span className='font-mono text-[10px] uppercase tracking-[0.15em] text-neutral-500'>Max live iframes</span>
          <input
            type='number'
            min={0}
            value={registry.settings.maxActive}
            onChange={event => registry.updateSettings({ maxActive: Number(event.target.value) })}
            className='rounded-lg border border-neutral-200 dark:border-white/[0.05] bg-white dark:bg-white/[0.02] px-3 py-2 text-sm text-neutral-800 dark:text-neutral-200 focus:border-neutral-400 dark:focus:border-white/[0.1] focus:outline-none transition-colors'
          />
        </label>
        <label className='flex flex-col gap-1.5'>
          <span className='font-mono text-[10px] uppercase tracking-[0.15em] text-neutral-500'>Max cached tools</span>
          <input
            type='number'
            min={0}
            value={registry.settings.maxCached}
            onChange={event => registry.updateSettings({ maxCached: Number(event.target.value) })}
            className='rounded-lg border border-neutral-200 dark:border-white/[0.05] bg-white dark:bg-white/[0.02] px-3 py-2 text-sm text-neutral-800 dark:text-neutral-200 focus:border-neutral-400 dark:focus:border-white/[0.1] focus:outline-none transition-colors'
          />
        </label>
        <label className='flex flex-col gap-1.5'>
          <span className='font-mono text-[10px] uppercase tracking-[0.15em] text-neutral-500'>
            Cache TTL (minutes)
          </span>
          <input
            type='number'
            min={0}
            value={registry.settings.ttlMinutes}
            onChange={event => registry.updateSettings({ ttlMinutes: Number(event.target.value) })}
            className='rounded-lg border border-neutral-200 dark:border-white/[0.05] bg-white dark:bg-white/[0.02] px-3 py-2 text-sm text-neutral-800 dark:text-neutral-200 focus:border-neutral-400 dark:focus:border-white/[0.1] focus:outline-none transition-colors'
          />
        </label>
        <label className='flex flex-col gap-1.5'>
          <span className='font-mono text-[10px] uppercase tracking-[0.15em] text-neutral-500'>
            Hibernate after (minutes)
          </span>
          <input
            type='number'
            min={0}
            value={registry.settings.hibernateAfterMinutes}
            onChange={event => registry.updateSettings({ hibernateAfterMinutes: Number(event.target.value) })}
            className='rounded-lg border border-neutral-200 dark:border-white/[0.05] bg-white dark:bg-white/[0.02] px-3 py-2 text-sm text-neutral-800 dark:text-neutral-200 focus:border-neutral-400 dark:focus:border-white/[0.1] focus:outline-none transition-colors'
          />
        </label>
        <label className='flex flex-col gap-1.5'>
          <span className='font-mono text-[10px] uppercase tracking-[0.15em] text-neutral-500'>
            Max cache size (MB)
          </span>
          <input
            type='number'
            min={0}
            value={maxBytesMb}
            onChange={event =>
              registry.updateSettings({
                maxBytes: Number(event.target.value) * 1024 * 1024,
              })
            }
            className='rounded-lg border border-neutral-200 dark:border-white/[0.05] bg-white dark:bg-white/[0.02] px-3 py-2 text-sm text-neutral-800 dark:text-neutral-200 focus:border-neutral-400 dark:focus:border-white/[0.1] focus:outline-none transition-colors'
          />
        </label>
        <div className='flex flex-col gap-1.5 font-mono text-[10px] text-neutral-500 dark:text-neutral-600'>
          <span className='uppercase tracking-[0.15em] text-neutral-500'>Notes</span>
          <span>0 = no limit. Favorites are never evicted.</span>
        </div>
      </div>
    </div>
  )

  const mainContent =
    viewMode === 'tabs' ? (
      <div className='flex-1 flex flex-col overflow-hidden'>
        {/* Tool tab bar */}
        <div
          className='shrink-0 px-4 py-2 bg-neutral-50 dark:bg-black/20 border-b border-neutral-200 dark:border-white/[0.03] overflow-x-auto thin-scrollbar relative z-[1451]'
          style={
            customThemeEnabled
              ? {
                  borderColor: htmlToolsModalSurfaceBorder,
                  backgroundColor: htmlToolsModalPanelMutedBg,
                }
              : undefined
          }
        >
          <div className='flex gap-2'>
            {activeEntries.map(entry => (
              <button
                key={entry.key}
                type='button'
                onClick={() => {
                  setActiveTab(entry.key)
                  registry.touchEntry(entry.key)
                }}
                className={`
                  text-[13px] font-semibold px-3.5 py-1.5 rounded-full
                  transition-all duration-200 cursor-pointer border whitespace-nowrap
                  ${
                    activeKey === entry.key
                      ? 'bg-neutral-200 border-neutral-300 text-neutral-900 dark:bg-white/[0.08] dark:border-white/[0.1] dark:text-white'
                      : 'bg-neutral-100 border-neutral-200 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900 dark:bg-white/[0.02] dark:border-white/[0.05] dark:text-neutral-500 dark:hover:bg-white/[0.05] dark:hover:text-white'
                  }
                `}
                style={activeKey === entry.key ? activeButtonStyle : buttonStyle}
              >
                {displayLabels.get(entry.key) ?? resolveEntryLabel(entry)}
              </button>
            ))}
          </div>
        </div>
        {/* Content area */}
        <div className='flex-1 flex flex-col min-h-0 p-0'>
          {activeEntries.length === 0 ? (
            <div className='flex-1 flex items-center justify-center border border-dashed border-neutral-300 dark:border-white/[0.05] rounded-2xl'>
              <span className='font-mono text-xs text-neutral-400 dark:text-neutral-700'>
                awaiting_output_stream_from_server...
              </span>
            </div>
          ) : (
            activeEntries.map(entry => {
              const isActive = entry.key === activeKey
              return (
                <div
                  key={entry.key}
                  className={isActive ? 'flex-1 flex flex-col min-h-0' : 'hidden'}
                  aria-hidden={!isActive}
                >
                  {renderEntry(entry, { fillHeight: true })}
                </div>
              )
            })
          )}
        </div>
        {/* Favorites panel */}
        {showFavorites && (
          <div
            className='shrink-0 border-t border-amber-200 dark:border-amber-500/20 bg-neutral-50/80 dark:bg-amber-500/[0.03] p-3 max-h-[40vh] overflow-y-auto space-y-3 relative z-[1451]'
            style={
              customThemeEnabled
                ? {
                    borderColor: htmlToolsModalSurfaceBorder,
                    backgroundColor: htmlToolsModalPanelMutedBg,
                  }
                : undefined
            }
          >
            <div className='font-mono text-[10px] uppercase tracking-[0.15em] text-amber-600 dark:text-amber-500 flex items-center gap-2'>
              <i className='bx bxs-star' aria-hidden='true' />
              Favorite tools (never removed or hibernated)
            </div>
            {favoriteEntries.length === 0 ? (
              <div className='font-mono text-xs text-neutral-500 dark:text-neutral-600'>
                No favorite tools. Click the star icon on any tool to add it to favorites.
              </div>
            ) : (
              favoriteEntries.map(entry => (
                <React.Fragment key={entry.key}>{renderEntry(entry, { compactView: true, showLabel: true })}</React.Fragment>
              ))
            )}
          </div>
        )}
        {/* Hibernated panel */}
        {showHibernated && (
          <div
            className='shrink-0 border-t border-neutral-200 dark:border-white/[0.03] bg-neutral-50 dark:bg-black/20 p-3 max-h-[40vh] overflow-y-auto space-y-3 relative z-[1451]'
            style={
              customThemeEnabled
                ? {
                    borderColor: htmlToolsModalSurfaceBorder,
                    backgroundColor: htmlToolsModalPanelMutedBg,
                  }
                : undefined
            }
          >
            <div className='font-mono text-[10px] uppercase tracking-[0.15em] text-neutral-500'>Hibernated tools</div>
            {hibernatedEntries.length === 0 ? (
              <div className='font-mono text-xs text-neutral-500 dark:text-neutral-600'>No hibernated tools.</div>
            ) : (
              hibernatedEntries.map(entry => <React.Fragment key={entry.key}>{renderEntry(entry, { showLabel: true })}</React.Fragment>)
            )}
          </div>
        )}
      </div>
    ) : (
      <div className='flex-1 overflow-y-auto px-0 py-2 space-y-2'>
        {activeEntries.length === 0 ? (
          <div className='flex-1 flex items-center justify-center h-[300px] border border-dashed border-neutral-300 dark:border-white/[0.05] rounded-2xl'>
            <span className='font-mono text-xs text-neutral-400 dark:text-neutral-700'>
              awaiting_output_stream_from_server...
            </span>
          </div>
        ) : (
          activeEntries.map(entry => <React.Fragment key={entry.key}>{renderEntry(entry)}</React.Fragment>)
        )}
        {showFavorites && (
          <div
            className='border-t border-amber-200 dark:border-amber-500/20 bg-amber-50 dark:bg-amber-500/[0.03] pt-3 space-y-3 relative z-[1451]'
            style={
              customThemeEnabled
                ? {
                    borderColor: htmlToolsModalSurfaceBorder,
                    backgroundColor: htmlToolsModalPanelMutedBg,
                  }
                : undefined
            }
          >
            <div className='font-mono text-[10px] uppercase tracking-[0.15em] text-amber-600 dark:text-amber-500 flex items-center gap-2'>
              <i className='bx bxs-star' aria-hidden='true' />
              Favorite tools (never removed or hibernated)
            </div>
            {favoriteEntries.length === 0 ? (
              <div className='font-mono text-xs text-neutral-500 dark:text-neutral-600'>
                No favorite tools. Click the star icon on any tool to add it to favorites.
              </div>
            ) : (
              favoriteEntries.map(entry => (
                <React.Fragment key={entry.key}>{renderEntry(entry, { compactView: true, showLabel: true })}</React.Fragment>
              ))
            )}
          </div>
        )}
        {showHibernated && (
          <div
            className='border-t border-neutral-200 dark:border-white/[0.03] bg-neutral-50 dark:bg-black/20 pt-3 space-y-3 relative z-[1451]'
            style={
              customThemeEnabled
                ? {
                    borderColor: htmlToolsModalSurfaceBorder,
                    backgroundColor: htmlToolsModalPanelMutedBg,
                  }
                : undefined
            }
          >
            <div className='font-mono text-[10px] uppercase tracking-[0.15em] text-neutral-500'>Hibernated tools</div>
            {hibernatedEntries.length === 0 ? (
              <div className='font-mono text-xs text-neutral-500 dark:text-neutral-600'>No hibernated tools.</div>
            ) : (
              hibernatedEntries.map(entry => <React.Fragment key={entry.key}>{renderEntry(entry, { showLabel: true })}</React.Fragment>)
            )}
          </div>
        )}
      </div>
    )

  // Homepage fullscreen mode
  if (isHomepageFullscreen) {
    return (
      <div
        className='fixed inset-0 z-[1400] flex flex-col bg-white/98 dark:bg-[rgba(15,15,15,0.98)] backdrop-blur-[32px]'
        style={{
          paddingTop: 'var(--titlebar-height, 0px)',
          boxSizing: 'border-box',
          ...(customThemeEnabled ? { backgroundColor: htmlToolsModalSurfaceBg } : {}),
        }}
      >
        {/* Minimalistic titlebar with tabs */}
        <div
          className='flex items-center h-10 px-3 bg-transparent shrink-0 app-region-drag border-b border-neutral-200 dark:border-white/[0.03]'
          style={
            customThemeEnabled
              ? {
                  borderColor: htmlToolsModalSurfaceBorder,
                  backgroundColor: htmlToolsModalPanelMutedBg,
                }
              : undefined
          }
        >
          {/* Tabs - scrollable horizontally */}
          <div className='flex-1 flex items-center gap-1.5 overflow-x-auto no-scrollbar app-region-no-drag'>
            {activeEntries.map(entry => {
              const isActive = entry.key === activeKey
              return (
                <div key={entry.key} className='relative flex items-center group shrink-0'>
                  <button
                    type='button'
                    onClick={() => {
                      setActiveTab(entry.key)
                      registry.touchEntry(entry.key)
                    }}
                    className={`
                      font-mono text-[11px] px-3 py-1.5 rounded-full
                      transition-all duration-200 cursor-pointer border whitespace-nowrap
                      ${
                        isActive
                          ? 'bg-neutral-200 border-neutral-300 text-neutral-900 dark:bg-white/[0.08] dark:border-white/[0.1] dark:text-white'
                          : 'bg-transparent border-transparent text-neutral-500 hover:bg-neutral-100 dark:hover:bg-white/[0.03] hover:text-neutral-700 dark:hover:text-neutral-300'
                      }
                    `}
                    style={isActive ? activeButtonStyle : buttonStyle}
                  >
                    <span className='flex items-center gap-1.5'>
                      {entry.favorite && <i className='bx bxs-star text-amber-500 dark:text-amber-400 text-[10px]' />}
                      {displayLabels.get(entry.key) || resolveEntryLabel(entry)}
                    </span>
                  </button>
                  {/* Tab context menu trigger */}
                  <button
                    type='button'
                    onClick={e => {
                      e.stopPropagation()
                      if (showFullscreenTabMenu === entry.key) {
                        setShowFullscreenTabMenu(null)
                        setTabMenuPosition(null)
                      } else {
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                        setTabMenuPosition({ top: rect.bottom + 4, left: rect.left })
                        setShowFullscreenTabMenu(entry.key)
                      }
                    }}
                    className='opacity-0 group-hover:opacity-100 ml-0.5 p-1 rounded-full hover:bg-neutral-200 dark:hover:bg-white/[0.05] transition-all'
                  >
                    <i className='bx bx-dots-vertical-rounded text-xs text-neutral-500' />
                  </button>
                  {/* Tab dropdown menu */}
                  {showFullscreenTabMenu === entry.key &&
                    tabMenuPosition &&
                    createPortal(
                      <div
                        ref={tabMenuRef}
                        className='fixed z-[1500] min-w-[160px] rounded-xl border border-neutral-200 dark:border-white/[0.08] bg-white/95 dark:bg-[rgba(15,15,15,0.95)] backdrop-blur-xl shadow-lg dark:shadow-[0_20px_50px_-10px_rgba(0,0,0,0.5)] py-1.5'
                        style={{
                          top: `${tabMenuPosition.top}px`,
                          left: `${tabMenuPosition.left}px`,
                          ...(customThemeEnabled
                            ? {
                                borderColor: htmlToolsModalSurfaceBorder,
                                backgroundColor: htmlToolsModalSurfaceBg,
                              }
                            : {}),
                        }}
                      >
                        <button
                          type='button'
                          className='w-full px-3 py-2 text-left font-mono text-[11px] flex items-center gap-2.5 hover:bg-neutral-100 dark:hover:bg-white/[0.05] text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors'
                          onClick={() => {
                            registry.toggleFavorite(entry.key)
                            setShowFullscreenTabMenu(null)
                          }}
                        >
                          <i
                            className={`bx ${entry.favorite ? 'bxs-star text-amber-500 dark:text-amber-400' : 'bx-star'}`}
                          />
                          {entry.favorite ? 'Remove favorite' : 'Add to favorites'}
                        </button>
                        <button
                          type='button'
                          className='w-full px-3 py-2 text-left font-mono text-[11px] flex items-center gap-2.5 hover:bg-neutral-100 dark:hover:bg-white/[0.05] text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors'
                          onClick={() => {
                            registry.hibernateEntry(entry.key)
                            setShowFullscreenTabMenu(null)
                          }}
                        >
                          <i className='bx bx-moon' />
                          Hibernate
                        </button>
                        <button
                          type='button'
                          className='w-full px-3 py-2 text-left font-mono text-[11px] flex items-center gap-2.5 hover:bg-red-50 dark:hover:bg-red-500/10 text-red-600 dark:text-red-400 transition-colors'
                          onClick={() => {
                            registry.removeEntry(entry.key)
                            setShowFullscreenTabMenu(null)
                          }}
                        >
                          <i className='bx bx-trash' />
                          Remove
                        </button>
                      </div>,
                      document.body
                    )}
                </div>
              )
            })}
            {/* Hibernated indicator */}
            {hibernatedEntries.length > 0 && (
              <button
                type='button'
                onClick={() => setShowHibernated(!showHibernated)}
                className='px-2 py-1 font-mono text-[10px] text-neutral-500 dark:text-neutral-600 hover:text-neutral-700 dark:hover:text-neutral-400 flex items-center gap-1 transition-colors'
              >
                <i className='bx bx-moon' />
                {hibernatedEntries.length}
              </button>
            )}
          </div>

          {/* Right side controls */}
          <div className='flex items-center gap-1 shrink-0 app-region-no-drag'>
            {/* Settings dropdown */}
            <div className='relative' ref={settingsRef}>
              <button
                type='button'
                data-settings-trigger
                onClick={() => setShowFullscreenSettings(!showFullscreenSettings)}
                className='p-1.5 rounded-full hover:bg-neutral-200 dark:hover:bg-white/[0.05] text-neutral-500 hover:text-neutral-900 dark:hover:text-white transition-colors'
                style={buttonStyle}
              >
                <i className='bx bx-cog text-sm' />
              </button>
              {showFullscreenSettings &&
                createPortal(
                  <div
                    ref={settingsDropdownRef}
                    className='fixed w-60 rounded-xl border border-neutral-200 dark:border-white/[0.08] bg-white/95 dark:bg-[rgba(15,15,15,0.95)] backdrop-blur-xl shadow-lg dark:shadow-[0_20px_50px_-10px_rgba(0,0,0,0.5)] py-2 z-[1500]'
                    style={{
                      top: `${(document.querySelector('[data-settings-trigger]') as HTMLElement)?.getBoundingClientRect().bottom ?? 44}px`,
                      right: `${window.innerWidth - ((document.querySelector('[data-settings-trigger]') as HTMLElement)?.getBoundingClientRect().right ?? 100)}px`,
                      ...(customThemeEnabled
                        ? {
                            borderColor: htmlToolsModalSurfaceBorder,
                            backgroundColor: htmlToolsModalSurfaceBg,
                          }
                        : {}),
                    }}
                  >
                    <div className='px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-600'>
                      Settings
                    </div>
                    <label className='flex items-center justify-between px-3 py-2.5 hover:bg-neutral-100 dark:hover:bg-white/[0.03] transition-colors'>
                      <span className='font-mono text-[11px] text-neutral-600 dark:text-neutral-400'>
                        Max live iframes
                      </span>
                      <input
                        type='number'
                        min={0}
                        value={registry.settings.maxActive}
                        onChange={e => registry.updateSettings({ maxActive: Number(e.target.value) })}
                        className='w-14 px-2 py-1 font-mono text-[11px] rounded-lg border border-neutral-200 dark:border-white/[0.05] bg-white dark:bg-white/[0.02] text-right text-neutral-800 dark:text-neutral-200 focus:border-neutral-400 dark:focus:border-white/[0.1] focus:outline-none'
                      />
                    </label>
                    <label className='flex items-center justify-between px-3 py-2.5 hover:bg-neutral-100 dark:hover:bg-white/[0.03] transition-colors'>
                      <span className='font-mono text-[11px] text-neutral-600 dark:text-neutral-400'>
                        Auto-hibernate (min)
                      </span>
                      <input
                        type='number'
                        min={0}
                        value={registry.settings.hibernateAfterMinutes}
                        onChange={e => registry.updateSettings({ hibernateAfterMinutes: Number(e.target.value) })}
                        className='w-14 px-2 py-1 font-mono text-[11px] rounded-lg border border-neutral-200 dark:border-white/[0.05] bg-white dark:bg-white/[0.02] text-right text-neutral-800 dark:text-neutral-200 focus:border-neutral-400 dark:focus:border-white/[0.1] focus:outline-none'
                      />
                    </label>
                    {hibernatedEntries.length > 0 && (
                      <>
                        <div className='my-1.5 border-t border-neutral-200 dark:border-white/[0.05]' />
                        <div className='px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-600'>
                          Hibernated ({hibernatedEntries.length})
                        </div>
                        {hibernatedEntries.map(entry => (
                          <button
                            key={entry.key}
                            type='button'
                            className='w-full px-3 py-2 text-left font-mono text-[11px] flex items-center gap-2.5 hover:bg-neutral-100 dark:hover:bg-white/[0.03] text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors'
                            onClick={() => {
                              registry.restoreEntry(entry.key)
                              setActiveTab(entry.key)
                            }}
                          >
                            <i className='bx bx-play' />
                            <span className='truncate flex-1'>{resolveEntryLabel(entry)}</span>
                          </button>
                        ))}
                      </>
                    )}
                  </div>,
                  document.body
                )}
            </div>
            {/* Close button */}
            <button
              type='button'
              onClick={closeHomepageFullscreen}
              className='p-1.5 rounded-full hover:bg-red-50 dark:hover:bg-red-500/10 text-neutral-500 hover:text-red-600 dark:hover:text-red-400 transition-colors'
              style={buttonStyle}
            >
              <i className='bx bx-x text-lg' />
            </button>
          </div>
        </div>

        {/* App content - full size */}
        <div className='flex-1 min-h-0 relative'>
          {activeEntries.length === 0 ? (
            <div className='flex items-center justify-center h-full text-neutral-400 dark:text-neutral-700'>
              <div className='text-center'>
                <i className='bx bx-code-block text-4xl mb-2' />
                <p className='font-mono text-xs'>No active apps</p>
              </div>
            </div>
          ) : (
            activeEntries.map(entry => (
              <div
                key={entry.key}
                data-tab-key={entry.key}
                className={`absolute inset-0 ${entry.key === activeKey ? 'block' : 'hidden'}`}
              >
                {entry.kind === 'mcp' ? (
                  <McpAppIframeSlot
                    iframeKey={entry.key}
                    serverName={entry.serverName}
                    qualifiedToolName={entry.qualifiedToolName}
                    resourceUri={entry.resourceUri}
                    toolArgs={entry.toolArgs ?? undefined}
                    toolResult={entry.toolResult ?? undefined}
                    toolDefinition={entry.toolDefinition}
                    reloadToken={entry.reloadToken}
                    className='h-full w-full'
                    priority={1}
                  />
                ) : (
                  <HtmlIframeSlot
                    iframeKey={entry.key}
                    html={entry.html}
                    toolName={entry.toolName ?? null}
                    fullHeight
                    className='h-full w-full'
                    priority={1}
                  />
                )}
              </div>
            ))
          )}
        </div>
      </div>
    )
  }

  if (!isOpen) return null

  // Main modal view
  return (
    <>
      {dockResizeShield}
      <div className={modalWrapperClassName} style={modalWrapperStyle}>
        {isRightDockedLayout && (
          <div
            role='separator'
            aria-orientation='vertical'
            aria-label='Resize docked tool viewer'
            className='absolute left-0 top-0 h-full w-2 z-[1452] dark:bg-neutral-900 bg-neutral-50 hover:dark:bg-neutral-800 hover:bg-neutral-200 cursor-col-resize select-none'
            style={{
            border: 'none',
            outline: 'none',
            margin: 0,
            padding: 0,
            top: 'var(--titlebar-height, 0px)',
            height: 'calc(100% - var(--titlebar-height, 0px))',
          }}
            onMouseDown={startDockResize}
            title='Drag to resize'
          />
        )}
        {/* Fullscreen viewer */}
        <div
          className={modalPanelClassName}
          role='dialog'
          aria-modal='true'
          aria-label='HTML tool viewer'
          style={
            customThemeEnabled
              ? {
                  backgroundColor: htmlToolsModalSurfaceBg,
                  borderColor: htmlToolsModalSurfaceBorder,
                }
              : undefined
          }
        >
          {headerContent}
          {limitsContent}
          {mainContent}
        </div>
      </div>
    </>
  )
}
