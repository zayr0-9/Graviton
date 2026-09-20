import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  MAX_STREAM_IDLE_TIMEOUT_MS,
  MIN_STREAM_IDLE_TIMEOUT_MS,
  getStreamIdleTimeoutMs,
  loadToolExecutionSettings,
  saveToolExecutionSettings,
} from './toolExecutionSettings'

function installMemoryLocalStorage(): void {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size
    },
  })
}

describe('tool execution settings', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    installMemoryLocalStorage()
  })

  it('defaults the chat stream idle timeout to 120 seconds', () => {
    expect(DEFAULT_STREAM_IDLE_TIMEOUT_MS).toBe(120_000)
    expect(loadToolExecutionSettings().streamIdleTimeoutMs).toBe(120_000)
    expect(getStreamIdleTimeoutMs()).toBe(120_000)
  })

  it('hydrates older saved settings with the new default', () => {
    localStorage.setItem(
      'ygg_tool_execution_settings',
      JSON.stringify({ toolCallTimeoutMs: 90_000, bashTimeoutMs: 60_000 })
    )

    expect(loadToolExecutionSettings()).toMatchObject({
      toolCallTimeoutMs: 90_000,
      streamIdleTimeoutMs: 120_000,
      bashTimeoutMs: 60_000,
    })
  })

  it('clamps the persisted stream idle timeout to the supported range', () => {
    saveToolExecutionSettings({
      toolCallTimeoutMs: 60_000,
      streamIdleTimeoutMs: MIN_STREAM_IDLE_TIMEOUT_MS - 1,
      bashTimeoutMs: 60_000,
    })
    expect(loadToolExecutionSettings().streamIdleTimeoutMs).toBe(MIN_STREAM_IDLE_TIMEOUT_MS)

    saveToolExecutionSettings({
      toolCallTimeoutMs: 60_000,
      streamIdleTimeoutMs: MAX_STREAM_IDLE_TIMEOUT_MS + 1,
      bashTimeoutMs: 60_000,
    })
    expect(loadToolExecutionSettings().streamIdleTimeoutMs).toBe(MAX_STREAM_IDLE_TIMEOUT_MS)
  })
})
