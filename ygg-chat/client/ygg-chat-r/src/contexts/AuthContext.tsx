import { Session, User } from '@supabase/supabase-js'
import React, { createContext, useCallback, useEffect, useMemo, useState } from 'react'
import { isCommunityMode, isElectronMode, LOCAL_AUTH_USER_ID, syncRuntimeAuthMode } from '../config/runtimeMode'
import { clearUser, setUser } from '../features/users/usersSlice'
import { getAuthProvider, type AuthProvider as IAuthProvider } from '../lib/auth'
import { localMirror as dualSync } from '../lib/localMirror'
import { store } from '../store/store'
import { updateThunkExtraAuth } from '../store/thunkExtra'
import { API_BASE, FORCE_LOGOUT_EVENT } from '../utils/api'

export interface AuthContextType {
  user: User | null
  session: Session | null
  accessToken: string | null
  userId: string | null
  loading: boolean
  signIn: (credentials: { email: string; password: string }) => Promise<void>
  signOut: () => Promise<void>
  getClaims: () => Promise<Record<string, unknown> | null>
  isTokenValid: () => Promise<boolean>
  reloadSession: () => Promise<void>
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined)

interface AuthProviderProps {
  children: React.ReactNode
}

interface AuthState {
  user: User | null
  session: Session | null
  accessToken: string | null
  userId: string | null
  loading: boolean
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  // Use single state object to batch updates and prevent multiple re-renders
  const [authState, setAuthState] = useState<AuthState>({
    user: null,
    session: null,
    accessToken: null,
    userId: null,
    loading: true,
  })

  // Store the auth provider instance
  const [provider, setProvider] = useState<IAuthProvider | null>(null)

  // Update auth state helper
  const updateAuthState = useCallback((state: Partial<AuthState>) => {
    setAuthState(prev => {
      const newState = { ...prev, ...state, loading: false }

      syncRuntimeAuthMode({
        accessToken: newState.accessToken,
        userId: newState.userId,
      })

      // Update Redux thunk extra auth
      updateThunkExtraAuth(newState.accessToken, newState.userId)

      // console.log('[AuthContext] Session updated:', newState.userId ?? 'none')

      return newState
    })
  }, [])

