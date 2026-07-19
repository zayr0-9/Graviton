import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { selectCcCwd } from '../../features/chats/chatSelectors'
import { chatSliceActions } from '../../features/chats/chatSlice'
import type { ImageDraftTarget } from '../../features/chats/chatTypes'
import { addSelectedFileForChat } from '../../features/ideContext'
import { selectMentionableFiles, type MentionableFileOption } from '../../features/ideContext/ideContextSelectors'
import { useIdeContext } from '../../hooks/useIdeContext'
import { type DirectoryFileEntry, useDirectoryFileSearch, useDirectoryFiles } from '../../hooks/useQueries'
import type { RootState } from '../../store/store'
import { readLocalMentionFile } from '../../utils/readLocalMentionFile'
import { localApi } from '../../utils/api'
import { rankFileMatches } from '../../../shared/fileMatchRanking'
import { CHAT_NORMAL_TEXT_SIZE_CLASS, getChatFontSizeOffsetStyle } from '../ChatMessage/chatMessageShared'

type textAreaState = 'default' | 'error' | 'disabled'
type textAreaWidth = 'w-1/6' | 'w-1/4' | 'w-1/2' | 'w-3/4' | 'w-3/5' | 'w-5/6' | 'w-full' | 'max-w-3xl'

interface TextAreaProps {
  label?: string
  placeholder?: string
  value?: string
  onChange?: (value: string) => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onContextMenu?: (e: React.MouseEvent<HTMLTextAreaElement>) => void
  state?: textAreaState
  errorMessage?: string
  maxLength?: number
  width?: textAreaWidth
  className?: string
  minRows?: number
  maxRows?: number
  /**
   * Optional viewport-relative cap for auto-resize mode.
   * Useful for in-message editors where maxRows alone can exceed small screens.
   */
  maxHeightViewportRatio?: number
  autoFocus?: boolean
  showCharCount?: boolean
  fillAvailableHeight?: boolean
  fallbackFileSearchRoot?: string | null
  enableImageAttachments?: boolean
  imageDraftTarget?: ImageDraftTarget
  fontSizeOffset?: number
}

const allowedMentionChar = /[A-Za-z0-9._\/\-]/
const normalizeSlashes = (value: string) => value.replace(/\\/g, '/')
const basename = (value: string) => {
  const normalized = normalizeSlashes(value)
  const parts = normalized.split('/').filter(Boolean)
  return parts[parts.length - 1] || normalized
}
const dirname = (value: string) => {
  const normalized = normalizeSlashes(value)
  const idx = normalized.lastIndexOf('/')
  if (idx <= 0) return ''
  return normalized.slice(0, idx)
}

const toMentionableOption = (file: DirectoryFileEntry): MentionableFileOption => {
  const relativePath = file.relativePath || file.name || basename(file.path)
  const normalizedRelativePath = normalizeSlashes(relativePath)
  return {
    kind: file.isDirectory ? 'folder' : 'file',
    path: file.path,
    relativePath: normalizedRelativePath,
    directoryPath: dirname(file.path),
    relativeDirectoryPath: dirname(normalizedRelativePath),
    name: file.name || basename(normalizedRelativePath),
    mention: `@${normalizedRelativePath}`,
  }
}

function findActiveMention(value: string, cursorPos: number) {
  const beforeCursor = value.slice(0, cursorPos)
  const atIndex = beforeCursor.lastIndexOf('@')
  if (atIndex === -1) return null

  const prevChar = atIndex > 0 ? beforeCursor[atIndex - 1] : ''
  if (prevChar && allowedMentionChar.test(prevChar)) return null

  const afterAt = beforeCursor.slice(atIndex + 1)
  let mentionLength = 0
  while (mentionLength < afterAt.length && allowedMentionChar.test(afterAt[mentionLength])) {
    mentionLength += 1
  }

  // Cursor must still be inside the mention (no spaces/newlines/other chars between @ and cursor)
  // Allow empty term when cursor is immediately after @ (for discoverability)
  if (mentionLength !== afterAt.length) return null

  const term = afterAt.slice(0, mentionLength)
  return { start: atIndex, term }
}

