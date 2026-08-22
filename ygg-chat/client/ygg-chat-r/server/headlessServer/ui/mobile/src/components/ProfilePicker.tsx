import React from 'react'
import { cn } from '../lib/utils'
import { Select } from './ui'
import type { LocalUserProfile } from '../types'

interface ProfilePickerProps {
  users: LocalUserProfile[]
  selectedUserId: string | null
  onSelect: (userId: string) => void
  disabled?: boolean
  compact?: boolean
  labelText?: string
  className?: string
}

export const ProfilePicker: React.FC<ProfilePickerProps> = ({
  users,
  selectedUserId,
  onSelect,
  disabled = false,
  compact = false,
  labelText = 'Profile',
  className,
}) => {
  return (
    <div className={cn('mobile-profile-picker', compact && 'mobile-profile-picker--compact', className)}>
      <label className='mobile-profile-picker-label'>
        <span>{labelText}</span>
        <Select
          value={selectedUserId || ''}
          onChange={event => onSelect(event.target.value)}
          disabled={disabled || users.length === 0}
        >
          {users.length === 0 ? <option value=''>No local users found</option> : null}
          {users.map(user => (
            <option key={user.id} value={user.id}>
              {user.username || user.id} · {user.conversation_count ?? 0} conv
            </option>
          ))}
        </Select>
      </label>
    </div>
  )
}
