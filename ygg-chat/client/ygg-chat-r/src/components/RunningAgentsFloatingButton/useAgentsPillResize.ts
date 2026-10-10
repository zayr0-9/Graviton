import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react'
import { useAppDispatch, useAppSelector } from '../../hooks/redux'
import { runningAgentsUiActions, type AgentsPillSize } from '../../features/ui/runningAgentsUiSlice'
import { clampAgentsPillSize, resizeAgentsPillFromCorner, type PillSpace } from './agentsPillResize'

export function useAgentsPillResize(expanded: boolean, anchorKey: string) {
  const dispatch = useAppDispatch()
  const preferred = useAppSelector(state => state.runningAgentsUi.expandedSize)
  const shellRef = useRef<HTMLDivElement>(null)
  const spaceRef = useRef<PillSpace>({ right: window.innerWidth - 16, bottom: window.innerHeight - 16 })
  const headerRef = useRef<HTMLDivElement>(null)
  const [headerHeight, setHeaderHeight] = useState(48)
  const [limits, setLimits] = useState({ width: window.innerWidth - 28, height: window.innerHeight - 28 })
  const [resolved, setResolved] = useState<AgentsPillSize | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{
    pointerId: number; x: number; y: number; start: AgentsPillSize;
    latest: AgentsPillSize; handle: HTMLButtonElement
  } | null>(null)
  const frameRef = useRef<number | null>(null)

  const measureSpace = useCallback(() => {
    const shell = shellRef.current
    if (!shell) return
    // Read CSS anchor offsets independently of the shell's transitioning size.
    const style = getComputedStyle(shell)
    const right = parseFloat(style.right)
    const bottom = parseFloat(style.bottom)
    spaceRef.current = {
      right: window.innerWidth - (Number.isFinite(right) ? right : 16),
      bottom: window.innerHeight - (Number.isFinite(bottom) ? bottom : 16),
    }
  }, [])

  const cancelDrag = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    const drag = dragRef.current
    dragRef.current = null
    if (drag?.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId)
  }, [])

  useLayoutEffect(() => {
    if (!expanded) {
      cancelDrag()
      setDragging(false)
      return
    }
    const update = () => {
      cancelDrag()
      setDragging(false)
      measureSpace()
      setLimits({ width: Math.max(1, spaceRef.current.right - 12), height: Math.max(1, spaceRef.current.bottom - 12) })
      setResolved(preferred ? clampAgentsPillSize(preferred, spaceRef.current) : null)
    }
    update()
    window.addEventListener('resize', update)
    const observer = new ResizeObserver(() => {
      const height = headerRef.current?.getBoundingClientRect().height
      if (height) setHeaderHeight(height)
    })
    if (headerRef.current) observer.observe(headerRef.current)
    return () => { window.removeEventListener('resize', update); observer.disconnect(); cancelDrag() }
  }, [expanded, preferred, anchorKey, measureSpace, cancelDrag])

  const finish = (event: PointerEvent<HTMLButtonElement>, save: boolean) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    const size = dragRef.current.latest
    cancelDrag()
    setDragging(false)
    if (save) dispatch(runningAgentsUiActions.sizeChanged(size))
    else setResolved(preferred ? clampAgentsPillSize(preferred, spaceRef.current) : null)
  }

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || dragRef.current || !event.isPrimary) return
    event.preventDefault()
    event.stopPropagation()
    measureSpace()
    const rect = shellRef.current?.getBoundingClientRect()
    if (!rect) return
    const size = clampAgentsPillSize({ width: rect.width, height: rect.height }, spaceRef.current)
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      start: size, latest: size, handle: event.currentTarget }
    event.currentTarget.setPointerCapture(event.pointerId)
    setResolved(size)
    setDragging(true)
  }
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    drag.latest = resizeAgentsPillFromCorner(drag.start, event.clientX - drag.x, event.clientY - drag.y, spaceRef.current)
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      if (dragRef.current) setResolved(dragRef.current.latest)
    })
  }
  const reset = () => {
    cancelDrag()
    setDragging(false)
    setResolved(null)
    dispatch(runningAgentsUiActions.sizeReset())
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Home') { event.preventDefault(); reset(); return }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    measureSpace()
    const rect = shellRef.current?.getBoundingClientRect()
    if (!rect) return
    const step = event.shiftKey ? 32 : 8
    const size = resizeAgentsPillFromCorner(resolved ?? rect,
      event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
      event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0, spaceRef.current)
    dispatch(runningAgentsUiActions.sizeChanged(size))
  }

  return { shellRef, headerRef, headerHeight, limits, size: expanded ? resolved : null, dragging,
    handleProps: { onPointerDown, onPointerMove, onPointerUp: (event: PointerEvent<HTMLButtonElement>) => finish(event, true),
      onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => finish(event, false),
      onLostPointerCapture: (event: PointerEvent<HTMLButtonElement>) => finish(event, true),
      onKeyDown, onDoubleClick: reset } }
}
