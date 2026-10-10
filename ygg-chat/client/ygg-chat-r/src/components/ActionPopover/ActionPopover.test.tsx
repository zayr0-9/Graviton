import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ActionPopoverButton, ActionPopoverDisclosure, ActionPopoverSwitch } from './ActionPopoverControls'
import { getActionPopoverPosition } from './actionPopoverPosition'

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return { ...actual, useReducedMotion: () => true }
})

describe('Soft cloud positioning', () => {
  it('uses a bottom anchor independent of disclosure height', () => {
    const position = getActionPopoverPosition({ top: 650, bottom: 686, left: 500, width: 36 }, 360, 1000, 800)
    expect(position).toMatchObject({ bottom: 158, top: undefined, maxHeight: 634, left: 338 })
    // Bottom + available height leaves 8px at the top, even for overflowing content.
    expect(800 - position.bottom! - position.maxHeight).toBe(8)
  })
  it('clamps horizontally on narrow viewports', () => {
    expect(getActionPopoverPosition({ top: 600, bottom: 636, left: 280, width: 36 }, 304, 320, 700).left).toBe(8)
  })
  it('falls back below a trigger near the top', () => {
    expect(getActionPopoverPosition({ top: 20, bottom: 56, left: 10, width: 36 }, 360, 900, 700))
      .toMatchObject({ top: 64, bottom: undefined, maxHeight: 628 })
  })
})

describe('Soft cloud controls', () => {
  it('preserves switch state and disabled semantics', () => {
    const html = renderToStaticMarkup(<ActionPopoverSwitch label='Fast mode' checked disabled />)
    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('disabled=""')
    expect(html).toContain('data-interacted="false"')
  })
  it('keeps collapsed image fields inert and labelled', () => {
    const html = renderToStaticMarkup(<ActionPopoverDisclosure><button>Custom dropdown</button></ActionPopoverDisclosure>)
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-controls=')
    expect(html).toContain('inert=""')
    expect(html).toContain('Custom dropdown')
  })
  it('renders the current pill state with no reduced-motion displacement', () => {
    const html = renderToStaticMarkup(<ActionPopoverButton label='Allow all' icon={<svg />} active aria-pressed />)
    expect(html).toContain('data-active="true"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('Allow all')
    expect(html).not.toContain('blur(2px)')
  })
})
