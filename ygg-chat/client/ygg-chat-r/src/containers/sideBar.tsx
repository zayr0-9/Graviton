import { useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { ConversationId, Project } from '../../../../shared/types'
import { Button } from '../components'
import SearchList, { type SearchResultItem } from '../components/SearchList/SearchList'
import { chatSliceActions } from '../features/chats'
import {
  activeConversationIdSet,
  Conversation,
  createConversation,
  deleteConversation,
} from '../features/conversations'
import { deleteProject } from '../features/projects'
import { type ConversationTab } from '../helpers/sidebarPreferences'
import EditProject from './EditProject'
// import { searchActions, selectSearchLoading, selectSearchQuery, selectSearchResults } from '../features/search'
import { useAppDispatch } from '../hooks/redux'
import { useAuth } from '../hooks/useAuth'
import {
  useConversationsByProject,
  useFavoritedConversations,
  useLocalTopLevelUserMessages,
  useMoveConversationToProject,
  useProjects,
  useSearchTopLevelUserMessages,
} from '../hooks/useQueries'
import { localApi } from '../utils/api'

type SidebarProject = Project & {
  latest_conversation_updated_at?: string | null
  description?: string
}

interface SideBarProps {
  limit?: number
  className?: string
  projects?: SidebarProject[]
  activeConversationId?: ConversationId | null
}

const LOCAL_MODE_RECENT_PROJECTS_LIMIT = 100
const SIDEBAR_RAIL_WIDTH_PX = 60
const SIDEBAR_PORTAL_GAP_PX = 10
const SIDEBAR_PORTAL_MAX_WIDTH_PX = 420
const SIDEBAR_PREVIEW_PORTAL_GAP_PX = 12
const SIDEBAR_PREVIEW_PORTAL_MAX_WIDTH_PX = 440
const SIDEBAR_PREVIEW_PORTAL_MIN_WIDTH_PX = 260
const SIDEBAR_PREVIEW_CLOSE_DELAY_MS = 120

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

const formatDate = (value?: string | null) => {
  if (!value) return null
  const parsedDate = new Date(value)
  if (Number.isNaN(parsedDate.getTime())) return null
  return DATE_FORMATTER.format(parsedDate)
}

const PROJECT_ROW_VISIBILITY_STYLE: React.CSSProperties = {
  contentVisibility: 'auto',
  containIntrinsicSize: '52px',
}

const CONVERSATION_ROW_VISIBILITY_STYLE: React.CSSProperties = {
  contentVisibility: 'auto',
  containIntrinsicSize: '44px',
}

interface ProjectAccordionItemProps {
  project: SidebarProject
  isExpanded: boolean
  isCollapsed: boolean
  activeConversationId: ConversationId | null
  favoriteConversationIds: Set<ConversationId>
  hoveredPreviewConversationId?: ConversationId | null
  isElectronMode: boolean
  onToggle: (projectId: string) => void
  onSelectConversation: (conversation: Conversation) => void
  onCreateConversation: (project: SidebarProject) => void
  onEditProject: (project: SidebarProject) => void
  onDeleteProject: (project: SidebarProject) => void
  onToggleFavorite: (conversation: Conversation) => void
  onMoveConversation: (conversation: Conversation) => void
  onDeleteConversation: (conversation: Conversation) => void
  enableConversationHoverPreview?: boolean
  onConversationHoverStart?: (conversation: Conversation) => void
  onConversationHoverEnd?: () => void
}

interface ProjectConversationsPanelProps {
  projectId: Project['id']
  activeConversationId: ConversationId | null
  favoriteConversationIds: Set<ConversationId>
  hoveredPreviewConversationId?: ConversationId | null
  isElectronMode: boolean
  onSelectConversation: (conversation: Conversation) => void
  onToggleFavorite: (conversation: Conversation) => void
  onMoveConversation: (conversation: Conversation) => void
  onDeleteConversation: (conversation: Conversation) => void
  enableConversationHoverPreview?: boolean
  onConversationHoverStart?: (conversation: Conversation) => void
  onConversationHoverEnd?: () => void
}

const ProjectConversationsPanel: React.FC<ProjectConversationsPanelProps> = memo(
  ({
    projectId,
    activeConversationId,
    favoriteConversationIds,
    hoveredPreviewConversationId = null,
    isElectronMode,
    onSelectConversation,
    onToggleFavorite,
    onMoveConversation,
    onDeleteConversation,
    enableConversationHoverPreview = false,
    onConversationHoverStart,
    onConversationHoverEnd,
  }) => {
    const {
      data: projectConversations = [],
      isLoading: projectConversationsLoading,
      error: projectConversationsError,
    } = useConversationsByProject(projectId)

    const sortedConversations = useMemo(() => {
      return [...projectConversations].sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      )
    }, [projectConversations])

    return (
      <div className='pb-2 pr-2 pl-8'>
        {projectConversationsLoading && (
          <div className='text-xs text-neutral-500 dark:text-neutral-400 py-1'>Loading chats...</div>
        )}
        {projectConversationsError && (
          <div className='text-xs text-red-500 dark:text-red-400 py-1'>Failed to load chats</div>
        )}
        {!projectConversationsLoading && !projectConversationsError && sortedConversations.length === 0 && (
          <div className='text-xs text-neutral-500 dark:text-neutral-400 py-1'>No chats yet</div>
        )}
        {!projectConversationsLoading &&
          !projectConversationsError &&
          sortedConversations.map(conversation => {
            const isActive = String(activeConversationId) === String(conversation.id)
            const isFavorite = favoriteConversationIds.has(conversation.id)
            const isPreviewHighlighted =
              enableConversationHoverPreview &&
              hoveredPreviewConversationId != null &&
              String(hoveredPreviewConversationId) === String(conversation.id)
            const conversationUpdatedDate = formatDate(conversation.updated_at)

            return (
              <div
                key={conversation.id}
                className='group/conv flex items-start gap-1 mb-1 min-w-0 overflow-hidden'
                style={CONVERSATION_ROW_VISIBILITY_STYLE}
                onMouseEnter={() => {
                  if (!enableConversationHoverPreview) return
                  onConversationHoverStart?.(conversation)
                }}
                onMouseLeave={() => {
                  if (!enableConversationHoverPreview) return
                  onConversationHoverEnd?.()
                }}
              >
                <button
                  type='button'
                  onClick={() => onSelectConversation(conversation)}
                  className={`w-full min-w-0 overflow-hidden text-left rounded-md px-2 py-1.5 text-xs md:text-[11px] lg:text-[12px] transition-colors ${
                    isActive
                      ? 'bg-blue-100 dark:bg-neutral-500/40 text-blue-700 dark:text-orange-300'
                      : isPreviewHighlighted
                        ? 'text-neutral-700 dark:text-neutral-300 bg-neutral-200/60 dark:bg-neutral-800/70'
                        : 'text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200/60 dark:hover:bg-neutral-800/70'
                  }`}
                >
                  <div className='min-w-0'>
                    <div className='truncate'>{conversation.title || 'Untitled conversation'}</div>
                    {conversationUpdatedDate && (
                      <div className='text-[10px] text-neutral-500 dark:text-neutral-400 mt-0.5 truncate'>
                        {conversationUpdatedDate}
                      </div>
                    )}
                  </div>
                </button>
                {isElectronMode && (
                  <Button
                    variant='outline2'
                    size='smaller'
                    rounded='full'
                    className='mt-0.5 px-1 py-1 shrink-0'
                    onClick={() => onToggleFavorite(conversation)}
                    title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                    aria-label={`${isFavorite ? 'Remove' : 'Add'} ${conversation.title || conversation.id} ${isFavorite ? 'from' : 'to'} favorites`}
                  >
                    <i
                      className={`bx ${isFavorite ? 'bxs-star' : 'bx-star'} text-[16px] pointer-events-none group-hover/conv:opacity-100 opacity-0 group-hover/conv:pointer-events-auto group-focus-within/conv:opacity-100 group-focus-within/conv:pointer-events-auto  ${isFavorite ? 'text-yellow-500' : ''}`}
                      aria-hidden='true'
                    ></i>
                  </Button>
                )}
                <Button
                  variant='outline2'
                  size='smaller'
                  rounded='full'
                  className='mt-0.5 px-2 py-1 shrink-0 opacity-0 pointer-events-none group-hover/conv:opacity-100 group-hover/conv:pointer-events-auto group-focus-within/conv:opacity-100 group-focus-within/conv:pointer-events-auto transition-opacity duration-150'
                  onClick={() => onMoveConversation(conversation)}
                  title='Conversation actions'
                  aria-label={`Conversation actions for ${conversation.title || conversation.id}`}
                >
                  <i className='bx bx-dots-horizontal-rounded text-lg' aria-hidden='true'></i>
                </Button>
                <Button
                  variant='outline2'
                  size='smaller'
                  rounded='full'
                  className='mt-0.5 px-2 py-1 shrink-0 text-red-500 dark:text-red-400 opacity-0 pointer-events-none group-hover/conv:opacity-100 group-hover/conv:pointer-events-auto group-focus-within/conv:opacity-100 group-focus-within/conv:pointer-events-auto transition-opacity duration-150'
                  onClick={() => onDeleteConversation(conversation)}
                  title='Delete conversation'
                  aria-label={`Delete conversation ${conversation.title || conversation.id}`}
                >
                  <i className='bx bx-trash text-lg' aria-hidden='true'></i>
                </Button>
              </div>
            )
          })}
      </div>
    )
  }
)

