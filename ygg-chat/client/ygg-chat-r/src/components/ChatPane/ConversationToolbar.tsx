import React, { useEffect, useId, useRef, useState } from 'react'
import { Check, GitBranch, Pencil, RefreshCw, X } from 'lucide-react'
import { getThemeModeColor, type CustomChatTheme, type ThemeColorPair } from '../ThemeManager/themeConfig'

interface ConversationToolbarProps {
  title: string
  backgroundColor: string
  treeVisible: boolean
  customTheme: CustomChatTheme
  customThemeEnabled: boolean
  isDarkMode: boolean
  onToggleTree: () => void
  onRefresh: () => void
  onRename: (title: string) => Promise<void>
  onEditingChange: (editing: boolean) => void
}

type ThemeColorToken = {
  [K in keyof CustomChatTheme['colors']]: CustomChatTheme['colors'][K] extends ThemeColorPair ? K : never
}[keyof CustomChatTheme['colors']]

const controlClass = 'flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-black/[0.035] text-stone-600 transition-[background-color,color,transform] duration-[var(--ygg-motion-duration-fast)] hover:bg-black/[0.07] hover:text-stone-950 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 disabled:cursor-wait disabled:opacity-40 dark:bg-white/[0.045] dark:text-stone-300 dark:hover:bg-white/[0.09] dark:hover:text-white dark:focus-visible:ring-orange-400/70 motion-reduce:transform-none'

/** A local rename draft only reaches persistence on explicit confirmation. */
export function ConversationToolbar({
  title, backgroundColor, treeVisible, customTheme, customThemeEnabled, isDarkMode,
  onToggleTree, onRefresh, onRename, onEditingChange,
}: ConversationToolbarProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const editRef = useRef<HTMLButtonElement>(null)
  const mountedRef = useRef(false)
  const savingRef = useRef(false)
  const fieldId = useId()
  const feedbackId = `${fieldId}-feedback`
  const color = (token: ThemeColorToken) =>
    customThemeEnabled ? getThemeModeColor(customTheme.colors[token], isDarkMode) : undefined
  const controlStyle = {
    backgroundColor: color('settingsCustomThemesButtonBg'),
    color: color('settingsCustomThemesButtonText'),
  }
  const primaryStyle = {
    backgroundColor: color('settingsCustomThemesPrimaryButtonBg'),
    color: color('settingsCustomThemesPrimaryButtonText'),
  }

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const finishEditing = () => {
    setEditing(false)
    setError(null)
    onEditingChange(false)
    requestAnimationFrame(() => {
      if (mountedRef.current) editRef.current?.focus()
    })
  }

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (savingRef.current) return
    const trimmed = draft.trim()
    if (!trimmed) {
      setError('Enter a conversation title.')
      inputRef.current?.focus()
      return
    }
    if (trimmed === title.trim()) {
      finishEditing()
      return
    }
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      await onRename(trimmed)
      if (mountedRef.current) finishEditing()
    } catch {
      if (mountedRef.current) {
        setError('Could not save the title. Your draft is kept. Try again.')
        requestAnimationFrame(() => {
          if (mountedRef.current) inputRef.current?.focus()
        })
      }
    } finally {
      savingRef.current = false
      if (mountedRef.current) setSaving(false)
    }
  }

  return (
    <div
      className={`min-w-0 p-1.5 backdrop-blur-[12px] ${editing && (error || saving) ? 'rounded-3xl' : 'rounded-full'}`}
      style={{ backgroundColor, color: color('toolJobsPrimaryText') }}
      data-conversation-toolbar='true'
    >
      {editing ? (
        <form onSubmit={save} aria-label='Rename conversation' aria-busy={saving} onKeyDown={event => {
          if (event.key === 'Escape' && !savingRef.current) {
            event.preventDefault()
            finishEditing()
          }
        }}>
          <label htmlFor={fieldId} className='sr-only'>Conversation title</label>
          <div className='flex min-w-0 items-center gap-1'>
            <input
              ref={inputRef}
              id={fieldId}
              value={draft}
              onChange={event => { setDraft(event.target.value); setError(null) }}
              onKeyDown={event => {
                if (event.key === 'Enter' && event.nativeEvent.isComposing) {
                  event.preventDefault()
                }
              }}
              readOnly={saving}
              aria-invalid={Boolean(error)}
              aria-describedby={error || saving ? feedbackId : undefined}
              className='h-11 min-w-0 flex-1 rounded-full bg-black/5 px-3 text-sm text-stone-900 outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 dark:bg-black/20 dark:text-stone-100 dark:focus-visible:ring-orange-400/70'
              style={{ backgroundColor: color('settingsCustomThemesInnerCardBg'), color: color('toolJobsPrimaryText') }}
            />
            <button type='submit' className={controlClass} style={primaryStyle} disabled={saving || !draft.trim()} title='Save title (Enter)' aria-label='Save title'>
              <Check size={18} strokeWidth={2.25} aria-hidden='true' />
            </button>
            <button type='button' className={controlClass} style={controlStyle} disabled={saving} onClick={finishEditing} title='Cancel rename (Escape)' aria-label='Cancel rename'>
              <X size={18} strokeWidth={2.25} aria-hidden='true' />
            </button>
          </div>
          {(error || saving) && (
            <p id={feedbackId} role={error ? 'alert' : 'status'} className={`px-3 py-1.5 text-xs ${error ? 'text-red-600 dark:text-red-400' : 'text-stone-500 dark:text-stone-400'}`} style={error ? undefined : { color: color('toolJobsMutedText') }}>
              {error || 'Saving title…'}
            </p>
          )}
        </form>
      ) : (
        <div className='flex min-w-0 items-center gap-1'>
          <button type='button' className={`${controlClass} ${treeVisible ? 'bg-blue-50 text-blue-700 dark:bg-orange-500/15 dark:text-orange-100' : ''}`} style={treeVisible ? { backgroundColor: color('composerToggleActiveBg'), color: color('composerToggleActiveText') } : controlStyle}
            aria-pressed={treeVisible} title={treeVisible ? 'Hide tree view' : 'Show tree view'} aria-label={treeVisible ? 'Hide tree view' : 'Show tree view'} onClick={onToggleTree}>
            <GitBranch size={18} strokeWidth={2.25} aria-hidden='true' />
          </button>
          <div className='min-w-0 flex-1 px-2'>
            <h1 className='truncate text-sm font-medium text-stone-800 dark:text-stone-100' style={{ color: color('toolJobsPrimaryText') }} title={title || 'Untitled conversation'}>
              {title || 'Untitled conversation'}
            </h1>
          </div>
          <button ref={editRef} type='button' className={controlClass} style={controlStyle} title='Edit conversation title' aria-label='Edit conversation title' onClick={() => {
            setDraft(title)
            setError(null)
            setEditing(true)
            onEditingChange(true)
          }}>
            <Pencil size={18} strokeWidth={2.25} aria-hidden='true' />
          </button>
          <button type='button' className={controlClass} style={controlStyle} title='Refresh messages' aria-label='Refresh messages' onClick={onRefresh}>
            <RefreshCw size={18} strokeWidth={2.25} aria-hidden='true' />
          </button>
        </div>
      )}
    </div>
  )
}
