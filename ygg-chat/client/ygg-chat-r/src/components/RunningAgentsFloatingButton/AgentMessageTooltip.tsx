import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'

/** Portal escapes the pill's animated overflow/mask and scroll containers. */
export function AgentMessageTooltip({ text, children }: { text: string; children: ReactNode }) {
  const id = useId()
  const anchorRef = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)
  const { theme, enabled } = useCustomChatTheme()
  const dark = useHtmlDarkMode()
  const cancelClose = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  const closeSoon = () => {
    cancelClose()
    timer.current = setTimeout(() => setPosition(null), 120)
  }
  const open = () => {
    cancelClose()
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(400, window.innerWidth - 24)
    const above = rect.top > window.innerHeight / 2
    setPosition({
      left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
      top: above ? rect.top - 8 : rect.bottom + 8,
      width,
      maxHeight: Math.max(48, Math.min(320, above ? rect.top - 20 : window.innerHeight - rect.bottom - 20)),
    })
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  useEffect(() => {
    if (!position) return
    const close = () => setPosition(null)
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    // Scroll inside the tooltip is intentional; scrolling the underlying list dismisses it.
    const onScroll = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('[role="tooltip"]')) return
      close()
    }
    window.addEventListener('resize', close)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [position])

  const above = position && anchorRef.current && position.top < anchorRef.current.getBoundingClientRect().top
  return (
    <span ref={anchorRef} className='block min-w-0' tabIndex={0} aria-label='Full user message'
      aria-describedby={position ? id : undefined}
      onMouseEnter={open} onMouseLeave={closeSoon} onFocus={open} onBlur={closeSoon}
      onClick={() => setPosition(null)}>
      {children}
      {position && createPortal(
        <div id={id} role='tooltip'
          className='fixed z-[1800] overflow-y-auto overscroll-contain whitespace-pre-wrap break-words rounded-xl border p-3 text-left text-xs leading-relaxed shadow-xl thin-scrollbar'
          style={{ ...position, transform: above ? 'translateY(-100%)' : undefined,
            backgroundColor: enabled ? getThemeModeColor(theme.colors.settingsCustomThemesCardBg, dark) : dark ? '#171717' : '#ffffff',
            borderColor: enabled ? getThemeModeColor(theme.colors.settingsCustomThemesCardBorder, dark) : dark ? '#404040' : '#e5e5e5',
            color: enabled ? getThemeModeColor(theme.colors.toolJobsPrimaryText, dark) : dark ? '#f5f5f5' : '#171717',
          }}
          onMouseEnter={cancelClose} onMouseLeave={closeSoon}
          onClick={event => event.stopPropagation()}>
          {text}
        </div>, document.body
      )}
    </span>
  )
}