export const TextArea: React.FC<TextAreaProps> = ({
  label,
  placeholder = 'Type your message...',
  value = '',
  onChange,
  onKeyDown,
  onContextMenu,
  state = 'default',
  errorMessage,
  maxLength = 2000000,
  width = 'max-w-full',
  className = '',
  minRows = 1,
  maxRows = 25,
  maxHeightViewportRatio,
  autoFocus = false,
  showCharCount = false,
  fillAvailableHeight = false,
  fallbackFileSearchRoot = null,
  enableImageAttachments = false,
  imageDraftTarget = { kind: 'composer' },
  fontSizeOffset = 0,
  ...rest
}) => {
  const dispatch = useDispatch()
  const imageDrafts = useSelector((s: RootState) => s.chat.composition.imageDrafts)
  const currentImageDraftTarget = useSelector((s: RootState) => s.chat.composition.imageDraftTarget)
  const mentionableFiles = useSelector(selectMentionableFiles)
  const selectedFilesForChat = useSelector((s: RootState) => s.ideContext.selectedFilesForChat)
  const extensionConnected = useSelector((s: RootState) => s.ideContext.extensionConnected)
  const chatCwd = useSelector(selectCcCwd)
  // Local copy of mentionable files to prevent re-selecting the same file locally
  const [localMentionableFiles, setLocalMentionableFiles] = useState(mentionableFiles)
  // Merge in new files from the selector while preserving local removals and excluding already selected files
  useEffect(() => {
    const selectedPaths = new Set(selectedFilesForChat.map(f => f.path))
    setLocalMentionableFiles(mentionableFiles.filter(f => !selectedPaths.has(f.path)))
  }, [mentionableFiles, selectedFilesForChat])
  const imageDraftTargetMatches =
    currentImageDraftTarget?.kind === imageDraftTarget.kind &&
    (imageDraftTarget.kind === 'composer' ||
      (currentImageDraftTarget?.kind === 'branch' &&
        String(currentImageDraftTarget.messageId) === String(imageDraftTarget.messageId)))
  const visibleImageDrafts = enableImageAttachments && imageDraftTargetMatches ? imageDrafts : []

  const effectiveFallbackFileSearchRoot =
    (typeof fallbackFileSearchRoot === 'string' && fallbackFileSearchRoot.trim()) ||
    (typeof chatCwd === 'string' && chatCwd.trim()) ||
    null
  const shouldUseLocalFileFallback =
    import.meta.env.VITE_ENVIRONMENT !== 'web' &&
    !!effectiveFallbackFileSearchRoot &&
    (!extensionConnected || mentionableFiles.length === 0)
  const { requestFileContent } = useIdeContext()
  const id = useId()
  const errorId = `${id}-error`
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const [showFileList, setShowFileList] = useState(false)
  const [selectedFileIndex, setSelectedFileIndex] = useState(0)
  const [filteredFiles, setFilteredFiles] = useState<MentionableFileOption[]>([])
  const [activeMention, setActiveMention] = useState<{ start: number; term: string } | null>(null)
  const [dropdownDirection, setDropdownDirection] = useState<'up' | 'down'>('up')
  const [dropdownMaxHeight, setDropdownMaxHeight] = useState<number | undefined>(undefined)
  const activeMentionTerm = activeMention?.term?.trim() || ''
  const {
    data: fallbackDirectoryData,
    isLoading: isFallbackDirectoryLoading,
    isFetching: isFallbackDirectoryFetching,
    error: fallbackDirectoryError,
  } = useDirectoryFiles(shouldUseLocalFileFallback && !activeMentionTerm ? effectiveFallbackFileSearchRoot : null)
  const {
    data: fallbackFileSearchData,
    isLoading: isFallbackSearchLoading,
    isFetching: isFallbackSearchFetching,
    error: fallbackFileSearchError,
  } = useDirectoryFileSearch(
    shouldUseLocalFileFallback && activeMentionTerm ? effectiveFallbackFileSearchRoot : null,
    shouldUseLocalFileFallback && activeMentionTerm ? activeMentionTerm : null,
    true,
    100
  )
  const selectedMentionedPaths = useMemo(
    () => new Set(selectedFilesForChat.map(file => file.path)),
    [selectedFilesForChat]
  )
  const fallbackMentionableFiles = useMemo(() => {
    const source = activeMentionTerm ? fallbackFileSearchData?.files || [] : fallbackDirectoryData?.files || []
    const options = source.map(toMentionableOption).filter(file => !selectedMentionedPaths.has(file.path))
    return activeMentionTerm ? rankFileMatches(options, activeMentionTerm) : options
  }, [activeMentionTerm, fallbackDirectoryData?.files, fallbackFileSearchData?.files, selectedMentionedPaths])
  const isFallbackMentionLoading = shouldUseLocalFileFallback
    ? activeMentionTerm
      ? isFallbackSearchLoading || isFallbackSearchFetching
      : isFallbackDirectoryLoading || isFallbackDirectoryFetching
    : false
  const fallbackMentionError = activeMentionTerm ? fallbackFileSearchError : fallbackDirectoryError
  const shouldShowFallbackFileListState =
    shouldUseLocalFileFallback &&
    !!activeMention &&
    (isFallbackMentionLoading || !!fallbackMentionError || filteredFiles.length === 0)

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (state === 'disabled') return
    const newValue = e.target.value
    onChange?.(newValue)

    const cursorPos = e.target.selectionStart ?? newValue.length
    const mention = findActiveMention(newValue, cursorPos)
    if (mention) {
      setActiveMention(mention)
    } else {
      setActiveMention(null)
    }
  }

  const scrollToSelectedItem = (index: number) => {
    if (listRef.current) {
      const listElement = listRef.current
      const selectedElement = listElement.children[index] as HTMLElement
      if (selectedElement) {
        selectedElement.scrollIntoView({
          block: 'nearest',
          behavior: 'smooth',
        })
      }
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showFileList && filteredFiles.length > 0) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedFileIndex(prev => {
            const newIndex = prev < filteredFiles.length - 1 ? prev + 1 : 0
            setTimeout(() => scrollToSelectedItem(newIndex), 0)
            return newIndex
          })
          return
        case 'ArrowUp':
          e.preventDefault()
          setSelectedFileIndex(prev => {
            const newIndex = prev > 0 ? prev - 1 : filteredFiles.length - 1
            setTimeout(() => scrollToSelectedItem(newIndex), 0)
            return newIndex
          })
          return
        case 'Enter':
          e.preventDefault()
          handleFileSelection(filteredFiles[selectedFileIndex])
          return
        case 'Tab':
          e.preventDefault()
          handleFileSelection(filteredFiles[selectedFileIndex])
          return
        case 'Escape':
          e.preventDefault()
          setShowFileList(false)
          setActiveMention(null)
          return
      }
    }
    onKeyDown?.(e)
  }

  const handleDragEnter = (e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (state !== 'disabled') setDragOver(true)
  }

  const handleDragOver = (e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (state !== 'disabled') setDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
  }

  const fileToDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })

  const handleDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (state === 'disabled' || !enableImageAttachments) return

    const files = Array.from(e.dataTransfer?.files || [])
    const images = files.filter(f => f.type.startsWith('image/'))
    if (images.length === 0) return

    Promise.all(
      images.map(async image => ({
        dataUrl: await fileToDataUrl(image),
        name: image.name,
        type: image.type,
        size: image.size,
      }))
    )
      .then(drafts => {
        void (async () => {
          try {
            const result = await localApi.post<{ attachments?: Array<{ id: string; file_path: string; sha256: string }> }>(
              '/local/attachments/prepare-base64',
              { attachments: drafts }
            )
            const saved = Array.isArray(result?.attachments) ? result.attachments : []
            if (saved.length !== drafts.length) throw new Error('Incomplete attachment persistence result')
            dispatch(chatSliceActions.imageDraftsAppended({
              drafts: drafts.map((draft, index) => ({
                ...draft,
                filePath: saved[index].file_path,
                attachmentId: saved[index].id,
                sha256: saved[index].sha256,
              })),
              target: imageDraftTarget,
            }))
          } catch (err) {
            console.error('Failed to persist image attachments locally', err)
          }
        })()
      })
      .catch(err => console.error('Failed to read dropped images', err))
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (state === 'disabled' || !enableImageAttachments) return

    const items = Array.from(e.clipboardData?.items || [])
    const imageItems = items.filter(item => item.type.startsWith('image/'))

    if (imageItems.length === 0) return

    e.preventDefault()

    Promise.all(
      imageItems.map(async (item, index) => {
        const file = item.getAsFile()
        if (!file) return null

        return {
          dataUrl: await fileToDataUrl(file),
          name: `pasted-image-${Date.now()}-${index}.${file.type.split('/')[1]}`,
          type: file.type,
          size: file.size,
        }
      })
    )
      .then(results => {
        const drafts = results.filter(Boolean) as Array<{
          dataUrl: string
          name: string
          type: string
          size: number
        }>

        if (drafts.length > 0) {
          void (async () => {
            try {
              const result = await localApi.post<{ attachments?: Array<{ id: string; file_path: string; sha256: string }> }>(
                '/local/attachments/prepare-base64',
                { attachments: drafts }
              )
              const saved = Array.isArray(result?.attachments) ? result.attachments : []
              if (saved.length !== drafts.length) throw new Error('Incomplete attachment persistence result')
              dispatch(chatSliceActions.imageDraftsAppended({
                drafts: drafts.map((draft, index) => ({
                  ...draft,
                  filePath: saved[index].file_path,
                  attachmentId: saved[index].id,
                  sha256: saved[index].sha256,
                })),
                target: imageDraftTarget,
              }))
            } catch (err) {
              console.error('Failed to persist image attachments locally', err)
            }
          })()
        }
      })
      .catch(err => console.error('Failed to read pasted images', err))
  }

  const handleFileSelection = (file: MentionableFileOption) => {
    if (!activeMention) {
      setShowFileList(false)
      return
    }

    const mention = activeMention
    const mentionToken = shouldUseLocalFileFallback ? file.path : file.relativePath || file.name

    try {
      const currentValue = textareaRef.current?.value ?? value
      const before = currentValue.slice(0, mention.start)
      const after = currentValue.slice(mention.start + 1 + mention.term.length)
      const newValue = `${before}@${mentionToken} ${after}`
      onChange?.(newValue)

      setTimeout(() => {
        if (textareaRef.current) {
          const cursorPos = before.length + mentionToken.length + 2 // include @ and trailing space
          textareaRef.current.focus()
          textareaRef.current.setSelectionRange(cursorPos, cursorPos)
        }
      }, 0)

      if (file.kind === 'file') {
        setLocalMentionableFiles(prev => prev.filter(f => f.path !== file.path))
        setFilteredFiles(prev => prev.filter(f => f.path !== file.path))

        if (shouldUseLocalFileFallback) {
          void (async () => {
            try {
              const contents = await readLocalMentionFile(file.path)
              dispatch(
                addSelectedFileForChat({
                  path: file.path,
                  relativePath: file.relativePath,
                  directoryPath: file.directoryPath,
                  relativeDirectoryPath: file.relativeDirectoryPath,
                  name: file.name,
                  contents,
                  contentLength: contents.length,
                })
              )
            } catch (error) {
              console.error('Failed to load fallback @mention file contents:', error)
            }
          })()
        } else {
          void requestFileContent(file.path).catch(error => {
            console.error('Failed to load IDE @mention file contents:', error)
          })
        }
      }
    } catch (error) {
      console.error('Failed to process @mention selection:', error)
    } finally {
      setActiveMention(null)
      setShowFileList(false)
      setSelectedFileIndex(0)
    }
  }

  const getViewportMaxHeight = () => {
    if (!maxHeightViewportRatio || typeof window === 'undefined') return undefined

    const viewportHeight = window.innerHeight || document.documentElement.clientHeight
    if (!viewportHeight) return undefined

    return Math.max(0, viewportHeight * Math.min(Math.max(maxHeightViewportRatio, 0), 1))
  }

  // Auto-resize functionality
  const adjustHeight = () => {
    const textarea = textareaRef.current
    if (textarea) {
      // If fillAvailableHeight is true, only set min-height and let flex handle the rest
      if (fillAvailableHeight) {
        const lineHeight = 24 // Approximate line height in pixels
        const minHeight = minRows * lineHeight + 16 // 16px for padding
        textarea.style.minHeight = `${minHeight}px`
        textarea.style.height = '100%'
        textarea.style.overflowY = 'auto'
        return
      }

      // Original fixed-height behavior for non-flex mode
      // Reset height to auto to get the correct scrollHeight
      textarea.style.height = 'auto'

      // Calculate the number of lines
      const lineHeight = 24 // Approximate line height in pixels
      const minHeight = minRows * lineHeight + 16 // 16px for padding
      const rowMaxHeight = maxRows ? maxRows * lineHeight + 16 : undefined
      const viewportMaxHeight = getViewportMaxHeight()
      const maxHeight = [rowMaxHeight, viewportMaxHeight]
        .filter((height): height is number => typeof height === 'number' && height > 0)
        .reduce<number | undefined>((smallest, height) => (smallest == null ? height : Math.min(smallest, height)), undefined)

      const scrollHeight = textarea.scrollHeight
      let newHeight = Math.max(scrollHeight, minHeight)

      if (maxHeight && newHeight > maxHeight) {
        newHeight = Math.max(minHeight, maxHeight)
        textarea.style.overflowY = 'auto'
      } else {
        textarea.style.overflowY = 'hidden'
      }

      textarea.style.height = `${newHeight}px`
    }
  }

  // Adjust height when value changes
  useEffect(() => {
    adjustHeight()
  }, [value, maxHeightViewportRatio])

  // Adjust height on mount and when the viewport changes
  useEffect(() => {
    adjustHeight()
    if (!maxHeightViewportRatio || typeof window === 'undefined') return

    window.addEventListener('resize', adjustHeight)
    return () => window.removeEventListener('resize', adjustHeight)
  }, [maxHeightViewportRatio])

  // Programmatic focus when autoFocus toggles to true (e.g., after streaming finishes)
  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [autoFocus])

  // Handle clicking outside to close file list
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        showFileList &&
        listRef.current &&
        textareaRef.current &&
        !listRef.current.contains(event.target as Node) &&
        !textareaRef.current.contains(event.target as Node)
      ) {
        setShowFileList(false)
        setActiveMention(null)
      }
    }

    if (showFileList) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showFileList])

  // Re-filter when mention state or available files change
  useEffect(() => {
    if (!activeMention) {
      setFilteredFiles([])
      setSelectedFileIndex(0)
      setShowFileList(false)
      return
    }

    if (shouldUseLocalFileFallback) {
      if (!isFallbackMentionLoading) {
        setFilteredFiles(fallbackMentionableFiles)
        setSelectedFileIndex(0)
      }
      setShowFileList(true)
      return
    }

    const filtered = rankFileMatches(localMentionableFiles, activeMention.term)
    setFilteredFiles(filtered)
    setSelectedFileIndex(0)
    setShowFileList(filtered.length > 0)
  }, [
    activeMention,
    fallbackMentionableFiles,
    isFallbackMentionLoading,
    localMentionableFiles,
    shouldUseLocalFileFallback,
  ])

  // Compute dropdown placement and size (up or down) based on viewport space
  useEffect(() => {
    if (!showFileList) return

    const updatePlacement = () => {
      const ta = textareaRef.current
      if (!ta) return
      const rect = ta.getBoundingClientRect()
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight
      const padding = 8 // px gap from textarea
      const desiredMax = 184 // ~max-h-96 (24rem)

      const spaceBelow = Math.max(0, viewportHeight - rect.bottom - padding)
      const spaceAbove = Math.max(0, rect.top - padding)

      if (spaceBelow >= spaceAbove) {
        setDropdownDirection('down')
        setDropdownMaxHeight(Math.max(0, Math.min(desiredMax, spaceBelow)))
      } else {
        setDropdownDirection('up')
        setDropdownMaxHeight(Math.max(0, Math.min(desiredMax, spaceAbove)))
      }
    }

    updatePlacement()
    window.addEventListener('resize', updatePlacement)
    window.addEventListener('scroll', updatePlacement, true)
    return () => {
      window.removeEventListener('resize', updatePlacement)
      window.removeEventListener('scroll', updatePlacement, true)
    }
  }, [showFileList])

  const textareaStyle = fillAvailableHeight
    ? getChatFontSizeOffsetStyle(fontSizeOffset)
    : {
        minHeight: `${minRows * 24 + 16}px`,
        ...getChatFontSizeOffsetStyle(fontSizeOffset),
      }
  const baseStyles = `${width} resize-none px-4 py-3 rounded-xl transition-all duration-200 overflow-hidden border-1 border-neutral-300 dark:border-neutral-600 bg-neutral-50 dark:bg-neutral-900 ${CHAT_NORMAL_TEXT_SIZE_CLASS} `
  const labelClasses = state === 'disabled' ? 'opacity-40' : ''
  // focus:border-gray-500 focus:ring-2 focus:ring-gray-500 focus:ring-opacity-50 dark:focus:ring-2 dark:focus:ring-secondary-600
  const stateStyles = {
    default: `${baseStyles} dark:bg-neutral-800 text-stone-800 dark:text-stone-200 placeholder-gray-400 border-gray-600 outline-none`,
    error: `${baseStyles} bg-gray-800 text-stone-800 dark:text-stone-200 placeholder-gray-400 border-red-500 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-500 focus:ring-opacity-50`,
    disabled: `${baseStyles} bg-gray-900 text-stone-800 dark:text-stone-200 border-gray-700 placeholder-gray-600 cursor-not-allowed`,
  }

  return (
    <div className={`flex flex-col gap-1 ${fillAvailableHeight ? 'flex-1 h-full' : ''}`}>
      {label && (
        <label
          htmlFor={id}
          className={`text-[13px] text-gray-500 dark:text-gray-200 leading-none pl-1 pb-1 ${labelClasses}`}
        >
          {label}
        </label>
      )}

      <div className={`relative ${fillAvailableHeight ? 'flex flex-col flex-1' : ''}`}>
        <textarea
          ref={textareaRef}
          id={id}
          placeholder={placeholder}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onContextMenu={onContextMenu}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onPaste={handlePaste}
          disabled={state === 'disabled'}
          className={`${stateStyles[state]} thin-scrollbar ${dragOver ? 'border-blue-500 ring-2 ring-blue-500' : ''} ${fillAvailableHeight ? 'flex-1' : ''} ${className}`}
          aria-invalid={state === 'error'}
          aria-describedby={state === 'error' && errorMessage ? errorId : undefined}
          autoFocus={autoFocus}
          style={textareaStyle}
          {...rest}
        />

        {/* Character count indicator */}
        {showCharCount && maxLength && (
          <div className='absolute bottom-2 right-3 text-xs text-stone-800 dark:text-stone-200'>
            {value.length}/{maxLength}
          </div>
        )}

        {/* Floating file list */}
        <div className='relative'>
          {showFileList && (filteredFiles.length > 0 || shouldShowFallbackFileListState) && (
            <div
              ref={listRef}
              className='absolute z-50 mb-1 w-full max-h-96 overflow-y-auto thin-scrollbar dark:bg-neutral-900 bg-neutral-50 rounded-lg shadow-lg'
              style={{
                bottom: dropdownDirection === 'up' ? '100%' : undefined,
                top: dropdownDirection === 'down' ? '100%' : undefined,
                left: 0,
                maxHeight: dropdownMaxHeight ? `${dropdownMaxHeight}px` : undefined,
              }}
            >
              {filteredFiles.map((file, index) => (
                <div
                  key={file.path}
                  className={`px-3 py-2 cursor-pointer text-sm rounded-lg last:border-b-0 ${
                    index === selectedFileIndex
                      ? 'text-stone-800 dark:bg-neutral-700 bg-neutral-200 transform transition-all duration-100 mx-1 dark:text-stone-200'
                      : 'text-stone-800 dark:text-stone-200'
                  }`}
                  onClick={() => handleFileSelection(file)}
                  onMouseEnter={() => setSelectedFileIndex(index)}
                >
                  <div className='flex justify-between'>
                    <div className='font-medium truncate'>
                      {file.kind === 'folder' ? '📁 ' : '📄 '}
                      {file.name}
                    </div>
                    <div className='text-xs text-stone-400 truncate' title={file.relativePath || file.path}>
                      {file.kind === 'folder' ? file.relativePath : file.relativeDirectoryPath || '/'}
                    </div>
                  </div>
                </div>
              ))}
              {shouldUseLocalFileFallback && fallbackMentionError && (
                <div className='px-3 py-2 text-xs text-red-600 dark:text-red-300'>
                  {fallbackMentionError instanceof Error ? fallbackMentionError.message : 'Failed to load files'}
                </div>
              )}
              {shouldUseLocalFileFallback && !fallbackMentionError && filteredFiles.length === 0 && (
                <div className='px-3 py-2 text-xs text-stone-700 dark:text-stone-300'>No matches</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Image draft previews */}
      {visibleImageDrafts.length > 0 && (
        <div className='mt-2 px-2 flex flex-wrap gap-2'>
          {visibleImageDrafts.map((img, idx) => (
            <div
              key={idx}
              className='relative w-16 h-16 rounded-md overflow-hidden border border-gray-600 bg-neutral-800 group'
              title={img.name}
            >
              <img src={img.dataUrl} alt={img.name || `image-${idx}`} className='w-full h-full object-cover' />
              <button
                type='button'
                onClick={() => dispatch(chatSliceActions.imageDraftRemoved({ index: idx, target: imageDraftTarget }))}
                className='absolute top-0 right-0 w-5 h-5 bg-red-400 hover:bg-red-700 text-white rounded-bl-md opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-xs font-bold'
                aria-label='Remove image'
                title='Remove image'
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {state === 'error' && errorMessage && (
        <span id={errorId} className='text-sm text-red-400 mt-1'>
          {errorMessage}
        </span>
      )}
    </div>
  )
}
