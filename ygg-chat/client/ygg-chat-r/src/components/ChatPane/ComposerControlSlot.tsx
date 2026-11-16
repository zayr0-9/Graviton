import React from 'react'
import { createPortal } from 'react-dom'

/** Relocate low-frequency chrome only. Never use for the stateful textarea or file input. */
export function ComposerControlSlot({ compact, target, children }: {
  compact: boolean
  target: HTMLElement | null
  children: React.ReactNode
}) {
  if (!compact) return <>{children}</>
  return target ? createPortal(children, target) : null
}
