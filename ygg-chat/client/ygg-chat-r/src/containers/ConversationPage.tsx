import { InfiniteData, useQueryClient } from '@tanstack/react-query'
import 'boxicons'
import 'boxicons/css/boxicons.min.css'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useChatNavigate as useNavigate } from '../components/ChatSelection/ChatSelectionProvider'
import type { StorageMode } from '../../../../shared/types'
import { Button } from '../components'
import { isCommunityMode } from '../config/runtimeMode'
import { LowBar } from '../components/LowBar/LowBar'
import { Select } from '../components/Select/Select'
import { TextField } from '../components/TextField/TextField'
import { chatSliceActions } from '../features/chats'
import {
  activeConversationIdSet,
  Conversation,
  conversationsLoaded,
  createConversation,
  deleteConversation,
  selectConvError,
} from '../features/conversations'
import { clearSelectedProject, projectsLoaded, selectSelectedProject, setSelectedProject } from '../features/projects'

import { useAppDispatch, useAppSelector } from '../hooks/redux'
import { useIntersectionObserver } from '../hooks/useIntersectionObserver'
import {
  PaginatedConversationsResponse,
  useConversationsByProjectInfinite,
  useConversationsInfinite,
  useFavoritedConversations,
  useMoveConversationToProject,
  useProject,
  useProjects,
  useResearchNotes,
  useSearchConversations,
} from '../hooks/useQueries'
import { localApi } from '../utils/api'
import { parseId } from '../utils/helpers'
import { DownloadAppModal } from './downloadApp'
import EditProject from './EditProject'

