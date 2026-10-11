import { describe, expect, it } from 'vitest'
import { getSearchListPosition } from './searchListPosition'

const anchor = { top: 100, bottom: 144, left: 16, width: 300 }

describe('search results positioning', () => {
  it('leaves a gap below the field and reaches the viewport bottom inset', () => {
    const position = getSearchListPosition(anchor, 1200, 900, true)
    expect(position).toEqual({ top: 152, left: 16, width: 300, maxHeight: 732, opensUpward: false })
    expect(position.top + position.maxHeight).toBe(900 - 16)
  })

  it('does not cap the sidebar panel on tall screens', () => {
    expect(getSearchListPosition(anchor, 1200, 1600, true).maxHeight).toBe(1432)
  })

  it('preserves a compact height limit when full-viewport mode is not requested', () => {
    expect(getSearchListPosition(anchor, 1200, 900).maxHeight).toBe(420)
  })

  it('keeps the sidebar below a low field instead of flipping above it', () => {
    const lowAnchor = { ...anchor, top: 750, bottom: 794 }
    const position = getSearchListPosition(lowAnchor, 1200, 850, true)
    expect(position.opensUpward).toBe(false)
    expect(position.top).toBe(lowAnchor.bottom + 8)
    expect(position.top + position.maxHeight).toBe(850 - 16)
  })

  it('keeps compact upward panels attached to the field', () => {
    const position = getSearchListPosition({ ...anchor, top: 750, bottom: 794 }, 1200, 850)
    expect(position.maxHeight).toBe(420)
    expect(position.top).toBe(322)
  })

  it('clamps width and horizontal position on narrow viewports', () => {
    const position = getSearchListPosition(anchor, 200, 900, true)
    expect(position.width).toBe(184)
    expect(position.left).toBe(8)
  })

  it('clamps the right edge without changing a fitting width', () => {
    const position = getSearchListPosition({ ...anchor, left: 1100 }, 1200, 900, true)
    expect(position.left).toBe(892)
    expect(position.width).toBe(300)
  })

  it('does not force a minimum height that would overflow a short viewport', () => {
    const position = getSearchListPosition({ ...anchor, top: 24, bottom: 68 }, 300, 120, true)
    expect(position.maxHeight).toBe(28)
    expect(position.top + position.maxHeight).toBe(104)
  })
})
