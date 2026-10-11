import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_FAST_MODE_ANIMATION, FAST_MODE_ANIMATIONS, FAST_MODE_ANIMATION_KEY,
  FAST_MODE_ANIMATION_CHANGE_EVENT, loadFastModeAnimation, normalizeFastModeAnimation, saveFastModeAnimation,
} from '../../helpers/fastModeAnimationSettings'
import { createDefaultCustomChatTheme } from '../ThemeManager/themeConfig'
import { FastModeAnimationBackground } from './FastModeAnimation'
import { getFastModePalette, resolveComposerAgentTint } from './fastModePalette'
import { FastModeAnimationSettings } from '../SettingsPane/FastModeAnimationSettings'

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
      const html = renderToStaticMarkup(<FastModeAnimationBackground animation={option.id} dark={false} operationMode='plan' />)
      expect(html).toContain(`fm-${option.id}`)
      expect(html).toContain('aria-hidden="true"')
      expect(html).toContain('viewBox="0 0 264 76"')
      expect(html).not.toContain('<button')
      expect(css).toContain(`.fm-${option.id}`)
      for (const dark of [false, true]) {
        const chat = renderToStaticMarkup(<FastModeAnimationBackground animation={option.id} dark={dark} operationMode='plan' />)
        const agent = renderToStaticMarkup(<FastModeAnimationBackground animation={option.id} dark={dark} operationMode='execute' />)
        // Only style values change: the DOM/animation classes stay stable on mode changes.
        expect(agent.replace(/style="[^"]*"/, '')).toBe(chat.replace(/style="[^"]*"/, ''))
        expect(agent).not.toBe(chat)
      }
    }
    expect(renderToStaticMarkup(<FastModeAnimationBackground animation='none' dark={false} operationMode='plan' />)).toBe('')
    expect(css).toContain('prefers-reduced-motion: reduce')
    expect(css).toContain('pointer-events: none')
    expect(css).toContain('animation-play-state: paused')
  })
  it('resolves four distinct states and reuses the actual composer Agent tint', () => {
    const states = [false, true].flatMap(dark => [getFastModePalette(dark, 'plan'), getFastModePalette(dark, 'execute')])
    expect(new Set(states.map(state => JSON.stringify(state))).size).toBe(4)
    expect(getFastModePalette(false, 'plan')).toMatchObject({ '--fm-base': 'color-mix(in srgb, #91a5c0 30%, #eef2f7)' })
    expect(getFastModePalette(true, 'execute', undefined, '#f97316')).toMatchObject({ '--fm-a': 'color-mix(in srgb, rgb(from #f97316 r g b / 1) 67%, #172336)' })
    const border = { animation: 'digital-breath', lightColor: '#123456', darkColor: '#654321' }
    expect(resolveComposerAgentTint(false, undefined, border)).toBe('#123456')
    expect(resolveComposerAgentTint(true, undefined, border)).toBe('#654321')
    expect(resolveComposerAgentTint(false, undefined, { ...border, animation: 'none' })).toBe('#93c5fd')
    expect(resolveComposerAgentTint(true, undefined, { ...border, animation: 'none' })).toBe('#c2410c')
  })
  it('uses theme surface for Chat and theme input-border accent for Agent in both appearances', () => {
    const theme = createDefaultCustomChatTheme()
    theme.colors.chatPanelBg = { light: '#edf4ee', dark: '#15291f' }
    theme.colors.chatInputAreaBorder = { light: 'rgba(44, 156, 131, 0.7)', dark: '#47b88f' }
    for (const dark of [false, true]) {
      const surface = dark ? '#15291f' : '#edf4ee'
      const accent = dark ? '#47b88f' : 'rgba(44, 156, 131, 0.7)'
      expect(resolveComposerAgentTint(dark, theme, { animation: 'none', lightColor: '#fff', darkColor: '#fff' })).toBe(accent)
      expect(getFastModePalette(dark, 'execute', theme)).toMatchObject({ '--fm-a': `color-mix(in srgb, rgb(from ${accent} r g b / 1) 67%, ${surface})` })
      expect(JSON.stringify(getFastModePalette(dark, 'plan', theme))).not.toContain(accent)
      expect(JSON.stringify(getFastModePalette(dark, 'plan', theme))).toContain(surface)
      expect(getFastModePalette(dark, 'execute', theme)).not.toEqual(getFastModePalette(dark, 'plan', theme))
    }
  })
  it('documents the independent Chat/Agent preview without enabling Fast mode', () => {
    const html = renderToStaticMarkup(<FastModeAnimationSettings />)
    expect(html).toContain('Fast mode animation')
    // Options are not mounted until expanded; no background animation work while collapsed.
    expect(html).not.toContain('fm-scene')
    const source = readFileSync(new URL('../SettingsPane/FastModeAnimationSettings.tsx', import.meta.url), 'utf8')
    expect(source).toContain('Preview operation mode')
    expect(source).toContain('operationMode={previewMode}')
    expect(source).toContain('setPreviewMode(option.mode)')
    expect(source).not.toContain('dispatch(')
  })
})