const ConversationPage: React.FC = () => {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const projectIdParam = searchParams.get('projectId')
  const projectId = projectIdParam ? parseId(projectIdParam) : null

  // Check if running in Electron
  const isElectronMode =
    import.meta.env.VITE_ENVIRONMENT === 'electron' ||
    (typeof process !== 'undefined' && process.env?.VITE_ENVIRONMENT === 'electron')

  // Use React Query with infinite scroll for data fetching
  // Fetch project-specific conversations OR all conversations (not both)
  const {
    data: projectConversationsData,
    isLoading: projectConvsLoading,
    isRefetching: projectConvsRefetching,
    refetch: refetchProjectConversations,
    fetchNextPage: fetchNextProjectPage,
    hasNextPage: hasNextProjectPage,
    isFetchingNextPage: isFetchingNextProjectPage,
  } = useConversationsByProjectInfinite(projectId)

  // Only fetch all conversations when NOT viewing a specific project
  const {
    data: allConversationsData,
    isLoading: allConvsLoading,
    isRefetching: allConvsRefetching,
    refetch: refetchAllConversations,
    fetchNextPage: fetchNextAllPage,
    hasNextPage: hasNextAllPage,
    isFetchingNextPage: isFetchingNextAllPage,
  } = useConversationsInfinite(!projectId)

  // Project data is fetched but not directly used - populates React Query cache
  useProject(projectId)
  const { data: allProjects = [] } = useProjects()

  // Fetch research notes for display in LowBar
  const { data: researchNotes = [], isLoading: notesLoading } = useResearchNotes()
  const { data: favoriteConversations = [] } = useFavoritedConversations(null)

  // Flatten pages into single array for rendering
  const projectConversations = useMemo(
    () => projectConversationsData?.pages.flatMap(page => page.conversations) ?? [],
    [projectConversationsData]
  )

  const allConversations = useMemo(
    () => allConversationsData?.pages.flatMap(page => page.conversations) ?? [],
    [allConversationsData]
  )

  // Select appropriate data based on context
  const conversations = projectId ? projectConversations : allConversations
  const loading = projectId ? projectConvsLoading : allConvsLoading
  const isRefetching = projectId ? projectConvsRefetching : allConvsRefetching
  const refetchConversations = projectId ? refetchProjectConversations : refetchAllConversations
  const fetchNextPage = projectId ? fetchNextProjectPage : fetchNextAllPage
  const hasNextPage = projectId ? hasNextProjectPage : hasNextAllPage
  const isFetchingNextPage = projectId ? isFetchingNextProjectPage : isFetchingNextAllPage
  const favoriteConversationIds = useMemo(
    () => new Set(favoriteConversations.map(conversation => conversation.id)),
    [favoriteConversations]
  )

  // Intersection observer for infinite scroll
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const { ref: loadMoreRef, isIntersecting } = useIntersectionObserver<HTMLLIElement>({
    root: scrollContainerRef.current,
    rootMargin: '100px', // Trigger 100px before reaching the bottom
    enabled: hasNextPage && !isFetchingNextPage,
  })

  // Trigger load more when sentinel is visible
  useEffect(() => {
    if (isIntersecting && hasNextPage && !isFetchingNextPage) {
      fetchNextPage()
    }
  }, [isIntersecting, hasNextPage, isFetchingNextPage, fetchNextPage])

  // Sync React Query data to Redux
  // Simple approach: just load the conversations from React Query
  // The optimistic update in Chat.tsx handles both React Query AND Redux
  useEffect(() => {
    if (conversations.length > 0) {
      dispatch(conversationsLoaded(conversations))
    }
  }, [conversations, dispatch])

  useEffect(() => {
    if (allProjects.length > 0) {
      dispatch(projectsLoaded(allProjects))
    }
  }, [allProjects, dispatch])

  // Set selected project based on URL parameter
  useEffect(() => {
    if (projectId && allProjects.length > 0) {
      const project = allProjects.find(p => p.id === projectId)
      if (project) {
        dispatch(setSelectedProject(project))
      }
    } else if (!projectId) {
      dispatch(clearSelectedProject())
    }
  }, [projectId, allProjects, dispatch])

  const selectedProject = useAppSelector(selectSelectedProject)
  const error = useAppSelector(selectConvError)

  const [showEditProjectModal, setShowEditProjectModal] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [conversationToDelete, setConversationToDelete] = useState<Conversation | null>(null)
  const [sortBy, setSortBy] = useState<'updated' | 'created' | 'name'>('updated')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [searchQuery, setSearchQuery] = useState('')

  // Search hook with local-first optimization
  const { search, clearSearch, searchResults, isSearching } = useSearchConversations(projectId)
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Debounced search effect
  useEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current)
    }

    if (searchQuery.trim()) {
      searchTimeoutRef.current = setTimeout(() => {
        search(searchQuery)
      }, 300) // 300ms debounce delay
    } else {
      clearSearch()
    }

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current)
      }
    }
  }, [searchQuery, search, clearSearch])
  const [showNewConversationModal, setShowNewConversationModal] = useState(false)
  const [newConvTitle, setNewConvTitle] = useState('')
  const [storageMode, setStorageMode] = useState<StorageMode>(isCommunityMode ? 'local' : 'cloud')
  // Download app modal state
  const [showDownloadModal, setShowDownloadModal] = useState(false)
  // Move project modal state
  const [showMoveModal, setShowMoveModal] = useState(false)
  const [conversationToMove, setConversationToMove] = useState<Conversation | null>(null)
  // Move confirmation state
  const [showMoveConfirm, setShowMoveConfirm] = useState(false)
  const [destinationProject, setDestinationProject] = useState<{ id: string; name: string } | null>(null)
  // Move mutation
  const moveConversationMutation = useMoveConversationToProject()
  // Sorting function for conversations
  const sortConversations = (
    convs: Conversation[],
    sortBy: 'updated' | 'created' | 'name',
    invert: boolean = false
  ) => {
    const sorted = [...convs].sort((a, b) => {
      switch (sortBy) {
        case 'updated':
          // Use updated_at if available, otherwise fall back to created_at
          const aDate = a.updated_at || a.created_at || ''
          const bDate = b.updated_at || b.created_at || ''
          if (!aDate) return 1
          if (!bDate) return -1
          return bDate.localeCompare(aDate)

        case 'created':
          if (!a.created_at) return 1
          if (!b.created_at) return -1
          return b.created_at.localeCompare(a.created_at)

        case 'name':
          const aTitle = a.title || `Conversation ${a.id}`
          const bTitle = b.title || `Conversation ${b.id}`
          return aTitle.localeCompare(bTitle)

        default:
          return 0
      }
    })

    return invert ? sorted.reverse() : sorted
  }

  // Sort conversations
  const sortedConversations = sortConversations(conversations, sortBy, sortOrder === 'asc')

  // Use search results if searching, otherwise use sorted conversations
  const displayedConversations = searchQuery.trim() ? searchResults : sortedConversations
  const isShowingSearchResults = searchQuery.trim().length > 0

  // Search dropdown is handled inside SearchList component

  useEffect(() => {
    dispatch(chatSliceActions.stateReset())
    dispatch(chatSliceActions.heimdallDataLoaded({ treeData: null }))

    // Conversations and project are now fetched via React Query hooks above
    // No need to dispatch Redux actions - React Query handles caching and deduplication
  }, [dispatch])

  // Dropdown open/close is managed internally by SearchList

  const handleSelect = (conv: Conversation) => {
    dispatch(chatSliceActions.conversationSet(conv.id))
    navigate(`/chat/${conv.project_id}/${conv.id}`)
    dispatch(activeConversationIdSet(conv.id))
  }

  const handleDelete = (conversation: Conversation) => {
    setConversationToDelete(conversation)
    setShowDeleteConfirm(true)
  }

  const handleEditClick = (e: React.MouseEvent, conv: Conversation) => {
    e.stopPropagation()
    setConversationToMove(conv)
    setShowMoveModal(true)
  }

  const handleToggleFavorite = async (e: React.MouseEvent, conv: Conversation) => {
    e.stopPropagation()
    if (!isElectronMode) return

    const nextFavorite = favoriteConversationIds.has(conv.id) ? 0 : 1

    try {
      await localApi.patch(`/app/conversations/${conv.id}/favorite`, { favorite: nextFavorite })
      refetchConversations()
      queryClient.invalidateQueries({ queryKey: ['conversations', 'favorites'] })
      queryClient.invalidateQueries({ queryKey: ['conversations', 'recent'] })
    } catch (error) {
      console.error('Failed to update conversation favorite:', error)
    }
  }

  const handleSelectDestinationProject = (project: { id: string; name: string }) => {
    setDestinationProject(project)
    setShowMoveModal(false)
    setShowMoveConfirm(true)
  }

  const confirmMoveProject = async () => {
    if (!conversationToMove || !destinationProject) return

    const sourceProjectId = conversationToMove.project_id || null
    await moveConversationMutation.mutateAsync({
      conversationId: conversationToMove.id,
      sourceProjectId,
      destinationProjectId: destinationProject.id,
    })

    setShowMoveConfirm(false)
    setConversationToMove(null)
    setDestinationProject(null)
  }

  const cancelMoveProject = () => {
    setShowMoveConfirm(false)
    setDestinationProject(null)
  }

  const getProjectName = (projectId: string | null | undefined): string => {
    if (!projectId) return 'No Project'
    const project = allProjects.find(p => p.id === projectId)
    return project?.name || 'Unknown Project'
  }

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [])

  const confirmDelete = async () => {
    if (!conversationToDelete) return

    const id = conversationToDelete.id
    await dispatch(deleteConversation({ id }))

    // Update infinite query caches
    queryClient.setQueryData(
      ['conversations', 'infinite'],
      (old: InfiniteData<PaginatedConversationsResponse> | undefined) => {
        if (!old) return old
        return {
          ...old,
          pages: old.pages.map(page => ({
            ...page,
            conversations: page.conversations.filter(c => c.id !== id),
          })),
        }
      }
    )

    // Update project-specific infinite cache
    if (projectId) {
      queryClient.setQueryData(
        ['conversations', 'project', projectId, 'infinite'],
        (old: InfiniteData<PaginatedConversationsResponse> | undefined) => {
          if (!old) return old
          return {
            ...old,
            pages: old.pages.map(page => ({
              ...page,
              conversations: page.conversations.filter(c => c.id !== id),
            })),
          }
        }
      )
    }

    // Keep flat array caches updated for backward compatibility (SideBar, other components)
    queryClient.setQueryData(['conversations'], (old: Conversation[] | undefined) => {
      return old ? old.filter(c => c.id !== id) : []
    })

    queryClient.setQueriesData<Conversation[]>({ queryKey: ['conversations', 'recent'] }, old => {
      return old ? old.filter(c => c.id !== id) : []
    })

    setShowDeleteConfirm(false)
    setConversationToDelete(null)
  }

  const handleCancelDelete = () => {
    setShowDeleteConfirm(false)
    setConversationToDelete(null)
  }

  const handleNewConversation = async () => {
    // If a project is selected, skip modal and use project's storage mode
    if (selectedProject) {
      const projectStorageMode = isCommunityMode ? 'local' : (selectedProject.storage_mode || 'cloud')
      const defaultTitle = `${selectedProject.name} Conversation`
      await createNewConversation(projectStorageMode, defaultTitle)
      return
    }

    // No project selected: in Electron mode, show modal to choose storage
    if (isElectronMode) {
      setNewConvTitle('New Conversation')
      setStorageMode(isCommunityMode ? 'local' : 'cloud')
      setShowNewConversationModal(true)
    } else {
      // Web mode: create cloud conversation directly
      await createNewConversation(isCommunityMode ? 'local' : 'cloud')
    }
  }

  const createNewConversation = async (mode: StorageMode, title?: string) => {
    const payload = {
      title: title || (selectedProject ? `${selectedProject.name} Conversation` : undefined),
      storageMode: isCommunityMode ? 'local' : mode,
    }
    const result = await dispatch(createConversation(payload)).unwrap()

    // Prepend new conversation to first page of infinite query
    queryClient.setQueryData(
      ['conversations', 'infinite'],
      (old: InfiniteData<PaginatedConversationsResponse> | undefined) => {
        if (!old || old.pages.length === 0) {
          return {
            pages: [{ conversations: [result], nextCursor: null, hasMore: false }],
            pageParams: [undefined],
          }
        }
        return {
          ...old,
          pages: [{ ...old.pages[0], conversations: [result, ...old.pages[0].conversations] }, ...old.pages.slice(1)],
        }
      }
    )

    // Update project-specific infinite cache
    if (result.project_id) {
      queryClient.setQueryData(
        ['conversations', 'project', result.project_id, 'infinite'],
        (old: InfiniteData<PaginatedConversationsResponse> | undefined) => {
          if (!old || old.pages.length === 0) {
            return {
              pages: [{ conversations: [result], nextCursor: null, hasMore: false }],
              pageParams: [undefined],
            }
          }
          return {
            ...old,
            pages: [{ ...old.pages[0], conversations: [result, ...old.pages[0].conversations] }, ...old.pages.slice(1)],
          }
        }
      )
    }

    // Keep flat caches updated for backward compatibility (SideBar, other components)
    queryClient.setQueryData(['conversations'], (old: Conversation[] | undefined) => {
      return old ? [result, ...old] : [result]
    })

    queryClient.setQueriesData<Conversation[]>({ queryKey: ['conversations', 'recent'] }, old => {
      return old ? [result, ...old] : [result]
    })

    handleSelect(result)
  }

  const handleConfirmNewConversation = async () => {
    await createNewConversation(storageMode, newConvTitle)
    setShowNewConversationModal(false)
    setNewConvTitle('')
  }

  const handleEditProject = () => {
    setShowEditProjectModal(true)
  }

  const handleCloseEditProjectModal = () => {
    setShowEditProjectModal(false)
  }

  const handleRefreshConversations = async () => {
    // Manually refetch conversations from the server
    await refetchConversations()

    // Also invalidate and refetch related caches for a complete refresh
    queryClient.invalidateQueries({ queryKey: ['conversations', 'recent'] })
    queryClient.invalidateQueries({ queryKey: ['projects'] })
    queryClient.invalidateQueries({ queryKey: ['research-notes'] })
  }

  return (
    <div className='flex overflow-hidden h-full'>
      {/* Dark Overlay */}
      {/* bg-neutral-200/15 dark:bg-black/30 */}
      <div className='absolute inset-0 w-full h-full  z-0' />
      {/* Main content with flex layout - Responsive margins for different displays */}
      <div className='relative z-10 flex-1 h-full flex flex-col overflow-hidden w-full mx-1 sm:mr-4 sm:ml-4 md:mr-8 md:ml-8 lg:mr-15 lg:ml-15 xl:mr-20 xl:ml-15 2xl:mr-25 2xl:ml-15 3xl:mr-35 3xl:ml-20 transition-all px-2 duration-300'>
        <div className='py-4 w-full max-w-full mx-auto shrink-0'>
          <div className='flex items-center justify-between mb-2'>
            <div className='flex items-center gap-2 pt-2 mb-2'>
              <Button
                variant='acrylic'
                rounded='full'
                size='circle'
                onClick={() => navigate('/homepage')}
                className='px-3 py-3 group border-2 hover:bg-pureWhite-100 dark:hover:bg-neutral-900 dark:border-neutral-800 shadow-[0_0px_8px_-4px_rgba(0,0,0,0.5)] dark:shadow-[0_1px_22px_1px_rgba(0,0,0,0.45)]'
              >
                <i
                  className='bx bx-home text-[24px] sm:text-[14px] md:text-[25px] lg:text-[30px] 2xl:text-[38px] 3xl:text-[28px] 4xl:text-[32px] pb-0.75 transition-transform group-hover:scale-101 duration-100 group-active:scale-93 pointer-events-none'
                  aria-hidden='true'
                ></i>
              </Button>
              <h1 className='text-[26px] pl-1 sm:text-[28px] lg:text-[28px] xl:text-[34px] 2xl:text-[34px] 3xl:text-[44px] 4xl:text-[44px] xl:p-2 lg:p-1 md:p-2 sm:p-2 font-bold dark:text-neutral-100 video-light:text-neutral-100 video-dark:text-neutral-900'>
                {selectedProject ? `${selectedProject.name}` : 'Chats'}
              </h1>
              {/* {selectedProject && (
                <Button variant='secondary' size='small' onClick={handleEditProject}>
                  <i className='bx bx-edit text-lg' aria-hidden='true'></i>
                </Button>
              )} */}
            </div>
            {/* Download App Button - only visible in Electron when VITE_ENVIRONMENT is 'web' */}

            {/* {selectedProject?.context && (
              <p className='text-sm text-gray-600 ygg-line-clamp-6 dark:text-gray-300 ml-12'>
                {selectedProject.context}
              </p>
            )} */}
          </div>
        </div>
        <div className='px-1 sm:px-4 md:px-6 w-full max-w-full md:max-w-4xl lg:max-w-5xl xl:max-w-6xl 2xl:max-w-6xl 3xl:max-w-7xl 4xl:max-w-[2400px] mx-auto flex-1 overflow-hidden flex flex-col'>
          <div className='mb-4 flex items-center justify-between max-w-full '>
            <h2 className='text-[20px] md:text-[22px] lg:text-[22px] xl:text-[22px] 2xl:text-[38px] 3xl:text-[38px] 4xl:text-[38px] xl:py-2 lg:py-1 md:py-2 sm:py-2 font-bold dark:text-neutral-100 video-light:text-neutral-100 video-dark:text-neutral-900'>
              Chats
            </h2>
            <div className='flex items-center gap-2 my-1 p-0 lg:p-1 '>
              {import.meta.env.VITE_ENVIRONMENT === 'web' && (
                <Button
                  variant='acrylic'
                  size='medium'
                  onClick={() => setShowDownloadModal(true)}
                  rounded='full'
                  title='Download App'
                  aria-label='Download App'
                  className='mr-2'
                >
                  <i
                    className='bx bx-download text-lg sm:text-lg 2xl:text-2xl mx-0.5 my-1.5 transition-all hover:scale-96 duration-200'
                    aria-hidden='true'
                  ></i>
                </Button>
              )}
              <Button
                variant='acrylic'
                size='large'
                rounded='full'
                onClick={handleEditProject}
                className='group dark:hover:bg-neutral-800 transition-all hover:scale-98 duration-200 shadow-[0px_0px_3px_1px_rgba(0,0,0,0.05)] dark:shadow-[0px_0px_16px_1px_rgba(0,0,0,0.45)]'
              >
                <p className='transition-transform duration-100 text-black dark:text-neutral-100 group-active:scale-95'>
                  Project Settings
                </p>
              </Button>
            </div>
          </div>
          {/* New Conversation + Sort Controls + Search inline row */}
          <div className='mb-0 z-500 flex p-2 px-2 flex-wrap justify-between acrylic-ultra-light items-center gap-3 outline-2 dark:outline-neutral-300/20 outline-neutral-50/10 rounded-4xl shadow-[0px_0px_7px_-2.5px_rgba(0,0,0,0.45)] dark:shadow-[0px_0px_16px_-2px_rgba(0,0,0,0.45)] 2xl:p-3'>
            <div className='flex items-center gap-1'>
              <Button
                variant='acrylic'
                size='large'
                rounded='full'
                onClick={handleNewConversation}
                className='group dark:outline-2 rounded-4xl dark:hover:bg-neutral-800 transition-all hover:scale-98 duration-200 shadow-[0px_0px_3px_1px_rgba(0,0,0,0.05)] dark:shadow-[0px_0px_16px_2px_rgba(0,0,0,0.45)] dark:outline-neutral-300/20'
              >
                <p className='transition-transform duration-100 text-black dark:text-neutral-100 group-active:scale-95'>
                  New Chat
                </p>
              </Button>
            </div>

            <div className='flex items-center gap-1'>
              <div className='w-40 md:w-48 lg:w-56'>
                <TextField
                  placeholder='Search chats...'
                  value={searchQuery}
                  onChange={setSearchQuery}
                  size='small'
                  showSearchIcon
                  onSearchClick={() => {
                    if (searchQuery.trim()) {
                      search(searchQuery)
                    }
                  }}
                />
              </div>
              <Select
                value={sortBy}
                onChange={value => setSortBy(value as 'updated' | 'created' | 'name')}
                options={[
                  { value: 'updated', label: 'Updated' },
                  { value: 'created', label: 'Created' },
                  { value: 'name', label: 'Name' },
                ]}
                className='w-28 ml-1 transition-transform duration-70 active:scale-95'
              />
              <Button
                variant='acrylic'
                size='circle'
                rounded='full'
                onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
                className='shrink-0 ml-1 group'
              >
                <i
                  className={` px-3 py-3 bx ${sortOrder === 'asc' ? 'bx-sort-up' : 'bx-sort-down'} text-xl transition-transform duration-100 group-active:scale-90 pointer-events-none`}
                  aria-hidden='true'
                ></i>
              </Button>

              <Button
                variant='acrylic'
                size='circle'
                rounded='full'
                onClick={handleRefreshConversations}
                disabled={isRefetching}
                className='px-3 py-3 group ml-1 dark:outline-2 rounded-full transition-all hover:scale-98 duration-200 shadow-[0px_0px_3px_1px_rgba(0,0,0,0.05)] dark:shadow-[0px_0px_16px_2px_rgba(0,0,0,0.45)] dark:outline-neutral-300/20'
                title='Refresh conversations from server'
              >
                <i
                  className={`bx bx-refresh text-xl transition-transform duration-100 group-active:scale-90 pointer-events-none ${
                    isRefetching ? 'animate-spin' : ''
                  }`}
                  aria-hidden='true'
                ></i>
              </Button>
            </div>
          </div>

          {loading && <p>Loading...</p>}
          {error && <p className='text-red-500'>{error}</p>}
          <div className='gap-2 sm:gap-1 md:gap-2 px-3 items-start w-full max-w-full lg:max-w-full flex-1 overflow-hidden flex flex-col'>
            <div ref={scrollContainerRef} className='scroll-fade-container w-full overflow-y-auto thin-scrollbar '>
              <ul className='project-list no-scrollbar space-y-4 px-1 sm:px-2 py-8 pb-50 sm:pb-50 md:pb-50 lg:pb-50 xl:pb-50 2xl:pb-52 sm:py-6 2xl:py-12 3xl:py-14 rounded flex-1 pr-2 w-full'>
                {/* Show search indicator when searching */}
                {isShowingSearchResults && (
                  <li className='flex items-center gap-2 bg-transparent text-neutral-800 dark:text-neutral-300 rounded-full acrylic-subtle p-2 text-[16px] mb-4'>
                    {isSearching ? (
                      <>
                        <i className='bx bx-loader-alt animate-spin' aria-hidden='true'></i>
                        <span>Searching...</span>
                      </>
                    ) : (
                      <>
                        <i className='bx bx-search' aria-hidden='true'></i>
                        <span>
                          {searchResults.length} result{searchResults.length !== 1 ? 's' : ''} for "{searchQuery}"
                        </span>
                        <button
                          onClick={() => {
                            setSearchQuery('')
                            clearSearch()
                          }}
                          className='ml-2 text-xs underline hover:text-neutral-700 dark:hover:text-neutral-200'
                        >
                          Clear
                        </button>
                      </>
                    )}
                  </li>
                )}
                {displayedConversations.map((conv, index) => {
                  const isFavorite = favoriteConversationIds.has(conv.id)

                  return (
                    <li
                      key={conv.id}
                      className='rounded-4xl px-3 py-3 sm:p-2 md:px-4 acrylic-light md:py-2 lg:px-3.5 lg:pt-2 lg:pb-2.5 xl:px-4 xl:py-3 2xl:px-4 2xl:py-4 3xl:p-4 4xl:p-4 mb-4 sm:mb-3 md:mb-3 lg:mb-3 xl:mb-4 2xl:mb-4 3xl:mb-6 bg-neutral-50 cursor-pointer border-indigo-100 dark:border-red-600 dark:bg-yBlack-900 hover:bg-neutral-100 dark:outline-1 dark:outline-neutral-700/50 dark:hover:bg-yBlack-800 dark:hover:outline-neutral-700 group shadow-[0px_0px_8px_-2px_rgba(0,0,0,0.15)] dark:shadow-[0px_0px_8px_1px_rgba(0,0,0,0.65)]'
                      onClick={() => handleSelect(conv)}
                    >
                      <div className='flex items-center justify-between'>
                        <div className='flex items-center gap-2 flex-1 min-w-0'>
                          <span className='font-semibold dark:text-neutral-300 transition-transform duration-100 group-active:scale-99 text-[14px] sm:text-[13px] md:text-[13px] lg:text-[14px] xl:text-[16px] 2xl:text-[18px] 3xl:text-[20px] 4xl:text-[22px] truncate'>
                            {String(index + 1).padStart(2, '0')}. {conv.title || `Conversation ${conv.id}`}
                          </span>
                          {conv.storage_mode === 'local' && (
                            <span className='inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300 shrink-0'>
                              Local
                            </span>
                          )}
                          {isElectronMode && conv.storage_mode === 'cloud' && (
                            <span className='inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 shrink-0'>
                              Cloud
                            </span>
                          )}
                        </div>
                        <div className='flex items-center gap-1 relative'>
                          {isElectronMode && (
                            <Button
                              variant='outline2'
                              size='circle'
                              rounded='full'
                              className='px-3 py-3 acrylic-ultra-light dark:shadow-[0px_0px_4px_1px_rgba(0,0,0,0.15)] hover:scale-105 transition-transform duration-300 active:scale-95 shrink-0'
                              onClick={e => handleToggleFavorite(e, conv)}
                              title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                            >
                              <i
                                className={`bx ${isFavorite ? 'bxs-star' : 'bx-star'} text-lg ${
                                  isFavorite ? 'text-yellow-500' : ''
                                }`}
                                aria-hidden='true'
                              ></i>
                            </Button>
                          )}
                          {/* Edit Button */}
                          <Button
                            variant='outline2'
                            size='circle'
                            rounded='full'
                            className='px-3 py-3 acrylic-ultra-light dark:shadow-[0px_0px_4px_1px_rgba(0,0,0,0.15)] hover:scale-105 transition-transform duration-300 active:scale-95 shrink-0'
                            onClick={e => handleEditClick(e, conv)}
                          >
                            <i className='bx bx-dots-horizontal-rounded text-lg' aria-hidden='true'></i>
                          </Button>

                          {/* Delete Button */}
                          <Button
                            variant='outline2'
                            size='circle'
                            rounded='full'
                            className='px-3 py-3 acrylic-ultra-light dark:shadow-[0px_0px_4px_1px_rgba(0,0,0,0.15)] hover:scale-105 transition-transform duration-300 active:scale-95 shrink-0'
                            onClick={
                              (e => {
                                ;(e as unknown as React.MouseEvent).stopPropagation()
                                handleDelete(conv)
                              }) as unknown as () => void
                            }
                          >
                            <i className='bx bx-trash-alt text-lg' aria-hidden='true'></i>
                          </Button>
                        </div>
                      </div>
                      {conv.created_at && (
                        <div className='text-xs mt-2 text-neutral-900 dark:text-neutral-300 transition-transform duration-100 group-active:scale-99 text-[12px] sm:text-[11px] md:text-[11px] lg:text-[10px] xl:text-[12px] 2xl:text-[14px] 3xl:text-[16px] 4xl:text-[16px]'>
                          {new Date(conv.created_at).toLocaleString()}
                        </div>
                      )}
                    </li>
                  )
                })}
                {/* {displayedConversations.length === 0 && !loading && !isSearching && (
                  <p className='dark:text-neutral-300 rounded-3xl p-4 acrylic-light'>
                    {isShowingSearchResults ? `No conversations found for "${searchQuery}"` : 'No conversations yet.'}
                  </p>
                )} */}

                {/* Loading more indicator - hide when searching */}
                {isFetchingNextPage && !isShowingSearchResults && (
                  <li className='flex justify-center py-4'>
                    <div className='flex items-center gap-2 text-neutral-500 dark:text-neutral-400'>
                      <i className='bx bx-loader-alt animate-spin text-xl' aria-hidden='true'></i>
                      <span>Loading more...</span>
                    </div>
                  </li>
                )}

                {/* Sentinel element for infinite scroll - triggers loading when visible, hide when searching */}
                {hasNextPage && !isFetchingNextPage && !isShowingSearchResults && (
                  <li ref={loadMoreRef} className='h-4' aria-hidden='true' />
                )}

                {/* End of list indicator - hide when searching */}
                {!hasNextPage && conversations.length > 0 && !loading && !isShowingSearchResults && (
                  <li className='w-fit mx-auto text-center mt-2 py-1 text-neutral-800 dark:text-neutral-300 text-[15px] rounded-full px-2 acrylic-light'>
                    All chats loaded
                  </li>
                )}
              </ul>
            </div>
          </div>
        </div>
      </div>

      <EditProject
        isOpen={showEditProjectModal}
        onClose={handleCloseEditProjectModal}
        editingProject={selectedProject}
      />

      {/* New Conversation Modal */}
      {showNewConversationModal && (
        <div className='fixed inset-0 bg-neutral-400/40 dark:bg-black/30 bg-opacity-50 backdrop-blur-sm flex items-center justify-center z-50 p-4'>
          <div className='bg-neutral-100 text-neutral-900 mica-medium dark:bg-yBlack-900 rounded-3xl border border-gray-200 dark:border-zinc-700 w-full max-w-md p-6 shadow-[0_8px_32px_rgba(0,0,0,0.1)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.3)]'>
            <h3 className='text-xl font-semibold mb-4 dark:text-neutral-100'>Create New Conversation</h3>

            <div className='mb-4'>
              <label className='block text-sm font-medium mb-2 dark:text-neutral-300'>Title (optional)</label>
              <input
                type='text'
                value={newConvTitle}
                onChange={e => setNewConvTitle(e.target.value)}
                placeholder='Enter conversation title...'
                className='w-full px-3 py-2 rounded-xl border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500'
              />
            </div>

            <div className='mb-6'>
              <label className='block text-sm font-medium mb-2 dark:text-neutral-300'>Storage Location</label>
              <div className='space-y-2'>
                {!isCommunityMode && (
                  <label className='flex items-center p-3 rounded-xl border border-gray-300 dark:border-neutral-700 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800'>
                    <input
                      type='radio'
                      value='cloud'
                      checked={storageMode === 'cloud'}
                      onChange={e => setStorageMode(e.target.value as StorageMode)}
                      className='mr-3'
                    />
                    <div>
                      <div className='font-medium dark:text-neutral-100'>Cloud</div>
                      <div className='text-xs text-neutral-600 dark:text-neutral-400'>
                        Synced to cloud (accessible anywhere)
                      </div>
                    </div>
                  </label>
                )}
                <label className='flex items-center p-3 rounded-xl border border-gray-300 dark:border-neutral-700 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800'>
                  <input
                    type='radio'
                    value='local'
                    checked={storageMode === 'local'}
                    onChange={e => setStorageMode(e.target.value as StorageMode)}
                    className='mr-3'
                  />
                  <div>
                    <div className='font-medium dark:text-neutral-100'>Local Only</div>
                    <div className='text-xs text-neutral-600 dark:text-neutral-400'>
                      Stored on this device only (not synced)
                    </div>
                  </div>
                </label>
              </div>
            </div>

            <div className='flex gap-3 justify-end'>
              <Button
                variant='acrylic'
                size='circle'
                rounded='full'
                className='group'
                onClick={() => setShowNewConversationModal(false)}
              >
                <p className='transition-transform duration-100 group-active:scale-95'>Cancel</p>
              </Button>
              <Button
                variant='acrylic'
                size='circle'
                rounded='full'
                className='group bg-blue-500 hover:bg-blue-600 dark:bg-blue-600 dark:hover:bg-blue-700 text-white border-blue-600 dark:border-blue-700'
                onClick={handleConfirmNewConversation}
              >
                <p className='transition-transform duration-100 group-active:scale-95'>Create</p>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      {showDeleteConfirm && conversationToDelete && (
        <div className='fixed inset-0 bg-neutral-400/40 dark:bg-black/30 bg-opacity-50 backdrop-blur-sm flex items-center justify-center z-50 p-4'>
          <div className='bg-neutral-100 text-neutral-900 mica-medium dark:bg-yBlack-900 rounded-3xl border border-gray-200 dark:border-zinc-700 w-full max-w-md p-6 shadow-[0_8px_32px_rgba(0,0,0,0.1)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.3)]'>
            <h3 className='text-xl font-semibold mb-2 dark:text-neutral-100'>Delete Chat?</h3>
            <p className='text-sm text-neutral-600 dark:text-neutral-400 mb-4'>
              Are you sure you want to delete "
              <span className='font-medium'>
                {conversationToDelete.title || `Conversation ${conversationToDelete.id}`}
              </span>
              "? This action cannot be undone.
            </p>
            <div className='flex gap-3 justify-end'>
              <Button variant='acrylic' size='circle' rounded='full' className='group' onClick={handleCancelDelete}>
                <p className='transition-transform duration-100 group-active:scale-95'>Cancel</p>
              </Button>
              <Button
                variant='acrylic'
                size='circle'
                rounded='full'
                className='group bg-red-500 hover:bg-red-600 dark:bg-red-600 dark:hover:bg-red-700 text-black dark:text-white border-red-600 dark:border-red-700'
                onClick={confirmDelete}
              >
                <p className='transition-transform duration-100 group-active:scale-95'>Delete</p>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Move Project Modal */}
      {showMoveModal && conversationToMove && (
        <div
          className='fixed inset-0 bg-neutral-400/40 dark:bg-black/30 bg-opacity-50 backdrop-blur-sm flex items-center justify-center z-50 p-4'
          onClick={() => setShowMoveModal(false)}
        >
          <div
            className='bg-neutral-100 text-neutral-900 mica-medium dark:bg-yBlack-900 rounded-3xl border border-gray-200 dark:border-zinc-700 w-full max-w-md p-6 shadow-[0_8px_32px_rgba(0,0,0,0.1)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.3)]'
            onClick={e => e.stopPropagation()}
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
              {allProjects
                .filter(p => {
                  const convMode = conversationToMove.storage_mode || 'cloud'
                  const projMode = p.storage_mode || 'cloud'
                  return p.id !== conversationToMove.project_id && projMode === convMode
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
              {allProjects.filter(p => {
                const convMode = conversationToMove.storage_mode || 'cloud'
                const projMode = p.storage_mode || 'cloud'
                return p.id !== conversationToMove.project_id && projMode === convMode
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
          className='fixed inset-0 bg-neutral-400/40 dark:bg-black/30 bg-opacity-50 backdrop-blur-sm flex items-center justify-center z-50 p-4'
          onClick={cancelMoveProject}
        >
          <div
            className='bg-neutral-100 text-neutral-900 mica-medium rounded-3xl border border-gray-200 dark:border-zinc-700 w-full max-w-md p-6 shadow-[0_8px_32px_rgba(0,0,0,0.1)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.3)]'
            onClick={e => e.stopPropagation()}
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
                  {getProjectName(conversationToMove.project_id)}
                </div>
              </div>
              <i className='bx bx-right-arrow-alt text-2xl text-neutral-400' aria-hidden='true'></i>
              <div className='text-center'>
                <div className='text-[16px] text-neutral-500 dark:text-neutral-400 mb-1'>To</div>
                <div className='font-medium dark:text-neutral-100 text-[16px]'>{destinationProject.name}</div>
              </div>
            </div>
            <div className='flex gap-3 pt-2 justify-end'>
              <Button variant='outline2' size='circle' rounded='full' className='group' onClick={cancelMoveProject}>
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

      {/* Research Notes List - Fixed bottom-right */}
      <LowBar conversationId={null} mode='list' notes={researchNotes} isLoadingNotes={notesLoading} />

      {/* Download App Modal */}
      <DownloadAppModal isOpen={showDownloadModal} onClose={() => setShowDownloadModal(false)} />
    </div>
  )
}

export default ConversationPage
