export interface MermaidViewTransform {
  scale: number
  x: number
  y: number
}

export interface MermaidPoint {
  x: number
  y: number
}

export interface MermaidSize {
  width: number
  height: number
}

export const MERMAID_MIN_SCALE = 0.02
export const MERMAID_MAX_SCALE = 6

export const clampMermaidScale = (scale: number): number =>
  Math.min(MERMAID_MAX_SCALE, Math.max(MERMAID_MIN_SCALE, scale))

export const zoomMermaidAtPoint = (
  transform: MermaidViewTransform,
  nextScale: number,
  point: MermaidPoint
): MermaidViewTransform => {
  const scale = clampMermaidScale(nextScale)
  const contentX = (point.x - transform.x) / transform.scale
  const contentY = (point.y - transform.y) / transform.scale

  return {
    scale,
    x: point.x - contentX * scale,
    y: point.y - contentY * scale,
  }
}

export const centerMermaidAtScale = (
  viewport: MermaidSize,
  content: MermaidSize,
  scale: number
): MermaidViewTransform => {
  const nextScale = clampMermaidScale(scale)
  return {
    scale: nextScale,
    x: (viewport.width - content.width * nextScale) / 2,
    y: (viewport.height - content.height * nextScale) / 2,
  }
}

export const fitMermaidToViewport = (
  viewport: MermaidSize,
  content: MermaidSize,
  padding = 48
): MermaidViewTransform => {
  const availableWidth = Math.max(1, viewport.width - padding * 2)
  const availableHeight = Math.max(1, viewport.height - padding * 2)
  const contentWidth = Math.max(1, content.width)
  const contentHeight = Math.max(1, content.height)
  const scale = clampMermaidScale(Math.min(availableWidth / contentWidth, availableHeight / contentHeight))

  return centerMermaidAtScale(viewport, content, scale)
}
