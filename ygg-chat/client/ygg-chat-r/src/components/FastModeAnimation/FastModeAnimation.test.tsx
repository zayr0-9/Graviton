import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_FAST_MODE_ANIMATION, FAST_MODE_ANIMATIONS, FAST_MODE_ANIMATION_KEY,
  FAST_MODE_ANIMATION_CHANGE_EVENT, loadFastModeAnimation, normalizeFastModeAnimation, saveFastModeAnimation,
} from '../../helpers/fastModeAnimationSettings'
import { createDefaultCustomChatTheme } from '../ThemeManager/themeConfig'
import { FastModeAnimationBackground } from './FastModeAnimation'
import { getFastModePalette } from './fastModePalette'

const css = readFileSync(new URL('./fastModeAnimation.css', import.meta.url), 'utf8')
afterEach(() => vi.unstubAllGlobals())

describe('fast-mode animation settings', () => {
  it('offers all sixteen approved studies and defaults to Tidal glass', () => {
    expect(FAST_MODE_ANIMATIONS).toHaveLength(16)
    expect(new Set(FAST_MODE_ANIMATIONS.map(option => option.id)).size).toBe(16)
    expect(DEFAULT_FAST_MODE_ANIMATION).toBe('tidal-glass')
    for (const option of FAST_MODE_ANIMATIONS) expect(normalizeFastModeAnimation(option.id)).toBe(option.id)
    expect(normalizeFastModeAnimation('none')).toBe('none')
    for (const value of [null, undefined, 'pixel-aurora', {}, 5]) {
      expect(normalizeFastModeAnimation(value)).toBe(DEFAULT_FAST_MODE_ANIMATION)
    }
  })
  it('persists IDs and broadcasts same-window changes even if storage fails', () => {
    const values = new Map<string, string>()
    const dispatchEvent = vi.fn()
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) })
    vi.stubGlobal('window', { dispatchEvent })
    vi.stubGlobal('CustomEvent', class { constructor(public type: string, public options: { detail: string }) {} })
    expect(loadFastModeAnimation()).toBe('tidal-glass')
    saveFastModeAnimation('pixel-rain')
    expect(values.get(FAST_MODE_ANIMATION_KEY)).toBe('pixel-rain')
    expect(loadFastModeAnimation()).toBe('pixel-rain')
    expect(dispatchEvent.mock.calls[0][0]).toMatchObject({ type: FAST_MODE_ANIMATION_CHANGE_EVENT, options: { detail: 'pixel-rain' } })
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
    expect(loadFastModeAnimation()).toBe('tidal-glass')
    expect(() => saveFastModeAnimation('none')).not.toThrow()
    expect(dispatchEvent).toHaveBeenCalledTimes(2)
  })
})

describe('fast-mode backgrounds', () => {
  it('renders each effect as a non-interactive decorative layer with matching CSS', () => {
    for (const option of FAST_MODE_ANIMATIONS) {
      const html = renderToStaticMarkup(<FastModeAnimationBackground animation={option.id} dark={false} />)
      expect(html).toContain(`fm-${option.id}`)
      expect(html).toContain('aria-hidden="true"')
      expect(html).toContain('viewBox="0 0 264 76"')
      expect(html).not.toContain('<button')
      expect(css).toContain(`.fm-${option.id}`)
      expect(getFastModePalette(option.id, false)).toMatchObject({ '--fm-base': option.colors[0], '--fm-a': option.colors[1] })
    }
    expect(renderToStaticMarkup(<FastModeAnimationBackground animation='none' dark={false} />)).toBe('')
    expect(css).toContain('prefers-reduced-motion: reduce')
    expect(css).toContain('pointer-events: none')
    expect(css).toContain('animation-play-state: paused')
  })
  it('borrows the active theme keys in each mode, without changing the theme schema', () => {
    const theme = createDefaultCustomChatTheme()
    theme.colors.composerToggleActiveBg = { light: '#112233', dark: '#223344' }
    theme.colors.sendButtonAnimationColor = { light: '#345678', dark: '#456789' }
    theme.colors.chatProgressBarFill = { light: '#567890', dark: '#678901' }
    theme.colors.composerToggleActiveBorder = { light: '#789012', dark: '#890123' }
    theme.colors.chatPanelBg.dark = '#101010'
    const light = getFastModePalette('solar', false, theme)
    expect(light).toMatchObject({ '--fm-base': '#112233', '--fm-a': '#345678', '--fm-b': '#567890', '--fm-c': '#789012' })
    const dark = getFastModePalette('solar', true, theme)
    expect(dark).toMatchObject({ '--fm-base': 'color-mix(in srgb, #223344 38%, #101010)', '--fm-a': 'color-mix(in srgb, #456789 65%, #101010)' })
    expect(getFastModePalette('tidal-glass', true)).toMatchObject({ '--fm-a': 'color-mix(in srgb, #b4c8e4 65%, #162338)' })
  })
})
