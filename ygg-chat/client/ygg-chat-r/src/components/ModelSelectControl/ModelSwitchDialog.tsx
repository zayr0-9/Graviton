import { useEffect, useRef, type CSSProperties } from 'react'
import type { BranchModelSelection } from '../../features/chats/branchModelSelection'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'
import '../ChatMessage/explainSelection.css'
import './modelSwitchDialog.css'

export function ModelSwitchDialog({ from, to, onCancel, onConfirm }: {
  from: BranchModelSelection
  to: BranchModelSelection
  onCancel: () => void
  onConfirm: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const closing = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { theme, enabled } = useCustomChatTheme()
  const dark = useHtmlDarkMode()
  type ColorKey = { [K in keyof typeof theme.colors]: typeof theme.colors[K] extends { light: string; dark: string } ? K : never }[keyof typeof theme.colors]
  const color = (key: ColorKey, fallback: string) => enabled ? getThemeModeColor(theme.colors[key], dark) : fallback
  const style = {
    '--switch-backdrop': color('authModalBackdrop', 'rgba(0, 0, 0, 0.45)'),
    '--switch-surface': color('authModalSurfaceBg', dark ? '#171717' : '#ffffff'),
    '--switch-body': color('authModalBodyText', dark ? '#d4d4d4' : '#404040'),
    '--switch-title': color('authModalTitleText', dark ? '#f5f5f5' : '#171717'),
    '--switch-secondary-bg': color('authModalSecondaryButtonBg', dark ? '#262626' : '#f5f5f5'),
    '--switch-secondary-text': color('authModalSecondaryButtonText', dark ? '#e5e5e5' : '#404040'),
    '--switch-primary-bg': color('authModalPrimaryButtonBg', dark ? '#e5e5e5' : '#262626'),
    '--switch-primary-text': color('authModalPrimaryButtonText', dark ? '#171717' : '#ffffff'),
    '--switch-accent': color('toolPermissionDialogToolNameText', dark ? '#fdba74' : '#1d4ed8'),
  } as CSSProperties

  useEffect(() => {
    const dialog = ref.current
    closing.current = false
    dialog?.classList.remove('is-open', 'is-closing')
    dialog?.showModal()
    // Establish the scaled resting state before transitioning into the top layer.
    if (dialog) void dialog.offsetWidth
    const frame = requestAnimationFrame(() => {
      if (!closing.current) dialog?.classList.add('is-open')
    })
    return () => {
      cancelAnimationFrame(frame)
      if (timer.current !== null) clearTimeout(timer.current)
      dialog?.classList.remove('is-open', 'is-closing')
      dialog?.close()
    }
  }, [])

  const dismiss = (action: () => void) => {
    const dialog = ref.current
    if (!dialog || closing.current) return
    closing.current = true
    dialog.classList.remove('is-open')
    dialog.classList.add('is-closing')
    const duration = getComputedStyle(dialog).getPropertyValue('--modal-close-dur').trim()
    const closeMs = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0
      : duration ? parseFloat(duration) * (duration.endsWith('ms') ? 1 : 1000) : 150
    timer.current = setTimeout(() => {
      dialog.classList.remove('is-closing')
      dialog.close()
      action()
    }, closeMs)
  }

  return (
    <dialog ref={ref} aria-labelledby='model-switch-title' aria-describedby='model-switch-description'
      onCancel={event => { event.preventDefault(); dismiss(onCancel) }}
      className='t-modal model-switch-dialog fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-sm rounded-3xl p-6 shadow-xl'
      style={style}>
      <h3 id='model-switch-title' className='mb-3 text-lg font-semibold'>Switch model or provider?</h3>
      <p className='mb-2 break-words text-sm'>{from.provider} · {from.model || 'Default model'}</p>
      <p className='mb-4 break-words text-sm'>{'→ '}{to.provider} · {to.model || 'Provider default model'}</p>
      <p id='model-switch-description' className='text-sm leading-6'>Switching may invalidate this branch’s prompt cache and increase latency or cost. Existing runs will not change.</p>
      <div className='mt-5 flex justify-end gap-2'>
        <button type='button' autoFocus onClick={() => dismiss(onCancel)} className='model-switch-button rounded-full px-4 py-2 text-sm font-medium'>Keep current</button>
        <button type='button' onClick={() => dismiss(onConfirm)} className='model-switch-button model-switch-button-primary rounded-full px-4 py-2 text-sm font-medium'>Switch</button>
      </div>
    </dialog>
  )
}
