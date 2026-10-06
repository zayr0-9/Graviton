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
