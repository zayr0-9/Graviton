import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getAssetPath } from '../../utils/assetPath'
import { contentSpringTransition, reducedMotionTransition, shellSpringTransition } from '../motion'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'

export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh'

type ReasoningLevelControlProps = {
  supported: boolean
  level: ReasoningLevel
  onLevelChange: (level: ReasoningLevel) => void
}

const LEVELS: Array<{ value: ReasoningLevel; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
]

const POPOVER_WIDTH = 96
const SLIDER_HEIGHT = 176
const SLIDER_TOP_GAP = 16
const SLIDER_BOTTOM_OFFSET = 12 + 40 + SLIDER_TOP_GAP + SLIDER_HEIGHT
const FIZZ_PARTICLES = Array.from({ length: 16 }, (_, index) => ({
  id: index,
  left: 12 + ((index * 37) % 76),
  size: 1.5 + (index % 3),
  duration: 1.25 + (index % 5) * 0.24,
  delay: -(index % 7) * 0.31,
}))

const getLevelIndex = (level: ReasoningLevel) => Math.max(0, LEVELS.findIndex(option => option.value === level))
const getLevelLabel = (level: ReasoningLevel) => LEVELS[getLevelIndex(level)]?.label ?? 'Off'

export const ReasoningLevelControl = ({ supported, level, onLevelChange }: ReasoningLevelControlProps) => {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number; transformOrigin: string } | null>(null)
  const [dragLevel, setDragLevel] = useState<ReasoningLevel | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const sliderRef = useRef<HTMLDivElement | null>(null)
  const shouldReduceMotion = useReducedMotion()
  const reducedMotion = shouldReduceMotion ?? false
  const { theme, enabled: customThemeEnabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()

  const displayedLevel = dragLevel ?? level
  const levelIndex = getLevelIndex(displayedLevel)
  const fillPercent = levelIndex * 25
  const activeColor = customThemeEnabled
    ? getThemeModeColor(theme.colors.composerToggleActiveText, isDarkMode)
    : isDarkMode
      ? '#fb923c'
      : '#2563eb'
  const surfaceColor = customThemeEnabled
    ? getThemeModeColor(theme.colors.settingsCustomThemesInnerCardBg, isDarkMode)
    : undefined
  const textColor = customThemeEnabled
    ? getThemeModeColor(theme.colors.settingsCustomThemesButtonText, isDarkMode)
    : undefined
  const mutedColor = customThemeEnabled
    ? getThemeModeColor(theme.colors.settingsCustomThemesBodyText, isDarkMode)
    : undefined
  const trackColor = customThemeEnabled
    ? getThemeModeColor(theme.colors.settingsCustomThemesBadgeBg, isDarkMode)
    : isDarkMode
      ? 'rgba(255,255,255,0.12)'
      : 'rgba(23,23,23,0.10)'

  const computePosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger || typeof window === 'undefined') return

    const rect = trigger.getBoundingClientRect()
    const width = Math.min(POPOVER_WIDTH, window.innerWidth - 16)
    const triggerCenterX = rect.left + rect.width / 2
    const triggerCenterY = rect.top + rect.height / 2
    const left = Math.min(Math.max(8, triggerCenterX - width / 2), window.innerWidth - width - 8)
    const top = Math.max(8, triggerCenterY - SLIDER_BOTTOM_OFFSET)

    setPosition({ top, left, transformOrigin: 'bottom center' })
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    computePosition()
    window.addEventListener('resize', computePosition)
    window.addEventListener('scroll', computePosition, true)
    return () => {
      window.removeEventListener('resize', computePosition)
      window.removeEventListener('scroll', computePosition, true)
    }
  }, [computePosition, open])

  useEffect(() => {
    if (!supported) setOpen(false)
  }, [supported])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const updateFromPointer = useCallback(
    (clientY: number) => {
      const slider = sliderRef.current
      if (!slider) return
      const rect = slider.getBoundingClientRect()
      const ratio = Math.min(1, Math.max(0, (rect.bottom - clientY) / rect.height))
      const nextLevel = LEVELS[Math.round(ratio * (LEVELS.length - 1))].value
      setDragLevel(nextLevel)
      if (nextLevel !== level) onLevelChange(nextLevel)
    },
    [level, onLevelChange]
  )

  const handleSliderKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = getLevelIndex(level)
    let nextIndex: number | null = null
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') nextIndex = Math.min(LEVELS.length - 1, currentIndex + 1)
    if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') nextIndex = Math.max(0, currentIndex - 1)
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = LEVELS.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    onLevelChange(LEVELS[nextIndex].value)
  }

  const popoverStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!position) return undefined
    return {
      top: position.top,
      left: position.left,
      width: Math.min(POPOVER_WIDTH, typeof window === 'undefined' ? POPOVER_WIDTH : window.innerWidth - 16),
      transformOrigin: position.transformOrigin,
      ...(surfaceColor ? { backgroundColor: surfaceColor } : null),
      ...(textColor ? { color: textColor } : null),
    }
  }, [position, surfaceColor, textColor])

  return (
    <>
      <button
        ref={triggerRef}
        type='button'
        className={`relative flex h-9 w-9 items-center justify-center rounded-full transition-[background-color,color,opacity,transform] duration-150 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 dark:focus-visible:ring-orange-400/70 ${
          open ? 'opacity-0' : ''
        } ${
          supported
            ? 'text-neutral-500 hover:bg-white/10 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-white/5 dark:hover:text-neutral-200'
            : 'cursor-not-allowed text-neutral-300 dark:text-neutral-600'
        }`}
        onClick={() => {
          if (!supported) return
          computePosition()
          setOpen(current => !current)
        }}
        disabled={!supported}
        aria-haspopup='dialog'
        aria-expanded={open}
        aria-label={supported ? `Reasoning level: ${getLevelLabel(level)}` : 'Thinking not supported by this model'}
        title={supported ? `Reasoning: ${getLevelLabel(level)}` : 'Thinking not supported by this model'}
      >
        <img src={getAssetPath(level === 'off' ? 'img/thinkingofflightmode.svg' : 'img/thinkingonlightmode.svg')} alt='' className='h-[22px] w-[22px] dark:hidden' />
        <img src={getAssetPath(level === 'off' ? 'img/thinkingoffdarkmode.svg' : 'img/thinkingondarkmode.svg')} alt='' className='hidden h-[22px] w-[22px] dark:block' />
      </button>

      {position &&
        createPortal(
          <AnimatePresence initial={false}>
            {open && (
              <motion.div
                ref={popoverRef}
                role='dialog'
                aria-label='Reasoning level'
                className='fixed z-[100001] overflow-hidden rounded-2xl bg-white/90 px-3 py-3 backdrop-blur-xl dark:bg-neutral-900/90'
                initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
                animate={reducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
                exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
                transition={reducedMotion ? reducedMotionTransition : shellSpringTransition}
                style={popoverStyle}
              >
                <motion.div initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 6 }} transition={reducedMotion ? reducedMotionTransition : contentSpringTransition}>
                  <div className='h-10 text-center'>
                    <div className='text-[11px] font-semibold text-neutral-900 dark:text-neutral-100' style={textColor ? { color: textColor } : undefined}>Reasoning</div>
                    <div className='text-[10px] text-neutral-500 dark:text-neutral-400' style={mutedColor ? { color: mutedColor } : undefined}>{getLevelLabel(displayedLevel)}</div>
                  </div>
                  <div className='flex justify-center pt-4'>
                    <div
                      ref={sliderRef}
                      role='slider'
                      tabIndex={0}
                      aria-label='Reasoning level'
                      aria-valuemin={0}
                      aria-valuemax={4}
                      aria-valuenow={levelIndex}
                      aria-valuetext={getLevelLabel(displayedLevel)}
                      className='relative h-44 w-12 touch-none cursor-ns-resize select-none focus-visible:outline-none'
                      onKeyDown={handleSliderKeyDown}
                      onPointerDown={event => {
                        event.currentTarget.setPointerCapture(event.pointerId)
                        updateFromPointer(event.clientY)
                      }}
                      onPointerMove={event => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) updateFromPointer(event.clientY)
                      }}
                      onPointerUp={event => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
                        setDragLevel(null)
                      }}
                      onPointerCancel={() => setDragLevel(null)}
                      onLostPointerCapture={() => setDragLevel(null)}
                    >
                      <div aria-hidden='true' className='absolute bottom-0 left-1/2 h-full w-3 -translate-x-1/2 overflow-hidden rounded-full' style={{ backgroundColor: trackColor }}>
                        <motion.div
                          className='absolute bottom-0 w-full overflow-hidden rounded-full'
                          animate={{ height: `${fillPercent}%`, backgroundColor: activeColor }}
                          transition={reducedMotion ? reducedMotionTransition : contentSpringTransition}
                        >
                          {!reducedMotion &&
                            FIZZ_PARTICLES.slice(0, levelIndex * 4).map(particle => (
                              <motion.span
                                key={particle.id}
                                className='absolute bottom-[-8px] rounded-full bg-white'
                                style={{ left: `${particle.left}%`, width: particle.size, height: particle.size }}
                                animate={{ y: [0, -190], opacity: [0, 0.9, 0], scale: [0.7, 1, 0.65] }}
                                transition={{ duration: particle.duration, delay: particle.delay, repeat: Infinity, ease: 'linear' }}
                              />
                            ))}
                        </motion.div>
                      </div>
                      <div
                        aria-hidden='true'
                        className='absolute left-1/2 flex h-8 w-8 -translate-x-1/2 translate-y-1/2 items-center justify-center rounded-full bg-white shadow-md dark:bg-neutral-800'
                        style={{ bottom: `${fillPercent}%` }}
                      >
                        <img draggable={false} src={getAssetPath(displayedLevel === 'off' ? 'img/thinkingofflightmode.svg' : 'img/thinkingonlightmode.svg')} alt='' className='pointer-events-none h-5 w-5 select-none dark:hidden' />
                        <img draggable={false} src={getAssetPath(displayedLevel === 'off' ? 'img/thinkingoffdarkmode.svg' : 'img/thinkingondarkmode.svg')} alt='' className='pointer-events-none hidden h-5 w-5 select-none dark:block' />
                      </div>
                    </div>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body
        )}
    </>
  )
}
