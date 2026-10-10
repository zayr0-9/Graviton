import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { MoreHorizontal } from 'lucide-react'
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'
import { getActionPopoverPosition } from './actionPopoverPosition'
import { isActionPopoverInsideClick } from './actionPopoverDismissal'
import './actionPopover.css'

interface ActionPopoverProps {
  children: React.ReactNode
  isActive?: boolean
  footer?: React.ReactNode
}

type PopoverPosition = ReturnType<typeof getActionPopoverPosition>
const popoverEase = [0.22, 1, 0.36, 1] as const
const actionRowClass = 'action-cloud-actions'
const footerClass = 'action-cloud-footer'

export const ActionPopover: React.FC<ActionPopoverProps> = ({ children, isActive = false, footer }) => {
  const [open, setOpen] = useState(false)
  const shouldReduceMotion = useReducedMotion()
  const prefersReducedMotion = shouldReduceMotion ?? false
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [popoverPosition, setPopoverPosition] = useState<PopoverPosition | null>(null)
  const { theme: customTheme, enabled: customThemeEnabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()
  const popoverSurfaceStyle: React.CSSProperties | undefined = customThemeEnabled
    ? {
        backgroundColor: getThemeModeColor(customTheme.colors.settingsCustomThemesCardBg, isDarkMode),
        color: getThemeModeColor(customTheme.colors.toolJobsPrimaryText, isDarkMode),
      }
    : undefined
  const cloudThemeStyle = customThemeEnabled ? {
    '--cloud-field': getThemeModeColor(customTheme.colors.settingsCustomThemesInnerCardBg, isDarkMode),
    '--cloud-button': getThemeModeColor(customTheme.colors.settingsCustomThemesButtonBg, isDarkMode),
    '--cloud-muted': getThemeModeColor(customTheme.colors.toolJobsMutedText, isDarkMode),
    '--cloud-button-text': getThemeModeColor(customTheme.colors.settingsCustomThemesButtonText, isDarkMode),
    '--cloud-active-bg': getThemeModeColor(customTheme.colors.composerToggleActiveBg, isDarkMode),
    '--cloud-active-text': getThemeModeColor(customTheme.colors.composerToggleActiveText, isDarkMode),
  } as React.CSSProperties : undefined
  const triggerStyle: React.CSSProperties | undefined = customThemeEnabled
    ? isActive || open
      ? {
          backgroundColor: getThemeModeColor(customTheme.colors.composerToggleActiveBg, isDarkMode),
          color: getThemeModeColor(customTheme.colors.composerToggleActiveText, isDarkMode),
        }
      : {
          backgroundColor: getThemeModeColor(customTheme.colors.settingsCustomThemesButtonBg, isDarkMode),
          color: getThemeModeColor(customTheme.colors.settingsCustomThemesButtonText, isDarkMode),
        }
    : undefined

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (isActionPopoverInsideClick(e, btnRef.current, popoverRef.current)) return
      setOpen(false)
    }
    // Capture before React handlers update state or replace animated button content.
    document.addEventListener('click', onDocClick, true)
    return () => document.removeEventListener('click', onDocClick, true)
  }, [open])

  // Close on Escape key
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[data-ygg-overlay="select-dropdown"]')) {
        setOpen(false)
        btnRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  // Position before paint; the visible shell is also the measurement node.
  useLayoutEffect(() => {
    if (open) {
      const btn = btnRef.current
      if (!btn || typeof window === 'undefined') return
      const rect = btn.getBoundingClientRect()

      // Initial position (will be corrected after measurement)
      setPopoverPosition({
        ...getActionPopoverPosition(rect, Math.min(336, window.innerWidth - 16), window.innerWidth, window.innerHeight),
        measured: false,
      })
    }
  }, [open])

  // Use layoutEffect to measure and reposition synchronously before paint
  useLayoutEffect(() => {
    if (!open || !popoverPosition || popoverPosition.measured) return

    const popover = popoverRef.current
    const btn = btnRef.current
    if (!popover || !btn || typeof window === 'undefined') return

    setPopoverPosition(getActionPopoverPosition(btn.getBoundingClientRect(), popover.offsetWidth, window.innerWidth, window.innerHeight))
  }, [open, popoverPosition])

  // Keep the popover anchored above its trigger when content expands or collapses.
  useLayoutEffect(() => {
    if (!open || !popoverPosition?.measured) return

    const recompute = () => {
      const popover = popoverRef.current
      const btn = btnRef.current
      if (!popover || !btn || typeof window === 'undefined') return

      const next = getActionPopoverPosition(btn.getBoundingClientRect(), popover.offsetWidth, window.innerWidth, window.innerHeight)
      setPopoverPosition(prev =>
        prev?.top === next.top && prev.bottom === next.bottom && prev.left === next.left && prev.maxHeight === next.maxHeight
          ? prev
          : next
      )
    }

    const resizeObserver = new ResizeObserver(recompute)
    if (popoverRef.current) resizeObserver.observe(popoverRef.current)
    recompute()
    window.addEventListener('resize', recompute)
    window.addEventListener('scroll', recompute, true)
    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', recompute)
      window.removeEventListener('scroll', recompute, true)
    }
  }, [open, popoverPosition?.measured])

  const handleToggle = useCallback(() => {
    setOpen(o => !o)
  }, [])

  return (
    <div className='relative'>
      <button
        ref={btnRef}
        type='button'
        onClick={handleToggle}
        className={`group/action-popover relative flex h-9 w-9 items-center justify-center rounded-full bg-white/80 text-stone-700 backdrop-blur-xl transition-[background-color,color,transform] duration-150 motion-reduce:transition-none hover:-translate-y-0.5 hover:scale-105 hover:bg-white hover:text-stone-950 active:translate-y-0 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-50 dark:bg-yBlack-900/80 dark:text-stone-200 dark:hover:bg-neutral-900 dark:hover:text-white dark:focus-visible:ring-orange-400/70 dark:focus-visible:ring-offset-yBlack-900 ${
          isActive || open
            ? 'bg-blue-50 text-blue-700 hover:bg-blue-100 hover:text-blue-800 dark:bg-orange-500/15 dark:text-orange-100 dark:hover:bg-orange-500/25 dark:hover:text-orange-50'
            : ''
        }`}
        style={triggerStyle}
        title='Toggle options'
        aria-label='Toggle chat options'
        aria-haspopup='true'
        aria-expanded={open}
        aria-pressed={open}
      >
        <MoreHorizontal
          size={18}
          strokeWidth={2.25}
          className='transition-transform duration-200 group-hover/action-popover:scale-110'
          aria-hidden='true'
        />
      </button>

      {popoverPosition &&
        createPortal(
          <>
            <AnimatePresence initial={false}>
              {open && (
                <motion.div
                  ref={popoverRef}
                  key='action-popover-shell'
                  className='action-cloud fixed z-[1000]'
                  role='dialog'
                  data-ygg-overlay='action-popover'
                  onClick={event => event.stopPropagation()}
                  onMouseDown={event => event.stopPropagation()}
                  aria-label='Chat options'
                  initial={{ opacity: 0, scale: prefersReducedMotion ? 1 : 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: prefersReducedMotion ? 1 : 0.99, transition: { duration: prefersReducedMotion ? 0 : 0.15, ease: popoverEase } }}
                  transition={{ duration: prefersReducedMotion ? 0 : 0.25, ease: popoverEase }}
                  style={{
                    top: popoverPosition.top,
                    bottom: popoverPosition.bottom,
                    maxHeight: popoverPosition.maxHeight,
                    ...cloudThemeStyle,
                    left: `${popoverPosition.left}px`,
                    ...popoverSurfaceStyle,
                    transformOrigin: popoverPosition.bottom !== undefined ? 'bottom center' : 'top center',
                  }}
                >
                  <div>
                    <div className={actionRowClass}>
                      {children}
                    </div>
                    {footer && (
                      <div className={footerClass}>
                        {footer}
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </>,
          document.body
        )}
    </div>
  )
}
