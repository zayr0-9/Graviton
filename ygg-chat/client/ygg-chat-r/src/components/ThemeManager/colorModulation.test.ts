import { afterEach, describe, expect, it } from 'vitest'
import { formatHex, hslaToRgba, modulateColor, parseCssColor, rgbaToHsla } from './colorModulation'

describe('parseCssColor', () => {
  it.each([
    ['#fff', '#ffffff'],
    ['#0008', '#00000088'],
    ['#be123c', '#be123c'],
    ['#BE123C80', '#be123c80'],
    ['rgb(250, 250, 250)', '#fafafa'],
    ['rgba(23, 23, 23, 0.3)', '#1717174d'],
    ['rgb(23 23 23 / 30%)', '#1717174d'],
    ['hsl(210, 40%, 50%)', '#4d80b3'],
    ['hsla(0 100% 50% / 0.5)', '#ff000080'],
    ['hsl(210deg 40 50)', '#4d80b3'],
    ['white', '#ffffff'],
    ['transparent', '#00000000'],
  ])('parses %s', (input, hex) => {
    const parsed = parseCssColor(input)
    expect(parsed).not.toBeNull()
    expect(formatHex(parsed!)).toBe(hex)
  })

  it.each(['', 'nope', 'rebeccapurple', 'var(--x)', 'color-mix(in srgb, red, blue)', '#ggg', '#12345', 'rgb(1, 2)', 'rgb(a, b, c)'])(
    'rejects %j',
    input => {
      expect(parseCssColor(input)).toBeNull()
    }
  )
})

describe('hsl round trip', () => {
  it.each(['#be123c', '#fda4af', '#334155', '#e7e5e4', '#86efac', '#c4b5fd', '#475569', '#a8a29e', '#000000', '#ffffff', '#808080', '#0284c7'])(
    'returns %s unchanged',
    hex => {
      expect(formatHex(hslaToRgba(rgbaToHsla(parseCssColor(hex)!)))).toBe(hex)
    }
  )
})

describe('modulateColor', () => {
  it('is the identity for an empty modulation', () => {
    expect(modulateColor('#be123c', {})).toBe('#be123c')
    expect(modulateColor('#be123c', { saturate: 1, lighten: 0 })).toBe('#be123c')
  })

  it('normalises other formats to hex', () => {
    expect(modulateColor('rgba(23, 23, 23, 0.3)', {})).toBe('#1717174d')
  })

  it('desaturates to grey at the same lightness', () => {
    expect(modulateColor('#be123c', { saturate: 0 })).toBe('#686868')
  })

  it('clamps lightness at both ends', () => {
    expect(modulateColor('#be123c', { lighten: 100 })).toBe('#ffffff')
    expect(modulateColor('#be123c', { lighten: -100 })).toBe('#000000')
  })

  it('multiplies alpha', () => {
    expect(modulateColor('#be123c', { alpha: 0.5 })).toBe('#be123c80')
    expect(modulateColor('#be123c80', { alpha: 0.5 })).toBe('#be123c40')
  })

  it('mixes toward another colour', () => {
    expect(modulateColor('#000000', { mix: { color: '#ffffff', amount: 0.5 } })).toBe('#808080')
    expect(modulateColor('#000000', { mix: { color: 'not a colour', amount: 0.5 } })).toBe('#000000')
  })

  describe('unparseable input', () => {
    const originalCss = (globalThis as { CSS?: unknown }).CSS
    afterEach(() => {
      if (originalCss === undefined) delete (globalThis as { CSS?: unknown }).CSS
      else (globalThis as { CSS?: unknown }).CSS = originalCss
    })

    it('passes through when the runtime has no CSS object', () => {
      delete (globalThis as { CSS?: unknown }).CSS
      expect(modulateColor('rebeccapurple', { saturate: 0.5, lighten: 4 })).toBe('rebeccapurple')
    })

    it('passes through when relative colour syntax is unsupported', () => {
      ;(globalThis as { CSS?: unknown }).CSS = { supports: () => false }
      expect(modulateColor('rebeccapurple', { saturate: 0.5 })).toBe('rebeccapurple')
    })

    it('defers to CSS relative colour syntax when supported', () => {
      ;(globalThis as { CSS?: unknown }).CSS = { supports: () => true }
      expect(modulateColor('rebeccapurple', {})).toBe('hsl(from rebeccapurple h s l)')
      expect(modulateColor('rebeccapurple', { saturate: 0.5, lighten: -4, alpha: 0.75 })).toBe(
        'hsl(from rebeccapurple h calc(s * 0.5) calc(l + -4) / calc(alpha * 0.75))'
      )
      expect(modulateColor('rebeccapurple', { mix: { color: 'white', amount: 0.25 } })).toBe(
        'color-mix(in srgb, hsl(from rebeccapurple h s l) 75%, white 25%)'
      )
    })
  })
})
