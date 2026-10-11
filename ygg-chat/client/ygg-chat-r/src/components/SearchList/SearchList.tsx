import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useIsPresent, useReducedMotion, type HTMLMotionProps } from 'framer-motion'
import { Search, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { TextField } from '..'
import { ConversationId } from '../../../../../shared/types'
import { getActionPopoverThemeStyle } from '../ActionPopover/actionPopoverTheme'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'
import { useMotionPreferences } from '../motion'
import { getSearchListPosition, type SearchListPosition } from './searchListPosition'
import './searchList.css'

export type SearchResultItem = {
  conversationId: ConversationId
  messageId: string
  content: string
  conversationTitle?: string
  createdAt: string
  highlighted?: string
}

type Variant = 'neutral' | 'secondary'
type InputRounding = 'default' | 'full'

export interface SearchListProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  results: SearchResultItem[]
  loading?: boolean
  onResultClick: (conversationId: ConversationId, messageId: string) => void
  placeholder?: string
  className?: string
  inputClassName?: string
  inputRounding?: InputRounding
  dropdownVariant?: Variant
  dropdownZIndex?: number
  fillViewport?: boolean
}

// AnimatePresence retains the shell during exit; inert also gates keyboard focus.
const SearchResultsPanel = React.forwardRef<HTMLDivElement, HTMLMotionProps<'div'>>((props, ref) => {
  const isPresent = useIsPresent()
  return <motion.div {...props} ref={ref} inert={!isPresent} />
})
SearchResultsPanel.displayName = 'SearchResultsPanel'