  // Fetch user profile from API and sync to Redux
  const syncUserProfile = useCallback(async (userId: string | null, accessToken: string | null) => {
    if (!userId || !accessToken) {
      // console.log('[AuthContext] Clearing user profile from Redux')
      store.dispatch(clearUser())
      return
    }

    try {
      if (isCommunityMode) {
        const localProfile = {
          id: userId,
          username: 'community-user',
          created_at: new Date(0).toISOString(),
          max_credits: 0,
          cached_current_credits: 0,
          total_spent: 0,
          credits_enabled: false,
          reset_period: 'none' as const,
          free_generations_remaining: 0,
          favorite_conversation_ids: [],
        }
        store.dispatch(setUser(localProfile as any))
        if (isElectronMode) {
          dualSync.syncUser({
            id: localProfile.id,
            username: localProfile.username,
            created_at: localProfile.created_at,
          })
        }
        return
      }

      // console.log('[AuthContext] Fetching user profile for:', userId)
      const response = await fetch(`${API_BASE}/users/${userId}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        console.error('[AuthContext] Failed to fetch user profile:', response.statusText)
        return
      }

      const profile = await response.json()
      // console.log('[AuthContext] User profile fetched:', profile.username)

      // Dispatch to Redux
      store.dispatch(setUser(profile))

      // Sync user to local SQLite database (Electron mode only)
      if (isElectronMode) {
        // console.log('[AuthContext] Syncing user to local SQLite:', profile.id)
        dualSync.syncUser({
          id: profile.id,
          username: profile.username,
          created_at: profile.created_at,
        })
      }
    } catch (error) {
      console.error('[AuthContext] Error fetching user profile:', error)
    }
  }, [])

  // Listen for force logout events from API layer (when token refresh fails)
  useEffect(() => {
    const handleForceLogout = () => {
      setAuthState({
        user: null,
        session: null,
        accessToken: null,
        userId: null,
        loading: false,
      })
      syncRuntimeAuthMode({ accessToken: null, userId: null })
      updateThunkExtraAuth(null, null)
      store.dispatch(clearUser())
    }

    window.addEventListener(FORCE_LOGOUT_EVENT, handleForceLogout)
    return () => window.removeEventListener(FORCE_LOGOUT_EVENT, handleForceLogout)
  }, [])

  // Initialize auth provider on mount
  useEffect(() => {
    let mounted = true
    let unsubscribe: (() => void) | null = null
    let refreshInterval: number | null = null

    const initializeAuth = async () => {
      try {
        // console.log('[AuthContext] Initializing auth provider...')

        // Get the appropriate provider for this environment
        const authProvider = await getAuthProvider()

        if (!mounted) return

        setProvider(authProvider)

        // Get initial session
        const session = await authProvider.getSession()

        if (!mounted) return

        updateAuthState({
          user: session.user as any,
          session: session.session as any,
          accessToken: session.accessToken,
          userId: session.userId,
        })

        // Sync user profile to Redux
        await syncUserProfile(session.userId, session.accessToken)

        // Subscribe to auth state changes
        unsubscribe = authProvider.onAuthStateChange(async user => {
          if (!mounted) return

          // Get the actual session with access token from the provider
          const session = await authProvider.getSession()

          updateAuthState({
            user: user as any,
            session: session.session as any,
            accessToken: session.accessToken,
            userId: user?.id ?? null,
          })

          // Sync user profile to Redux
          await syncUserProfile(user?.id ?? null, session.accessToken)
        })

        // Set up periodic token refresh if provider requires network auth
        if (authProvider.requiresNetworkAuth()) {
          // console.log('[AuthContext] Setting up periodic token refresh')
          refreshInterval = window.setInterval(async () => {
            try {
              await authProvider.refreshToken()
            } catch (error) {
              console.error('[AuthContext] Token refresh failed:', error)
            }
          }, 30000) // Check every 30 seconds

          // Add visibility change listener - refresh when tab becomes visible
          const handleVisibilityChange = async () => {
            if (document.visibilityState === 'visible') {
              // console.log('[AuthContext] Tab became visible, checking token...')
              try {
                await authProvider.refreshToken()
              } catch (error) {
                console.error('[AuthContext] Token refresh on visibility change failed:', error)
              }
            }
          }

          // Add window focus listener - refresh when window gains focus
          const handleWindowFocus = async () => {
            // console.log('[AuthContext] Window gained focus, checking token...')
            try {
              await authProvider.refreshToken()
            } catch (error) {
              console.error('[AuthContext] Token refresh on window focus failed:', error)
            }
          }

          document.addEventListener('visibilitychange', handleVisibilityChange)
          window.addEventListener('focus', handleWindowFocus)

          // Store cleanup functions
          const originalUnsubscribe = unsubscribe
          unsubscribe = () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange)
            window.removeEventListener('focus', handleWindowFocus)
            if (originalUnsubscribe) originalUnsubscribe()
          }
        }
      } catch (error) {
        console.error('[AuthContext] Failed to initialize auth:', error)
        if (mounted) {
          setAuthState(prev => ({ ...prev, loading: false }))
        }
      }
    }

    initializeAuth()

    // Cleanup
    return () => {
      mounted = false
      // console.log('[AuthContext] Cleaning up auth provider')

      if (unsubscribe) {
        unsubscribe()
      }

      if (refreshInterval !== null) {
        clearInterval(refreshInterval)
      }
    }
  }, [updateAuthState, syncUserProfile])

  // Sign in using the provider
  const signIn = useCallback(
    async (credentials: { email: string; password: string }) => {
      // console.log('[AuthContext] Signing in...')

      const wantsLocalLogin = !credentials.email?.trim() && !credentials.password?.trim()

      if (wantsLocalLogin) {
        const localToken = isElectronMode ? 'electron-local-token' : 'local-mode-token'
        const localAuthState = {
          user: {
            id: LOCAL_AUTH_USER_ID,
            username: isElectronMode ? 'electron-user' : 'local-user',
            email: isElectronMode ? 'electron@localhost' : 'local@localhost',
          },
          session: {
            access_token: localToken,
          },
          loading: false,
          accessToken: localToken,
          userId: LOCAL_AUTH_USER_ID,
        }

        if (isElectronMode && window.electronAPI?.storage) {
          try {
            await window.electronAPI.storage.set('auth_session', localAuthState)
          } catch (storageError) {
            console.warn('[AuthContext] Failed to persist local auth session:', storageError)
          }
        }

        updateAuthState({
          user: localAuthState.user as any,
          session: localAuthState.session as any,
          accessToken: localAuthState.accessToken,
          userId: localAuthState.userId,
        })

        await syncUserProfile(localAuthState.userId, localAuthState.accessToken)
        return
      }

      if (!provider) {
        console.warn('[AuthContext] Provider not initialized yet')
        throw new Error('Auth provider not initialized')
      }

      try {
        const authState = await provider.login(credentials)

        // Update state
        updateAuthState({
          user: authState.user as any,
          session: authState.session as any,
          accessToken: authState.accessToken,
          userId: authState.userId,
        })

        // Sync user profile to Redux
        await syncUserProfile(authState.userId, authState.accessToken)
      } catch (error) {
        console.error('[AuthContext] Sign in failed:', error)
        throw error
      }
    },
    [provider, updateAuthState, syncUserProfile]
  )

  // Sign out using the provider
  const signOut = useCallback(async () => {
    // console.log('[AuthContext] Signing out...')

    if (!provider) {
      console.warn('[AuthContext] Provider not initialized yet')
      return
    }

    try {
      await provider.logout()

      // Update state
      updateAuthState({
        user: null,
        session: null,
        accessToken: null,
        userId: null,
      })

      // Clear user profile from Redux
      await syncUserProfile(null, null)
    } catch (error) {
      console.error('[AuthContext] Sign out failed:', error)
      throw error
    }
  }, [provider, updateAuthState, syncUserProfile])

  // Reload session from storage (for Electron OAuth flow)
  const reloadSession = useCallback(async () => {
    // console.log('[AuthContext] Reloading session from storage...')

    if (!provider) {
      console.warn('[AuthContext] Provider not initialized yet')
      return
    }

    // Check if provider supports reloadSession (ElectronAuthProvider)
    if ('reloadSession' in provider) {
      try {
        await (provider as any).reloadSession()

        // Get updated session
        const session = await provider.getSession()

        // Update context state
        updateAuthState({
          user: session.user as any,
          session: session.session as any,
          accessToken: session.accessToken,
          userId: session.userId,
        })

        // Sync user profile to Redux
        await syncUserProfile(session.userId, session.accessToken)

        // console.log('[AuthContext] Session reloaded successfully')
      } catch (error) {
        console.error('[AuthContext] Failed to reload session:', error)
      }
    } else {
      console.log('[AuthContext] Provider does not support session reload')
    }
  }, [provider, updateAuthState, syncUserProfile])

  // Memoize context value to prevent re-render cascades
  // Only updates when authState or signIn/signOut actually changes
  const value: AuthContextType = useMemo(
    () => ({
      user: authState.user,
      session: authState.session,
      accessToken: authState.accessToken,
      userId: authState.userId,
      loading: authState.loading,
      signIn,
      signOut,
      reloadSession,
      getClaims: async () => {
        // For Supabase provider, use its getClaims method
        if (provider && 'getClaims' in provider) {
          return (provider as any).getClaims()
        }
        // For other providers, return null
        return null
      },
      isTokenValid: async () => {
        // For Supabase provider, use its isTokenValid method
        if (provider && 'isTokenValid' in provider) {
          return (provider as any).isTokenValid()
        }
        // For other providers, always valid
        return true
      },
    }),
    [authState, signIn, signOut, reloadSession, provider]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
