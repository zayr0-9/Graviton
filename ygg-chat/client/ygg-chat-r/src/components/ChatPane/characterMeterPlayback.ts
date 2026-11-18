import type { MeterSequence } from '../../features/chats/characterMeter'

/** Visual-only FIFO. Drive it from the canvas clock, never from the tool/stream lifecycle. */
export function createMeterPlayback() {
  const pending: MeterSequence[] = []
  let index = 0, due = 0
  return {
    enqueue(sequence: MeterSequence) {
      if (!sequence.glyphs.length) return
      // Under sustained overload keep the active sequence and the newest pending work.
      if (pending.length >= 12) pending.splice(1, 1)
      pending.push(sequence)
    },
    next(now: number, reduced: boolean) {
      const seq = pending[0]
      if (!seq || now < due) return null
      const start = index, length = seq.glyphs.length
      index = reduced ? length : index + 1
      const glyph = seq.glyphs[start]
      const fragment = seq.glyphs.slice(Math.max(0, start - 2), start + 1).join('')
      const count = Math.floor(seq.count * index / length) - Math.floor(seq.count * start / length)
      const done = index === length
      due = now + (done ? 100 : pending.length > 3 ? 40 : 75)
      if (done) { pending.shift(); index = 0 }
      return { glyph, fragment, count }
    },
    get waiting() { return pending.length > 0 },
  }
}
