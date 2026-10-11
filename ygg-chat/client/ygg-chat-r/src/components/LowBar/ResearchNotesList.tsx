import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronUp } from 'lucide-react'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useDispatch } from 'react-redux'
import { useChatNavigate as useNavigate } from '../ChatSelection/ChatSelectionProvider'
import { updateResearchNote } from '../../features/conversations/conversationActions'
import { Conversation } from '../../features/conversations/conversationTypes'
import { useAuth } from '../../hooks/useAuth'
import { useIsMobile } from '../../hooks/useMediaQuery'
import { ResearchNoteItem } from '../../hooks/useQueries'
import { TextArea } from '../TextArea/TextArea'

interface ResearchNotesListProps {
  notes: ResearchNoteItem[]
  isLoading?: boolean
  isEmbedded?: boolean
}

export const ResearchNotesList: React.FC<ResearchNotesListProps> = ({
  notes,
  isLoading = false,
  isEmbedded = false,
}) => {
  const navigate = useNavigate()
  const dispatch = useDispatch()
  const queryClient = useQueryClient()
  const { userId } = useAuth()
  const isMobile = useIsMobile()

  const [isExpanded, setIsExpanded] = useState(false)
  const [expandedNoteIds, setExpandedNoteIds] = useState<Set<string>>(new Set())
  const [localNotes, setLocalNotes] = useState<Map<string, string>>(new Map())
  const debounceTimeoutRefs = useRef<Map<string, NodeJS.Timeout>>(new Map())

  const handleNoteClick = (note: ResearchNoteItem) => {
    navigate(`/chat/${note.project_id}/${note.id}`)
  }

  const toggleNoteExpansion = (noteId: string, event: React.MouseEvent) => {
    event.stopPropagation() // Prevent navigation when clicking chevron
    setExpandedNoteIds(prev => {
      const newSet = new Set(prev)
      if (newSet.has(noteId)) {
        newSet.delete(noteId)
      } else {
        newSet.add(noteId)
      }
      return newSet
    })
  }

  // Debounced update handler for note changes
  const handleNoteChange = useCallback(
    (noteId: string, newValue: string, projectId: string | null, noteTitle: string) => {
      // Update local state immediately for instant UI feedback
      setLocalNotes(prev => {
        const newMap = new Map(prev)
        newMap.set(noteId, newValue)
        return newMap
      })

      // Clear existing debounce timeout for this note
      const timeoutMap = debounceTimeoutRefs.current
      if (timeoutMap.has(noteId)) {
        clearTimeout(timeoutMap.get(noteId)!)
      }

      // Set new debounce timeout
      const timeout = setTimeout(() => {
        dispatch(updateResearchNote({ id: noteId, researchNote: newValue }) as any)
          .unwrap()
          .then(() => {
            // Update React Query caches to reflect the new research note

            // Update all conversations cache
            const conversationsCache = queryClient.getQueryData<Conversation[]>(['conversations'])
            if (conversationsCache) {
              queryClient.setQueryData(
                ['conversations'],
                conversationsCache.map(conv => (conv.id === noteId ? { ...conv, research_note: newValue } : conv))
              )
            }

            // Update project conversations cache if project exists
            if (projectId) {
              const projectConversationsCache = queryClient.getQueryData<Conversation[]>([
                'conversations',
                'project',
                projectId,
              ])
              if (projectConversationsCache) {
                queryClient.setQueryData(
                  ['conversations', 'project', projectId],
                  projectConversationsCache.map(conv =>
                    conv.id === noteId ? { ...conv, research_note: newValue } : conv
                  )
                )
              }
            }

            // Update recent conversations cache
            const recentCache = queryClient.getQueryData<Conversation[]>(['conversations', 'recent'])
            if (recentCache) {
              queryClient.setQueryData(
                ['conversations', 'recent'],
                recentCache.map(conv => (conv.id === noteId ? { ...conv, research_note: newValue } : conv))
              )
            }

            // Update research notes cache
            const researchNotesCache = queryClient.getQueryData<ResearchNoteItem[]>(['research-notes', userId])
            if (researchNotesCache) {
              // If note is empty or whitespace, remove from list
              if (!newValue || newValue.trim().length === 0) {
                queryClient.setQueryData(
                  ['research-notes', userId],
                  researchNotesCache.filter(item => item.id !== noteId)
                )
              } else {
                // Update existing note or add new one
                const existingIndex = researchNotesCache.findIndex(item => item.id === noteId)
                if (existingIndex >= 0) {
                  // Update existing note
                  queryClient.setQueryData(
                    ['research-notes', userId],
                    researchNotesCache.map(item =>
                      item.id === noteId
                        ? {
                            ...item,
                            research_note: newValue,
                            updated_at: new Date().toISOString(),
                          }
                        : item
                    )
                  )
                } else {
                  // Add new note to the list
                  queryClient.setQueryData(
                    ['research-notes', userId],
                    [
                      {
                        id: noteId,
                        title: noteTitle || `Conversation ${noteId}`,
                        research_note: newValue,
                        updated_at: new Date().toISOString(),
                        project_id: projectId,
                      },
                      ...researchNotesCache,
                    ]
                  )
                }
              }
            }
          })
          .catch((error: unknown) => {
            console.error('Failed to update research note:', error)
          })
          .finally(() => {
            // Remove timeout from map after execution
            timeoutMap.delete(noteId)
          })
      }, 1000) // 1 second debounce

      // Store timeout in map
      timeoutMap.set(noteId, timeout)
    },
    [dispatch, queryClient, userId]
  )

  // Initialize local notes from props when component mounts or notes change
  useEffect(() => {
    const initialNotes = new Map<string, string>()
    notes.forEach(note => {
      initialNotes.set(note.id, note.research_note)
    })
    setLocalNotes(initialNotes)
  }, [notes])

  // Cleanup: clear all pending debounce timers on unmount
  useEffect(() => {
    return () => {
      debounceTimeoutRefs.current.forEach(timeout => clearTimeout(timeout))
    }
  }, [])

  const truncateNote = (text: string, maxLength: number = 100): string => {
    if (text.length <= maxLength) return text
    return text.substring(0, maxLength) + '...'
  }

  const formatDate = (dateString: string): string => {
    const date = new Date(dateString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    if (diffDays === 0) {
      return 'Today'
    } else if (diffDays === 1) {
      return 'Yesterday'
    } else if (diffDays < 7) {
      return `${diffDays} days ago`
    } else {
      return date.toLocaleDateString()
    }
  }

  // Render content only when embedded (used inside LowBar tabs)
  if (isEmbedded) {
    return (
      <>
        {isLoading ? (
          <div className='text-center py-4 text-stone-600 dark:text-stone-400'>Loading notes...</div>
        ) : notes.length === 0 ? (
          <div className='text-center py-2 rounded-2xl acrylic-light text-stone-900 dark:text-stone-400'>
            No research notes yet. Create notes by adding them to your conversations.
          </div>
        ) : (
          <div className='space-y-3'>
            {notes.map(note => {
              const isNoteExpanded = expandedNoteIds.has(note.id)

              return (
                <div
                  key={note.id}
                  className='p-3 bg-neutral-100 dark:bg-neutral-900 rounded-lg border border-neutral-200 dark:border-neutral-700 transition-all duration-200 ease-in-out'
                >
                  {/* Clickable header area - navigates to chat */}
                  <div onClick={() => handleNoteClick(note)} className='cursor-pointer transition-opacity duration-150'>
                    {/* Title row with chevron button */}
                    <div className='flex items-start justify-between gap-2 mb-1'>
                      <h3 className='flex-1 text-sm font-semibold text-stone-800 dark:text-stone-200 truncate'>
                        {note.title || `Conversation ${note.id}`}
                      </h3>
                      <button
                        onClick={e => toggleNoteExpansion(note.id, e)}
                        className='flex-shrink-0 p-1 hover:bg-neutral-200 dark:hover:bg-neutral-700 rounded transition-colors duration-150'
                        aria-label={isNoteExpanded ? 'Collapse note' : 'Expand note'}
                        aria-expanded={isNoteExpanded}
                      >
                        {isNoteExpanded ? (
                          <ChevronUp className='w-3.5 h-3.5 text-stone-600 dark:text-stone-400' />
                        ) : (
                          <ChevronDown className='w-3.5 h-3.5 text-stone-600 dark:text-stone-400' />
                        )}
                      </button>
                    </div>

                    {/* Truncated preview - only show when collapsed */}
                    {!isNoteExpanded && (
                      <p className='text-xs text-stone-600 dark:text-stone-400 line-clamp-2'>
                        {truncateNote(note.research_note)}
                      </p>
                    )}
                  </div>

                  {/* Expanded content - editable TextArea */}
                  {isNoteExpanded && (
                    <div className='mt-2'>
                      <TextArea
                        value={localNotes.get(note.id) ?? note.research_note}
                        onChange={value => handleNoteChange(note.id, value, note.project_id, note.title)}
                        placeholder='Add research notes...'
                        minRows={3}
                        maxRows={undefined}
                        className='text-xs'
                        width='w-full'
                      />
                    </div>
                  )}

                  {/* Timestamp */}
                  <div className='text-xs text-stone-500 dark:text-stone-500 mt-2'>{formatDate(note.updated_at)}</div>
                </div>
              )
            })}
          </div>
        )}
      </>
    )
  }

  // Standalone rendering with fixed positioning (original behavior)
  return (
    <div
      className={`fixed bottom-4 right-4 z-50 transition-all duration-300 ease-in-out ${
        isExpanded
          ? isMobile
            ? 'w-[95%] h-[75%]'
            : 'w-[35%] h-[60%]'
          : isMobile
            ? 'w-[50%] h-[35px]'
            : 'w-[18%] h-[35px]'
      }`}
    >
      {/* Container with shadow and border */}
      <div className='h-full flex flex-col backdrop-blur-sm dark:bg-transparent border border-transparent dark:border-neutral-800 rounded-2xl shadow-lg overflow-hidden'>
        {/* Header bar (always visible) */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className={`flex items-center justify-between ${isExpanded ? 'mt-2 mx-2' : ''} px-4 py-2 bg-neutral-50 dark:bg-neutral-900 dark:outline-2 rounded-full dark:hover:bg-neutral-800 transition-all hover:scale-99 duration-200 shadow-[0px_0px_3px_1px_rgba(0,0,0,0.05)] dark:shadow-[0px_0px_16px_2px_rgba(0,0,0,0.45)] dark:outline-neutral-800`}
        >
          <span className='text-sm font-medium text-stone-800 dark:text-stone-200'>All Notes ({notes.length})</span>
          {isExpanded ? (
            <ChevronUp className='w-4 h-4 text-stone-600 dark:text-stone-300' />
          ) : (
            <ChevronDown className='w-4 h-4 text-stone-600 dark:text-stone-300' />
          )}
        </button>

        {/* Expanded content - List of notes */}
        {isExpanded && (
          <div
            className='flex-1 p-3 overflow-y-auto thin-scrollbar '
            data-heimdall-wheel-exempt='true'
            data-heimdall-contextmenu-exempt='true'
          >
            {isLoading ? (
              <div className='text-center py-4 text-stone-600 dark:text-stone-400'>Loading notes...</div>
            ) : notes.length === 0 ? (
              <div className='text-center py-2 text-stone-900 rounded-4xl acrylic-light dark:text-stone-400'>
                No research notes yet. Create notes by adding them to your conversations.
              </div>
            ) : (
              <div className='space-y-3'>
                {notes.map(note => {
                  const isNoteExpanded = expandedNoteIds.has(note.id)

                  return (
                    <div
                      key={note.id}
                      className='p-3 bg-neutral-50 dark:bg-neutral-900 rounded-lg border border-neutral-200 dark:border-neutral-700 shadow-sm transition-all duration-200 ease-in-out'
                    >
                      {/* Clickable header area - navigates to chat */}
                      <div
                        onClick={() => handleNoteClick(note)}
                        className='cursor-pointer hover:opacity-80 transition-opacity duration-150'
                      >
                        {/* Title row with chevron button */}
                        <div className='flex items-start justify-between gap-2 mb-1'>
                          <h3 className='flex-1 text-sm font-semibold text-stone-800 dark:text-stone-200 truncate'>
                            {note.title || `Conversation ${note.id}`}
                          </h3>
                          <button
                            onClick={e => toggleNoteExpansion(note.id, e)}
                            className='flex-shrink-0 p-1 hover:bg-neutral-200 dark:hover:bg-neutral-700 rounded transition-colors duration-150'
                            aria-label={isNoteExpanded ? 'Collapse note' : 'Expand note'}
                            aria-expanded={isNoteExpanded}
                          >
                            {isNoteExpanded ? (
                              <ChevronUp className='w-3.5 h-3.5 text-stone-600 dark:text-stone-400' />
                            ) : (
                              <ChevronDown className='w-3.5 h-3.5 text-stone-600 dark:text-stone-400' />
                            )}
                          </button>
                        </div>

                        {/* Truncated preview - only show when collapsed */}
                        {!isNoteExpanded && (
                          <p className='text-xs text-stone-600 dark:text-stone-400 line-clamp-2'>
                            {truncateNote(note.research_note)}
                          </p>
                        )}
                      </div>

                      {/* Expanded content - editable TextArea */}
                      {isNoteExpanded && (
                        <div className='mt-2'>
                          <TextArea
                            value={localNotes.get(note.id) ?? note.research_note}
                            onChange={value => handleNoteChange(note.id, value, note.project_id, note.title)}
                            placeholder='Add research notes...'
                            minRows={3}
                            maxRows={undefined}
                            className='text-xs'
                            width='w-full'
                          />
                        </div>
                      )}

                      {/* Timestamp */}
                      <div className='text-xs text-stone-500 dark:text-stone-500 mt-2'>
                        {formatDate(note.updated_at)}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
