import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

export default function ManagedLogin() {
  const { user, signIn } = useAuth()
  const navigate = useNavigate()
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
  const secondaryButtonClass = 'rounded-lg border border-neutral-300 bg-white px-4 py-2 font-medium text-neutral-800 transition hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700 dark:focus-visible:ring-orange-500'

  return <main className='flex min-h-screen items-center justify-center bg-neutral-50 p-8 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100'>
    <section className='w-full max-w-md space-y-5 rounded-xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-900'>
      <h1 className='text-2xl font-semibold text-neutral-900 dark:text-neutral-100'>Sign in to Graviton</h1>
      <p className='text-neutral-600 dark:text-neutral-300'>Connect your cloud account, or keep working locally.</p>
      {error && <p role='alert' className='text-red-600 dark:text-red-400'>{error}</p>}
      <div className='flex gap-4'>
        <button className={`${secondaryButtonClass} flex-1`} onClick={() => void start('google')}>Google</button>
        <button className={`${secondaryButtonClass} flex-1`} onClick={() => void start('github')}>GitHub</button>
      </div>
      {waiting && <div className='space-y-3 text-neutral-700 dark:text-neutral-200'>
        <p>Finish signing in in your browser.</p>
        <button className={secondaryButtonClass} onClick={() => void start(provider, true)}>Use a sign-in code instead</button>
        <input aria-label='Sign-in code' className='w-full rounded-lg border border-neutral-300 bg-white p-2 text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:ring-orange-500' value={code} onChange={e => setCode(e.target.value)} />
        <div className='flex gap-3'>
          <button className={secondaryButtonClass} onClick={() => { void window.electronAPI!.auth.code(code.trim()).then(() => setWaiting(false)).catch(e => setError(e.message)) }}>Verify code</button>
          <button className={secondaryButtonClass} onClick={() => { void window.electronAPI!.auth.cancel(); setWaiting(false) }}>Cancel</button>
        </div>
      </div>}
      <button className='w-full rounded-lg bg-neutral-900 px-4 py-2 font-semibold text-white transition hover:bg-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white dark:focus-visible:ring-orange-500' onClick={() => { void signIn({ email: '', password: '' }).then(() => navigate('/homepage')).catch(e => setError(e.message)) }}>Continue locally</button>
    </section>
  </main>
}
