import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Button } from '../components'
import { isCloudSession, isElectronMode as isElectronRuntime, LOCAL_AUTH_USER_ID } from '../config/runtimeMode'
import { loadStartupLandingPreference } from '../helpers/startupPreferences'
import { useAuth } from '../hooks/useAuth'
import { useRecentConversations } from '../hooks/useQueries'
import { syncHeadlessOpenRouterToken } from '../lib/auth/headlessProviderTokenSync'
import { supabase } from '../lib/supabase'
import { localMirror as dualSync } from '../lib/localMirror'
import { localApi } from '../utils/api'

// Railway server URL for OOB auth (where Redis runs)
const RAILWAY_URL = import.meta.env.VITE_API_URL?.replace('/api', '') || 'https://webdrasil-production.up.railway.app'

const Login: React.FC = () => {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { user, userId, accessToken, loading: authLoading, reloadSession, signIn } = useAuth()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const startupRedirectedRef = useRef(false)

  const startupLandingPreference = useMemo(() => loadStartupLandingPreference(), [])
  const shouldRouteToLatestChat = startupLandingPreference === 'latest-chat'
  const { data: startupRecentConversations = [], isLoading: startupConversationsLoading } = useRecentConversations(1)

  // OOB (Out-of-Band) authentication state for Electron
  const [oobMode, setOobMode] = useState(false)
  const [oobCode, setOobCode] = useState('')
  const [oauthUrl, setOauthUrl] = useState<string | null>(null)

  // Hybrid flow state: try deep link first, show fallback after 5 seconds
  const [waitingForCallback, setWaitingForCallback] = useState(false)
  const [showFallbackLink, setShowFallbackLink] = useState(false)
  const [pendingProvider, setPendingProvider] = useState<'google' | 'github' | null>(null)

  // Check if we're in Electron mode
  const isElectronMode = isElectronRuntime
  const requiresCloudLogin = searchParams.get('required') === 'cloud'
  const hasCloudSession = isCloudSession({
    accessToken,
    userId,
  })

  const mergeLocalDataIntoCloudAccount = async (
    cloudUserId: string,
    cloudUsername: string,
    cloudCreatedAt?: string
  ) => {
    if (!isElectronMode) return
    if (!cloudUserId || cloudUserId === LOCAL_AUTH_USER_ID) return

    try {
      await localApi.post('/local/users/merge', {
        fromUserId: LOCAL_AUTH_USER_ID,
        toUserId: cloudUserId,
        toUsername: cloudUsername,
        toCreatedAt: cloudCreatedAt || new Date().toISOString(),
      })
    } catch (mergeError) {
      console.error('[Login] Failed to merge local user data into cloud account:', mergeError)
    }
  }

  const persistElectronCloudSession = async (
    session: { access_token: string; [key: string]: any },
    authUser: { id: string; email?: string | null },
    username: string
  ) => {
    if (!window.electronAPI?.storage) return

    const userId = authUser.id
    const authStateForStorage = {
      user: {
        id: userId,
        email: authUser.email || 'unknown',
        username,
      },
      session,
      loading: false,
      accessToken: session.access_token,
      userId,
    }

    await window.electronAPI.storage.set('auth_session', authStateForStorage)

    try {
      await syncHeadlessOpenRouterToken({
        userId,
        accessToken: session.access_token,
      })
    } catch (syncError) {
      console.error('[Login] Failed to sync app token to headless token store:', syncError)
    }

    await reloadSession()
  }

  useEffect(() => {
    if (!user) {
      startupRedirectedRef.current = false
    }
  }, [user])

  // Redirect after auth based on startup preference.
  useEffect(() => {
    if (requiresCloudLogin && !hasCloudSession) {
      startupRedirectedRef.current = false
      return
    }

    if (!user || authLoading || startupRedirectedRef.current) return

    if (shouldRouteToLatestChat && !accessToken) return

    if (!shouldRouteToLatestChat) {
      startupRedirectedRef.current = true
      navigate('/homepage', { replace: true })
      return
    }

    if (startupConversationsLoading) return

    const latestConversation = startupRecentConversations.find(conversation => conversation.project_id)
    if (latestConversation?.id && latestConversation.project_id) {
      startupRedirectedRef.current = true
      navigate(`/chat/${latestConversation.project_id}/${latestConversation.id}`, {
        replace: true,
        state: latestConversation.storage_mode ? { storageMode: latestConversation.storage_mode } : undefined,
      })
      return
    }

    startupRedirectedRef.current = true
    navigate('/homepage', { replace: true })
  }, [
    user,
    authLoading,
    shouldRouteToLatestChat,
    startupConversationsLoading,
    startupRecentConversations,
    navigate,
    accessToken,
    requiresCloudLogin,
    hasCloudSession,
  ])

  // Monitor auth state changes - just for logging and cleanup
  // NOTE: Skip in Electron mode - ElectronAuthProvider handles auth state through useAuth()
  // Having this listener active in Electron causes conflicts with the provider's state management
  useEffect(() => {
    if (!supabase) return
    // Skip in Electron mode/community mode to prevent dual auth state management
    if (isElectronMode) return

    // console.log('[Login] Setting up onAuthStateChange listener')

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      // console.log('[Login] Auth state changed:', {
      //   event,
      //   hasSession: !!session,
      //   hasUser: !!session?.user,
      //   userId: session?.user?.id,
      // })

      // Clear loading state on successful sign-in
      // Authorization checks are handled in the OAuth callback handler for Electron
      if (event === 'SIGNED_IN' && session?.user) {
        setLoading(false)
      }
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [isElectronMode])

  // Handle OAuth callback from external browser (Electron only)
  useEffect(() => {
    if (!window.electronAPI?.auth?.onOAuthCallback) return

    // console.log('[Login] Setting up OAuth callback listener for Electron')

    const cleanup = window.electronAPI.auth.onOAuthCallback(async (callbackUrl: string) => {
      // console.log('[Login] Received OAuth callback from external browser:', callbackUrl)
      setLoading(true)
      setError(null)

      // Clear waiting state since callback was received
      setWaitingForCallback(false)
      setShowFallbackLink(false)
      setPendingProvider(null)

      try {
        // Extract the hash/query parameters from the callback URL
        const url = new URL(callbackUrl)
        const hashParams = new URLSearchParams(url.hash.substring(1)) // Remove the '#' and parse
        const access_token = hashParams.get('access_token')
        const refresh_token = hashParams.get('refresh_token')

        if (!access_token || !refresh_token) {
          throw new Error('No tokens found in callback URL')
        }

        // Set the session in Supabase
        const { data, error } = await supabase!.auth.setSession({
          access_token,
          refresh_token,
        })

        if (error) throw error

        // console.log('[Login] OAuth session established successfully')

        // Handle Electron-specific setup
        if (data.session?.user && isElectronMode) {
          const userId = data.session.user.id

          // Use Supabase user data directly for local SQLite sync (no Railway call needed)
          const username = data.session.user.user_metadata?.name || data.session.user.email?.split('@')[0] || 'user'

          // console.log('[Login] Syncing Supabase user to local SQLite...', { userId, username })

          // Sync user to local SQLite database (fire-and-forget)
          dualSync.syncUser({
            id: userId,
            username: username,
            created_at: data.session.user.created_at,
          })

          await mergeLocalDataIntoCloudAccount(userId, username, data.session.user.created_at)

          // Save OAuth session to Electron storage so ElectronAuthProvider can use it
          if (window.electronAPI?.storage) {
            try {
              await persistElectronCloudSession(data.session, data.session.user, username)
              // console.log('[Login] OAuth session saved to Electron storage')
              // console.log('[Login] Auth session reloaded in context')
            } catch (storageError) {
              console.error('[Login] Failed to save OAuth session to storage:', storageError)
            }
          }
        } else if (data.session?.user && !isElectronMode) {
          // Web mode: Session is already set in Supabase, AuthContext will pick it up
          console.log('[Login] Web mode: OAuth session established, letting AuthContext handle state')
        }

        // Success - clear loading state and let the redirect happen
        setLoading(false)
      } catch (error: any) {
        console.error('[Login] Failed to handle OAuth callback:', error)
        setError(error.message || 'Failed to complete OAuth login')
        setLoading(false)
      }
    })

    return cleanup
  }, [isElectronMode, reloadSession])

  const handleOAuthLogin = async (provider: 'google' | 'github') => {
    setLoading(true)
    setError(null)

    try {
      if (!supabase) {
        throw new Error('Supabase client not available. Please check your environment configuration.')
      }

      // Check if running in Electron
      if (window.electronAPI?.auth) {
        // Get the OAuth URL from Supabase (deep link flow)
        const { data, error } = await supabase.auth.signInWithOAuth({
          provider,
          options: {
            redirectTo: 'yggchat://auth/callback',
            skipBrowserRedirect: true, // Don't redirect in the current window
          },
        })

        if (error) throw error

        if (data?.url) {
          // console.log('[Login] Opening OAuth in external browser (deep link flow)')
          const result = await window.electronAPI.auth.openExternal(data.url)

          if (!result.success) {
            // Browser failed to open - immediately switch to OOB flow
            // console.log('[Login] Failed to open browser, switching to OOB flow')
            setLoading(false)
            handleOOBLogin(provider)
            return
          }

          // console.log('[Login] OAuth URL opened in external browser, waiting for callback...')

          // Enter "waiting for callback" state
          setPendingProvider(provider)
          setWaitingForCallback(true)
          setLoading(false)

          // Show fallback link after 5 seconds
          setTimeout(() => {
            setShowFallbackLink(true)
          }, 5000)
        } else {
          throw new Error('No OAuth URL returned from Supabase')
        }
      } else {
        // Web mode - use normal OAuth flow
        const { error } = await supabase.auth.signInWithOAuth({
          provider,
          options: {
            // Route back to login so startup preference logic can choose homepage vs latest chat.
            redirectTo: `${window.location.origin}/login`,
          },
        })
        if (error) throw error
      }
    } catch (error: any) {
      setError(error.message || 'An error occurred')
      setLoading(false)
    }
  }

  const handleCommunityLogin = async () => {
    setLoading(true)
    setError(null)

    try {
      await signIn({ email: '', password: '' })
      setLoading(false)
    } catch (error: any) {
      setError(error.message || 'Failed to sign in with local community mode')
      setLoading(false)
    }
  }

  // OOB Login flow - for Electron when deep links don't work
  const handleOOBLogin = async (provider: 'google' | 'github') => {
    setLoading(true)
    setError(null)

    try {
      if (!supabase) {
        throw new Error('Supabase client not available.')
      }

      // Get OAuth URL with Railway callback (for OOB code display)
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: `${RAILWAY_URL}/auth/callback`,
          skipBrowserRedirect: true,
        },
      })

      if (error) throw error
      if (!data?.url) throw new Error('No OAuth URL returned')

      setOauthUrl(data.url)
      setOobMode(true)
      setLoading(false)

      // Try to open in browser
      if (window.electronAPI?.auth?.openExternal) {
        await window.electronAPI.auth.openExternal(data.url)
      }
    } catch (error: any) {
      setError(error.message || 'Failed to initiate login')
      setLoading(false)
    }
  }

  // Exchange OOB code for tokens
  const handleCodeSubmit = async () => {
    if (!oobCode.trim()) return

    setLoading(true)
    setError(null)

    try {
      const res = await fetch(`${RAILWAY_URL}/api/auth/oob/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: oobCode.trim() }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Invalid or expired code')
      }

      const { access_token, refresh_token } = await res.json()

      // Set session in Supabase
      const { data, error } = await supabase!.auth.setSession({
        access_token,
        refresh_token,
      })

      if (error) throw error

      // console.log('[Login] OOB session established successfully')

      // Handle Electron-specific setup (same as deep link flow)
      if (data.session?.user && isElectronMode) {
        const userId = data.session.user.id
        const username = data.session.user.user_metadata?.name || data.session.user.email?.split('@')[0] || 'user'

        // Sync to local SQLite
        dualSync.syncUser({
          id: userId,
          username: username,
          created_at: data.session.user.created_at,
        })

        await mergeLocalDataIntoCloudAccount(userId, username, data.session.user.created_at)

        // Save to Electron storage
        if (window.electronAPI?.storage) {
          await persistElectronCloudSession(data.session, data.session.user, username)
        }
      }

      setLoading(false)
      setOobMode(false)
    } catch (error: any) {
      console.error('[Login] OOB code exchange failed:', error)
      setError(error.message || 'Failed to verify code')
      setLoading(false)
    }
  }

  // Switch from deep link waiting to OOB flow
  const handleSwitchToOOB = () => {
    setWaitingForCallback(false)
    setShowFallbackLink(false)
    if (pendingProvider) {
      handleOOBLogin(pendingProvider)
    }
  }

  // Cancel waiting for callback and return to initial state
  const handleCancelWaiting = () => {
    setWaitingForCallback(false)
    setShowFallbackLink(false)
    setPendingProvider(null)
    setError(null)
  }

  return (
    <div className=' relative z-10 min-h-screen flex items-center justify-center bg-black/40 dark:bg-black/40 py-12 px-4 sm:px-6 lg:px-8'>
      <div className='max-w-md w-full space-y-8'>
        <div className='py-10'>
          <h2 className='mt-6 text-center text-3xl font-extrabold text-neutral-100 dark:text-white'>
            Sign in to your account
          </h2>
          <p className='mt-2 text-center text-sm text-neutral-100 dark:text-neutral-50'>
            Choose your preferred sign-in method
          </p>
          {requiresCloudLogin && (
            <p className='mt-2 text-center text-sm text-amber-200 dark:text-amber-300'>
              Google or GitHub sign-in is required to unlock Yggdrasil cloud models.
            </p>
          )}
        </div>

        {error && (
          <div className='bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-200 px-4 py-3 rounded'>
            {error}
          </div>
        )}

        <div className='space-y-6 relative z-10 justify-center items-center align-middle'>
          {oobMode ? (
            // OOB Code Entry UI
            <div className='space-y-6'>
              <div className='text-center'>
                <p className='text-neutral-200 dark:text-neutral-100 mb-2'>
                  Complete sign-in in your browser, then enter the code shown:
                </p>
              </div>

              <input
                type='text'
                value={oobCode}
                onChange={e => setOobCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
                placeholder='ABCD-1234'
                maxLength={9}
                className='w-full text-center text-3xl tracking-[0.2em] font-mono py-4 px-6 
                           bg-neutral-800/50 border-2 border-neutral-600 rounded-lg
                           text-white placeholder-neutral-500
                           focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20'
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter' && oobCode.length >= 8) {
                    handleCodeSubmit()
                  }
                }}
              />

              <Button
                onClick={handleCodeSubmit}
                disabled={loading || oobCode.length < 8}
                variant='mica'
                size='large'
                className='w-full'
              >
                {loading ? 'Verifying...' : 'Verify Code'}
              </Button>

              <div className='text-sm text-neutral-400 space-y-2'>
                <p>Browser didn't open? Copy this URL:</p>
                <div
                  className='p-3 bg-neutral-800/50 rounded-lg break-all text-xs cursor-pointer hover:bg-neutral-700/50 transition-colors'
                  onClick={() => {
                    if (oauthUrl) {
                      navigator.clipboard.writeText(oauthUrl)
                    }
                  }}
                  title='Click to copy'
                >
                  {oauthUrl}
                </div>
              </div>

              <button
                onClick={() => {
                  setOobMode(false)
                  setOobCode('')
                  setOauthUrl(null)
                  setError(null)
                }}
                className='w-full text-neutral-400 hover:text-neutral-200 text-sm py-2 transition-colors'
              >
                ← Back to sign-in options
              </button>
            </div>
          ) : waitingForCallback ? (
            // Waiting for deep link callback UI
            <div className='space-y-6'>
              <div className='text-center'>
                <div className='inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-white mb-4'></div>
                <p className='text-neutral-200 dark:text-neutral-100 mb-2'>Completing sign-in in browser...</p>
                <p className='text-neutral-400 text-sm'>Waiting for authentication to complete</p>
              </div>

              {showFallbackLink && (
                <button
                  onClick={handleSwitchToOOB}
                  className='w-full text-blue-400 hover:text-blue-300 text-sm py-2 transition-colors underline'
                >
                  Having trouble? Enter code manually
                </button>
              )}

              <button
                onClick={handleCancelWaiting}
                className='w-full text-neutral-400 hover:text-neutral-200 text-sm py-2 transition-colors'
              >
                Cancel
              </button>
            </div>
          ) : (
            // OAuth + local mode buttons
            <div className='space-y-8'>
              <Button
                onClick={() => handleOAuthLogin('github')}
                disabled={loading || waitingForCallback}
                variant='mica'
                size='large'
                className='w-full inline-flex justify-center items-center '
              >
                <svg className='w-5 h-5' fill='currentColor' viewBox='0 0 24 24'>
                  <path
                    fillRule='evenodd'
                    d='M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z'
                    clipRule='evenodd'
                  />
                </svg>
                <span className='ml-3'>Continue with GitHub</span>
              </Button>

              <div className='relative'>
                <div className='absolute inset-0 flex items-center'>
                  <div className='w-full border-t border-2 border-stone-300 dark:border-stone-500' />
                </div>
                <div className='relative flex justify-center text-sm'>
                  <span className='px-1.5 py-1 bg-gray-50 dark:bg-yBlack-900 border-2 dark:text-stone-300 border:stone-700 dark:border-stone-400 rounded-full text-gray-500'>
                    Or
                  </span>
                </div>
              </div>

              <Button
                onClick={() => handleOAuthLogin('google')}
                disabled={loading || waitingForCallback}
                variant='mica'
                className='w-full inline-flex justify-center items-center'
                size='large'
              >
                <svg className='w-5 h-5' viewBox='0 0 24 24'>
                  <path
                    fill='currentColor'
                    d='M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z'
                  />
                  <path
                    fill='currentColor'
                    d='M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z'
                  />
                  <path
                    fill='currentColor'
                    d='M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z'
                  />
                  <path
                    fill='currentColor'
                    d='M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z'
                  />
                </svg>
                <span className='ml-3'>Continue with Google</span>
              </Button>

              {!requiresCloudLogin && (
                <>
                  <div className='relative'>
                    <div className='absolute inset-0 flex items-center'>
                      <div className='w-full border-t border-2 border-stone-300 dark:border-stone-500' />
                    </div>
                    <div className='relative flex justify-center text-sm'>
                      <span className='px-1.5 py-1 bg-gray-50 dark:bg-yBlack-900 border-2 dark:text-stone-300 border:stone-700 dark:border-stone-400 rounded-full text-gray-500'>
                        Or continue locally
                      </span>
                    </div>
                  </div>

                  <Button
                    onClick={handleCommunityLogin}
                    disabled={loading || authLoading || waitingForCallback}
                    variant='mica'
                    size='large'
                    className='w-full inline-flex justify-center items-center '
                  >
                    <span>{loading ? 'Signing in...' : 'Continue in Local Mode'}</span>
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default Login
