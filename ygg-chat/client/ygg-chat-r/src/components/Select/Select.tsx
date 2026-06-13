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
      if (opt) {
        onChange(opt.value)
        setOpen(false)
      }
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
        <i className={`bx bx-chevron-down shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden='true' />
      </Button>

      {open &&
        dropdownPosition &&
        createPortal(
          <div
            ref={listRef}
            role='listbox'
            tabIndex={-1}
            className={`fixed rounded-2xl overflow-hidden border border-neutral-200 dark:border-0 dark:border-neutral-700 bg-white/50 dark:bg-transparent flex flex-col`}
            style={{
              zIndex: dropdownZIndex,
              maxHeight: listMaxHeight,
              top: dropdownPosition.top !== undefined ? `${dropdownPosition.top}px` : undefined,
              bottom: dropdownPosition.bottom !== undefined ? `${dropdownPosition.bottom}px` : undefined,
              left: `${dropdownPosition.left}px`,
              width: `${dropdownPosition.width}px`,
            }}
          >
            {filterUI && (
              <div className='px-2 py-2 border-b acrylic-ultra-light-nb-2 dark:bg-transparent border-neutral-200 dark:border-neutral-900'>
                {filterUI}
              </div>
            )}
            {searchBarVisible && (
              <div className='px-2 py-2 border-b acrylic-ultra-light-nb-2 dark:bg-transparent border-neutral-200 dark:border-neutral-900'>
                <input
                  ref={searchRef}
                  type='text'
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  placeholder='Search...'
                  className='w-full rounded-lg px-1 py-1.5 text-[12px] sm:text-[12px] md:text-[12px] lg:text-[14px] 2xl:text-[16px] 3xl:text-[18px] 4xl:text-[22px]rounded border-neutral-300 dark:border-neutral-900 bg-transparent dark:bg-transparent text-stone-800 dark:text-stone-100 focus:outline-none focus:ring-1 focus:ring-neutral-300 dark:focus:ring-2 dark:focus:ring-neutral-800 dark:border-0'
                  autoFocus={!isMobile}
                />
              </div>
            )}
            <div
              className={`flex-1 min-h-0 overflow-y-scroll no-scrollbar ${blur === 'high' ? 'acrylic-medium' : 'acrylic-ultra-light-nb-2'}`}
              style={{ maxHeight: searchBarVisible ? (listMaxHeight || 280) - 50 : listMaxHeight }}
            >
              {filteredOptions.length === 0 ? (
                <div className='px-3 py-2 text-[13px] sm:text-[13px] md:text-[13px] lg:text-[12px] 2xl:text-[14px] 3xl:text-[16px] 4xl:text-[20px] text-neutral-500 dark:text-neutral-400'>
                  {searchBarVisible && searchTerm.trim() ? 'No matching options' : 'No options'}
                </div>
              ) : (
                filteredOptions.map((opt, idx) => {
                  const isSelected = value === opt.value
                  const modelInfo = modelData?.[opt.value]
                  const optDisabled = isOptionDisabled(opt.value)
                  return (
                    <div key={opt.value} className={`flex items-center gap-0 ${optDisabled ? 'opacity-50' : ''}`}>
                      <Button
                        variant='outline2'
                        size='small'
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
                        onClick={() => !optDisabled && handleSelect(opt.value)}
                        className={`flex-1 hover:scale-103 transition-all line-clamp-3 justify-start text-left text-[13px] sm:text-[13px] md:text-[13px] lg:text-[14px] 2xl:text-[14px] 3xl:text-[14px] 4xl:text-[14px] ${isSelected ? 'font-medium' : ''} ${optDisabled ? 'cursor-not-allowed' : 'hover:bg-neutral-200'}`}
                        title={optDisabled ? 'Upgrade to access this model' : undefined}
                      >
                        {opt.label}
                        {optDisabled && <i className='bx bx-lock-alt ml-1 text-xs' aria-hidden='true' />}
                      </Button>
                      {modelInfo && (
                        <>
                          <button
                            type='button'
                            onClick={e => {
                              e.preventDefault()
                              e.stopPropagation()
                              toggleFavorite(opt.value)
                            }}
                            className='px-2 py-2 hover:bg-neutral-200 dark:hover:bg-neutral-700/20 transition-colors rounded-lg'
                            aria-label={isFavorite(opt.value) ? 'Remove from favorites' : 'Add to favorites'}
                          >
                            <i
                              className={`bx ${isFavorite(opt.value) ? 'bxs-star' : 'bx-star'} text-neutral-600 dark:text-neutral-300`}
                            />
                          </button>
                          <button
                            type='button'
                            onClick={e => {
                              e.preventDefault()
                              e.stopPropagation()
                              setSelectedModelForInfo(modelInfo)
                              setShowModelInfo(true)
                            }}
                            className='px-2 py-2 hover:bg-neutral-200 dark:hover:bg-neutral-700/20 transition-colors rounded-lg'
                            aria-label='View model details'
                          >
                            <i className='bx bx-dots-vertical-rounded text-neutral-600 dark:text-neutral-300' />
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
              <div className='acrylic border-t border-neutral-200 dark:border-neutral-700 dark:bg-transparent'>
                <Button
                  variant='outline2'
                  size='medium'
                  className='w-full'
                  onClick={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    onExpandClick?.()
                    setOpen(false)
                  }}
                >
                  <i className='bx bx-expand-alt mr-1' />
                  <div className='text-[13px] sm:text-[13px] md:text-[13px] lg:text-[14px] 2xl:text-[16px] 3xl:text-[18px] 4xl:text-[20px] text-neutral-500 dark:text-neutral-200'>
                    View All Models ({allFilteredCount})
                  </div>
                </Button>
              </div>
            )}
            {footerContent && (
              <div className='border-t border-neutral-200 dark:border-neutral-700 acrylic-medium dark:bg-transparent'>
                {footerContent}
              </div>
            )}
          </div>,
          document.body
        )}

      <ModelInfoModal model={selectedModelForInfo} isOpen={showModelInfo} onClose={() => setShowModelInfo(false)} />
    </div>
  )
}
