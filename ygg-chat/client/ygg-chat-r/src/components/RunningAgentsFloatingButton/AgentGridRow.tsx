import { Children, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { getAgentGridTracks, resizeAgentGridSplit } from './agentGridSplit'

/** Each row owns its split ratios; no shared grid tracks can move other rows. */
export function AgentGridRow({ children, label }: { children: ReactNode; label: string }) {
  const cells = Children.toArray(children)
  const identity = JSON.stringify(cells.map(cell => typeof cell === 'object' && cell !== null && 'key' in cell ? cell.key : null))
  const equal = () => cells.map(() => 1 / cells.length)
  const [ratios, setRatios] = useState(equal)
  const [previousIdentity, setPreviousIdentity] = useState(identity)
  // Reset only geometry when row membership changes, not surviving transcripts.
  if (previousIdentity !== identity) {
    setPreviousIdentity(identity)
    setRatios(equal())
  }
  const resolvedRatios = previousIdentity === identity ? ratios : equal()
  const rowRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    pointerId: number; divider: number; x: number; width: number;
    start: number[]; latest: number[]; handle: HTMLDivElement
  } | null>(null)
  const frameRef = useRef<number | null>(null)

  const release = () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    const drag = dragRef.current
    dragRef.current = null
    if (drag?.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId)
  }

  useLayoutEffect(() => () => release(), [identity])

  const availableWidth = () => {
    const row = rowRef.current
    if (!row) return 0
    const gap = parseFloat(getComputedStyle(row).columnGap) || 0
    return row.getBoundingClientRect().width - gap * (cells.length - 1)
  }
  const finish = (event: PointerEvent<HTMLDivElement>, save: boolean) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const validWidth = Math.abs(availableWidth() - drag.width) <= 1
    const final = save && validWidth
      ? resizeAgentGridSplit(drag.start, drag.divider, event.clientX - drag.x, drag.width)
      : drag.start
    release()
    setRatios(final)
  }
  const reset = () => { release(); setRatios(equal()) }
  const measuredRatios = () => {
    const row = rowRef.current
    const width = availableWidth()
    if (!row || width <= 0) return resolvedRatios
    // CSS enforces minimums on shell shrink; start from the actual painted sizes.
    return Array.from(row.children).map(cell => cell.getBoundingClientRect().width / width)
  }
  const onPointerDown = (event: PointerEvent<HTMLDivElement>, divider: number) => {
    if (event.button !== 0 || !event.isPrimary || dragRef.current) return
    event.preventDefault()
    event.stopPropagation()
    const start = measuredRatios()
    dragRef.current = { pointerId: event.pointerId, divider, x: event.clientX, width: availableWidth(),
      start, latest: start, handle: event.currentTarget }
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    // If the shell or viewport resized mid-drag, abandon the old geometry.
    if (Math.abs(availableWidth() - drag.width) > 1) { finish(event, false); return }
    drag.latest = resizeAgentGridSplit(drag.start, drag.divider, event.clientX - drag.x, drag.width)
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      if (dragRef.current) setRatios(dragRef.current.latest)
    })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, divider: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'Escape'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      const start = dragRef.current?.start
      release()
      if (start) setRatios(start)
    } else if (event.key === 'Home') reset()
    else {
      release()
      const delta = (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 32 : 8)
      setRatios(resizeAgentGridSplit(measuredRatios(), divider, delta, availableWidth()))
    }
  }

  return (
    <div ref={rowRef} className='grid min-w-0 gap-x-3' style={{ gridTemplateColumns: getAgentGridTracks(resolvedRatios) }}>
      {cells.map((cell, index) => (
        <div key={typeof cell === 'object' && cell !== null && 'key' in cell ? cell.key : index} className='relative min-w-0'>
          {cell}
          {index < cells.length - 1 && <div role='separator' tabIndex={0} aria-orientation='vertical'
            aria-label={`${label}: resize cells ${index + 1} and ${index + 2}`}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(resolvedRatios[index] / (resolvedRatios[index] + resolvedRatios[index + 1]) * 100)}
            title='Drag to resize · Double-click to reset row'
            className='absolute -right-3 top-0 z-10 h-full w-3 touch-none select-none cursor-col-resize rounded hover:bg-current/10 focus-visible:bg-current/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-current'
            onClick={event => event.stopPropagation()}
            onPointerDown={event => onPointerDown(event, index)} onPointerMove={onPointerMove}
            onPointerUp={event => finish(event, true)} onPointerCancel={event => finish(event, false)}
            onLostPointerCapture={event => finish(event, false)} onKeyDown={event => onKeyDown(event, index)} onDoubleClick={reset} />}
        </div>
      ))}
    </div>
  )
}
