import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Maximize2, Minus, Plus, RotateCcw, Scan, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { motionState, useMotionPreferences } from '../motion'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'
import {
  MERMAID_MAX_SCALE,
  MERMAID_MIN_SCALE,
  centerMermaidAtScale,
  fitMermaidToViewport,
  zoomMermaidAtPoint,
  type MermaidSize,
  type MermaidViewTransform,
} from './mermaidViewport'

interface MermaidDiagramProps {
  chart: string
  className?: string
}

interface PanGesture {
  pointerId: number
  clientX: number
  clientY: number
}

const defaultDiagramSize: MermaidSize = { width: 800, height: 600 }
const defaultTransform: MermaidViewTransform = { scale: 1, x: 0, y: 0 }

const iconButtonClass =
  'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/60 text-neutral-600 backdrop-blur-xl transition-[background-color,color,transform,opacity] duration-150 hover:bg-white hover:text-neutral-950 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 disabled:cursor-not-allowed disabled:opacity-35 dark:bg-black/30 dark:text-neutral-300 dark:hover:bg-white/10 dark:hover:text-white dark:focus-visible:ring-orange-400/70'

const readDiagramSize = (svg: string): MermaidSize => {
  try {
    const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
    const viewBox = root.getAttribute('viewBox')?.trim().split(/[ ,]+/).map(Number)
    if (viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
      return { width: viewBox[2], height: viewBox[3] }
    }

    const width = Number.parseFloat(root.getAttribute('width') ?? '')
    const height = Number.parseFloat(root.getAttribute('height') ?? '')
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) return { width, height }
  } catch {
    // Mermaid normally supplies a viewBox; retain a usable fallback if it does not.
  }
  return defaultDiagramSize
}

