import { useQueryClient } from '@tanstack/react-query'
import 'boxicons'
import 'boxicons/css/boxicons.min.css'
import React, { useEffect, useState } from 'react'
import { useChatNavigate as useNavigate } from '../components/ChatSelection/ChatSelectionProvider'
import { ProjectWithLatestConversation } from '../../../../shared/types'
import { Button } from '../components'
import { useHtmlIframeRegistry } from '../components/HtmlIframeRegistry/HtmlIframeRegistry'
import { LowBar } from '../components/LowBar/LowBar'
import { Select } from '../components/Select/Select'
import { chatSliceActions } from '../features/chats'
import { deleteProject, projectsLoaded, setSelectedProject } from '../features/projects'
import { selectCurrentUser } from '../features/users'
import { useAppDispatch, useAppSelector } from '../hooks/redux'
import { useAuth } from '../hooks/useAuth'
import { useIsMobile } from '../hooks/useMediaQuery'
import { useProjects, useResearchNotes } from '../hooks/useQueries'
import { getAssetPath } from '../utils/assetPath'
import { sortProjects } from '../utils/sortProjects'
import { DownloadAppModal } from './downloadApp'
import EditProject from './EditProject'

const Homepage: React.FC = () => {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { userId } = useAuth()
  const isMobile = useIsMobile()
  const currentUser = useAppSelector(selectCurrentUser)
  const quickChatProjectId = currentUser?.quick_chat_project_id || null
  const htmlRegistry = useHtmlIframeRegistry()
  const isToolsFullscreen = htmlRegistry?.isHomepageFullscreen ?? false

  // Check if running in Electron
  const isElectronMode =
    import.meta.env.VITE_ENVIRONMENT === 'electron' ||
    (typeof process !== 'undefined' && process.env?.VITE_ENVIRONMENT === 'electron')

  // Use React Query for data fetching (with automatic caching and deduplication)
  // Projects now include latest_conversation_updated_at, eliminating need to fetch all conversations
  const { data: allProjects = [], isLoading: loading, isRefetching, refetch: refetchProjects } = useProjects()

  // Fetch research notes for display in LowBar
  const { data: researchNotes = [], isLoading: notesLoading } = useResearchNotes()

  // Sync React Query data to Redux
  useEffect(() => {
    if (allProjects.length > 0) {
      dispatch(projectsLoaded(allProjects))
    }
  }, [allProjects, dispatch])

  //   const error = useAppSelector(selectProjectsError)

  const [showEditModal, setShowEditModal] = useState(false)
  const [editingProject, setEditingProject] = useState<ProjectWithLatestConversation | null>(null)
  // Search dropdown is handled inside SearchList component
  const [sortBy, setSortBy] = useState<'updated' | 'created' | 'name'>('updated')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [storageFilter, setStorageFilter] = useState<'all' | 'cloud' | 'local'>('all')

  // Delete confirmation dialog state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [projectToDelete, setProjectToDelete] = useState<ProjectWithLatestConversation | null>(null)

  // Mobile options menu state
  const [showMobileOptionsMenu, setShowMobileOptionsMenu] = useState(false)
  // Download app modal state
  const [showDownloadModal, setShowDownloadModal] = useState(false)
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null)

  // Theme state
  const [themeMode, setThemeMode] = useState<'Light' | 'Dark' | 'System'>(() => {
    if (typeof window === 'undefined') return 'Light'
    const saved = localStorage.getItem('theme')
    return saved === 'dark' ? 'Dark' : saved === 'light' ? 'Light' : saved === 'system' ? 'System' : 'System'
  })

  // Filter projects by storage mode
  const filteredProjects =
    storageFilter === 'all' ? allProjects : allProjects.filter(p => p.storage_mode === storageFilter)
  const projects = sortProjects(filteredProjects, sortBy, sortOrder === 'asc')

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

  const cycleTheme = () => {
    setThemeMode(prev => (prev === 'Light' ? 'Dark' : prev === 'Dark' ? 'System' : 'Light'))
  }
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [])

  // Close mobile options menu on outside click or Escape key
  useEffect(() => {
    if (!showMobileOptionsMenu) return
    const onDown = () => {
      setShowMobileOptionsMenu(false)
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setShowMobileOptionsMenu(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [showMobileOptionsMenu])

  useEffect(() => {
    dispatch(chatSliceActions.stateReset())
    dispatch(chatSliceActions.heimdallDataLoaded({ treeData: null }))

    // Projects and conversations are now fetched via React Query hooks above
    // No need to dispatch Redux actions for fetching - React Query handles caching and deduplication
  }, [dispatch])

  // Dropdown open/close is managed internally by SearchList

  const handleSelectProject = (project: ProjectWithLatestConversation) => {
    dispatch(setSelectedProject(project))
    navigate(`/conversationPage?projectId=${project.id}`)
  }

  const handleDeleteProject = (project: ProjectWithLatestConversation) => {
    setProjectToDelete(project)
    setShowDeleteConfirm(true)
  }

  const confirmDeleteProject = async () => {
    if (!projectToDelete) return

    const id = projectToDelete.id
    // Delete via Redux thunk (handles API call)
    await dispatch(deleteProject({ id }))

    // Update React Query cache to remove the deleted project
    queryClient.setQueryData(['projects', userId], (old: ProjectWithLatestConversation[] | undefined) => {
      return old ? old.filter(project => project.id !== id) : []
    })

    setShowDeleteConfirm(false)
    setProjectToDelete(null)
  }

  const handleCancelDelete = () => {
    setShowDeleteConfirm(false)
    setProjectToDelete(null)
  }

  const handleCloseModal = () => {
    setShowEditModal(false)
    setEditingProject(null)
  }

  const handleEditProject = (project: ProjectWithLatestConversation) => {
    setEditingProject(project)
    setShowEditModal(true)
  }

  const { signOut } = useAuth()
  const handleLogout = async () => {
    await signOut()
    // The ProtectedRoute component will automatically redirect to /login
  }

  const handleRefreshProjects = async () => {
    // Manually refetch projects from the server
    await refetchProjects()

    // Also invalidate and refetch related caches for a complete refresh
    queryClient.invalidateQueries({ queryKey: ['conversations'] })
    queryClient.invalidateQueries({ queryKey: ['conversations', 'recent'] })
    queryClient.invalidateQueries({ queryKey: ['research-notes'] })
  }

  return (
    <div className=' h-full flex backdrop-blur-lg'>
      {/* Dark Overlay */}
      {/* bg-neutral-200/15 dark:bg-black/30 */}
      <div className='absolute inset-0 w-full h-full  z-0' />
      {/* Main content with flex layout - Responsive margins for different displays */}
      <div className='relative z-10 flex-1 h-full flex flex-col w-full mr-2 ml-2 overflow-hidden sm:mr-4 sm:ml-4 md:mr-8 md:ml-8 lg:mr-15 lg:ml-15 xl:mr-20 xl:ml-15 2xl:mr-25 2xl:ml-15 3xl:mr-35 3xl:ml-20 transition-all duration-300'>
        <div className='py-1 lg:py-1 xl:py-1 2xl:py-0 3xl:py-4 4xl:py-6 w-full mx-auto shrink-0'>
          <div className='flex items-center justify-baseline'>
            <div className='flex items-center flex-wrap gap-3 rounded-full pl-2 pr-3 py-2 2xl:pt-2'>
              <div className='sm:pt-4 lg:pt-6'>
                <img
                  src={getAssetPath('img/logo-d.svg')}
                  alt='Yggdrasil Logo'
                  className='w-14 h-14 sm:w-14 sm:h-14 md:w-16 md:h-16 lg:w-18 lg:h-18 xl:w-20 xl:h-20 2xl:w-22 2xl:h-22 dark:hidden video-light:hidden rounded-full shadow-[0_2px_16px_3px_rgba(0,0,0,0.05)] acrylic-ultra-light-nb'
                />
                <img
                  src={getAssetPath('img/logo-l-thick.svg')}
                  alt='Yggdrasil Logo'
                  className='w-14 h-14 sm:w-14 sm:h-14 md:w-16 md:h-16 lg:w-18 lg:h-18 xl:w-20 xl:h-20 2xl:w-22 2xl:h-22 dark:block video-light:block rounded-full dark:shadow-[0_2px_16px_3px_rgba(0,0,0,0.25)]'
                />
              </div>
              <h1 className='junicode-bold tracking-wide pt-0 2xl:pb-2 text-[28px] sm:text-[40px] lg:text-[44px] xl:text-[48px] 2xl:text-[70px] 3xl:text-[70px] 4xl:text-[44px] px-1 dark:text-neutral-100 video-light:text-neutral-100 video-dark:text-neutral-900'>
                Yggdrasil
              </h1>
            </div>
          </div>
        </div>
        <div className='px-2 sm:px-4 md:px-6 w-full max-w-full md:max-w-4xl lg:max-w-5xl xl:max-w-6xl 2xl:max-w-6xl 3xl:max-w-7xl 4xl:max-w-[2400px] mx-auto flex-1 flex flex-col min-h-0'>
          <div className='mb-4 flex items-center justify-between'>
            <h2 className='text-[22px] sm:text-[22px] lg:text-[22px] xl:text-[22px] 2xl:text-[38px] 3xl:text-[38px] 4xl:text-[38px] py-2 font-bold video-light:text-neutral-100 video-dark:text-neutral-900'>
              Projects
            </h2>
            <div className='flex items-center gap-3 my-1 mr-1 rounded-4xl '>
              {/* Download App Button - only visible in Electron when VITE_ENVIRONMENT is 'web' */}

              <Button
                variant='acrylic'
                size='circle'
                onClick={handleLogout}
                rounded='full'
                title='Logout'
                aria-label='Logout'
                className=''
              >
                <i
                  className='bx transform -translate-x-0.5  bx-log-out text-lg sm:text-lg 2xl:text-2xl mx-0.5 my-1.5 transition-all hover:scale-96 duration-200'
                  aria-hidden='true'
                ></i>
              </Button>
              {import.meta.env.VITE_ENVIRONMENT === 'web' && (
                <div className='relative flex items-center justify-center'>
                  <div className='absolute -top-10 left-1/2 -translate-x-1/2 whitespace-nowrap bg-blue-500 dark:bg-blue-700 text-white text-[10px] font-bold px-3 py-1.5 rounded-full shadow-lg pointer-events-none z-50'>
                    Download our desktop app!
                    <div className='absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-blue-500 dark:border-t-blue-700'></div>
                  </div>
                  <Button
                    variant='acrylic'
                    size='medium'
                    onClick={() => setShowDownloadModal(true)}
                    rounded='full'
                    title='Download App'
                    aria-label='Download App'
                    className=''
                  >
                    <i
                      className='bx bx-download text-lg sm:text-lg 2xl:text-2xl mx-0.5 my-1.5 transition-all hover:scale-96 duration-200'
                      aria-hidden='true'
                    ></i>
                  </Button>
                </div>
              )}
              {isMobile && (
                <Button
                  variant='acrylic'
                  size='medium'
                  onClick={() => {
                    const button = document.activeElement as HTMLElement
                    if (button) {
                      const rect = button.getBoundingClientRect()
                      setMenuPosition({ x: rect.left, y: rect.bottom + 4 })
                    }
                    setShowMobileOptionsMenu(true)
                  }}
                  rounded='full'
                  title='More options'
                  aria-label='More options'
                  className='group'
                >
                  <i
                    className='bx bx-dots-vertical-rounded text-lg sm:text-lg 2xl:text-2xl mx-0.5 my-1.5 transition-transform duration-100 group-active:scale-90 pointer-events-none'
                    aria-hidden='true'
                  ></i>
                </Button>
              )}
            </div>
          </div>

          {/* Sort Controls */}
          <div className='mb-0 z-5000 flex p-2 flex-wrap justify-end items-center gap-3 outline-2 dark:outline-neutral-300/12 outline-neutral-50/10 acrylic-ultra-light rounded-4xl shadow-[0px_2px_7px_2.5px_rgba(0,0,0,0.10)] dark:shadow-[0px_0px_16px_-2px_rgba(0,0,0,0.45)] 2xl:p-3'>
            <div className='flex items-center gap-2'>
              {/* Storage Filter (only show in Electron mode) */}
              {isElectronMode && (
                <div className='flex items-center gap-1 mr-2'>
                  <Button
                    variant='acrylic'
                    size='small'
                    rounded='full'
                    onClick={() => setStorageFilter('all')}
                    className={`transition-all duration-200 ${
                      storageFilter === 'all'
                        ? 'bg-blue-500 text-white dark:bg-blue-600'
                        : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300'
                    }`}
                  >
                    <p className='text-xs px-1'>All</p>
                  </Button>
                  <Button
                    variant='acrylic'
                    size='small'
                    rounded='full'
                    onClick={() => setStorageFilter('cloud')}
                    className={`transition-all duration-200 ${
                      storageFilter === 'cloud'
                        ? 'bg-blue-500 text-white dark:bg-blue-600'
                        : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300'
                    }`}
                  >
                    <p className='text-xs px-1'>Cloud</p>
                  </Button>
                  <Button
                    variant='acrylic'
                    size='small'
                    rounded='full'
                    onClick={() => setStorageFilter('local')}
                    className={`transition-all duration-200 ${
                      storageFilter === 'local'
                        ? 'bg-green-500 text-white dark:bg-green-600'
                        : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300'
                    }`}
                  >
                    <p className='text-xs px-1'>Local</p>
                  </Button>
                </div>
              )}
              <Select
                value={sortBy}
                onChange={value => setSortBy(value as 'updated' | 'created' | 'name')}
                options={[
                  { value: 'updated', label: 'Updated' },
                  { value: 'created', label: 'Created' },
                  { value: 'name', label: 'Name' },
                ]}
                className='w-32 transition-transform duration-70 active:scale-95'
              />
              <Button
                variant='acrylic'
                size='circle'
                rounded='full'
                onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
                className='px-3 py-3 shrink-0 group rounded-4xl transition-all hover:scale-98 duration-200 shadow-[0px_0px_3px_1px_rgba(0,0,0,0.05)] dark:shadow-[0px_0px_16px_2px_rgba(0,0,0,0.45)] '
              >
                <i
                  className={`bx ${sortOrder === 'asc' ? 'bx-sort-up' : 'bx-sort-down'} text-xl transition-transform duration-100 group-active:scale-90 pointer-events-none`}
                  aria-hidden='true'
                ></i>
              </Button>
              <Button
                variant='acrylic'
                size='circle'
                rounded='full'
                onClick={handleRefreshProjects}
                disabled={isRefetching}
                className='px-3 py-3 group rounded-4xl transition-all hover:scale-98 duration-200 shadow-[0px_0px_3px_1px_rgba(0,0,0,0.05)] dark:shadow-[0px_0px_16px_2px_rgba(0,0,0,0.45)]'
                title='Refresh projects from server'
              >
                <i
                  className={`bx bx-refresh text-xl transition-transform duration-100 group-active:scale-90 pointer-events-none ${
                    isRefetching ? 'animate-spin' : ''
                  }`}
                  aria-hidden='true'
                ></i>
              </Button>
              <Button
                variant='acrylic'
                size='circle'
                rounded='full'
                onClick={() => htmlRegistry?.setHomepageFullscreen(true)}
                className={`px-3 py-3 sgroup rounded-4xl transition-all hover:scale-98 duration-200 shadow-[0px_0px_3px_1px_rgba(0,0,0,0.05)] dark:shadow-[0px_0px_16px_2px_rgba(0,0,0,0.45)] ${
                  isToolsFullscreen ? 'bg-blue-500 text-white dark:bg-blue-600' : ''
                }`}
                title='Open Tool Viewer'
              >
                <i
                  className='bx bx-code-block text-xl transition-transform duration-100 group-active:scale-90 pointer-events-none'
                  aria-hidden='true'
                ></i>
              </Button>
            </div>
          </div>

          {loading && <p>Loading...</p>}
          {/* {error && <p className='text-red-500'>{error}</p>} */}

          <div className='gap-2 sm:gap-1 md:gap-2 px-3 items-start w-full max-w-full lg:max-w-full flex-1 overflow-hidden flex flex-col'>
            <div className='scroll-fade-container w-full overflow-y-auto thin-scrollbar '>
              <ul className='project-list no-scrollbar space-y-4 px-1 sm:px-2 py-8 sm:py-6 pb-50 sm:pb-50 md:pb-50 lg:pb-50 xl:pb-50 2xl:pb-52 2xl:py-12  3xl:py-14 rounded flex-1 pr-2 w-full'>
                {projects.map((project, index) => (
                  <li
                    key={project.id}
                    className='rounded-4xl acrylic-light px-3 py-3 sm:px-4 md:px-4 md:py-2 lg:px-3.5 lg:pt-2 lg:pb-2.5 xl:px-4 xl:py-3 2xl:px-4 2xl:py-4 3xl:p-4 4xl:p-4 bg-neutral-50 dark:bg-yBlack-900 cursor-pointer border-indigo-100 dark:border-neutral-600 dark:bg-transparent hover:bg-neutral-100 dark:outline-1 dark:outline-neutral-700/50 dark:hover:bg-transparent dark:hover:outline-neutral-600 group '
                    onClick={() => handleSelectProject(project)}
                  >
                    <div className='flex place-items-start justify-between'>
                      <div className='flex-1'>
                        <span className='font-semibold text-xl dark:text-neutral-100 transition-transform duration-100 group-active:scale-99 flex items-center gap-2'>
                          <p className='transition-transform duration-100 group-active:scale-99 text-[16px] sm:text-[14px] md:text-[16px] lg:text-[16px] xl:text-[16px] 2xl:text-[18px] 3xl:text-[20px] 4xl:text-[22px]'>
                            {String(index + 1).padStart(2, '0')}. {project.name}
                          </p>
                          {project.storage_mode === 'local' && (
                            <span className='text-[12px] sm:text-[12px] md:text-[12px] lg:text-[12px] xl:text-[12px] 2xl:text-[12px] 3xl:text-[12px] 4xl:text-[12px] px-1.5 py-0.5 rounded-full bg-green-100/50 text-green-800 dark:bg-green-900/30 dark:text-green-300 border border-green-600/40 dark:border-green-800 font-medium'>
                              Local
                            </span>
                          )}
                          {project.storage_mode === 'cloud' && (
                            <span className='text-[12px] sm:text-[12px] md:text-[12px] lg:text-[12px] xl:text-[12px] 2xl:text-[12px] 3xl:text-[12px] 4xl:text-[12px] px-1.5 py-0.5 rounded-full bg-blue-100/50 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 border border-blue-200 dark:border-blue-800 font-medium'>
                              Cloud
                            </span>
                          )}
                        </span>
                        {project.context && (
                          <p className='text-sm text-stone-900 ygg-line-clamp-6 dark:text-gray-300 mt-2 mr-2 transition-transform duration-100 group-active:scale-99 text-[12px] sm:text-[14px] md:text-[16px] lg:text-[16px] xl:text-[16px] 2xl:text-[18px] 3xl:text-[20px] 4xl:text-[22px]'>
                            {project.context}
                          </p>
                        )}
                      </div>
                      <div className='flex gap-2'>
                        <Button
                          variant='acrylic'
                          size='circle'
                          rounded='full'
                          className='px-3 py-3 group dark:shadow-[0px_0px_6px_6px_rgba(0,0,0,0.95)] hover:scale-105 transition-transform duration-300 active:scale-95'
                          onClick={
                            (e => {
                              ;(e as unknown as React.MouseEvent).stopPropagation()
                              handleEditProject(project)
                            }) as unknown as () => void
                          }
                        >
                          <i
                            className='bx bx-edit text-lg transition-transform duration-100 group-active:scale-90 pointer-events-none '
                            aria-hidden='true'
                          ></i>
                        </Button>
                        {project.id !== quickChatProjectId && (
                          <Button
                            variant='acrylic'
                            size='circle'
                            rounded='full'
                            className='px-3 py-3 group dark:shadow-[0px_0px_6px_6px_rgba(0,0,0,0.95)] hover:scale-105 transition-transform duration-300 active:scale-95'
                            onClick={
                              (e => {
                                ;(e as unknown as React.MouseEvent).stopPropagation()
                                handleDeleteProject(project)
                              }) as unknown as () => void
                            }
                          >
                            <i
                              className='bx bx-trash-alt text-lg transition-transform duration-100 group-active:scale-90 pointer-events-none'
                              aria-hidden='true'
                            ></i>
                          </Button>
                        )}
                      </div>
                    </div>
                    {project.created_at && (
                      <div className='text-xs text-stone-800 dark:text-neutral-300 mt-2 transition-transform duration-100 group-active:scale-99 text-[12px] sm:text-[12px] md:text-[12px] lg:text-[12px] xl:text-[14px] 2xl:text-[16px] 3xl:text-[16px] 4xl:text-[16px]'>
                        Created: {new Date(project.created_at).toLocaleString()}
                      </div>
                    )}
                  </li>
                ))}
                {projects.length === 0 && !loading && (
                  <p className='dark:text-neutral-300'>No projects yet. Create your first project to get started!</p>
                )}
              </ul>
            </div>
          </div>
        </div>
      </div>

      <EditProject
        isOpen={showEditModal}
        onClose={handleCloseModal}
        editingProject={editingProject}
      />

      {/* Delete Project Confirmation Dialog */}
      {showDeleteConfirm && projectToDelete && (
        <div className='fixed inset-0 bg-neutral-400/40 dark:bg-black/30 backdrop-blur-sm flex items-center justify-center z-50 p-4'>
          <div className='bg-neutral-100 text-neutral-900 mica-medium dark:bg-yBlack-900 rounded-3xl border border-gray-200 dark:border-zinc-700 w-full max-w-md p-6 shadow-[0_8px_32px_rgba(0,0,0,0.1)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.3)]'>
            <h3 className='text-xl font-semibold mb-2 dark:text-neutral-100'>Delete Project?</h3>
            <p className='text-sm text-neutral-600 dark:text-neutral-400 mb-4'>
              Are you sure you want to delete "<span className='font-medium'>{projectToDelete.name}</span>
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
                onClick={confirmDeleteProject}
              >
                <p className='transition-transform duration-100 group-active:scale-95'>Delete</p>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile Options Context Menu */}
      {showMobileOptionsMenu && menuPosition && (
        <div
          className='fixed z-50 min-w-[100px] rounded-xl shadow-lg border border-stone-200 bg-white dark:bg-yBlack-900 dark:border-neutral-700 animate-scale-in'
          style={{
            left: Math.max(8, Math.min(menuPosition.x, window.innerWidth - 110)),
            top: Math.max(8, Math.min(menuPosition.y, window.innerHeight - 160)),
            transformOrigin: 'top right',
          }}
          onMouseDown={e => e.stopPropagation()}
        >
          <ul className='py-1 text-sm text-stone-800 dark:text-stone-200'>
            <li>
              <button
                className='w-full text-left px-4 py-3 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-yBlack-500 rounded-xl hover:scale-103 active:scale-97 transition-all duration-100 flex items-center gap-3'
                onClick={() => {
                  cycleTheme()
                }}
              >
                <i
                  className={`bx ${themeMode === 'System' ? 'bx-desktop' : themeMode === 'Dark' ? 'bx-moon' : 'bx-sun'} text-xl`}
                  aria-hidden='true'
                ></i>
                <span>{themeMode}</span>
              </button>
            </li>
            <li>
              <button
                className='w-full text-left px-4 py-3 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-yBlack-500 rounded-xl hover:scale-103 active:scale-97 transition-all duration-100 flex items-center gap-3'
                onClick={() => {
                  navigate('/payment')
                  setShowMobileOptionsMenu(false)
                }}
              >
                <i className='bx bx-user-circle text-xl' aria-hidden='true'></i>
                <span>Profile</span>
              </button>
            </li>
          </ul>
        </div>
      )}

      {/* Research Notes List - Fixed bottom-right */}
      <LowBar conversationId={null} mode='list' notes={researchNotes} isLoadingNotes={notesLoading} />

      {/* Download App Modal */}
      <DownloadAppModal isOpen={showDownloadModal} onClose={() => setShowDownloadModal(false)} />
    </div>
  )
}

export default Homepage
