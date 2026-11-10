import { useEffect, useRef, useState } from 'react'
import { isNativeShell } from '../platform/clientCapabilities'
import { BackgroundMode, VIDEO_BACKGROUND_CHANGE_EVENT } from '../helpers/videoBackgroundStorage'
import {
  loadMatrixSettings, saveMatrixSettings, MATRIX_PRESETS, MatrixBackgroundSettings as Settings,
  loadMatrixRuntimeStatus, MATRIX_STATUS_EVENT,
} from '../helpers/matrixBackgroundStorage'
import { Button } from './Button/button'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from './ThemeManager/themeConfig'

interface Props {
  mode: BackgroundMode
  onModeChange: (mode: BackgroundMode) => void
}

export default function MatrixBackgroundSettings({ mode, onModeChange }: Props) {
  const [settings, setSettings] = useState(loadMatrixSettings)
  const [error, setError] = useState('')
  const [runtime, setRuntime] = useState(loadMatrixRuntimeStatus)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pending = useRef<Settings | null>(null)
  useEffect(() => {
    const refresh = () => setRuntime(loadMatrixRuntimeStatus())
    window.addEventListener(MATRIX_STATUS_EVENT, refresh)
    return () => window.removeEventListener(MATRIX_STATUS_EVENT, refresh)
  }, [])
  useEffect(() => () => {
    clearTimeout(saveTimer.current)
    if (pending.current) {
      try { saveMatrixSettings(pending.current) } catch { console.error('Could not save Matrix wallpaper settings.') }
    }
  }, [])
  const { theme, enabled } = useCustomChatTheme()
  const dark = useHtmlDarkMode()
  const color = (key: 'settingsCustomThemesCardBg' | 'settingsCustomThemesInnerCardBg' | 'toolJobsPrimaryText' | 'toolJobsMutedText') =>
    enabled ? getThemeModeColor(theme.colors[key], dark) : undefined
  const fieldStyle = { backgroundColor: color('settingsCustomThemesInnerCardBg'), color: color('toolJobsPrimaryText') }
  useEffect(() => {
    const refresh = () => { if (!pending.current) setSettings(loadMatrixSettings()) }
    window.addEventListener(VIDEO_BACKGROUND_CHANGE_EVENT, refresh)
    return () => window.removeEventListener(VIDEO_BACKGROUND_CHANGE_EVENT, refresh)
  }, [])

  if (!isNativeShell) return null

  const update = (patch: Partial<Settings>, debounce = false) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    pending.current = next
    clearTimeout(saveTimer.current)
    const commit = () => {
      pending.current = null
      try { saveMatrixSettings(next); setError('') }
      catch { setError('Could not save Matrix wallpaper settings.') }
    }
    if (debounce) saveTimer.current = setTimeout(commit, 300)
    else commit()
  }
  const controlClass = 'rounded-xl bg-white/70 px-3 py-2 text-sm dark:bg-zinc-800'
  return (
    <section className='rounded-[1.75rem] bg-white/45 p-6 dark:bg-zinc-900/60' aria-labelledby='matrix-wallpaper-heading' style={{ backgroundColor: color('settingsCustomThemesCardBg'), color: color('toolJobsPrimaryText') }}>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <h2 id='matrix-wallpaper-heading' className='text-lg font-semibold'>Live Matrix wallpaper</h2>
        <Button variant={mode === 'matrix' ? 'primary' : 'outline2'} size='small' aria-pressed={mode === 'matrix'} onClick={() => onModeChange(mode === 'matrix' ? 'color' : 'matrix')}>
          {mode === 'matrix' ? 'Turn off Matrix' : 'Use Matrix'}
        </Button>
      </div>
      <div className='mt-5 grid gap-4 sm:grid-cols-2'>
        <label className='flex flex-col gap-2 text-sm'>
          Preset
          <select style={fieldStyle} className={controlClass} value={settings.preset} onChange={event => update({ preset: event.target.value as Settings['preset'], columns: MATRIX_PRESETS.find(preset => preset.value === event.target.value)!.columns })}>
            {MATRIX_PRESETS.map(preset => <option key={preset.value} value={preset.value}>{preset.label}</option>)}
          </select>
        </label>
        <label className='flex flex-col gap-2 text-sm'>
          Frame rate
          <select style={fieldStyle} className={controlClass} value={settings.fps} onChange={event => update({ fps: Number(event.target.value) as Settings['fps'] })}>
            {[15, 30, 60].map(fps => <option key={fps} value={fps}>{fps} fps</option>)}
          </select>
        </label>
        <label className='flex flex-col gap-2 text-sm'>
          Speed: {settings.speed.toFixed(2)}×
          <input type='range' min='0.25' max='2' step='0.25' value={settings.speed} onChange={event => update({ speed: Number(event.target.value) }, true)} />
        </label>
        <label className='flex flex-col gap-2 text-sm'>
          Columns: {settings.columns}
          <input type='range' min='20' max='120' step='1' value={settings.columns} onChange={event => update({ columns: Number(event.target.value) }, true)} />
        </label>
      </div>
      <p style={{ color: color('toolJobsMutedText') }} className='mt-4 text-xs text-stone-500 dark:text-stone-400'>
        Powered by Rezmason/matrix. Runs locally and pauses when hidden or reduced motion is enabled.
      </p>
      {mode === 'matrix' && runtime === 'retrying' && <p role='status' className='mt-2 text-sm'>Restarting Matrix after a graphics error…</p>}
      {mode === 'matrix' && runtime === 'error' && <p role='alert' className='mt-2 text-sm'>Matrix could not start. Using a solid background. Turn Matrix off and on to retry.</p>}
      {error && <p role='alert' className='mt-2 text-sm text-red-500'>{error}</p>}
    </section>
  )
}
