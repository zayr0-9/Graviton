import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlanMdToolView } from './PlanMdToolView'

const harness = vi.hoisted(() => ({
  stateIndex: 0,
  effects: [] as Array<() => unknown>,
  keydown: null as ((event: KeyboardEvent) => void) | null,
  portalKeydown: null as ((event: React.KeyboardEvent) => void) | null,
  post: vi.fn(),
}))
// Start in fullscreen with a dirty draft to exercise the save guard, not only
// the absence of buttons. No DOM-test dependency is required for these checks.
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = harness.stateIndex++
      return actual.useState(index === 0 ? true : index === 3 ? '# Changed draft' : initial)
    },
    useEffect: (effect: () => unknown) => { harness.effects.push(effect) },
    useLayoutEffect: (effect: () => unknown) => { harness.effects.push(effect) },
  }
})
vi.mock('react-dom', () => ({ createPortal: (children: React.ReactNode) => children }))
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  useReducedMotion: () => true,
  motion: { div: ({ children, onKeyDown, className }: React.HTMLAttributes<HTMLDivElement>) => {
    if (className?.includes('fixed inset-0')) harness.portalKeydown = onKeyDown ?? null
    return <div className={className}>{children}</div>
  } },
}))
vi.mock('../motion', () => ({
  motionState: () => ({}),
  useMotionPreferences: () => ({ reducedMotion: true }),
}))
vi.mock('../ThemeManager/themeConfig', () => ({
  useCustomChatTheme: () => ({ theme: {}, enabled: false }),
  useHtmlDarkMode: () => false,
}))
vi.mock('../MarkdownContent/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}))
vi.mock('../../utils/api', () => ({ localApi: { post: harness.post } }))

beforeEach(() => {
  harness.stateIndex = 0
  harness.effects = []
  harness.keydown = null
  harness.portalKeydown = null
  harness.post.mockReset()
  vi.stubGlobal('document', {
    body: { style: { overflow: '' } },
    addEventListener: (name: string, handler: (event: KeyboardEvent) => void) => {
      if (name === 'keydown') harness.keydown = handler
    },
    removeEventListener: vi.fn(),
  })
  vi.stubGlobal('window', { requestAnimationFrame: vi.fn() })
})

afterEach(() => vi.unstubAllGlobals())

const renderPlan = (readOnly: boolean) => renderToStaticMarkup(
  <PlanMdToolView readOnly={readOnly} result={{ name: 'design', path: '/design.md', exists: true, content: '# Plan' }} />
)

describe('inspection-only plan viewer', () => {
  it('keeps fullscreen/zoom, hides editing and saving, and layers above the pill', () => {
    const html = renderPlan(true)
    expect(html).toContain('Open fullscreen plan')
    expect(html).toContain('Zoom in')
    expect(html).toContain('z-[1800]')
    expect(html).not.toContain('Edit raw Markdown')
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('Save plan')
    for (const effect of harness.effects) effect()
    harness.keydown?.({ key: 's', metaKey: true, preventDefault: vi.fn() } as unknown as KeyboardEvent)
    expect(harness.post).not.toHaveBeenCalled()
  })

  it('preserves edit/save controls in normal chat', () => {
    const html = renderPlan(false)
    expect(html).toContain('Edit raw Markdown')
    expect(html).toContain('Save plan')
    expect(html).toContain('z-[1200]')
  })

  it('stops fullscreen Escape from reaching the underlying pill preview', () => {
    renderPlan(true)
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    harness.portalKeydown?.({ key: 'Escape', preventDefault, stopPropagation } as unknown as React.KeyboardEvent)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(stopPropagation).toHaveBeenCalledOnce()
  })
})
