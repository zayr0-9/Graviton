import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { isCloudSessionEnabled } from '../config/runtimeMode'
import {
  clearDefaultLocalUserSystemPrompt,
  createLocalUserSystemPrompt,
  setDefaultLocalUserSystemPrompt,
  type UserSystemPromptStorageMode,
} from '../helpers/userSystemPromptStorage'
import { clearDefaultUserSystemPrompt, createUserSystemPrompt, setDefaultUserSystemPrompt } from '../utils/api'
import { useAuth } from './useAuth'
import { UserSystemPromptCached, useUserSystemPromptsQuery } from './useQueries'

const MAX_PROMPT_NAME_LENGTH = 100

export interface UseUserSystemPromptsOptions {
  /** Called when a prompt is selected */
  onPromptSelect?: (content: string) => void
  /** Called when an error occurs */
  onError?: (message: string) => void
  /** Current system prompt content (for checking if it matches existing prompts) */
  currentPromptContent?: string
  /** Whether the modal/component is open (triggers fetch) */
  isOpen?: boolean
}

export interface UseUserSystemPromptsReturn {
  // State
  prompts: UserSystemPromptCached[]
  loading: boolean
  selectedPromptId: string | null
  showSavePromptInput: boolean
  savePromptName: string
  savePromptStorage: UserSystemPromptStorageMode
  canSaveToCloud: boolean
  savingPrompt: boolean
  saveError: string | null
  isExistingPrompt: boolean
  matchingPrompt: UserSystemPromptCached | null
  makingDefault: boolean
  removingDefault: boolean

  // Actions
  setSelectedPromptId: (id: string | null) => void
  setShowSavePromptInput: (show: boolean) => void
  setSavePromptName: (name: string) => void
  setSavePromptStorage: (storage: UserSystemPromptStorageMode) => void
  handleSelectPrompt: (prompt: UserSystemPromptCached) => void
  handleSaveAsPrompt: () => Promise<void>
  handleMakeDefault: () => Promise<void>
  handleRemoveDefault: () => Promise<void>
  resetSaveUI: () => void
  clearError: () => void
}

const isLocalPrompt = (prompt: UserSystemPromptCached | null | undefined) =>
  prompt?.storage_mode === 'local' || prompt?.id.startsWith('local-')

