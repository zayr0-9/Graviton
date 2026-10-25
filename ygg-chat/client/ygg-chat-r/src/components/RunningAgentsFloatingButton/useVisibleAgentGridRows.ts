import { useEffect, useState, type RefObject } from 'react'

/** One observer for the grid, not one observer/subscription per transcript. */
export function useVisibleAgentGridRows(
  gridRef: RefObject<HTMLDivElement | null>,
  scrollRef: RefObject<HTMLDivElement | null>,
  rowCount: number,
  columns: number
): ReadonlySet<number> | null {
  // Unsupported environments retain the fully accessible non-deferred view.
  const [visibility, setVisibility] = useState(() => ({ columns, rows: new Set<number>() }))
  const [focusedRow, setFocusedRow] = useState<number | null>(null)
  const supported = typeof IntersectionObserver !== 'undefined'

  useEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const updateFocus = (event: FocusEvent) => {
      const target = event.type === 'focusout' ? event.relatedTarget : event.target
      const row = target instanceof Element && grid.contains(target) ? target.closest<HTMLElement>('[data-agent-grid-row]') : null
      setFocusedRow(row ? Number(row.dataset.agentGridRow) : null)
    }
    grid.addEventListener('focusin', updateFocus)
    grid.addEventListener('focusout', updateFocus)
    return () => {
      grid.removeEventListener('focusin', updateFocus)
      grid.removeEventListener('focusout', updateFocus)
    }
  }, [gridRef])

  useEffect(() => {
    const grid = gridRef.current
    const root = scrollRef.current
    if (!grid || !root || typeof IntersectionObserver === 'undefined') return
    let active = true
    const observer = new IntersectionObserver(entries => {
      if (!active) return
      setVisibility(previous => {
        const next = new Set(previous.columns === columns ? [...previous.rows].filter(index => index < rowCount) : [])
        let changed = previous.columns !== columns || next.size !== previous.rows.size
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.agentGridRow)
          if (entry.isIntersecting && !next.has(index)) { next.add(index); changed = true }
          else if (!entry.isIntersecting && next.has(index)) { next.delete(index); changed = true }
        }
        return changed ? { columns, rows: next } : previous
      })
    }, { root, rootMargin: '200px 0px' })
    for (const row of grid.children) observer.observe(row)
    return () => { active = false; observer.disconnect() }
  }, [gridRef, scrollRef, rowCount, columns])

  if (!supported) return null
  const visible = new Set(visibility.columns === columns ? [...visibility.rows].filter(index => index < rowCount) : [])
  if (focusedRow !== null && focusedRow < rowCount) visible.add(focusedRow)
  return visible
}
