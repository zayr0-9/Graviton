import type { Transition } from 'framer-motion'

/**
 * Shared presentation-only motion recipes for app-chrome surfaces.
 * Keep interaction state and high-frequency rendering outside this module.
 */
export const shellSpringTransition: Transition = {
  type: 'spring',
  stiffness: 340,
  damping: 44,
  mass: 0.86,
}

export const contentSpringTransition: Transition = {
  type: 'spring',
  stiffness: 300,
  damping: 40,
  mass: 0.8,
}

export const softTransition: Transition = {
  duration: 0.18,
  ease: 'easeOut',
}

export const feedbackTransition: Transition = {
  duration: 0.14,
  ease: 'easeOut',
}

export const reducedMotionTransition: Transition = {
  duration: 0.18,
  ease: 'easeOut',
}

export const motionState = (reducedMotion: boolean, directionalOffset = 8) => ({
  initial: reducedMotion ? { opacity: 0 } : { opacity: 0, y: directionalOffset, scale: 0.985 },
  animate: reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 },
  exit: reducedMotion ? { opacity: 0 } : { opacity: 0, y: directionalOffset, scale: 0.985 },
})

export const useMotionPreferences = (reducedMotion: boolean | null) => ({
  reducedMotion: Boolean(reducedMotion),
  shellTransition: reducedMotion ? reducedMotionTransition : shellSpringTransition,
  contentTransition: reducedMotion ? reducedMotionTransition : contentSpringTransition,
  feedbackTransition: reducedMotion ? reducedMotionTransition : feedbackTransition,
})
