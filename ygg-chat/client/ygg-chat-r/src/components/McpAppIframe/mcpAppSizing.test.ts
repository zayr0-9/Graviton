import { beforeEach, describe, expect, it, vi } from 'vitest'

// Node environment: install minimal browser globals before the module evaluates.
vi.hoisted(() => {
  const globals = globalThis as unknown as Record<string, unknown>
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  }
  globals.localStorage = storage
  globals.window = Object.assign(new EventTarget(), { localStorage: storage, innerWidth: 1280 })
})

import {
  buildMcpAppContainerDimensions,
  getMcpAppHeight,
  loadMcpAppConstraintsEnabled,
  MCP_APP_DEFAULT_HEIGHT,
  MCP_APP_MAX_HEIGHT,
  MCP_APP_MIN_HEIGHT,
  rememberMcpAppHeight,
  saveMcpAppConstraintsEnabled,
} from './mcpAppSizing'

beforeEach(() => saveMcpAppConstraintsEnabled(true))

describe('MCP app native size constraints', () => {
  it('are on by default and clamp requests to the native range', () => {
    localStorage.removeItem('chat:mcpAppNativeConstraints')
    expect(loadMcpAppConstraintsEnabled()).toBe(true)
    expect(rememberMcpAppHeight('tall', 1200)).toBe(MCP_APP_MAX_HEIGHT)
    expect(rememberMcpAppHeight('short', 80)).toBe(MCP_APP_MIN_HEIGHT)
    expect(buildMcpAppContainerDimensions()).toEqual({ width: 1280, maxHeight: MCP_APP_MAX_HEIGHT })
  })

  it('use the requested height when switched off, and re-apply on read when switched back', () => {
    rememberMcpAppHeight('app', 1200)
    expect(getMcpAppHeight('app')).toBe(MCP_APP_MAX_HEIGHT)

    saveMcpAppConstraintsEnabled(false)
    expect(getMcpAppHeight('app')).toBe(1200)
    expect(rememberMcpAppHeight('small', 80)).toBe(80)
    expect(buildMcpAppContainerDimensions()).toEqual({ width: 1280 })

    saveMcpAppConstraintsEnabled(true)
    expect(getMcpAppHeight('app')).toBe(MCP_APP_MAX_HEIGHT)
    expect(getMcpAppHeight('small')).toBe(MCP_APP_MIN_HEIGHT)
  })

  it('still reject nonsensical heights when switched off', () => {
    saveMcpAppConstraintsEnabled(false)
    expect(rememberMcpAppHeight('zero', 0)).toBe(1)
    expect(rememberMcpAppHeight('huge', 5_000_000)).toBe(10_000)
    expect(getMcpAppHeight('never-reported')).toBe(MCP_APP_DEFAULT_HEIGHT)
  })

  it('notifies subscribers when the setting changes', () => {
    const listener = vi.fn()
    window.addEventListener('mcpAppNativeConstraintsChange', listener)
    saveMcpAppConstraintsEnabled(false)
    window.removeEventListener('mcpAppNativeConstraintsChange', listener)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
