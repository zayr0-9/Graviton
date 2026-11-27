export type ThemePreference = 'light' | 'dark' | 'system'

const THEME_STORAGE_KEY = 'theme'
const DARK_COLOR_SCHEME = '(prefers-color-scheme: dark)'

export function readThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system'
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY)
    return saved === 'light' || saved === 'dark' ? saved : 'system'
  } catch {
    return 'system'
  }
}

function applyThemePreference(preference: ThemePreference, media: MediaQueryList) {
  // Send the preference, not the resolved color. Forcing light/dark in Electron
  // overrides the media query itself and stops it from following the OS.
  void window.electronAPI?.theme?.update(preference)
  document.documentElement.classList.toggle('dark', preference === 'dark' || (preference === 'system' && media.matches))
}

export function setThemePreference(preference: ThemePreference) {
  window.localStorage.setItem(THEME_STORAGE_KEY, preference)
  applyThemePreference(preference, window.matchMedia(DARK_COLOR_SCHEME))
}

export function initializeThemePreference() {
  const media = window.matchMedia(DARK_COLOR_SCHEME)
  const apply = () => applyThemePreference(readThemePreference(), media)

  const onMediaChange = () => {
    if (readThemePreference() === 'system') {
      document.documentElement.classList.toggle('dark', media.matches)
    }
  }
  const onStorageChange = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) apply()
  }

  const hasModernMediaListener = typeof media.addEventListener === 'function'
  if (hasModernMediaListener) media.addEventListener('change', onMediaChange)
  else media.addListener?.(onMediaChange)
  window.addEventListener('storage', onStorageChange)
  apply()

  return () => {
    if (hasModernMediaListener) media.removeEventListener('change', onMediaChange)
    else media.removeListener?.(onMediaChange)
    window.removeEventListener('storage', onStorageChange)
  }
}