export const useUserSystemPrompts = (options: UseUserSystemPromptsOptions = {}): UseUserSystemPromptsReturn => {
  const { onPromptSelect, onError, currentPromptContent = '', isOpen = true } = options

  const queryClient = useQueryClient()
  const { accessToken, userId } = useAuth()
  const canSaveToCloud = Boolean(userId && isCloudSessionEnabled())

  // Use React Query for system prompts (cached globally)
  const { prompts, isLoading, refetch } = useUserSystemPromptsQuery()

  // Local state
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null)
  const [showSavePromptInput, setShowSavePromptInput] = useState(false)
  const [savePromptName, setSavePromptName] = useState('')
  const [savePromptStorage, setSavePromptStorageState] = useState<UserSystemPromptStorageMode>(() =>
    canSaveToCloud ? 'cloud' : 'local'
  )
  const [savingPrompt, setSavingPrompt] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [makingDefault, setMakingDefault] = useState(false)
  const [removingDefault, setRemovingDefault] = useState(false)

  const setSavePromptStorage = useCallback(
    (storage: UserSystemPromptStorageMode) => {
      setSavePromptStorageState(storage === 'cloud' && !canSaveToCloud ? 'local' : storage)
    },
    [canSaveToCloud]
  )

  useEffect(() => {
    if (!canSaveToCloud && savePromptStorage === 'cloud') {
      setSavePromptStorageState('local')
    }
  }, [canSaveToCloud, savePromptStorage])

  // Find the prompt that matches current content (if any)
  const matchingPrompt = useMemo(() => {
    if (!currentPromptContent.trim()) return null
    return prompts.find(prompt => prompt.content.trim() === currentPromptContent.trim()) || null
  }, [prompts, currentPromptContent])

  // Check if current content matches any saved prompt
  const isExistingPrompt = matchingPrompt !== null

  // Refetch prompts when modal opens to ensure fresh data
  useEffect(() => {
    if (isOpen) {
      // Refetch to ensure we have the latest prompts, including local prompt changes.
      refetch()
    }
  }, [isOpen, refetch])

  // Handle selecting a saved prompt
  const handleSelectPrompt = useCallback(
    (prompt: UserSystemPromptCached) => {
      setSelectedPromptId(prompt.id)
      onPromptSelect?.(prompt.content)
    },
    [onPromptSelect]
  )

  // Reset save UI state
  const resetSaveUI = useCallback(() => {
    setShowSavePromptInput(false)
    setSavePromptName('')
    setSaveError(null)
  }, [])

  // Clear error
  const clearError = useCallback(() => {
    setSaveError(null)
  }, [])

  // Handle making the matching prompt the default
  const handleMakeDefault = useCallback(async () => {
    if (!matchingPrompt) {
      const errorMsg = 'No matching prompt found'
      setSaveError(errorMsg)
      onError?.(errorMsg)
      return
    }

    if (matchingPrompt.is_default) {
      // Already the default, nothing to do
      return
    }

    setMakingDefault(true)
    setSaveError(null)

    try {
      if (isLocalPrompt(matchingPrompt)) {
        const updatedPrompt = setDefaultLocalUserSystemPrompt(matchingPrompt.id)
        if (!updatedPrompt) throw new Error('Local prompt not found')

        queryClient.setQueryData<UserSystemPromptCached[]>(['userSystemPrompts', userId], old => {
          if (!old) return [updatedPrompt]
          return old.map(p => (isLocalPrompt(p) ? { ...p, is_default: p.id === updatedPrompt.id } : p))
        })
        setSelectedPromptId(updatedPrompt.id)
        return
      }

      if (!userId) {
        const errorMsg = 'Authentication required'
        setSaveError(errorMsg)
        onError?.(errorMsg)
        return
      }

      const updatedPrompt = { ...(await setDefaultUserSystemPrompt(matchingPrompt.id, accessToken)), storage_mode: 'cloud' as const }

      // Update React Query cache - set is_default to false for all other cloud prompts
      queryClient.setQueryData<UserSystemPromptCached[]>(['userSystemPrompts', userId], old => {
        if (!old) return [updatedPrompt]
        return old.map(p =>
          isLocalPrompt(p)
            ? p
            : {
                ...p,
                is_default: p.id === updatedPrompt.id,
              }
        )
      })

      // Select the prompt
      setSelectedPromptId(updatedPrompt.id)
    } catch (error) {
      const errorMsg = 'Failed to set default prompt. Please try again.'
      console.error('Failed to set default system prompt:', error)
      setSaveError(errorMsg)
      onError?.(errorMsg)
    } finally {
      setMakingDefault(false)
    }
  }, [matchingPrompt, accessToken, queryClient, userId, onError])

  // Handle removing the default status from the matching prompt
  const handleRemoveDefault = useCallback(async () => {
    if (!matchingPrompt || !matchingPrompt.is_default) {
      return
    }

    setRemovingDefault(true)
    setSaveError(null)

    try {
      if (isLocalPrompt(matchingPrompt)) {
        clearDefaultLocalUserSystemPrompt()
        queryClient.setQueryData<UserSystemPromptCached[]>(['userSystemPrompts', userId], old => {
          if (!old) return old
          return old.map(p => (isLocalPrompt(p) ? { ...p, is_default: false } : p))
        })
        return
      }

      if (!userId) {
        const errorMsg = 'Authentication required'
        setSaveError(errorMsg)
        onError?.(errorMsg)
        return
      }

      await clearDefaultUserSystemPrompt(accessToken)

      // Update React Query cache - set is_default to false for cloud prompts
      queryClient.setQueryData<UserSystemPromptCached[]>(['userSystemPrompts', userId], old => {
        if (!old) return old
        return old.map(p => (isLocalPrompt(p) ? p : { ...p, is_default: false }))
      })
    } catch (error) {
      const errorMsg = 'Failed to remove default status. Please try again.'
      console.error('Failed to remove default system prompt:', error)
      setSaveError(errorMsg)
      onError?.(errorMsg)
    } finally {
      setRemovingDefault(false)
    }
  }, [matchingPrompt, accessToken, queryClient, userId, onError])

  // Handle saving current prompt as a new user system prompt
  const handleSaveAsPrompt = useCallback(async () => {
    // Validation
    if (!savePromptName.trim()) {
      const errorMsg = 'Please enter a name for this prompt'
      setSaveError(errorMsg)
      onError?.(errorMsg)
      return
    }

    if (savePromptName.trim().length > MAX_PROMPT_NAME_LENGTH) {
      const errorMsg = `Name must be less than ${MAX_PROMPT_NAME_LENGTH} characters`
      setSaveError(errorMsg)
      onError?.(errorMsg)
      return
    }

    if (!currentPromptContent.trim()) {
      const errorMsg = 'Please enter prompt content'
      setSaveError(errorMsg)
      onError?.(errorMsg)
      return
    }

    if (savePromptStorage === 'cloud' && !accessToken) {
      const errorMsg = 'Authentication required for cloud prompts. Choose Local to save on this device.'
      setSaveError(errorMsg)
      onError?.(errorMsg)
      return
    }

    setSavingPrompt(true)
    setSaveError(null)

    try {
      const newPrompt =
        savePromptStorage === 'local'
          ? createLocalUserSystemPrompt({
              name: savePromptName.trim(),
              content: currentPromptContent.trim(),
            })
          : {
              ...(await createUserSystemPrompt(
                {
                  name: savePromptName.trim(),
                  content: currentPromptContent.trim(),
                },
                accessToken
              )),
              storage_mode: 'cloud' as const,
            }

      // Update React Query cache with the new prompt
      queryClient.setQueryData<UserSystemPromptCached[]>(['userSystemPrompts', userId], old => {
        if (!old) return [newPrompt]
        return [...old.filter(prompt => prompt.id !== newPrompt.id), newPrompt]
      })

      // Reset save prompt UI
      resetSaveUI()
      // Select the newly created prompt
      setSelectedPromptId(newPrompt.id)
    } catch (error) {
      const errorMsg = 'Failed to save prompt. Please try again.'
      console.error('Failed to save system prompt:', error)
      setSaveError(errorMsg)
      onError?.(errorMsg)
    } finally {
      setSavingPrompt(false)
    }
  }, [savePromptName, currentPromptContent, savePromptStorage, accessToken, queryClient, userId, resetSaveUI, onError])

  return {
    // State
    prompts,
    loading: isLoading,
    selectedPromptId,
    showSavePromptInput,
    savePromptName,
    savePromptStorage,
    canSaveToCloud,
    savingPrompt,
    saveError,
    isExistingPrompt,
    matchingPrompt,
    makingDefault,
    removingDefault,

    // Actions
    setSelectedPromptId,
    setShowSavePromptInput,
    setSavePromptName,
    setSavePromptStorage,
    handleSelectPrompt,
    handleSaveAsPrompt,
    handleMakeDefault,
    handleRemoveDefault,
    resetSaveUI,
    clearError,
  }
}
