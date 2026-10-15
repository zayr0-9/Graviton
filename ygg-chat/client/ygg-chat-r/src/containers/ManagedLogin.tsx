import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../components/ThemeManager/themeConfig'

export default function ManagedLogin() {
  const { user, signIn } = useAuth()
  const navigate = useNavigate()
  const { theme, enabled: customThemeEnabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()
  type ColorKey = { [K in keyof typeof theme.colors]: typeof theme.colors[K] extends { light: string; dark: string } ? K : never }[keyof typeof theme.colors]
  const themeColor = (key: ColorKey) =>
    customThemeEnabled ? getThemeModeColor(theme.colors[key], isDarkMode) : undefined
  const secondaryButtonStyle = {
    backgroundColor: themeColor('settingsCustomThemesButtonBg'),
    color: themeColor('settingsCustomThemesButtonText'),
  }
  const [error, setError] = useState('')
  const [waiting, setWaiting] = useState(false)
  const [code, setCode] = useState('')
  const [provider, setProvider] = useState<'google' | 'github'>('google')
  // Do not redirect an existing-but-expired identity away from its reconnect screen.
  void user
  useEffect(() => window.electronAPI!.auth.onChanged(state => {
    if (state.app.status === 'ready') { setWaiting(false); navigate('/homepage', { replace: true }) }
  }), [navigate])
  useEffect(() => window.electronAPI!.auth.onLoginError(message => { setError(message); setWaiting(false) }), [])
  const start = async (selected: 'google' | 'github', oob = false) => {
    setError(''); setProvider(selected)
    try {
      const { url } = await window.electronAPI!.auth.start(selected, oob)
      const opened = await window.electronAPI!.auth.openExternal(url)
      if (!opened.success) throw new Error('Could not open your browser')
      setWaiting(true)
    } catch (e) { setError(e instanceof Error ? e.message : 'Sign-in failed') }
  }
  const buttonClass = 'inline-flex min-h-12 items-center justify-center rounded-full px-5 py-3 text-sm font-medium transition-[background-color,color,opacity,transform] duration-[var(--ygg-motion-duration-fast)] hover:opacity-80 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 focus-visible:ring-offset-2 dark:focus-visible:ring-orange-400/70 motion-reduce:transform-none motion-reduce:transition-none'
  const secondaryButtonClass = `${buttonClass} bg-neutral-100/80 text-neutral-800 dark:bg-white/10 dark:text-neutral-100`

  return <main
    className='flex min-h-screen items-center justify-center bg-neutral-100 p-4 text-neutral-900 sm:p-8 dark:bg-neutral-950 dark:text-neutral-100'
    style={{ backgroundColor: themeColor('settingsPaneBodyBg'), color: themeColor('toolJobsPrimaryText') }}
  >
    <section
      aria-labelledby='login-heading'
      className='w-full max-w-md space-y-8 rounded-[32px] bg-white/60 p-6 backdrop-blur-xl sm:p-10 dark:bg-white/5'
      style={{ backgroundColor: themeColor('settingsCustomThemesCardBg') }}
    >
      <header className='space-y-3'>
        <h1 id='login-heading' className='text-2xl font-semibold'>Sign in to Graviton</h1>
        <p className='text-sm leading-relaxed text-neutral-500 dark:text-neutral-400' style={{ color: themeColor('toolJobsMutedText') }}>
          Connect your cloud account, or keep working locally.
        </p>
      </header>
      {error && <p role='alert' className='rounded-2xl bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300'>{error}</p>}
      <div className='grid grid-cols-2 gap-3'>
        <button type='button' className={secondaryButtonClass} style={secondaryButtonStyle} onClick={() => void start('google')}>Google</button>
        <button type='button' className={secondaryButtonClass} style={secondaryButtonStyle} onClick={() => void start('github')}>GitHub</button>
      </div>
      {waiting && <div
        className='space-y-4 rounded-3xl bg-neutral-100/70 p-4 text-sm dark:bg-black/15'
        style={{ backgroundColor: themeColor('settingsCustomThemesInnerCardBg') }}
      >
        <p role='status' className='text-neutral-500 dark:text-neutral-400' style={{ color: themeColor('toolJobsMutedText') }}>Finish signing in in your browser.</p>
        <button type='button' className={`${secondaryButtonClass} w-full`} style={secondaryButtonStyle} onClick={() => void start(provider, true)}>Use a sign-in code instead</button>
        <input
          aria-label='Sign-in code'
          placeholder='Sign-in code'
          className='min-h-12 w-full rounded-2xl bg-white/70 px-4 py-3 text-neutral-900 placeholder:text-current placeholder:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 dark:bg-white/5 dark:text-neutral-100 dark:focus-visible:ring-orange-400/70'
          style={{ backgroundColor: themeColor('settingsCustomThemesCardBg'), color: themeColor('toolJobsPrimaryText') }}
          value={code}
          onChange={e => setCode(e.target.value)}
        />
        <div className='flex flex-wrap gap-3'>
          <button type='button' className={`${secondaryButtonClass} flex-1`} style={secondaryButtonStyle} onClick={() => { void window.electronAPI!.auth.code(code.trim()).then(() => setWaiting(false)).catch(e => setError(e.message)) }}>Verify code</button>
          <button type='button' className={secondaryButtonClass} style={secondaryButtonStyle} onClick={() => { void window.electronAPI!.auth.cancel(); setWaiting(false) }}>Cancel</button>
        </div>
      </div>}
      <button
        type='button'
        className={`${buttonClass} w-full bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900`}
        style={{ backgroundColor: themeColor('settingsCustomThemesPrimaryButtonBg'), color: themeColor('settingsCustomThemesPrimaryButtonText') }}
        onClick={() => { void signIn({ email: '', password: '' }).then(() => navigate('/homepage')).catch(e => setError(e.message)) }}
      >Continue locally</button>
    </section>
  </main>
}
