import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Check, Settings2 } from 'lucide-react'
import { opaqueAppBackground } from '../../helpers/opaqueAppBackground'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'
import { AGENT_GRID_ORDER_MODES, type AgentGridOrderMode } from './agentGridLayout'

const ORDER_MODE_STORAGE_KEY = 'agents:gridOrderMode'

export function readAgentGridOrderMode(): AgentGridOrderMode {
  try {
    const saved = localStorage.getItem(ORDER_MODE_STORAGE_KEY)
    return AGENT_GRID_ORDER_MODES.includes(saved as AgentGridOrderMode) ? saved as AgentGridOrderMode : 'rows'
  } catch { return 'rows' }
}

export function writeAgentGridOrderMode(mode: AgentGridOrderMode) {
  try { localStorage.setItem(ORDER_MODE_STORAGE_KEY, mode) } catch { /* preference stays session-only */ }
}

const OPTIONS: { mode: AgentGridOrderMode; label: string; detail: string }[] = [
  { mode: 'rows', label: 'Move between rows', detail: 'Active forks rise to the top row. Cards never swap columns within a row.' },
  { mode: 'locked', label: 'Lock positions', detail: 'Cards stay where they are. New forks are added at the end.' },
]

/** Header gear for grid preferences. The menu portals out of the pill's clipped shell. */
export function AgentsGridSettings({ orderMode, onOrderModeChange, buttonClassName, buttonStyle, activeButtonStyle }: {
  orderMode: AgentGridOrderMode
  onOrderModeChange: (mode: AgentGridOrderMode) => void
  buttonClassName: (open: boolean) => string
  buttonStyle?: CSSProperties
  activeButtonStyle?: CSSProperties
}) {
  const menuId = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ right: number; top: number } | null>(null)
  const { theme, enabled } = useCustomChatTheme()
  const dark = useHtmlDarkMode()
  const open = position !== null

  const close = (restoreFocus: boolean) => {
    setPosition(null)
    if (restoreFocus) buttonRef.current?.focus()
  }
  const toggle = () => {
    if (open) { close(false); return }
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) setPosition({ right: Math.max(12, window.innerWidth - rect.right), top: rect.bottom + 8 })
  }

  useEffect(() => {
    if (!open) return
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus())
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) close(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(true) } }
    const onResize = () => close(false)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  const color = (name: 'settingsCustomThemesCardBorder' | 'toolJobsPrimaryText' | 'toolJobsMutedText' | 'composerToggleActiveBg' | 'composerToggleActiveText') =>
    enabled ? getThemeModeColor(theme.colors[name], dark) : undefined

  return <>
    <button ref={buttonRef} type='button' aria-label='Grid settings' title='Grid settings'
      aria-haspopup='menu' aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={event => { event.stopPropagation(); toggle() }}
      className={buttonClassName(open)} style={open ? activeButtonStyle : buttonStyle}>
      <Settings2 size={18} strokeWidth={2.25} aria-hidden='true' />
    </button>
    {position && createPortal(
      <div ref={menuRef} id={menuId} role='menu' aria-label='Card movement'
        className='fixed z-[1800] w-72 rounded-2xl border p-1.5 text-left shadow-xl'
        style={{ ...position,
          // Theme card colors are translucent; the menu floats over arbitrary content so it must be solid.
          backgroundColor: enabled ? opaqueAppBackground(getThemeModeColor(theme.colors.settingsCustomThemesCardBg, dark), dark) : dark ? '#171717' : '#ffffff',
          borderColor: color('settingsCustomThemesCardBorder') ?? (dark ? '#404040' : '#e5e5e5'),
          color: color('toolJobsPrimaryText') ?? (dark ? '#f5f5f5' : '#171717'),
        }}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])
          const index = items.indexOf(document.activeElement as HTMLElement)
          items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
        }}>
        <div className='px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-400'
          style={{ color: color('toolJobsMutedText') }}>Card movement</div>
        {OPTIONS.map(option => {
          const selected = option.mode === orderMode
          return (
            <button key={option.mode} type='button' role='menuitemradio' aria-checked={selected}
              onClick={() => { onOrderModeChange(option.mode); close(true) }}
              className={`flex w-full items-start gap-2 rounded-xl px-2.5 py-2 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${selected
                ? 'bg-blue-50 text-blue-700 dark:bg-orange-500/15 dark:text-orange-100' : 'hover:bg-black/5 dark:hover:bg-white/10'}`}
              style={selected && enabled ? { backgroundColor: color('composerToggleActiveBg'), color: color('composerToggleActiveText') } : undefined}>
              <span className='mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center' aria-hidden='true'>
                {selected && <Check size={14} strokeWidth={2.5} />}
              </span>
              <span className='min-w-0'>
                <span className='block text-sm font-semibold'>{option.label}</span>
                <span className='block text-xs opacity-75'>{option.detail}</span>
              </span>
            </button>
          )
        })}
      </div>, document.body
    )}
  </>
}
