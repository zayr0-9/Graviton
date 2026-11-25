/**
 * Colour arithmetic for deriving UI colours from custom theme tokens at render time.
 *
 * A theme stores one colour per semantic token. A surface that needs a calmer, lighter or
 * translucent variant derives it here instead of adding a token, so a theme author tunes one
 * value and every derived use follows. Parsing covers what the theme editor and sanitizer
 * produce (hex, rgb()/rgba(), hsl()/hsla(), white/black/transparent). Anything else is handed
 * to CSS relative colour syntax when the runtime supports it, otherwise returned unchanged, so
 * an exotic theme value never turns into an invalid colour.
 */

export interface RgbaColor {
  r: number
  g: number
  b: number
  /** 0..1 */
  a: number
}

export interface HslaColor {
  /** 0..360 */
  h: number
  /** 0..100 */
  s: number
  /** 0..100 */
  l: number
  /** 0..1 */
  a: number
}

export interface ColorModulation {
  /** Saturation multiplier: 1 keeps it, 0.5 halves it, 0 is grey. */
  saturate?: number
  /** Lightness offset in percentage points: positive lightens, negative darkens. */
  lighten?: number
  /** Alpha multiplier: 0.75 leaves three quarters of the opacity. */
  alpha?: number
  /** Blend toward another colour; `amount` is that colour's share, 0..1. */
  mix?: { color: string; amount: number }
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

const NAMED_COLORS: Record<string, RgbaColor> = {
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
}

const parseHex = (hex: string): RgbaColor | null => {
  if (!/^[0-9a-f]+$/.test(hex)) return null
  const digits = hex.length === 3 || hex.length === 4 ? hex.split('').map(ch => ch + ch).join('') : hex
  if (digits.length !== 6 && digits.length !== 8) return null
  const channel = (offset: number) => parseInt(digits.slice(offset, offset + 2), 16)
  return { r: channel(0), g: channel(2), b: channel(4), a: digits.length === 8 ? channel(6) / 255 : 1 }
}

/** Reads one function argument; `max` is what a bare 100% stands for. */
const parseChannel = (part: string, max: number): number | null => {
  const percent = part.endsWith('%')
  const numeric = Number(percent ? part.slice(0, -1) : part.replace(/deg$/, ''))
  if (!Number.isFinite(numeric)) return null
  return percent ? (numeric / 100) * max : numeric
}

const parseFunction = (name: string, body: string): RgbaColor | null => {
  const parts = body.replace('/', ' ').trim().split(/[\s,]+/).filter(Boolean)
  if (parts.length !== 3 && parts.length !== 4) return null
  const alpha = parts.length === 4 ? parseChannel(parts[3], 1) : 1
  if (alpha === null) return null
  if (name.startsWith('rgb')) {
    const [r, g, b] = parts.slice(0, 3).map(part => parseChannel(part, 255))
    if (r === null || g === null || b === null) return null
    return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: clamp(alpha, 0, 1) }
  }
  const h = parseChannel(parts[0], 360)
  const s = parseChannel(parts[1].endsWith('%') ? parts[1] : `${parts[1]}%`, 100)
  const l = parseChannel(parts[2].endsWith('%') ? parts[2] : `${parts[2]}%`, 100)
  if (h === null || s === null || l === null) return null
  return hslaToRgba({ h, s, l, a: clamp(alpha, 0, 1) })
}

/** Parses hex, rgb()/rgba(), hsl()/hsla() and white/black/transparent. Anything else is null. */
export const parseCssColor = (input: string): RgbaColor | null => {
  const value = input.trim().toLowerCase()
  if (!value) return null
  if (value in NAMED_COLORS) return { ...NAMED_COLORS[value] }
  if (value.startsWith('#')) return parseHex(value.slice(1))
  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(value)
  return fn ? parseFunction(fn[1], fn[2]) : null
}

export const rgbaToHsla = ({ r, g, b, a }: RgbaColor): HslaColor => {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const delta = max - min
  const l = (max + min) / 2
  if (delta === 0) return { h: 0, s: 0, l: l * 100, a }
  const s = delta / (1 - Math.abs(2 * l - 1))
  let h = max === rn ? ((gn - bn) / delta) % 6 : max === gn ? (bn - rn) / delta + 2 : (rn - gn) / delta + 4
  h *= 60
  if (h < 0) h += 360
  return { h, s: s * 100, l: l * 100, a }
}

export const hslaToRgba = ({ h, s, l, a }: HslaColor): RgbaColor => {
  const sn = clamp(s, 0, 100) / 100
  const ln = clamp(l, 0, 100) / 100
  const hue = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * ln - 1)) * sn
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = ln - c / 2
  const [rp, gp, bp] =
    hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x]
  return { r: Math.round((rp + m) * 255), g: Math.round((gp + m) * 255), b: Math.round((bp + m) * 255), a }
}

const hexByte = (value: number): string => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0')

/** `#rrggbb`, or `#rrggbbaa` when the colour is translucent. */
export const formatHex = ({ r, g, b, a }: RgbaColor): string => {
  const rgb = `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`
  return a >= 1 ? rgb : `${rgb}${hexByte(a * 255)}`
}

export const mixRgba = (base: RgbaColor, other: RgbaColor, amount: number): RgbaColor => {
  const t = clamp(amount, 0, 1)
  const lerp = (from: number, to: number) => from + (to - from) * t
  return { r: lerp(base.r, other.r), g: lerp(base.g, other.g), b: lerp(base.b, other.b), a: lerp(base.a, other.a) }
}

const RELATIVE_COLOR_PROBE = 'hsl(from red h s l)'

/** Chromium 119+ (Electron 28+) and current browsers; older browser clients get the input back. */
export const supportsRelativeColorSyntax = (): boolean =>
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('color', RELATIVE_COLOR_PROBE)

/** The same modulation expressed in CSS, for colours this module cannot parse. */
const modulateWithCss = (input: string, modulation: ColorModulation): string => {
  if (!supportsRelativeColorSyntax()) return input
  const s = modulation.saturate === undefined ? 's' : `calc(s * ${modulation.saturate})`
  const l = modulation.lighten === undefined ? 'l' : `calc(l + ${modulation.lighten})`
  const alpha = modulation.alpha === undefined ? '' : ` / calc(alpha * ${modulation.alpha})`
  const derived = `hsl(from ${input} h ${s} ${l}${alpha})`
  if (!modulation.mix) return derived
  const share = clamp(modulation.mix.amount, 0, 1) * 100
  return `color-mix(in srgb, ${derived} ${100 - share}%, ${modulation.mix.color} ${share}%)`
}

/**
 * Applies a modulation to a CSS colour and returns hex. Saturation and lightness move in HSL,
 * then the optional mix and alpha apply in RGB. An empty modulation is the identity.
 */
export const modulateColor = (input: string, modulation: ColorModulation): string => {
  const parsed = parseCssColor(input)
  if (!parsed) return modulateWithCss(input, modulation)
  let color = parsed
  if (modulation.saturate !== undefined || modulation.lighten !== undefined) {
    const hsl = rgbaToHsla(color)
    hsl.s = clamp(hsl.s * (modulation.saturate ?? 1), 0, 100)
    hsl.l = clamp(hsl.l + (modulation.lighten ?? 0), 0, 100)
    color = hslaToRgba(hsl)
  }
  if (modulation.mix) {
    const other = parseCssColor(modulation.mix.color)
    if (other) color = mixRgba(color, other, modulation.mix.amount)
  }
  if (modulation.alpha !== undefined) color = { ...color, a: clamp(color.a * modulation.alpha, 0, 1) }
  return formatHex(color)
}
