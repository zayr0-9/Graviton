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
  return <main className='min-h-screen flex items-center justify-center p-8'>
    <section className='max-w-md w-full space-y-5 rounded-xl border border-neutral-600 p-8'>
      <h1 className='text-2xl font-semibold'>Sign in to Graviton</h1>
      <p>Connect your cloud account, or keep working locally.</p>
      {error && <p role='alert' className='text-red-400'>{error}</p>}
      <div className='flex gap-4'>
        <button onClick={() => void start('google')}>Google</button>
        <button onClick={() => void start('github')}>GitHub</button>
      </div>
      {waiting && <div className='space-y-3'>
        <p>Finish signing in in your browser.</p>
        <button onClick={() => void start(provider, true)}>Use a sign-in code instead</button>
        <input aria-label='Sign-in code' className='w-full bg-transparent border rounded p-2' value={code} onChange={e => setCode(e.target.value)} />
        <button onClick={() => { void window.electronAPI!.auth.code(code.trim()).then(() => setWaiting(false)).catch(e => setError(e.message)) }}>Verify code</button>
        <button onClick={() => { void window.electronAPI!.auth.cancel(); setWaiting(false) }}>Cancel</button>
      </div>}
      <button onClick={() => { void signIn({ email: '', password: '' }).then(() => navigate('/homepage')).catch(e => setError(e.message)) }}>Continue locally</button>
    </section>
  </main>
}
