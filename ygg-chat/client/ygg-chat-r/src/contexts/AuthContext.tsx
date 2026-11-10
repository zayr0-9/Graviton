import React, { createContext, useCallback, useEffect, useMemo, useState } from 'react'
import { LOCAL_USER_NAME } from '../../../../shared/localUser'
import { setUser } from '../features/users/usersSlice'
import { getAuthProvider, type User } from '../lib/auth'
import { store } from '../store/store'
import { updateThunkExtraAuth } from '../store/thunkExtra'

/**
 * Identity is always the single local user (fully-local plan D4). The host projects it;
 * this context only waits for that projection and keeps the Redux profile filled.
 */
export interface AuthContextType {
  user: User | null
  userId: string | null
  loading: boolean
  /** Re-reads the host identity (for example after a renderer recovery). */
  reloadSession: () => Promise<void>
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined)

interface AuthState {
  user: User | null
  userId: string | null
  loading: boolean
}

const applyLocalProfile = (user: User | null) => {
  updateThunkExtraAuth(user?.id ?? null)
  if (!user) return
  const current = store.getState().users.currentUser
  if (current?.id === user.id) return
  store.dispatch(setUser({ id: user.id, username: LOCAL_USER_NAME, created_at: new Date(0).toISOString(), favorite_conversation_ids: [] }))
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [authState, setAuthState] = useState<AuthState>({ user: null, userId: null, loading: true })

  const adopt = useCallback((user: User | null) => {
    applyLocalProfile(user)
    setAuthState({ user, userId: user?.id ?? null, loading: false })
  }, [])

  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    void (async () => {
      try {
        const provider = await getAuthProvider()
        if (cancelled) return
        adopt((await provider.getSession()).user)
        unsubscribe = provider.onAuthStateChange(user => { if (!cancelled) adopt(user) })
      } catch (error) {
        console.error('[AuthContext] Host identity is unavailable:', error)
        if (!cancelled) setAuthState(prev => ({ ...prev, loading: false }))
      }
    })()
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [adopt])

  const reloadSession = useCallback(async () => {
    const provider = await getAuthProvider()
    await provider.refreshToken()
    adopt((await provider.getSession()).user)
  }, [adopt])

  const value = useMemo<AuthContextType>(() => ({ ...authState, reloadSession }), [authState, reloadSession])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
