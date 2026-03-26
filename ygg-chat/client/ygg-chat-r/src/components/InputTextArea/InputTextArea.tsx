import React, { useEffect, useId, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { selectFocusedChatMessageId } from '../../features/chats/chatSelectors'
import { chatSliceActions } from '../../features/chats/chatSlice'
import { setCurrentSelection } from '../../features/ideContext'
import {
  selectCurrentSelection,
  selectMentionableFiles,
  selectSelectedFilesForChat,
  type MentionableFileOption,
} from '../../features/ideContext/ideContextSelectors'
import { useIdeContext } from '../../hooks/useIdeContext'
import type { RootState } from '../../store/store'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'

type textAreaState = 'default' | 'error' | 'disabled'
// Accept any Tailwind width/max-width class combination (e.g. "w-full max-w-3xl").
type textAreaWidth = string

type SlashCommandSelectionResult = {
  handled: boolean
  clearInput?: boolean
}

interface TextAreaProps {
  label?: string
  placeholder?: string
  value?: string
  onChange?: (value: string) => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onBlur?: () => void
  state?: textAreaState
  errorMessage?: string
  maxLength?: number
  width?: textAreaWidth
  className?: string
  minRows?: number
  maxRows?: number
  autoFocus?: boolean
  showCharCount?: boolean
  showHelp?: boolean
  outline?: boolean
  onProcessMessage?: (processMessage: (message: string) => string) => void
  variant?: 'primary' | 'outline'
  slashCommands?: string[]
  onSlashCommandSelect?: (command: string) => SlashCommandSelectionResult | void
  onAddCurrentIdeContext?: () => boolean
  onClearIdeContexts?: () => void
  selectedIdeContextItems?: Array<{ id: string; label: string }>
}

const allowedMentionChar = /[A-Za-z0-9._\/\-]/

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

// Detect slash command at position 0 (e.g., "/compact", "/clear")
const allowedSlashChar = /[A-Za-z0-9_\-]/

function findActiveSlashCommand(value: string, cursorPos: number) {
  // Slash commands must start at position 0
  if (!value.startsWith('/')) return null

  const beforeCursor = value.slice(0, cursorPos)
  // Only process if cursor is within the slash command (after the /)
  if (!beforeCursor.startsWith('/')) return null

  const afterSlash = beforeCursor.slice(1)
  let commandLength = 0
  while (commandLength < afterSlash.length && allowedSlashChar.test(afterSlash[commandLength])) {
    commandLength += 1
  }

  // If there's a space after the command, we're done with autocomplete
  if (commandLength < afterSlash.length && afterSlash[commandLength] === ' ') {
    return null
  }

  const term = afterSlash.slice(0, commandLength)
  return { start: 0, term }
}

export const InputTextArea: React.FC<TextAreaProps> = ({
  label,
  placeholder = 'Type your message...',
  value = '',
  onChange,
  onKeyDown,
  onBlur,
  state = 'default',
  errorMessage,
  maxLength = 1000000,
  width = 'max-w-3xl',
  className = '',
  minRows = 1,
  maxRows = 25,
  autoFocus = false,
  showCharCount = false,
  showHelp = true,
  outline = false,
  onProcessMessage, // redundant with onChange but included for backward compatibility for now
  variant = 'primary',
  slashCommands,
  onSlashCommandSelect,
  onAddCurrentIdeContext,
  onClearIdeContexts,
  selectedIdeContextItems = [],
  ...rest
}) => {
  const dispatch = useDispatch()
  const focusedMessageId = useSelector(selectFocusedChatMessageId)
  const imageDrafts = useSelector((s: RootState) => s.chat.composition.imageDrafts)
  const editingBranch = useSelector((s: RootState) => s.chat.composition.editingBranch)
  const currentSelection = useSelector(selectCurrentSelection)
  const mentionableFiles = useSelector(selectMentionableFiles)
  const selectedFilesForChat = useSelector(selectSelectedFilesForChat)
  // Local copy of mentionable files to prevent re-selecting the same file locally
  const [localMentionableFiles, setLocalMentionableFiles] = useState(mentionableFiles)
  // Merge in new files from the selector while preserving local removals
  useEffect(() => {
    // Drive the visible mentionable files from Redux state:
    // exclude files that are currently selected (ideContext.selectedFilesForChat),
    // and add them back automatically when they are removed from that list.
    const selectedPaths = new Set(selectedFilesForChat.map(f => f.path))
    setLocalMentionableFiles(mentionableFiles.filter(f => !selectedPaths.has(f.path)))
  }, [mentionableFiles, selectedFilesForChat])
  const { requestFileContent } = useIdeContext()
  const id = useId()
  const errorId = `${id}-error`
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [showFileList, setShowFileList] = useState(false)
  const [selectedFileIndex, setSelectedFileIndex] = useState(0)
  const [filteredFiles, setFilteredFiles] = useState<MentionableFileOption[]>([])
  const [activeMention, setActiveMention] = useState<{ start: number; term: string } | null>(null)

  const ideSelectionText = currentSelection?.selectedText?.trim() || ''
  const hasIdeContextSelection = ideSelectionText.length > 0
  const ideSelectionPreview =
    ideSelectionText.length > 1200
      ? `${ideSelectionText.slice(0, 1200)}
…`
      : ideSelectionText
  const ideSelectionPath =
    currentSelection?.relativePath ||
    currentSelection?.filePath?.split(/[\\/]/).pop() ||
    currentSelection?.filePath ||
    'current file'
  const ideSelectionLocation = currentSelection
    ? `${ideSelectionPath}:${currentSelection.startLine}-${currentSelection.endLine}`
    : null
  const [showContextAddedNotice, setShowContextAddedNotice] = useState(false)
  const { theme: customTheme, enabled: customThemeEnabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()

  const handleAddContextClick = () => {
    if (!onAddCurrentIdeContext || !hasIdeContextSelection) return
    const wasAdded = onAddCurrentIdeContext()
    if (!wasAdded) return

    setShowContextAddedNotice(true)
    window.setTimeout(() => setShowContextAddedNotice(false), 1200)
  }

  const handleClearIdeContextsClick = () => {
    dispatch(setCurrentSelection(null))
    onClearIdeContexts?.()
    setShowContextAddedNotice(false)
  }

  // Slash command autocomplete state
  const slashListRef = useRef<HTMLDivElement>(null)
  const [showSlashList, setShowSlashList] = useState(false)
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0)
  const [filteredSlashCommands, setFilteredSlashCommands] = useState<string[]>([])
  const [activeSlashCommand, setActiveSlashCommand] = useState<{ start: number; term: string } | null>(null)

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (state === 'disabled') return
    const newValue = e.target.value
    onChange?.(newValue)

    const cursorPos = e.target.selectionStart ?? newValue.length

    // Check for slash commands first (must start at position 0)
    if (slashCommands && slashCommands.length > 0) {
      const slashCmd = findActiveSlashCommand(newValue, cursorPos)
      if (slashCmd) {
        setActiveSlashCommand(slashCmd)
        setActiveMention(null) // Clear file mention when slash command is active
        return
      }
    }
    setActiveSlashCommand(null)

    // Check for file mentions
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

  const scrollToSelectedSlashItem = (index: number) => {
    if (slashListRef.current) {
      const listElement = slashListRef.current
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
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      dispatch(chatSliceActions.operationModeToggled())
      return
    }

    // Handle slash command list navigation
    if (showSlashList && filteredSlashCommands.length > 0) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedSlashIndex(prev => {
            const newIndex = prev < filteredSlashCommands.length - 1 ? prev + 1 : 0
            setTimeout(() => scrollToSelectedSlashItem(newIndex), 0)
            return newIndex
          })
          return
        case 'ArrowUp':
          e.preventDefault()
          setSelectedSlashIndex(prev => {
            const newIndex = prev > 0 ? prev - 1 : filteredSlashCommands.length - 1
            setTimeout(() => scrollToSelectedSlashItem(newIndex), 0)
            return newIndex
          })
          return
        case 'Enter':
        case 'Tab':
          e.preventDefault()
          handleSlashCommandSelection(filteredSlashCommands[selectedSlashIndex])
          return
        case 'Escape':
          e.preventDefault()
          setShowSlashList(false)
          return
      }
    }

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
        case 'Escape':
          e.preventDefault()
          setShowFileList(false)
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
    if (state === 'disabled') return

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
        dispatch(chatSliceActions.imageDraftsAppended(drafts))
        if (focusedMessageId != null) {
          dispatch(
            chatSliceActions.messageArtifactsAppended({
              messageId: focusedMessageId,
              artifacts: drafts.map(d => d.dataUrl),
            })
          )
        }
      })
      .catch(err => console.error('Failed to read dropped images', err))
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (state === 'disabled') return

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
          dispatch(chatSliceActions.imageDraftsAppended(drafts))
          if (focusedMessageId != null) {
            dispatch(
              chatSliceActions.messageArtifactsAppended({
                messageId: focusedMessageId,
                artifacts: drafts.map(d => d.dataUrl),
              })
            )
          }
        }
      })
      .catch(err => console.error('Failed to read pasted images', err))
  }

  const handleFileSelection = async (file: MentionableFileOption) => {
    if (!activeMention) {
      setShowFileList(false)
      return
    }

    const mentionToken = file.relativePath || file.name

    try {
      if (file.kind === 'file') {
        await requestFileContent(file.path)
        setLocalMentionableFiles(prev => prev.filter(f => f.path !== file.path))
        setFilteredFiles(prev => prev.filter(f => f.path !== file.path))
      }

      if (textareaRef.current) {
        const currentValue = textareaRef.current.value
        const before = currentValue.slice(0, activeMention.start)
        const after = currentValue.slice(activeMention.start + 1 + activeMention.term.length)
        const newValue = `${before}@${mentionToken} ${after}`
        onChange?.(newValue)

        setTimeout(() => {
          if (textareaRef.current) {
            const cursorPos = before.length + mentionToken.length + 2 // include @ and trailing space
            textareaRef.current.focus()
            textareaRef.current.setSelectionRange(cursorPos, cursorPos)
          }
        }, 0)
      }
    } catch (error) {
      console.error('Failed to process @mention selection:', error)
    } finally {
      setActiveMention(null)
      setShowFileList(false)
    }
  }

  // Handle slash command selection from autocomplete
  const handleSlashCommandSelection = (command: string) => {
    if (!activeSlashCommand) {
      setShowSlashList(false)
      return
    }

    const commandResult = onSlashCommandSelect?.(command)
    if (commandResult && commandResult.handled) {
      if (commandResult.clearInput) {
        const after = value.slice(activeSlashCommand.start + 1 + activeSlashCommand.term.length)
        const clearedValue = after.trimStart()
        onChange?.(clearedValue)

        setTimeout(() => {
          if (textareaRef.current) {
            textareaRef.current.focus()
            const cursorPos = Math.max(clearedValue.length, 0)
            textareaRef.current.setSelectionRange(cursorPos, cursorPos)
          }
        }, 0)
      }

      setActiveSlashCommand(null)
      setShowSlashList(false)
      return
    }

    if (textareaRef.current) {
      // Replace the partial command with the selected one
      // The command already includes the `/` prefix, so just add a trailing space
      const after = value.slice(activeSlashCommand.start + 1 + activeSlashCommand.term.length)
      const newValue = `${command} ${after.trimStart()}`
      onChange?.(newValue)

      setTimeout(() => {
        if (textareaRef.current) {
          const cursorPos = command.length + 1 // After the command and space
          textareaRef.current.focus()
          textareaRef.current.setSelectionRange(cursorPos, cursorPos)
        }
      }, 0)
    }

    setActiveSlashCommand(null)
    setShowSlashList(false)
  }

  // Auto-resize functionality with debounced execution to prevent forced reflows
  const adjustHeightTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const adjustHeight = () => {
    const textarea = textareaRef.current
    if (!textarea) return

    requestAnimationFrame(() => {
      textarea.style.height = 'auto'

      const computedStyle = window.getComputedStyle(textarea)
      const fallbackLineHeight = 24
      const parsedLineHeight = parseFloat(computedStyle.lineHeight)
      const lineHeight = Number.isNaN(parsedLineHeight) ? fallbackLineHeight : parsedLineHeight
      const paddingTop = parseFloat(computedStyle.paddingTop) || 0
      const paddingBottom = parseFloat(computedStyle.paddingBottom) || 0
      const verticalPadding = paddingTop + paddingBottom
      const minHeight = Math.max(minRows, 1) * lineHeight + verticalPadding
      const maxHeight = maxRows ? maxRows * lineHeight + verticalPadding : undefined

      const scrollHeight = textarea.scrollHeight
      let newHeight = Math.max(scrollHeight, minHeight)

      if (maxHeight && newHeight > maxHeight) {
        newHeight = maxHeight
        textarea.style.overflowY = 'auto'
      } else {
        textarea.style.overflowY = 'hidden'
      }

      textarea.style.height = `${newHeight}px`
    })
  }

  const debouncedAdjustHeight = () => {
    if (adjustHeightTimeoutRef.current) {
      clearTimeout(adjustHeightTimeoutRef.current)
    }
    adjustHeightTimeoutRef.current = setTimeout(adjustHeight, 16) // ~60fps
  }

  // Adjust height when value changes (debounced)
  useEffect(() => {
    debouncedAdjustHeight()
  }, [value, minRows, maxRows])

  // Filter slash commands when active command changes
  useEffect(() => {
    if (activeSlashCommand && slashCommands) {
      const term = activeSlashCommand.term.toLowerCase()
      const filtered = slashCommands.filter(cmd => {
        const normalized = cmd.startsWith('/') ? cmd.slice(1) : cmd
        return normalized.toLowerCase().startsWith(term)
      })
      setFilteredSlashCommands(filtered)
      setShowSlashList(filtered.length > 0)
      setSelectedSlashIndex(0)
    } else {
      setFilteredSlashCommands([])
      setShowSlashList(false)
      setSelectedSlashIndex(0)
    }
  }, [activeSlashCommand, slashCommands])

  // Close slash list on outside click
  useEffect(() => {
    if (!showSlashList) return

    const handleClickOutside = (e: MouseEvent) => {
      if (slashListRef.current && !slashListRef.current.contains(e.target as Node)) {
        setShowSlashList(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showSlashList])

  // Adjust height on mount and cleanup timeout
  useEffect(() => {
    adjustHeight()
    return () => {
      if (adjustHeightTimeoutRef.current) {
        clearTimeout(adjustHeightTimeoutRef.current)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minRows, maxRows])

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

    const term = activeMention.term.toLowerCase()
    const filtered = localMentionableFiles.filter(file => {
      const nameMatches = file.name.toLowerCase().includes(term)
      const relativePathMatches = file.relativePath.toLowerCase().includes(term)
      const relativeDirectoryMatches = file.relativeDirectoryPath.toLowerCase().includes(term)
      const absolutePathMatches = file.path.toLowerCase().includes(term)
      return nameMatches || relativePathMatches || relativeDirectoryMatches || absolutePathMatches
    })
    setFilteredFiles(filtered)
    setSelectedFileIndex(0)
    setShowFileList(filtered.length > 0)
  }, [activeMention, localMentionableFiles])

  const variantStyles = {
    primary:
      'text-stone-900 dark:text-stone-200 placeholder-neutral-700 dark:placeholder-neutral-200 border-secondary-600 outline-none focus:border-secondary-600 focus:ring-1 focus:ring-opacity-50 dark:focus:ring-secondary-600',
    outline:
      'rounded-3xl text-neutral-900 dark:text-neutral-300 border border-neutral-300 focus:border-neutral-400 dark:border-neutral-700 outline-none dark:focus:border-neutral-600',
  }

  const baseStyles = outline
    ? `${width} px-3 py-2 sm:px-4 sm:py-2 md:px-4 md:py-2 lg:px-4 lg:py-2 2xl:px-4 2xl:py-2 overflow-hidden bg-transparent text-[16px] sm:text-[16px] md:text-[16px] lg:text-[16px] 2xl:text-[16px] ${variantStyles[variant]}`
    : `${width} px-3 py-1 sm:px-3 sm:py-1 md:px-3 md:py-1 lg:px-3 lg:py-1 2xl:px-3 2xl:py-1 rounded-xl transition-all duration-200 overflow-hidden bg-transparent text-[16px] sm:text-[14px] md:text-[14px] lg:text-[14px] 2xl:text-[16px]`
  const labelClasses = state === 'disabled' ? 'opacity-40' : ''

  const stateStyles = outline
    ? {
        default: `${baseStyles}`,
        error: `${baseStyles} text-stone-800 dark:text-stone-200 placeholder-neutral-700 dark:placeholder-neutral-200 border-red-500 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-500 focus:ring-opacity-50`,
        disabled: `${baseStyles} text-stone-800 dark:text-stone-200 border-gray-700 placeholder-neutral-700 dark:placeholder-neutral-200 cursor-not-allowed`,
      }
    : {
        default: `${baseStyles} bg-transparent text-stone-900 dark:text-stone-200 placeholder-neutral-700 dark:placeholder-neutral-200 border-gray-600 outline-none focus:border-neutral-300 focus:ring-0 focus:ring-neutral-300 focus:ring-opacity-50 dark:focus:ring-0 `,
        error: `${baseStyles} bg-gray-800 text-stone-800 dark:text-stone-200 placeholder-neutral-700 dark:placeholder-neutral-200 border-red-500 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-500 focus:ring-opacity-50`,
        disabled: `${baseStyles} bg-gray-900 text-stone-800 dark:text-stone-200 border-gray-700 placeholder-neutral-700 dark:placeholder-neutral-200 cursor-not-allowed`,
      }

  const ideContextPillStyle = customThemeEnabled
    ? {
        backgroundColor: getThemeModeColor(customTheme.colors.ideContextPillBg, isDarkMode),
        borderColor: getThemeModeColor(customTheme.colors.ideContextPillBorder, isDarkMode),
        color: getThemeModeColor(customTheme.colors.ideContextPillText, isDarkMode),
      }
    : undefined

  const ideContextAddButtonStyle = customThemeEnabled
    ? {
        backgroundColor: getThemeModeColor(customTheme.colors.ideContextAddButtonBg, isDarkMode),
        borderColor: getThemeModeColor(customTheme.colors.ideContextAddButtonBorder, isDarkMode),
        color: getThemeModeColor(customTheme.colors.ideContextAddButtonText, isDarkMode),
      }
    : undefined

  const ideContextPreviewStyle = customThemeEnabled
    ? {
        backgroundColor: getThemeModeColor(customTheme.colors.ideContextPreviewBg, isDarkMode),
        borderColor: getThemeModeColor(customTheme.colors.ideContextPreviewBorder, isDarkMode),
      }
    : undefined

  const ideContextPreviewFileTextStyle = customThemeEnabled
    ? {
        color: getThemeModeColor(customTheme.colors.ideContextPreviewFileText, isDarkMode),
      }
    : undefined

  const ideContextPreviewCodeTextStyle = customThemeEnabled
    ? {
        color: getThemeModeColor(customTheme.colors.ideContextPreviewCodeText, isDarkMode),
      }
    : undefined

  const ideContextSelectedPillStyle = customThemeEnabled
    ? {
        backgroundColor: getThemeModeColor(customTheme.colors.ideContextSelectedPillBg, isDarkMode),
        borderColor: getThemeModeColor(customTheme.colors.ideContextSelectedPillBorder, isDarkMode),
        color: getThemeModeColor(customTheme.colors.ideContextSelectedPillText, isDarkMode),
      }
    : undefined

  const ideContextClearButtonStyle = customThemeEnabled
    ? {
        borderColor: getThemeModeColor(customTheme.colors.ideContextClearButtonBorder, isDarkMode),
        color: getThemeModeColor(customTheme.colors.ideContextClearButtonText, isDarkMode),
      }
    : undefined

  const ideContextAddedTextStyle = customThemeEnabled
    ? {
        color: getThemeModeColor(customTheme.colors.ideContextAddedText, isDarkMode),
      }
    : undefined

  return (
    <div className={`flex flex-col gap-0`}>
      {label && (
        <label
          htmlFor={id}
          className={`text-md font-medium text-neutral-800 dark:text-neutral-200 pb-2 ${labelClasses}`}
        >
          {label}
        </label>
      )}

      <div className={`relative`}>
        {/* Slash Command Autocomplete Dropdown */}
        {showSlashList && filteredSlashCommands.length > 0 && (
          <div
            ref={slashListRef}
            className='absolute bottom-full left-0 mb-1 w-64 max-h-48 overflow-y-auto
                       /70 acrylic-light  rounded-xl shadow-lg z-50'
          >
            {filteredSlashCommands.map((command, index) => (
              <div
                key={command}
                className={`px-3 py-2 cursor-pointer text-sm ${
                  index === selectedSlashIndex
                    ? 'transparent dark:text-orange-400 text-blue-400'
                    : 'hover:bg-neutral-100 dark:hover:bg-neutral-700 text-neutral-900 dark:text-neutral-100'
                }`}
                onClick={() => handleSlashCommandSelection(command)}
              >
                <span className='font-medium'>{command}</span>
              </div>
            ))}
          </div>
        )}

        {/* Floating file list */}
        {showFileList && filteredFiles.length > 0 && (
          <div
            ref={listRef}
            className='absolute acrylic-input-chat-light z-50 mb-1 w-full max-h-96 overflow-y-auto rounded-b-lg rounded-3xl thin-scrollbar'
            style={{
              bottom: '100%',
              left: 0,
            }}
          >
            {filteredFiles.map((file, index) => (
              <div
                key={file.path}
                className={`px-3 py-2 cursor-pointer text-[10px] rounded-lg sm:text-[8px] md:text-[8px] lg:text-[10px] 2xl:text-[12px] 3xl:text-[14px] 4xl:text-[16px] last:border-b-0 ${
                  index === selectedFileIndex
                    ? 'text-stone-800 dark:bg-neutral-700 bg-neutral-200 transform transition-all duration-100 mx-1 dark:text-stone-200'
                    : 'text-stone-800 dark:text-stone-200'
                }`}
                onClick={() => handleFileSelection(file)}
                onMouseEnter={() => setSelectedFileIndex(index)}
              >
                <div className='flex justify-between gap-2'>
                  <div className='pl-2 font-medium sm:text-xs md:text-xs lg:text-sm 3xl:text-base 4xl:text-lg truncate basis-2/5'>
                    {file.kind === 'folder' ? '📁 ' : '📄 '}
                    {file.name}
                  </div>
                  <div
                    className='pl-2 overflow-left text-[10px] sm:text-xs md:text-xs lg:text-sm 3xl:text-base 4xl:text-lg text-stone-800 dark:text-stone-300 truncate rtl text-left basis-3/5'
                    title={file.relativePath || file.path}
                  >
                    {file.kind === 'folder' ? file.relativePath : file.relativeDirectoryPath || '/'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {(hasIdeContextSelection || selectedIdeContextItems.length > 0) && (
          <div className='mb-2 mt-1 ml-1 flex flex-wrap items-center gap-2'>
            {hasIdeContextSelection && (
              <div className='group relative inline-flex max-w-full items-center gap-1'>
                <span
                  className='inline-flex items-center rounded-full border dark:border-orange-400/60 border-blue-400/60 bg-blue-100/80 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide dark:border-orange-500/60 dark:bg-neutral-900/40 text-neutral-900 dark:text-neutral-200'
                  style={ideContextPillStyle}
                >
                  ide context detected
                </span>
                <button
                  type='button'
                  onClick={handleAddContextClick}
                  className='inline-flex mt-0.5 h-5.5 w-5.5 items-center justify-center rounded-full border border-blue-400/60 dark:border-orange-400/70 bg-blue-100/80 dark:bg-transparent text-xs font-bold text-neutral-900 hover:bg-orange-300/80 dark:border-orange-500/60 dark:bg-neutral-800/60 dark:text-orange-100 dark:hover:bg-orange-700/70'
                  style={ideContextAddButtonStyle}
                  title='Add this IDE context to message context list'
                  aria-label='Add IDE context'
                >
                  +
                </button>

                <div
                  className='pointer-events-none thin-scrollbar absolute bottom-full left-0 z-50 mb-2 hidden w-[24rem] max-w-[90vw] rounded-md border bg-neutral-100/80 dark:bg-neutral-50/95 p-2 shadow-sm group-hover:block dark:border-orange-500/40 dark:bg-neutral-900/95'
                  style={ideContextPreviewStyle}
                >
                  {ideSelectionLocation && (
                    <div className='mb-1 text-[10px] font-semibold text-orange-900 dark:text-orange-200' style={ideContextPreviewFileTextStyle}>
                      {ideSelectionLocation}
                    </div>
                  )}
                  <pre
                    className='max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-orange-950 dark:text-orange-100'
                    style={ideContextPreviewCodeTextStyle}
                  >
                    {ideSelectionPreview}
                  </pre>
                </div>
              </div>
            )}

            {showContextAddedNotice && (
              <span className='text-[10px] font-semibold text-blue-700 dark:text-orange-300' style={ideContextAddedTextStyle}>
                context added
              </span>
            )}

            {selectedIdeContextItems.length > 0 && (
              <div className='flex flex-wrap gap-1'>
                {selectedIdeContextItems.map(item => (
                  <span
                    key={item.id}
                    className='inline-flex items-center rounded-full border shadow-sm dark:bg-orange-100/70 px-2 py-0.5 text-[11px] text-neutral-900 dark:border-orange-500/40 dark:bg-transparent dark:text-orange-100'
                    style={ideContextSelectedPillStyle}
                    title={item.label}
                  >
                    {item.label}
                  </span>
                ))}
              </div>
            )}

            <button
              type='button'
              onClick={handleClearIdeContextsClick}
              className='ml-auto inline-flex items-center mr-2 rounded-full border border-neutral-400/70 px-2 py-0.25 text-[10px] font-semibold uppercase tracking-wide text-neutral-700 hover:bg-neutral-200/70 dark:border-orange-500/40 dark:text-orange-100 dark:hover:bg-orange-700/40'
              style={ideContextClearButtonStyle}
              title='Clear detected and added IDE contexts'
              aria-label='Clear IDE contexts'
            >
              clear
            </button>
          </div>
        )}

        <textarea
          ref={textareaRef}
          id={id}
          placeholder={placeholder}
          value={value}
          rows={minRows}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={onBlur}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onPaste={handlePaste}
          disabled={state === 'disabled'}
          // maxLength={maxLength}
          className={`${stateStyles[state]} thin-scrollbar resize-none ${dragOver ? 'border-blue-500 ring-2 ring-blue-500' : ''} ${className}`}
          aria-invalid={state === 'error'}
          aria-describedby={state === 'error' && errorMessage ? errorId : undefined}
          autoFocus={autoFocus}
          {...rest}
        />

        {/* Character count indicator */}
        {showCharCount && (
          <div className='absolute bottom-5 right-2 text-[10px] sm:text-[8px] md:text-[8px] lg:text-[10px] 2xl:text-[12px] 3xl:text-[14px] 4xl:text-[16px] text-stone-800 dark:text-stone-200'>
            {value.length}
          </div>
        )}
        {/* Help text indicator */}
        {showHelp && value.length <= 0 && (
          // <div className='absolute top-4 right-2 text-[10px] sm:text-[8px] md:text-[8px] lg:text-[10px] 2xl:text-[10px] 3xl:text-[12px] 4xl:text-[14px] text-stone-800 dark:text-stone-200'>
          //   {/* {value.length}/{maxLength} */}
          //   Shift+Enter
          //   <br />
          //   for new line
          // </div>
          <span className='absolute bottom-1 right-2 hidden sm:block font-mono text-[10px] text-neutral-400/60 dark:text-neutral-600 whitespace-nowrap select-none'>
            SHIFT+ENTER <span className='opacity-50'>NEW LINE</span>
          </span>
        )}
      </div>

      {/* Image draft previews (hidden while editing a branch) */}
      {!editingBranch && imageDrafts && imageDrafts.length > 0 && (
        <div className='mt-2 px-2 flex flex-wrap gap-2'>
          {imageDrafts.map((img, idx) => (
            <div
              key={idx}
              className='relative w-16 h-16 rounded-md overflow-hidden border border-gray-600 bg-neutral-800 group'
              title={img.name}
            >
              <img src={img.dataUrl} alt={img.name || `image-${idx}`} className='w-full h-full object-cover' />
              <button
                onClick={() => dispatch(chatSliceActions.imageDraftRemoved(idx))}
                className='absolute top-0 right-0 w-5 h-5 bg-red-400 hover:bg-red-700 text-white rounded-bl-md opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-xs font-bold'
                aria-label='Remove image'
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
