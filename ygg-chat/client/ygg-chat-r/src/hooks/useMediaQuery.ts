import { useState, useEffect } from 'react'

/**
 * Custom hook to track media query matches
 * @param query - CSS media query string (e.g., '(max-width: 767px)')
 * @returns boolean indicating if the media query matches
 */
export const useMediaQuery = (query: string): boolean => {
  // Initialize state with SSR-safe check
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    // Return early if window is not available (SSR)
    if (typeof window === 'undefined') return

    const mediaQuery = window.matchMedia(query)

    // Update state if the initial value doesn't match
    if (mediaQuery.matches !== matches) {
      setMatches(mediaQuery.matches)
    }

    // Handler for media query changes
    const handleChange = (event: MediaQueryListEvent) => {
      setMatches(event.matches)
    }

    // Add listener for changes
    mediaQuery.addEventListener('change', handleChange)

    // Cleanup listener on unmount
    return () => {
      mediaQuery.removeEventListener('change', handleChange)
    }
  }, [query, matches])

  return matches
}

/**
 * Predefined hook to detect mobile devices
 * @returns true if viewport width is less than 768px (Tailwind's md breakpoint)
 */
export const useIsMobile = (): boolean => {
  return useMediaQuery('(max-width: 767px)')
}

/** Primary input is touch (phones, tablets) rather than a mouse or trackpad. */
export const TOUCH_PRIMARY_QUERY = '(hover: none) and (pointer: coarse)'

/** True on touch-primary devices, where the on-screen keyboard has no Shift+Enter. */
export const useIsTouchPrimary = (): boolean => {
  return useMediaQuery(TOUCH_PRIMARY_QUERY)
}

/**
 * Predefined hook to detect tablet devices
 * @returns true if viewport width is between 768px and 1023px
 */
export const useIsTablet = (): boolean => {
  return useMediaQuery('(min-width: 768px) and (max-width: 1023px)')
}

/**
 * Predefined hook to detect desktop devices
 * @returns true if viewport width is 1024px or greater
 */
export const useIsDesktop = (): boolean => {
  return useMediaQuery('(min-width: 1024px)')
}
