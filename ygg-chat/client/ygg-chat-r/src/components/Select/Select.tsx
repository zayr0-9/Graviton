import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Check, ChevronDown, Expand, LockKeyhole, MoreVertical, Search, Star } from 'lucide-react'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { BaseModel } from '../../../../../shared/types'
import { useIsMobile } from '../../hooks/useMediaQuery'
import {
  getFavoritedModels,
  setFavoritedModels as saveFavoritedModels,
  toggleModelFavorite,
} from '../../utils/favorites'
import { Button } from '../Button/button'
import { reducedMotionTransition, shellSpringTransition } from '../motion'
import { getActionPopoverThemeStyle } from '../ActionPopover/actionPopoverTheme'
import { useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'
import './select.css'
import { ModelInfoModal } from '../ModelInfoModal/ModelInfoModal'

export type SelectOption = { value: string; label?: string }

interface SelectProps {
  value?: string
  options: Array<string | SelectOption>
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  searchBarVisible?: boolean
  size?: 'small' | 'medium' | 'large'
  blur?: 'low' | 'high'
  filterUI?: React.ReactNode
  modelData?: Record<string, BaseModel>
  modelProvider?: string | null
  onFavoritesChange?: () => void
  modelSelect?: boolean
  footerContent?: React.ReactNode
  /** Options that should be visually disabled (shown but not selectable) */
  disabledOptions?: string[]
  /** Show "View All" button when there are more options than displayed */
  showExpandButton?: boolean
  /** Callback when expand button is clicked */
  onExpandClick?: () => void
  /** Total count of all options (for display in expand button) */
  totalOptionsCount?: number
  /** z-index applied to the dropdown portal container */
  dropdownZIndex?: number
  /** Minimum pixel width for the dropdown portal. Defaults to trigger width. */
  dropdownMinWidth?: number
  /** Pixel width added to the trigger width for the dropdown portal. Defaults to model select expansion. */
  dropdownWidthOffset?: number
}

const DROPDOWN_LIMIT = 25
const DEFAULT_SELECT_DROPDOWN_Z_INDEX = 100


export const Select: React.FC<SelectProps> = ({
  value,
  options,
  onChange,
  placeholder = 'Select...',
  disabled = false,
  className = '',
  searchBarVisible = false,
  size = 'medium',
  blur = 'low',
  filterUI,
  modelData,
  modelProvider,
  onFavoritesChange,
  modelSelect = false,
  footerContent,
  disabledOptions = [],
  showExpandButton = false,
  onExpandClick,
  totalOptionsCount,
  dropdownZIndex = DEFAULT_SELECT_DROPDOWN_Z_INDEX,
  dropdownMinWidth,
  dropdownWidthOffset,
}) => {
  const [open, setOpen] = useState(false)
  const shouldReduceMotion = useReducedMotion()
  const prefersReducedMotion = shouldReduceMotion ?? false
  const [activeIndex, setActiveIndex] = useState<number>(-1)
  const [searchTerm, setSearchTerm] = useState('')
  const [showModelInfo, setShowModelInfo] = useState(false)
  const [selectedModelForInfo, setSelectedModelForInfo] = useState<BaseModel | null>(null)
  const [favoritedModels, setFavoritedModels] = useState<string[]>(() => getFavoritedModels())
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const [listMaxHeight, setListMaxHeight] = useState<number | undefined>(undefined)
  const [dropdownPosition, setDropdownPosition] = useState<{
    top?: number
    bottom?: number
    left: number
    width: number
  } | null>(null)
  const isMobile = useIsMobile()
  const { theme: customTheme, enabled: customThemeEnabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()
  const dropdownThemeStyle = customThemeEnabled
    ? getActionPopoverThemeStyle(customTheme, isDarkMode)
    : undefined

  const computeDropdownMetrics = useCallback(() => {
    const btn = btnRef.current
    if (!btn || typeof window === 'undefined') return
    const rect = btn.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    const shouldOpenUp = spaceBelow < 200 && spaceAbove > spaceBelow
    const available = (shouldOpenUp ? spaceAbove : spaceBelow) - 8
    const maxH = Math.max(160, Math.min(460, available))
    setListMaxHeight(Number.isFinite(maxH) ? maxH : 280)

    const left = modelSelect ? rect.left - 5 : rect.left
    const widthOffset = dropdownWidthOffset ?? (modelSelect ? 80 : 0)
    const desiredWidth = Math.max(rect.width + widthOffset, dropdownMinWidth ?? 0)
    const viewportPadding = 8
    const maxWidth = Math.max(rect.width, window.innerWidth - viewportPadding * 2)
    const width = Math.min(desiredWidth, maxWidth)
    const adjustedLeft = Math.min(Math.max(viewportPadding, left), Math.max(viewportPadding, window.innerWidth - width - viewportPadding))

    setDropdownPosition({
      top: shouldOpenUp ? undefined : rect.bottom + 4,
      bottom: shouldOpenUp ? window.innerHeight - rect.top + 4 : undefined,
      left: adjustedLeft,
      width,
    })
  }, [dropdownMinWidth, dropdownWidthOffset, modelSelect])

  // Toggle favorite status and persist to localStorage
  const toggleFavorite = useCallback(
    (modelName: string) => {
      setFavoritedModels(prev => {
        const updated = toggleModelFavorite(modelName, prev)
        saveFavoritedModels(updated)
        onFavoritesChange?.()
        return updated
      })
    },
    [onFavoritesChange]
  )

  // Check if a model is favorited
  const isFavorite = useCallback(
    (modelName: string) => {
      return favoritedModels.includes(modelName)
    },
    [favoritedModels]
  )

  const normOptions: SelectOption[] = useMemo(() => {
    const out: SelectOption[] = []
    for (const o of options) {
      if (o == null) continue
      if (typeof o === 'string') {
        out.push({ value: o, label: o })
      } else if (typeof o.value === 'string' && o.value.length > 0) {
        out.push({ value: o.value, label: o.label ?? o.value })
      }
    }
    return out
  }, [options])

  const filteredOptions: SelectOption[] = useMemo(() => {
    let result = normOptions
    if (searchBarVisible && searchTerm.trim()) {
      const term = searchTerm.toLowerCase()
      result = normOptions.filter(
        opt => opt.label.toLowerCase().includes(term) || opt.value.toLowerCase().includes(term)
      )
    }
    // Limit dropdown to DROPDOWN_LIMIT items for modelSelect (performance optimization)
    if (modelSelect && showExpandButton && result.length > DROPDOWN_LIMIT) {
      return result.slice(0, DROPDOWN_LIMIT)
    }
    return result
  }, [normOptions, searchTerm, searchBarVisible, modelSelect, showExpandButton])

  // Count of all filtered options before limiting (for "View All" button)
  const allFilteredCount = useMemo(() => {
    if (!searchBarVisible || !searchTerm.trim()) {
      return totalOptionsCount ?? normOptions.length
    }
    const term = searchTerm.toLowerCase()
    return normOptions.filter(opt => opt.label.toLowerCase().includes(term) || opt.value.toLowerCase().includes(term))
      .length
  }, [normOptions, searchTerm, searchBarVisible, totalOptionsCount])

  const selected = useMemo(() => normOptions.find(o => o.value === value) || null, [normOptions, value])

  // Size styles to mirror Button component sizes with responsive text sizing
  const sizeClass = useMemo(() => {
    switch (size) {
      case 'small':
        return 'px-2 py-1 sm:px-3 sm:py-1.5 text-[12px] sm:text-[12px] md:text-[12px] lg:text-[12px] 3xl:text-lg 4xl:text-xl '
      case 'large':
        return 'px-3 py-2 sm:px-4 sm:py-2 text-[14px] sm:text-[12px] md:text-[16px] lg:text-[16px] 2xl:text-[14px] 3xl:text-[28px] 4xl:text-[24px] '
      case 'medium':
      default:
        return 'px-2.5 sm:px-3 sm:py-2.5 md:px-2.5 md:py-2.5 lg:px-2.5 lg:py-2.5 xl:px-2.5 xl:py-2.5 2xl:px-2 2xl:py-2 text-[14px] sm:text-[14px] md:text-[14px] lg:text-[14px] 2xl:text-[15px] 3xl:text-xl 4xl:text-2xl '
    }
  }, [size])

  // Close on outside click (use 'click' so option selection handlers run first)
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t)) return
      if (listRef.current?.contains(t)) return
      if (searchRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [open])

  // Reset search term when dropdown closes
  useEffect(() => {
    if (!open) {
      setSearchTerm('')
    }
  }, [open])

  // Compute dropdown placement and size
  useLayoutEffect(() => {
    computeDropdownMetrics()
    if (!open) return
    window.addEventListener('resize', computeDropdownMetrics)
    window.addEventListener('scroll', computeDropdownMetrics, true)
    return () => {
      window.removeEventListener('resize', computeDropdownMetrics)
      window.removeEventListener('scroll', computeDropdownMetrics, true)
    }
  }, [open, computeDropdownMetrics])

  // Keyboard navigation
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      computeDropdownMetrics()
      setOpen(true)
      setActiveIndex(
        Math.max(
          0,
          filteredOptions.findIndex(o => o.value === value)
        )
      )
      return
    }
    if (!open) return

    if (e.key === 'Escape') {
      e.preventDefault()
      btnRef.current?.focus()
      setOpen(false)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(i => (i + 1) % filteredOptions.length)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(i => (i - 1 + filteredOptions.length) % filteredOptions.length)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const opt = filteredOptions[activeIndex]
      if (opt) handleSelect(opt.value)
      return
    }
  }

  // Check if a specific option is disabled
  const isOptionDisabled = useCallback(
    (optionValue: string) => disabledOptions.includes(optionValue),
    [disabledOptions]
  )

  const handleSelect = (val: string) => {
    if (disabled || isOptionDisabled(val)) return
    onChange(val)
    btnRef.current?.focus()
    setOpen(false)
  }

  return (
    <div className={`relative ${className}`} data-open={open ? 'true' : 'false'}>
      <Button
        ref={btnRef}
        variant={blur === 'high' ? 'outline2' : 'outline2'}
        size='medium'
        className={`w-full min-w-0 justify-between ${sizeClass}`}
        aria-haspopup='listbox'
        aria-expanded={open}
        onClick={() => {
          if (disabled) return
          computeDropdownMetrics()
          setOpen(o => !o)
        }}
        onKeyDown={onKeyDown}
        disabled={disabled}
        title={selected?.label}
      >
        <span className='min-w-0 truncate overflow-left text-left flex-1 text-[12px] text-neutral-500 dark:text-neutral-200'>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={16} strokeWidth={2.25} className={`shrink-0 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} aria-hidden='true' />
      </Button>

      {dropdownPosition &&
        createPortal(
          <AnimatePresence initial={false} mode='popLayout'>
            {open && (
              <motion.div
                ref={listRef}
                role='listbox'
                tabIndex={-1}
                data-ygg-overlay='select-dropdown'
                layout
                className='select-cloud fixed flex flex-col overflow-hidden p-2 backdrop-blur-xl'
                onKeyDown={e => {
                  if (e.key === 'Escape' || e.target === searchRef.current || e.target === listRef.current) onKeyDown(e)
                }}
                initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: dropdownPosition.bottom ? -8 : 8, scale: 0.965 }}
                animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
                exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: dropdownPosition.bottom ? -8 : 8, scale: 0.965 }}
                transition={prefersReducedMotion ? reducedMotionTransition : shellSpringTransition}
                style={{
                  ...dropdownThemeStyle,
                  zIndex: dropdownZIndex,
                  maxHeight: listMaxHeight,
                  top: dropdownPosition.top !== undefined ? `${dropdownPosition.top}px` : undefined,
                  bottom: dropdownPosition.bottom !== undefined ? `${dropdownPosition.bottom}px` : undefined,
                  left: `${dropdownPosition.left}px`,
                  width: `${dropdownPosition.width}px`,
                  transformOrigin: dropdownPosition.bottom ? 'bottom center' : 'top center',
                }}
              >
                <div className='flex min-h-0 flex-1 flex-col gap-1'>
            {filterUI && (
              <div className='px-2 py-1'>
                {filterUI}
              </div>
            )}
            {searchBarVisible && (
              <div className='select-cloud-search mx-1 mb-1 flex shrink-0 items-center gap-2 rounded-full px-3'>
                <Search size={16} strokeWidth={2.25} aria-hidden='true' className='shrink-0' />
                <input
                  ref={searchRef}
                  type='text'
                  value={searchTerm}
                  onChange={e => {
                    setSearchTerm(e.target.value)
                    setActiveIndex(-1)
                  }}
                  aria-label='Search options'
                  placeholder='Search...'
                  className='min-w-0 w-full border-0 bg-transparent py-2.5 text-sm outline-none'
                  autoFocus={!isMobile}
                />
              </div>
            )}
            <div
              className='min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain no-scrollbar'
              style={{ maxHeight: searchBarVisible ? (listMaxHeight || 280) - 50 : listMaxHeight }}
            >
              {filteredOptions.length === 0 ? (
                <div className='select-cloud-empty px-3 py-3 text-sm'>
                  {searchBarVisible && searchTerm.trim() ? 'No matching options' : 'No options'}
                </div>
              ) : (
                filteredOptions.map((opt, idx) => {
                  const isSelected = value === opt.value
                  const modelInfo = modelData?.[opt.value]
                  const optDisabled = isOptionDisabled(opt.value)
                  return (
                    <div key={opt.value} className={`select-cloud-row flex items-center gap-1 rounded-[18px] ${optDisabled ? 'opacity-50' : ''}`} data-selected={isSelected} data-active={idx === activeIndex && !optDisabled}>
                      <button
                        type='button'
                        role='option'
                        aria-selected={isSelected}
                        aria-disabled={optDisabled}
                        onMouseEnter={() => setActiveIndex(idx)}
                        onMouseDown={e => {
                          // Select on mousedown to beat any outside click handlers and avoid losing the event
                          e.preventDefault()
                          e.stopPropagation()
                          if (!optDisabled) handleSelect(opt.value)
                        }}
                        onClick={e => {
                          e.preventDefault()
                          e.stopPropagation()
                          if (!optDisabled) handleSelect(opt.value)
                        }}
                        className={`select-cloud-option flex min-w-0 flex-1 items-center gap-2 rounded-[18px] px-3 py-2.5 text-left text-sm ${isSelected ? 'font-medium' : 'font-normal'} ${optDisabled ? 'cursor-not-allowed' : ''}`}
                        title={optDisabled ? 'Upgrade to access this model' : undefined}
                      >
                        <span className='min-w-0 flex-1 line-clamp-3 break-words'>{opt.label}</span>
                        {optDisabled ? <LockKeyhole size={14} aria-hidden='true' className='shrink-0' /> : isSelected && <Check size={16} strokeWidth={2.25} aria-hidden='true' className='shrink-0' />}
                      </button>
                      {modelInfo && (
                        <>
                          <button
                            type='button'
                            onClick={e => {
                              e.preventDefault()
                              e.stopPropagation()
                              toggleFavorite(opt.value)
                            }}
                            className='select-cloud-icon mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full'
                            aria-label={isFavorite(opt.value) ? 'Remove from favorites' : 'Add to favorites'}
                            title={isFavorite(opt.value) ? 'Remove from favorites' : 'Add to favorites'}
                            aria-pressed={isFavorite(opt.value)}
                          >
                            <Star size={16} strokeWidth={2.25} fill={isFavorite(opt.value) ? 'currentColor' : 'none'} aria-hidden='true' />
                          </button>
                          <button
                            type='button'
                            onClick={e => {
                              e.preventDefault()
                              e.stopPropagation()
                              setSelectedModelForInfo(modelInfo)
                              setShowModelInfo(true)
                            }}
                            className='select-cloud-icon mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full'
                            aria-label='View model details'
                            title='View model details'
                          >
                            <MoreVertical size={16} strokeWidth={2.25} aria-hidden='true' />
                          </button>
                        </>
                      )}
                    </div>
                  )
                })
              )}
            </div>
            {/* View All Models button */}
            {showExpandButton && allFilteredCount > DROPDOWN_LIMIT && (
              <div className='select-cloud-footer mt-1 rounded-[18px] p-1'>
                <button
                  type='button'
                  className='select-cloud-option flex w-full items-center justify-center gap-2 rounded-full px-3 py-2.5 text-sm'
                  onClick={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    onExpandClick?.()
                    setOpen(false)
                  }}
                >
                  <Expand size={16} strokeWidth={2.25} aria-hidden='true' />
                  <span>View all models ({allFilteredCount})</span>
                </button>
              </div>
            )}
            {footerContent && (
              <div className='select-cloud-footer mt-1 rounded-[18px] p-1'>
                {footerContent}
              </div>
            )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body
        )}

      <ModelInfoModal
        model={selectedModelForInfo}
        provider={modelProvider}
        isOpen={showModelInfo}
        onClose={() => setShowModelInfo(false)}
      />
    </div>
  )
}
