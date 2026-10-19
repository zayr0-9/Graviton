import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  native: true,
  enabled: true,
  colors: { light: '#123456', dark: '#654321' },
  backgroundColors: { light: '#fefefe', dark: '#121212' },
  mode: 'color' as 'color' | 'video',
  activeVideo: null as { id: string; mimeType: string } | null,
  activeVideoUrl: null as string | null,
  baseColors: { light: 'transparent', dark: 'transparent' },
}))

vi.mock('../platform/clientCapabilities', () => ({ get isNativeShell() { return state.native } }))

vi.mock('./ThemeManager/themeConfig', () => ({
  useCustomChatTheme: () => ({ enabled: state.enabled, theme: { colors: { appBackgroundColor: state.colors } } }),
  getThemeModeColor: (pair: { light: string; dark: string }, dark: boolean) => dark ? pair.dark : pair.light,
}))

vi.mock('../helpers/videoBackgroundStorage', () => ({
  DEFAULT_BACKGROUND_COLORS: state.baseColors,
  VIDEO_BACKGROUND_CHANGE_EVENT: 'background-change',
  loadBackgroundMode: () => state.mode,
  loadBackgroundColors: () => state.backgroundColors,
  loadActiveCustomVideoId: () => state.activeVideo?.id ?? null,
  loadActiveCustomVideo: () => state.activeVideo,
  loadCustomVideoBlobUrl: vi.fn(),
  getActiveTextColorMode: () => 'auto',
}))

// Static rendering does not run effects: model the URL resolved by the video
// loading effect so the existing active-wallpaper branch is covered as well.
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: (initial: unknown) => actual.useState(initial === null ? state.activeVideoUrl : initial),
  }
})

import VideoBackground from './VideoBackground'

afterEach(() => {
  vi.unstubAllGlobals()
  state.native = true
  state.enabled = true
  state.colors = { light: '#123456', dark: '#654321' }
  state.mode = 'color'
  state.activeVideo = null
  state.activeVideoUrl = null
  state.baseColors.light = 'transparent'
  state.baseColors.dark = 'transparent'
})

const renderBackground = (dark = false) => {
  vi.stubGlobal('CSS', { supports: () => true })
  vi.stubGlobal('document', { documentElement: { classList: { contains: () => dark } } })
  return renderToStaticMarkup(<VideoBackground />)
}

describe('custom-theme background tint', () => {
  it.each([false, true])('keeps a transparent base and applies light/dark gradient colors (dark=%s)', dark => {
    const html = renderBackground(dark)
    const rgb = dark ? '101, 67, 33' : '18, 52, 86'
    expect(html).toContain('background-color:transparent')
    expect(html).toContain(`radial-gradient(ellipse at 16% 0%, rgba(${rgb}, 0.18), transparent 65%)`)
    expect(html).toContain(`linear-gradient(135deg, rgba(${rgb}, 0.08), transparent 70%)`)
    expect(html).toContain('pointer-events-none')
    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toContain('opacity:')
  })

  it.each(['oklch(60% 0.1 150)', 'rgba(20, 100, 50, 0.5)', '#abc', 'transparent'])('supports CSS theme colors including existing transparency: %s', color => {
    state.colors.light = color
    const html = renderBackground()
    expect(html).toContain(`color-mix(in srgb, ${color} 18%, transparent)`)
    expect(html).toContain(`color-mix(in srgb, ${color} 8%, transparent)`)
  })

  it.each([false, true])('preserves user-selected background colors when custom themes are disabled (dark=%s)', dark => {
    state.enabled = false
    const html = renderBackground(dark)
    expect(html).toContain(`background-color:${dark ? '#121212' : '#fefefe'}`)
    expect(html).not.toContain('gradient')
  })

  it('retains the opaque platform fallback beneath the tint on Linux', () => {
    state.baseColors.dark = '#0C0A09'
    const html = renderBackground(true)
    expect(html).toContain('background-color:#0C0A09')
    expect(html).toContain('radial-gradient')
  })

  it('leaves active video wallpapers unchanged', () => {
    state.mode = 'video'
    state.activeVideo = { id: 'wallpaper', mimeType: 'video/mp4' }
    state.activeVideoUrl = 'blob:wallpaper'
    const html = renderBackground()
    expect(html).toContain('<video')
    expect(html).toContain('src="blob:wallpaper"')
    expect(html).not.toContain('gradient')
  })

  it('uses the tinted fallback while a video has not loaded', () => {
    state.mode = 'video'
    state.activeVideo = { id: 'wallpaper', mimeType: 'video/mp4' }
    const html = renderBackground()
    expect(html).not.toContain('<video')
    expect(html).toContain('background-color:transparent')
    expect(html).toContain('radial-gradient')
  })
})

describe('forced solid browser background', () => {
  it.each([false, true])('uses the actual custom theme color, not a translucent tint (dark=%s)', dark => {
    state.native = false
    const html = renderBackground(dark)
    expect(html).toContain(`background-color:rgb(from ${dark ? '#654321' : '#123456'} r g b / 1)`)
    expect(html).not.toContain('gradient')
  })
  it.each(['transparent', 'rgba(10, 20, 30, 0.1)', '#12345600'])('cannot enable transparency with theme color %s', color => {
    state.native = false
    state.colors.dark = color
    const html = renderBackground(true)
    expect(html).toContain(color === 'transparent' ? 'background-color:#0C0A09' : `background-color:rgb(from ${color} r g b / 1)`)
  })
  it('ignores saved video mode and transparent background preferences in browser delivery', () => {
    state.native = false
    state.enabled = false
    state.backgroundColors.dark = 'transparent'
    state.mode = 'video'
    state.activeVideo = { id: 'wallpaper', mimeType: 'video/mp4' }
    state.activeVideoUrl = 'blob:wallpaper'
    const html = renderBackground(true)
    expect(html).not.toContain('<video')
    expect(html).toContain('background-color:#0C0A09')
    state.backgroundColors.dark = '#121212'
  })
})
