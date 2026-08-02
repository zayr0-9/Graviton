import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadToolOutputTruncationEnabled,
  saveToolOutputTruncationEnabled,
  TOOL_OUTPUT_PREVIEW_CHARACTER_LIMIT,
  TOOL_OUTPUT_TRUNCATION_CHANGE_EVENT,
  TOOL_OUTPUT_TRUNCATION_ENABLED_KEY,
  truncateToolOutput,
} from './toolOutputTruncation'

const installBrowserGlobals = () => {
  const store = new Map<string, string>()
  const dispatchEvent = vi.fn()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
  })
  vi.stubGlobal('window', { dispatchEvent })
  vi.stubGlobal(
    'CustomEvent',
    class<T> {
      type: string
      detail: T

      constructor(type: string, init: { detail: T }) {
        this.type = type
        this.detail = init.detail
      }
    }
  )
  return { store, dispatchEvent }
}

describe('tool output truncation preference', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults to enabled for missing or invalid stored values', () => {
    const { store } = installBrowserGlobals()
    expect(loadToolOutputTruncationEnabled()).toBe(true)

    store.set(TOOL_OUTPUT_TRUNCATION_ENABLED_KEY, 'invalid')
    expect(loadToolOutputTruncationEnabled()).toBe(true)
  })

  it('loads explicit true and false values', () => {
    const { store } = installBrowserGlobals()
    store.set(TOOL_OUTPUT_TRUNCATION_ENABLED_KEY, 'false')
    expect(loadToolOutputTruncationEnabled()).toBe(false)

    store.set(TOOL_OUTPUT_TRUNCATION_ENABLED_KEY, 'true')
    expect(loadToolOutputTruncationEnabled()).toBe(true)
  })

  it('persists and dispatches same-window changes', () => {
    const { store, dispatchEvent } = installBrowserGlobals()
    saveToolOutputTruncationEnabled(false)

    expect(store.get(TOOL_OUTPUT_TRUNCATION_ENABLED_KEY)).toBe('false')
    expect(dispatchEvent).toHaveBeenCalledTimes(1)
    expect(dispatchEvent.mock.calls[0][0]).toMatchObject({
      type: TOOL_OUTPUT_TRUNCATION_CHANGE_EVENT,
      detail: false,
    })
  })

  it('falls back safely when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('unavailable')
      },
      setItem: () => {
        throw new Error('unavailable')
      },
    })
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })

    expect(loadToolOutputTruncationEnabled()).toBe(true)
    expect(() => saveToolOutputTruncationEnabled(false)).not.toThrow()
  })
})

describe('truncateToolOutput', () => {
  it('leaves output at or below the 2,000-character budget unchanged', () => {
    for (const value of ['', 'a'.repeat(TOOL_OUTPUT_PREVIEW_CHARACTER_LIMIT - 1), 'b'.repeat(2_000)]) {
      expect(truncateToolOutput(value)).toEqual({ text: value, truncated: false, omittedCharacters: 0 })
    }
  })

  it('preserves equal head and tail previews and reports the omitted count', () => {
    const value = `${'h'.repeat(1_000)}${'m'.repeat(250)}${'t'.repeat(1_000)}`
    const result = truncateToolOutput(value)

    expect(result.truncated).toBe(true)
    expect(result.omittedCharacters).toBe(250)
    expect(result.text).toBe(`${'h'.repeat(1_000)}\n… 250 characters omitted …\n${'t'.repeat(1_000)}`)
  })

  it('handles multiline output and never splits surrogate pairs', () => {
    const value = `${'a'.repeat(999)}😀\n${'middle\n'.repeat(100)}🚀${'z'.repeat(999)}`
    const result = truncateToolOutput(value)

    expect(result.truncated).toBe(true)
    expect(result.text).toContain('characters omitted')
    expect(result.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u)
    expect(Array.from(result.text.split(/\n… [\d,]+ characters omitted …\n/)[0]).at(-1)).toBe('😀')
    expect(Array.from(result.text.split(/\n… [\d,]+ characters omitted …\n/)[1])[0]).toBe('🚀')
  })
})
