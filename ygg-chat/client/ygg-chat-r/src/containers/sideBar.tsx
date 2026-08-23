import { useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Settings, Sun, User } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { ConversationId, Project } from '../../../../shared/types'
import { Button } from '../components'
import { MarkdownContent } from '../components/MarkdownContent/MarkdownContent'
import SearchList, { type SearchResultItem } from '../components/SearchList/SearchList'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../components/ThemeManager/themeConfig'
import { contentSpringTransition, shellSpringTransition, softTransition } from '../components/motion'
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
import { useIntersectionObserver } from '../hooks/useIntersectionObserver'
import {
  useConversationsByProjectInfinite,
  useFavoritedConversations,
  useLocalTopLevelUserMessages,
  useMoveConversationToProject,
  useProjects,
  useRecentConversations,
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
const PROJECT_CONVERSATIONS_EXPANSION_DEFER_MS = 180
const CONVERSATION_SORT_POPOVER_WIDTH_PX = 360
const CONVERSATION_SORT_POPOVER_GAP_PX = 8
const PROJECT_CONVERSATIONS_EXPANSION_TRANSITION = {
  duration: PROJECT_CONVERSATIONS_EXPANSION_DEFER_MS / 1000,
  ease: [0.22, 1, 0.36, 1] as const,
}

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const CONVERSATION_SECTION_DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
})

const formatDate = (value?: string | null) => {
  if (!value) return null
  const parsedDate = new Date(value)
  if (Number.isNaN(parsedDate.getTime())) return null
  return DATE_FORMATTER.format(parsedDate)
}

const formatConversationSectionDate = (date: Date) => {
  return CONVERSATION_SECTION_DATE_FORMATTER.format(date)
}

type SidebarConversationSortField = 'updated_at' | 'created_at'
type SidebarConversationSortOrder = 'desc' | 'asc'

interface SidebarConversationSortOptions {
  field: SidebarConversationSortField
  order: SidebarConversationSortOrder
}

interface ConversationDateGroup {
  key: string
  label: string
  conversations: Conversation[]
}

const DEFAULT_CONVERSATION_SORT_OPTIONS: SidebarConversationSortOptions = {
  field: 'updated_at',
  order: 'desc',
}

