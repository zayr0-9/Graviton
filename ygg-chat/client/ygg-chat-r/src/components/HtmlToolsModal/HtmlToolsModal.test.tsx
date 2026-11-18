import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const registryState = vi.hoisted(() => ({ value: null as any }))
vi.mock('../HtmlIframeRegistry/HtmlIframeRegistry', () => ({
  useHtmlIframeRegistry: () => registryState.value,
  HtmlIframeSlot: ({ iframeKey }: { iframeKey: string }) => <div data-slot={iframeKey} />,
  McpAppIframeSlot: ({ iframeKey }: { iframeKey: string }) => <div data-slot={iframeKey} />,
}))
vi.mock('../ThemeManager/themeConfig', () => ({
  getThemeModeColor: () => undefined,
  useCustomChatTheme: () => ({ enabled: false, theme: { colors: {} } }),
  useHtmlDarkMode: () => false,
}))

import { HtmlToolsModal } from './HtmlToolsModal'

const entry = {
  key: 'app-1',
  kind: 'html',
  html: '<p>x</p>',
  label: 'Chart',
  favorite: false,
  status: 'active',
  sizeBytes: 8,
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: 1,
}

const makeRegistry = (overrides: Record<string, unknown> = {}) => ({
  entries: [entry],
  isModalOpen: false,
  isHomepageFullscreen: false,
  focusKey: null,
  detached: false,
  canPopOut: true,
  settings: { maxActive: 6, maxCached: 20, maxBytes: 8 * 1024 * 1024, ttlMinutes: 720, hibernateAfterMinutes: 720 },
  closeModal: vi.fn(),
  setHomepageFullscreen: vi.fn(),
  popOut: vi.fn(),
  ...overrides,
})

describe('HtmlToolsModal presentations', () => {
  beforeEach(() => {
    registryState.value = makeRegistry()
  })

  it('renders nothing as a closed modal', () => {
    expect(renderToStaticMarkup(<HtmlToolsModal />)).toBe('')
  })

  it('offers the pop-out and docking in the main window modal', () => {
    registryState.value = makeRegistry({ isModalOpen: true })
    const html = renderToStaticMarkup(<HtmlToolsModal />)
    expect(html).toContain('aria-label="Open Task Manager in a new window"')
    expect(html).toContain('Dock tool viewer to right half')
    expect(html).toContain('aria-label="Close tool viewer"')
    expect(html).toContain('data-slot="app-1"')
  })

  it('hides the pop-out when the window cannot open one', () => {
    registryState.value = makeRegistry({ isModalOpen: true, canPopOut: false })
    expect(renderToStaticMarkup(<HtmlToolsModal />)).not.toContain('Open Task Manager in a new window')
  })

  it('always shows in the apps window, without pop-out or docking, and closing returns the apps', () => {
    const html = renderToStaticMarkup(<HtmlToolsModal presentation='window' />)
    expect(html).toContain('Task Manager')
    expect(html).toContain('data-slot="app-1"')
    expect(html).not.toContain('Open Task Manager in a new window')
    expect(html).not.toContain('Dock tool viewer')
    expect(html).toContain('aria-label="Close window and return apps to the main window"')
    expect(html).not.toContain('var(--titlebar-height')
  })
})
