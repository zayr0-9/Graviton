import { describe, expect, it } from 'vitest'
import { composerSurfacePath } from './ComposerSurface'

const geometry = { width: 600, height: 120, tabWidth: 140, tabHeight: 26, rem: 16 }
const commands = (path: string) => path.replace(/[^A-Z]/g, '')

describe('composerSurfacePath', () => {
  it('is the plain rounded body when the tab is hidden', () => {
    const path = composerSurfacePath(geometry, 0)
    // Body top edge sits at the tab height; every corner uses the rounded-3xl radius.
    expect(path).toContain('M0 122 V50 A24 24 0 0 1 24 26')
    expect(path).toContain('H576 A24 24 0 0 1 600 50')
    expect(path).toContain('A0 0 0 0 1 140 26')
  })

  it('joins the tab to the body with a concave fillet', () => {
    const path = composerSurfacePath(geometry, 1)
    expect(path).toContain('V12 A12 12 0 0 1 12 0')
    expect(path).toContain('H128 A12 12 0 0 1 140 12')
    expect(path).toContain('V16 A10 10 0 0 0 150 26')
  })

  it('keeps one command structure so the shape can morph', () => {
    expect(commands(composerSurfacePath(geometry, 0.4))).toBe(commands(composerSurfacePath(geometry, 1)))
    expect(commands(composerSurfacePath(geometry, 0, 0.5))).toBe(commands(composerSurfacePath(geometry, 1)))
  })

  it('keeps a wide tab clear of the top-right corner', () => {
    const path = composerSurfacePath({ ...geometry, tabWidth: 900 }, 1)
    expect(path).toContain('A10 10 0 0 0 576 26')
  })

  it('draws nothing before the body is measured', () => {
    expect(composerSurfacePath({ ...geometry, width: 0 }, 1)).toBe('M0 0')
  })
})