ProjectConversationsPanel.displayName = 'ProjectConversationsPanel'

const ProjectAccordionItem: React.FC<ProjectAccordionItemProps> = memo(
  ({
    project,
    isExpanded,
    isCollapsed,
    activeConversationId,
    favoriteConversationIds,
    hoveredPreviewConversationId = null,
    isElectronMode,
    onToggle,
    onSelectConversation,
    onCreateConversation,
    onEditProject,
    onDeleteProject,
    onToggleFavorite,
    onMoveConversation,
    onDeleteConversation,
    enableConversationHoverPreview = false,
    onConversationHoverStart,
    onConversationHoverEnd,
  }) => {
    const projectLastActivityDate =
      project.latest_conversation_updated_at || project.updated_at || project.created_at || null
    const projectLastActivityDateLabel = formatDate(projectLastActivityDate)

    return (
      <div
        className='sm:mb-1 md:mb-1 lg:mb-1.5 2xl:mb-2 group relative overflow-hidden'
        style={PROJECT_ROW_VISIBILITY_STYLE}
      >
        {isCollapsed ? (
          <div
            role='button'
            tabIndex={0}
            onClick={() => onToggle(project.id)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onToggle(project.id)
              }
            }}
            className='w-full text-left rounded-lg transition-all duration-200 cursor-pointer py-2 flex items-center hover:scale-90 justify-center'
            title={project.name}
          >
            <Button
              variant='outline2'
              size='circle'
              rounded='full'
              className='h-10 w-10 text-md font-semibold text-lg md:text-base lg:text-sm xl:text-sm 2xl:text-lg'
            >
              {project.name ? project.name.charAt(0).toUpperCase() : '#'}
            </Button>
          </div>
        ) : (
          <div className='rounded-lg hover:bg-stone-100/30 dark:hover:bg-yBlack-900/10 transition-all duration-200'>
            <div className='flex items-start justify-between px-2 py-2 gap-2 min-w-0'>
              <button
                type='button'
                onClick={() => onToggle(project.id)}
                className='flex items-start gap-2 min-w-0 flex-1 text-left'
                aria-expanded={isExpanded}
              >
                <i
                  className={`bx ${isExpanded ? 'bx-chevron-down' : 'bx-chevron-right'} text-neutral-500 text-lg mt-0.5`}
                  aria-hidden='true'
                ></i>
                <div className='min-w-0 flex-1'>
                  <div className='flex items-center gap-1 min-w-0'>
                    <div className='text-[12px] md:text-[12px] lg:text-[13px] xl:text-[13px] 2xl:text-[14px] font-medium text-neutral-900 dark:text-stone-200 truncate min-w-0 flex-1'>
                      {project.name}
                    </div>
                    {project.storage_mode !== 'local' && (
                      <i
                        className='bx bx-cloud text-[14px] text-blue-500 shrink-0'
                        aria-label='Cloud project'
                        title='Cloud project'
                      ></i>
                    )}
                  </div>
                  {projectLastActivityDateLabel && (
                    <div className='text-[10px] text-neutral-500 dark:text-neutral-400'>
                      {projectLastActivityDateLabel}
                    </div>
                  )}
                </div>
              </button>
              <div className='flex items-center gap-1 shrink-0'>
                <Button
                  variant='outline2'
                  size='smaller'
                  rounded='full'
                  className='mt-0.5 px-2 py-1 shrink-0'
                  onClick={() => onCreateConversation(project)}
                  title='New chat in project'
                  aria-label={`Create new chat in ${project.name}`}
                >
                  <i className='bx bx-plus text-lg' aria-hidden='true'></i>
                </Button>
                <Button
                  variant='outline2'
                  size='smaller'
                  rounded='full'
                  className='mt-0.5 px-2 py-1 shrink-0 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-opacity duration-150'
                  onClick={() => onEditProject(project)}
                  title='Edit project'
                  aria-label={`Edit project ${project.name}`}
                >
                  <i className='bx bx-edit text-lg' aria-hidden='true'></i>
                </Button>
                <Button
                  variant='outline2'
                  size='smaller'
                  rounded='full'
                  className='mt-0.5 px-2 py-1 text-red-500 dark:text-red-400 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-opacity duration-150'
                  onClick={() => onDeleteProject(project)}
                  title='Delete project'
                  aria-label={`Delete project ${project.name}`}
                >
                  <i className='bx bx-trash text-lg' aria-hidden='true'></i>
                </Button>
              </div>
            </div>

            {isExpanded && (
              <ProjectConversationsPanel
                projectId={project.id}
                activeConversationId={activeConversationId}
                favoriteConversationIds={favoriteConversationIds}
                hoveredPreviewConversationId={hoveredPreviewConversationId}
                isElectronMode={isElectronMode}
                onSelectConversation={onSelectConversation}
                onToggleFavorite={onToggleFavorite}
                onMoveConversation={onMoveConversation}
                onDeleteConversation={onDeleteConversation}
                enableConversationHoverPreview={enableConversationHoverPreview}
                onConversationHoverStart={onConversationHoverStart}
                onConversationHoverEnd={onConversationHoverEnd}
              />
            )}
          </div>
        )}

        {isCollapsed && (
          <div className='absolute left-full ml-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-50'>
            <div className='bg-neutral-900 dark:bg-neutral-700 text-white dark:text-neutral-100 px-3 py-2 rounded-lg shadow-lg text-sm whitespace-nowrap max-w-xs'>
              <div className='font-medium flex items-center gap-1'>
                <span>{project.name}</span>
                {project.storage_mode !== 'local' && (
                  <i className='bx bx-cloud text-[14px] text-blue-300' title='Cloud project'></i>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }
)

ProjectAccordionItem.displayName = 'ProjectAccordionItem'

const SideBar: React.FC<SideBarProps> = ({
  limit = 100,
  className = '',
  projects = [],
  activeConversationId = null,
}) => {
  const dispatch = useAppDispatch()
  const { userId } = useAuth()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const isWeb = import.meta.env.VITE_ENVIRONMENT === 'web'
  const isElectronMode =
    import.meta.env.VITE_ENVIRONMENT === 'electron' ||
    (typeof process !== 'undefined' && process.env?.VITE_ENVIRONMENT === 'electron')

  const [conversationTab, setConversationTab] = useState<ConversationTab>('recent')
  const [showEditProjectModal, setShowEditProjectModal] = useState(false)
  const [editingProject, setEditingProject] = useState<SidebarProject | null>(null)
  const [showMoveModal, setShowMoveModal] = useState(false)
  const [showMoveConfirm, setShowMoveConfirm] = useState(false)
  const [conversationToMove, setConversationToMove] = useState<Conversation | null>(null)
  const [destinationProject, setDestinationProject] = useState<{ id: string; name: string } | null>(null)
  const moveConversationMutation = useMoveConversationToProject()
  // NOTE: 'recent' tab is repurposed as the Projects tab across the app.
  const isProjectsTab = conversationTab !== 'favorites'

  // Track expanded projects in chat sidebar (lazy-load conversations per project)
  const [expandedProjectIds, setExpandedProjectIds] = useState<string[]>([])
  const expandedProjectIdSet = useMemo(() => new Set(expandedProjectIds), [expandedProjectIds])

  // Fetch projects using React Query
  const { data: fetchedProjects = [], isLoading: projectsLoading, error: projectsError } = useProjects()
  const projectData = projects.length > 0 ? projects : fetchedProjects

  const visibleProjects = useMemo(() => {
    if (isWeb) return projectData

    let localProjectsShown = 0
    return projectData.filter(project => {
      if (project.storage_mode !== 'local') return true
      localProjectsShown += 1
      return localProjectsShown <= LOCAL_MODE_RECENT_PROJECTS_LIMIT
    })
  }, [projectData, isWeb])

  // Default expand only the latest visible project. Keep user-expanded projects if still visible.
  useEffect(() => {
    setExpandedProjectIds(prevExpanded => {
      const visibleIds = new Set(visibleProjects.map(project => String(project.id)))
      const preserved = prevExpanded.filter(id => visibleIds.has(String(id)))
      if (preserved.length > 0) return preserved
      if (visibleProjects.length === 0) return []
      return [String(visibleProjects[0].id)]
    })
  }, [visibleProjects])

  // Keep favorites tab available across all routes
  const {
    data: favoriteConversations = [],
    isLoading: favoritesLoading,
    error: favoritesError,
  } = useFavoritedConversations(null)

  const displayedFavoriteConversations = useMemo(() => {
    if (typeof limit !== 'number' || !Number.isFinite(limit)) return favoriteConversations
    return favoriteConversations.slice(0, limit)
  }, [favoriteConversations, limit])

  const favoriteConversationIds = useMemo(
    () => new Set(favoriteConversations.map(conversation => conversation.id)),
    [favoriteConversations]
  )

  const loading = isProjectsTab ? projectsLoading : favoritesLoading
  const error = isProjectsTab
    ? projectsError
      ? String(projectsError)
      : null
    : favoritesError
      ? String(favoritesError)
      : null

  const [searchQuery, setSearchQuery] = useState('')
  const {
    search,
    clearSearch,
    searchResults: searchedTopLevelMessages,
    isSearching,
  } = useSearchTopLevelUserMessages(null, { forceServerSearch: true })

  const projectNameById = useMemo(() => {
    return new Map(projectData.map(project => [String(project.id), project.name]))
  }, [projectData])

  const sidebarSearchResults = useMemo<SearchResultItem[]>(() => {
    return searchedTopLevelMessages.map(result => {
      const projectName = result.project_id ? projectNameById.get(String(result.project_id)) : null
      const notePrefix = result.note ? `${result.note}\n` : ''
      const contentPreview = `${notePrefix}${result.content}`.trim()

      return {
        conversationId: result.conversation_id,
        messageId: result.message_id,
        content: contentPreview || (projectName ? `Project: ${projectName}` : 'No preview'),
        conversationTitle: result.conversation_title || 'Untitled conversation',
        createdAt: result.message_created_at || result.conversation_updated_at || new Date().toISOString(),
      }
    })
  }, [projectNameById, searchedTopLevelMessages])

  // Floating-only sidebar: keep the rail mounted and use the portal as the only full sidebar UI.
  const [isExpandPortalOpen, setIsExpandPortalOpen] = useState(true)
  const [portalLeftOffset, setPortalLeftOffset] = useState(SIDEBAR_RAIL_WIDTH_PX + SIDEBAR_PORTAL_GAP_PX)
  const [expandPortalWidth, setExpandPortalWidth] = useState(SIDEBAR_PORTAL_MAX_WIDTH_PX)
  const [previewPortalLeftOffset, setPreviewPortalLeftOffset] = useState(
    SIDEBAR_RAIL_WIDTH_PX + SIDEBAR_PORTAL_GAP_PX + SIDEBAR_PORTAL_MAX_WIDTH_PX + SIDEBAR_PREVIEW_PORTAL_GAP_PX
  )
  const [previewPortalWidth, setPreviewPortalWidth] = useState(SIDEBAR_PREVIEW_PORTAL_MIN_WIDTH_PX)
  const [hoveredPreviewConversation, setHoveredPreviewConversation] = useState<Conversation | null>(null)
  const [hoverPreviewSearchQuery, setHoverPreviewSearchQuery] = useState('')
  const hoverPreviewCloseTimeoutRef = useRef<number | null>(null)
  const sidebarRef = useRef<HTMLElement | null>(null)
  const expandButtonRef = useRef<HTMLButtonElement | null>(null)

  // Theme state
  const [themeMode, setThemeMode] = useState<'Light' | 'Dark' | 'System'>(() => {
    if (typeof window === 'undefined') return 'Light'
    const saved = localStorage.getItem('theme')
    return saved === 'dark' ? 'Dark' : saved === 'light' ? 'Light' : saved === 'system' ? 'System' : 'System'
  })

  // Apply theme immediately when user toggles preference
  useEffect(() => {
    if (typeof window === 'undefined') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const isDark = themeMode === 'Dark' || (themeMode === 'System' && media.matches)
    document.documentElement.classList.toggle('dark', isDark)

    // Notify Electron to update title bar colors
    if (window.electronAPI?.theme?.update) {
      window.electronAPI.theme.update(isDark)
    }
  }, [themeMode])

  // Persist theme preference
  useEffect(() => {
    if (typeof window === 'undefined') return
    localStorage.setItem('theme', themeMode === 'Dark' ? 'dark' : themeMode === 'Light' ? 'light' : 'system')
  }, [themeMode])

  const cycleTheme = useCallback(() => {
    setThemeMode(prev => (prev === 'Light' ? 'Dark' : prev === 'Dark' ? 'System' : 'Light'))
  }, [])

  const clearHoverPreviewCloseTimeout = useCallback(() => {
    if (hoverPreviewCloseTimeoutRef.current !== null) {
      window.clearTimeout(hoverPreviewCloseTimeoutRef.current)
      hoverPreviewCloseTimeoutRef.current = null
    }
  }, [])

  const scheduleHoverPreviewClose = useCallback(() => {
    clearHoverPreviewCloseTimeout()
    hoverPreviewCloseTimeoutRef.current = window.setTimeout(() => {
      setHoveredPreviewConversation(null)
      hoverPreviewCloseTimeoutRef.current = null
    }, SIDEBAR_PREVIEW_CLOSE_DELAY_MS)
  }, [clearHoverPreviewCloseTimeout])

  const closeExpandPortal = useCallback(
    (restoreFocus = true) => {
      setIsExpandPortalOpen(false)
      setHoveredPreviewConversation(null)
      clearHoverPreviewCloseTimeout()

      if (restoreFocus && typeof window !== 'undefined') {
        window.requestAnimationFrame(() => {
          expandButtonRef.current?.focus()
        })
      }
    },
    [clearHoverPreviewCloseTimeout]
  )

  const openExpandPortal = useCallback(() => {
    setIsExpandPortalOpen(true)
  }, [])

  useEffect(() => {
    if (!isExpandPortalOpen) return

    const updatePortalAnchor = () => {
      const railRect = sidebarRef.current?.getBoundingClientRect()
      const baseLeft = railRect?.right ?? SIDEBAR_RAIL_WIDTH_PX
      const desiredLeft = baseLeft + SIDEBAR_PORTAL_GAP_PX
      const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : SIDEBAR_PORTAL_MAX_WIDTH_PX
      const panelWidth = Math.min(SIDEBAR_PORTAL_MAX_WIDTH_PX, Math.max(280, viewportWidth - 32))
      const maxLeft = Math.max(8, viewportWidth - panelWidth - 8)
      const computedLeft = Math.max(8, Math.min(desiredLeft, maxLeft))

      setPortalLeftOffset(computedLeft)
      setExpandPortalWidth(panelWidth)

      const desiredPreviewLeft = computedLeft + panelWidth + SIDEBAR_PREVIEW_PORTAL_GAP_PX
      const maxPreviewLeft = Math.max(8, viewportWidth - SIDEBAR_PREVIEW_PORTAL_MIN_WIDTH_PX - 8)
      const computedPreviewLeft = Math.max(8, Math.min(desiredPreviewLeft, maxPreviewLeft))
      const availablePreviewWidth = Math.max(
        SIDEBAR_PREVIEW_PORTAL_MIN_WIDTH_PX,
        viewportWidth - computedPreviewLeft - 8
      )
      const computedPreviewWidth = Math.min(SIDEBAR_PREVIEW_PORTAL_MAX_WIDTH_PX, availablePreviewWidth)

      setPreviewPortalLeftOffset(computedPreviewLeft)
      setPreviewPortalWidth(computedPreviewWidth)
    }

    updatePortalAnchor()
    window.addEventListener('resize', updatePortalAnchor)

    return () => {
      window.removeEventListener('resize', updatePortalAnchor)
    }
  }, [isExpandPortalOpen])

  useEffect(() => {
    if (!isExpandPortalOpen) return

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeExpandPortal()
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => {
      window.removeEventListener('keydown', handleEscape)
    }
  }, [closeExpandPortal, isExpandPortalOpen])

  const previousPathnameRef = useRef(location.pathname)

  useEffect(() => {
    const pathChanged = previousPathnameRef.current !== location.pathname
    if (pathChanged && isExpandPortalOpen) {
      closeExpandPortal(false)
    }
    previousPathnameRef.current = location.pathname
  }, [closeExpandPortal, isExpandPortalOpen, location.pathname])

  useEffect(() => {
    if (!isProjectsTab && searchQuery) {
      setSearchQuery('')
      clearSearch()
    }
  }, [isProjectsTab, searchQuery, clearSearch])

  useEffect(() => {
    setHoverPreviewSearchQuery('')
  }, [hoveredPreviewConversation?.id])

  useEffect(() => {
    return () => {
      clearHoverPreviewCloseTimeout()
    }
  }, [clearHoverPreviewCloseTimeout])

  const handleSearchChange = (value: string) => {
    setSearchQuery(value)
    if (!value.trim()) {
      clearSearch()
    }
  }

  const handleSearchSubmit = () => {
    const trimmedQuery = searchQuery.trim()
    if (!trimmedQuery) {
      clearSearch()
      return
    }

    search(trimmedQuery)
  }

  const handleSearchResultClick = (conversationId: ConversationId, messageId?: string) => {
    const match = searchedTopLevelMessages.find(result => {
      const sameConversation = String(result.conversation_id) === String(conversationId)
      if (!sameConversation) return false
      if (!messageId) return true
      return String(result.message_id) === String(messageId)
    })
    if (!match) return

    closeExpandPortal(false)
    dispatch(chatSliceActions.conversationSet(match.conversation_id))
    dispatch(activeConversationIdSet(match.conversation_id))
    navigate(`/chat/${match.project_id || 'unknown'}/${match.conversation_id}`, {
      state: match.storage_mode ? { storageMode: match.storage_mode } : undefined,
    })

    setSearchQuery('')
    clearSearch()
  }

  const handleConversationHoverStart = useCallback(
    (conversation: Conversation) => {
      if (!isExpandPortalOpen) return
      if (conversation.storage_mode !== 'local') {
        setHoveredPreviewConversation(null)
        return
      }

      clearHoverPreviewCloseTimeout()
      setHoveredPreviewConversation(conversation)
    },
    [clearHoverPreviewCloseTimeout, isExpandPortalOpen]
  )

  const handleConversationHoverEnd = useCallback(() => {
    scheduleHoverPreviewClose()
  }, [scheduleHoverPreviewClose])

  const handleSelect = (id: ConversationId) => {
    const conversation = favoriteConversations.find(c => c.id === id)
    closeExpandPortal(false)
    dispatch(chatSliceActions.conversationSet(id))
    dispatch(activeConversationIdSet(id))
    navigate(`/chat/${conversation?.project_id || 'unknown'}/${id}`)
  }

  const handleProjectConversationSelect = useCallback(
    (conversation: Conversation) => {
      closeExpandPortal(false)
      dispatch(chatSliceActions.conversationSet(conversation.id))
      dispatch(activeConversationIdSet(conversation.id))
      navigate(`/chat/${conversation.project_id || 'unknown'}/${conversation.id}`, {
        state: conversation.storage_mode ? { storageMode: conversation.storage_mode } : undefined,
      })
    },
    [closeExpandPortal, dispatch, navigate]
  )

  const handlePreviewMessageSelect = useCallback(
    (messageId: string) => {
      if (!hoveredPreviewConversation) return

      const targetConversation = hoveredPreviewConversation
      const encodedMessageId = encodeURIComponent(String(messageId))

      closeExpandPortal(false)
      setHoverPreviewSearchQuery('')
      dispatch(chatSliceActions.conversationSet(targetConversation.id))
      dispatch(activeConversationIdSet(targetConversation.id))
      navigate(`/chat/${targetConversation.project_id || 'unknown'}/${targetConversation.id}#${encodedMessageId}`, {
        state: targetConversation.storage_mode ? { storageMode: targetConversation.storage_mode } : undefined,
      })
    },
    [closeExpandPortal, dispatch, hoveredPreviewConversation, navigate]
  )

  const handleToggleProjectExpansion = useCallback(
    (projectId: string) => {
      const normalizedProjectId = String(projectId)

      if (!isExpandPortalOpen) {
        setExpandedProjectIds(prev => (prev.includes(normalizedProjectId) ? prev : [normalizedProjectId, ...prev]))
        openExpandPortal()
        return
      }

      setExpandedProjectIds(prev =>
        prev.includes(normalizedProjectId)
          ? prev.filter(id => id !== normalizedProjectId)
          : [...prev, normalizedProjectId]
      )
    },
    [isExpandPortalOpen, openExpandPortal]
  )

  const handleDeleteSidebarProject = useCallback(
    async (project: SidebarProject) => {
      const shouldDelete = window.confirm(`Delete project "${project.name}"? This action cannot be undone.`)
      if (!shouldDelete) return

      try {
        await dispatch(deleteProject({ id: project.id, storageMode: project.storage_mode })).unwrap()

        setExpandedProjectIds(prev => prev.filter(id => String(id) !== String(project.id)))

        if (userId) {
          queryClient.setQueryData<SidebarProject[]>(['projects', userId], previous =>
            previous ? previous.filter(item => String(item.id) !== String(project.id)) : previous
          )
        }

        queryClient.setQueryData<Conversation[]>(['conversations'], previous =>
          previous ? previous.filter(item => String(item.project_id) !== String(project.id)) : previous
        )
        queryClient.setQueriesData<Conversation[]>({ queryKey: ['conversations', 'recent'] }, previous =>
          previous ? previous.filter(item => String(item.project_id) !== String(project.id)) : previous
        )
        queryClient.removeQueries({ queryKey: ['conversations', 'project', project.id] })

        queryClient.invalidateQueries({ queryKey: ['projects'] })
        queryClient.invalidateQueries({ queryKey: ['conversations'] })
      } catch (deleteError) {
        console.error('Failed to delete project from sidebar:', deleteError)
      }
    },
    [dispatch, queryClient, userId]
  )

  const handleDeleteSidebarConversation = useCallback(
    async (conversation: Conversation) => {
      const label = conversation.title || `Conversation ${conversation.id}`
      const shouldDelete = window.confirm(`Delete conversation "${label}"? This action cannot be undone.`)
      if (!shouldDelete) return

      try {
        await dispatch(
          deleteConversation({ id: conversation.id, storageMode: conversation.storage_mode || 'cloud' })
        ).unwrap()

        queryClient.setQueryData<Conversation[]>(['conversations', 'project', conversation.project_id], previous =>
          previous ? previous.filter(item => String(item.id) !== String(conversation.id)) : previous
        )
        queryClient.setQueryData<Conversation[]>(['conversations'], previous =>
          previous ? previous.filter(item => String(item.id) !== String(conversation.id)) : previous
        )
        queryClient.setQueriesData<Conversation[]>({ queryKey: ['conversations', 'recent'] }, previous =>
          previous ? previous.filter(item => String(item.id) !== String(conversation.id)) : previous
        )
        queryClient.setQueriesData<Conversation[]>({ queryKey: ['conversations', 'favorites'] }, previous =>
          previous ? previous.filter(item => String(item.id) !== String(conversation.id)) : previous
        )

        if (String(activeConversationId) === String(conversation.id)) {
          if (conversation.project_id) {
            navigate(`/conversationPage?projectId=${conversation.project_id}`)
          } else {
            navigate('/conversationPage')
          }
        }

        queryClient.invalidateQueries({ queryKey: ['projects'] })
        queryClient.invalidateQueries({ queryKey: ['conversations'] })
      } catch (deleteError) {
        console.error('Failed to delete conversation from sidebar:', deleteError)
      }
    },
    [activeConversationId, dispatch, navigate, queryClient]
  )

  const handleOpenMoveConversation = useCallback((conversation: Conversation) => {
    setConversationToMove(conversation)
    setDestinationProject(null)
    setShowMoveConfirm(false)
    setShowMoveModal(true)
  }, [])

  const handleSelectDestinationProject = useCallback((project: { id: string; name: string }) => {
    setDestinationProject(project)
    setShowMoveModal(false)
    setShowMoveConfirm(true)
  }, [])

  const handleCancelMoveProject = useCallback(() => {
    setShowMoveConfirm(false)
    setDestinationProject(null)
  }, [])

  const confirmMoveProject = useCallback(async () => {
    if (!conversationToMove || !destinationProject) return

    const sourceProjectId = conversationToMove.project_id || null

    await moveConversationMutation.mutateAsync({
      conversationId: conversationToMove.id,
      sourceProjectId,
      destinationProjectId: destinationProject.id,
    })

    setShowMoveConfirm(false)
    setShowMoveModal(false)
    setConversationToMove(null)
    setDestinationProject(null)
  }, [conversationToMove, destinationProject, moveConversationMutation])

  const handleToggleFavorite = useCallback(
    async (conversation: Conversation) => {
      if (!isElectronMode) return

      const nextFavorite = favoriteConversationIds.has(conversation.id) ? 0 : 1
      const updatedConversation = { ...conversation, favorite: nextFavorite }

      queryClient.setQueriesData<Conversation[]>({ queryKey: ['conversations', 'favorites'] }, previous => {
        if (nextFavorite === 1) {
          const existingItems = previous || []
          return [updatedConversation, ...existingItems.filter(item => String(item.id) !== String(conversation.id))]
        }

        return previous ? previous.filter(item => String(item.id) !== String(conversation.id)) : previous
      })

      try {
        await localApi.patch(`/app/conversations/${conversation.id}/favorite`, { favorite: nextFavorite })
        queryClient.invalidateQueries({ queryKey: ['conversations', 'favorites'] })
      } catch (error) {
        queryClient.invalidateQueries({ queryKey: ['conversations', 'favorites'] })
        console.error('Failed to update conversation favorite from sidebar:', error)
      }
    },
    [favoriteConversationIds, isElectronMode, queryClient]
  )

  const handleCreateConversationForProject = useCallback(
    async (project: SidebarProject) => {
      try {
        const createdConversation = await dispatch(
          createConversation({
            projectId: project.id,
            title: `${project.name} Conversation`,
            storageMode: project.storage_mode || 'cloud',
          })
        ).unwrap()

        setExpandedProjectIds(prev => {
          const normalizedProjectId = String(project.id)
          return prev.includes(normalizedProjectId) ? prev : [normalizedProjectId, ...prev]
        })

        queryClient.setQueryData<Conversation[]>(['conversations', 'project', project.id], previous => {
          const previousItems = previous || []
          return [createdConversation, ...previousItems.filter(item => item.id !== createdConversation.id)]
        })

        queryClient.setQueryData<Conversation[]>(['conversations'], previous => {
          const previousItems = previous || []
          return [createdConversation, ...previousItems.filter(item => item.id !== createdConversation.id)]
        })

        queryClient.setQueriesData<Conversation[]>({ queryKey: ['conversations', 'recent'] }, previous => {
          const previousItems = previous || []
          return [createdConversation, ...previousItems.filter(item => item.id !== createdConversation.id)]
        })

        const activityTimestamp =
          createdConversation.updated_at || createdConversation.created_at || new Date().toISOString()
        const debugProjectOrder =
          typeof window !== 'undefined' && window.localStorage.getItem('sidebar:debugProjectOrder') === 'true'
        const previousProjectOrder = userId
          ? queryClient.getQueryData<SidebarProject[]>(['projects', userId])?.map(item => item.id)
          : undefined

        const applyProjectActivityOrdering = (previousProjects?: SidebarProject[]) => {
          if (!previousProjects || previousProjects.length === 0) return previousProjects

          const updatedProjects = previousProjects.map(existingProject => {
            if (String(existingProject.id) !== String(project.id)) return existingProject

            return {
              ...existingProject,
              updated_at: activityTimestamp,
              latest_conversation_updated_at: activityTimestamp,
            }
          })

          updatedProjects.sort((a, b) => {
            const getSortTime = (item: SidebarProject) => {
              const candidate = item.latest_conversation_updated_at || item.updated_at || item.created_at
              return candidate ? new Date(candidate).getTime() : 0
            }
            return getSortTime(b) - getSortTime(a)
          })

          return updatedProjects
        }

        if (userId) {
          queryClient.setQueryData<SidebarProject[]>(['projects', userId], applyProjectActivityOrdering)

          if (debugProjectOrder) {
            const nextProjectOrder = queryClient
              .getQueryData<SidebarProject[]>(['projects', userId])
              ?.map(item => item.id)
            console.debug('[SideBar] project order after creating conversation', {
              projectId: project.id,
              conversationId: createdConversation.id,
              previousProjectOrder,
              nextProjectOrder,
            })
          }
        }

        // Mark projects stale, but do not immediately refetch active queries.
        // Immediate refetch can return slightly stale ordering from backend and cause
        // the just-promoted project row to "jump" back down momentarily.
        queryClient.invalidateQueries({ queryKey: ['projects'], refetchType: 'none' })

        closeExpandPortal(false)
        dispatch(chatSliceActions.conversationSet(createdConversation.id))
        dispatch(activeConversationIdSet(createdConversation.id))
        navigate(`/chat/${createdConversation.project_id || project.id}/${createdConversation.id}`, {
          state: {
            storageMode: createdConversation.storage_mode || project.storage_mode || 'cloud',
          },
        })
      } catch (createError) {
        console.error('Failed to create conversation from sidebar:', createError)
      }
    },
    [closeExpandPortal, dispatch, navigate, queryClient, userId]
  )

  const handleOpenEditProject = useCallback((project: SidebarProject) => {
    setEditingProject(project)
    setShowEditProjectModal(true)
  }, [])

  const handleCloseEditProjectModal = useCallback(() => {
    setShowEditProjectModal(false)
    setEditingProject(null)
  }, [])

  const handleOpenCreateProject = useCallback(() => {
    setEditingProject(null)
    setShowEditProjectModal(true)
  }, [])

  const handleSidebarProjectCreated = useCallback(
    async (project: Project) => {
      const projectWithLatest: SidebarProject = {
        ...project,
        latest_conversation_updated_at: null,
      }

      if (userId) {
        queryClient.setQueryData<SidebarProject[]>(['projects', userId], previous => {
          const existingProjects = previous || []
          return [
            projectWithLatest,
            ...existingProjects.filter(existingProject => String(existingProject.id) !== String(project.id)),
          ]
        })
      }

      setExpandedProjectIds(prev => {
        const normalizedProjectId = String(project.id)
        return prev.includes(normalizedProjectId) ? prev : [normalizedProjectId, ...prev]
      })

      await handleCreateConversationForProject(projectWithLatest)
    },
    [handleCreateConversationForProject, queryClient, userId]
  )

  const sidebarActions = useMemo(
    () => [
      {
        key: 'theme',
        label: themeMode,
        iconClass: themeMode === 'System' ? 'bx-desktop' : themeMode === 'Dark' ? 'bx-moon' : 'bx-sun',
        onClick: cycleTheme,
        title: `Theme: ${themeMode} (click to change)`,
        ariaLabel: `Theme: ${themeMode}`,
      },
      {
        key: 'logging',
        label: 'Logging',
        iconClass: 'bx-line-chart',
        onClick: () => navigate('/logging'),
        title: 'Open logging',
        ariaLabel: 'Open logging',
      },
      {
        key: 'profile',
        label: 'Profile',
        iconClass: 'bx-user-circle',
        onClick: () => navigate('/payment'),
        title: 'Open profile',
        ariaLabel: 'Open profile',
      },
      {
        key: 'settings',
        label: 'Settings',
        iconClass: 'bx-cog',
        onClick: () => navigate('/settings'),
        title: 'Open settings',
        ariaLabel: 'Open settings',
      },
    ],
    [cycleTheme, navigate, themeMode]
  )

  const renderSidebarBody = (
    renderCollapsed: boolean,
    enableMiniHoverPreview: boolean = false,
    hoveredConversationId: ConversationId | null = null
  ) => {
    const actionIconShellClass = renderCollapsed
      ? 'acrylic-light flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-transparent text-neutral-700 dark:bg-transparent dark:text-neutral-300 dark:outline dark:outline-1 dark:outline-neutral-400/15'
      : 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-neutral-200/80 bg-neutral-50 text-neutral-700 dark:border-neutral-700/70 dark:bg-neutral-900 dark:text-neutral-300'

    return (
      <>
        {!renderCollapsed && (
          <div className='px-2 pb-2'>
            <div className='rounded-xl border border-white/10 dark:bg-neutral-900/70 bg-neutral-100/85 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-sm dark:bg-neutral-950/70'>
              <div className='grid grid-cols-2 gap-1'>
                <button
                  type='button'
                  onClick={() => setConversationTab('recent')}
                  className={`rounded-lg px-3 py-2 text-sm font-semibold transition-all duration-200 ${
                    conversationTab === 'recent'
                      ? 'bg-neutral-100/85 dark:bg-neutral-700/85  text-neutral-900 dark:text-neutral-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_4px_14px_rgba(0,0,0,0.05)]'
                      : 'text-neutral-400 hover:bg-neutral-100/85 dark:hover:bg-neutral-800/70 hover:text-neutral-900 dark:hover:text-neutral-200'
                  }`}
                >
                  Projects
                </button>
                <button
                  type='button'
                  onClick={() => setConversationTab('favorites')}
                  className={`rounded-lg px-3 py-2 text-sm font-semibold transition-all duration-200 ${
                    conversationTab === 'favorites'
                      ? 'bg-neutral-100/85 dark:bg-neutral-700/85 text-neutral-900 dark:text-neutral-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_4px_14px_rgba(0,0,0,0.05)]'
                      : 'text-neutral-400 hover:bg-neutral-100/85 dark:hover:bg-neutral-800/70 hover:text-neutral-900 dark:hover:text-neutral-200'
                  }`}
                >
                  Favorites
                </button>
              </div>
            </div>
          </div>
        )}

        {!renderCollapsed && isProjectsTab && (
          <>
            <div className='px-2 pb-2 relative z-50'>
              <SearchList
                value={searchQuery}
                onChange={handleSearchChange}
                onSubmit={handleSearchSubmit}
                results={sidebarSearchResults}
                loading={isSearching}
                onResultClick={(conversationId, messageId) => handleSearchResultClick(conversationId, messageId)}
                placeholder='Search chat...'
                dropdownVariant='neutral'
                dropdownZIndex={enableMiniHoverPreview ? 1301 : 50}
              />
            </div>
            <div className='px-2 pb-2'>
              <Button
                variant='outline2'
                size='medium'
                rounded='full'
                onClick={handleOpenCreateProject}
                className='group w-full justify-center gap-2'
                title='Create a new project'
                aria-label='Create a new project'
              >
                <i className='bx bx-plus text-lg transition-transform duration-100 group-active:scale-90'></i>
                <span className='text-sm font-medium'>New Project</span>
              </Button>
            </div>
          </>
        )}

        <div className='flex-1 overflow-y-auto overflow-x-hidden p-2 pt-2 2xl:pt-2 no-scrollbar scroll-fade dark:border-neutral-800 rounded-xl border-t-0'>
          {loading && (
            <div
              className={`text-xs text-gray-500 dark:text-gray-300 px-2 py-1 ${renderCollapsed ? 'text-center' : ''}`}
              title={renderCollapsed ? 'Loading...' : undefined}
            >
              {renderCollapsed ? '...' : 'Loading...'}
            </div>
          )}
          {error && (
            <div
              className={`text-xs text-red-600 dark:text-red-400 px-2 py-1 ${renderCollapsed ? 'text-center' : ''}`}
              role='alert'
              title={renderCollapsed ? error : undefined}
            >
              {renderCollapsed ? '!' : error}
            </div>
          )}

          {isProjectsTab ? (
            <>
              {!renderCollapsed &&
                visibleProjects.map(project => (
                  <ProjectAccordionItem
                    key={project.id}
                    project={project}
                    isExpanded={expandedProjectIdSet.has(String(project.id))}
                    isCollapsed={renderCollapsed}
                    activeConversationId={activeConversationId}
                    favoriteConversationIds={favoriteConversationIds}
                    hoveredPreviewConversationId={hoveredConversationId}
                    isElectronMode={isElectronMode}
                    onToggle={handleToggleProjectExpansion}
                    onSelectConversation={handleProjectConversationSelect}
                    onCreateConversation={handleCreateConversationForProject}
                    onEditProject={handleOpenEditProject}
                    onDeleteProject={handleDeleteSidebarProject}
                    onToggleFavorite={handleToggleFavorite}
                    onMoveConversation={handleOpenMoveConversation}
                    onDeleteConversation={handleDeleteSidebarConversation}
                    enableConversationHoverPreview={enableMiniHoverPreview}
                    onConversationHoverStart={handleConversationHoverStart}
                    onConversationHoverEnd={handleConversationHoverEnd}
                  />
                ))}
              {visibleProjects.length === 0 && !loading && !error && !renderCollapsed && (
                <div className='text-xs text-neutral-500 dark:text-neutral-400 px-2 py-1'>No projects</div>
              )}
            </>
          ) : (
            <>
              {!renderCollapsed &&
                displayedFavoriteConversations.map(conv => {
                  const isActive = activeConversationId === conv.id
                  const isPreviewHighlighted =
                    enableMiniHoverPreview &&
                    hoveredConversationId != null &&
                    String(hoveredConversationId) === String(conv.id)
                  const projectName = conv.project_id ? projectNameById.get(String(conv.project_id)) : undefined
                  const conversationUpdatedDate = formatDate(conv.updated_at)

                  return (
                    <div
                      key={conv.id}
                      className='sm:mb-1 md:mb-1 lg:mb-1.5 2xl:mb-2 group relative'
                      style={CONVERSATION_ROW_VISIBILITY_STYLE}
                      onMouseEnter={() => {
                        if (!enableMiniHoverPreview) return
                        handleConversationHoverStart(conv)
                      }}
                      onMouseLeave={() => {
                        if (!enableMiniHoverPreview) return
                        handleConversationHoverEnd()
                      }}
                    >
                      <div
                        role='button'
                        tabIndex={0}
                        onClick={() => handleSelect(conv.id)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            handleSelect(conv.id)
                          }
                        }}
                        className={`w-full text-left rounded-lg transition-all duration-200 cursor-pointer hover:bg-stone-100/30 hover:ring-neutral-100 hover:ring-1 sm:py-1 xl:py-2 dark:hover:ring-neutral-600/60 outline-transparent dark:hover:bg-yBlack-900/10 ${
                          isActive
                            ? 'bg-indigo-100 dark:bg-indigo-900/40 border-l-4 border-indigo-500'
                            : isPreviewHighlighted
                              ? 'bg-stone-100/30 ring-neutral-100 ring-1 dark:ring-neutral-600/60 dark:bg-yBlack-900/10'
                              : ''
                        }`}
                      >
                        <div className='flex flex-col gap-0 md:gap-1 lg:gap-1.5 xl:gap-1 2xl:gap-2 py-2 md:py-0 lg:py-0 xl:py-0 mx-2'>
                          <span className='text-[14px] font-medium text-neutral-900 dark:text-stone-200 truncate'>
                            {conv.title || `Conversation ${conv.id}`}
                          </span>
                          {projectName && (
                            <span className='text-[12px] text-neutral-600 dark:text-stone-300 truncate'>
                              Project: {projectName}
                            </span>
                          )}
                          {conversationUpdatedDate && (
                            <span className='text-xs md:text-[11px] lg:text-[10px] xl:text-[9px] 2xl:text-[11px] 3xl:text-[12px] 4xl:text-[14px] text-neutral-500 dark:text-neutral-400 text-right'>
                              {conversationUpdatedDate}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              {displayedFavoriteConversations.length === 0 && !loading && !error && (
                <div
                  className={`text-xs text-neutral-500 dark:text-neutral-400 px-2 py-1 ${renderCollapsed ? 'hidden' : ''}`}
                >
                  No favorite conversations
                </div>
              )}
            </>
          )}
        </div>

        {renderCollapsed && (
          <div className=' px-1 py-2'>
            {sidebarActions.map(action => (
              <button
                key={action.key}
                type='button'
                onClick={action.onClick}
                title={action.title}
                aria-label={action.ariaLabel}
                className='group flex w-full items-center justify-center rounded-3xl px-0 py-1.5 transition-colors'
              >
                <span className={actionIconShellClass}>
                  <i
                    className={`bx ${action.iconClass} block text-[22px] leading-none transition-transform duration-100 ${
                      action.key === 'theme' ? 'group-active:scale-90' : 'group-hover:scale-108 group-active:scale-95'
                    }`}
                    aria-hidden='true'
                  ></i>
                </span>
              </button>
            ))}
          </div>
        )}
      </>
    )
  }

  const handleToggleSidebar = useCallback(() => {
    if (isExpandPortalOpen) {
      closeExpandPortal(false)
      return
    }

    openExpandPortal()
  }, [closeExpandPortal, isExpandPortalOpen, openExpandPortal])

  const showExpandedPortal = isExpandPortalOpen
  const hoveredPreviewConversationId = hoveredPreviewConversation?.id ?? null
  const shouldShowConversationPreviewPortal =
    showExpandedPortal && hoveredPreviewConversation?.storage_mode === 'local' && !!hoveredPreviewConversationId
  const sidebarToggleAriaLabel = showExpandedPortal ? 'Close sidebar panel' : 'Open sidebar panel'
  const sidebarToggleIconClass = showExpandedPortal ? 'bx-chevron-left' : 'bx-chevron-right'

  const {
    data: topLevelUserPreviewMessages = [],
    isLoading: topLevelUserPreviewLoading,
    error: topLevelUserPreviewError,
  } = useLocalTopLevelUserMessages(hoveredPreviewConversationId, shouldShowConversationPreviewPortal)

  const normalizedHoverPreviewSearch = hoverPreviewSearchQuery.trim().toLowerCase()
  const filteredTopLevelUserPreviewMessages = useMemo(() => {
    if (!normalizedHoverPreviewSearch) return topLevelUserPreviewMessages

    return topLevelUserPreviewMessages.filter(message => {
      const searchableContent = [message.note, message.plain_text_content, message.content]
        .filter(Boolean)
        .join('\n')
        .toLowerCase()

      return searchableContent.includes(normalizedHoverPreviewSearch)
    })
  }, [normalizedHoverPreviewSearch, topLevelUserPreviewMessages])

  return (
    <>
      <aside
        ref={sidebarRef}
        className={`acrylic-subtle-2 relative z-10 ${isWeb ? 'h-[100vh]' : 'h-full'} flex w-12 flex-col flex-shrink-0 overflow-hidden bg-transparent shadow-sm dark:bg-transparent ${className}`}
        aria-label='Sidebar rail'
      >
        <div className='flex items-center justify-center py-3 my-1 md:py-2.5 lg:p-1 xl:p-1 2xl:px-1 2xl:py-2'>
          <Button
            ref={expandButtonRef}
            variant='acrylic'
            size='circle'
            rounded='full'
            onClick={handleToggleSidebar}
            className='mx-auto p-2 transition-transform duration-200 hover:scale-103'
            aria-label={sidebarToggleAriaLabel}
            aria-haspopup='dialog'
            aria-expanded={showExpandedPortal}
          >
            <i className={`bx ${sidebarToggleIconClass} text-lg`} aria-hidden='true'></i>
          </Button>
        </div>

        {renderSidebarBody(true, false, hoveredPreviewConversationId)}
      </aside>

      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {showExpandedPortal && (
              <motion.div
                className='fixed inset-x-0 bottom-0 z-[1200]'
                style={{ top: 'var(--titlebar-height, 0px)' }}
                initial={false}
              >
                <motion.button
                  type='button'
                  className='absolute inset-0 ml-12 rounded-2xl bg-neutral-900/10 dark:bg-neutral-950/45'
                  aria-label='Close sidebar panel'
                  onClick={() => closeExpandPortal()}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.16, ease: 'easeOut' }}
                />

                <motion.section
                  role='dialog'
                  aria-modal='true'
                  aria-label='Sidebar panel'
                  className='absolute top-3 bottom-3 overflow-hidden rounded-xl border border-neutral-200/90 bg-neutral-50 shadow-2xl dark:border-neutral-700/80 dark:bg-transparent'
                  style={{
                    left: `${portalLeftOffset}px`,
                    width: `${expandPortalWidth}px`,
                    transformOrigin: 'left center',
                  }}
                  initial={{ opacity: 0, x: -16, scale: 0.985 }}
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  exit={{ opacity: 0, x: -10, scale: 0.985 }}
                  transition={{ duration: 0.22, ease: 'easeOut' }}
                >
                  <div className='acrylic-subtle-no-hover h-full min-h-0 flex flex-col overflow-hidden rounded-xl'>
                    <div className='flex items-center justify-between px-3 py-2 border-b border-neutral-200/80 dark:border-neutral-800/80'>
                      <h2 className='text-sm font-semibold text-neutral-800 dark:text-neutral-100'>Sidebar</h2>
                      <div className='flex items-center gap-1'>
                        <Button
                          variant='outline2'
                          size='circle'
                          rounded='full'
                          className='p-2'
                          onClick={() => closeExpandPortal()}
                          aria-label='Close sidebar panel'
                        >
                          <i className='bx bx-x text-lg' aria-hidden='true'></i>
                        </Button>
                      </div>
                    </div>

                    {renderSidebarBody(false, true, hoveredPreviewConversationId)}
                  </div>
                </motion.section>

                <AnimatePresence>
                  {shouldShowConversationPreviewPortal && (
                    <motion.section
                      role='dialog'
                      aria-modal='false'
                      aria-label='Top level user messages preview'
                      className='absolute top-3 bottom-3 rounded-xl border border-neutral-200/90 bg-neutral-50 shadow-2xl backdrop-blur-sm dark:border-neutral-700/80 dark:bg-neutral-800'
                      style={{
                        left: `${previewPortalLeftOffset}px`,
                        width: `${previewPortalWidth}px`,
                        transformOrigin: 'left center',
                      }}
                      onMouseEnter={() => {
                        clearHoverPreviewCloseTimeout()
                      }}
                      onMouseLeave={() => {
                        scheduleHoverPreviewClose()
                      }}
                      initial={{ opacity: 0, x: -12, scale: 0.985 }}
                      animate={{ opacity: 1, x: 0, scale: 1 }}
                      exit={{ opacity: 0, x: -8, scale: 0.985 }}
                      transition={{ duration: 0.18, ease: 'easeOut' }}
                    >
                      <div className='h-full min-h-0 flex flex-col'>
                        <div className='px-3 py-2 border-b border-neutral-200/80 dark:border-neutral-800/80 space-y-2'>
                          <div>
                            <h3 className='text-sm font-semibold text-neutral-800 dark:text-neutral-100 truncate'>
                              {hoveredPreviewConversation?.title || 'Untitled conversation'}
                            </h3>
                            <p className='text-[11px] text-neutral-500 dark:text-neutral-400'>Top-level user messages</p>
                          </div>

                          <div className='relative'>
                            <input
                              type='text'
                              value={hoverPreviewSearchQuery}
                              onChange={event => setHoverPreviewSearchQuery(event.target.value)}
                              placeholder='Search messages in this preview...'
                              className='w-full rounded-md border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 text-xs text-neutral-800 outline-none focus:border-blue-400 dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100 dark:focus:border-orange-400'
                            />
                          </div>
                        </div>

                        <div className='flex-1 min-h-0 overflow-y-auto thin-scrollbar p-3 space-y-2'>
                          {topLevelUserPreviewLoading && (
                            <div className='text-xs text-neutral-500 dark:text-neutral-400'>
                              Loading top-level messages...
                            </div>
                          )}

                          {!topLevelUserPreviewLoading && topLevelUserPreviewError && (
                            <div className='text-xs text-red-500 dark:text-red-400'>
                              {String(topLevelUserPreviewError) || 'Failed to load messages'}
                            </div>
                          )}

                          {!topLevelUserPreviewLoading &&
                            !topLevelUserPreviewError &&
                            topLevelUserPreviewMessages.length === 0 && (
                              <div className='text-xs text-neutral-500 dark:text-neutral-400'>
                                No top-level user messages
                              </div>
                            )}

                          {!topLevelUserPreviewLoading &&
                            !topLevelUserPreviewError &&
                            topLevelUserPreviewMessages.length > 0 &&
                            filteredTopLevelUserPreviewMessages.length === 0 && (
                              <div className='text-xs text-neutral-500 dark:text-neutral-400'>
                                No messages match "{hoverPreviewSearchQuery}".
                              </div>
                            )}

                          {!topLevelUserPreviewLoading &&
                            !topLevelUserPreviewError &&
                            filteredTopLevelUserPreviewMessages.map(message => (
                              <button
                                type='button'
                                key={message.id}
                                onClick={() => handlePreviewMessageSelect(String(message.id))}
                                className='w-full text-left rounded-lg border border-neutral-200/80 bg-neutral-50 px-3 py-2 transition-colors hover:bg-neutral-100 dark:border-neutral-700/70 dark:bg-neutral-900/80 dark:hover:bg-neutral-800'
                                title='Open this conversation branch'
                              >
                                {message.note && (
                                  <p className='mb-1 text-[11px] font-medium whitespace-pre-wrap break-words text-blue-600 dark:text-orange-400'>
                                    {message.note}
                                  </p>
                                )}
                                <p className='text-xs text-neutral-800 dark:text-neutral-100 whitespace-pre-wrap break-words'>
                                  {message.plain_text_content || message.content}
                                </p>
                              </button>
                            ))}
                        </div>
                      </div>
                    </motion.section>
                  )}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body
        )}

      {/* Move Project Modal */}
      {showMoveModal && conversationToMove && (
        <div
          className='fixed inset-0 bg-neutral-400/40 dark:bg-black/30 bg-opacity-50 backdrop-blur-sm flex items-center justify-center z-[1300] p-4'
          onClick={() => setShowMoveModal(false)}
        >
          <div
            className='bg-neutral-100 text-neutral-900 mica-medium dark:bg-yBlack-900 rounded-3xl border border-gray-200 dark:border-zinc-700 w-full max-w-md p-6 shadow-[0_8px_32px_rgba(0,0,0,0.1)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.3)]'
            onClick={event => event.stopPropagation()}
          >
            <h3 className='text-xl font-semibold mb-2 dark:text-neutral-100'>Conversation Actions</h3>
            <p className='text-sm text-neutral-600 dark:text-neutral-400 mb-4'>
              Choose an action for "
              <span className='font-medium'>{conversationToMove.title || `Conversation ${conversationToMove.id}`}</span>
              ".
            </p>

            <h4 className='text-sm font-semibold mb-2 dark:text-neutral-200'>
              Move to Project
              <span className='ml-2 text-xs font-normal text-neutral-500 dark:text-neutral-400'>
                ({conversationToMove.storage_mode === 'local' ? 'Local' : 'Cloud'} projects only)
              </span>
            </h4>
            <div className='max-h-[400px] overflow-y-auto space-y-3 thin-scrollbar'>
              {projectData
                .filter(project => {
                  const convMode = conversationToMove.storage_mode || 'cloud'
                  const projMode = project.storage_mode || 'cloud'
                  return project.id !== conversationToMove.project_id && projMode === convMode
                })
                .map(project => (
                  <button
                    key={project.id}
                    className='w-full text-left px-4 py-3 rounded-xl border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors flex items-center justify-between'
                    onClick={() => handleSelectDestinationProject({ id: project.id, name: project.name })}
                  >
                    <span className='font-medium dark:text-neutral-100'>{project.name}</span>
                    <i className='bx bx-chevron-right text-lg text-neutral-400' aria-hidden='true'></i>
                  </button>
                ))}
              {projectData.filter(project => {
                const convMode = conversationToMove.storage_mode || 'cloud'
                const projMode = project.storage_mode || 'cloud'
                return project.id !== conversationToMove.project_id && projMode === convMode
              }).length === 0 && (
                <p className='text-sm text-neutral-500 dark:text-neutral-400 text-center py-4'>
                  No other {conversationToMove.storage_mode === 'local' ? 'local' : 'cloud'} projects available.
                </p>
              )}
            </div>
            <div className='flex gap-3 justify-end mt-4'>
              <Button variant='outline2' size='circle' rounded='full' className='group' onClick={() => setShowMoveModal(false)}>
                <p className='transition-transform duration-100 group-active:scale-95'>Cancel</p>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Move Confirmation Dialog */}
      {showMoveConfirm && conversationToMove && destinationProject && (
        <div
          className='fixed inset-0 bg-neutral-400/40 dark:bg-black/30 bg-opacity-50 backdrop-blur-sm flex items-center justify-center z-[1300] p-4'
          onClick={handleCancelMoveProject}
        >
          <div
            className='bg-neutral-100 text-neutral-900 mica-medium rounded-3xl border border-gray-200 dark:border-zinc-700 w-full max-w-md p-6 shadow-[0_8px_32px_rgba(0,0,0,0.1)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.3)]'
            onClick={event => event.stopPropagation()}
          >
            <h3 className='text-[24px] font-semibold mb-2 dark:text-neutral-100'>Confirm Move</h3>
            <p className='text-[18px] text-neutral-800 dark:text-neutral-400 mb-4'>
              Move "
              <span className='font-medium'>{conversationToMove.title || `Conversation ${conversationToMove.id}`}</span>
              " to a new project?
            </p>
            <div className='flex items-center justify-center gap-3 py-4 px-2 acrylic rounded-xl mb-4'>
              <div className='text-center'>
                <div className='text-[16px] text-neutral-500 dark:text-neutral-400 mb-1'>From</div>
                <div className='font-medium dark:text-neutral-100 text-[16px]'>
                  {conversationToMove.project_id
                    ? projectNameById.get(String(conversationToMove.project_id)) || 'Unknown Project'
                    : 'No Project'}
                </div>
              </div>
              <i className='bx bx-right-arrow-alt text-2xl text-neutral-400' aria-hidden='true'></i>
              <div className='text-center'>
                <div className='text-[16px] text-neutral-500 dark:text-neutral-400 mb-1'>To</div>
                <div className='font-medium dark:text-neutral-100 text-[16px]'>{destinationProject.name}</div>
              </div>
            </div>
            <div className='flex gap-3 pt-2 justify-end'>
              <Button
                variant='outline2'
                size='circle'
                rounded='full'
                className='group'
                onClick={handleCancelMoveProject}
              >
                <p className='transition-transform duration-100 group-active:scale-95'>Cancel</p>
              </Button>
              <Button
                variant='outline2'
                size='circle'
                rounded='full'
                className='group bg-blue-500 hover:bg-blue-600 dark:bg-blue-600 hover:text-black dark:hover:bg-blue-700 text-white border-blue-600 dark:border-blue-700'
                onClick={confirmMoveProject}
                disabled={moveConversationMutation.isPending}
              >
                <p className='transition-transform duration-100 group-active:scale-95'>
                  {moveConversationMutation.isPending ? 'Moving...' : 'Move'}
                </p>
              </Button>
            </div>
          </div>
        </div>
      )}

      <EditProject
        isOpen={showEditProjectModal}
        onClose={handleCloseEditProjectModal}
        editingProject={editingProject}
        onProjectCreated={handleSidebarProjectCreated}
      />
    </>
  )
}

export default SideBar
