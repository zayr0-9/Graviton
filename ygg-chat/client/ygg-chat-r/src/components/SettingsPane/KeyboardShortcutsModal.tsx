import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, useReducedMotion } from 'framer-motion'
import { Keyboard, RotateCcw, X } from 'lucide-react'
import { commandIds, formatShortcut, getBindings, getCommand, isMacKeyboard } from '../../keyboard/commands'
import type { CommandId, ShortcutOverrides } from '../../keyboard/commands'
import { captureShortcut, findShortcutConflict, loadShortcutOverrides, saveShortcutOverrides } from '../../keyboard/shortcutPreferences'
import { useCommandBlocker } from '../../keyboard/KeyboardProvider'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'
import { motionState, useMotionPreferences } from '../motion'

type Props = { onClose: () => void }

/** Mounted only while open: a cancelled draft never changes runtime bindings. */
export const KeyboardShortcutsModal = ({ onClose }: Props) => {
  const [draft, setDraft] = useState<ShortcutOverrides>(loadShortcutOverrides)
  const [recording, setRecording] = useState<CommandId | null>(null)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const helpId = useId()
  const mac = isMacKeyboard()
  const reduceMotion = useReducedMotion()
  const { shellTransition } = useMotionPreferences(reduceMotion)
  const { theme, enabled } = useCustomChatTheme()
  const dark = useHtmlDarkMode()
  const color = (token: 'settingsCustomThemesCardBg' | 'settingsCustomThemesInnerCardBg' | 'settingsCustomThemesButtonBg' | 'settingsCustomThemesButtonText' | 'settingsCustomThemesPrimaryButtonBg' | 'settingsCustomThemesPrimaryButtonText' | 'toolJobsPrimaryText' | 'toolJobsMutedText' | 'composerToggleActiveBg' | 'composerToggleActiveText' | 'authModalBackdrop') =>
    enabled ? getThemeModeColor(theme.colors[token], dark) : undefined
  const buttonClass = 'rounded-full px-3 py-2 text-sm bg-black/5 dark:bg-white/10 hover:opacity-80 active:scale-95 transition-[background-color,opacity,transform] duration-[var(--ygg-motion-duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current motion-reduce:transform-none disabled:opacity-40'
  const buttonStyle = { backgroundColor: color('settingsCustomThemesButtonBg'), color: color('settingsCustomThemesButtonText') }
  useCommandBlocker(true)

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])

  // Capture before legacy Chat handlers; this dialog owns its recording and Escape.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (recording) { setRecording(null); setError('') }
        else onClose()
        return
      }
      if (!recording || event.key === 'Tab') return
      event.preventDefault()
      event.stopImmediatePropagation()
      const result = captureShortcut(event, recording, mac)
      if (result.error) { setError(result.error); return }
      if (!result.binding) return
      const conflict = findShortcutConflict(recording, result.binding, draft, mac)
      if (conflict) {
        setError(`Already assigned to “${getCommand(conflict).label}”. Clear or change that shortcut first.`)
        return
      }
      setDraft(previous => ({ ...previous, [recording]: [result.binding!] }))
      setRecording(null)
      setError('')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, draft, mac, onClose])

  const save = () => {
    for (const id of commandIds) {
      for (const binding of getBindings(id, mac, draft)) {
        const conflict = findShortcutConflict(id, binding, draft, mac)
        if (conflict) {
          setError(`“${getCommand(id).label}” and “${getCommand(conflict).label}” use the same shortcut.`)
          return
        }
      }
    }
    try {
      saveShortcutOverrides(draft)
      onClose()
    } catch {
      setError('Could not save shortcuts. Your changes are kept here; try again.')
    }
  }

  return createPortal(
    <motion.div className='fixed inset-0 z-[500] flex items-center justify-center p-4' data-shortcut-editor='true'
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18, ease: 'easeOut' }}>
      <button type='button' tabIndex={-1} aria-label='Cancel keyboard shortcut changes' onClick={onClose}
        className='absolute inset-0 bg-black/25 backdrop-blur-sm' style={{ backgroundColor: color('authModalBackdrop') }} />
      <motion.div ref={dialogRef} role='dialog' aria-modal='true' aria-labelledby={titleId} aria-describedby={helpId}
        className='relative flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-[26px] bg-white/95 p-5 text-stone-900 backdrop-blur-2xl dark:bg-neutral-900/95 dark:text-stone-100'
        style={{ backgroundColor: color('settingsCustomThemesCardBg'), color: color('toolJobsPrimaryText') }}
        {...motionState(Boolean(reduceMotion))} transition={shellTransition}
        onKeyDown={event => {
          event.stopPropagation()
          if (event.key !== 'Tab') return
          const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? [])]
          const first = controls[0]
          const last = controls.at(-1)
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }}>
        <div className='flex items-center justify-between gap-3'>
          <h2 id={titleId} className='flex items-center gap-2 text-lg font-semibold'><Keyboard size={18} />Keyboard shortcuts</h2>
          <button ref={closeRef} type='button' className={`${buttonClass} flex h-11 w-11 items-center justify-center p-0`} style={buttonStyle}
            onClick={onClose} aria-label='Close keyboard shortcuts' title='Close keyboard shortcuts'><X size={18} strokeWidth={2.25} /></button>
        </div>
        <p id={helpId} className='my-3 text-sm text-stone-500 dark:text-stone-400' style={{ color: color('toolJobsMutedText') }}>
          Choose a shortcut, then press the keys you want. Escape cancels recording. Tree controls work only when the graph is focused.
        </p>
        <div className='min-h-0 flex-1 overflow-y-auto thin-scrollbar space-y-1'>
          {commandIds.map(id => <div key={id} className='flex flex-wrap items-center gap-2 rounded-2xl p-3'
            style={{ backgroundColor: recording === id ? color('composerToggleActiveBg') : color('settingsCustomThemesInnerCardBg') }}>
            <span className='min-w-40 flex-1 text-sm'>{getCommand(id).label}</span>
            <button type='button' className={`${buttonClass} min-w-28`} style={recording === id ? { backgroundColor: color('composerToggleActiveBg'), color: color('composerToggleActiveText') } : buttonStyle}
              aria-label={`Change ${getCommand(id).label} shortcut`} aria-pressed={recording === id}
              onClick={() => { setRecording(id); setError('') }} onBlur={() => setRecording(current => current === id ? null : current)}>
              {recording === id ? 'Press keys…' : formatShortcut(id, mac, draft)}
            </button>
            <button type='button' className={buttonClass} style={buttonStyle} disabled={getBindings(id, mac, draft).length === 0}
              aria-label={`Clear ${getCommand(id).label} shortcut`}
              onClick={() => { setDraft(previous => ({ ...previous, [id]: [] })); setError('') }}>Clear</button>
            <button type='button' className={`${buttonClass} flex h-9 w-9 items-center justify-center p-0`} style={buttonStyle} disabled={draft[id] === undefined}
              title={`Reset ${getCommand(id).label}`} aria-label={`Reset ${getCommand(id).label} shortcut`}
              onClick={() => { setDraft(previous => { const next = { ...previous }; delete next[id]; return next }); setError('') }}>
              <RotateCcw size={16} strokeWidth={2.25} />
            </button>
          </div>)}
        </div>
        <div className='mt-3 min-h-5 text-sm text-red-600 dark:text-red-400' role='alert'>{error}</div>
        <div className='mt-3 flex flex-wrap items-center justify-between gap-2'>
          <button type='button' className={buttonClass} style={buttonStyle} onClick={() => { setDraft({}); setRecording(null); setError('') }}>Reset all</button>
          <div className='flex gap-2'>
            <button type='button' className={buttonClass} style={buttonStyle} onClick={onClose}>Cancel</button>
            <button type='button' className={buttonClass} disabled={recording !== null} onClick={save}
              style={{ backgroundColor: color('settingsCustomThemesPrimaryButtonBg'), color: color('settingsCustomThemesPrimaryButtonText') }}>Save shortcuts</button>
          </div>
        </div>
      </motion.div>
    </motion.div>, document.body
  )
}
