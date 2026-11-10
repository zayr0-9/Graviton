import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'framer-motion'

// Radii mirror the classes the separate surfaces used: rounded-3xl body, rounded-t-xl tab.
const BODY_RADIUS_REM = 1.5
const TAB_RADIUS_REM = 0.75
const FILLET_RADIUS_REM = 0.625
// The old surface drew a CSS outline, which sits fully outside the box. Push the stroke out by half its width to match.
const STROKE_OUTSET = 0.5
const TAB_TRANSITION = { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const }
const EMPTY_PATH = 'M0 0'
const MASK_LAYOUT_STYLE = { maskSize: '100% 100%', WebkitMaskSize: '100% 100%', maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat' } as const

export type ComposerSurfaceGeometry = {
  width: number
  height: number
  tabWidth: number
  tabHeight: number
  rem: number
}

/**
 * One outline for the composer body and the tab on its top-left edge, with a concave
 * fillet where they meet. `progress` 0 is the plain rounded body and 1 is the full tab;
 * every value in between keeps the same commands, so the shape morphs smoothly.
 * Coordinates start at the tab top: the body begins `tabHeight` below.
 */
export function composerSurfacePath(geometry: ComposerSurfaceGeometry, progress: number, outset = 0): string {
  const { width, height, tabHeight, rem } = geometry
  if (width <= 0 || height <= 0) return EMPTY_PATH
  const p = Math.min(1, Math.max(0, progress))
  const bodyRadius = BODY_RADIUS_REM * rem
  const tabRadius = TAB_RADIUS_REM * rem
  const fillet = FILLET_RADIUS_REM * rem

  const left = -outset
  const right = width + outset
  const bodyTop = tabHeight - outset
  const bottom = tabHeight + height + outset
  const top = tabHeight * (1 - p) - outset
  const corner = bodyRadius + outset
  const leftCorner = bodyRadius + (tabRadius - bodyRadius) * p + outset
  const tabCorner = (tabRadius + outset) * p
  const join = Math.max(0, fillet - outset) * p
  const tabRight = Math.min(Math.max(geometry.tabWidth + outset, leftCorner + tabCorner), right - corner - join)

  return [
    `M${left} ${bottom - corner}`,
    `V${top + leftCorner}`,
    `A${leftCorner} ${leftCorner} 0 0 1 ${left + leftCorner} ${top}`,
    `H${tabRight - tabCorner}`,
    `A${tabCorner} ${tabCorner} 0 0 1 ${tabRight} ${top + tabCorner}`,
    `V${bodyTop - join}`,
    `A${join} ${join} 0 0 0 ${tabRight + join} ${bodyTop}`,
    `H${right - corner}`,
    `A${corner} ${corner} 0 0 1 ${right} ${bodyTop + corner}`,
    `V${bottom - corner}`,
    `A${corner} ${corner} 0 0 1 ${right - corner} ${bottom}`,
    `H${left + corner}`,
    `A${corner} ${corner} 0 0 1 ${left} ${bottom - corner}`,
    'Z',
  ].join(' ')
}

/**
 * The shape as a CSS mask for the glass layer. A mask, not `clip-path`: inside a rounded
 * `overflow: hidden` ancestor (the chat pane) Chromium ignores `clip-path` for
 * `backdrop-filter` and blurs the layer's whole bounding box.
 */
export function composerSurfaceMask(geometry: ComposerSurfaceGeometry, progress: number): string {
  const width = geometry.width
  const height = geometry.tabHeight + geometry.height
  if (width <= 0 || height <= 0) return 'linear-gradient(transparent, transparent)'
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}'><path d='${composerSurfacePath(geometry, progress)}'/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

type ComposerSurfaceProps = {
  /** Shown in a tab joined to the top-left edge. Null/false hides the tab. */
  tab?: React.ReactNode
  /** Fill and blur of the glass, drawn once for body and tab. */
  surfaceClassName: string
  /** Stroke color/width for the outline shared by body and tab. */
  strokeClassName: string
  /** Layout of the body content (padding). */
  className?: string
  children: React.ReactNode
}

/**
 * Composer glass surface. The body and its tab are one masked layer with one outline,
 * so overlapping translucent pieces cannot darken the join or blur differently.
 * The tab sits above the body (`bottom-full`) and never changes the body's measured height.
 */
export function ComposerSurface({ tab, surfaceClassName, strokeClassName, className = '', children }: ComposerSurfaceProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const tabRef = useRef<HTMLDivElement | null>(null)
  const reduceMotion = useReducedMotion()
  const visible = tab != null && tab !== false
  // Keep the last tab content mounted while the shape folds back into the body.
  const lastTabRef = useRef<React.ReactNode>(null)
  if (visible) lastTabRef.current = tab
  const [present, setPresent] = useState(visible)

  const geometry = useMotionValue<ComposerSurfaceGeometry>({ width: 0, height: 0, tabWidth: 0, tabHeight: 0, rem: 16 })
  const progress = useMotionValue(visible ? 1 : 0)
  // Computed transforms re-run whenever a value read through `.get()` changes.
  const maskImage = useTransform(() => composerSurfaceMask(geometry.get(), progress.get()))
  const strokePath = useTransform(() => composerSurfacePath(geometry.get(), progress.get(), STROKE_OUTSET))
  const layerTop = useTransform(geometry, g => -g.tabHeight)
  const layerHeight = useTransform(geometry, g => g.tabHeight + g.height)

  useEffect(() => {
    if (visible) setPresent(true)
    const controls = animate(progress, visible ? 1 : 0, {
      ...(reduceMotion ? { duration: 0 } : TAB_TRANSITION),
      onComplete: visible ? undefined : () => setPresent(false),
    })
    return () => controls.stop()
  }, [progress, reduceMotion, visible])

  const showTab = visible || present
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const measure = () => {
      const tabElement = tabRef.current
      const rem = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16
      geometry.set({
        width: body.offsetWidth,
        height: body.offsetHeight,
        tabWidth: tabElement?.offsetWidth ?? 0,
        tabHeight: tabElement?.offsetHeight ?? geometry.get().tabHeight,
        rem,
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    if (tabRef.current) observer.observe(tabRef.current)
    return () => observer.disconnect()
  }, [geometry, showTab])

  return (
    <div ref={bodyRef} className={`relative z-10 ${className}`}>
      <motion.div
        aria-hidden='true'
        className={`pointer-events-none absolute inset-x-0 -z-10 ${surfaceClassName}`}
        style={{ top: layerTop, height: layerHeight, maskImage, WebkitMaskImage: maskImage, ...MASK_LAYOUT_STYLE }}
      />
      <motion.svg
        aria-hidden='true'
        className='pointer-events-none absolute inset-x-0 -z-10 w-full overflow-visible'
        style={{ top: layerTop, height: layerHeight }}
      >
        <motion.path d={strokePath} fill='none' className={`transition-[stroke] duration-300 ${strokeClassName}`} />
      </motion.svg>
      {showTab && (
        <motion.div
          ref={tabRef}
          className={`absolute bottom-full left-0 flex items-center gap-3 px-2 py-1.5 ${visible ? '' : 'pointer-events-none'}`}
          style={{ opacity: progress }}
        >
          {visible ? tab : lastTabRef.current}
        </motion.div>
      )}
      {children}
    </div>
  )
}
