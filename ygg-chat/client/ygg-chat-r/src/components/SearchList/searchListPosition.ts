export type SearchListPosition = {
  top: number
  left: number
  width: number
  maxHeight: number
  opensUpward: boolean
}

/** Keep the panel clear of the input's focus ring and inside the viewport. */
export function getSearchListPosition(
  anchor: { top: number; bottom: number; left: number; width: number },
  viewportWidth: number,
  viewportHeight: number,
  fillViewport = false
): SearchListPosition {
  const edgePadding = 16
  const gap = 8
  const horizontalPadding = Math.min(8, viewportWidth / 2)
  const width = Math.max(0, Math.min(anchor.width, viewportWidth - horizontalPadding * 2))
  const left = Math.min(Math.max(horizontalPadding, anchor.left), viewportWidth - width - horizontalPadding)
  const spaceBelow = Math.max(0, viewportHeight - edgePadding - anchor.bottom - gap)
  const spaceAbove = Math.max(0, anchor.top - gap - edgePadding)
  const opensUpward = !fillViewport && spaceBelow < 120 && spaceAbove > spaceBelow
  const availableHeight = opensUpward ? spaceAbove : spaceBelow
  const maxHeight = fillViewport ? availableHeight : Math.min(420, availableHeight)

  return {
    top: opensUpward ? anchor.top - gap - maxHeight : anchor.bottom + gap,
    left,
    width,
    maxHeight,
    opensUpward,
  }
}
