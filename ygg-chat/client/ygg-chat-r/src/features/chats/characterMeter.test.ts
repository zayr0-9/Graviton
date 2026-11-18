import { describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { createMeterPlayback } from '../../components/ChatPane/characterMeterPlayback'
import { characterBin, meterStyles, sequencesSince, summarizeMeter } from './characterMeter'
import { characterMeterPalette } from '../../components/ChatPane/CharacterMeterCanvas'
import { createDefaultCustomChatTheme } from '../../components/ThemeManager/themeConfig'
import { loadMeterPreferences } from '../../helpers/characterMeterSettings'
vi.hoisted(() => { Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: vi.fn(() => null) } }) })
import chatReducer, { chatSliceActions as chat } from './chatSlice'

function setup() {
  const store = configureStore({ reducer: chatReducer })
  const streamId = 's'
  store.dispatch(chat.sendingStarted({ streamId, conversationId: 'c' }))
  return {
    store, emit: (chunk: object) => store.dispatch(chat.streamChunkReceived({ streamId, chunk })),
    reading: () => store.getState().streaming.byId.s.characterMeter,
    enable: (limit = 10) => store.dispatch(chat.characterMeterTickLimitSet(limit)),
  }
}
const tool = (name: string, args: object, id = name) => ({ type: 'chunk', part: 'tool_call', toolCall: { name, arguments: args, id } })

