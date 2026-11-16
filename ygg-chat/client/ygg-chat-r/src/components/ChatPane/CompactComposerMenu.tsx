import React, { useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowLeft, X } from 'lucide-react'
import { getCompactComposerThemeStyle, getCompactMenuPosition } from './compactComposerPresentation'
import { useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'
import '../ActionPopover/actionPopover.css'

export type ComposerMenuPage = 'add' | 'controls' | 'activity'
export const composerMenuTitle = (page: ComposerMenuPage) => ({ add: 'Add to message', controls: 'Model and controls', activity: 'Activity' })[page]

/** Non-modal dialog: nested existing Select portals retain their keyboard/focus ownership. */
export function CompactComposerMenu({ pages, onBack, onClose, children, anchorRef, paneRef }: {
  paneRef: React.RefObject<HTMLElement | null>
  anchorRef: React.RefObject<HTMLElement | null>
  pages: ComposerMenuPage[]
  onBack: () => void
  onClose: () => void
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const sliderRef = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const parentFocus = useRef<string[]>([])
  const invokedLabel = useRef('')
  const previousDepth = useRef(0)
  const page = pages[pages.length - 1]
  useLayoutEffect(() => {
    const previous = previousDepth.current
    if (pages.length > previous && previous > 0 && document.activeElement instanceof HTMLElement) {
      parentFocus.current.push(invokedLabel.current)
    }
    if (pages.length < previous && pages.length > 0) {
      const label = parentFocus.current.pop()
      requestAnimationFrame(() => {
        const target = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(button => button.dataset.menuRow === label)
        target?.focus({ preventScroll: true })
      })
    } else if (pages.length > 0 && previous > 0) {
      ref.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    }
    if (!pages.length) parentFocus.current = []
    previousDepth.current = pages.length
  }, [pages.length, page])
  const reduced = useReducedMotion()
  const { theme, enabled } = useCustomChatTheme()
  const dark = useHtmlDarkMode()
  const open = pages.length > 0
  useLayoutEffect(() => {
    if (!open) return
    trigger.current = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    return () => {
      const target = trigger.current
      requestAnimationFrame(() => {
        if (target?.isConnected && !target.closest('[inert]')) target.focus({ preventScroll: true })
        else document.querySelector<HTMLButtonElement>('[data-quiet-add]')?.focus({ preventScroll: true })
      })
    }
  }, [open])
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const viewport = window.visualViewport
      const anchor = anchorRef.current
      if (!ref.current || !anchor) return
      const position = getCompactMenuPosition(anchor.getBoundingClientRect(), {
        top: viewport?.offsetTop ?? 0, left: viewport?.offsetLeft ?? 0,
        width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight,
        layoutHeight: window.innerHeight,
      }, page === 'activity' ? paneRef.current?.getBoundingClientRect() : undefined)
      if (contentRef.current) ref.current.style.height = `${Math.min(contentRef.current.offsetHeight + 16, position.maxHeight)}px`
      Object.entries(position).forEach(([property, value]) => {
        ref.current!.style.setProperty(property === 'maxHeight' ? 'max-height' : property, `${value}px`)
      })
    }
    update()
    const observer = new ResizeObserver(update)
    if (anchorRef.current) observer.observe(anchorRef.current)
    if (paneRef.current) observer.observe(paneRef.current)
    if (contentRef.current) observer.observe(contentRef.current)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
    }
  }, [open, anchorRef, paneRef, page])
  useLayoutEffect(() => {
    const slider = sliderRef.current
    if (!open || !slider) return
    const target = page === 'add' ? '1' : '2'
    slider.dataset.page = target === '1' ? '2' : '1'
    void slider.offsetWidth
    slider.dataset.page = target
  }, [open, page])
  useEffect(() => {
    if (!open) return
    const key = (event: KeyboardEvent) => {
      if (document.querySelector('[data-ygg-overlay="select-dropdown"], [data-ygg-overlay="expanded-model"], [data-ygg-overlay="model-info"], [data-ygg-overlay="reasoning-level"]')) return
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); onClose() }
      if (event.key === 'Tab') {
        const nodes = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? [])].filter(node => node.getClientRects().length)
        const first = nodes[0], last = nodes[nodes.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [open, onClose])
  return createPortal(<AnimatePresence>{open && <motion.div className='quiet-menu-backdrop' key='quiet-menu'
    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : .15 }}
    onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <motion.div ref={ref} role='dialog' aria-label={composerMenuTitle(pages[pages.length - 1])}
      onClickCapture={event => { invokedLabel.current = (event.target as HTMLElement).closest('button')?.dataset.menuRow ?? '' }}
      className='action-cloud quiet-menu t-resize' data-ygg-overlay='quiet-composer'
      style={enabled ? getCompactComposerThemeStyle(theme, dark) : undefined}
      initial={{ opacity: 0, scale: reduced ? 1 : .96 }} animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: reduced ? 1 : .96, transition: { duration: reduced ? 0 : .15 } }}
      transition={{ duration: reduced ? 0 : .25, ease: [.22, 1, .36, 1] }}>
      <div ref={contentRef}>
      <div className='quiet-menu-heading'>
        {pages.length > 1 && <button type='button' className='quiet-icon' onClick={onBack} title='Back' aria-label='Back to previous menu'><ArrowLeft size={18} /></button>}
        <h2>{composerMenuTitle(pages[pages.length - 1])}</h2>
        <button type='button' className='quiet-icon' onClick={onClose} title='Close' aria-label='Close composer menu'><X size={18} /></button>
      </div>
      <div ref={sliderRef} className='t-page-slide quiet-page-slide'>
        <section key={page} className='t-page' data-page-id={page === 'add' ? '1' : '2'}>{children}</section>
      </div>
      </div>
    </motion.div>
  </motion.div>}</AnimatePresence>, document.body)
}
