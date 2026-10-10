import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ChevronDown } from 'lucide-react'
import React, { useId, useState } from 'react'

/** Fixed pill geometry keeps label swaps from shifting adjacent actions. */
export function ActionPopoverButton({ label, icon, active = false, ...props }: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  label: string
  icon: React.ReactNode
  active?: boolean
}) {
  const reduceMotion = useReducedMotion()
  return (
    <button {...props} type='button' className='action-cloud-pill' data-active={active}>
      <span className='action-cloud-icon' aria-hidden='true'>{icon}</span>
      <span className='action-cloud-label'>
        <AnimatePresence initial={false} mode='wait'>
          <motion.span
            key={label}
            initial={reduceMotion ? { opacity: 1 } : { opacity: 0, y: 4, filter: 'blur(2px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={reduceMotion ? { opacity: 1 } : { opacity: 0, y: -4, filter: 'blur(2px)' }}
            transition={{ duration: reduceMotion ? 0 : 0.15, ease: 'easeInOut' }}
          >{label}</motion.span>
        </AnimatePresence>
      </span>
    </button>
  )
}

export function ActionPopoverSwitch({ checked, label, ...props }: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  checked: boolean
  label: string
}) {
  const [interacted, setInteracted] = useState(false)
  return (
    <button
      {...props}
      type='button'
      className='action-cloud-switch'
      role='switch'
      aria-label={label}
      aria-checked={checked}
      data-interacted={interacted}
      onClick={event => { setInteracted(true); props.onClick?.(event) }}
    >
      <span aria-hidden='true' />
    </button>
  )
}

export function ActionPopoverDisclosure({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className='action-cloud-disclosure' data-open={open}>
      <button type='button' aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
        Image options
        <ChevronDown size={16} aria-hidden='true' />
      </button>
      <div className='action-cloud-disclosure-track' id={id} aria-hidden={!open}>
        <div className='action-cloud-disclosure-inner' inert={!open}>
          {children}
        </div>
      </div>
    </div>
  )
}