const SearchList: React.FC<SearchListProps> = ({
  value,
  onChange,
  onSubmit,
  results,
  loading = false,
  onResultClick,
  placeholder = 'Search messages...',
  className = '',
  inputClassName = '',
  inputRounding = 'default',
  dropdownZIndex = 50,
  fillViewport = false,
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const [dropdownPosition, setDropdownPosition] = useState<SearchListPosition | null>(null)
  const dropdownRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const panelId = useId()
  const { theme, enabled: customThemeEnabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()
  const themeStyle: React.CSSProperties | undefined = customThemeEnabled ? {
    ...getActionPopoverThemeStyle(theme, isDarkMode),
    // Quiet search feedback uses secondary surfaces, not the brighter active-toggle accent.
    '--search-hover-bg': getThemeModeColor(theme.colors.settingsCustomThemesButtonBg, isDarkMode),
    '--search-hover-text': getThemeModeColor(theme.colors.settingsCustomThemesButtonText, isDarkMode),
    '--search-control-bg': getThemeModeColor(theme.colors.settingsCustomThemesInnerCardBg, isDarkMode),
  } as React.CSSProperties : undefined
  const { reducedMotion, shellTransition, contentTransition } = useMotionPreferences(useReducedMotion())
  const closePanel = () => {
    setIsOpen(false)
    containerRef.current?.querySelector('input')?.focus()
  }

  // Measure before paint, so the portal never flashes over the input.
  useLayoutEffect(() => {
    const updatePosition = () => {
      if (isOpen && containerRef.current) {
        // Position based on the actual input element
        const inputElement = containerRef.current.querySelector('input')
        if (inputElement) {
          const rect = inputElement.getBoundingClientRect()
          const next = getSearchListPosition(rect, window.innerWidth, window.innerHeight, fillViewport)
          setDropdownPosition(previous =>
            previous?.top === next.top && previous.left === next.left && previous.width === next.width &&
            previous.maxHeight === next.maxHeight && previous.opensUpward === next.opensUpward ? previous : next
          )
        }
      }
    }

    updatePosition()

    if (isOpen) {
      const observer = new ResizeObserver(updatePosition)
      if (containerRef.current) observer.observe(containerRef.current)
      window.addEventListener('scroll', updatePosition, true)
      window.addEventListener('resize', updatePosition)
      return () => {
        observer.disconnect()
        window.removeEventListener('scroll', updatePosition, true)
        window.removeEventListener('resize', updatePosition)
      }
    }
  }, [isOpen, fillViewport])

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false)
      }
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [])

  useEffect(() => {
    if (!value.trim()) setIsOpen(false)
  }, [value])

  useEffect(() => {
    if (!isOpen) return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      setIsOpen(false)
      containerRef.current?.querySelector('input')?.focus()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen])

  const handleEnterKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && isOpen) {
      e.preventDefault()
      dropdownRef.current?.querySelector<HTMLButtonElement>('[data-search-result]')?.focus()
    }
    if (e.key === 'Enter' && value.trim()) {
      onSubmit()
      setIsOpen(true)
    }
  }

  const handleSearchClick = () => {
    if (value.trim()) {
      onSubmit()
      setIsOpen(true)
    }
  }

  const searchInput =
    inputRounding === 'full' ? (
      <div className='search-list-input relative w-full' style={themeStyle}>
        <input
          type='text'
          value={value}
          onChange={event => onChange(event.target.value)}
          onKeyDown={handleEnterKey}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-expanded={isOpen}
          aria-controls={isOpen ? panelId : undefined}
          className={`w-full rounded-full transition-[background-color,color] duration-150 ${inputClassName} !pr-12`}
        />
        <button
          type='button'
          onClick={handleSearchClick}
          aria-label='Search'
          title='Search'
          className='search-list-control absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full transition-[background-color,color] duration-150 active:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 dark:focus-visible:ring-orange-400/70'
        >
          <Search size={18} strokeWidth={2.25} aria-hidden='true' />
        </button>
      </div>
    ) : (
      <TextField
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        onKeyDown={handleEnterKey}
        showSearchIcon
        onSearchClick={handleSearchClick}
        className={inputClassName}
      />
    )

  const dropdownContent = (
    <AnimatePresence>
      {isOpen && dropdownPosition && (
        <SearchResultsPanel
          key='search-results'
          ref={dropdownRef}
          id={panelId}
          role='region'
          aria-label='Chat search results'
          aria-busy={loading}
          className='search-list-panel fixed flex flex-col overflow-hidden rounded-[26px] p-2 backdrop-blur-2xl'
          initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: dropdownPosition.opensUpward ? -8 : 8, scale: 0.97 }}
          animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
          transition={shellTransition}
          exit={reducedMotion
            ? { opacity: 0, pointerEvents: 'none', transition: { ...contentTransition, duration: 0.15 } }
            : { opacity: 0, scale: 0.99, pointerEvents: 'none', transition: { duration: 0.15, ease: [0.22, 1, 0.36, 1] } }}
          style={{
            ...themeStyle,
            zIndex: dropdownZIndex,
            colorScheme: isDarkMode ? 'dark' : 'light',
            top: dropdownPosition.top,
            left: dropdownPosition.left,
            width: dropdownPosition.width,
            height: fillViewport ? dropdownPosition.maxHeight : undefined,
            maxHeight: dropdownPosition.maxHeight,
            transformOrigin: dropdownPosition.opensUpward ? 'bottom center' : 'top center',
            pointerEvents: isOpen ? 'auto' : 'none',
          }}
          onKeyDown={event => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            const buttons = Array.from(dropdownRef.current?.querySelectorAll<HTMLButtonElement>('[data-search-result]') ?? [])
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
            if (index < 0) return
            event.preventDefault()
            buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
          }}
        >
          <div className='flex shrink-0 items-center justify-between gap-2 px-3 pb-2 pt-1'>
            <div className='min-w-0'>
              <h2 className='text-sm font-semibold'>Search results</h2>
              <p className='search-list-muted mt-0.5 text-xs' role='status'>
                {loading ? 'Searching messages…' : `${results.length} ${results.length === 1 ? 'match' : 'matches'}`}
              </p>
            </div>
            <button
              type='button'
              title='Close search results'
              aria-label='Close search results'
              onClick={closePanel}
              className='search-list-control flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-[background-color,color] duration-150 active:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 dark:focus-visible:ring-orange-400/70'
            >
              <X size={16} strokeWidth={2.25} aria-hidden='true' />
            </button>
          </div>
          <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain thin-scrollbar'>
            {loading || results.length === 0 ? (
              <div className='search-list-muted flex min-h-40 flex-col items-center justify-center gap-3 px-4 py-8 text-center'>
                <span className='search-list-control flex h-11 w-11 items-center justify-center rounded-full'>
                  <Search size={18} strokeWidth={2.25} aria-hidden='true' />
                </span>
                <p className='text-sm'>{loading ? 'Looking through your chats…' : 'No matching messages'}</p>
                {!loading && <p className='text-xs'>Try a different word or phrase.</p>}
              </div>
            ) : (
              <ul className='space-y-1'>
                {results.map(res => (
                  <li key={`${res.conversationId}-${res.messageId}`}>
                    <button
                      type='button'
                      data-search-result
                      className='search-list-result w-full rounded-[18px] p-3 text-left transition-[background-color,color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/70 dark:focus-visible:ring-orange-400/70'
                      title={res.conversationTitle}
                      onClick={() => {
                        onResultClick(res.conversationId, res.messageId)
                        setIsOpen(false)
                      }}
                    >
                      <div className='flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1'>
                        <span className='min-w-0 truncate text-sm font-semibold'>
                          {res.conversationTitle || `Conv ${res.conversationId}`}
                        </span>
                        <time className='search-list-muted shrink-0 text-[11px]' dateTime={res.createdAt} title={new Date(res.createdAt).toLocaleString()}>
                          {new Date(res.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </time>
                      </div>
                      <span className='mt-2 line-clamp-6 whitespace-pre-wrap break-words text-xs leading-relaxed'>
                        {res.content}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SearchResultsPanel>
      )}
    </AnimatePresence>
  )

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {searchInput}
      {dropdownContent && typeof document !== 'undefined' ? createPortal(dropdownContent, document.body) : null}
    </div>
  )
}

export default SearchList
