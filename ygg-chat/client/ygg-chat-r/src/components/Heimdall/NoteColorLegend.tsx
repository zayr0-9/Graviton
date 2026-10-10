import { Palette } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { BaseMessage, ConversationId } from '../../../../../shared/types'
import { isContextInjectionMessage } from '../../../../../shared/contextInjection'
import type { CSSProperties } from 'react'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'
import './noteColorLegend.css'

// Keep these meanings aligned with .ygg/hooks/root_note_stop.py.
export const NOTE_COLOR_LEGEND = [
  { color: '#22c55e', label: 'Questions / clarifications / help' },
  { color: '#ef4444', label: 'Bugs / errors / fixes' },
  { color: '#8b5cf6', label: 'New features / enhancements' },
  { color: '#3b82f6', label: 'Refactors / improvements / performance' },
  { color: '#f59e0b', label: 'General / documentation / other' },
] as const

type BranchNote = Pick<BaseMessage, 'id' | 'role' | 'meta' | 'conversation_id' | 'parent_id' | 'note' | 'note_color'>

export function countTopLevelBranchNoteColors(messages: readonly BranchNote[], conversationId: ConversationId | null) {
  const counts: Record<string, number> = Object.fromEntries(NOTE_COLOR_LEGEND.map(({ color }) => [color, 0]))
  if (conversationId == null) return counts

  // Match server/topLevelUserMessages.ts, used by the sidebar preview:
  // launch-context user roots are transparent, but ordinary messages stop traversal.
  const roots: BranchNote[] = []
  const childrenByParent = new Map<string, BranchNote[]>()
  for (const message of messages) {
    if (String(message.conversation_id) !== String(conversationId)) continue
    if (message.parent_id == null) {
      roots.push(message)
    } else {
      const parentId = String(message.parent_id)
      const children = childrenByParent.get(parentId) ?? []
      children.push(message)
      childrenByParent.set(parentId, children)
    }
  }

  const pending = [...roots]
  const visited = new Set<string>()
  for (let index = 0; index < pending.length; index += 1) {
    const message = pending[index]
    const id = String(message.id)
    if (visited.has(id)) continue
    visited.add(id)
    if (message.role !== 'user') continue
    if (isContextInjectionMessage(message)) {
      pending.push(...(childrenByParent.get(id) ?? []))
      continue
    }
    if (!message.note?.trim()) continue
    const color = message.note_color?.trim().toLowerCase()
    if (color && Object.hasOwn(counts, color)) counts[color] += 1
  }
  return counts
}

interface NoteColorLegendProps {
  buttonClassName: string
  buttonStyle?: CSSProperties
  messages?: readonly BranchNote[]
  conversationId?: ConversationId | null
}

const EMPTY_MESSAGES: readonly BranchNote[] = []

export function NoteColorLegend({ buttonClassName, buttonStyle, messages = EMPTY_MESSAGES, conversationId = null }: NoteColorLegendProps) {
  const counts = useMemo(() => countTopLevelBranchNoteColors(messages, conversationId), [messages, conversationId])
  const { theme, enabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()
  const id = useId()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    if (!closing) return
    const closeMs = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--dropdown-close-dur')
    ) || 150
    const timer = window.setTimeout(() => setClosing(false), closeMs)
    return () => window.clearTimeout(timer)
  }, [closing])

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) closeLegend()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeLegend()
      }
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  function openLegend() {
    setClosing(false)
    setOpen(true)
  }

  function closeLegend() {
    setOpen(false)
    setClosing(true)
  }

  return (
    <div
      ref={wrapperRef}
      className='relative'
      onMouseEnter={openLegend}
      onMouseLeave={() => {
        if (!wrapperRef.current?.contains(document.activeElement)) closeLegend()
      }}
      onFocus={openLegend}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeLegend()
      }}
    >
      <button
        type='button'
        className={buttonClassName}
        style={buttonStyle}
        title='Note color legend'
        aria-label='Note color legend'
        aria-expanded={open}
        aria-controls={id}
        onClick={openLegend}
      >
        <Palette size={18} strokeWidth={2.25} />
      </button>
      <div
        id={id}
        role='region'
        aria-label='Note color legend'
        aria-hidden={!open}
        data-origin='bottom-right'
        className={`t-dropdown absolute bottom-full right-0 w-[min(18rem,calc(100vw-3rem))] pb-3 ${open ? 'is-open' : closing ? 'is-closing' : ''}`}
      >
        <div
          className='rounded-2xl bg-white/90 p-4 text-stone-800 backdrop-blur-2xl dark:bg-neutral-900/90 dark:text-stone-200'
          style={enabled ? {
            backgroundColor: getThemeModeColor(theme.colors.settingsPaneBodyBg, isDarkMode),
            color: getThemeModeColor(theme.colors.toolJobsPrimaryText, isDarkMode),
          } : undefined}
        >
          <h3 className='mb-3 text-sm font-medium'>Note colors</h3>
          <ul
            className='space-y-2.5 text-xs leading-5 text-stone-600 dark:text-stone-400'
            style={enabled ? { color: getThemeModeColor(theme.colors.toolJobsMutedText, isDarkMode) } : undefined}
          >
            {NOTE_COLOR_LEGEND.map(({ color, label }) => (
              <li key={color} className='flex items-center gap-2.5'>
                <span className='min-w-[2ch] shrink-0 text-right tabular-nums' aria-label={`${counts[color]} top-level branches`}>
                  {counts[color]}
                </span>
                <span aria-hidden='true' className='h-2.5 w-2.5 shrink-0 rounded-full' style={{ backgroundColor: color }} />
                <span>{label}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