describe('output character meter', () => {
  it('is opt-in; all counts only observed model text, reasoning and serialized tool inputs', () => {
    const { emit, reading, enable, store } = setup()
    emit({ type: 'chunk', part: 'text', delta: 'ignored' }); expect(reading()).toBeUndefined()
    enable(); emit({ type: 'chunk', part: 'text', delta: 'Aa🙂\n' }); emit({ type: 'chunk', part: 'reasoning', delta: '2' })
    const args = { path: 'a', content: 'z' }
    emit(tool('create_file', args)); emit(tool('create_file', args)); emit(tool('Read', {}))
    emit({ type: 'chunk', part: 'tool_result', toolResult: { tool_use_id: 'Read', content: 'not output' } })
    emit({ type: 'generation_started' }); store.dispatch(chat.sendingCompleted({ streamId: 's' }))
    emit({ type: 'chunk', part: 'text', delta: 'late' })
    const n = JSON.stringify(args).length
    const all = summarizeMeter(reading(), 'all')
    expect(all.total).toBe(5 + n + 2); expect(all.bins.reduce((a, b) => a + b)).toBe(all.total)
    expect(all.bins[characterBin('🙂')]).toBeGreaterThan(0); expect(all.bins[characterBin(' ')]).toBe(1)
    expect(summarizeMeter(reading(), 'tools').total).toBe(n + 2); expect(summarizeMeter(reading(), 'edits').total).toBe(n)
  })
  it('attributes only the matching nested inputs to edits without double-counting the batch', () => {
    const { enable, emit, reading } = setup(); enable()
    const edit = { path: 'one', replacement: 'new' }
    const batch = { calls: [{ toolName: 'mcp__graviton__edit_file', args: edit }, { tool: 'read_file', args: {} }] }
    emit(tool('multi_call', batch))
    expect(summarizeMeter(reading(), 'edits').total).toBe(JSON.stringify(edit).length)
    expect(summarizeMeter(reading(), 'all').total).toBe(JSON.stringify(batch).length)
  })
  it('plays sampled tool characters in order across batched calls, while the count is already final', () => {
    const { enable, emit, reading } = setup(); enable()
    const text = '😀' + '0123456789'.repeat(200) + '終'
    emit({ ...tool('edit_file', {}), toolCall: { id: '1', name: 'edit_file', arguments: text } })
    emit(tool('Read', {})); emit(tool('Read', {}))
    const calls = sequencesSince(reading(), 'tools', 0)
    expect(calls).toHaveLength(2)
    expect(sequencesSince(reading(), 'edits', 0)).toEqual([calls[0]])
    expect(sequencesSince(reading(), 'tools', calls[0].id)).toEqual([calls[1]])
    const chars = [...text]
    expect(calls[0].glyphs).toEqual(Array.from({ length: 10 }, (_, i) => chars[Math.floor(i * (chars.length - 1) / 9)]))
    const total = summarizeMeter(reading(), 'tools').total
    expect(total).toBe(chars.length + 2)
    const player = createMeterPlayback(); player.enqueue(calls[0])
    const first = player.next(0, false); player.enqueue(calls[1]); expect(player.next(1, false)).toBeNull()
    const ticks = [first]
    for (let time = 1; player.waiting && time < 3000; time++) {
      const tick = player.next(time, false); if (tick) ticks.push(tick)
    }
    expect(ticks.map(t => t.glyph)).toEqual([...calls[0].glyphs, '{', '}'])
    expect(ticks.reduce((sum, t) => sum + t.count, 0)).toBe(total)
    player.enqueue(calls[0]); expect(player.next(4000, true)?.count).toBe(chars.length); expect(player.waiting).toBe(false)
  })
  it('caps contiguous text and reasoning blocks independently, not each transport delta', () => {
    const { enable, emit, reading } = setup(); enable()
    for (let i = 0; i < 6; i++) emit({ type: 'chunk', part: 'text', delta: 'abcd' })
    emit({ type: 'chunk', part: 'reasoning', delta: '0123456789AB' })
    emit({ type: 'chunk', part: 'text', delta: 'é' })
    expect(sequencesSince(reading(), 'all', 0).flatMap(s => s.glyphs)).toHaveLength(21)
    expect(summarizeMeter(reading(), 'all').total).toBe(37)
    expect(sequencesSince(reading(), 'tools', 0)).toEqual([])
  })
  it('uses the configured animation limit without changing counts when lowered mid-block', () => {
    const { enable, emit, reading } = setup(); enable(24)
    const args = { content: 'x'.repeat(120) }
    emit(tool('create_file', args)); emit({ type: 'chunk', part: 'text', delta: '12345678' })
    enable(2); emit({ type: 'chunk', part: 'text', delta: 'abc' })
    emit({ type: 'chunk', part: 'reasoning', delta: 'abcd' })
    emit(tool('multi_call', { calls: [{ tool: 'edit_file', args }] }))
    expect(sequencesSince(reading(), 'all', 0).map(s => s.glyphs.length)).toEqual([24, 8, 2, 2])
    expect(sequencesSince(reading(), 'edits', 0).map(s => s.glyphs.length)).toEqual([24, 2])
    expect(reading().text.total).toBe(15)
  })
  it.each([[42, 42], [0, 1], [900, 100], [2.6, 3], ['bad', 10]])('loads a bounded playback limit (%s)', (value, expected) => {
    vi.mocked(localStorage.getItem).mockReturnValueOnce(JSON.stringify({ tickLimit: value }))
    expect(loadMeterPreferences().tickLimit).toBe(expected)
  })
  it('does not replay arrivals or count another stream', () => {
    const { enable, emit, reading, store } = setup(); enable(); emit({ type: 'chunk', part: 'text', delta: 'ab' })
    store.dispatch(chat.streamBootstrapReset({ streamId: 's', conversationId: 'c' }))
    emit({ type: 'chunk', part: 'text', delta: 'ab' })
    store.dispatch(chat.sendingStarted({ streamId: 'other' }))
    store.dispatch(chat.streamChunkReceived({ streamId: 'other', chunk: { type: 'chunk', part: 'text', delta: 'elsewhere' } }))
    expect(summarizeMeter(reading(), 'all').total).toBe(2)
  })
  it.each([false, true])('resolves every palette entry from the active appearance (dark=%s)', dark => {
    const theme = createDefaultCustomChatTheme(), mode = dark ? 'dark' : 'light'
    const expected = () => ({ water: theme.colors.chatProgressBarFill[mode], letters: theme.colors.markdownSyntaxString[mode],
      digits: theme.colors.markdownSyntaxNumber[mode], marks: theme.colors.markdownSyntaxKeyword[mode], text: theme.colors.markdownText[mode] })
    expect(characterMeterPalette(undefined, dark)).toEqual(expected())
    theme.colors.markdownSyntaxString = { light: '#314144', dark: '#afd7cf' }
    expect(characterMeterPalette(theme, dark)).toEqual(expected())
  })
  it('defaults to off and accepts all eight persisted styles', () => {
    expect(loadMeterPreferences()).toEqual({ style: 'off', scope: 'all', tickLimit: 10 })
    for (const style of Object.keys(meterStyles)) {
      vi.mocked(localStorage.getItem).mockReturnValueOnce(JSON.stringify({ style, scope: 'edits' }))
      expect(loadMeterPreferences()).toEqual({ style, scope: 'edits', tickLimit: 10 })
    }
    vi.mocked(localStorage.getItem).mockReturnValueOnce('{bad')
    expect(loadMeterPreferences().style).toBe('off')
  })
})
