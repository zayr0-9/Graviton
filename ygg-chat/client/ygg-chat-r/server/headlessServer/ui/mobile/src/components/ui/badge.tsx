import React from 'react'
import { cn } from '../../lib/utils'

type BadgeVariant = 'default' | 'success' | 'destructive' | 'outline'

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
}

export const Badge: React.FC<BadgeProps> = ({ className, variant = 'default', ...props }) => {
  return <span className={cn('ui-badge', `ui-badge--${variant}`, className)} {...props} />
}
