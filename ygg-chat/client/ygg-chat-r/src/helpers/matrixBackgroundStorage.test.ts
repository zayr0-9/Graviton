import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MATRIX_SETTINGS, loadMatrixSettings, normalizeMatrixSettings, saveMatrixSettings,
} from './matrixBackgroundStorage'
import { loadBackgroundMode, persistBackgroundMode, VIDEO_BACKGROUND_CHANGE_EVENT } from './videoBackgroundStorage'

afterEach(() => vi.unstubAllGlobals())
const installWindow = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial))
  const dispatchEvent = vi.fn()
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  }, dispatchEvent })
  return { values, dispatchEvent }
}

describe('Matrix wallpaper preferences', () => {
  it('uses bounded defaults without window or with malformed storage', () => {
    vi.stubGlobal('window', undefined)
    expect(loadMatrixSettings()).toEqual(DEFAULT_MATRIX_SETTINGS)
    installWindow({ graviton_matrix_background: '{oops' })
    expect(loadMatrixSettings()).toEqual(DEFAULT_MATRIX_SETTINGS)
    expect(normalizeMatrixSettings(null)).toEqual(DEFAULT_MATRIX_SETTINGS)
    expect(normalizeMatrixSettings({ preset: 'https://example.com', fps: 999, speed: NaN, columns: 'bad' })).toEqual(DEFAULT_MATRIX_SETTINGS)
  })

  it('allowlists presets/frame rates and clamps speed/columns', () => {
    expect(normalizeMatrixSettings({ preset: 'operator', fps: 60, speed: 99, columns: 500 })).toEqual({ preset: 'operator', fps: 60, speed: 2, columns: 120 })
    expect(normalizeMatrixSettings({ preset: 'resurrections', fps: 15, speed: -1, columns: -8 })).toEqual({ preset: 'resurrections', fps: 15, speed: 0.25, columns: 20 })
    expect(normalizeMatrixSettings({ columns: 42.8 }).columns).toBe(43)
  })

  it('persists selection and notifies the existing background channel', () => {
    const { dispatchEvent } = installWindow()
    const settings = { preset: 'operator', fps: 15, speed: 0.5, columns: 40 } as const
    saveMatrixSettings(settings)
    expect(loadMatrixSettings()).toEqual(settings)
    expect(dispatchEvent.mock.calls[0][0].type).toBe(VIDEO_BACKGROUND_CHANGE_EVENT)
    persistBackgroundMode('matrix')
    expect(loadBackgroundMode()).toBe('matrix')
    persistBackgroundMode('video')
    expect(loadBackgroundMode()).toBe('video')
    persistBackgroundMode('color')
    expect(loadBackgroundMode()).toBe('color')
  })

  it('retains old modes and fails closed on unknown mode values', () => {
    for (const mode of ['video', 'color', 'matrix', 'remote']) {
      installWindow({ yggdrasil_background_preference: JSON.stringify({ mode }) })
      expect(loadBackgroundMode()).toBe(mode === 'remote' ? 'color' : mode)
    }
  })

  it('does not report success when preferences cannot be saved', () => {
    installWindow()
    window.localStorage.setItem = () => { throw new Error('quota') }
    expect(() => saveMatrixSettings(DEFAULT_MATRIX_SETTINGS)).toThrow('quota')
  })
})
