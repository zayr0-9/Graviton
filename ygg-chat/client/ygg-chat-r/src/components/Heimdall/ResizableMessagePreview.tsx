import { useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { clampPreviewRect, resizePreviewEdge, type PreviewEdge, type PreviewRect } from './heimdallViewport'

interface Props {
  previewKey: string
  layout: { left: number; top: number; width: number; maxHeight: number }
  dimensions: { width: number; height: number }
  containerRef: RefObject<HTMLDivElement | null>
  cardRef: RefObject<HTMLDivElement | null>
  preferredRef: RefObject<{ width?: number; height?: number } | null>
  draggingRef: RefObject<boolean>
  style?: CSSProperties
  accent: string
  onEnter: () => void
  onLeave: () => void
  children: ReactNode
}

const edges: PreviewEdge[] = ['left', 'right', 'top', 'bottom']
const edgeClasses: Record<PreviewEdge, string> = {
  left: 'left-0 top-4 bottom-4 w-2 cursor-ew-resize',
  right: 'right-0 top-4 bottom-4 w-2 cursor-ew-resize',
  top: 'top-0 left-4 right-4 h-2 cursor-ns-resize',
  bottom: 'bottom-0 left-4 right-4 h-2 cursor-ns-resize',
}
const lineStyles: Record<PreviewEdge, CSSProperties> = {
  left: { left: 0, top: 0, bottom: 0, width: 2 },
  right: { right: 0, top: 0, bottom: 0, width: 2 },
  top: { top: 0, left: 0, right: 0, height: 2 },
  bottom: { bottom: 0, left: 0, right: 0, height: 2 },
}

/** Local geometry keeps pointer frames out of Heimdall's graph render loop. */
export function ResizableMessagePreview(props: Props) {
  const { layout, dimensions, cardRef, containerRef, preferredRef, draggingRef, accent, children, style } = props
  const [manualRect, setManualRect] = useState<PreviewRect | null>(null)
  const [activeEdge, setActiveEdge] = useState<PreviewEdge | null>(null)
  const [hoveredEdge, setHoveredEdge] = useState<PreviewEdge | null>(null)
  const dragRef = useRef<{
    pointerId: number; x: number; y: number; edge: PreviewEdge; start: PreviewRect
    previous: PreviewRect | null; handle: HTMLButtonElement
  } | null>(null)
  const frameRef = useRef<number | null>(null)
  const callbacks = useRef(props)
  callbacks.current = props

  const clearDrag = () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    const drag = dragRef.current
    dragRef.current = null
    draggingRef.current = false
    if (drag?.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId)
  }
  const measure = (): PreviewRect | null => {
    const card = cardRef.current?.getBoundingClientRect()
    const container = containerRef.current
    if (!card || !container) return null
    const bounds = container.getBoundingClientRect()
    return {
      left: card.left - bounds.left - container.clientLeft,
      top: card.top - bounds.top - container.clientTop,
      width: card.width, height: card.height,
    }
  }
  const settleHover = (x?: number, y?: number) => {
    const card = cardRef.current
    const rect = card?.getBoundingClientRect()
    const inside = rect && x !== undefined && y !== undefined
      ? x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      : card?.matches(':hover')
    if (inside || card?.contains(document.activeElement)) callbacks.current.onEnter()
    else callbacks.current.onLeave()
  }
  const cancel = () => {
    const drag = dragRef.current
    if (!drag) return
    clearDrag()
    setManualRect(drag.previous)
    setActiveEdge(null)
    settleHover()
  }

  // New anchors re-dock; panel changes retain the user's position and preference.
  useLayoutEffect(() => {
    setManualRect(null)
    setActiveEdge(null)
    setHoveredEdge(null)
  }, [props.previewKey])

  useLayoutEffect(() => {
    const interrupted = dragRef.current
    if (interrupted) {
      clearDrag()
      setManualRect(interrupted.previous)
      setActiveEdge(null)
      settleHover()
    }
  }, [dimensions.width, dimensions.height])

  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !dragRef.current) return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true); clearDrag() }
  }, [props.previewKey])

  const preferred = preferredRef.current
  // The automatic layout tells us which panel edge the preview is docked to.
  const customLayout = preferred ? clampPreviewRect({
    left: layout.left <= 12 ? layout.left : dimensions.width - 12 - (preferred.width ?? layout.width),
    top: layout.top, width: preferred.width ?? layout.width, height: preferred.height ?? layout.maxHeight,
  }, dimensions) : null
  const saveSize = (next: PreviewRect, edge: PreviewEdge) => {
    preferredRef.current = { ...preferredRef.current,
      ...(edge === 'left' || edge === 'right' ? { width: next.width } : { height: next.height }),
    }
  }
  const rect = manualRect ? clampPreviewRect(manualRect, dimensions) : customLayout
  const reset = () => {
    clearDrag()
    preferredRef.current = null
    setManualRect(null)
    setActiveEdge(null)
  }
  const deltaRect = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current!
    const delta = drag.edge === 'left' || drag.edge === 'right' ? event.clientX - drag.x : event.clientY - drag.y
    return resizePreviewEdge(drag.start, drag.edge, delta, dimensions)
  }
  const finish = (event: PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    const drag = dragRef.current
    const next = deltaRect(event)
    clearDrag()
    if (next.width !== drag.start.width || next.height !== drag.start.height) {
      saveSize(next, drag.edge)
      setManualRect(next)
    } else {
      setManualRect(drag.previous)
    }
    // Pointer use must not leave a keyboard-focused handle pinning this hover card.
    if (document.activeElement === drag.handle) drag.handle.blur()
    setActiveEdge(null)
    const bounds = drag.handle.getBoundingClientRect()
    setHoveredEdge(event.clientX >= bounds.left && event.clientX <= bounds.right &&
      event.clientY >= bounds.top && event.clientY <= bounds.bottom ? drag.edge : null)
    settleHover(event.clientX, event.clientY)
  }

  return (
    <div className='pointer-events-none absolute z-20' style={{ left: rect?.left ?? layout.left, top: rect?.top ?? layout.top }}>
      <div
        ref={cardRef}
        data-heimdall-wheel-exempt='true'
        className='pointer-events-auto relative flex flex-col overflow-hidden rounded-[20px] border border-stone-200/55 bg-white/75 backdrop-blur-2xl dark:border-neutral-700/55 dark:bg-neutral-900/75'
        style={{ ...style, width: rect?.width ?? layout.width, height: manualRect || preferred?.height !== undefined ? rect?.height : undefined, maxHeight: rect?.height ?? layout.maxHeight }}
        onMouseEnter={props.onEnter}
        onMouseLeave={props.onLeave}
        onFocusCapture={props.onEnter}
        onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) props.onLeave() }}
        onPointerDown={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()}
      >
        <div className='min-h-0 flex-1 overflow-auto p-4 no-scrollbar'>{children}</div>
        {edges.map(edge => (
          <button
            key={edge}
            type='button'
            role='separator'
            aria-label={`Resize message preview ${edge} edge`}
            aria-orientation={edge === 'left' || edge === 'right' ? 'vertical' : 'horizontal'}
            aria-valuenow={Math.round(edge === 'left' || edge === 'right' ? rect?.width ?? layout.width : rect?.height ?? layout.maxHeight)}
            aria-valuetext={`${Math.round(edge === 'left' || edge === 'right' ? rect?.width ?? layout.width : rect?.height ?? layout.maxHeight)} pixels${!rect && (edge === 'top' || edge === 'bottom') ? ' maximum' : ''}`}
            aria-description='Arrow keys resize; Shift for larger steps. Home resets automatic size.'
            title='Drag to resize. Arrow keys resize; Shift for larger steps. Double-click or Home to reset.'
            className={`group absolute z-10 touch-none select-none border-0 bg-transparent p-0 focus-visible:outline-none ${edgeClasses[edge]}`}
            onPointerEnter={() => setHoveredEdge(edge)}
            onPointerLeave={() => setHoveredEdge(null)}
            onPointerDown={event => {
              if (event.button !== 0 || !event.isPrimary || dragRef.current) return
              event.preventDefault()
              event.stopPropagation()
              const start = measure()
              if (!start) return
              callbacks.current.onEnter()
              draggingRef.current = true
              dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, edge, start, previous: manualRect, handle: event.currentTarget }
              event.currentTarget.setPointerCapture(event.pointerId)
              setManualRect(start)
              setActiveEdge(edge)
            }}
            onPointerMove={event => {
              if (dragRef.current?.pointerId !== event.pointerId) return
              const next = deltaRect(event)
              if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
              frameRef.current = requestAnimationFrame(() => { frameRef.current = null; setManualRect(next) })
            }}
            onPointerUp={finish}
            onPointerCancel={event => { if (dragRef.current?.pointerId === event.pointerId) cancel() }}
            onLostPointerCapture={event => { if (dragRef.current?.pointerId === event.pointerId) cancel() }}
            onDoubleClick={reset}
            onKeyDown={event => {
              if (event.key === 'Home') { event.preventDefault(); event.stopPropagation(); reset(); return }
              const horizontal = edge === 'left' || edge === 'right'
              const negative = horizontal ? 'ArrowLeft' : 'ArrowUp'
              const positive = horizontal ? 'ArrowRight' : 'ArrowDown'
              if (event.key !== negative && event.key !== positive) return
              event.preventDefault()
              event.stopPropagation()
              if (dragRef.current) return
              const start = measure()
              if (!start) return
              const next = resizePreviewEdge(start, edge, (event.key === negative ? -1 : 1) * (event.shiftKey ? 32 : 8), dimensions)
              saveSize(next, edge)
              setManualRect(next)
            }}
          >
            <span aria-hidden='true' className={`pointer-events-none absolute rounded-full group-focus-visible:opacity-100 ${(activeEdge ?? hoveredEdge) === edge ? 'opacity-100' : 'opacity-0'}`} style={{ ...lineStyles[edge], backgroundColor: accent }} />
          </button>
        ))}
      </div>
    </div>
  )
}
