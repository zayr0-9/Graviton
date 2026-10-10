import { useEffect, useState } from 'react'

export const FAST_MODE_ANIMATION_KEY = 'chat:fastModeAnimation'
export const FAST_MODE_ANIMATION_CHANGE_EVENT = 'chatUi:fastModeAnimationChange'

export const FAST_MODE_ANIMATIONS = [
  { id: 'aurora', name: 'Aurora drift', colors: ['#d1eafa', '#6ccceb', '#9a9beb', '#b1f8e9'] },
  { id: 'slipstream', name: 'Slipstream', colors: ['#cce7fc', '#388fe2', '#70b8ed', '#b6dcf8'] },
  { id: 'satin', name: 'Liquid satin', colors: ['#dce2fa', '#b6dcf8', '#bbbcf1', '#a4e5f3'] },
  { id: 'solar', name: 'Solar boost', colors: ['#f5e1bd', '#f6b767', '#ffd88a', '#fff2d8'] },
  { id: 'contour', name: 'Vector flow', colors: ['#cee9ec', '#368e9e', '#70b5c4', '#b7e8de'] },
  { id: 'ribbon', name: 'Energy ribbons', colors: ['#dddaf9', '#ab98e9', '#70cbea', '#f2f4ff'] },
  { id: 'ripple', name: 'Quiet propulsion', colors: ['#d7e9f8', '#6596bd', '#a0d8f3', '#b6dcf8'] },
  { id: 'prism', name: 'Prismatic mesh', colors: ['#dce1fa', '#91dbea', '#d3bcf0', '#c0f1e0'] },
  { id: 'pearl-crest', name: 'Pearl crest', colors: ['#dfeaf4', '#aacfe1', '#b7c9e8', '#b7c9e3'] },
  { id: 'pixel-packets', name: 'Packet express', colors: ['#cce4f9', '#70b8ed', '#5aaae0', '#b6dcf8'] },
  { id: 'lunar-lens', name: 'Lunar lens', colors: ['#e4e5f5', '#b4bddc', '#b6d9e5', '#c8c2e8'] },
  { id: 'caustic-tide', name: 'Caustic tide', colors: ['#c4e7e6', '#70b5c4', '#62b5c8', '#b7e8de'] },
  { id: 'sea-glass', name: 'Sea-glass swell', colors: ['#dceeea', '#9accc6', '#b7e8de', '#a6d7de'] },
  { id: 'opal-veil', name: 'Opal veil', colors: ['#e9e4f1', '#cfbbdd', '#bad8e3', '#b9d6e3'] },
  { id: 'tidal-glass', name: 'Tidal glass', colors: ['#e1e4f6', '#b4c8e4', '#a6d7de', '#c8c2e8'] },
  { id: 'pixel-rain', name: 'Mint bitfall', colors: ['#d2eae3', '#65a693', '#9accc6', '#b7e8de'] },
] as const

export type FastModeAnimation = (typeof FAST_MODE_ANIMATIONS)[number]['id'] | 'none'
export const DEFAULT_FAST_MODE_ANIMATION: FastModeAnimation = 'tidal-glass'

export const normalizeFastModeAnimation = (value: unknown): FastModeAnimation =>
  value === 'none' || FAST_MODE_ANIMATIONS.some(option => option.id === value)
    ? value as FastModeAnimation
    : DEFAULT_FAST_MODE_ANIMATION

export const loadFastModeAnimation = (): FastModeAnimation => {
  try {
    return normalizeFastModeAnimation(localStorage.getItem(FAST_MODE_ANIMATION_KEY))
  } catch {
    return DEFAULT_FAST_MODE_ANIMATION
  }
}

export const saveFastModeAnimation = (value: FastModeAnimation): void => {
  const animation = normalizeFastModeAnimation(value)
  try {
    localStorage.setItem(FAST_MODE_ANIMATION_KEY, animation)
  } catch {
    // Keep this window responsive even when preference storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent(FAST_MODE_ANIMATION_CHANGE_EVENT, { detail: animation }))
}

export const useFastModeAnimation = (): FastModeAnimation => {
  const [animation, setAnimation] = useState(loadFastModeAnimation)
  useEffect(() => {
    const onChange = (event: Event) => setAnimation(normalizeFastModeAnimation((event as CustomEvent).detail))
    const onStorage = (event: StorageEvent) => {
      if (event.key === FAST_MODE_ANIMATION_KEY || event.key === null) setAnimation(loadFastModeAnimation())
    }
    window.addEventListener(FAST_MODE_ANIMATION_CHANGE_EVENT, onChange)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(FAST_MODE_ANIMATION_CHANGE_EVENT, onChange)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return animation
}
