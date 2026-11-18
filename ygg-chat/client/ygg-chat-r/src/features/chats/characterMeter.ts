import type { StreamChunk, StreamState } from './chatTypes'

export const meterStyles = {
  off: 'Off', tide: 'Tide pool', ribbon: 'Edit ribbon', moonwell: 'Moonwell', coast: 'Cartridge coast',
  letter: 'Single letter', fragment: 'Fragment', rain: 'Rain ticks', spectrum: 'Character spectrum',
} as const
export const meterScopes = { all: 'All output', tools: 'Tool calls only', edits: 'File edits only' } as const
export type MeterStyle = keyof typeof meterStyles
export type MeterScope = keyof typeof meterScopes
export const spectrumKeys = [...'abcdefghijklmnopqrstuvwxyz0123456789{}()[].,:;=+-/_', '␣', '…']
const binIndex = new Map(spectrumKeys.map((key, index) => [key, index]))
export const characterBin = (char: string) => binIndex.get(/\s/u.test(char) ? '␣' : char.toLowerCase()) ?? spectrumKeys.length - 1

export interface MeterBucket { total: number; bins: number[] }
type MeterKind = 'text' | 'tool' | 'edit' | 'nestedEdit'
export interface MeterSequence { id: number; kind: MeterKind; glyphs: string[]; count: number }
export type MeterReading = Partial<Record<MeterKind, MeterBucket>> & {
  recent?: MeterSequence[]
  textBlockTicks?: number
}
export const defaultMeterTicks = 10
export const maxMeterTicks = 100
export const normalizeMeterTicks = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(maxMeterTicks, Math.round(value))) : defaultMeterTicks
// Small transient journal: two tool calls arriving in one React commit must stay distinct.
const journalLimit = 32
export function sequencesSince(reading: MeterReading | undefined, scope: MeterScope, after: number) {
  return (reading?.recent ?? []).filter(s => s.id > after && (s.kind === 'edit' ||
    (s.kind === 'text' && scope === 'all') || (s.kind === 'tool' && scope !== 'edits') ||
    (s.kind === 'nestedEdit' && scope === 'edits')))
}
const editTools = new Set(['edit_file', 'create_file', 'multi_edit', 'edit', 'write', 'multiedit', 'notebookedit', 'apply_patch'])
const bareName = (name: string) => name.replace(/^mcp__graviton__/, '').toLowerCase()
const toolText = (args: unknown) => typeof args === 'string' ? args : JSON.stringify(args ?? {})

function add(reading: MeterReading, kind: MeterKind, text: string, budget: number) {
  if (!text) return 0
  const bucket = reading[kind] ??= { total: 0, bins: Array(spectrumKeys.length).fill(0) }
  const bins = Array<number>(spectrumKeys.length).fill(0)
  let size = 0
  for (const char of text) { bins[characterBin(char)]++; size++ }
  bins.forEach((n, i) => { if (n) bucket.bins[i] += n })
  bucket.total += size

  const ticks = Math.min(budget, size)
  if (!ticks) return 0
  // Sample in source order, including both ends. Never retain the full payload or split a surrogate pair.
  const glyphs: string[] = []
  let i = 0
  for (const char of text) {
    if (i++ === Math.floor(glyphs.length * (size - 1) / Math.max(1, ticks - 1))) glyphs.push(char)
    if (glyphs.length === ticks) break
  }
  const recent = reading.recent ??= []
  recent.push({ id: (recent.at(-1)?.id ?? 0) + 1, kind, glyphs, count: size })
  if (recent.length > journalLimit) recent.shift()
  return ticks
}

/** The transport exposes completed tool inputs, not the provider's raw JSON token stream. */
export function recordMeterChunk(stream: StreamState, chunk: StreamChunk, tickLimit: number) {
  if (chunk.type !== 'chunk' && chunk.type !== 'tool_call') return
  if (chunk.type === 'tool_call' || chunk.part === 'tool_call') {
    const call = chunk.toolCall
    if (!call?.name || stream.toolCalls.some(previous => previous.id === call.id)) return
    const name = bareName(call.name)
    const reading = stream.characterMeter ??= {}
    const payload = toolText(call.arguments)
    if (name === 'multi_call' && Array.isArray(call.arguments?.calls)) {
      // Attribute nested edit inputs to their own bucket, not the batch's wrapper or sibling reads.
      const edits = call.arguments.calls.filter((entry: { tool?: string; toolName?: string }) =>
        editTools.has(bareName(String(entry?.tool ?? entry?.toolName ?? ''))))
      // Count the complete wrapper once for tool/all scopes. The edit subset is separate.
      add(reading, 'tool', payload, tickLimit)
      for (const entry of edits) add(reading, 'nestedEdit', toolText(entry.args), tickLimit)
    } else add(reading, editTools.has(name) ? 'edit' : 'tool', payload, tickLimit)
  } else if (chunk.part === 'text' || chunk.part === 'reasoning' || !chunk.part) {
    const text = chunk.delta ?? chunk.content
    if (typeof text === 'string' && text) {
      const reading = stream.characterMeter ??= {}
      const sameBlock = stream.events.at(-1)?.type === (chunk.part ?? 'text')
      const used = sameBlock ? reading.textBlockTicks ?? 0 : 0
      reading.textBlockTicks = used + add(reading, 'text', text, Math.max(0, tickLimit - used))
    }
  }
}

export function summarizeMeter(reading: MeterReading | undefined, scope: MeterScope): MeterBucket {
  const result: MeterBucket = { total: 0, bins: Array(spectrumKeys.length).fill(0) }
  for (const bucket of [scope === 'all' && reading?.text, scope !== 'edits' && reading?.tool, reading?.edit, scope === 'edits' && reading?.nestedEdit]) {
    if (!bucket) continue
    result.total += bucket.total
    bucket.bins.forEach((n, i) => { result.bins[i] += n })
  }
  return result
}
