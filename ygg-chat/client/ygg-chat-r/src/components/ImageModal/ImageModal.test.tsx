import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ImageModal } from './ImageModal'

vi.mock('boxicons', () => ({}))
vi.mock('react-dom', () => ({ createPortal: (content: ReactNode) => content }))
vi.mock('../Button/button', () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }))

// The renderer suite runs in Node. Portals are projected inline for markup checks.
vi.stubGlobal('document', { body: {} })

describe('nested image preview layer', () => {
  it('can sit above the live monitor while keeping its dialog semantics', () => {
    const html = renderToStaticMarkup(<ImageModal isOpen imageUrl='https://example.com/image.png' onClose={() => {}} overlayZIndex={1800} />)
    expect(html).toContain('z-index:1800')
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-label="Close image preview"')
  })

  it('preserves the original layer by default and renders nothing when closed', () => {
    const html = renderToStaticMarkup(<ImageModal isOpen imageUrl='https://example.com/image.png' onClose={() => {}} />)
    expect(html).toContain('z-[1200]')
    expect(html).not.toContain('z-index:')
    expect(renderToStaticMarkup(<ImageModal isOpen={false} imageUrl='https://example.com/image.png' onClose={() => {}} />)).toBe('')
  })
})