/** Renders a fenced `mermaid` code block without enabling raw HTML in Markdown. */
export const MermaidDiagram: React.FC<MermaidDiagramProps> = ({ chart, className = '' }) => {
  const reactId = useId()
  const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const openButtonRef = useRef<HTMLButtonElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const panGestureRef = useRef<PanGesture | null>(null)
  const [renderedSvg, setRenderedSvg] = useState('')
  const [diagramSize, setDiagramSize] = useState<MermaidSize>(defaultDiagramSize)
  const [error, setError] = useState<string | null>(null)
  const [themeRevision, setThemeRevision] = useState(0)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const [transform, setTransform] = useState<MermaidViewTransform>(defaultTransform)
  const shouldReduceMotion = useReducedMotion()
  const motionPreferences = useMotionPreferences(shouldReduceMotion)
  const { theme: customTheme, enabled: customThemeEnabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()

  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(records => {
      if (records.some(record => record.attributeName === 'class')) setThemeRevision(value => value + 1)
    })
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    setRenderedSvg('')
    setError(null)
    if (!chart.trim()) return

    void import('mermaid')
      .then(async ({ default: mermaid }) => {
        const darkMode = document.documentElement.classList.contains('dark')
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          theme: darkMode ? 'dark' : 'default',
        })
        const { svg } = await mermaid.render(renderId, chart)
        if (cancelled) return
        setDiagramSize(readDiagramSize(svg))
        setRenderedSvg(svg)
      })
      .catch(reason => {
        if (cancelled) return
        setRenderedSvg('')
        setError(reason instanceof Error ? reason.message : 'Unable to render Mermaid diagram')
      })

    return () => {
      cancelled = true
    }
  }, [chart, renderId, themeRevision])

  const getViewportSize = useCallback((): MermaidSize | null => {
    const viewport = viewportRef.current
    if (!viewport) return null
    return { width: viewport.clientWidth, height: viewport.clientHeight }
  }, [])

  const fitToView = useCallback(() => {
    const viewport = getViewportSize()
    if (!viewport) return
    setTransform(fitMermaidToViewport(viewport, diagramSize))
  }, [diagramSize, getViewportSize])

  const resetView = useCallback(() => {
    const viewport = getViewportSize()
    if (!viewport) return
    setTransform(centerMermaidAtScale(viewport, diagramSize, 1))
  }, [diagramSize, getViewportSize])

  const zoomAtViewportCenter = useCallback(
    (factor: number) => {
      const viewport = getViewportSize()
      if (!viewport) return
      const point = { x: viewport.width / 2, y: viewport.height / 2 }
      setTransform(current => zoomMermaidAtPoint(current, current.scale * factor, point))
    },
    [getViewportSize]
  )

  const closeFullscreen = useCallback(() => {
    panGestureRef.current = null
    setIsPanning(false)
    setIsFullscreen(false)
    window.requestAnimationFrame(() => openButtonRef.current?.focus())
  }, [])

  useEffect(() => {
    if (!isFullscreen) return

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const frame = window.requestAnimationFrame(() => {
      fitToView()
      closeButtonRef.current?.focus()
    })

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeFullscreen()
        return
      }

      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    // Capture keeps Escape from also closing an underlying fullscreen plan dialog.
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', handleKeyDown, true)
      document.body.style.overflow = previousOverflow
    }
  }, [closeFullscreen, fitToView, isFullscreen])

  const handleWheel = useCallback((event: WheelEvent) => {
    event.preventDefault()
    const viewport = viewportRef.current
    if (!viewport) return
    const rect = viewport.getBoundingClientRect()
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    const deltaPixels = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * rect.height : event.deltaY
    const factor = Math.exp(-deltaPixels * 0.001)
    setTransform(current => zoomMermaidAtPoint(current, current.scale * factor, point))
  }, [])

  useEffect(() => {
    if (!isFullscreen) return
    const viewport = viewportRef.current
    if (!viewport) return

    // A native non-passive listener is required so wheel zoom reliably prevents page/plan scrolling.
    viewport.addEventListener('wheel', handleWheel, { passive: false })
    window.addEventListener('resize', fitToView)
    return () => {
      viewport.removeEventListener('wheel', handleWheel)
      window.removeEventListener('resize', fitToView)
    }
  }, [fitToView, handleWheel, isFullscreen])

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    if (event.target instanceof Element && event.target.closest('a, button')) return
    panGestureRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
    setIsPanning(true)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = panGestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const deltaX = event.clientX - gesture.clientX
    const deltaY = event.clientY - gesture.clientY
    gesture.clientX = event.clientX
    gesture.clientY = event.clientY
    setTransform(current => ({ ...current, x: current.x + deltaX, y: current.y + deltaY }))
  }

  const finishPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (panGestureRef.current?.pointerId !== event.pointerId) return
    panGestureRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setIsPanning(false)
  }

  const handleViewportKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const panStep = event.shiftKey ? 100 : 40
    const offsets: Partial<Record<string, { x: number; y: number }>> = {
      ArrowLeft: { x: panStep, y: 0 },
      ArrowRight: { x: -panStep, y: 0 },
      ArrowUp: { x: 0, y: panStep },
      ArrowDown: { x: 0, y: -panStep },
    }
    const offset = offsets[event.key]
    if (offset) {
      event.preventDefault()
      setTransform(current => ({ ...current, x: current.x + offset.x, y: current.y + offset.y }))
    }
  }

  if (!chart.trim()) return null

  if (error) {
    return (
      <div className={`my-3 overflow-hidden rounded-xl bg-red-50/70 dark:bg-red-950/20 ${className}`}>
        <div className='px-3 py-2 text-xs text-red-700 dark:text-red-300' role='alert'>
          Mermaid diagram could not be rendered. Showing source instead.
        </div>
        <pre className='thin-scrollbar m-0 overflow-auto bg-transparent px-3 py-2.5 text-[0.85em] leading-[1.5] text-neutral-700 dark:text-neutral-300'>
          <code>{chart}</code>
        </pre>
      </div>
    )
  }

  const modalSurfaceStyle: React.CSSProperties | undefined = customThemeEnabled
    ? {
        backgroundColor: getThemeModeColor(customTheme.colors.settingsCustomThemesCardBg, isDarkMode),
        color: getThemeModeColor(customTheme.colors.toolJobsPrimaryText, isDarkMode),
      }
    : undefined
  const toolbarStyle: React.CSSProperties | undefined = customThemeEnabled
    ? {
        backgroundColor: getThemeModeColor(customTheme.colors.settingsCustomThemesButtonBg, isDarkMode),
        color: getThemeModeColor(customTheme.colors.settingsCustomThemesButtonText, isDarkMode),
      }
    : undefined

  const fullscreenModal =
    typeof document !== 'undefined'
      ? createPortal(
          <AnimatePresence>
            {isFullscreen && renderedSvg && (
              <motion.div
                key='mermaid-fullscreen'
                className='fixed inset-0 z-[1400] flex items-center justify-center bg-black/35 p-3 backdrop-blur-sm sm:p-6'
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={motionPreferences.feedbackTransition}
                onMouseDown={event => {
                  event.stopPropagation()
                  if (event.target === event.currentTarget) closeFullscreen()
                }}
              >
                <motion.div
                  ref={dialogRef}
                  role='dialog'
                  aria-modal='true'
                  aria-label='Mermaid diagram viewer'
                  className='relative flex h-[calc(100vh-1.5rem)] w-full flex-col overflow-hidden rounded-2xl bg-white/95 backdrop-blur-xl dark:bg-yBlack-900/95 sm:h-[calc(100vh-3rem)]'
                  style={modalSurfaceStyle}
                  {...motionState(motionPreferences.reducedMotion, 8)}
                  transition={motionPreferences.shellTransition}
                  onMouseDown={event => event.stopPropagation()}
                >
                  <div className='flex min-w-0 items-center justify-between gap-3 px-4 py-3 sm:px-6'>
                    <div className='min-w-0'>
                      <h2 className='truncate text-sm font-semibold'>Mermaid diagram</h2>
                      <p className='mt-0.5 text-[10px] text-neutral-500 dark:text-neutral-400'>
                        Drag to pan · Scroll to zoom
                      </p>
                    </div>
                    <button
                      ref={closeButtonRef}
                      type='button'
                      onClick={closeFullscreen}
                      className={iconButtonClass}
                      title='Close diagram viewer'
                      aria-label='Close diagram viewer'
                    >
                      <X size={18} strokeWidth={2.25} aria-hidden='true' />
                    </button>
                  </div>

                  <div
                    ref={viewportRef}
                    className={`relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-neutral-100/55 dark:bg-black/15 ${isPanning ? 'cursor-grabbing' : 'cursor-grab'}`}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={finishPan}
                    onPointerCancel={finishPan}
                    onDoubleClick={fitToView}
                    onKeyDown={handleViewportKeyDown}
                    tabIndex={0}
                    role='region'
                    aria-label='Pan and zoom diagram canvas. Drag or use arrow keys to pan; scroll to zoom.'
                  >
                    <div
                      className='absolute left-0 top-0 will-change-transform [&_svg]:block [&_svg]:h-full [&_svg]:w-full [&_svg]:max-w-none'
                      style={{
                        width: `${diagramSize.width}px`,
                        height: `${diagramSize.height}px`,
                        transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
                        transformOrigin: '0 0',
                      }}
                      dangerouslySetInnerHTML={{ __html: renderedSvg }}
                    />
                  </div>

                  <div className='pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4 sm:bottom-5'>
                    <div
                      className='pointer-events-auto flex items-center gap-1 rounded-full bg-white/75 p-1.5 backdrop-blur-xl dark:bg-black/45 sm:gap-2'
                      style={toolbarStyle}
                      role='toolbar'
                      aria-label='Diagram viewer controls'
                    >
                      <button
                        type='button'
                        className={iconButtonClass}
                        onClick={() => zoomAtViewportCenter(1 / 1.2)}
                        disabled={transform.scale <= MERMAID_MIN_SCALE}
                        title='Zoom out'
                        aria-label='Zoom out'
                      >
                        <Minus size={17} strokeWidth={2.25} aria-hidden='true' />
                      </button>
                      <span className='w-12 text-center text-[10px] tabular-nums text-neutral-500 dark:text-neutral-300'>
                        {Math.round(transform.scale * 100)}%
                      </span>
                      <button
                        type='button'
                        className={iconButtonClass}
                        onClick={() => zoomAtViewportCenter(1.2)}
                        disabled={transform.scale >= MERMAID_MAX_SCALE}
                        title='Zoom in'
                        aria-label='Zoom in'
                      >
                        <Plus size={17} strokeWidth={2.25} aria-hidden='true' />
                      </button>
                      <div className='mx-0.5 h-5 w-px bg-neutral-300/60 dark:bg-white/10' aria-hidden='true' />
                      <button type='button' className={iconButtonClass} onClick={fitToView} title='Fit diagram to view' aria-label='Fit diagram to view'>
                        <Scan size={17} strokeWidth={2.25} aria-hidden='true' />
                      </button>
                      <button type='button' className={iconButtonClass} onClick={resetView} title='Reset to 100%' aria-label='Reset diagram to 100%'>
                        <RotateCcw size={17} strokeWidth={2.25} aria-hidden='true' />
                      </button>
                    </div>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body
        )
      : null

  return (
    <>
      <div
        className={`mermaid-diagram my-3 max-w-full overflow-hidden rounded-xl bg-white/45 dark:bg-black/15 ${className}`}
        aria-label='Mermaid diagram'
      >
        <div className='flex items-center justify-between gap-2 px-3 py-2'>
          <span className='text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-500 dark:text-neutral-400'>
            Diagram
          </span>
          <button
            ref={openButtonRef}
            type='button'
            onClick={() => setIsFullscreen(true)}
            disabled={!renderedSvg}
            className='inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-1 text-[10px] font-medium text-neutral-600 transition-[background-color,color,transform] duration-150 hover:bg-neutral-200 hover:text-neutral-900 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 disabled:opacity-40 dark:bg-white/5 dark:text-neutral-300 dark:hover:bg-white/10 dark:hover:text-white dark:focus-visible:ring-orange-400/70'
            title='Open interactive diagram viewer'
            aria-label='Open interactive diagram viewer'
          >
            <Maximize2 size={13} strokeWidth={2.25} aria-hidden='true' />
            Open viewer
          </button>
        </div>
        <div className='thin-scrollbar max-h-[60vh] min-h-32 overflow-auto px-3 pb-3 text-center'>
          {renderedSvg && !isFullscreen ? (
            <div
              className='inline-block min-w-fit [&_svg]:block [&_svg]:h-auto [&_svg]:max-w-none'
              style={{ width: `${diagramSize.width}px` }}
              dangerouslySetInnerHTML={{ __html: renderedSvg }}
            />
          ) : !isFullscreen ? (
            <div className='flex min-h-32 items-center justify-center text-xs text-neutral-400 dark:text-neutral-500' role='status'>
              Rendering diagram…
            </div>
          ) : null}
        </div>
      </div>
      {fullscreenModal}
    </>
  )
}

export default MermaidDiagram
