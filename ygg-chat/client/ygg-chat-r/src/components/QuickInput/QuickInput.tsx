import { getAssetPath } from '@/utils/assetPath'
import { useQueryClient } from '@tanstack/react-query'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChatNavigate as useNavigate } from '../ChatSelection/ChatSelectionProvider'
import { chatSliceActions, sendMessage } from '../../features/chats'
import { Conversation, createConversation } from '../../features/conversations'
import { convContextSet, systemPromptSet } from '../../features/conversations/conversationSlice'
import { fetchProjectById } from '../../features/projects'
import { selectCurrentUser } from '../../features/users'
import { useAppDispatch, useAppSelector } from '../../hooks/redux'
import { useAuth } from '../../hooks/useAuth'
import { useModels, useProjects, useSelectModel, useSelectedModel, useToggleSecretMode } from '../../hooks/useQueries'
import { useSubscriptionStatus } from '../../hooks/useSubscriptionStatus'
import { Button } from '../Button/button'
import { InputTextArea } from '../InputTextArea/InputTextArea'
import { ModelSelectControl } from '../ModelSelectControl/ModelSelectControl'
export const QuickInput: React.FC = () => {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const currentUser = useAppSelector(selectCurrentUser)
  const quickChatProjectId = currentUser?.quick_chat_project_id || null

  // Subscription status for free/paid detection
  const { userId } = useAuth()
  const { isFreeUser } = useSubscriptionStatus(userId)

  // Check if user has credits (in USD cents) - users with credits get paid features
  const currentCredits = currentUser?.cached_current_credits ?? 0
  const hasCredits = currentCredits > 0
  const showSecretMode = !isFreeUser || hasCredits

  // Local state
  const [quickChatInput, setQuickChatInput] = useState('')
  const [think, setThink] = useState(false)
  // const [spinRefresh, setSpinRefresh] = useState(false)
  const [currentProvider] = useState('OpenRouter') // Default provider
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [secretMode, setSecretMode] = useState(false)
  const projectsScrollRef = useRef<HTMLDivElement>(null)
  const [canScrollProjectsLeft, setCanScrollProjectsLeft] = useState(false)
  const [canScrollProjectsRight, setCanScrollProjectsRight] = useState(false)

  // Secret mode toggle (ZDR models)
  const toggleSecretModeMutation = useToggleSecretMode()

  // Handle secret mode toggle
  const handleSecretModeToggle = useCallback(() => {
    const newSecretMode = !secretMode
    setSecretMode(newSecretMode)
    toggleSecretModeMutation.mutate({ enabled: newSecretMode })
  }, [secretMode, toggleSecretModeMutation])

  const modelSelectFooter = showSecretMode ? (
    <div className='p-1'>
      <Button
        variant={secretMode ? 'primary' : 'outline2'}
        size='small'
        className='w-full'
        onClick={handleSecretModeToggle}
        disabled={toggleSecretModeMutation.isPending}
      >
        <i className={`bx ${secretMode ? 'bxs-lock' : 'bx-lock-open'} mr-1`} aria-hidden='true'></i>
        {toggleSecretModeMutation.isPending ? 'Loading...' : secretMode ? 'Secret Mode On' : 'Secret Mode'}
      </Button>
    </div>
  ) : (
    <div className='p-1 space-y-2'>
      <Button variant='outline2' size='medium' className='w-full' onClick={() => navigate('/payment')}>
        Subscribe now for access to all 400+ models
      </Button>
    </div>
  )

  // Fetch projects for quick selection
  const { data: projects } = useProjects()

  // Memoize filtered and sorted projects: local projects first, then sorted by updated_at
  const filteredAndSortedProjects = useMemo(() => {
    if (!projects || projects.length === 0) return []

    // Separate local and cloud projects
    const localProjects = projects.filter(p => p.storage_mode === 'local')
    const cloudProjects = projects.filter(p => p.storage_mode !== 'local')

    // Sort local projects by updated_at (most recent first)
    localProjects.sort((a, b) => {
      const dateA = new Date(a.updated_at).getTime()
      const dateB = new Date(b.updated_at).getTime()
      return dateB - dateA
    })

    // Sort cloud projects by updated_at (most recent first)
    cloudProjects.sort((a, b) => {
      const dateA = new Date(a.updated_at).getTime()
      const dateB = new Date(b.updated_at).getTime()
      return dateB - dateA
    })

    // Return local projects first, then cloud projects
    return [...localProjects, ...cloudProjects]
  }, [projects])

  const updateProjectScrollButtons = useCallback(() => {
    const element = projectsScrollRef.current
    if (!element) {
      setCanScrollProjectsLeft(false)
      setCanScrollProjectsRight(false)
      return
    }

    const maxScrollLeft = element.scrollWidth - element.clientWidth
    setCanScrollProjectsLeft(element.scrollLeft > 2)
    setCanScrollProjectsRight(maxScrollLeft > 2 && element.scrollLeft < maxScrollLeft - 2)
  }, [])

  const handleProjectScroll = useCallback((direction: 'left' | 'right') => {
    const element = projectsScrollRef.current
    if (!element) return

    const scrollDistance = Math.max(element.clientWidth * 0.75, 140)
    element.scrollBy({
      left: direction === 'left' ? -scrollDistance : scrollDistance,
      behavior: 'smooth',
    })
  }, [])

  // Handle horizontal scroll with vertical mouse wheel using native event listener
  useEffect(() => {
    const element = projectsScrollRef.current
    if (!element) return

    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY !== 0) {
        e.preventDefault()
        element.scrollLeft += e.deltaY
      }
    }

    const handleScroll = () => updateProjectScrollButtons()

    const resizeObserver = new ResizeObserver(() => updateProjectScrollButtons())

    element.addEventListener('wheel', handleWheel, { passive: false })
    element.addEventListener('scroll', handleScroll, { passive: true })
    resizeObserver.observe(element)
    updateProjectScrollButtons()

    return () => {
      element.removeEventListener('wheel', handleWheel)
      element.removeEventListener('scroll', handleScroll)
      resizeObserver.disconnect()
    }
  }, [updateProjectScrollButtons])

  useEffect(() => {
    updateProjectScrollButtons()
  }, [filteredAndSortedProjects, quickChatInput, updateProjectScrollButtons])

  // Fetch models and mutation for model selection
  const { data: modelsData } = useModels(currentProvider)
  const selectModelMutation = useSelectModel()
  const models = modelsData?.models || []
  const selectedModel = useSelectedModel(currentProvider)
  // const refreshModelsMutation = useRefreshModels()

  // Sync secretMode state with React Query cache (handles navigation back to page)
  useEffect(() => {
    const cachedSecretMode = (modelsData as any)?.isSecretMode ?? false
    if (cachedSecretMode !== secretMode) {
      setSecretMode(cachedSecretMode)
    }
  }, [(modelsData as any)?.isSecretMode])

  // Handle model selection
  const handleModelSelect = useCallback(
    (modelName: string) => {
      const model = models.find(m => m.name === modelName)
      if (model) {
        selectModelMutation.mutate({ provider: currentProvider, model })
      }
    },
    [models, selectModelMutation, currentProvider]
  )

  // Handle refresh models
  // const handleRefreshModels = useCallback(() => {
  //   if (currentProvider) {
  //     refreshModelsMutation.mutate(currentProvider)
  //   }
  // }, [currentProvider, refreshModelsMutation])

  // Handle quick chat send
  const handleQuickChatSend = useCallback(async () => {
    const trimmedInput = quickChatInput.trim()
    if (!trimmedInput || !selectedModel) {
      return
    }

    // Use selected project if user picked one, otherwise fall back to quick chat default
    const targetProjectId = selectedProjectId || quickChatProjectId

    // Determine storage mode from the selected project
    const targetProject = projects?.find(p => p.id === targetProjectId)
    const storageMode = targetProject?.storage_mode || 'cloud'

    try {
      // 1. Fetch and set project in Redux (if we have one)
      if (targetProjectId) {
        await dispatch(fetchProjectById({ id: targetProjectId, storageMode })).unwrap()
      }

      // 2. Create conversation with target project
      const result = await dispatch(
        createConversation({
          title: trimmedInput.slice(0, 50), // First 50 chars as title
          projectId: targetProjectId, // Use selected project or default quick chat project
          systemPrompt: null,
          conversationContext: null,
          storageMode, // Route to local or cloud based on project's storage_mode
        })
      ).unwrap()

      // 3. Update React Query caches
      queryClient.setQueryData(['conversations'], (old: Conversation[] | undefined) => {
        return old ? [result, ...old] : [result]
      })

      queryClient.setQueriesData<Conversation[]>({ queryKey: ['conversations', 'recent'] }, old => {
        return old ? [result, ...old] : [result]
      })

      // 4. Set conversation in Redux BEFORE navigation (critical for sendMessage)
      dispatch(chatSliceActions.conversationSet(result.id))
      // 5. Clear conversation-level system prompt and context for quick chats
      dispatch(systemPromptSet(null))
      dispatch(convContextSet(null))

      // 6. Clear input and reset selected project
      setQuickChatInput('')
      setSelectedProjectId(null)

      // 7. Send message BEFORE navigation - we have the conversation ID, no need to wait
      // Pass modelOverride explicitly to avoid relying on Redux provider state
      // which may be null on fresh sign-in (before localStorage is populated)
      dispatch(
        sendMessage({
          conversationId: result.id,
          input: { content: trimmedInput, modelOverride: selectedModel?.name || null },
          parent: null, // First message has no parent
          repeatNum: 1,
          think: think,
          retrigger: false,
        })
      )

      // 8. Navigate to new conversation AFTER sendMessage is dispatched
      navigate(`/chat/${targetProjectId || 'null'}/${result.id}`)
    } catch (error) {
      console.error('[QuickInput] Failed to create quick chat:', error)
    }
  }, [
    quickChatInput,
    selectedModel,
    think,
    dispatch,
    queryClient,
    navigate,
    selectedProjectId,
    quickChatProjectId,
    filteredAndSortedProjects,
  ])

  // Handle Enter key press
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleQuickChatSend()
      }
    },
    [handleQuickChatSend]
  )

  const canSend = quickChatInput.trim().length > 0 && selectedModel !== null
  const showProjectSelector = quickChatInput.trim().length > 0

  return (
    <div className='bg-transparent acrylic-subtle pb-1 mx-4 my-2 pt-3 2xl:pt-2 outline-1 dark:outline-1 dark:outline-neutral-700 outline-neutral-100/50 rounded-2xl drop-shadow-xl shadow-[0_-12px_28px_-6px_rgba(0,0,0,0.05)] dark:shadow-[0_0px_24px_1px_rgba(0,0,0,0.65)]'>
      {/* Project selection pills */}
      {filteredAndSortedProjects && filteredAndSortedProjects.length > 0 && (
        <div className='relative'>
          <div
            ref={projectsScrollRef}
            className={`flex gap-2 px-8 py-1 overflow-x-auto no-scrollbar rounded-2xl transition-all duration-300 ${
              showProjectSelector ? 'max-h-40 opacity-100 pt-3 md:pt-0' : 'max-h-0 opacity-0 pt-0'
            }`}
          >
            {filteredAndSortedProjects.map(project => {
              const isLocalProject = project.storage_mode === 'local'
              const isSelectedProject = selectedProjectId === project.id

              return (
                <button
                  key={project.id}
                  onClick={() => setSelectedProjectId(prev => (prev === project.id ? null : project.id))}
                  className='bg-neutral-100/20  px-1.25 py-0.25  dark:bg-neutral-800/30 rounded-xl'
                >
                  <p
                    className={`whitespace-nowrap flex-shrink-0  transition-all duration-200 text-[14px] ${
                      isSelectedProject
                        ? 'bg-neutral-100 dark:bg-transparent text-sky-700 dark:text-orange-200'
                        : `hover:scale-103 text-emerald-500 dark:text-emerald-500 ${isLocalProject ? '' : 'text-neutral-800 dark:text-neutral-300'}`
                    }`}
                  >
                    {project.name}
                  </p>
                </button>
              )
            })}
          </div>
          <button
            type='button'
            aria-label='Scroll projects left'
            onClick={() => handleProjectScroll('left')}
            className={`absolute left-2 top-1/2 -translate-y-1/2 h-7 w-7 rounded-full border text-sm transition-all duration-200 flex items-center justify-center bg-neutral-50/90 dark:bg-neutral-800/80 border-neutral-300/80 dark:border-neutral-700/70 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 ${
              showProjectSelector && canScrollProjectsLeft ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
            }`}
          >
            <i className='bx bx-chevron-left' aria-hidden='true'></i>
          </button>
          <button
            type='button'
            aria-label='Scroll projects right'
            onClick={() => handleProjectScroll('right')}
            className={`absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7 rounded-full border text-sm transition-all duration-200 flex items-center justify-center bg-neutral-50/90 dark:bg-neutral-800/80 border-neutral-300/80 dark:border-neutral-700/70 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 ${
              showProjectSelector && canScrollProjectsRight
                ? 'opacity-100 pointer-events-auto'
                : 'opacity-0 pointer-events-none'
            }`}
          >
            <i className='bx bx-chevron-right' aria-hidden='true'></i>
          </button>
        </div>
      )}
      <InputTextArea
        value={quickChatInput}
        onChange={setQuickChatInput}
        onKeyDown={handleKeyDown}
        placeholder='Enter a message...'
        state='default'
        width='w-full'
        minRows={1}
        autoFocus={false}
        showCharCount={false}
      />
      <div className='bg-transparent rounded-b-4xl flex flex-col items-end overflow-hidden transition-all duration-300 ease-in-out'>
        <div className='flex justify-between w-full mb-1'>
          <div className='flex items-center justify-start gap-1 flex-wrap flex-1'>
            <ModelSelectControl
              provider={currentProvider}
              selectedModelName={selectedModel?.name || ''}
              onChange={handleModelSelect}
              size='small'
              placeholder='Select model...'
              className='flex-1 ml-2 max-w-28 sm:max-w-28 md:max-w-28 lg:max-w-40 transition-transform duration-60 active:scale-99'
              showFilters={true}
              blur='high'
              footerContent={modelSelectFooter}
            />
            {/* <Button
              variant='outline2'
              className='rounded-full'
              size='medium'
              onClick={() => {
                setSpinRefresh(true)
                handleRefreshModels()
              }}
            >
              <i
                className={`bx bx-refresh text-[26px] sm:text-[18px] md:text-[16px] lg:text-[18px] 2xl:text-[22px] 3xl:text-[28px] 4xl:text-[24px] ${spinRefresh ? 'animate-[spin_0.6s_linear_1]' : ''}`}
                aria-hidden='true'
                onAnimationEnd={() => setSpinRefresh(false)}
              ></i>
            </Button> */}
            {selectedModel?.thinking && (
              <Button
                variant='outline2'
                className='rounded-full'
                size='medium'
                onClick={() => setThink(t => !t)}
                title='Enable thinking'
              >
                {think ? (
                  <>
                    <img
                      src={getAssetPath('img/thinkingonlightmode.svg')}
                      alt='Thinking active'
                      className='w-[28px] h-[28px] sm:w-[28px] sm:h-[28px] md:w-[28px] md:h-[28px] lg:w-[24px] lg:h-[24px] 2xl:w-[28px] 2xl:h-[28px] 3xl:w-[28px] 3xl:h-[28px] 4xl:w-[24px] 4xl:h-[24px] dark:hidden'
                    />
                    <img
                      src={getAssetPath('img/thinkingondarkmode.svg')}
                      alt='Thinking active'
                      className='w-[28px] h-[28px] sm:w-[28px] sm:h-[28px] md:w-[28px] md:h-[28px] lg:w-[24px] lg:h-[24px] 2xl:w-[28px] 2xl:h-[28px] 3xl:w-[28px] 3xl:h-[28px] 4xl:w-[24px] 4xl:h-[24px] hidden dark:block'
                    />
                  </>
                ) : (
                  <>
                    <img
                      src={getAssetPath('img/thinkingofflightmode.svg')}
                      alt='Thinking'
                      className='w-[28px] h-[28px] sm:w-[28px] sm:h-[28px] md:w-[28px] md:h-[28px] lg:w-[24px] lg:h-[24px] 2xl:w-[28px] 2xl:h-[28px] 3xl:w-[28px] 3xl:h-[28px] 4xl:w-[24px] 4xl:h-[24px] dark:hidden'
                    />
                    <img
                      src={getAssetPath('img/thinkingoffdarkmode.svg')}
                      alt='Thinking'
                      className='w-[28px] h-[28px] sm:w-[28px] sm:h-[28px] md:w-[28px] md:h-[28px] lg:w-[24px] lg:h-[24px] 2xl:w-[28px] 2xl:h-[28px] 3xl:w-[28px] 3xl:h-[28px] 4xl:w-[24px] 4xl:h-[24px] hidden dark:block'
                    />
                  </>
                )}
              </Button>
            )}
          </div>
          <div className='flex items-center justify-end pl-2.5'>
            <Button
              variant='outline2'
              size='medium'
              disabled={!canSend}
              onClick={handleQuickChatSend}
              className='rounded-full'
            >
              <i className='bx bx-send text-[22px]' aria-hidden='true'></i>
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
