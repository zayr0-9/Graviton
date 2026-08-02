import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../config/runtimeMode', () => ({ isElectronMode: true }))

import { isResumableRunsEnabled, setResumableRunsEnabled } from './serverLoopSettings'

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

describe('resumable run settings', () => {
  beforeEach(() => installMemoryLocalStorage())

  it('defaults on in Electron', () => {
    expect(isResumableRunsEnabled()).toBe(true)
  })

  it('persists explicit enable and disable values', () => {
    setResumableRunsEnabled(false)
    expect(localStorage.getItem('ygg.resumableRuns')).toBe('false')
    expect(isResumableRunsEnabled()).toBe(false)

    setResumableRunsEnabled(true)
    expect(localStorage.getItem('ygg.resumableRuns')).toBe('true')
    expect(isResumableRunsEnabled()).toBe(true)
  })

  it('falls back to the Electron default when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('unavailable')
      },
      setItem: () => {
        throw new Error('unavailable')
      },
    })
    expect(isResumableRunsEnabled()).toBe(true)
    expect(() => setResumableRunsEnabled(false)).not.toThrow()
  })
})
