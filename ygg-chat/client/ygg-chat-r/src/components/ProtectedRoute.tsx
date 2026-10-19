import React from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

interface ProtectedRouteProps {
  children: React.ReactNode
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className='min-h-screen flex items-center justify-center'>
        <div className='text-gray-600 dark:text-gray-400'>Loading...</div>
      </div>
    )
  }

  if (!user) {
    return <Navigate to='/login' replace />
  }

  return <>{children}</>
}

export default ProtectedRoute
