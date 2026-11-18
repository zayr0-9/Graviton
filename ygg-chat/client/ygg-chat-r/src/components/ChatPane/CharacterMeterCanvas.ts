import { characterBin, spectrumKeys, type MeterSequence, type MeterStyle } from '../../features/chats/characterMeter'

import { createMeterPlayback } from './characterMeterPlayback'
import { createDefaultCustomChatTheme, getThemeModeColor, type CustomChatTheme } from '../ThemeManager/themeConfig'

const defaultTheme = createDefaultCustomChatTheme()
export function characterMeterPalette(theme: CustomChatTheme = defaultTheme, dark: boolean): MeterPalette {
  const c = theme.colors
  return {
    water: getThemeModeColor(c.chatProgressBarFill, dark), letters: getThemeModeColor(c.markdownSyntaxString, dark),
    digits: getThemeModeColor(c.markdownSyntaxNumber, dark), marks: getThemeModeColor(c.markdownSyntaxKeyword, dark),
    text: getThemeModeColor(c.markdownText, dark),
  }
}

export interface MeterPalette { water: string; letters: string; digits: string; marks: string; text: string }
interface Arrival { time: number; x: number; label: string; count: number }

/** Only visual ticks are paced; the numeric meter uses the immediate stream totals. */
export function createMeterCanvas(canvas: HTMLCanvasElement, style: MeterStyle, palette: MeterPalette) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const playback = createMeterPlayback()
  const spectrum = style === 'spectrum'
  let width = 0, height = 0, frame = 0, lastDraw = 0, lastHit = -Infinity, serial = 0
  let arrivals: Arrival[] = [], peaks = spectrumKeys.map(() => 0)
  const ramp = (n: number) => Math.min(1, Math.log2(1 + n) / 5)
  function paint(now: number) {
    if (!width || !height) return
    const reduced = motion.matches
    ctx.clearRect(0, 0, width, height)
    const age = now - lastHit
    const decay = reduced ? Number(age < 650) : Math.max(0, 1 - age / 850)
    const base = height - 2
    const cell = width / spectrumKeys.length
    if (spectrum) {
      for (let i = 0; i < peaks.length; i++) {
        ctx.fillStyle = i < 26 ? palette.letters : i < 36 ? palette.digits : palette.marks
        const bar = 1 + (height - 6) * peaks[i] * decay
        ctx.globalAlpha = .32 + .64 * peaks[i] * decay
        ctx.fillRect(i * cell + cell * .16, height - bar, cell * .68, bar)
      }
    } else if (style !== 'ribbon') {
      const pixel = style === 'coast', moon = style === 'moonwell'
      const wave = style === 'tide' || moon || pixel
      ctx.beginPath(); ctx.moveTo(0, height)
      for (let x = 0; x <= width + 6; x += 6) {
        const lift = wave ? 1.8 + Math.sin(x / (pixel ? 16 : 37) + (reduced ? 0 : decay * 1.8)) * (moon ? .9 : 1.6) : 0
        const y = base - (pixel ? Math.round(lift / 1.5) * 1.5 : lift)
        if (pixel) ctx.lineTo(x - 6, y)
        ctx.lineTo(x, y)
      }
      ctx.lineTo(width, height); ctx.closePath(); ctx.fillStyle = pixel ? palette.letters : palette.water
      ctx.globalAlpha = moon ? .48 : .4; ctx.fill()
    }
    arrivals = arrivals.filter(a => now - a.time < (style === 'ribbon' ? 1900 : 850))
    ctx.font = '11px ui-monospace, monospace'; ctx.textAlign = 'center'
    const tapeStep = Math.min(72, width / 8)
    for (const [index, a] of arrivals.entries()) {
      const t = now - a.time, x = a.x * width
      ctx.fillStyle = palette.text; ctx.strokeStyle = style === 'coast' ? palette.letters : palette.water
      if (style === 'ribbon') {
        ctx.globalAlpha = reduced ? .85 : Math.min(1, (1900 - t) / 500)
        const slot = arrivals.length - 1 - index
        const slide = reduced ? 0 : Math.max(0, 1 - (now - arrivals[arrivals.length - 1].time) / 180)
        ctx.fillStyle = palette.letters
        ctx.fillText(`+${a.count}`, width - (1.3 + slot - slide * .5) * tapeStep, height - 5)
      } else if (t < 340) {
        const p = reduced ? .65 : style === 'coast' ? Math.floor(t / 65) / 5 : t / 340
        ctx.globalAlpha = .85
        if (style === 'rain') {
          for (let j = 0; j < Math.min(3, a.count); j++) ctx.fillRect(x + j * 3, p * 9 + j % 2, 1, 4 + j % 2)
        } else ctx.fillText(a.label, x, 8 + p * 9)
      } else if (!spectrum && !reduced) {
        const p = (t - 340) / 510
        ctx.globalAlpha = (1 - p) * .72; ctx.beginPath()
        if (style === 'coast') {
          ctx.fillStyle = palette.letters
          ctx.fillRect(x - 3 - p * 7, base - 4 - 3 * Math.sin(p * Math.PI), 2, 2)
          ctx.fillRect(x + 3 + p * 7, base - 5 - 3 * Math.sin(p * Math.PI), 2, 2)
        } else {
          ctx.ellipse(x, base - 2, 2 + p * (style === 'moonwell' ? 21 : 9), style === 'moonwell' ? 1.8 : 1, 0, 0, 2 * Math.PI); ctx.stroke()
        }
      }
    }
    ctx.globalAlpha = 1
  }
  function tick(now: number) {
    frame = 0
    const beat = playback.next(now, motion.matches)
    if (beat) {
      const bin = characterBin(beat.glyph)
      const decay = Math.max(0, 1 - (now - lastHit) / 850)
      peaks = peaks.map((peak, i) => Math.min(1, peak * decay + (i === bin ? ramp(beat.count) : 0)))
      const label = (style === 'fragment' ? beat.fragment : beat.glyph).replace(/\s/gu, '·')
      const x = spectrum ? (bin + .5) / spectrumKeys.length : .06 + (++serial * .618034 % 1) * .87
      arrivals = arrivals.slice(-9); arrivals.push({ time: now, x, label, count: beat.count })
      lastHit = now
    }
    if (now - lastDraw >= 32 || !arrivals.length) { paint(now); lastDraw = now }
    if (playback.waiting || arrivals.length || now - lastHit <= 850) frame = requestAnimationFrame(tick)
  }
  function resize() {
    width = canvas.clientWidth; height = canvas.clientHeight
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); paint(performance.now())
  }
  const observer = new ResizeObserver(resize); observer.observe(canvas); resize()
  return {
    enqueue(sequence: MeterSequence) {
      playback.enqueue(sequence)
      if (!frame) frame = requestAnimationFrame(tick)
    },
    destroy() { observer.disconnect(); cancelAnimationFrame(frame) },
  }
}
