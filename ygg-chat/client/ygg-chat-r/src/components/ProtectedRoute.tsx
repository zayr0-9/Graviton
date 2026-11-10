import React from 'react'
import { useAuth } from '../hooks/useAuth'

interface ProtectedRouteProps {
  children: React.ReactNode
}

/**
 * Waits for the host to project the local identity. There is no login: if the host is
 * not reachable yet, offer a retry instead of redirecting anywhere.
 */
const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  const { user, loading, reloadSession } = useAuth()

  if (loading) {
    return (
      <div className='min-h-screen flex items-center justify-center'>
        <div className='text-gray-600 dark:text-gray-400'>Loading...</div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className='min-h-screen flex flex-col items-center justify-center gap-3 text-gray-600 dark:text-gray-400'>
        <div>Could not reach the Graviton host.</div>
        <button
          type='button'
          className='rounded-full border border-current px-4 py-1.5 text-sm'
          onClick={() => void reloadSession().catch(() => undefined)}
        >
          Retry
        </button>
      </div>
    )
  }

  return <>{children}</>
}

export default ProtectedRoute
