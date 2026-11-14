interface ViewportSize {
  width: number
  height: number
}

// Sidebar drags and flex-basis transitions resize the panel without resizing
// the window. Observe the panel itself, keeping window resize as a fallback.
export function observeHeimdallViewport(container: HTMLElement, onSize: (size: ViewportSize) => void): () => void {
  const updateSize = () => onSize({ width: container.clientWidth, height: container.clientHeight })
  updateSize()

  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateSize) : null
  observer?.observe(container)
  window.addEventListener('resize', updateSize)

  return () => {
    observer?.disconnect()
    window.removeEventListener('resize', updateSize)
  }
}

export function calculateDockedPreviewLayout(
  dimensions: ViewportSize,
  anchor: { x: number; y: number },
  preferredWidth: number,
  preferredMaxHeight: number
) {
  const viewportWidth = Math.max(0, dimensions.width)
  const viewportHeight = Math.max(0, dimensions.height)
  const horizontalMargin = Math.min(12, viewportWidth / 2)
  const verticalMargin = Math.min(10, viewportHeight / 2)
  const halfWidth = viewportWidth / 2
  const width = Math.min(
    preferredWidth,
    Math.max(220, halfWidth - horizontalMargin * 2),
    Math.max(0, viewportWidth - horizontalMargin * 2)
  )
  const maxHeight = Math.min(preferredMaxHeight, Math.max(0, viewportHeight - verticalMargin * 2))
  // Prefer the opposite half, but containment takes priority in narrow panels.
  const left = anchor.x < halfWidth ? viewportWidth - width - horizontalMargin : horizontalMargin
  const top = Math.max(verticalMargin, Math.min(anchor.y, viewportHeight - maxHeight - verticalMargin))

  return { left, top, width, maxHeight }
}

export type PreviewEdge = 'left' | 'right' | 'top' | 'bottom'
export interface PreviewRect { left: number; top: number; width: number; height: number }

export function clampPreviewRect(rect: PreviewRect, viewport: ViewportSize): PreviewRect {
  const marginX = Math.min(12, Math.max(0, viewport.width) / 2)
  const marginY = Math.min(10, Math.max(0, viewport.height) / 2)
  const availableWidth = Math.max(0, viewport.width - marginX * 2)
  const availableHeight = Math.max(0, viewport.height - marginY * 2)
  const width = Math.min(availableWidth, Math.max(0, rect.width))
  const height = Math.min(availableHeight, Math.max(0, rect.height))
  return {
    left: Math.max(marginX, Math.min(rect.left, viewport.width - marginX - width)),
    top: Math.max(marginY, Math.min(rect.top, viewport.height - marginY - height)),
    width, height,
  }
}

export function resizePreviewEdge(start: PreviewRect, edge: PreviewEdge, delta: number, viewport: ViewportSize): PreviewRect {
  const rect = clampPreviewRect(start, viewport)
  const marginX = Math.min(12, Math.max(0, viewport.width) / 2)
  const marginY = Math.min(10, Math.max(0, viewport.height) / 2)
  const minWidth = Math.min(220, rect.width)
  const minHeight = Math.min(120, rect.height)
  const right = rect.left + rect.width
  const bottom = rect.top + rect.height
  if (edge === 'left') {
    rect.left = Math.max(marginX, Math.min(rect.left + delta, right - minWidth))
    rect.width = right - rect.left
  } else if (edge === 'right') {
    rect.width = Math.max(minWidth, Math.min(rect.width + delta, viewport.width - marginX - rect.left))
  } else if (edge === 'top') {
    rect.top = Math.max(marginY, Math.min(rect.top + delta, bottom - minHeight))
    rect.height = bottom - rect.top
  } else {
    rect.height = Math.max(minHeight, Math.min(rect.height + delta, viewport.height - marginY - rect.top))
  }
  return rect
}