const getConversationDateGroupKey = (date: Date) => {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

const getConversationSortTimestamp = (conversation: Conversation, field: SidebarConversationSortField) => {
  const value = conversation[field]
  if (!value) return 0
  const timestamp = new Date(value).getTime()
  return Number.isNaN(timestamp) ? 0 : timestamp
}

const sortSidebarConversations = (
  conversations: Conversation[],
  sortOptions: SidebarConversationSortOptions
): Conversation[] => {
  const direction = sortOptions.order === 'asc' ? 1 : -1

  return [...conversations].sort((a, b) => {
    const aTimestamp = getConversationSortTimestamp(a, sortOptions.field)
    const bTimestamp = getConversationSortTimestamp(b, sortOptions.field)
    const timestampDiff = aTimestamp - bTimestamp

    if (timestampDiff !== 0) return timestampDiff * direction

    const titleDiff = (a.title || '').localeCompare(b.title || '')
    if (titleDiff !== 0) return titleDiff

    return String(a.id).localeCompare(String(b.id))
  })
}

const groupConversationsByDate = (
  conversations: Conversation[],
  field: SidebarConversationSortField
): ConversationDateGroup[] => {
  const groups: ConversationDateGroup[] = []
  const groupByKey = new Map<string, ConversationDateGroup>()

  conversations.forEach(conversation => {
    const timestamp = getConversationSortTimestamp(conversation, field)
    const parsedDate = timestamp > 0 ? new Date(timestamp) : null
    const hasValidDate = parsedDate != null && !Number.isNaN(parsedDate.getTime())
    const key = hasValidDate ? getConversationDateGroupKey(parsedDate) : 'unknown-date'
    const label = hasValidDate ? formatConversationSectionDate(parsedDate) : 'Unknown date'
    const existingGroup = groupByKey.get(key)

    if (existingGroup) {
      existingGroup.conversations.push(conversation)
      return
    }

    const nextGroup = { key, label, conversations: [conversation] }
    groupByKey.set(key, nextGroup)
    groups.push(nextGroup)
  })

  return groups
}

interface SidebarSortDropdownOption<T extends string> {
  value: T
  label: string
}

interface SidebarSortDropdownProps<T extends string> {
  value: T
  options: SidebarSortDropdownOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
}

const SidebarSortDropdown = <T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: SidebarSortDropdownProps<T>) => {
  const [open, setOpen] = useState(false)
  const selectedOption = options.find(option => option.value === value) ?? options[0]

  return (
    <div className='relative'>
      <button
        type='button'
        className='flex w-full items-center justify-between gap-3 rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-left text-sm text-neutral-800 outline-none transition-colors hover:bg-neutral-50 focus:border-blue-400 focus:ring-2 focus:ring-blue-400/20 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:hover:bg-neutral-900 dark:focus:border-orange-400 dark:focus:ring-orange-400/20'
        onClick={() => setOpen(previous => !previous)}
        aria-haspopup='listbox'
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span>{selectedOption?.label}</span>
        <i className={`bx bx-chevron-down text-lg leading-none transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden='true'></i>
      </button>

      {open && (
        <div
          role='listbox'
          className='absolute left-0 right-0 top-full z-[1410] mt-1 overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-xl dark:border-neutral-700 dark:bg-neutral-950'
        >
          {options.map(option => {
            const isSelected = option.value === value
            return (
              <button
                key={option.value}
                type='button'
                role='option'
                aria-selected={isSelected}
                className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors ${
                  isSelected
                    ? 'bg-blue-600 text-white dark:bg-orange-500 dark:text-neutral-950'
                    : 'text-neutral-800 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800'
                }`}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                <span>{option.label}</span>
                {isSelected && <i className='bx bx-check text-lg leading-none' aria-hidden='true'></i>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

const PROJECT_ROW_VISIBILITY_STYLE: React.CSSProperties = {
  contentVisibility: 'auto',
  containIntrinsicSize: '52px',
}

const CONVERSATION_ROW_VISIBILITY_STYLE: React.CSSProperties = {
  contentVisibility: 'auto',
  containIntrinsicSize: '44px',
}

const SIDEBAR_ROW_ACTIONS_OVERLAY_BASE_CLASS =
  'pointer-events-none absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 rounded-full bg-white/85 p-1 opacity-0 backdrop-blur-xl transition-opacity dark:bg-neutral-950/85'
const SIDEBAR_ROW_ACTION_BUTTON_CLASS =
  'pointer-events-auto mt-0 flex h-7 w-7 shrink-0 items-center justify-center p-0'

interface SidebarConversationPage {
  conversations: Conversation[]
  nextCursor: string | null
  hasMore: boolean
}

interface SidebarInfiniteConversationData {
  pages: SidebarConversationPage[]
  pageParams: unknown[]
}

interface ProjectAccordionItemProps {
  project: SidebarProject
  isExpanded: boolean
  isCollapsed: boolean
  activeConversationId: ConversationId | null
  favoriteConversationIds: Set<ConversationId>
  hoveredPreviewConversationId?: ConversationId | null
  isElectronMode: boolean
  conversationSortOptions: SidebarConversationSortOptions
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
  conversationSortOptions: SidebarConversationSortOptions
  shouldLoadConversations: boolean
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
    conversationSortOptions,
    shouldLoadConversations,
    onSelectConversation,
    onToggleFavorite,
    onMoveConversation,
    onDeleteConversation,
    enableConversationHoverPreview = false,
    onConversationHoverStart,
    onConversationHoverEnd,
  }) => {
    const isDarkMode = useHtmlDarkMode()
    const { theme: customTheme, enabled: customThemeEnabled } = useCustomChatTheme()
    const {
      data: projectConversationsData,
      isLoading: projectConversationsLoading,
      error: projectConversationsError,
      fetchNextPage,
      hasNextPage,
      isFetchingNextPage,
    } = useConversationsByProjectInfinite(projectId, { enabled: shouldLoadConversations })

    const projectConversations = useMemo(
      () => projectConversationsData?.pages.flatMap(page => page.conversations) ?? [],
      [projectConversationsData]
    )

    const sortedConversations = useMemo(() => {
      return sortSidebarConversations(projectConversations, conversationSortOptions)
    }, [conversationSortOptions, projectConversations])

    const { ref: loadMoreRef, isIntersecting } = useIntersectionObserver<HTMLDivElement>({
      rootMargin: '120px',
      enabled: shouldLoadConversations && Boolean(hasNextPage) && !isFetchingNextPage,
    })

    useEffect(() => {
      if (shouldLoadConversations && isIntersecting && hasNextPage && !isFetchingNextPage) {
        fetchNextPage()
      }
    }, [fetchNextPage, hasNextPage, isFetchingNextPage, isIntersecting, shouldLoadConversations])

    const conversationDateGroups = useMemo(
      () => groupConversationsByDate(sortedConversations, conversationSortOptions.field),
      [conversationSortOptions.field, sortedConversations]
    )

    const conversationDateHeaderStyle = useMemo<React.CSSProperties | undefined>(() => {
      if (!customThemeEnabled) return undefined

      return {
        color: getThemeModeColor(customTheme.colors.streamingAnimationColor, isDarkMode),
      }
    }, [customTheme.colors.streamingAnimationColor, customThemeEnabled, isDarkMode])

    if (!shouldLoadConversations) {
      return <div className='pb-2 pr-2 pl-8' aria-hidden='true' />
    }

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
          conversationDateGroups.map(group => (
            <div key={group.key}>
              <div
                className='px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-blue-600 dark:text-orange-400'
                style={conversationDateHeaderStyle}
              >
                {group.label}
              </div>
              {group.conversations.map(conversation => {
                const isActive = String(activeConversationId) === String(conversation.id)
                const isFavorite = favoriteConversationIds.has(conversation.id)
                const isPreviewHighlighted =
                  enableConversationHoverPreview &&
                  hoveredPreviewConversationId != null &&
                  String(hoveredPreviewConversationId) === String(conversation.id)

                return (
                  <div
                    key={conversation.id}
                    className='group/conv relative mb-1 min-w-0 overflow-visible rounded-md'
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
                      </div>
                    </button>
                    <div
                      className={`${SIDEBAR_ROW_ACTIONS_OVERLAY_BASE_CLASS} group-hover/conv:pointer-events-auto group-hover/conv:opacity-100`}
                    >
                      {isElectronMode && (
                        <Button
                          variant='outline2'
                          size='smaller'
                          rounded='full'
                          className={SIDEBAR_ROW_ACTION_BUTTON_CLASS}
                          onClick={() => onToggleFavorite(conversation)}
                          title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                          aria-label={`${isFavorite ? 'Remove' : 'Add'} ${conversation.title || conversation.id} ${isFavorite ? 'from' : 'to'} favorites`}
                        >
                          <i
                            className={`bx ${isFavorite ? 'bxs-star text-yellow-500' : 'bx-star'} text-[16px] pointer-events-none`}
                            aria-hidden='true'
                          ></i>
                        </Button>
                      )}
                      <Button
                        variant='outline2'
                        size='smaller'
                        rounded='full'
                        className={SIDEBAR_ROW_ACTION_BUTTON_CLASS}
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
                        className={`${SIDEBAR_ROW_ACTION_BUTTON_CLASS} text-red-500 dark:text-red-400`}
                        onClick={() => onDeleteConversation(conversation)}
                        title='Delete conversation'
                        aria-label={`Delete conversation ${conversation.title || conversation.id}`}
                      >
                        <i className='bx bx-trash text-lg' aria-hidden='true'></i>
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        {!projectConversationsLoading && !projectConversationsError && hasNextPage && (
          <div ref={loadMoreRef} className='py-2 text-center text-[10px] text-neutral-500 dark:text-neutral-400'>
            {isFetchingNextPage ? 'Loading more chats...' : 'Load more chats'}
          </div>
        )}
        {!projectConversationsLoading && !projectConversationsError && isFetchingNextPage && !hasNextPage && (
          <div className='py-2 text-center text-[10px] text-neutral-500 dark:text-neutral-400'>Loading more chats...</div>
        )}
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
    conversationSortOptions,
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
    const [isConversationPanelReady, setIsConversationPanelReady] = useState(() => isExpanded)

    useEffect(() => {
      if (!isExpanded) {
        setIsConversationPanelReady(false)
        return
      }

      setIsConversationPanelReady(false)
      const timeoutId = window.setTimeout(() => {
        setIsConversationPanelReady(true)
      }, PROJECT_CONVERSATIONS_EXPANSION_DEFER_MS)

      return () => {
        window.clearTimeout(timeoutId)
      }
    }, [isExpanded])

    return (
      <div
        className='sm:mb-1 md:mb-1 lg:mb-1.5 2xl:mb-2 group relative overflow-visible'
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
            className='flex w-full cursor-pointer items-center justify-center rounded-lg py-2 text-left transition-transform duration-150 hover:scale-[1.02] active:scale-[0.98]'
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
          <div className='relative overflow-visible rounded-lg transition-colors duration-150'>
            <div className='group/projectHeader relative min-w-0 rounded-lg px-2 py-2 hover:bg-stone-100/30 dark:hover:bg-yBlack-900/10'>
              <button
                type='button'
                onClick={() => onToggle(project.id)}
                className='flex w-full min-w-0 items-start gap-2 text-left'
                aria-expanded={isExpanded}
              >
                <motion.i
                  className='bx bx-chevron-right mt-0.5 inline-flex h-5 w-5 items-center justify-center text-lg leading-none text-neutral-500'
                  animate={{ rotate: isExpanded ? 90 : 0 }}
                  transition={contentSpringTransition}
                  aria-hidden='true'
                />
                <div className='min-w-0 flex-1'>
                  <div className='flex items-center gap-1 min-w-0'>
                    <div className='text-[13px] md:text-[13px] lg:text-[14px] xl:text-[14px] 2xl:text-[15px] font-medium text-neutral-900 dark:text-stone-200 truncate min-w-0 flex-1'>
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
                    <div className='mt-1 text-[11px] text-neutral-500 dark:text-neutral-400'>
                      {projectLastActivityDateLabel}
                    </div>
                  )}
                </div>
              </button>
              <div className={`${SIDEBAR_ROW_ACTIONS_OVERLAY_BASE_CLASS} group-hover/projectHeader:pointer-events-auto group-hover/projectHeader:opacity-100`}>
                <Button
                  variant='outline2'
                  size='smaller'
                  rounded='full'
                  className={SIDEBAR_ROW_ACTION_BUTTON_CLASS}
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
                  className={SIDEBAR_ROW_ACTION_BUTTON_CLASS}
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
                  className={`${SIDEBAR_ROW_ACTION_BUTTON_CLASS} text-red-500 dark:text-red-400`}
                  onClick={() => onDeleteProject(project)}
                  title='Delete project'
                  aria-label={`Delete project ${project.name}`}
                >
                  <i className='bx bx-trash text-lg' aria-hidden='true'></i>
                </Button>
              </div>
            </div>

            <AnimatePresence initial={false}>
              {isExpanded && (
                <motion.div
                  key='project-conversations'
                  className='overflow-hidden'
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={PROJECT_CONVERSATIONS_EXPANSION_TRANSITION}
                  layout
                >
                  <ProjectConversationsPanel
                    projectId={project.id}
                    activeConversationId={activeConversationId}
                    favoriteConversationIds={favoriteConversationIds}
                    hoveredPreviewConversationId={hoveredPreviewConversationId}
                    isElectronMode={isElectronMode}
                    conversationSortOptions={conversationSortOptions}
                    shouldLoadConversations={isConversationPanelReady}
                    onSelectConversation={onSelectConversation}
                    onToggleFavorite={onToggleFavorite}
                    onMoveConversation={onMoveConversation}
                    onDeleteConversation={onDeleteConversation}
                    enableConversationHoverPreview={enableConversationHoverPreview}
                    onConversationHoverStart={onConversationHoverStart}
                    onConversationHoverEnd={onConversationHoverEnd}
                  />
                </motion.div>
              )}
            </AnimatePresence>
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
  const [conversationSortOptions, setConversationSortOptions] = useState<SidebarConversationSortOptions>(
    DEFAULT_CONVERSATION_SORT_OPTIONS
  )
  const [draftConversationSortOptions, setDraftConversationSortOptions] = useState<SidebarConversationSortOptions>(
    DEFAULT_CONVERSATION_SORT_OPTIONS
  )
  const [showConversationSortModal, setShowConversationSortModal] = useState(false)
  const [conversationSortModalPosition, setConversationSortModalPosition] = useState({ top: 96, left: 16 })
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

  const favoriteConversationDateGroups = useMemo(
    () => groupConversationsByDate(displayedFavoriteConversations, 'updated_at'),
    [displayedFavoriteConversations]
  )

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
    return new Map<string, string>(
      projectData.map((project): [string, string] => [String(project.id), String(project.name ?? '')])
    )
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
  const conversationSortButtonRef = useRef<HTMLButtonElement | null>(null)
  const { data: recentConversations = [] } = useRecentConversations(limit)

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
      const projectConversationsQueryKey = ['conversations', 'project', normalizedProjectId]
      const projectConversationsInfiniteQueryKey = ['conversations', 'project', normalizedProjectId, 'infinite']

      if (!isExpandPortalOpen) {
        queryClient.invalidateQueries({ queryKey: projectConversationsQueryKey, refetchType: 'none' })
        queryClient.invalidateQueries({ queryKey: projectConversationsInfiniteQueryKey, refetchType: 'none' })
        setExpandedProjectIds(prev => (prev.includes(normalizedProjectId) ? prev : [normalizedProjectId, ...prev]))
        openExpandPortal()
        return
      }

      setExpandedProjectIds(prev => {
        const isCurrentlyExpanded = prev.includes(normalizedProjectId)

        if (!isCurrentlyExpanded) {
          queryClient.invalidateQueries({ queryKey: projectConversationsQueryKey, refetchType: 'none' })
          queryClient.invalidateQueries({ queryKey: projectConversationsInfiniteQueryKey, refetchType: 'none' })
        }

        return isCurrentlyExpanded ? prev.filter(id => id !== normalizedProjectId) : [...prev, normalizedProjectId]
      })
    },
    [isExpandPortalOpen, openExpandPortal, queryClient]
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
        queryClient.removeQueries({ queryKey: ['conversations', 'project', project.id, 'infinite'] })

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
      const shouldDelete = window.confirm(`Delete conversation \"${label}\"? This action cannot be undone.`)
      if (!shouldDelete) return

      const wasActiveConversation = String(activeConversationId) === String(conversation.id)
      const previousHistoryEntry = typeof window !== 'undefined' ? window.history.state?.idx : null

      try {
        await dispatch(
          deleteConversation({ id: conversation.id, storageMode: conversation.storage_mode || 'cloud' })
        ).unwrap()

        queryClient.setQueryData<Conversation[]>(['conversations', 'project', conversation.project_id], previous =>
          previous ? previous.filter(item => String(item.id) !== String(conversation.id)) : previous
        )
        queryClient.setQueryData<SidebarInfiniteConversationData>(
          ['conversations', 'project', conversation.project_id, 'infinite'],
          previous =>
            previous
              ? {
                  ...previous,
                  pages: previous.pages.map(page => ({
                    ...page,
                    conversations: page.conversations.filter(item => String(item.id) !== String(conversation.id)),
                  })),
                }
              : previous
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

        if (wasActiveConversation) {
          closeExpandPortal(false)

          if (previousHistoryEntry != null && previousHistoryEntry > 0) {
            navigate(-1)
          } else {
            const fallbackConversation = recentConversations.find(candidate => {
              if (String(candidate.id) === String(conversation.id)) return false
              return String(candidate.project_id) === String(conversation.project_id)
            })

            if (fallbackConversation?.id && fallbackConversation.project_id) {
              dispatch(chatSliceActions.conversationSet(fallbackConversation.id))
              dispatch(activeConversationIdSet(fallbackConversation.id))
              navigate(`/chat/${fallbackConversation.project_id}/${fallbackConversation.id}`, {
                replace: true,
                state: fallbackConversation.storage_mode
                  ? { storageMode: fallbackConversation.storage_mode }
                  : undefined,
              })
            } else {
              navigate('/homepage', { replace: true })
            }
          }
        }

        queryClient.invalidateQueries({ queryKey: ['projects'] })
        queryClient.invalidateQueries({ queryKey: ['conversations'] })
      } catch (deleteError) {
        console.error('Failed to delete conversation from sidebar:', deleteError)
      }
    },
    [activeConversationId, closeExpandPortal, dispatch, navigate, queryClient, recentConversations]
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
            cwd: project.cwd || null,
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
        queryClient.setQueryData<SidebarInfiniteConversationData>(
          ['conversations', 'project', project.id, 'infinite'],
          previous => {
            if (!previous || previous.pages.length === 0) {
              return {
                pages: [{ conversations: [createdConversation], nextCursor: null, hasMore: false }],
                pageParams: [undefined],
              }
            }

            return {
              ...previous,
              pages: [
                {
                  ...previous.pages[0],
                  conversations: [
                    createdConversation,
                    ...previous.pages[0].conversations.filter(item => item.id !== createdConversation.id),
                  ],
                },
                ...previous.pages.slice(1),
              ],
            }
          }
        )

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
        const inheritedCwd = createdConversation.storage_mode === 'local' ? createdConversation.cwd || project.cwd || '' : ''
        dispatch(chatSliceActions.ccCwdSet(inheritedCwd))
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

  const updateConversationSortModalPosition = useCallback(() => {
    if (typeof window === 'undefined') return

    const rect = conversationSortButtonRef.current?.getBoundingClientRect()
    if (!rect) return

    const viewportPadding = 8
    const width = Math.min(CONVERSATION_SORT_POPOVER_WIDTH_PX, window.innerWidth - viewportPadding * 2)
    const desiredLeft = rect.right - width
    const left = Math.max(viewportPadding, Math.min(desiredLeft, window.innerWidth - width - viewportPadding))
    const desiredTop = rect.bottom + CONVERSATION_SORT_POPOVER_GAP_PX
    const top = Math.max(viewportPadding, Math.min(desiredTop, window.innerHeight - viewportPadding - 120))

    setConversationSortModalPosition({ top, left })
  }, [])

  const handleOpenConversationSortModal = useCallback(() => {
    setDraftConversationSortOptions(conversationSortOptions)
    updateConversationSortModalPosition()
    setShowConversationSortModal(true)
  }, [conversationSortOptions, updateConversationSortModalPosition])

  const handleCloseConversationSortModal = useCallback(() => {
    setShowConversationSortModal(false)
  }, [])

  const handleApplyConversationSortOptions = useCallback(() => {
    setConversationSortOptions(draftConversationSortOptions)
    setShowConversationSortModal(false)
  }, [draftConversationSortOptions])

  useEffect(() => {
    if (!showConversationSortModal) return

    updateConversationSortModalPosition()
    window.addEventListener('resize', updateConversationSortModalPosition)
    window.addEventListener('scroll', updateConversationSortModalPosition, true)

    return () => {
      window.removeEventListener('resize', updateConversationSortModalPosition)
      window.removeEventListener('scroll', updateConversationSortModalPosition, true)
    }
  }, [showConversationSortModal, updateConversationSortModalPosition])

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
        icon:
          themeMode === 'System' ? (
            <Monitor className='h-5 w-5' aria-hidden='true' />
          ) : themeMode === 'Dark' ? (
            <Moon className='h-5 w-5' aria-hidden='true' />
          ) : (
            <Sun className='h-5 w-5' aria-hidden='true' />
          ),
        onClick: cycleTheme,
        title: `Theme: ${themeMode} (click to change)`,
        ariaLabel: `Theme: ${themeMode}`,
      },
      {
        key: 'logging',
        label: 'Logging',
        icon: <BarChart3 className='h-5 w-5' strokeWidth={2.25} aria-hidden='true' />,
        onClick: () => navigate('/logging'),
        title: 'Open logging',
        ariaLabel: 'Open logging',
      },
      {
        key: 'profile',
        label: 'Profile',
        icon: <User className='h-5 w-5' strokeWidth={2.25} aria-hidden='true' />,
        onClick: () => navigate('/payment'),
        title: 'Open profile',
        ariaLabel: 'Open profile',
      },
      {
        key: 'settings',
        label: 'Settings',
        icon: <Settings className='h-5 w-5' strokeWidth={2.25} aria-hidden='true' />,
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
      ? 'flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-transparent dark:bg-transparent text-stone-900 dark:text-neutral-300'
      : 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-transparent dark:bg-neutral-900 dark:text-neutral-300 text-neutral-100'

    return (
      <>
        {!renderCollapsed && (
          <div className='px-2 pb-2'>
            <div className='rounded-full p-1'>
              <div className='grid grid-cols-2 gap-1'>
                <button
                  type='button'
                  onClick={() => setConversationTab('recent')}
                  className={`rounded-full px-3 py-2 text-sm font-semibold transition-[background-color,color,transform] duration-150 ${
                    conversationTab === 'recent'
                      ? 'bg-white/80 text-neutral-900 shadow-[0_0_8px_rgba(15,23,42,0.08)] dark:bg-white/15 dark:text-neutral-100 dark:shadow-none'
                      : 'text-neutral-500 hover:bg-white/45 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-200'
                  }`}
                >
                  Projects
                </button>
                <button
                  type='button'
                  onClick={() => setConversationTab('favorites')}
                  className={`rounded-full px-3 py-2 text-sm font-semibold transition-[background-color,color,transform] duration-150 ${
                    conversationTab === 'favorites'
                      ? 'bg-white/80 text-neutral-900 shadow-[0_0_8px_rgba(15,23,42,0.08)] dark:bg-white/15 dark:text-neutral-100 dark:shadow-none'
                      : 'text-neutral-500 hover:bg-white/45 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-200'
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
                inputRounding='full'
                inputClassName='border-0 bg-white/55 px-4 py-2.5 text-neutral-800 placeholder:text-neutral-500 shadow-none outline-none focus:border-transparent focus:ring-2 focus:ring-blue-400/50 dark:border-0 dark:bg-white/10 dark:text-neutral-100 dark:placeholder:text-neutral-400 dark:focus:border-transparent dark:focus:ring-orange-400/40'
              />
            </div>
            <div className='px-2 pb-2'>
              <div className='flex items-center gap-2'>
                <button
                  onClick={handleOpenCreateProject}
                  className='group flex min-w-0 flex-1 items-center justify-center gap-2 rounded-full bg-white/80 px-3 py-2.5 shadow-[0_0_8px_rgba(15,23,42,0.08)] backdrop-blur-sm dark:bg-white/10 dark:text-neutral-100 dark:shadow-[0_0_8px_rgba(15,23,42,0.38)]'
                  title='Create a new project'
                  aria-label='Create a new project'
                >
                  <i className='bx bx-plus flex h-5 w-5 items-center justify-center text-lg leading-none transition-transform duration-100 group-active:scale-90'></i>
                  <span className='truncate text-sm font-medium leading-5'>New Project</span>
                </button>
                <button
                  ref={conversationSortButtonRef}
                  type='button'
                  onClick={handleOpenConversationSortModal}
                  className='group flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/80 shadow-[0_0_8px_rgba(15,23,42,0.08)] backdrop-blur-sm transition-transform duration-100 active:scale-95 dark:bg-white/10 dark:text-neutral-100 dark:shadow-[0_0_8px_rgba(15,23,42,0.38)]'
                  title='Sort project conversations'
                  aria-label='Sort project conversations'
                  aria-haspopup='dialog'
                  aria-expanded={showConversationSortModal}
                >
                  <i className='bx bx-sort-alt-2 text-xl leading-none transition-transform duration-100 group-active:scale-90' aria-hidden='true'></i>
                </button>
              </div>
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
                    conversationSortOptions={conversationSortOptions}
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
                favoriteConversationDateGroups.map(group => (
                  <div key={group.key}>
                    <div className='px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-blue-600 dark:text-orange-400'>
                      {group.label}
                    </div>
                    {group.conversations.map(conv => {
                      const isActive = activeConversationId === conv.id
                      const isPreviewHighlighted =
                        enableMiniHoverPreview &&
                        hoveredConversationId != null &&
                        String(hoveredConversationId) === String(conv.id)
                      const projectName = conv.project_id ? projectNameById.get(String(conv.project_id)) : undefined

                      return (
                        <div
                          key={conv.id}
                          className='group/fav relative mb-1 min-w-0 overflow-visible rounded-md'
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
                          <button
                            type='button'
                            onClick={() => handleSelect(conv.id)}
                            className={`w-full min-w-0 overflow-hidden rounded-md px-2 py-1.5 text-left text-xs transition-colors md:text-[11px] lg:text-[12px] ${
                              isActive
                                ? 'bg-blue-100 text-blue-700 dark:bg-neutral-500/40 dark:text-orange-300'
                                : isPreviewHighlighted
                                  ? 'bg-neutral-200/60 text-neutral-700 dark:bg-neutral-800/70 dark:text-neutral-300'
                                  : 'text-neutral-700 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-800/70'
                            }`}
                          >
                            <div className='min-w-0'>
                              <div className='truncate'>{conv.title || 'Untitled conversation'}</div>
                              {projectName && (
                                <div className='mt-0.5 truncate text-[10px] text-neutral-500 dark:text-neutral-400'>
                                  {projectName}
                                </div>
                              )}
                            </div>
                          </button>
                          <div className={`${SIDEBAR_ROW_ACTIONS_OVERLAY_BASE_CLASS} group-hover/fav:pointer-events-auto group-hover/fav:opacity-100`}>
                            {isElectronMode && (
                              <Button
                                variant='outline2'
                                size='smaller'
                                rounded='full'
                                className={SIDEBAR_ROW_ACTION_BUTTON_CLASS}
                                onClick={() => handleToggleFavorite(conv)}
                                title='Remove from favorites'
                                aria-label={`Remove ${conv.title || conv.id} from favorites`}
                              >
                                <i className='bx bxs-star text-[16px] text-yellow-500' aria-hidden='true'></i>
                              </Button>
                            )}
                            <Button
                              variant='outline2'
                              size='smaller'
                              rounded='full'
                              className={SIDEBAR_ROW_ACTION_BUTTON_CLASS}
                              onClick={() => handleOpenMoveConversation(conv)}
                              title='Conversation actions'
                              aria-label={`Conversation actions for ${conv.title || conv.id}`}
                            >
                              <i className='bx bx-dots-horizontal-rounded text-lg' aria-hidden='true'></i>
                            </Button>
                            <Button
                              variant='outline2'
                              size='smaller'
                              rounded='full'
                              className={`${SIDEBAR_ROW_ACTION_BUTTON_CLASS} text-red-500 dark:text-red-400`}
                              onClick={() => handleDeleteSidebarConversation(conv)}
                              title='Delete conversation'
                              aria-label={`Delete conversation ${conv.title || conv.id}`}
                            >
                              <i className='bx bx-trash text-lg' aria-hidden='true'></i>
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ))}
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
          <div className='px-0.5 py-2'>
            {sidebarActions.map(action => (
              <button
                key={action.key}
                type='button'
                onClick={action.onClick}
                title={action.title}
                aria-label={action.ariaLabel}
                className='group flex w-full items-center justify-center rounded-3xl px-0 py-1.5 transition-colors'
              >
                <span
                  className={`${actionIconShellClass} transition-transform duration-100 group-hover:scale-105 group-active:scale-95`}
                >
                  {action.icon}
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
  const sidebarToggleIcon = showExpandedPortal ? (
    <PanelLeftClose className='h-5 w-5' strokeWidth={2.25} aria-hidden='true' />
  ) : (
    <PanelLeftOpen className='h-5 w-5' strokeWidth={2.25} aria-hidden='true' />
  )

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
            variant='outline2'
            size='circle'
            rounded='full'
            onClick={handleToggleSidebar}
            className='mx-auto p-2 transition-transform duration-150 hover:scale-[1.02] active:scale-[0.98]'
            aria-label={sidebarToggleAriaLabel}
            aria-haspopup='dialog'
            aria-expanded={showExpandedPortal}
          >
            {sidebarToggleIcon}
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
                  transition={softTransition}
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
                  transition={shellSpringTransition}
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
                      transition={contentSpringTransition}
                    >
                      <div className='h-full min-h-0 flex flex-col'>
                        <div className='px-3 py-2 border-b border-neutral-200/80 dark:border-neutral-800/80 space-y-2'>
                          <div>
                            <h3 className='text-sm font-semibold text-neutral-800 dark:text-neutral-100 truncate'>
                              {hoveredPreviewConversation?.title || 'Untitled conversation'}
                            </h3>
                            <p className='text-[11px] text-neutral-500 dark:text-neutral-400'>
                              Top-level user messages
                            </p>
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
                                <MarkdownContent
                                  content={message.note || message.plain_text_content || message.content}
                                  className='text-[11px] font-medium text-blue-600 dark:text-orange-400 prose-p:my-0 prose-pre:my-2 prose-ul:my-1 prose-ol:my-1'
                                />
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

      {/* Project Conversation Sort Modal */}
      {showConversationSortModal && (
        <div
          className='fixed inset-0 z-[1300] bg-transparent'
          onClick={handleCloseConversationSortModal}
        >
          <div
            className='fixed bg-neutral-50/95 text-neutral-900 backdrop-blur-xl dark:bg-neutral-900/95 rounded-3xl border border-gray-200 dark:border-zinc-700 w-[calc(100vw-16px)] max-w-sm p-6 shadow-[0_8px_32px_rgba(0,0,0,0.1)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.3)]'
            style={{
              top: `${conversationSortModalPosition.top}px`,
              left: `${conversationSortModalPosition.left}px`,
              width: `${CONVERSATION_SORT_POPOVER_WIDTH_PX}px`,
            }}
            onClick={event => event.stopPropagation()}
          >
            <div className='mb-5 flex items-start justify-between gap-3'>
              <div>
                <h3 className='text-xl font-semibold dark:text-neutral-100'>Sort conversations</h3>
                <p className='mt-1 text-sm text-neutral-600 dark:text-neutral-400'>
                  Choose how conversations are ordered inside expanded projects.
                </p>
              </div>
              <Button
                variant='outline2'
                size='smaller'
                rounded='full'
                className='mt-0 flex h-8 w-8 shrink-0 items-center justify-center p-0'
                onClick={handleCloseConversationSortModal}
                aria-label='Close conversation sort options'
              >
                <i className='bx bx-x text-lg' aria-hidden='true'></i>
              </Button>
            </div>

            <div className='space-y-4'>
              <label className='block'>
                <span className='mb-2 block text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400'>
                  Sort by
                </span>
                <SidebarSortDropdown<SidebarConversationSortField>
                  value={draftConversationSortOptions.field}
                  onChange={field =>
                    setDraftConversationSortOptions(prev => ({
                      ...prev,
                      field,
                    }))
                  }
                  options={[
                    { value: 'updated_at', label: 'Updated at' },
                    { value: 'created_at', label: 'Created at' },
                  ]}
                  ariaLabel='Choose project conversation sort field'
                />
              </label>

              <label className='block'>
                <span className='mb-2 block text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400'>
                  Order
                </span>
                <SidebarSortDropdown<SidebarConversationSortOrder>
                  value={draftConversationSortOptions.order}
                  onChange={order =>
                    setDraftConversationSortOptions(prev => ({
                      ...prev,
                      order,
                    }))
                  }
                  options={[
                    { value: 'desc', label: 'Newest first' },
                    { value: 'asc', label: 'Oldest first' },
                  ]}
                  ariaLabel='Choose project conversation sort order'
                />
              </label>
            </div>

            <div className='mt-6 flex justify-end gap-3'>
              <Button
                variant='outline2'
                size='circle'
                rounded='full'
                className='group'
                onClick={handleCloseConversationSortModal}
              >
                <p className='transition-transform duration-100 group-active:scale-95'>Cancel</p>
              </Button>
              <Button
                variant='outline2'
                size='circle'
                rounded='full'
                className='group bg-blue-500 hover:bg-blue-600 dark:bg-blue-600 hover:text-black dark:hover:bg-blue-700 text-white border-blue-600 dark:border-blue-700 px-5 py-2.5'
                onClick={handleApplyConversationSortOptions}
              >
                <p className='transition-transform duration-100 group-active:scale-95'>Apply</p>
              </Button>
            </div>
          </div>
        </div>
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
              <Button
                variant='outline2'
                size='circle'
                rounded='full'
                className='group'
                onClick={() => setShowMoveModal(false)}
              >
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
