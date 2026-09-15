import { describe, expect, it } from 'vitest'
import {
  MERMAID_MAX_SCALE,
  MERMAID_MIN_SCALE,
  clampMermaidScale,
  fitMermaidToViewport,
  zoomMermaidAtPoint,
} from './mermaidViewport'

describe('Mermaid diagram viewport transforms', () => {
  it('clamps zoom to the supported range', () => {
    expect(clampMermaidScale(0.01)).toBe(MERMAID_MIN_SCALE)
    expect(clampMermaidScale(10)).toBe(MERMAID_MAX_SCALE)
  })

  it('keeps the diagram point beneath the cursor stationary while zooming', () => {
    const point = { x: 250, y: 180 }
    const current = { scale: 1, x: 50, y: 30 }
    const next = zoomMermaidAtPoint(current, 2, point)

    expect(next).toEqual({ scale: 2, x: -150, y: -120 })
    expect((point.x - next.x) / next.scale).toBe((point.x - current.x) / current.scale)
    expect((point.y - next.y) / next.scale).toBe((point.y - current.y) / current.scale)
  })

  it('fits and centers a diagram inside the available viewport', () => {
    expect(fitMermaidToViewport({ width: 1000, height: 700 }, { width: 1600, height: 800 }, 50)).toEqual({
      scale: 0.5625,
      x: 50,
      y: 125,
    })
  })
})
